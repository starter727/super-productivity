# 服务端同步架构（SuperSync）

**最后更新：** 2026 年 1 月  
**状态：** 已实现

本图展示了 SuperSync 的完整同步架构：客户端流程、服务端 API 端点、PostgreSQL 数据库操作以及服务端处理流程。

## 主架构图

```mermaid
graph TB
    %% Styles
    classDef client fill:#fff,stroke:#333,stroke-width:2px,color:black;
    classDef api fill:#e3f2fd,stroke:#1565c0,stroke-width:2px,color:black;
    classDef db fill:#e8f5e9,stroke:#2e7d32,stroke-width:2px,color:black;
    classDef conflict fill:#ffebee,stroke:#c62828,stroke-width:2px,color:black;
    classDef validation fill:#fff3e0,stroke:#ef6c00,stroke-width:2px,color:black;

    %% CLIENT SIDE
    subgraph Client["CLIENT (Angular)"]
        direction TB

        subgraph SyncLoop["Sync Loop"]
            Scheduler((Scheduler)) -->|Interval| SyncService["OperationLogSyncService"]
            SyncService -->|1. Get lastSyncedSeq| LocalMeta["SUP_OPS IndexedDB"]
        end

        subgraph DownloadFlow["Download Flow"]
            SyncService -->|"2. GET /api/sync/ops?sinceSeq=N"| DownAPI
            DownAPI -->|Response| GapCheck{Gap Detected?}
            GapCheck -- "Yes + Empty Server" --> ServerMigration["Server Migration:<br/>Create SYNC_IMPORT"]
            GapCheck -- "Yes + Has Ops" --> ResetSeq["Reset sinceSeq=0<br/>Re-download all"]
            GapCheck -- No --> FreshCheck{Fresh Client?}
            ResetSeq --> FreshCheck
            FreshCheck -- "Yes + Has Ops" --> ConfirmDialog["Confirmation Dialog"]
            FreshCheck -- No --> FilterApplied
            ConfirmDialog -- Confirmed --> FilterApplied{Already Applied?}
            ConfirmDialog -- Cancelled --> SkipDownload[Skip]
            FilterApplied -- Yes --> Discard[Discard]
            FilterApplied -- No --> ConflictDet
        end

        subgraph ConflictMgmt["Conflict Management (LWW Auto-Resolution)"]
            ConflictDet{"Compare<br/>Vector Clocks"}:::conflict
            ConflictDet -- Sequential --> ApplyRemote
            ConflictDet -- Concurrent --> AutoCheck{"Auto-Resolve?"}

            AutoCheck -- "Both DELETE or<br/>Identical payload" --> AutoResolve["Auto: Keep Remote"]
            AutoCheck -- "Real conflict" --> LWWResolve["LWW: Compare<br/>Timestamps"]:::conflict

            AutoResolve --> MarkRejected
            LWWResolve -- "Remote newer<br/>or tie" --> MarkRejected[Mark Local Rejected]:::conflict
            LWWResolve -- "Local newer" --> LocalWins["Create Update Op<br/>with local state"]:::conflict
            LocalWins --> RejectBoth[Mark both rejected]
            RejectBoth --> CreateNewOp[New op syncs local state]
            MarkRejected --> ApplyRemote
        end

        subgraph Application["Application & Validation"]
            ApplyRemote -->|Dispatch| NgRx["NgRx Store"]
            NgRx --> Validator{Valid State?}
            Validator -- Yes --> SyncDone((Done))
            Validator -- No --> Repair["Auto-Repair"]:::conflict
            Repair --> NgRx
        end

        subgraph UploadFlow["Upload Flow"]
            LocalMeta -->|Get Unsynced| PendingOps[Pending Ops]
            PendingOps --> FreshUploadCheck{Fresh Client?}
            FreshUploadCheck -- Yes --> BlockUpload["Block Upload<br/>(must download first)"]
            FreshUploadCheck -- No --> FilterRejected{Rejected?}
            FilterRejected -- Yes --> SkipRejected[Skip]
            FilterRejected -- No --> ClassifyOp{Op Type?}

            ClassifyOp -- "SYNC_IMPORT<br/>BACKUP_IMPORT<br/>REPAIR" --> SnapshotAPI
            ClassifyOp -- "CRT/UPD/DEL/MOV/BATCH" --> OpsAPI

            OpsAPI -->|Response with<br/>piggybackedOps| ProcessPiggybacked["Process Piggybacked<br/>(→ Conflict Detection)"]
            ProcessPiggybacked --> ConflictDet
        end
    end

    %% SERVER API LAYER
    subgraph Server["SERVER (Fastify + Node.js)"]
        direction TB

        subgraph APIEndpoints["API Endpoints"]
            DownAPI["GET /api/sync/ops<br/>━━━━━━━━━━━━━━━<br/>Download operations<br/>Query: sinceSeq, limit"]:::api
            OpsAPI["POST /api/sync/ops<br/>━━━━━━━━━━━━━━━<br/>Upload operations<br/>Body: ops[], clientId"]:::api
            SnapshotAPI["POST /api/sync/snapshot<br/>━━━━━━━━━━━━━━━<br/>Upload full state<br/>Body: state, reason"]:::api
            GetSnapshotAPI["GET /api/sync/snapshot<br/>━━━━━━━━━━━━━━━<br/>Get full state"]:::api
            StatusAPI["GET /api/sync/status<br/>━━━━━━━━━━━━━━━<br/>Check sync status"]:::api
            RestoreAPI["GET /api/sync/restore/:seq<br/>━━━━━━━━━━━━━━━<br/>Restore to point"]:::api
        end

        subgraph ServerProcessing["Server-Side Processing (SyncService)"]
            direction TB

            subgraph Validation["1. Validation"]
                V1["Validate op.id, opType"]
                V2["Validate entityType allowlist"]
                V3["Sanitize vectorClock"]
                V4["Check payload size"]
                V5["Check timestamp drift"]
            end

            subgraph ConflictCheck["2. Conflict Detection"]
                C1["Find latest op for entity"]
                C2["Compare vector clocks"]
                C3{Result?}
                C3 -- GREATER_THAN --> C4[Accept]
                C3 -- CONCURRENT --> C5[Reject]
                C3 -- LESS_THAN --> C6[Reject]
            end

            subgraph Persist["3. Persistence (REPEATABLE_READ)"]
                P1["Increment lastSeq"]
                P2["Re-check conflict"]
                P3["INSERT operation"]
                P4{DEL op?}
                P4 -- Yes --> P5["UPSERT tombstone"]
                P4 -- No --> P6[Skip]
                P7["UPSERT sync_device"]
            end
        end
    end

    %% POSTGRESQL DATABASE
    subgraph PostgreSQL["POSTGRESQL DATABASE"]
        direction TB

        OpsTable[("operations<br/>━━━━━━━━━━━━━━━<br/>id, serverSeq<br/>opType, entityType<br/>entityId, payload<br/>vectorClock<br/>clientTimestamp")]:::db

        SyncState[("user_sync_state<br/>━━━━━━━━━━━━━━━<br/>lastSeq<br/>snapshotData<br/>lastSnapshotSeq")]:::db

        Devices[("sync_devices<br/>━━━━━━━━━━━━━━━<br/>clientId<br/>lastSeenAt<br/>lastAckedSeq")]:::db

        Tombstones[("tombstones<br/>━━━━━━━━━━━━━━━<br/>entityType<br/>entityId<br/>deletedAt")]:::db
    end

    %% CONNECTIONS: API -> Processing
    OpsAPI --> V1
    SnapshotAPI --> V1
    V1 --> V2 --> V3 --> V4 --> V5
    V5 --> C1 --> C2 --> C3
    C4 --> P1 --> P2 --> P3 --> P4
    P5 --> P7
    P6 --> P7

    %% CONNECTIONS: Processing -> Database
    P1 -.->|"UPDATE"| SyncState
    P3 -.->|"INSERT"| OpsTable
    P5 -.->|"UPSERT"| Tombstones
    P7 -.->|"UPSERT"| Devices

    %% CONNECTIONS: Read endpoints -> Database
    DownAPI -.->|"SELECT ops > sinceSeq"| OpsTable
    DownAPI -.->|"SELECT lastSeq"| SyncState
    GetSnapshotAPI -.->|"SELECT snapshot"| SyncState
    GetSnapshotAPI -.->|"SELECT (replay)"| OpsTable
    StatusAPI -.->|"SELECT"| SyncState
    StatusAPI -.->|"COUNT"| Devices
    RestoreAPI -.->|"SELECT (replay)"| OpsTable

    %% Subgraph styles
    style Validation fill:#fff3e0,stroke:#ef6c00,stroke-width:2px
    style ConflictCheck fill:#ffebee,stroke:#c62828,stroke-width:2px
    style Persist fill:#e8f5e9,stroke:#2e7d32,stroke-width:2px
    style PostgreSQL fill:#e8f5e9,stroke:#2e7d32,stroke-width:2px
    style APIEndpoints fill:#e3f2fd,stroke:#1565c0,stroke-width:2px
```

