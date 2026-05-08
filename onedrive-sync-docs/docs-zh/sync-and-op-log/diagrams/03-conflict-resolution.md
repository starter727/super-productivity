# 冲突解决与 SYNC_IMPORT 过滤

**最后更新：** 2026 年 2 月  
**状态：** 已实现

本文档涵盖 LWW（Last-Write-Wins）自动冲突解决，以及带“清空重建（clean slate）语义”的 SYNC_IMPORT 过滤机制。

## LWW 自动冲突解决

当两个客户端并发修改同一实体时会产生冲突。系统不会弹窗打断用户，而是基于操作时间戳用 **LWW** 自动裁决。

### 什么是冲突？

当向量时钟比较结果是 `CONCURRENT` 时即为冲突，即双方都不是“先于”对方的操作，代表独立并发编辑。

```mermaid
flowchart TD
    subgraph Detection["Conflict Detection (Vector Clocks)"]
        Download[Download remote ops] --> Compare{Compare Vector Clocks}

        Compare -->|"LESS_THAN<br/>(remote is older)"| Discard["Discard remote<br/>(already have it)"]
        Compare -->|"GREATER_THAN<br/>(remote is newer)"| Apply["Apply remote<br/>(sequential update)"]
        Compare -->|"CONCURRENT<br/>(independent edits)"| Conflict["⚠️ CONFLICT<br/>Both changed same entity"]
    end

    subgraph Example["Example: Concurrent Edits"]
        direction LR
        ClientA["Client A<br/>Clock: {A:5, B:3}<br/>Marks task done"]
        ClientB["Client B<br/>Clock: {A:4, B:4}<br/>Renames task"]

        ClientA -.->|"Neither dominates"| Concurrent["CONCURRENT<br/>A has more A,<br/>B has more B"]
        ClientB -.-> Concurrent
    end

    Conflict --> Resolution["LWW Resolution"]

    style Conflict fill:#ffebee,stroke:#c62828,stroke-width:2px
    style Concurrent fill:#fff3e0,stroke:#ef6c00,stroke-width:2px
```

### LWW 解决算法

系统会比较每个操作向量时钟中的**最大时间戳**。较晚者胜出；若相同则 remote 胜（保证收敛）。

```mermaid
flowchart TD
    subgraph Input["Conflicting Operations"]
        Local["LOCAL Operation<br/>━━━━━━━━━━━━━━━<br/>vectorClock: {A:5, B:3}<br/>timestamps: [1702900000, 1702899000]<br/>maxTimestamp: 1702900000"]
        Remote["REMOTE Operation<br/>━━━━━━━━━━━━━━━<br/>vectorClock: {A:4, B:4}<br/>timestamps: [1702898000, 1702901000]<br/>maxTimestamp: 1702901000"]
    end

    subgraph Algorithm["LWW Comparison"]
        GetMax["Extract max timestamp<br/>from each vector clock"]
        Compare{"Compare<br/>Timestamps"}

        GetMax --> Compare

        Compare -->|"Local > Remote"| LocalWins["🏆 LOCAL WINS<br/>Local state preserved<br/>Create UPDATE op to sync"]
        Compare -->|"Remote > Local<br/>OR tie"| RemoteWins["🏆 REMOTE WINS<br/>Apply remote state<br/>Reject local op"]
    end

    Local --> GetMax
    Remote --> GetMax

    subgraph Outcome["Resolution Outcome"]
        LocalWins --> CreateOp["Create new UPDATE operation<br/>with current entity state<br/>+ merged vector clock"]
        RemoteWins --> MarkRejected["Mark local op as rejected<br/>Apply remote op"]

        CreateOp --> Sync["New op syncs to server<br/>Other clients receive update"]
        MarkRejected --> Apply["Remote state applied<br/>User sees change"]
    end

    style LocalWins fill:#e8f5e9,stroke:#2e7d32,stroke-width:2px
    style RemoteWins fill:#e3f2fd,stroke:#1565c0,stroke-width:2px
    style CreateOp fill:#c8e6c9,stroke:#2e7d32,stroke-width:2px
```

### 两种可能结果

```mermaid
flowchart LR
    subgraph RemoteWinsPath["REMOTE WINS (more common)"]
        direction TB
        RW1["Remote timestamp >= Local timestamp"]
        RW2["Mark local op as REJECTED"]
        RW3["Apply remote operation"]
        RW4["Local change is overwritten"]

        RW1 --> RW2 --> RW3 --> RW4
    end

    subgraph LocalWinsPath["LOCAL WINS (less common)"]
        direction TB
        LW1["Local timestamp > Remote timestamp"]
        LW2["Mark BOTH ops as rejected"]
        LW3["Keep current local state"]
        LW4["Create NEW update operation<br/>with merged vector clock"]
        LW5["New op syncs to server"]
        LW6["Other clients receive<br/>local state as update"]

        LW1 --> LW2 --> LW3 --> LW4 --> LW5 --> LW6
    end

    style RemoteWinsPath fill:#e3f2fd,stroke:#1565c0,stroke-width:2px
    style LocalWinsPath fill:#e8f5e9,stroke:#2e7d32,stroke-width:2px
```

