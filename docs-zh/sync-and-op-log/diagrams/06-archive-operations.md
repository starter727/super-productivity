# 归档操作与副作用

**最后更新：** 2026 年 1 月  
**状态：** 已实现

本节说明归档相关副作用如何处理，并建立一条通用规则：**远端操作不应触发普通 effects**。

## 通用规则：Effects 只处理本地动作

```mermaid
flowchart TD
    subgraph Rule["🔒 GENERAL RULE"]
        R1["All NgRx effects MUST use LOCAL_ACTIONS"]
        R2["Effects should NEVER run for remote operations"]
        R3["Side effects for remote ops are handled<br/>explicitly by OperationApplierService"]
    end

    subgraph Why["Why This Matters"]
        W1["• Prevents duplicate side effects"]
        W2["• Makes sync behavior predictable"]
        W3["• Side effects happen exactly once<br/>(on originating client)"]
        W4["• Receiving clients only update state"]
    end

    Rule --> Why

    style Rule fill:#e8f5e9,stroke:#2e7d32,stroke-width:3px
    style Why fill:#e3f2fd,stroke:#1565c0,stroke-width:2px
```

## 双数据库架构

Super Productivity 使用两个独立的 IndexedDB 数据库：

```mermaid
flowchart TB
    subgraph Browser["Browser IndexedDB"]
        subgraph SUPOPS["SUP_OPS Database (Operation Log)"]
            direction TB
            OpsTable["ops table<br/>━━━━━━━━━━━━━━━<br/>Operation event log<br/>UUIDv7, vectorClock, payload"]
            StateCache["state_cache table<br/>━━━━━━━━━━━━━━━<br/>NgRx state snapshots<br/>for fast hydration"]
        end

        subgraph ArchiveDB["Archive Database"]
            direction TB
            ArchiveYoung["archiveYoung<br/>━━━━━━━━━━━━━━━<br/>ArchiveModel:<br/>• task: TaskArchive<br/>• timeTracking: State<br/>━━━━━━━━━━━━━━━<br/>Tasks < 21 days old"]
            ArchiveOld["archiveOld<br/>━━━━━━━━━━━━━━━<br/>ArchiveModel:<br/>• task: TaskArchive<br/>• timeTracking: State<br/>━━━━━━━━━━━━━━━<br/>Tasks > 21 days old"]
        end
    end

    subgraph Writers["What Writes Where"]
        OpLog["OperationLogStoreService"] -->|ops, snapshots| SUPOPS
        Archive["ArchiveService<br/>ArchiveOperationHandler"] -->|"ArchiveModel:<br/>tasks + time tracking"| ArchiveDB
    end

    style SUPOPS fill:#e8f5e9,stroke:#2e7d32,stroke-width:2px
    style ArchiveDB fill:#fff3e0,stroke:#ef6c00,stroke-width:2px
    style Writers fill:#e3f2fd,stroke:#1565c0,stroke-width:2px
```

**关键点：**

| 数据库     | 作用                 | 写入方                                      |
| ---------- | -------------------- | ------------------------------------------- |
| `SUP_OPS`  | 操作日志（事件溯源） | `OperationLogStoreService`                  |
| Archive DB | 归档数据、时间追踪   | `ArchiveService`, `ArchiveOperationHandler` |

## 归档操作流程

归档数据存放在独立 IndexedDB 中，**不在** NgRx state 与 operation log payload 内，因此需要通过统一的 `ArchiveOperationHandler` 特殊处理：

- **本地操作：** `ArchiveOperationHandlerEffects` 经由 `LOCAL_ACTIONS` 路由到 `ArchiveOperationHandler`
- **远端操作：** `OperationApplierService` 在 dispatch 后直接调用 `ArchiveOperationHandler`

两条路径都走同一处理器，以保证行为一致。

