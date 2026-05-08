# Super Productivity 同步架构详解

> 以 OneDrive 为切入点，深入讲解完整的同步机制，包括操作日志、向量时钟、冲突解决和文件同步适配器。
> 包含同步方案选型对比、多客户端并发场景分析和端到端冲突解决追踪。

## 目录

1. [架构总览](#1-架构总览)
2. [同步方案选型：为什么选择操作日志？](#2-同步方案选型为什么选择操作日志)
3. [核心概念：操作日志（Operation Log）](#3-核心概念操作日志operation-log)
4. [文件同步数据格式](#4-文件同步数据格式)
5. [同步流程详解](#5-同步流程详解)
6. [多客户端并发场景分析](#6-多客户端并发场景分析)
7. [冲突检测与解决](#7-冲突检测与解决)
8. [文件同步适配器（共享层）](#8-文件同步适配器共享层)
9. [Provider 层：OneDrive 的实现](#9-provider-层onedrive-的实现)
10. [关键设计决策](#10-关键设计决策)

---

## 1. 架构总览

```
                          ┌──────────────────────────────────────────────┐
                          │              SyncWrapperService              │
                          │         （顶层编排：防止并发、错误处理）          │
                          └───────────┬──────────────────────────────────┘
                                      │
                                      ▼
                          ┌──────────────────────────────────────────────┐
                          │         OperationLogSyncService              │
                          │    （同步协调：下载、上传、冲突对话框）          │
                          └───────────┬──────────────────────────────────┘
                                      │
                    ┌─────────────────┴─────────────────┐
                    │                                   │
                    ▼                                   ▼
      ┌──────────────────────┐          ┌─────────────────────────────┐
      │   SuperSync Provider │          │ FileBasedSyncAdapterService │
      │ （原生 OperationSync) │          │   （共享文件同步适配器）       │
      └──────────────────────┘          └───────────┬─────────────────┘
                                                    │
                              ┌──────────┬──────────┼──────────┬──────────┐
                              ▼          ▼          ▼          ▼          ▼
                           Dropbox    OneDrive    WebDAV   LocalFile  Nextcloud
                           (傻管道)    (傻管道)   (傻管道)   (傻管道)   (傻管道)
```

**关键分层原则：** 同步智能（冲突检测、向量时钟、操作回放）全部在共享层实现，存储 Provider 只负责读写一个字符串文件。

---

## 2. 同步方案选型：为什么选择操作日志？

在设计多设备同步时，有几种经典方案。理解每种方案的优缺点，才能明白为什么 Super Productivity 最终选择了操作日志 + 向量时钟的方案。

### 2.1 方案 A：全状态快照同步（State Snapshot）

最直观的方案——每次同步直接上传/下载完整的应用状态。

```
同步方式：直接比较本地和远端的完整状态文件

手机编辑任务 → 上传整个 state.json（包含所有任务、项目、标签...）
电脑编辑任务 → 发现远端 state.json 比本地新 → 下载并替换整个 state.json
```

**优点：**

- 实现极其简单——只需要上传/下载一个文件
- 不需要理解数据内部结构
- 新客户端引导只需一次下载

**致命缺点：**

- **只能做文件级冲突解决**：如果手机改了任务 A，电脑改了任务 B，同步时必须二选一——要么保留手机版本（丢失任务 B 的修改），要么保留电脑版本（丢失任务 A 的修改）。两个修改不可能同时保留。
- **无法追踪因果关系**：不知道谁先谁后，只能靠时间戳猜测
- **数据浪费严重**：改一个任务标题就要上传整个状态文件

> **Super Productivity 旧版（pfapi）就用的这种方案。** 当两个设备修改了不同任务时，用户必须手动选择保留哪个版本，另一个设备的修改会丢失。

### 2.2 方案 B：CRDT（Conflict-free Replicated Data Types）

学术上最优雅的方案——使用特殊的数据结构，使得所有冲突都可以自动合并，不需要中央协调。

```
同步方式：每个字段用特殊的 CRDT 类型（如 LWW-Register, OR-Set, RGA）

手机修改 task.title → 本地 CRDT 自动合并
电脑修改 task.title → 本地 CRDT 自动合并
同步时 → CRDT 数学保证自动合并，永无冲突
```

**优点：**

- **理论完美**：数学证明了永远不会冲突
- 离线优先，不需要网络就能工作
- 可以做到字段级别的自动合并

**缺点：**

- **数据模型复杂**：每个字段都需要特殊的 CRDT 类型，代码量巨大。一个 Task 有 20+ 个字段，每个都要定义 CRDT 语义
- **语义丢失**：CRDT 只知道"字段值变了"，不知道"用户做了什么操作"。比如用户拖拽排序任务，CRDT 只看到 taskIds 数组变了，不知道是移动还是重排
- **调试困难**：当合并结果不符合预期时，很难追踪原因
- **迁移风险大**：从现有状态模型迁移到 CRDT 几乎等于重写整个应用

> **例子：** 假设任务 A 在"待办"列表中，手机用户把它拖到"进行中"，电脑用户把它拖到"已完成"。CRDT 的 LWW-Register 只看时间戳，会选一个。但它不知道用户的语义意图——拖到"已完成"和拖到"进行中"是互斥的操作，不应该被简单覆盖。

### 2.3 方案 C：操作日志 + 向量时钟（Operation Log + Vector Clock）⭐

Super Productivity 最终选择的方案。不直接同步状态，而是同步"操作"——用户做了什么。

```
同步方式：记录每个用户操作（创建任务、修改标题、归档...），
         用向量时钟追踪因果关系，自动解决冲突

手机修改 task.title → 记录 Operation {type: Update, entity: Task:123, payload: {title: "新标题"}}
电脑修改 task.tags → 记录 Operation {type: Update, entity: Task:123, payload: {tags: ["工作"]}}
同步时 → 向量时钟发现两者是并发的（CONCURRENT），但修改了不同字段
       → 自动合并，两个修改都保留
```

**优点：**

- **实体级冲突检测**：两个设备修改不同任务 → 无冲突，都保留
- **因果关系追踪**：向量时钟知道哪些操作先于哪些，不会错乱
- **保留操作语义**：知道用户"归档了任务"vs"修改了标题"，可以做语义化的冲突解决（如归档总是赢）
- **渐进式迁移**：可以和旧的状态快照方案共存
- **数据效率**：只同步变化的操作，不需要每次上传完整状态

**代价：**

- 操作日志会增长 → 需要定期压缩（每 500 次操作创建快照）
- 向量时钟需要维护 → 每个客户端一个计数器，多个客户端后向量会变大（但限制为 20 个条目）
- 文件类 Provider（Dropbox、OneDrive）没有操作日志服务器 → 需要在 `sync-data.json` 中嵌入最近 500 条操作

### 2.4 三种方案对比总结

| 特性       | 全状态快照           | CRDT               | 操作日志 + 向量时钟 ⭐     |
| ---------- | -------------------- | ------------------ | -------------------------- |
| 冲突粒度   | 文件级（全有或全无） | 字段级（自动合并） | **实体级**（精确检测）     |
| 实现复杂度 | ★☆☆ 低               | ★★★ 高             | ★★☆ 中                     |
| 语义理解   | 无（不知道操作含义） | 无（只知道字段值） | **有**（知道用户做了什么） |
| 因果追踪   | 无                   | 有（内置）         | **有**（向量时钟）         |
| 数据效率   | 低（每次上传全量）   | 中                 | **高**（只同步操作）       |
| 离线支持   | 差                   | 优秀               | **好**                     |
| 迁移难度   | —                    | ★★★ 重写           | ★★☆ 可渐进                 |

### 2.5 为什么不用纯 CRDT？

操作日志方案和 CRDT 有重叠的目标（自动合并），但有关键区别：

1. **操作日志保留用户意图**：知道用户"归档了任务"而不是"把 completed 字段设为 true"。这让"归档总是赢"这种语义规则成为可能。

2. **向量时钟更简单**：相比 CRDT 的复杂类型系统，`{ clientId: counter }` 的向量时钟更容易理解、调试和维护。

3. **可以降级到快照**：操作日志可以随时压缩成快照（每 500 次操作），而 CRDT 的 tombstone（墓碑）数据需要特殊处理。

4. ** pragmatic 选择**：CRDT 需要从零设计整个数据模型，而操作日志可以包装现有的 NgRx actions（框架已有的状态变更事件），迁移成本最低。

---

## 3. 核心概念：操作日志（Operation Log）

### 3.1 什么是操作日志？

用户每一个操作（创建任务、修改标签、归档等）都被记录为一个不可变的 `Operation` 对象，存储在本地 IndexedDB（`SUP_OPS`）中。

```typescript
interface Operation {
  id: string; // UUIDv7，时间有序
  actionType: string; // 例如 '[TASK] Add Task'
  opType: OpType; // Create | Update | Delete | SyncImport | BackupImport | Repair
  entityType: string; // TASK | PROJECT | TAG | NOTE | ...
  entityId?: string; // 操作的实体 ID
  entityIds?: string[]; // 批量操作时的多个实体 ID
  payload: unknown; // 操作数据
  clientId: string; // 产生此操作的客户端 ID
  vectorClock: VectorClock; // 向量时钟（追踪因果顺序）
  timestamp: number; // 操作时间戳
  schemaVersion: number; // 数据格式版本
}
```

### 3.2 写入路径

```
用户操作 → NgRx dispatch → meta-reducer 原子更新所有相关实体
                          → OperationLogEffects 捕获 action 转为 Operation
                          → 写入 IndexedDB (SUP_OPS)
                          → 标记为 unsynced
```

### 3.3 读取路径（启动时）

```
启动 → 从 state_cache 加载最近的状态快照
     → 回放快照之后的 "tail" 操作
     → 定期压缩（每 500 ops 创建新快照，清理已同步的旧操作）
```

---

## 4. 文件同步数据格式

所有文件类 Provider 都存储同一个 `sync-data.json` 文件，格式为 `FileBasedSyncData`：

```typescript
interface FileBasedSyncData {
  version: 2; // 文件格式版本
  syncVersion: number; // 乐观锁计数器（每次上传 +1）
  schemaVersion: number; // 应用数据 schema 版本
  vectorClock: VectorClock; // 因果状态向量时钟
  lastModified: number; // 最后修改时间 (epoch ms)
  clientId: string; // 最后修改的客户端 ID
  state: unknown; // 完整应用状态快照（tasks, projects, tags, config...）
  archiveYoung?: ArchiveModel; // 21 天内的归档数据
  archiveOld?: ArchiveModel; // 21 天前的归档数据
  recentOps: SyncFileCompactOp[]; // 最近 500 条操作（用于冲突检测）
  oldestOpSyncVersion?: number; // recentOps 中最老操作的 syncVersion
}
```

**为什么既有完整状态快照又有操作日志？**

- `state`：用于新客户端引导（直接加载完整状态，不需要回放全部历史）
- `recentOps`：用于冲突检测（知道哪些实体被修改了，可以做到实体级 LWW）
- 只靠 `state` 做不到实体级冲突解决（只能做文件级"谁赢"）

---

## 5. 同步流程详解

### 5.1 完整同步周期

`SyncWrapperService._sync()` 编排了整个同步周期：

```
┌─────────────────────────────────────────────────────────────────────┐
│  SyncWrapperService._sync()                                        │
│                                                                     │
│  1. 获取 OperationSyncCapable provider                              │
│     - SuperSync → 直接用                                            │
│     - 文件类 → FileBasedSyncAdapterService 包装                     │
│                                                                     │
│  2. 检测 Provider 切换 → 强制从 seq 0 重新下载                      │
│                                                                     │
│  3. 下载远端操作 downloadRemoteOps()                                │
│     → OperationLogSyncService                                       │
│                                                                     │
│  4. 上传本地待同步操作 uploadPendingOps()                            │
│     → OperationLogSyncService                                       │
│                                                                     │
│  5. LWW 重传循环（如果有本地赢的操作需要重新上传）                    │
│     - 最多重试 MAX_LWW_REUPLOAD_RETRIES 次                          │
│                                                                     │
│  6. 标记 IN_SYNC，如果是 SuperSync 则连接 WebSocket                 │
└─────────────────────────────────────────────────────────────────────┘
```

### 5.2 下载流程（downloadRemoteOps）

```
OperationLogSyncService.downloadRemoteOps()
    │
    ├─ OperationLogDownloadService.downloadRemoteOps()
    │   └─ provider.downloadOps(sinceSeq, excludeClient)
    │       │
    │       │  [文件类] FileBasedSyncAdapterService._downloadOps()
    │       │   1. 下载 sync-data.json
    │       │   2. 解密+解压
    │       │   3. 过滤已应用的操作
    │       │   4. 检测 gap（版本重置、快照替换、部分裁剪）
    │       │   5. 返回 ops + snapshotState + vectorClock
    │       │
    │       │  [SuperSync] 直接从 API 获取 ops
    │
    ├─ 检测 server migration（空服务器上有历史客户端）
    ├─ 处理 snapshotState（新客户端引导）
    │   └─ SyncHydrationService.hydrateFromRemoteSync()
    ├─ 检测 SYNC_IMPORT 冲突 → 弹对话框
    └─ processRemoteOps()
        └─ RemoteOpsProcessingService.processRemoteOps()
```

### 5.3 RemoteOpsProcessingService 处理管线

这是远程操作处理的核心管线：

```
RemoteOpsProcessingService.processRemoteOps(remoteOps)
    │
    ├─ Step 1: Schema 迁移
    │   - 版本太旧（< MIN_SUPPORTED）→ 错误，停止
    │   - 版本太新（> current + MAX_SKIP）→ 错误，停止
    │   - 正常范围 → 迁移到当前版本
    │
    ├─ Step 2: SYNC_IMPORT 过滤
    │   - SyncImportFilterService.filterOpsInvalidatedBySyncImport()
    │   - 丢弃被全量导入覆盖的旧操作
    │
    ├─ Step 3: 全量操作检查
    │   - SYNC_IMPORT / BACKUP_IMPORT → 跳过冲突检测，直接应用
    │
    ├─ Step 4: 冲突检测
    │   - VectorClockService 获取本地实体前沿
    │   - 对比远程操作与本地待同步操作的向量时钟
    │
    ├─ Step 5: 冲突解决
    │   - 有冲突 → ConflictResolutionService.autoResolveConflictsLWW()
    │   - 无冲突 → applyNonConflictingOps() 直接应用
    │
    └─ Step 6: Checkpoint D 状态验证
        - ValidateStateService.validateAndRepairCurrentState()
        - 修复引用完整性（如任务引用已删除的项目）
```

### 5.4 上传流程（uploadPendingOps）

```
OperationLogSyncService.uploadPendingOps()
    │
    ├─ writeFlushService.flushPendingWrites()  // 确保所有写入完成
    ├─ isWhollyFreshClient() → 阻止空客户端上传
    ├─ serverMigrationService.checkAndHandleMigration()
    ├─ uploadService.uploadPendingOps(provider)
    │   └─ provider.uploadOps(ops, clientId)
    │       │
    │       │  [文件类] FileBasedSyncAdapterService._uploadOps()
    │       │   1. 获取当前 sync-data.json
    │       │   2. 合并新操作到 recentOps
    │       │   3. 更新向量时钟
    │       │   4. 读取 NgRx 当前状态作为新快照
    │       │   5. 加密+压缩
    │       │   6. 上传（带乐观锁重试）
    │       │
    │       │  [SuperSync] 直接调用 API 上传 ops
    │
    ├─ 处理 piggybacked ops（上传时服务端返回的其他客户端操作）
    │   └─ processRemoteOps(piggybackedOps)
    │
    └─ 处理被拒绝的 ops（服务端拒绝的操作）
        └─ RejectedOpsHandlerService.handleRejectedOps()
```

---

## 6. 多客户端并发场景分析

这一节通过具体的场景来展示多个客户端同时使用时会发生什么。每个场景都追踪了向量时钟的变化，让你看到系统如何保证数据一致性。

### 6.1 场景一：无冲突——修改不同任务（最常见）

这是最常见的场景，占了 99% 的同步操作。

```
时间线：

t0  手机（client-A）和电脑（client-B）已同步，状态相同
    向量时钟：{ "client-A": 2, "client-B": 1 }

t1  手机离线，修改了任务 T1 的标题
    → 本地操作：{ opType: Update, entityId: "T1", vectorClock: { "client-A": 3, "client-B": 1 } }
    → 写入 IndexedDB，标记为 unsynced

t2  电脑离线，修改了任务 T2 的标签
    → 本地操作：{ opType: Update, entityId: "T2", vectorClock: { "client-A": 2, "client-B": 2 } }
    → 写入 IndexedDB，标记为 unsynced

t3  手机先上线同步
    1. 下载：远端没有新操作（电脑还没上线）
    2. 上传：把 T1 的 Update 上传
    3. 远端 sync-data.json 更新：recentOps 包含 T1 的 Update

t4  电脑上线同步
    1. 下载：收到 T1 的 Update
       → 对比向量时钟：本地 T2 的 frontier = { "client-A": 2, "client-B": 2 }
       → 远程 T1 的 clock = { "client-A": 3, "client-B": 1 }
       → compareVectorClocks() → CONCURRENT（A 分支 3>2，B 分支 1<2）
       → 但！T1 和 T2 是不同实体 → 不冲突！
       → 直接应用 T1 的 Update
    2. 上传：把 T2 的 Update 上传
    3. 远端 sync-data.json 更新：recentOps 包含 T1 和 T2 的 Update

结果：✅ 两个修改都保留了，没有任何数据丢失。
```

**关键点：** 操作日志允许"实体级"冲突检测——只有修改了**同一个实体**的并发操作才被认为是冲突。修改不同任务完全无感。

### 6.2 场景二：真冲突——修改同一个任务

两个设备同时修改了同一个任务的不同字段。

```
时间线：

t0  手机和电脑已同步
    向量时钟：{ "client-A": 5, "client-B": 4 }
    任务 T1：{ title: "买牛奶", tags: ["购物"], notes: "" }

t1  手机离线，修改 T1 标题为 "买有机牛奶"
    → 操作：{ entityId: "T1", payload: { title: "买有机牛奶" }, clock: { "client-A": 6, "client-B": 4 }, timestamp: 1000 }

t2  电脑离线，修改 T1 标签为 ["购物", "紧急"]
    → 操作：{ entityId: "T1", payload: { tags: ["购物", "紧急"] }, clock: { "client-A": 5, "client-B": 5 }, timestamp: 1005 }

t3  手机上线同步，上传 T1 的修改

t4  电脑上线同步
    1. 下载：收到手机的 T1 Update
       → 对比：本地 T1 frontier = { "client-A": 5, "client-B": 5 }
       → 远程 T1 clock = { "client-A": 6, "client-B": 4 }
       → compareVectorClocks() → CONCURRENT（真正的冲突！）

    2. LWW 自动解决：
       → 本地时间戳 = 1005（电脑修改标签的时间）
       → 远程时间戳 = 1000（手机修改标题的时间）
       → 1005 > 1000 → 本地赢！

    3. 本地赢后的处理：
       a. 拒绝本地和远程的冲突操作（它们都过时了）
       b. 创建新 UPDATE 操作：
          - 从 NgRx store 读取当前 T1 状态（包含电脑的标签修改）
          - 向量时钟 = merge({A:5,B:5}, {A:6,B:4}) + increment = { "client-A": 7, "client-B": 6 }
          - 时间戳 = 1005（保留本地赢的语义）
       c. 新操作标记为 unsynced

    5. LWW 重传循环：SyncWrapperService 检测到 localWinOpsCreated > 0
       → 再次调用 uploadPendingOps() 上传新创建的操作

结果：✅ 电脑的标签修改被保留（因为时间戳更新），手机下次同步时会收到这个合并后的状态。
      但注意：手机的标题修改在本轮同步中被覆盖了！
```

**LWW 的现实：** 在真正的并发冲突中，总有一方会"输"。LWW 选择时间戳更新的那一方，这是最合理的默认策略，但不是完美的。如果你想保留两边的修改，需要在 UI 层面做字段级合并，这太复杂了。

### 6.3 场景三：归档 vs 修改——归档总是赢

这是唯一有特殊语义规则的场景。

```
时间线：

t0  任务 T1 在手机上被归档（moveToArchive）
    → 操作：{ actionType: "TASK_SHARED_MOVE_TO_ARCHIVE", entityId: "T1", clock: { "client-A": 4 } }

t1  同时，电脑上修改了 T1 的标题
    → 操作：{ opType: Update, entityId: "T1", payload: { title: "新标题" }, clock: { "client-B": 3 } }

t2  同步时检测到 CONCURRENT

    → 特殊规则：归档操作总是赢！
    → 无论时间戳谁大谁小，归档优先级最高
    → 本地（归档）赢，创建新的归档操作
    → 远程的标题修改被拒绝

结果：✅ 用户的归档意图被尊重。如果允许标题修改赢，
      它会通过 lwwUpdateMetaReducer 重新创建已归档的实体，
      违背用户"我处理完这个任务了"的明确意图。
```

### 6.4 场景四：三个客户端同时操作（三角同步）

更复杂的场景——三个设备同时修改。

```
设备：手机 A、平板 B、电脑 C
初始状态：三端已同步，时钟 { "A": 3, "B": 2, "C": 1 }

A 修改任务 T1（clock: {A:4, B:2, C:1}）
B 修改任务 T2（clock: {A:3, B:3, C:1}）
C 修改任务 T3（clock: {A:3, B:2, C:2}）

假设使用文件同步（OneDrive），只有一个 sync-data.json 文件：

t1  A 先同步
    → 下载：远端无变化
    → 上传：sync-data.json = {
        recentOps: [T1修改],
        vectorClock: {A:4, B:2, C:1},
        syncVersion: 1
      }

t2  B 同步
    → 下载：发现 A 的 T1 修改
    → 对比：B 没有 T1 的本地操作 → 无冲突，直接应用
    → 上传：需要先下载最新 sync-data.json
    → sync-data.json = {
        recentOps: [T1修改, T2修改],
        vectorClock: merge({A:4,B:2,C:1}, {A:3,B:3,C:1}) = {A:4, B:3, C:1},
        syncVersion: 2
      }

t3  C 同步
    → 下载：发现 A 的 T1 修改和 B 的 T2 修改
    → 对比：C 没有 T1/T2 的本地操作 → 全部无冲突，直接应用
    → 上传：
    → sync-data.json = {
        recentOps: [T1修改, T2修改, T3修改],
        vectorClock: merge({A:4,B:3,C:1}, {A:3,B:2,C:2}) = {A:4, B:3, C:2},
        syncVersion: 3
      }

结果：✅ 三个修改全部保留！向量时钟从 {A:3,B:2,C:1} 演进到 {A:4,B:3,C:2}，
      完美追踪了所有因果关系。
```

### 6.5 场景五：乐观锁竞争——两个客户端同时上传

文件类 Provider（OneDrive/Dropbox）只有一个文件，两个客户端可能同时上传。

```
A 和 B 都在 t0 下载了 sync-data.json（syncVersion=5）

t1  A 离线修改 T1，准备上传
    → 构建 newSyncData（syncVersion=6）
    → PUT sync-data.json If-Match: "etag-t0"

t2  B 也离线修改 T2，准备上传
    → 构建 newSyncData（syncVersion=6）
    → PUT sync-data.json If-Match: "etag-t0"

t3  A 的上传先到服务器 → 成功！文件 syncVersion 变为 6，ETag 变为 "etag-t3"

t4  B 的上传后到服务器 → 失败！
    → 服务器返回 412 Precondition Failed（ETag 不匹配）
    → B 收到 UploadRevToMatchMismatchAPIError

t5  B 的重试逻辑：
    → 等待指数退避延迟（base * 2^attempt + random jitter）
    → 重新下载最新 sync-data.json（得到 A 的 T1 修改，syncVersion=6）
    → 合并自己的 T2 修改到最新数据
    → 构建 newSyncData（syncVersion=7）
    → PUT sync-data.json If-Match: "etag-t3" → 成功！

结果：✅ A 和 B 的修改都保留了。乐观锁 + 自动重试解决了并发上传问题。
```

### 6.6 场景六：新设备加入——空客户端安全保护

一台全新的设备第一次连接同步。

```
t0  新设备 D 安装了 Super Productivity，配置了 OneDrive 同步
    → 本地没有任何操作历史（isWhollyFreshClient = true）

t1  第一次同步：
    → 下载：sync-data.json 包含完整状态快照
    → isFreshClient=true + 本地无数据 → 显示确认对话框：
      "远端有数据，是否下载到本地？"
    → 用户确认 → 下载远端状态，引导本地

t2  安全保护：
    → 新客户端不能上传（防止空数据覆盖远端）
    → 只有在下载并应用远端数据后，才解除上传限制

如果本地已有数据（之前忘记开同步）：
    → 抛出 LocalDataConflictError
    → 显示冲突对话框："本地有数据，远端也有数据，选择哪个？"
    → USE_LOCAL：上传本地数据，覆盖远端
    → USE_REMOTE：下载远端数据，丢弃本地
```

---

## 7. 冲突检测与解决

### 7.1 向量时钟（Vector Clock）

每个客户端维护一个向量时钟，格式为 `{ [clientId]: counter }`：

```typescript
type VectorClock = Record<string, number>;

// 例如：
// 客户端 A 做了 3 个操作后：{ "client-A": 3 }
// 从客户端 B 同步了 2 个操作后：{ "client-A": 3, "client-B": 2 }
```

**比较规则：**

| 比较结果       | 含义       | 处理                   |
| -------------- | ---------- | ---------------------- |
| `GREATER_THAN` | 本地更新   | 跳过远程操作（已过时） |
| `LESS_THAN`    | 远程更新   | 应用远程操作           |
| `EQUAL`        | 相同操作   | 跳过（重复）           |
| `CONCURRENT`   | 真正的冲突 | 需要解决               |

### 7.2 冲突检测过程

`ConflictResolutionService` 对每个远程操作执行以下检查：

```
对每个远程操作:
    │
    ├─ 获取操作影响的实体 ID(s)
    ├─ 查找本地对该实体的 pending 操作
    ├─ 构建本地实体前沿向量时钟
    │   = 已应用操作时钟 ∪ 待同步操作时钟
    ├─ compareVectorClocks(本地前沿, 远程时钟)
    │
    ├─ GREATER_THAN → 跳过（本地更新）
    ├─ EQUAL → 跳过（重复）
    ├─ LESS_THAN → 非冲突，直接应用
    └─ CONCURRENT → 真正冲突！进入 LWW 解决
```

### 7.3 LWW（Last-Write-Wins）自动解决

**不需要用户干预**，全部自动完成：

```
ConflictResolutionService.autoResolveConflictsLWW(conflicts, nonConflictingOps)
    │
    ├─ 对每个冲突:
    │   ├─ 特殊情况：归档操作总是赢（用户明确意图）
    │   │   - 远程归档 → 远程赢
    │   │   - 本地归档 → 本地赢（创建新归档操作）
    │   │
    │   ├─ 相同冲突检测：
    │   │   - 双方都 DELETE → 自动解决
    │   │   - payload 完全相同 → 自动解决
    │   │
    │   └─ 正常 LWW 时间戳比较：
    │       - 本地更新 → 本地赢
    │           - 创建新 UPDATE 操作（携带当前实体状态）
    │           - 合并双方向量时钟 + 递增
    │           - 保留原始时间戳（公平性）
    │           - 新操作将在下次同步时上传
    │       - 远程更新或平局 → 远程赢
    │           - 平局时远程优先（服务端权威性）
    │
    ├─ 批量应用所有操作（解决后的 + 非冲突的）
    │   └─ 确保依赖排序正确（如 Task 依赖 Project）
    │
    ├─ 拒绝被取代的本地操作
    │   └─ 包括同一实体的所有 pending 操作
    │
    ├─ 合并远程操作的向量时钟到本地
    │   └─ 确保后续本地操作"支配"已应用的远程操作
    │
    └─ Checkpoint D：状态验证和修复
```

### 7.4 本地赢时发生了什么？

当 LWW 判定本地胜出时：

1. **拒绝**本地和远程的冲突操作（它们现在都过时了）
2. **创建新 UPDATE 操作**：
   - 从 NgRx store 读取当前实体状态
   - 向量时钟 = merge(所有冲突操作时钟) + increment
   - 时间戳 = 本地操作的最大时间戳（保留"赢"的语义）
3. 新操作标记为 unsynced → 下次同步时上传
4. 下次同步的 LWW 重传循环会专门上传这些操作

---

## 8. 文件同步适配器（共享层）

### 8.1 FileBasedSyncAdapterService 的角色

这是一个通用适配器，把任何实现了 `FileSyncProvider` 接口的 Provider 包装成 `OperationSyncCapable`：

```
                            OperationSyncCapable 接口
                            （上传/下载操作、快照管理）
                                    │
                                    ▼
                    ┌───────────────────────────────────┐
                    │   FileBasedSyncAdapterService     │
                    │                                   │
                    │   - 操作编码/解码                   │
                    │   - 向量时钟合并                    │
                    │   - recentOps 管理（裁剪到 500）     │
                    │   - 乐观锁（syncVersion 计数器）    │
                    │   - 上传重试（版本冲突时）            │
                    │   - Gap 检测（版本重置/快照替换）     │
                    │   - 加密/压缩/解密/解压              │
                    │   - 归档数据同步                     │
                    └───────────────────────────────────┘
                                    │
                                    ▼
                        FileSyncProvider 接口
                        （只有 5 个方法）
```

### 8.2 乐观锁机制

文件类 Provider 没有 SuperSync 那样的服务端序列号，所以使用文件内的 `syncVersion` 计数器：

```
上传流程:
    1. 下载当前 sync-data.json → 得到 syncVersion=N, rev=ETag
    2. 检查 syncVersion === expectedSyncVersion
    3. 如果匹配：
       - 合并新操作，syncVersion = N+1
       - 上传，附带 If-Match: ETag
    4. 如果不匹配（其他人改了文件）：
       - 重新下载最新文件
       - 合并操作到最新数据
       - 递增 syncVersion
       - 上传（最多重试 2 次，指数退避）
```

### 8.3 Gap 检测

三种情况需要 gap 检测（触发重新从 seq 0 下载）：

1. **版本重置**：`syncVersion` 比预期的小（另一客户端上传了快照）
2. **快照替换**：`recentOps` 为空但 `state` 存在（"使用本地"冲突解决后）
3. **部分裁剪**：`oldestOpSyncVersion > sinceSeq` 且 `recentOps` 达到上限（慢同步客户端遗漏了被裁剪的操作）

---

## 9. Provider 层：OneDrive 的实现

### 9.1 OneDrive 实现的接口

OneDrive 只实现 `FileSyncProvider` 接口的 5 个方法：

```typescript
interface FileSyncProvider {
  getFileRev(path): Promise<{ rev }>; // 获取文件 ETag
  downloadFile(path): Promise<{ rev; dataStr }>; // 下载文件内容
  uploadFile(path, data, rev, force): Promise<{ rev }>; // 上传文件
  removeFile(path): Promise<void>; // 删除文件
  listFiles?(dirPath): Promise<string[]>; // 列出目录
}
```

**OneDrive 不知道的事情：**

- 操作（Operation）是什么
- 向量时钟
- 冲突检测/解决
- 状态快照
- 操作日志
- 归档数据
- 加密（由适配器层处理）

### 9.2 OneDrive 具体做了什么

`onedrive.ts`（约 670 行）全部是 Microsoft Graph API 相关：

```
OneDrive 类的职责:
    │
    ├─ OAuth 2.0 PKCE 认证
    │   ├─ 生成 code_verifier + code_challenge
    │   ├─ CSRF 保护（state 参数）
    │   ├─ 授权码交换
    │   └─ Token 刷新（带并发控制）
    │
    ├─ Microsoft Graph API 调用
    │   ├─ /me/drive/special/approot:/.../content (GET/PUT/DELETE)
    │   ├─ /me/drive/special/approot:/.../children (GET/POST)
    │   └─ ETag 处理（If-Match 头）
    │
    ├─ 同步文件夹管理
    │   └─ 递归创建路径（逐级 mkdir -p）
    │
    └─ HTTP 错误映射
        ├─ 401/403 → AuthFailSPError
        ├─ 404 → RemoteFileNotFoundAPIError
        ├─ 409/412 → UploadRevToMatchMismatchAPIError
        └─ 429 → TooManyRequestsAPIError
```

### 9.3 为什么 OneDrive 是"傻管道"

**OneDrive 的 `uploadFile` 实际上只做了一件事：**

```typescript
async uploadFile(targetPath, dataStr, revToMatch, isForceOverwrite) {
  const cfg = await this._cfgOrError();
  await this._ensureSyncFolderExistsCached(cfg);

  const headers = new Headers();
  headers.set('Content-Type', 'text/plain');
  if (!isForceOverwrite && revToMatch) {
    headers.set('If-Match', revToMatch);  // 乐观锁
  }

  const response = await this._request({
    method: 'PUT',
    path: `${this._getDriveItemPath(targetPath, cfg)}/content`,
    headers,
    body: dataStr,  // ← 完全不透明的字符串，OneDrive 不知道里面是什么
  });

  return { rev: result.eTag || '' };
}
```

`dataStr` 是加密+压缩后的 JSON 字符串，OneDrive 只是把它存到用户的 App Folder 里。

---

## 10. 关键设计决策

### 10.1 为什么不直接同步状态？

直接同步整个状态快照（旧版 pfapi 的方式）只能做文件级冲突解决：要么保留本地、要么保留远端。

操作日志方式允许：

- **实体级冲突检测**：两个客户端修改不同任务 → 两个都保留
- **字段级 LWW**：同一任务的不同字段修改 → 自动合并
- **因果关系追踪**：向量时钟知道哪些操作先于哪些

### 10.2 为什么文件类 Provider 也用操作日志？

SuperSync 有专门的同步服务器，可以存储和查询操作。文件类 Provider（Dropbox、OneDrive、WebDAV、LocalFile）没有这样的服务器，但通过 `sync-data.json` 文件中包含 `recentOps` 数组，实现了等价的操作同步能力。

代价是：

- 只保留最近 500 条操作（`MAX_RECENT_OPS`）
- 需要乐观锁替代服务端原子性
- 上传前必须先下载（读取当前 syncVersion）

### 10.3 归档操作为什么总是赢？

```
归档（moveToArchive）vs 并发修改（Update）→ 归档总是赢
```

归档是用户明确表示"我处理完这些任务了"。如果允许 Update 通过 LWW 赢，它会通过 `lwwUpdateMetaReducer.addOne()` 重新创建已归档的实体，违背用户意图。

### 10.4 为什么本地赢时要创建新操作？

当 LWW 判定本地胜出时，不能简单跳过远程操作 — 远程已经接受了那些操作，其他客户端可能已经基于它们做了更多修改。

解决方案：

1. 拒绝本地和远程的冲突操作
2. 创建新 UPDATE 操作，携带当前本地实体状态 + 合并后的向量时钟
3. 新操作在下次同步时上传，让所有客户端看到本地状态

### 10.5 新客户端的安全保护

```
新客户端判断：!snapshot && lastSeq === 0

安全措施：
1. 新客户端不能上传（防止空数据覆盖远端）
2. 下载远端数据前需要用户确认
3. 如果本地有有意义的数据（tasks/projects/tags/notes），抛出冲突错误
4. 空服务器 + 有本地数据 → 自动创建 SYNC_IMPORT 上传
```

---

## 附录：文件类 Provider 对比

| 特性     | Dropbox    | OneDrive   | WebDAV     | LocalFile   | Nextcloud  |
| -------- | ---------- | ---------- | ---------- | ----------- | ---------- |
| 认证方式 | OAuth      | OAuth PKCE | 用户名密码 | 无          | 用户名密码 |
| 存储位置 | App folder | App folder | 自定义路径 | 本地文件    | 自定义路径 |
| 乐观锁   | rev (ETag) | ETag       | ETag       | syncVersion | ETag       |
| 冲突解决 | 共享层 LWW | 共享层 LWW | 共享层 LWW | 共享层 LWW  | 共享层 LWW |
| 操作同步 | 共享适配器 | 共享适配器 | 共享适配器 | 共享适配器  | 共享适配器 |

**所有文件类 Provider 的同步逻辑完全相同，区别只在认证和文件传输。**
