# SuperSync 与文件同步对比

**最后更新：** 2026 年 1 月  
**状态：** 已实现

本文对比两种同步 Provider 架构：SuperSync（服务端模式）与 File-Based（WebDAV/Dropbox/LocalFile）。

## 并排架构图

```mermaid
graph TB
    subgraph Title[" "]
        direction LR
        T1["<b>SUPERSYNC</b><br/>Server-Based"]
        T2["<b>FILE-BASED</b><br/>File-Based"]
    end

    subgraph SS["SuperSync Architecture"]
        direction TB

        SS_Client["CLIENT"]
        SS_Upload["Upload: POST /ops<br/>━━━━━━━━━━━━━━━<br/>Send ops array<br/>Server assigns seq"]
        SS_Download["Download: GET /ops<br/>━━━━━━━━━━━━━━━<br/>Query since lastSeq<br/>Returns only new ops"]
        SS_Server["SERVER<br/>━━━━━━━━━━━━━━━<br/>Validates sequence<br/>Detects gaps<br/>Returns 409 on conflict"]
        SS_DB[("PostgreSQL<br/>━━━━━━━━━━━━━━━<br/>operations table<br/>All ops forever<br/>Server-assigned seq")]

        SS_Client --> SS_Upload
        SS_Client --> SS_Download
        SS_Upload --> SS_Server
        SS_Download --> SS_Server
        SS_Server --> SS_DB
    end

    subgraph FB["File-Based Architecture"]
        direction TB

        FB_Client["CLIENT"]
        FB_Upload["Upload: uploadFile()<br/>━━━━━━━━━━━━━━━<br/>Download first<br/>Merge + increment ver<br/>Upload entire file"]
        FB_Download["Download: downloadFile()<br/>━━━━━━━━━━━━━━━<br/>Get entire file<br/>Filter ops locally<br/>Detect version changes"]
        FB_Provider["FILE PROVIDER<br/>━━━━━━━━━━━━━━━<br/>WebDAV/Dropbox/Local<br/>Simple file operations<br/>No server logic"]
        FB_File[("sync-data.json<br/>━━━━━━━━━━━━━━━<br/>Full state snapshot<br/>Last 200 ops<br/>Client-managed ver")]

        FB_Client --> FB_Upload
        FB_Client --> FB_Download
        FB_Upload --> FB_Provider
        FB_Download --> FB_Provider
        FB_Provider --> FB_File
    end

    style SS fill:#e3f2fd,stroke:#1565c0,stroke-width:3px
    style FB fill:#fff3e0,stroke:#e65100,stroke-width:3px
    style SS_DB fill:#c8e6c9,stroke:#2e7d32,stroke-width:2px
    style FB_File fill:#ffe0b2,stroke:#e65100,stroke-width:2px
    style Title fill:none,stroke:none
```

## 概念层核心差异

```mermaid
graph LR
    subgraph Concept["KEY DIFFERENCE"]
        direction TB
        C1["Where is the<br/><b>source of truth</b>?"]
        C2["Who manages<br/><b>sequence numbers</b>?"]
        C3["How are<br/><b>conflicts detected</b>?"]
        C4["What gets<br/><b>transferred</b>?"]
        C5["How do<br/><b>late joiners</b> sync?"]
    end

    subgraph SSAnswer["SuperSync"]
        direction TB
        A1["Server's PostgreSQL<br/>database"]
        A2["Server assigns<br/>serverSeq on insert"]
        A3["Server returns 409<br/>with missing ops"]
        A4["Only the ops<br/>that changed"]
        A5["Replay all ops<br/>from server"]
    end

    subgraph FBAnswer["File-Based"]
        direction TB
        B1["The sync file<br/>(sync-data.json)"]
        B2["Client increments<br/>syncVersion locally"]
        B3["Client detects<br/>version mismatch"]
        B4["Entire file<br/>(state + ops)"]
        B5["Get state snapshot<br/>from file"]
    end

    C1 --> A1
    C1 --> B1
    C2 --> A2
    C2 --> B2
    C3 --> A3
    C3 --> B3
    C4 --> A4
    C4 --> B4
    C5 --> A5
    C5 --> B5

    style Concept fill:#f5f5f5,stroke:#333,stroke-width:2px
    style SSAnswer fill:#e3f2fd,stroke:#1565c0,stroke-width:2px
    style FBAnswer fill:#fff3e0,stroke:#e65100,stroke-width:2px
```

