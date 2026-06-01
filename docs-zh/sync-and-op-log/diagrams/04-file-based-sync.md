# 文件型同步架构（File-Based Sync Architecture）

**最后更新：** 2026 年 1 月
**状态：** 已实现

本文档包含说明文件型提供商（WebDAV、Dropbox、LocalFile）统一操作日志同步架构的图表。

## 概述

文件型同步使用单个 `sync-data.json` 文件，其中包含：

- 完整的应用状态快照
- 近期操作缓冲区（最近 200 条操作）
- 用于冲突检测的向量时钟（Vector Clock）
- 供后续加入客户端使用的归档数据

```mermaid
flowchart TB
    subgraph Remote["远程存储（Remote Storage）(WebDAV/Dropbox/LocalFile)"]
        subgraph Folder["/superProductivity/"]
            SyncFile["sync-data.json<br/>━━━━━━━━━━━━━━━━━<br/>加密 + 压缩"]
        end
    end

    subgraph Contents["sync-data.json 内容"]
        direction TB
        Meta["📵 元数据（Metadata）<br/>• version: 2<br/>• syncVersion: N（锁机制）<br/>• schemaVersion<br/>• lastModified<br/>• clientId<br/>• checksum"]

        VClock["🕰 向量时钟（Vector Clock）<br/>• {clientA: 42, clientB: 17}<br/>• 追踪因果关系"]

        State["📝 状态快照（State Snapshot）<br/>━━━━━━━━━━━━━━━━━<br/>• tasks: TaskState<br/>• projects: ProjectState<br/>• tags: TagState<br/>• notes: NoteState<br/>• globalConfig<br/>• issueProviders<br/>• planner<br/>• simpleCounters<br/>• taskRepeatCfg"]

        Archive["🗄 归档数据（Archive Data）<br/>━━━━━━━━━━━━━━━━━<br/>• archiveYoung: ArchiveModel<br/>• archiveOld: ArchiveModel<br/>━━━━━━━━━━━━━━━━━<br/>确保后续加入的客户端能获取完整的归档历史"]

        Ops["📑 近期操作（Recent Operations，最近 200 条）<br/>━━━━━━━━━━━━━━━━━<br/>• id, clientId, actionType<br/>• opType, entityType, entityId<br/>• payload, vectorClock<br/>• timestamp<br/>━━━━━━━━━━━━━━━━━<br/>用于冲突检测"]
    end

    SyncFile --> Contents

    style SyncFile fill:#fff3e0,stroke:#e65100,stroke-width:2px
    style State fill:#e8f5e9,stroke:#2e7d32,stroke-width:2px
    style Archive fill:#fce4ec,stroke:#c2185b,stroke-width:2px
    style Ops fill:#e1f5fe,stroke:#01579b,stroke-width:2px
```

### 为什么选择单文件而非分离的快照 + 操作文件？

| 单文件（已选）                | 双文件（曾考虑）                |
| --------------------------- | --------------------------- |
| 原子性：全有或全无            | 存在部分上传风险                |
| 只需跟踪一个版本              | 需要版本协调                   |
| 冲突解决简单                  | 需要在两处处理                 |
| 易于恢复                     | 可能出现不一致状态              |
| 每次上传完整状态              | 通常只上传操作                  |

带宽成本是可接受的：状态压缩效果好（约 90%），且同步频率不高。

## 架构总览

展示 `FileBasedSyncAdapter` 如何集成到现有的操作日志系统中，通过文件操作实现 `OperationSyncCapable` 接口。