```mermaid
flowchart TD
    subgraph LocalOp["LOCAL Operation (User Action)"]
        L1[User archives tasks] --> L2["ArchiveService writes<br/>to IndexedDB<br/>BEFORE dispatch"]
        L2 --> L3[Dispatch moveToArchive]
        L3 --> L4[Meta-reducers update NgRx state]
        L4 --> L5[ArchiveOperationHandlerEffects<br/>via LOCAL_ACTIONS]
        L5 --> L6["ArchiveOperationHandler<br/>.handleOperation<br/>(skips - already written)"]
        L4 --> L7[OperationLogEffects<br/>creates operation in SUP_OPS]
    end

    subgraph RemoteOp["REMOTE Operation (Sync)"]
        R1[Download operation<br/>from sync] --> R2[OperationApplierService<br/>dispatches action]
        R2 --> R3[Meta-reducers update NgRx state]
        R3 --> R4["ArchiveOperationHandler<br/>.handleOperation"]
        R4 --> R5["Write to IndexedDB<br/>(archiveYoung/archiveOld)"]

        NoEffect["❌ Regular effects DON'T run<br/>(action has meta.isRemote=true)"]
    end

    subgraph Storage["Storage Layer"]
        ArchiveDB[("Archive IndexedDB<br/>archiveYoung<br/>archiveOld")]
        SUPOPS_DB[("SUP_OPS IndexedDB<br/>ops table")]
    end

    L2 --> ArchiveDB
    L7 --> SUPOPS_DB
    R5 --> ArchiveDB
    SUPOPS_DB -.->|"Sync downloads ops"| R1

    style LocalOp fill:#e8f5e9,stroke:#2e7d32,stroke-width:2px
    style RemoteOp fill:#e3f2fd,stroke:#1565c0,stroke-width:2px
    style NoEffect fill:#ffebee,stroke:#c62828,stroke-width:2px
    style ArchiveDB fill:#fff3e0,stroke:#ef6c00,stroke-width:2px
    style SUPOPS_DB fill:#e8f5e9,stroke:#2e7d32,stroke-width:2px
```

## ArchiveOperationHandler 集成

`OperationApplierService` 采用 **fail-fast**：若硬依赖缺失，直接抛 `SyncStateCorruptedError`，触发全量重同步。相比复杂重试，这样更安全。

```mermaid
flowchart TD
    subgraph OperationApplierService["OperationApplierService (Fail-Fast)"]
        OA1[Receive operation] --> OA2{Check hard<br/>dependencies}
        OA2 -->|Missing| OA_ERR["throw SyncStateCorruptedError<br/>(triggers full re-sync)"]
        OA2 -->|OK| OA3[convertOpToAction]
        OA3 --> OA4["store.dispatch(action)<br/>with meta.isRemote=true"]
        OA4 --> OA5["archiveOperationHandler<br/>.handleOperation(action)"]
    end

    subgraph Handler["ArchiveOperationHandler"]
        H1{Action Type?}
        H1 -->|moveToArchive| H2["Write tasks to<br/>archiveYoung<br/>REMOTE ONLY"]
        H1 -->|restoreTask| H3["Delete task from<br/>archive"]
        H1 -->|flushYoungToOld| H4["Move old tasks<br/>Young → Old"]
        H1 -->|deleteProject| H5["Remove tasks<br/>for project +<br/>cleanup time tracking"]
        H1 -->|deleteTag/deleteTags| H6["Remove tag<br/>from tasks +<br/>cleanup time tracking"]
        H1 -->|deleteTaskRepeatCfg| H7["Remove repeatCfgId<br/>from tasks"]
        H1 -->|deleteIssueProvider| H8["Unlink issue data<br/>from tasks"]
        H1 -->|deleteIssueProviders| H8b["Unlink multiple<br/>issue providers"]
        H1 -->|other| H9[No-op]
    end

    OA5 --> H1

    style OperationApplierService fill:#e3f2fd,stroke:#1565c0,stroke-width:2px
    style Handler fill:#fff3e0,stroke:#ef6c00,stroke-width:2px
    style OA_ERR fill:#ffcdd2,stroke:#c62828,stroke-width:2px
```

**为什么 Fail-Fast？**

服务端保证按序下发操作，删除动作也由 meta-reducer 保障原子性。若依赖缺失，说明同步状态根本异常；此时全量重同步比局部修补更安全。

## 归档操作汇总

| 操作                   | 本地处理                                                      | 远端处理                                             |
| ---------------------- | ------------------------------------------------------------- | ---------------------------------------------------- |
| `moveToArchive`        | ArchiveService 在 dispatch 前写入；handler 跳过（避免重复写） | ArchiveOperationHandler 在 dispatch 后写入           |
| `restoreTask`          | ArchiveOperationHandlerEffects → ArchiveOperationHandler      | ArchiveOperationHandler 从归档删除                   |
| `flushYoungToOld`      | ArchiveOperationHandlerEffects → ArchiveOperationHandler      | ArchiveOperationHandler 执行 flush                   |
| `deleteProject`        | ArchiveOperationHandlerEffects → ArchiveOperationHandler      | ArchiveOperationHandler 删任务并清理 time tracking   |
| `deleteTag/deleteTags` | ArchiveOperationHandlerEffects → ArchiveOperationHandler      | ArchiveOperationHandler 移除标签并清理 time tracking |
| `deleteTaskRepeatCfg`  | ArchiveOperationHandlerEffects → ArchiveOperationHandler      | ArchiveOperationHandler 移除 repeatCfgId             |
| `deleteIssueProvider`  | ArchiveOperationHandlerEffects → ArchiveOperationHandler      | ArchiveOperationHandler 解绑 issue 数据              |