## 快速参考表

### API 端点

| 端点                       | 方法 | 作用                        | 数据库操作                                                            |
| -------------------------- | ---- | --------------------------- | --------------------------------------------------------------------- |
| `/api/sync/ops`            | POST | 上传操作                    | INSERT ops, UPDATE lastSeq, UPSERT device, UPSERT tombstone（DEL 时） |
| `/api/sync/ops?sinceSeq=N` | GET  | 下载操作                    | SELECT ops, SELECT lastSeq, 查找最新快照（跳过优化）                  |
| `/api/sync/snapshot`       | POST | 上传全量状态（SYNC_IMPORT） | 同 POST /ops + UPDATE 快照缓存                                        |
| `/api/sync/snapshot`       | GET  | 获取全量状态                | SELECT snapshot（过期则回放 ops）                                     |
| `/api/sync/status`         | GET  | 查询同步状态                | SELECT lastSeq, COUNT devices                                         |
| `/api/sync/restore-points` | GET  | 列出恢复点                  | SELECT ops（过滤 SYNC_IMPORT/BACKUP_IMPORT/REPAIR）                   |
| `/api/sync/restore/:seq`   | GET  | 恢复到指定点                | SELECT ops，回放到 targetSeq                                          |

### PostgreSQL 表

| 表名              | 作用                      | 关键列                                                  |
| ----------------- | ------------------------- | ------------------------------------------------------- |
| `operations`      | 事件日志（append-only）   | id, serverSeq, opType, entityType, payload, vectorClock |
| `user_sync_state` | 用户级元数据 + 缓存快照   | lastSeq, snapshotData, lastSnapshotSeq                  |
| `sync_devices`    | 设备跟踪                  | clientId, lastSeenAt, lastAckedSeq                      |
| `tombstones`      | 删除实体跟踪（30 天保留） | entityType, entityId, deletedAt, expiresAt              |