```mermaid
flowchart TB
    subgraph Client["客户端应用（Client Application）"]
        NgRx["NgRx 存储<br/>（运行时状态）"]
        OpLogEffects["OperationLogEffects"]
        OpLogStore["SUP_OPS IndexedDB<br/>（操作 + 状态缓存）"]

        subgraph SyncServices["同步服务（Sync Services）"]
            SyncService["OperationLogSyncService"]
            ConflictRes["ConflictResolutionService"]
            VectorClock["VectorClockService"]
        end

        subgraph ProviderLayer["提供商抽象层（Provider Abstraction）"]
            FileAdapter["FileBasedSyncAdapter<br/>（实现 OperationSyncCapable）"]
            SuperSync["SuperSyncProvider<br/>（现有基于 API 的）"]

            subgraph FileProviders["文件提供商（File Providers）"]
                WebDAV["WebDAV"]
                Dropbox["Dropbox"]
                LocalFile["LocalFile"]
            end
        end
    end

    subgraph RemoteStorage["远程存储（Remote Storage）"]
        SyncFile["sync-data.json<br/>━━━━━━━━━━━━━━━<br/>• syncVersion<br/>• 状态快照<br/>• recentOps（200）<br/>• vectorClock"]
    end

    NgRx --> OpLogEffects
    OpLogEffects --> OpLogStore
    OpLogStore --> SyncService
    SyncService --> ConflictRes
    SyncService --> VectorClock

    SyncService --> FileAdapter
    SyncService --> SuperSync

    FileAdapter --> WebDAV
    FileAdapter --> Dropbox
    FileAdapter --> LocalFile

    WebDAV --> SyncFile
    Dropbox --> SyncFile
    LocalFile --> SyncFile

    style FileAdapter fill:#e1f5fe,stroke:#01579b,stroke-width:2px
    style SyncFile fill:#fff3e0,stroke:#e65100,stroke-width:2px
    style OpLogStore fill:#e8f5e9,stroke:#2e7d32,stroke-width:2px
```

## TypeScript 类型

```mermaid
classDiagram
    class FileBasedSyncData {
        +number version = 2
        +number syncVersion
        +number schemaVersion
        +VectorClock vectorClock
        +number lastModified
        +string clientId
        +AppDataComplete state
        +ArchiveModel archiveYoung
        +ArchiveModel archiveOld
        +CompactOperation[] recentOps
        +string checksum
    }

    class AppDataComplete {
        +TaskState task
        +ProjectState project
        +TagState tag
        +GlobalConfigState globalConfig
        +NoteState note
        +IssueProviderState issueProvider
        +PlannerState planner
        +SimpleCounterState simpleCounter
        +TaskRepeatCfgState taskRepeatCfg
    }

    class ArchiveModel {
        +TaskArchive task
        +TimeTrackingState timeTracking
        +number lastTimeTrackingFlush
    }

    class CompactOperation {
        +string id
        +string clientId
        +string actionType
        +OpType opType
        +EntityType entityType
        +string entityId
        +unknown payload
        +VectorClock vectorClock
        +number timestamp
    }

    class VectorClock {
        +Record~string, number~ clocks
    }

    FileBasedSyncData --> AppDataComplete : state
    FileBasedSyncData --> ArchiveModel : archiveYoung?
    FileBasedSyncData --> ArchiveModel : archiveOld?
    FileBasedSyncData --> CompactOperation : recentOps[0..200]
    FileBasedSyncData --> VectorClock : vectorClock
    CompactOperation --> VectorClock : vectorClock
```

## 同步流程（基于内容的乐观锁，附带捎带机制）

```mermaid
sequenceDiagram
    participant Client as 客户端应用
    participant Adapter as FileBasedSyncAdapter
    participant Provider as 文件提供商
    participant Remote as sync-data.json

    Note over Client,Remote: ⬇🕰 下载流程 ⬇🕰

    Client->>Adapter: downloadOps(sinceSeq, clientId)
    Adapter->>Provider: downloadFile("sync-data.json")
    Provider->>Remote: GET
    Remote-->>Provider: {data, rev}
    Provider-->>Adapter: SyncData (syncVersion=N)

    Adapter->>Adapter: 更新 _expectedSyncVersion = N
    Adapter->>Adapter: 按 sinceSeq 过滤操作
    Adapter-->>Client: OpDownloadResponse

    Client->>Client: 将远程操作应用到 NgRx
    Client->>Client: setLastServerSeq(latestSeq)

    Note over Client,Remote: ⬆🕰 上传流程（带捎带机制） ⬆🕰

    Client->>Adapter: uploadOps(ops, clientId, lastKnownSeq)
    Adapter->>Provider: downloadFile("sync-data.json")
    Provider->>Remote: GET
    Remote-->>Provider: {data, rev}
    Provider-->>Adapter: 当前 syncVersion=M

    alt syncVersion 匹配预期的（M=N）
        Note over Adapter: 没有其他客户端同步过
    else syncVersion 已变更（M>N）
        Note over Adapter: 有其他客户端同步了！<br/>将捎带它们的操作
    end

    Adapter->>Adapter: 将本地操作合并到 recentOps
    Adapter->>Adapter: 更新 vectorClock
    Adapter->>Adapter: 裁剪 recentOps 至 200 条
    Adapter->>Adapter: 设置 syncVersion = M+1
    Adapter->>Adapter: 查找捎带操作<br/>（来自其他客户端且尚未见过的操作）

    Adapter->>Provider: uploadFile("sync-data.json", newData)
    Provider->>Remote: PUT
    Remote-->>Provider: 成功

    Adapter-->>Client: 成功 + 捎带操作（newOps）

    alt 存在捎带操作
        Client->>Client: 处理捎带操作
        Client->>Client: setLastServerSeq(latestSeq)
    end
```