### 完整 LWW 流程

```mermaid
sequenceDiagram
    participant A as Client A
    participant S as Server
    participant B as Client B

    Note over A,B: Both start with Task "Buy milk"

    A->>A: User marks task done (T=100)
    B->>B: User renames to "Buy oat milk" (T=105)

    Note over A,B: Both go offline, then reconnect

    B->>S: Upload: Rename op (T=105)
    S-->>B: OK (serverSeq=50)

    A->>S: Upload: Done op (T=100)
    S-->>A: Rejected (CONCURRENT with seq=50)
    S-->>A: Piggybacked: Rename op from B

    Note over A: Conflict detected!<br/>Local: Done (T=100)<br/>Remote: Rename (T=105)

    A->>A: LWW: Remote wins (105 > 100)
    A->>A: Mark local op REJECTED
    A->>A: Apply remote (rename)
    A->>A: Show snackbar notification

    Note over A: Task is now "Buy oat milk"<br/>(not done - A's change lost)

    A->>S: Sync (download only)
    B->>S: Sync
    S-->>B: No new ops

    Note over A,B: ✅ Both clients converged<br/>Task: "Buy oat milk" (not done)
```

### 用户提示

```mermaid
flowchart LR
    subgraph Resolution["After LWW Resolution"]
        Resolved["Conflicts resolved"]
    end

    subgraph Notification["User Notification"]
        Snack["📋 Snackbar<br/>━━━━━━━━━━━━━━━<br/>'X conflicts were<br/>auto-resolved'<br/>━━━━━━━━━━━━━━━<br/>Non-blocking<br/>Auto-dismisses"]
    end

    subgraph Backup["Safety Net"]
        BackupCreated["💾 Safety Backup<br/>━━━━━━━━━━━━━━━<br/>Created BEFORE resolution<br/>User can restore if needed"]
    end

    Resolution --> Notification
    Resolution --> Backup

    style Snack fill:#fff3e0,stroke:#ef6c00,stroke-width:2px
    style BackupCreated fill:#e8f5e9,stroke:#2e7d32,stroke-width:2px
```

### 归档优先例外（Archive-Wins）

当 `moveToArchive` 与字段级更新（重命名、时间追踪等）冲突时，**归档永远胜出**，与时间戳无关。因为归档代表明确用户意图，不应被反向恢复。

```mermaid
flowchart TD
    subgraph ArchiveCheck["Archive-Wins Check (Before LWW)"]
        Conflict["Conflict detected"] --> IsArchive{"Does either side<br/>contain moveToArchive?"}

        IsArchive -->|"Yes"| ArchiveWins["🏆 ARCHIVE WINS<br/>Regardless of timestamps"]
        IsArchive -->|"No"| NormalLWW["Proceed to normal<br/>LWW timestamp comparison"]
    end

    ArchiveWins --> CreateOp["Create new archive op<br/>with merged vector clock<br/>via _createArchiveWinOp()"]

    style ArchiveWins fill:#fff3e0,stroke:#ef6c00,stroke-width:2px
    style NormalLWW fill:#e3f2fd,stroke:#1565c0,stroke-width:2px
```

**为什么要这样？** 若没有此规则，并发字段更新在 LWW 中可能“复活”已归档任务（把状态写回 active store）。Archive-Wins 是第一层防线，`bulkOperationsMetaReducer` 是第二层防线（见 [06-archive-operations.md](./06-archive-operations.md)）。

### 关键实现细节

| 项目             | 实现                                           |
| ---------------- | ---------------------------------------------- |
| **时间戳来源**   | `Math.max(...Object.values(vectorClock))`      |
| **平局规则**     | remote 胜（保证所有客户端最终收敛）            |
| **归档例外**     | `moveToArchive` 优先于字段更新，跳过时间戳比较 |
| **安全备份**     | 通过 `BackupService` 在解决前创建              |
| **本地胜出更新** | 生成新 `OpType.UPD`，并携带合并后向量时钟      |
| **向量时钟合并** | `mergeVectorClocks(localClock, remoteClock)`   |
| **实体状态读取** | 通过实体选择器从 NgRx store 读取               |
| **用户提示**     | 非阻塞 snackbar，展示自动解决数量              |

---

## 带 Clean Slate 语义的 SYNC_IMPORT 过滤

当收到 `SYNC_IMPORT`/`BACKUP_IMPORT` 时，表示用户明确发起“恢复到某个时间点”。系统会通过向量时钟过滤掉所有“在不知道这次导入的前提下产生”的操作。

### 问题：导入后的过期操作

```mermaid
sequenceDiagram
    participant A as Client A
    participant S as Server
    participant B as Client B

    Note over A,B: Both start synced

    A->>A: Create Op1, Op2 (offline)

    Note over B: Client B does SYNC_IMPORT<br/>(restores from backup)

    B->>S: Upload SYNC_IMPORT

    Note over A: Client A comes online

    A->>S: Upload Op1, Op2
    A->>A: Download SYNC_IMPORT

    Note over A: Problem: Op1, Op2 reference<br/>entities that were WIPED by import
```

