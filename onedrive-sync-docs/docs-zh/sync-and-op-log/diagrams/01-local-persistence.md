# 本地持久化架构

**最后更新：** 2026 年 1 月
**状态：** 已实现

本图展示了用户操作如何流经系统、如何持久化到 IndexedDB（`SUP_OPS`），以及系统在启动时如何完成恢复（hydration）。

## Operation Log 架构

```mermaid
graph TD
    %% Styles
    classDef storage fill:#f9f,stroke:#333,stroke-width:2px,color:black;
    classDef process fill:#e1f5fe,stroke:#0277bd,stroke-width:2px,color:black;
    classDef trigger fill:#e8f5e9,stroke:#2e7d32,stroke-width:2px,color:black;
    classDef archive fill:#e8eaf6,stroke:#3949ab,stroke-width:2px,color:black;

    User((User / UI)) -->|Dispatch Action| NgRx["NgRx Store <br/> Runtime Source of Truth<br/><sub>*.effects.ts / *.reducer.ts</sub>"]

    subgraph "Write Path (Runtime)"
        NgRx -->|Action Stream| OpEffects["OperationLogEffects<br/><sub>operation-log.effects.ts</sub>"]

        OpEffects -->|1. Check isPersistent| Filter{"Is Persistent?<br/><sub>persistent-action.interface.ts</sub>"}
        Filter -- No --> Ignore[Ignore / UI Only]
        Filter -- Yes --> Transform["Transform to Operation<br/>UUIDv7, Timestamp, VectorClock<br/><sub>operation-converter.util.ts</sub>"]

        Transform -->|2. Validate| PayloadValid{"Payload<br/>Valid?<br/><sub>processing/validate-operation-payload.ts</sub>"}
        PayloadValid -- No --> ErrorSnack[Show Error Snackbar]
        PayloadValid -- Yes --> DBWrite
    end

    subgraph "Persistence Layer (IndexedDB: SUP_OPS)"
        DBWrite["Write to SUP_OPS<br/><sub>store/operation-log-store.service.ts</sub>"]:::storage

        DBWrite -->|Append| OpsTable["Table: ops<br/>The Event Log<br/><sub>IndexedDB</sub>"]:::storage
        DBWrite -->|Update| StateCache["Table: state_cache<br/>Snapshots<br/><sub>IndexedDB</sub>"]:::storage
    end

    subgraph "Archive Storage (IndexedDB)"
        ArchiveWrite["ArchiveService<br/><sub>time-tracking/archive.service.ts</sub>"]:::archive
        ArchiveWrite -->|Write BEFORE dispatch| ArchiveYoung["archiveYoung<br/>━━━━━━━━━━━━━━━<br/>• task: TaskArchive<br/>• timeTracking: State<br/>━━━━━━━━━━━━━━━<br/><sub>Tasks < 21 days old</sub>"]:::archive
        ArchiveYoung -->|"flushYoungToOld action<br/>(every ~14 days)"| ArchiveOld["archiveOld<br/>━━━━━━━━━━━━━━━<br/>• task: TaskArchive<br/>• timeTracking: State<br/>━━━━━━━━━━━━━━━<br/><sub>Tasks > 21 days old</sub>"]:::archive
    end

    User -->|Archive Tasks| ArchiveWrite
    NgRx -.->|moveToArchive action<br/>AFTER archive write| OpEffects

    subgraph "Compaction System"
        OpsTable -->|Count > 500| CompactionTrig{"Compaction<br/>Trigger<br/><sub>operation-log.effects.ts</sub>"}:::trigger
        CompactionTrig -->|Yes| Compactor["CompactionService<br/><sub>store/operation-log-compaction.service.ts</sub>"]:::process
        Compactor -->|Read State| NgRx
        Compactor -->|Save Snapshot| StateCache
        Compactor -->|Delete Old Ops| OpsTable
    end

    subgraph "Read Path (Hydration)"
        Startup((App Startup)) --> Hydrator["OperationLogHydrator<br/><sub>store/operation-log-hydrator.service.ts</sub>"]:::process
        Hydrator -->|1. Load| StateCache

        StateCache -->|Check| Schema{"Schema<br/>Version?<br/><sub>store/schema-migration.service.ts</sub>"}
        Schema -- Old --> Migrator["SchemaMigrationService<br/><sub>store/schema-migration.service.ts</sub>"]:::process
        Migrator -->|Transform State| MigratedState
        Schema -- Current --> CurrentState

        CurrentState -->|Load State| StoreInit[Init NgRx State]
        MigratedState -->|Load State| StoreInit

        Hydrator -->|2. Load Tail| OpsTable
        OpsTable -->|Replay Ops| Replayer["OperationApplier<br/><sub>processing/operation-applier.service.ts</sub>"]:::process
        Replayer -->|Dispatch| NgRx
    end

    subgraph "Single Instance + Sync Locking"
        Startup2((App Startup)) -->|BroadcastChannel| SingleCheck{"Already<br/>Open?<br/><sub>startup.service.ts</sub>"}
        SingleCheck -- Yes --> Block[Block New Tab]
        SingleCheck -- No --> Allow[Allow]

        DBWrite -.->|Critical ops use| WebLocks["Web Locks API<br/><sub>sync/lock.service.ts</sub>"]
    end

    class OpsTable,StateCache storage;
    class ArchiveWrite,ArchiveYoung,ArchiveOld,TimeTracking archive;
```

## 归档数据流说明

- **先写归档，再 dispatch**：用户归档任务时，`ArchiveService` 会先写入 IndexedDB，再派发 `moveToArchive` action，确保状态变更前数据已安全落盘。
- **ArchiveModel 结构**：每层归档都存储 `{ task: TaskArchive, timeTracking: TimeTrackingState, lastTimeTrackingFlush: number }`。即归档任务实体和其时间追踪数据一并保存。
- **双层归档**：近期任务进入 `archiveYoung`（任务 < 21 天）；更早任务通过 `flushYoungToOld` 转入 `archiveOld`（在归档时约每 14 天检查一次）。
- **Flush 机制**：`flushYoungToOld` 是持久化 action，包含：
  1. 当 `moveTasksToArchiveAndFlushArchiveIfDue()` 期间检测到 `lastTimeTrackingFlush > 14 days` 时触发
  2. 将 `archiveYoung.task` 中超过 21 天的任务移动到 `archiveOld.task`
  3. 通过 operation log 同步，让所有客户端以确定性方式执行相同 flush
- **不存入 NgRx state**：归档数据直接存 IndexedDB，不放在 NgRx store。用于同步的是操作本身（`moveToArchive`、`flushYoungToOld`）。
- **同步处理**：在远端客户端上，`ArchiveOperationHandler` 会在收到操作后再写归档数据（见 [archive-operations.md](./06-archive-operations.md)）。

## 关键文件

| 文件                                                   | 作用                         |
| ------------------------------------------------------ | ---------------------------- |
| `op-log/effects/operation-log.effects.ts`              | 捕获 action 并写入 operation |
| `op-log/store/operation-log-store.service.ts`          | SUP_OPS 的 IndexedDB 封装    |
| `op-log/persistence/operation-log-hydrator.service.ts` | 启动恢复（hydration）        |
| `op-log/processing/operation-applier.service.ts`       | 将 operation 回放到 NgRx     |
| `features/time-tracking/archive.service.ts`            | 归档写入逻辑                 |