## 详细特性对比

| 维度                 | SuperSync                | File-Based                   | 优势方     |
| -------------------- | ------------------------ | ---------------------------- | ---------- |
| **带宽效率**         | 仅传输变化操作           | 每次传输整文件               | SuperSync  |
| **接入复杂度**       | 需要账号 + 服务端        | 可直接用现有云存储           | File-Based |
| **离线时长**         | 理论无限（服务端保全量） | 有上限（仅保留最近 200 ops） | SuperSync  |
| **自托管门槛**       | 需运行服务端             | 只需文件存储                 | File-Based |
| **新设备首同步速度** | 慢（需回放全量 ops）     | 快（直接读快照）             | File-Based |
| **冲突处理**         | 服务端主导               | 客户端 piggybacking          | 平局       |
| **实时同步能力**     | 有（轮询/webhook）       | 无（周期同步）               | SuperSync  |
| **数据恢复能力**     | 全量 op 历史             | 快照 + 最近 200 ops          | SuperSync  |

## 权衡可视化

```mermaid
graph TB
    subgraph Tradeoffs["TRADE-OFFS AT A GLANCE"]
        direction TB

        subgraph Bandwidth["Bandwidth"]
            SS_BW["SuperSync: ✅ LOW<br/>Only delta ops transferred"]
            FB_BW["File-Based: ⚠️ HIGH<br/>Full file each time"]
        end

        subgraph Setup["Setup Effort"]
            SS_Setup["SuperSync: ⚠️ HIGH<br/>Account + server needed"]
            FB_Setup["File-Based: ✅ LOW<br/>Use existing storage"]
        end

        subgraph History["Operation History"]
            SS_Hist["SuperSync: ✅ FULL<br/>All ops stored forever"]
            FB_Hist["File-Based: ⚠️ LIMITED<br/>Only last 200 ops"]
        end

        subgraph LateJoin["Late Joiner Experience"]
            SS_Late["SuperSync: ⚠️ SLOW<br/>Must replay all ops"]
            FB_Late["File-Based: ✅ FAST<br/>Just load snapshot"]
        end

        subgraph Complexity["Client Complexity"]
            SS_Comp["SuperSync: ✅ SIMPLE<br/>Server handles sequences"]
            FB_Comp["File-Based: ⚠️ COMPLEX<br/>Client manages versions"]
        end
    end

    style SS_BW fill:#c8e6c9,stroke:#2e7d32
    style FB_BW fill:#ffecb3,stroke:#ffa000
    style SS_Setup fill:#ffecb3,stroke:#ffa000
    style FB_Setup fill:#c8e6c9,stroke:#2e7d32
    style SS_Hist fill:#c8e6c9,stroke:#2e7d32
    style FB_Hist fill:#ffecb3,stroke:#ffa000
    style SS_Late fill:#ffecb3,stroke:#ffa000
    style FB_Late fill:#c8e6c9,stroke:#2e7d32
    style SS_Comp fill:#c8e6c9,stroke:#2e7d32
    style FB_Comp fill:#ffecb3,stroke:#ffa000
```

## 并发编辑场景对比