### 关键实现细节

- **事务隔离级别：** `REPEATABLE_READ`，防止冲突检测中的幻读
- **双重冲突检查：** 分配序列号前后都检查一次（防竞态）
- **幂等性：** 重复 op ID 会返回 `DUPLICATE_OPERATION`
- **Gzip 支持：** 上传/下载都支持 `Content-Encoding: gzip`
- **限流：** 用户级限流（100 次上传/分钟，200 次下载/分钟）
- **同质冲突自动处理：** 两边都 DELETE 或 payload 相同，自动按 remote 解决
- **LWW 自动解决：** 真实冲突按时间戳走 Last-Write-Wins
- **新客户端安全：** 无历史客户端禁止上传，首次拉取远端前显示确认
- **Piggybacked Ops：** 上传响应携带新远端操作，立即处理并触发冲突检测
- **Gap 检测：** `gapDetected: true` 时客户端重置到 seq=0 全量重拉
- **服务端迁移：** Gap + 空服务器（无 ops）时，客户端创建 `SYNC_IMPORT` 初始化服务器
- **快照跳过优化：** 当 `sinceSeq < latestSnapshotSeq` 时，服务端可跳过快照前操作

## 通过 Snapshot 端点处理全量状态操作

`BackupImport`、`Repair`、`SyncImport` 这类全量状态操作会携带完整应用状态，可能超出普通 `/api/sync/ops` 的 body 限制（约 30MB），因此会走 `/api/sync/snapshot`。