### 核心洞察：捎带机制（Piggybacking）

版本不匹配时不会抛出错误，而是由适配器：

1. 将本地操作与文件中的操作合并
2. 将其他客户端的操作作为 `newOps`（捎带操作）返回
3. 上传服务在更新 `lastServerSeq` 之前先处理这些操作

这确保了即使客户端并发同步，也不会遗漏任何操作。

## 冲突解决（两个客户端同时同步）

```mermaid
sequenceDiagram
    participant A as 客户端 A
    participant B as 客户端 B
    participant File as sync-data.json<br/>（syncVersion: 5）

    Note over A,File: 初始状态：syncVersion=5，两个客户端均已同步

    rect rgb(232, 245, 233)
        Note over A,B: 两个客户端均离线修改
        A->>A: 创建任务 X
        A->>A: expectedSyncVersion = 5
        B->>B: 更新任务 Y
        B->>B: expectedSyncVersion = 5
    end

    Note over A,File: 竞态条件开始

    A->>File: 开始上传（下载文件，看到 v=5）
    B->>File: 开始上传（下载文件，看到 v=5）

    A->>A: 合并操作 [TaskX]，设置 syncVersion=6
    A->>File: 上传 sync-data.json（v=6）
    Note over A,File: A 赢得了竞态 ✅
    File-->>A: 成功
    A->>A: expectedSyncVersion = 6

    B->>B: 合并操作 [TaskY]
    Note over B: 为上传重新下载文件...
    B->>File: 下载（看到 syncVersion=6!）
    Note over B,File: 版本已变更！<br/>预期 5，实际 6

    rect rgb(225, 245, 254)
        Note over B: 捎带机制（不是重试！）
        B->>B: 从文件中查找捎带操作<br/>（A 的 TaskX 操作，seq > lastProcessedSeq）
        B->>B: 合并 [TaskX, TaskY] 到 recentOps
        B->>B: 设置 syncVersion = 7
        B->>File: 上传 sync-data.json（v=7）
        File-->>B: 成功 ✅

        B->>B: 返回捎带=[TaskX]
        B->>B: 处理 TaskX 操作 → 应用到 NgRx
        B->>B: setLastServerSeq(latestSeq)
    end

    Note over A,File: A 在下次同步时获取 B 的 TaskY
    A->>File: 下载（sinceSeq=6）
    File-->>A: ops=[TaskY]
    A->>A: 应用 TaskY → 两个客户端都拥有两个任务
```

### 捎带机制如何解决冲突

| 步骤                             | 发生的行为                                                   |
| -------------------------------- | ----------------------------------------------------------- |
| 1. 检测到版本不匹配              | B 预期 v=5，实际找到 v=6                                      |
| 2. 无需重试                      | B 继续进行合并                                                |
| 3. 查找捎带操作                  | 文件中 seq > lastProcessedSeq 且来自其他客户端的操作            |
| 4. 合并并上传                    | B 的操作 + 文件中的操作 → 新文件                               |
| 5. 返回捎带操作                  | 上传响应中包含 A 的操作                                         |
| 6. 处理捎带操作                  | 上传服务在推进 lastServerSeq 之前应用这些操作                    |

**同一实体上的 LWW（最后写入者胜出）：**

如果 A 和 B 都修改了同一任务，捎带操作会通过 `ConflictResolutionService` 处理，该服务使用向量时钟和时间戳来决定胜者。