```mermaid
sequenceDiagram
    participant A as Client A
    participant B as Client B
    participant SS as SuperSync Server
    participant File as sync-data.json

    Note over A,File: ═══ SUPERSYNC: Server Detects Gap ═══

    rect rgb(227, 242, 253)
        A->>SS: POST /ops [op1, op2]
        SS->>SS: Assign seq 10, 11
        SS-->>A: OK {seqs: [10, 11]}

        B->>SS: POST /ops [op3] (lastKnown: 9)
        SS->>SS: Gap! Client missing 10, 11
        SS-->>B: 409 Conflict {missing: [op1, op2]}
        B->>B: Process missing ops first
        B->>SS: POST /ops [op3] (lastKnown: 11)
        SS-->>B: OK {seqs: [12]}
    end

    Note over A,File: ═══ FILE-BASED: Piggybacking ═══

    rect rgb(255, 243, 224)
        A->>File: Download (v=5)
        A->>A: Merge ops, set v=6
        A->>File: Upload (v=6)

        B->>File: Download (v=5, expects v=5)
        Note over B: Version changed! (now v=6)
        B->>B: Find A's ops in file (piggybacked)
        B->>B: Merge A's ops + own ops
        B->>B: Set v=7
        B->>File: Upload (v=7)
        B->>B: Process piggybacked ops locally
    end
```

## 数据存储结构对比

```mermaid
flowchart TB
    subgraph SuperSync["SuperSync Storage"]
        direction TB
        PG["PostgreSQL Database"]

        subgraph Tables["Tables"]
            OpsTable["operations<br/>━━━━━━━━━━━━━━━<br/>id, client_id, seq<br/>action_type, payload<br/>vector_clock, timestamp"]
            ClientsTable["clients<br/>━━━━━━━━━━━━━━━<br/>client_id, last_seq<br/>created_at"]
        end

        PG --> Tables
    end

    subgraph FileBased["File-Based Storage"]
        direction TB
        SyncFile["sync-data.json"]

        subgraph Contents["Contents"]
            Meta["Metadata<br/>━━━━━━━━━━━━━━━<br/>version, syncVersion<br/>lastModified, checksum"]
            State["State Snapshot<br/>━━━━━━━━━━━━━━━<br/>Full AppDataComplete"]
            Archive["Archive Data<br/>━━━━━━━━━━━━━━━<br/>archiveYoung, archiveOld"]
            RecentOps["Recent Ops (200)<br/>━━━━━━━━━━━━━━━<br/>CompactOperation[]"]
        end

        SyncFile --> Contents
    end

    style SuperSync fill:#e3f2fd,stroke:#1565c0,stroke-width:2px
    style FileBased fill:#fff3e0,stroke:#e65100,stroke-width:2px
```

## 同步流程对比

### 下载流程

```mermaid
sequenceDiagram
    participant Client
    participant SS as SuperSync Server
    participant FB as File Provider

    rect rgb(227, 242, 253)
        Note over Client,SS: SuperSync Download
        Client->>SS: GET /ops?since={lastSeq}
        SS->>SS: Query ops WHERE seq > lastSeq
        SS-->>Client: {ops: [...], lastSeq: N}
        Note over Client: Only receives new ops<br/>Bandwidth efficient
    end

    rect rgb(255, 243, 224)
        Note over Client,FB: File-Based Download
        Client->>FB: downloadFile("sync-data.json")
        FB-->>Client: {state, recentOps, syncVersion}
        Client->>Client: Filter ops by lastProcessedSeq
        Note over Client: Downloads full file<br/>Filters locally
    end
```

### 上传流程

```mermaid
sequenceDiagram
    participant Client
    participant SS as SuperSync Server
    participant FB as File Provider

    rect rgb(227, 242, 253)
        Note over Client,SS: SuperSync Upload
        Client->>SS: POST /ops {ops: [...], lastKnownSeq}
        SS->>SS: Validate sequence continuity
        alt Gap detected
            SS-->>Client: 409 Conflict + missing ops
        else No gap
            SS->>SS: Insert ops, assign seq numbers
            SS-->>Client: 200 OK {assignedSeqs}
        end
    end

    rect rgb(255, 243, 224)
        Note over Client,FB: File-Based Upload
        Client->>FB: downloadFile (get current state)
        FB-->>Client: {syncVersion: N, recentOps}
        Client->>Client: Merge local ops + file ops
        Client->>Client: Find piggybacked ops
        Client->>Client: Set syncVersion = N+1
        Client->>FB: uploadFile(merged data)
        FB-->>Client: Success
        Note over Client: Returns piggybacked ops<br/>for immediate processing
    end
```

## 冲突处理对比