## 归档“复活”防护（双层）

多客户端并发时，可能出现归档任务被“复活”的竞态：某个字段级 LWW Update（重命名、时间追踪等）与归档并发，导致已归档任务重新回到 active store。

系统采用双层防护：

### 第一层：ConflictResolutionService（Archive-Wins）

在 LWW 冲突处理中，只要 `moveToArchive` 与字段更新冲突，**归档必胜**，与时间戳无关，防止归档意图被覆盖。

```mermaid
flowchart TD
    subgraph Level1["Level 1: Conflict Resolution"]
        C1["Conflict: moveToArchive vs field update"]
        C1 --> C2{"Archive-Wins<br/>Rule"}
        C2 -->|"Archive wins"| C3["Create new archive op<br/>with merged vector clock"]
        C2 -->|"No archive involved"| C4["Normal LWW<br/>timestamp comparison"]
    end

    style Level1 fill:#e8f5e9,stroke:#2e7d32,stroke-width:2px
```

**关键文件：** `src/app/op-log/sync/conflict-resolution.service.ts`

### 第二层：bulkOperationsMetaReducer（预扫描过滤）

在批量应用（同步/恢复）时，meta-reducer 会先扫描整个批次中的 `TASK_SHARED_MOVE_TO_ARCHIVE`，收集所有被归档实体 ID，然后跳过针对这些实体的 `[TASK] LWW Update`。

这覆盖了 **3+ 客户端场景**：同批中归档与 LWW Update 先后混杂，可能绕过第一层。

```mermaid
flowchart TD
    subgraph Level2["Level 2: Bulk Operations Meta-Reducer"]
        B1["Receive batch of operations<br/>[LWW Update, moveToArchive, ...]"]
        B1 --> B2["PRE-SCAN: Collect all<br/>entity IDs being archived"]
        B2 --> B3["For each operation in batch:"]
        B3 --> B4{"Is this an LWW Update<br/>for an archived entity?"}
        B4 -->|"Yes"| B5["⛔ SKIP<br/>(prevents resurrection)"]
        B4 -->|"No"| B6["✅ Apply normally"]
    end

    style Level2 fill:#e3f2fd,stroke:#1565c0,stroke-width:2px
    style B5 fill:#ffcdd2,stroke:#c62828,stroke-width:2px
```

**关键文件：** `src/app/op-log/apply/bulk-hydration.meta-reducer.ts`

### 为什么要两层？

| 场景                                  | 第一层（冲突解决）     | 第二层（批量预扫描） |
| ------------------------------------- | ---------------------- | -------------------- |
| 2 客户端：归档 vs 字段更新            | ✅ 可在 LWW 中捕获     | N/A（不在同批）      |
| 3+ 客户端：同批出现 LWW Update + 归档 | 可能漏掉（上游已解决） | ✅ 预扫描可拦截      |
| Hydration 回放混合操作                | N/A                    | ✅ 预扫描可拦截      |

## 关键文件

| 文件                                                        | 作用                                              |
| ----------------------------------------------------------- | ------------------------------------------------- |
| `src/app/op-log/apply/archive-operation-handler.service.ts` | 统一处理所有归档副作用（本地 + 远端）             |
| `src/app/op-log/apply/archive-operation-handler.effects.ts` | 通过 `LOCAL_ACTIONS` 将本地 action 路由到 handler |
| `src/app/op-log/apply/operation-applier.service.ts`         | 远端操作 dispatch 后调用 handler                  |
| `src/app/op-log/sync/conflict-resolution.service.ts`        | LWW 里的 Archive-Wins 规则                        |
| `src/app/op-log/apply/bulk-hydration.meta-reducer.ts`       | 批量应用时预扫描归档过滤                          |
| `src/app/features/archive/archive.service.ts`               | 本地归档写入（dispatch 前写）                     |
| `src/app/features/archive/task-archive.service.ts`          | 归档 CRUD                                         |