## 首次同步冲突处理

当本地已有数据的客户端首次同步到已存在远程数据的服务端时，会显示冲突对话框：

```mermaid
flowchart TD
    Start[首次同步尝试] --> Download[下载 sync-data.json]
    Download --> HasLocal{有本地数据吗？}
    HasLocal -->|否| Apply[应用远程状态]
    HasLocal -->|是| HasRemote{远程有数据吗？}
    HasRemote -->|否| Upload[上传本地状态]
    HasRemote -->|是| Dialog[显示冲突对话框]

    Dialog --> UseLocal[用户选择：使用本地]
    Dialog --> UseRemote[用户选择：使用远程]

    UseLocal --> CreateImport[创建 SYNC_IMPORT<br/>使用本地状态]
    CreateImport --> UploadImport[上传到远程]

    UseRemote --> ApplyRemote[应用远程状态<br/>丢弃本地]

    style Dialog fill:#fff3e0,stroke:#e65100,stroke-width:2px
```

## 主架构图

```mermaid
graph TB
    %% 样式
    classDef client fill:#fff,stroke:#333,stroke-width:2px,color:black;
    classDef provider fill:#e3f2fd,stroke:#1565c0,stroke-width:2px,color:black;
    classDef storage fill:#fff3e0,stroke:#e65100,stroke-width:2px,color:black;
    classDef conflict fill:#ffebee,stroke:#c62828,stroke-width:2px,color:black;
    classDef success fill:#e8f5e9,stroke:#2e7d32,stroke-width:2px,color:black;

    %% 客户端侧
    subgraph Client["客户端（Angular）"]
        direction TB

        subgraph SyncLoop["同步循环"]
            Scheduler((调度器)) -->|间隔| SyncService["OperationLogSyncService"]
            SyncService -->|1. 获取 lastSeq| LocalMeta["SUP_OPS IndexedDB"]
        end

        subgraph DownloadFlow["下载流程"]
            SyncService -->|"2. downloadOps(sinceSeq)"| Adapter
            Adapter -->|响应| VersionCheck{syncVersion<br/>已变更？}
            VersionCheck -- "是（重置）" --> GapDetect{检测到 Gap？}
            VersionCheck -- "无变更" --> FilterOps
            GapDetect -- "是 + 无操作" --> SnapshotCheck{存在快照<br/>状态？}
            GapDetect -- "是 + 有操作" --> FilterOps
            SnapshotCheck -- 是 --> LocalDataCheck{存在本地<br/>未同步操作？}
            SnapshotCheck -- 否 --> FilterOps
            LocalDataCheck -- 是 --> ConflictDialog["显示冲突对话框"]:::conflict
            LocalDataCheck -- 否 --> FreshCheck{新客户端？}
            FreshCheck -- 是 --> ConfirmDialog["确认对话框"]
            FreshCheck -- 否 --> HydrateSnapshot["从快照初始化"]:::success
            ConfirmDialog -- 已确认 --> HydrateSnapshot
            ConfirmDialog -- 已取消 --> SkipSync[跳过]
            ConflictDialog -- "使用本地" --> CreateSyncImport["创建 SYNC_IMPORT"]
            ConflictDialog -- "使用远程" --> HydrateSnapshot
            FilterOps["按 sinceSeq 过滤操作"]
        end

        subgraph ConflictMgmt["冲突管理（LWW 自动解决）"]
            FilterOps --> ConflictDet{{"比较<br/>向量时钟"}}:::conflict
            ConflictDet -- 顺序关系 --> ApplyRemote
            ConflictDet -- 并发关系 --> LWWCheck{{"LWW：比较<br/>时间戳"}}:::conflict

            LWWCheck -- "远程更新<br/>或平局" --> MarkRejected["标记本地为已拒绝"]:::conflict
            LWWCheck -- "本地更新" --> LocalWins["创建更新操作<br/>使用本地状态"]:::conflict
            LocalWins --> RejectBoth["标记两者为已拒绝"]
            RejectBoth --> CreateNewOp["新操作同步到远程"]
            MarkRejected --> ApplyRemote
        end

        subgraph Application["应用与验证"]
            ApplyRemote -->|分发| NgRx["NgRx 存储"]
            HydrateSnapshot -->|"初始化完整状态"| NgRx
            NgRx --> UpdateSeq["setLastServerSeq()"]
            UpdateSeq --> SyncDone((完成))
        end

        subgraph UploadFlow["上传流程"]
            LocalMeta -->|获取未同步| PendingOps["待处理操作"]
            PendingOps --> ClassifyOp{操作类型？}

            ClassifyOp -- "SYNC_IMPORT<br/>BACKUP_IMPORT" --> UploadSnapshot["作为快照上传<br/>（文件中包含完整状态）"]
            ClassifyOp -- "CRT/UPD/DEL" --> MergeOps["合并到 recentOps"]

            MergeOps --> BuildState["从 NgRx 构建状态快照"]
            BuildState --> IncrVersion["syncVersion++"]
            IncrVersion --> UploadFile["上传 sync-data.json"]
            UploadSnapshot --> UploadFile
            UploadFile --> CheckPiggyback{发现捎带<br/>操作？}
            CheckPiggyback -- 是 --> ProcessPiggyback["处理捎带操作<br/>（→ 冲突检测）"]
            ProcessPiggyback --> ConflictDet
            CheckPiggyback -- 否 --> MarkSynced["标记操作为已同步"]:::success
        end
    end

    %% 文件提供商层
    subgraph ProviderLayer["文件提供商层"]
        direction TB

        subgraph Adapter["FileBasedSyncAdapter"]
            DownloadOp["downloadOps()<br/>━━━━━━━━━━━━━━━<br/>• 下载文件<br/>• 按 sinceSeq 过滤<br/>• 检测版本变更<br/>• 如有 gap 则返回 snapshotState"]:::provider
            UploadOp["uploadOps()<br/>━━━━━━━━━━━━━━━<br/>• 下载当前文件<br/>• 合并操作 + 状态<br/>• 递增 syncVersion<br/>• 上传合并后的文件<br/>• 返回捎带操作"]:::provider
            SeqTracking["序列追踪<br/>━━━━━━━━━━━━━━━<br/>• _expectedSyncVersions<br/>• _localSeqCounters<br/>• _syncDataCache"]:::provider
        end

        subgraph Providers["文件提供商"]
            WebDAV["WebDAV<br/>━━━━━━━━━━━━<br/>downloadFile()<br/>uploadFile()"]:::provider
            Dropbox["Dropbox<br/>━━━━━━━━━━━━<br/>downloadFile()<br/>uploadFile()"]:::provider
            LocalFile["LocalFile<br/>━━━━━━━━━━━━<br/>downloadFile()<br/>uploadFile()"]:::provider
        end
    end

    %% 远程存储
    subgraph Remote["远程存储"]
        direction TB

        SyncFile[("sync-data.json<br/>━━━━━━━━━━━━━━━━━━━<br/>📵 version: 2<br/>📵 syncVersion: N<br/>📵 clientId<br/>━━━━━━━━━━━━━━━━━━━<br/>🕰 vectorClock<br/>━━━━━━━━━━━━━━━━━━━<br/>📝 state（完整快照）<br/>━━━━━━━━━━━━━━━━━━━<br/>🗄 archiveYoung<br/>🗄 archiveOld<br/>━━━━━━━━━━━━━━━━━━━<br/>📑 recentOps[0..200]")]:::storage
    end

    %% 连接
    Adapter --> WebDAV
    Adapter --> Dropbox
    Adapter --> LocalFile

    WebDAV --> SyncFile
    Dropbox --> SyncFile
    LocalFile --> SyncFile

    CreateSyncImport --> UploadSnapshot

    %% 子图样式
    style DownloadFlow fill:#e3f2fd,stroke:#1565c0,stroke-width:2px
    style ConflictMgmt fill:#ffebee,stroke:#c62828,stroke-width:2px
    style UploadFlow fill:#e8f5e9,stroke:#2e7d32,stroke-width:2px
    style Application fill:#f3e5f5,stroke:#7b1fa2,stroke-width:2px
    style ProviderLayer fill:#e3f2fd,stroke:#1565c0,stroke-width:2px
    style Remote fill:#fff3e0,stroke:#e65100,stroke-width:2px
```