```mermaid
flowchart TB
    subgraph SuperSync["SuperSync Conflict Handling"]
        SS1["Client uploads ops"]
        SS2{"Server checks<br/>sequence gap?"}
        SS3["Gap: Return 409<br/>+ missing ops"]
        SS4["No gap: Accept ops"]
        SS5["Client downloads<br/>missing ops"]
        SS6["LWW resolution<br/>on client"]

        SS1 --> SS2
        SS2 -->|Yes| SS3
        SS2 -->|No| SS4
        SS3 --> SS5
        SS5 --> SS6
    end

    subgraph FileBased["File-Based Conflict Handling"]
        FB1["Client downloads file"]
        FB2{"syncVersion<br/>changed?"}
        FB3["Version match:<br/>Clean upload"]
        FB4["Version changed:<br/>Piggybacking"]
        FB5["Merge all ops"]
        FB6["Upload merged file"]
        FB7["Return piggybacked ops"]
        FB8["LWW resolution<br/>on client"]

        FB1 --> FB2
        FB2 -->|No| FB3
        FB2 -->|Yes| FB4
        FB4 --> FB5
        FB5 --> FB6
        FB6 --> FB7
        FB7 --> FB8
    end

    style SuperSync fill:#e3f2fd,stroke:#1565c0,stroke-width:2px
    style FileBased fill:#fff3e0,stroke:#e65100,stroke-width:2px
```

## 何时选哪种

```mermaid
flowchart TD
    Start["Choose Sync Provider"] --> Q1{Need real-time<br/>multi-device sync?}

    Q1 -->|Yes| Q2{Have SuperSync<br/>account?}
    Q1 -->|No| FileBased

    Q2 -->|Yes| SuperSync
    Q2 -->|No| Q3{Have cloud<br/>storage?}

    Q3 -->|WebDAV/Dropbox| FileBased
    Q3 -->|No| LocalFile

    SuperSync["SuperSync<br/>━━━━━━━━━━━━━━━<br/>• Real-time sync<br/>• Efficient bandwidth<br/>• Server-managed gaps<br/>• Best for active teams"]

    FileBased["File-Based Sync<br/>━━━━━━━━━━━━━━━<br/>• Uses existing storage<br/>• No additional account<br/>• Self-hosted option<br/>• Good for individuals"]

    LocalFile["Local File<br/>━━━━━━━━━━━━━━━<br/>• Manual sync<br/>• Full control<br/>• Backup purposes"]

    style SuperSync fill:#e3f2fd,stroke:#1565c0,stroke-width:2px
    style FileBased fill:#fff3e0,stroke:#e65100,stroke-width:2px
    style LocalFile fill:#e8f5e9,stroke:#2e7d32,stroke-width:2px
```

## 实现细节

### 共享基础设施

两类 Provider 都实现 `OperationSyncCapable`，并共用：

| 组件                        | 作用                   |
| --------------------------- | ---------------------- |
| `OperationLogSyncService`   | 同步时机与流程编排     |
| `ConflictResolutionService` | 并发编辑的 LWW 解决    |
| `VectorClockService`        | 所有操作的因果追踪     |
| `OperationApplierService`   | 将远端 ops 应用到 NgRx |
| `ArchiveOperationHandler`   | 归档副作用处理         |

### Provider 专属组件

| SuperSync              | File-Based                    |
| ---------------------- | ----------------------------- |
| `SuperSyncProvider`    | `FileBasedSyncAdapter`        |
| REST API client        | 文件 Provider 抽象层          |
| 服务端序列号管理       | 客户端 syncVersion 跟踪       |
| 通过 HTTP 409 检测 gap | 通过版本不一致做 piggybacking |

## 关键文件

| 文件                                                 | 作用                    |
| ---------------------------------------------------- | ----------------------- |
| `src/app/op-log/sync-providers/super-sync/`          | SuperSync Provider 实现 |
| `src/app/op-log/sync-providers/file-based/`          | 文件型适配器与类型定义  |
| `src/app/op-log/sync/operation-log-sync.service.ts`  | 共享同步编排            |
| `src/app/op-log/sync/conflict-resolution.service.ts` | LWW 冲突解决            |