```mermaid
flowchart TB
    subgraph "Upload Decision Flow"
        GetUnsynced[Get Unsynced Operations<br/>from IndexedDB]
        Classify{Classify by OpType}

        GetUnsynced --> Classify

        subgraph FullStateOps["Full-State Operations"]
            SyncImport[OpType.SyncImport]
            BackupImport[OpType.BackupImport]
            Repair[OpType.Repair]
        end

        subgraph RegularOps["Regular Operations"]
            CRT[OpType.CRT]
            UPD[OpType.UPD]
            DEL[OpType.DEL]
            MOV[OpType.MOV]
            BATCH[OpType.BATCH]
        end

        Classify --> FullStateOps
        Classify --> RegularOps

        FullStateOps --> SnapshotPath
        RegularOps --> OpsPath

        subgraph SnapshotPath["Snapshot Endpoint Path"]
            MapReason["Map OpType to reason:<br/>SyncImport → 'initial'<br/>BackupImport → 'recovery'<br/>Repair → 'recovery'"]
            Encrypt1{E2E Encryption<br/>Enabled?}
            EncryptPayload[Encrypt state payload]
            UploadSnapshot["POST /api/sync/snapshot<br/>{state, clientId, reason,<br/>vectorClock, schemaVersion}"]
        end

        subgraph OpsPath["Ops Endpoint Path"]
            Encrypt2{E2E Encryption<br/>Enabled?}
            EncryptOps[Encrypt operation payloads]
            Batch[Batch up to 100 ops]
            UploadOps["POST /api/sync/ops<br/>{ops[], clientId, lastKnownSeq}"]
        end

        MapReason --> Encrypt1
        Encrypt1 -- Yes --> EncryptPayload
        Encrypt1 -- No --> UploadSnapshot
        EncryptPayload --> UploadSnapshot

        Encrypt2 -- Yes --> EncryptOps
        Encrypt2 -- No --> Batch
        EncryptOps --> Batch
        Batch --> UploadOps
    end

    UploadSnapshot --> MarkSynced[Mark Operation as Synced]
    UploadOps --> MarkSynced

    style FullStateOps fill:#e3f2fd,stroke:#1565c0,stroke-width:2px
    style RegularOps fill:#c8e6c9,stroke:#2e7d32,stroke-width:2px
    style SnapshotPath fill:#fff3e0,stroke:#ef6c00,stroke-width:2px
    style OpsPath fill:#e8f5e9,stroke:#2e7d32,stroke-width:2px
```

## Gap 检测

Gap 检测用于识别“无法可靠增量同步、必须纠偏”的场景。

### 四类 Gap 场景

| 场景 | 条件                              | 含义                     | 常见原因             |
| ---- | --------------------------------- | ------------------------ | -------------------- |
| 1    | `sinceSeq > 0 && latestSeq === 0` | 客户端有历史，服务器为空 | 服务器被重置/迁移    |
| 2    | `sinceSeq > latestSeq`            | 客户端序列领先服务端     | 服务端从旧备份恢复   |
| 3    | `sinceSeq < minSeq - 1`           | 请求的操作已被清理       | 保留策略删除了旧操作 |
| 4    | `firstOpSeq > sinceSeq + 1`       | 序列号出现断层           | 数据库损坏或人工删除 |

### 客户端处理流程

```mermaid
flowchart TD
    Download["Download ops from server"]
    GapCheck{gapDetected?}
    Reset["Reset sinceSeq = 0<br/>Clear accumulated ops"]
    ReDownload["Re-download from beginning"]
    HasReset{Already reset<br/>this session?}
    ServerEmpty{Server empty?<br/>latestSeq === 0}
    Migration["Server Migration:<br/>Create SYNC_IMPORT<br/>with full local state"]
    Continue["Process downloaded ops normally"]

    Download --> GapCheck
    GapCheck -->|Yes| HasReset
    HasReset -->|No| Reset
    Reset --> ReDownload
    ReDownload --> GapCheck
    HasReset -->|Yes| ServerEmpty
    GapCheck -->|No| Continue
    ServerEmpty -->|Yes| Migration
    ServerEmpty -->|No| Continue
    Migration --> Continue

    style Migration fill:#fff3e0,stroke:#e65100,stroke-width:2px
    style Reset fill:#e3f2fd,stroke:#1565c0,stroke-width:2px
```

## 关键文件

| 文件                                                    | 作用                   |
| ------------------------------------------------------- | ---------------------- |
| `src/app/op-log/sync/operation-log-sync.service.ts`     | 同步编排主入口         |
| `src/app/op-log/sync/operation-log-upload.service.ts`   | 上传逻辑               |
| `src/app/op-log/sync/operation-log-download.service.ts` | 下载逻辑               |
| `src/app/op-log/sync/conflict-resolution.service.ts`    | LWW 冲突解决           |
| `src/app/op-log/sync/server-migration.service.ts`       | 服务端迁移（空服务器） |
| `packages/super-sync-server/src/sync/`                  | 服务端同步实现         |