## 快速参考表

### 文件操作

| 操作     | 方法                    | 目的               | 关键步骤                                                              |
| -------- | ----------------------- | ------------------ | --------------------------------------------------------------------- |
| 下载     | `downloadOps()`         | 获取远程变更        | 下载文件 → 按 sinceSeq 过滤 → 检测 gap → 返回操作或快照                 |
| 上传     | `uploadOps()`           | 推送本地变更        | 下载当前文件 → 合并操作 → 递增 syncVersion → 上传 → 返回捎带操作        |
| 获取序列 | `getLastServerSeq()`    | 获取已处理的序列     | 从 `_localSeqCounters` 映射中读取                                      |
| 设置序列 | `setLastServerSeq()`    | 更新已处理的序列     | 写入 `_localSeqCounters` + 持久化                                      |

### sync-data.json 结构

| 字段             | 类型                  | 目的                                    |
| ---------------- | --------------------- | --------------------------------------- |
| `version`        | `2`                   | 文件格式版本                             |
| `syncVersion`    | `number`              | 基于内容的锁计数器（每次上传递增）          |
| `schemaVersion`  | `number`              | 应用数据模式版本（用于迁移）               |
| `clientId`       | `string`              | 最后修改文件的客户端                       |
| `lastModified`   | `number`              | 最后修改时间戳                           |
| `vectorClock`    | `VectorClock`         | 所有操作的因果顺序                        |
| `state`          | `AppDataComplete`     | 完整的应用状态快照                        |
| `archiveYoung`   | `ArchiveModel?`       | 归档 < 21 天的任务                       |
| `archiveOld`     | `ArchiveModel?`       | 归档 > 21 天的任务                       |
| `recentOps`      | `CompactOperation[]`  | 最近 200 条操作（用于冲突检测）            |
| `checksum`       | `string?`             | 未压缩状态的 SHA-256 哈希                 |