### 方案：Clean Slate 语义

`SYNC_IMPORT/BACKUP_IMPORT` 表示“以此状态为新起点”。**所有不知道这次导入的操作都应丢弃**，从而实现真正的时间点恢复语义。

这里必须用**向量时钟比较**（而不是 UUIDv7 时间戳），因为向量时钟表示的是**因果关系**（创建操作时是否知道这次导入），而墙钟时间会受设备时钟漂移影响。

```mermaid
flowchart TD
    subgraph Input["Remote Operations Received"]
        Ops["Op1, Op2, SYNC_IMPORT, Op3, Op4"]
    end

    subgraph Filter["SyncImportFilterService"]
        FindImport["Find latest SYNC_IMPORT<br/>(in batch or local store)"]
        Compare["Compare each op's vector clock<br/>against import's vector clock"]
    end

    subgraph Results["Vector Clock Comparison"]
        GT["GREATER_THAN<br/>Op created AFTER seeing import"]
        EQ["EQUAL<br/>Same causal history"]
        LT["LESS_THAN<br/>Op dominated by import"]
        CC["CONCURRENT<br/>Op created WITHOUT<br/>knowledge of import"]
    end

    subgraph Outcome["Outcome"]
        Keep["✅ KEEP"]
        Drop["❌ DROP"]
    end

    Input --> FindImport
    FindImport --> Compare
    Compare --> GT
    Compare --> EQ
    Compare --> LT
    Compare --> CC

    GT --> Keep
    EQ --> Keep
    LT --> Drop
    CC --> Drop

    style GT fill:#c8e6c9,stroke:#2e7d32
    style EQ fill:#c8e6c9,stroke:#2e7d32
    style LT fill:#ffcdd2,stroke:#c62828
    style CC fill:#ffcdd2,stroke:#c62828
    style Keep fill:#e8f5e9,stroke:#2e7d32
    style Drop fill:#ffebee,stroke:#c62828
```

### 向量时钟比较结果

| 比较结果       | 含义                   | 处理                   |
| -------------- | ---------------------- | ---------------------- |
| `GREATER_THAN` | 该操作创建时已知道导入 | ✅ 保留                |
| `EQUAL`        | 与导入处于同一因果历史 | ✅ 保留                |
| `LESS_THAN`    | 被导入状态支配         | ❌ 丢弃                |
| `CONCURRENT`   | 创建时不知道导入       | ❌ 丢弃（clean slate） |

### 为什么不用 UUIDv7？

向量时钟追踪的是**因果关系**（是否“知道导入”）。UUIDv7 只反映墙钟时间，设备间时钟漂移会导致误判。

```mermaid
flowchart LR
    subgraph UUIDv7["❌ UUIDv7 Approach (Previous)"]
        direction TB
        U1["Client B's clock is 2 hours AHEAD"]
        U2["B creates op at REAL time 10:00"]
        U3["UUIDv7 timestamp = 12:00<br/>(wrong due to clock drift)"]
        U4["SYNC_IMPORT at 11:00"]
        U5["Filter check: 12:00 > 11:00"]
        U6["🐛 NOT FILTERED!<br/>Old op applied, corrupts state"]

        U1 --> U2 --> U3 --> U4 --> U5 --> U6
    end

    subgraph VectorClock["✅ Vector Clock Approach (Current)"]
        direction TB
        V1["Client B's clock is 2 hours AHEAD"]
        V2["B creates op (offline)"]
        V3["op.vectorClock = {A: 2, B: 3}<br/>(wall-clock time irrelevant)"]
        V4["SYNC_IMPORT.vectorClock = {A: 3}"]
        V5["Compare: {A:2,B:3} vs {A:3}<br/>Result: CONCURRENT"]
        V6["✅ FILTERED!<br/>Op created without knowledge of import"]

        V1 --> V2 --> V3 --> V4 --> V5 --> V6
    end

    style U6 fill:#ffcccc
    style V6 fill:#ccffcc
```

## 关键文件

| 文件                                                           | 作用                             |
| -------------------------------------------------------------- | -------------------------------- |
| `src/app/op-log/sync/conflict-resolution.service.ts`           | LWW 自动冲突解决                 |
| `src/app/op-log/sync/rejected-ops-handler.service.ts`          | 处理服务端拒绝、卡住冲突重试上限 |
| `src/app/op-log/sync/superseded-operation-resolver.service.ts` | 生成带合并向量时钟的替代操作     |
| `src/app/op-log/sync/sync-import-filter.service.ts`            | SYNC_IMPORT 过滤逻辑             |
| `src/app/op-log/sync/operation-log-download.service.ts`        | 下载并应用远端操作               |
| `src/app/op-log/sync/vector-clock.service.ts`                  | 向量时钟比较工具                 |