### 关键实现细节

| 特性                 | 实现方式                                                                  |
| -------------------- | ------------------------------------------------------------------------- |
| **乐观锁**           | `syncVersion` 计数器——无需服务器 ETag                                      |
| **Gap 检测**         | syncVersion 重置或快照替换触发从 seq=0 重新下载                             |
| **捎带机制**         | 上传时，其他客户端的操作（seq > lastProcessed）作为 `newOps` 返回             |
| **首次同步冲突**     | 本地未同步操作 + 远程快照 → 显示冲突对话框                                   |
| **新客户端安全**     | 接受第一个远程数据前显示确认对话框                                            |
| **LWW 冲突**        | 并发向量时钟 → 比较时间戳 → 较晚者胜                                          |
| **快照引导**         | 检测到 gap + 存在快照 → 从完整状态初始化（跳过操作）                           |
| **缓存优化**         | 下载的同步数据被缓存，避免上传前重复下载                                      |
| **归档同步**         | 归档数据嵌入文件中；`ArchiveOperationHandler` 写入 IndexedDB                  |

## 关键要点

1. **单同步文件**：所有数据在 `sync-data.json` 中——状态快照 + 近期操作 + 向量时钟
2. **基于内容的版本控制**：`syncVersion` 计数器无需服务器 ETag 即可检测冲突
3. **上传捎带机制**：版本不匹配不抛出错误——其他客户端的操作作为 `newOps` 返回
4. **序列计数器分离**：
   - `_expectedSyncVersions`：跟踪文件的 syncVersion（用于版本不匹配检测）
   - `_localSeqCounters`：跟踪已处理的操作（通过 `setLastServerSeq` 更新）
5. **通过操作日志归档**：归档操作同步；`ArchiveOperationHandler` 写入数据
6. **确定性重放**：相同操作 + 相同时间戳 = 各处相同结果

## 实现文件

| 文件                                                                               | 用途                            |
| ---------------------------------------------------------------------------------- | ------------------------------- |
| `src/app/op-log/sync-providers/file-based/file-based-sync-adapter.service.ts`      | 主适配器（约 800 行）            |
| `src/app/op-log/sync-providers/file-based/file-based-sync.types.ts`                | TypeScript 类型和常量            |
| `src/app/op-log/sync-providers/file-based/file-based-sync-adapter.service.spec.ts` | 单元测试                         |
