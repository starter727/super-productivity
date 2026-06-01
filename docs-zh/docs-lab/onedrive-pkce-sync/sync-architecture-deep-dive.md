# 同步架构深度解析

# Super Productivity 同步架构详解

> 以 OneDrive 为切入点，深入讲解完整的同步机制，包括操作日志、向量时钟、冲突解决和文件同步适配器。
> 包含同步方案选型对比、多客户端并发场景分析和端到端冲突解决追踪。

## 目录

1. [架构总览](#1-架构总览)
2. [同步方案选型：为什么选择操作日志？](#2-同步方案选型为什么选择操作日志)
3. [核心概念：操作日志（Operation Log）](#3-核心概念操作日志operation-log)
4. [文件同步数据格式](#4-文件同步数据格式)
5. [同步流程详解（从触发到完成，逐行讲解）](#5-同步流程详解从触发到完成逐行讲解)
   - [5.0 先看全景：一次同步的六个阶段](#50-先看全景一次同步的六个阶段)
   - [5.1 顶层编排：SyncWrapperService.\_sync()](#51-顶层编排syncwrapperservice_sync)
   - [5.2 阶段 1 详解：下载远端操作 — downloadRemoteOps()](#52-阶段-1-详解下载远端操作--downloadremoteops)
   - [5.3 阶段 2 + 3：冲突检测与解决管线 — processRemoteOps()](#53-阶段-2--3冲突检测与解决管线--processremoteops)
   - [5.4 细节放大：向量时钟到底怎么比？](#54-细节放大向量时钟到底怎么比)
   - [5.5 阶段 3 详解：LWW 自动解决 — autoResolveConflictsLWW()](#55-阶段-3-详解lww-自动解决--autoresolveconflictslww)
   - [5.6 阶段 5 详解：上传本地操作 — uploadPendingOps()](#56-阶段-5-详解上传本地操作--uploadpendingops)
   - [5.7 完整端到端追踪：手机 vs 电脑修改同一个任务](#57-完整端到端追踪手机-vs-电脑修改同一个任务)
   - [5.8 故障处理：什么会失败，数据会不会丢？](#58-故障处理什么会失败数据会不会丢)
   - [5.9 关键数据结构流转图](#59-关键数据结构流转图)
6. [多客户端并发场景分析](#6-多客户端并发场景分析)
7. [冲突检测与解决](#7-冲突检测与解决)
8. [文件同步适配器（共享层）](#8-文件同步适配器共享层)
9. [Provider 层：OneDrive 的实现](#9-provider-层onedrive-的实现)
10. [关键设计决策](#10-关键设计决策)
11. [OneDrive PR Review 验证的并发模式](#11-onedrive-pr-review-验证的并发模式)

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

## 5. 同步流程详解（从触发到完成，逐行讲解）

> **阅读指引：** 这一章是整个文档的核心。我们从头到尾追踪一次完整的同步——不是用抽象描述，而是用伪代码 + 数值例子一步一步走。如果你只想看一个地方来理解同步，就看这一章。
>
> **记号说明：**
>
> - ⏱️ = 此处读写 **操作日志**（IndexedDB `SUP_OPS`）
> - 🕐 = 此处比较、合并或递增 **向量时钟**
> - 🔒 = 此处校验 **乐观锁**（syncVersion 或 ETag）

### 5.0 先看全景：一次同步的六个阶段

在深入细节之前，先用大白话讲一遍：一次同步到底做了什么？

```
╔══════════════════════════════════════════════════════════════════════╗
║                    一次完整同步的六个阶段                              ║
╠══════╦═══════════════════════════════════════════════════════════════╣
║ 触发  ║ 鼠标动了一下、电脑从休眠唤醒、定时器到时间……任何一个事件       ║
║      ║ 都能触发同步。所有触发源被 merge 到一起，debounce 100ms 防抖。  ║
╠══════╬═══════════════════════════════════════════════════════════════╣
║ 阶段1 ║ 下载远端操作。把 sync-data.json 从 OneDrive/Dropbox 拉下来，  ║
║      ║ 解密、解压、解析出 recentOps（最近 500 条操作）。              ║
╠══════╬═══════════════════════════════════════════════════════════════╣
║ 阶段2 ║ 冲突检测。对收到的每一条远程操作，去 IndexedDB 查"这个实体     ║
║      ║ 我本地改过没有？"。用向量时钟比较来判断是新的、过时的、还是      ║
║      ║ 真正冲突（两边都改了同一个东西）。                             ║
╠══════╬═══════════════════════════════════════════════════════════════╣
║ 阶段3 ║ 冲突解决。检测到 CONCURRENT 冲突 → LWW（Last-Write-Wins）    ║
║      ║ 自动解决：谁的时间戳更大谁就赢。不需要用户手动选择。            ║
╠══════╬═══════════════════════════════════════════════════════════════╣
║ 阶段4 ║ 应用远程操作。把非冲突的远程操作和 LWW 赢了的那方，写入        ║
║      ║ NgRx Store（内存中的状态）和 IndexedDB（持久化的操作日志）。    ║
╠══════╬═══════════════════════════════════════════════════════════════╣
║ 阶段5 ║ 上传本地操作。把本地还没同步的操作（从 IndexedDB 读出来），    ║
║      ║ 和远端的状态合并，构造成新的 sync-data.json，上传回去。        ║
╠══════╬═══════════════════════════════════════════════════════════════╣
║ 阶段6 ║ LWW 重上传。如果阶段3中本地赢了，冲突解决服务创建了新的操作，   ║
║      ║ 这些新操作需要在本次同步中也上传出去（让其他设备看到本地状态）。  ║
║      ║ 最多重试 3 次。                                               ║
╚══════╩═══════════════════════════════════════════════════════════════╝
```

**为什么是这个顺序？** 必须先下载再上传。如果先上传再下载，你可能刚上传完就被别人的旧数据覆盖。先下载 → 合并 → 再上传，保证你上传的一定是"基于最新版本修改的"。

---

### 5.1 顶层编排：SyncWrapperService.\_sync()

**白话：** `SyncWrapperService` 是同步流程的总指挥。它的 `_sync()` 方法做的事情很直白——"先拉（下载）、再推（上传）、如果有 LWW 赢了还要再推一轮"。它自己不处理文件，也不比较时钟，只是按顺序调用各个服务。同时还管一件事：防止两个同步同时跑（`_isSyncing` 锁）。

```
SyncWrapperService._sync():
    // ── 第 0 步：准备工作 ──
    rawProvider = providerManager.getActiveProvider()
    // 比如用户配置了 OneDrive → rawProvider 就是 OneDrive 类的实例
    // 这个实例只有 5 个文件操作方法（getFileRev/downloadFile/uploadFile/...）

    // WrappedProviderService 做一个判断：
    //   如果 provider 本身支持操作同步（SuperSync）→ 直接返回它
    //   如果 provider 只是文件存储（OneDrive/Dropbox/...）→ 用适配器包一层
    // 适配器做的事：把"上传操作列表"翻译成"构建 sync-data.json → 上传文件"
    syncProvider = wrappedProvider.getOperationSyncCapable(rawProvider)

    // 检测用户是否切换了 provider（比如从 Dropbox 换成 OneDrive）
    // 如果是 → 强制从 seq 0 重新下载全部数据
    isProviderSwitch = (lastSyncedProvider !== null && lastSyncedProvider !== providerId)

    // ═══════════════════════════════════════════════════════════════
    // 阶段 1：下载远端操作
    // ═══════════════════════════════════════════════════════════════
    // 白话：从 OneDrive 上把 sync-data.json 拉下来，看看别人改了啥
    downloadResult = downloadRemoteOps(syncProvider,
        isProviderSwitch ? { forceFromSeq0: true } : undefined
    )
    // downloadResult.kind 可能是：
    //   'no_new_ops'         → 远端没新东西，省事了
    //   'snapshot_hydrated'  → 新客户端，下载了完整状态
    //   'ops_processed'      → 有新操作，已经处理完了
    //   'cancelled'          → 用户在冲突对话框中点了取消
    //   'server_migration_handled' → 空服务器，已上传种子数据
    if downloadResult.kind === 'cancelled':
        return 'HANDLED_ERROR'

    // ═══════════════════════════════════════════════════════════════
    // 阶段 2：上传本地操作
    // ═══════════════════════════════════════════════════════════════
    // 白话：把本地还没同步的操作推到远端
    uploadResult = uploadPendingOps(syncProvider)
    if uploadResult.kind === 'cancelled':
        return 'HANDLED_ERROR'

    // ═══════════════════════════════════════════════════════════════
    // 阶段 3：LWW 重上传循环
    // ═══════════════════════════════════════════════════════════════
    // 白话：下载阶段如果 LWW 判定"本地赢了"，ConflictResolutionService
    // 会创建新的操作（携带当前实体状态 + 合并后的向量时钟）。
    // 这些新操作还没上传——它们刚被写进 IndexedDB，标记为 unsynced。
    // 所以这里再跑一轮上传，把新操作推出去，让其他客户端看到本地的状态。
    //
    // 具体例子：
    //   手机改了 T1 标题（timestamp=1000），电脑改了 T1 标签（timestamp=1005）
    //   电脑同步时发现 CONCURRENT → LWW 判定电脑赢（1005 > 1000）
    //   → 创建新操作 OP_NEW（clock={A:6,B:6}，携带电脑上的 T1 完整状态）
    //   → OP_NEW 现在在 IndexedDB 里，状态是 unsynced
    //   → 这个循环检测到 pendingLwwOps=1 → 再调一次 uploadPendingOps
    pendingLwwOps = downloadResult.localWinOpsCreated + uploadResult.localWinOpsCreated
    lwwRetries = 0
    while pendingLwwOps > 0 AND lwwRetries < MAX_LWW_REUPLOAD_RETRIES (3):
        lwwRetries++
        reuploadResult = uploadPendingOps(syncProvider)
        pendingLwwOps = reuploadResult.localWinOpsCreated
        // 为什么可能需要多次循环？
        // 因为上传过程中可能又产生新的 piggybacked 操作，
        // 处理这些新操作时可能又触发 LWW，又创建了新的 local-win op。

    // ── LWW 重上传失败处理 ──
    if pendingLwwOps > 0:
        // 重试了 3 次还没上传成功。可能的原因和后果：
        //
        // 情况 A：每次上传都遇到 ETag 冲突（412 Precondition Failed）
        //   → 另一个客户端在疯狂上传，我们抢不到锁
        //   → 操作还在 IndexedDB 里（unsynced 状态），不会丢
        //   → 下次同步触发时会重新尝试
        //
        // 情况 B：网络持续故障
        //   → 同上，操作不丢，等网络恢复
        //
        // 情况 C：payload 太大，OneDrive 拒绝（413 Request Entity Too Large）
        //   → snapshotState 包含了完整应用状态，可能很大
        //   → 这种情况比较少见，因为 state 经过了压缩
        //   → 同样是下次同步重试
        //
        // 同步状态设为 UNKNOWN_OR_CHANGED（用户看到的不是绿色对勾，而是警告图标）
        // 用户感知：同步状态显示"未知/已变化"，但数据没丢。
        // 关键保证：操作永远先从 IndexedDB 删除再标记为"已同步"——
        //   只要操作在 IndexedDB 里且 synced=false，下次同步一定会重试。
        this._providerManager.setSyncStatus('UNKNOWN_OR_CHANGED')
        return SyncStatus.UpdateRemote

    // ── 第 4 步：标记最终状态 ──
    if uploadResult.permanentRejectionCount > 0:
        // 有操作被永久拒绝（比如 schema 版本不兼容）
        setSyncStatus('ERROR')
    else:
        setSyncStatus('IN_SYNC')  // 用户看到绿色对勾
        if providerId === SuperSync: connectWebSocket()
```

---

### 5.2 阶段 1 详解：下载远端操作 — downloadRemoteOps()

**白话：** 这个阶段的目标很简单——"把别人改的东西拿过来看看"。但实现上要处理很多边界情况：远端文件不存在（首次同步）、文件被别的客户端覆盖了（版本回退）、操作列表有空隙（被裁剪了）、以及最重要的——新客户端第一次同步时本地和远端都有数据怎么办。

下载分两层：底层是 `FileBasedSyncAdapterService._downloadOps()` 负责读文件 + 解析，上层是 `OperationLogSyncService.downloadRemoteOps()` 负责判断各种情况并决定下一步做什么。

#### 5.2.1 底层：读文件、解密、Gap 检测

**白话：** 适配器的 `_downloadOps()` 做的事情就是"下载 sync-data.json → 解密 → 解压 → 检查有没有 gap → 返回操作列表"。这里的"gap"是指"我们漏掉了一些操作"——因为 sync-data.json 只保留最近 500 条操作，如果一个客户端很久没同步，它期望的操作可能已经被裁剪掉了。

```
FileBasedSyncAdapterService._downloadOps(sinceSeq, excludeClient):
    // 参数说明：
    //   sinceSeq: 上次同步时远端的 syncVersion。这次只下载 >sinceSeq 的操作
    //   excludeClient: 排除这个 clientId 的操作（自己上传的不需要再下载）

    // ── A. 下载 + 解密 ──
    result   = provider.downloadFile("sync-data.json")
    // OneDrive 实现：GET /me/drive/special/approot:/Super Productivity/sync-data.json:/content
    // 一次 HTTP 请求同时拿到 ETag（在响应头里）和文件内容（在响应体里）
    rev      = result.rev         // 例如: "aOE2MDI5RTcwRTE0NUU2N0MhNjAzLjk4Nw"
    rawData  = result.dataStr     // 加密+压缩后的字符串
    syncData = 解密解压(rawData)   // AES-GCM 解密 → 解压 → JSON.parse → FileBasedSyncData
    // ⏱️ syncData 结构：{ version, syncVersion, vectorClock, state, recentOps, ... }
    //    state 是完整应用快照（tasks + projects + tags + ...）
    //    recentOps 是最近 500 条操作

    // 🔒 缓存这次下载的结果（TTL 30秒）
    // 因为一个同步周期中 _downloadOps 和 _uploadOps 都会被调用，
    // 如果 _uploadOps 也要下载，直接读缓存省一次 HTTP 请求
    _syncCycleCache.set(providerKey, { syncData, rev, timestamp: Date.now() })

    // ── B. Gap 检测 ──
    // 目的：判断我们是否"漏掉"了一些操作。三种情况需要从 seq 0 重新下载全部。

    previousVersion = expectedSyncVersions.get(providerKey) ?? 0
    // previousVersion 是"我们以为的远端 syncVersion"——上次我们成功同步后记录的

    // ① 版本回退
    // 白话：我们上次同步完是 syncVersion=10，这次下载下来 syncVersion=5
    // → 另一个客户端用"Use Local"覆盖了文件（上传了旧版本的全量快照）
    // → 我们不能再从 seq 10 增量下载了，必须从 0 开始
    versionWasReset = (previousVersion > 0 AND syncData.syncVersion < previousVersion)

    // ② 快照替换
    // 白话：我们期望有增量操作（sinceSeq > 0），但文件里 recentOps 是空的
    // 且 state 存在 → 另一个客户端直接上传了完整状态快照（覆盖了历史操作）
    snapshotReplacement = (
        sinceSeq > 0 AND
        syncData.recentOps.length === 0 AND
        !!syncData.state AND
        syncData.clientId !== excludeClient   // 不是我们自己上传的
    )

    // ③ 部分裁剪（partial trimming）
    // 白话：recentOps 最多存 500 条。如果满了，最老的操作会被删掉。
    // 我们记录的 sinceSeq 可能指向一个已经被删掉的操作。
    // 判断方法：文件上记录了一个 oldestOpSyncVersion（最老操作的 sv），
    // 如果我们期望的 sinceSeq 比它还小 → 我们漏掉了被裁掉的操作
    partialTrimGap = (
        sinceSeq > 0 AND
        syncData.oldestOpSyncVersion !== undefined AND
        syncData.oldestOpSyncVersion > sinceSeq AND
        syncData.recentOps.length >= 500
    )

    needsGapDetection = versionWasReset OR snapshotReplacement OR partialTrimGap

    // ── C. 构建操作列表 ──
    // recentOps 是从旧到新排列的数组（下标 0 = 最老，最后一个 = 最新）
    filteredOps = []
    for (compactOp, index) in syncData.recentOps:    // index = 0, 1, 2, ...（数组下标）
        if excludeClient AND compactOp.clientId === excludeClient:
            continue   // 跳过自己上传的，自己不需要再应用一遍
        filteredOps.push({
            serverSeq: index + 1,                    // 用下标+1合成序列号（仅用于兼容接口）
            op: compactToSyncOp(compactOp),          // SyncFileCompactOp → SyncOperation
            receivedAt: compactOp.ts
        })

    // ── D. 快照状态（仅 seq 0 下载时返回） ──
    // 白话：当 sinceSeq=0（全量下载）时，把完整状态也带回去，
    // 让上层可以直接水合到 NgRx Store
    snapshotState =
        if sinceSeq === 0 AND syncData.state:
            // 合并 state + archiveYoung + archiveOld 为一个对象
            { ...syncData.state, archiveYoung, archiveOld }
        else:
            undefined

    // 这个 return 的值就是 5.2.2 中 `result = downloadService.downloadRemoteOps(...)` 拿到的 result
    return {
        ops: filteredOps.slice(0, 500),
        latestSeq: syncData.syncVersion,          // 🔒 syncVersion 作为逻辑序列号
        snapshotVectorClock: syncData.vectorClock, // 🕐 快照的整体向量时钟
        gapDetected: needsGapDetection,            // 如果 true，上层会从 seq 0 重试
        snapshotState: snapshotState                // 仅 sinceSeq=0 时有值，是完整应用状态对象
    }
```

#### 5.2.2 上层：判断场景、保护本地数据、触发水合

**白话：** 适配器返回操作列表后，`OperationLogSyncService` 要根据不同情况来分流处理。这里的关键逻辑是"保护本地数据"——如果本地有未同步的修改，不能直接丢弃它们。

```
OperationLogSyncService.downloadRemoteOps(syncProvider):
    result = downloadService.downloadRemoteOps(syncProvider)

    // ── 场景 1：服务器是空的（新注册），但本地有数据 ──
    if result.needsFullStateUpload:
        serverMigrationService.handleServerMigration(syncProvider)
        // 创建一个 SYNC_IMPORT 操作，上传本地全量状态去"播种"
        return { kind: 'server_migration_handled' }

    // ── 场景 2：全量下载（seq 0），远端有完整状态快照 ──
    // snapshotState 是从 sync-data.json 的 state 字段解析出来的完整应用状态
    // （tasks + projects + tags + notes + config...），不是 bool 值。
    // 只有 sinceSeq=0（全量下载）时才有值，用来给新客户端做初始化。
    if result.snapshotState:
        // 🕐 短路优化：为什么要比向量时钟？
        //   即使远端返回了完整状态，也不能直接覆盖本地——
        //   本地可能有更"新"的数据（离线修改了但还没上传）。
        //   例子：电脑本地时钟 {A:6,B:7}，远端时钟 {A:6,B:6}
        //   → GREATER_THAN：本地比远端多了一个操作，跳过水合保护本地数据
        localClock  = opLogStore.getVectorClock()      // ⏱️ 从 IndexedDB 读本地向量时钟
        remoteClock = result.snapshotVectorClock

        if localClock 非空 AND remoteClock 非空:
            cmp = compareVectorClocks(localClock, remoteClock)
            if cmp === 'EQUAL' OR cmp === 'GREATER_THAN':
                // 白话：本地时钟 ≥ 远端时钟 → 本地已经拥有远端的所有信息
                // EQUAL: 完全同步，没必要水合
                // GREATER_THAN: 本地还有远端不知道的操作（未同步的），
                //   不能用水合覆盖，否则会丢数据
                return { kind: 'no_new_ops' }

        // ⚠️ 走到这里说明本地时钟 < 远端时钟（远端有本地不知道的新数据）
        // 但还要检查：本地有没有还没同步的操作？
        unsyncedOps = opLogStore.getUnsynced()          // ⏱️ 从 IndexedDB 查
        if unsyncedOps.length > 0:
            // 🔥 最坏情况：本地和远端都有对方不知道的数据
            // 不能自动解决 → 弹出冲突对话框让用户手动选
            throw LocalDataConflictError(...)

        // 新客户端引导
        if isFreshClient AND hasStoreData:
            throw LocalDataConflictError(...)  // 本地已有数据（之前忘记开同步？）
        if isFreshClient:
            if NOT confirmDialog("远端有数据，是否下载？"):
                return { kind: 'cancelled' }

        // ✅ 水合：把远端状态写入本地
        syncHydrationService.hydrateFromRemoteSync(
            result.snapshotState,
            result.snapshotVectorClock,
            createSyncImport=false
            // 文件类 Provider 不创建 SYNC_IMPORT——
            // 状态在 sync-data.json 中已有权威副本
        )
        // ⏱️ 同时把 recentOps 写入 IndexedDB（防止下次同步当作新操作重复应用）
        opLogStore.appendBatchSkipDuplicates(result.newOps)
        return { kind: 'snapshot_hydrated' }

    // ── 场景 3：没有新操作，一切同步 ──
    if result.newOps.length === 0:
        return { kind: 'no_new_ops' }

    // ── 场景 4：正常的增量同步（最常见的情况）──
    // 远端有我们没见过的普通操作（不是全量快照），需要一条条处理。
    //
    // 但先做一个特殊检查：这些操作里有没有 SYNC_IMPORT？
    // SYNC_IMPORT 是一种特殊的"全量导入操作"——某个客户端把它的完整状态
    // 打包成一个操作上传了（比如：新设备第一次同步、从备份恢复）。
    // 如果收到了 SYNC_IMPORT 而本地也有未同步的操作 → 冲突！
    // 因为 SYNC_IMPORT 代表"用我的全部状态替换现有的一切"。
    incomingFullStateOp = result.newOps.find(op => FULL_STATE_OP_TYPES.has(op.opType))
    if incomingFullStateOp:
        pendingOps = opLogStore.getUnsynced()           // ⏱️
        if hasMeaningfulPendingOps(pendingOps):
            // 🔥 冲突对话框："别人导入了完整数据，你本地也有没同步的修改"
            resolution = showSyncImportConflictDialog()
            if resolution === 'CANCEL': return { kind: 'cancelled' }
            // USE_LOCAL → 上传本地数据覆盖远端
            // USE_REMOTE → 下载远端数据丢弃本地
        // 如果 pending 是空的或者没有有意义的用户数据 → 静默接受远端

    // ✅ 核心步骤：处理远程操作（详见 5.3）
    processResult = remoteOpsProcessingService.processRemoteOps(result.newOps)

    // 记录最新的 seq，防止下次重复下载同一批操作
    syncProvider.setLastServerSeq(result.latestSeq)
    return { kind: 'ops_processed', localWinOpsCreated: processResult.localWinOpsCreated }
```

---

### 5.3 阶段 2 + 3：冲突检测与解决管线 — processRemoteOps()

**白话：** 这是整个同步系统最复杂的部分。拿到一批远程操作后，对每一个操作问三个问题：

1. 这个操作是给我看的吗？（Schema 版本兼容？）
2. 这个操作是新的还是旧的？（向量时钟比较）
3. 如果是冲突的——两边都改了同一个东西——怎么办？（LWW 自动解决）

下面是一个具体的数值例子，后面会一直用：

> **示例设定（贯穿 5.3–5.6）：**
> 手机（client-A）和电脑（client-B）都从同步状态开始：
> 向量时钟：`{ A: 5, B: 4 }`
> 任务 T1：`{ title: "买牛奶", tags: ["购物"] }`
>
> t1: 手机离线，把 T1 标题改成 `"买有机牛奶"`
> → 操作 A6: `{ entityId: "T1", clock: {A:6,B:4}, ts: 1000, payload: {title: "买有机牛奶"} }`
>
> t2: 电脑离线，把 T1 标签改成 `["购物", "紧急"]`
> → 操作 B5: `{ entityId: "T1", clock: {A:5,B:5}, ts: 1005, payload: {tags: ["购物","紧急"]} }`
>
> t3: 手机先上线同步 → 上传 A6 到 sync-data.json
> t4: 电脑上线同步 → 从 sync-data.json 下载到 A6 → 开始处理

```
RemoteOpsProcessingService.processRemoteOps(remoteOps):
    // remoteOps = [A6]（电脑从 sync-data.json 下载到手机的操作）

    // ═══════════════════════════════════════════════════════════════
    // Step 1: Schema 迁移
    // ═══════════════════════════════════════════════════════════════
    // 白话：确保操作的数据格式版本是兼容的。如果版本太旧（不兼容），直接拒绝。
    // 如果可以迁移（比如新增了一个字段），自动转换。
    for each op in remoteOps:
        if op.schemaVersion < MIN_SUPPORTED:
            throw Error("版本太旧，无法同步")
        if op.schemaVersion > currentVersion + MAX_SKIP:
            updateRequired = true; break
        migratedOps.push( schemaMigrationService.migrate(op) )

    // ═══════════════════════════════════════════════════════════════
    // Step 2: SYNC_IMPORT 过滤
    // ═══════════════════════════════════════════════════════════════
    // 白话：如果本地刚导入了全量数据（SYNC_IMPORT），那些导入之前的远程操作
    // 就过时了——导入已经包含了它们的最终效果。
    // 判断方法：如果远程操作的向量时钟 ≤ SYNC_IMPORT 的向量时钟 → 丢弃
    filterResult = syncImportFilterService.filterOpsInvalidatedBySyncImport(migratedOps)
    if filterResult.allOpsFiltered:
        return { allOpsFilteredBySyncImport: true, ... }

    opsToProcess = filterResult.remainingOps
    // 在我们的例子中，电脑本地没有 SYNC_IMPORT → 不过滤，A6 继续

    // ═══════════════════════════════════════════════════════════════
    // Step 3: 分离全量操作
    // ═══════════════════════════════════════════════════════════════
    // 白话：SYNC_IMPORT 和 BACKUP_IMPORT 是全量操作，不需要冲突检测，
    // 直接应用即可（它们代表"全部替换"）。
    fullStateOps  = opsToProcess.filter(op => FULL_STATE_OP_TYPES.has(op.opType))
    regularOps    = opsToProcess.filter(op => NOT fullStateOps)
    // A6 是普通 UPDATE → regularOps = [A6]

    // ═══════════════════════════════════════════════════════════════
    // Step 4: 冲突检测 —— 每个远程操作和本地比较
    // ═══════════════════════════════════════════════════════════════
    conflicts = []
    nonConflictingOps = []

    for each remoteOp in regularOps:   // remoteOp = A6: {clock: {A:6,B:4}}

        // 🕐 查询本地前沿：对于 T1 这个实体，本地知道多少？
        localFrontier = vectorClockService.getEntityFrontier("TASK", "T1")

        // getEntityFrontier 内部做的事（详见 5.4.2）：
        //   1. ⏱️ IndexedDB 查 T1 最后一条已同步操作的 clock → {A:5, B:4}
        //   2. ⏱️ IndexedDB 查 T1 所有待同步操作的 clock → [B5: {A:5,B:5}]
        //   3. merge: {A:5,B:4} ∪ {A:5,B:5} → {A:5, B:5}
        //   所以 localFrontier = {A:5, B:5}

        // 🕐 核心比较
        comparison = compareVectorClocks(localFrontier, remoteOp.vectorClock)
        // compareVectorClocks({A:5,B:5}, {A:6,B:4}):
        //   key A: 5 < 6 → bGreaterInSome
        //   key B: 5 > 4 → aGreaterInSome
        //   → CONCURRENT

        switch comparison:
            case 'GREATER_THAN':
                // 白话：本地前沿每个key都 ≥ 远程时钟 → 本地已经知道这个操作
                skip(remoteOp)
            case 'EQUAL':
                // 白话：完全一样 → 重复操作
                skip(remoteOp)
            case 'LESS_THAN':
                // 白话：远程的每个key都 ≥ 本地 → 远程有新东西，本地没改过
                nonConflictingOps.push(remoteOp)
            case 'CONCURRENT':
                // 🔥 白话：两边都改了！本地有 B5，远程有 A6，互不知道对方
                conflicts.push(EntityConflict{
                    entityType: "TASK",
                    entityId:   "T1",
                    localOps:   [B5],     // ⏱️ 电脑本地未同步的 T1 操作
                    remoteOps:  [A6]       // 手机发来的 T1 操作
                })
    // 结果：conflicts = [{ entity: T1, local: [B5], remote: [A6] }]
    //      nonConflictingOps = []

    // ═══════════════════════════════════════════════════════════════
    // Step 5: 冲突解决或直接应用
    // ═══════════════════════════════════════════════════════════════
    if conflicts.length > 0:
        // 🔥 进入 LWW 自动解决（详见 5.5）
        resolution = conflictResolutionService.autoResolveConflictsLWW(
            conflicts,
            nonConflictingOps
        )
        localWinOpsCreated = resolution.localWinOpsCreated
        // 在我们的例子中：B5.ts=1005 > A6.ts=1000 → 本地赢
        // → 创建新操作 OP_NEW（clock={A:6,B:6}）→ localWinOpsCreated = 1
        //   因为 merge({A:5,B:5}, {A:6,B:4}) = {A:6,B:5}, B是本地再+1 → {A:6,B:6}
    else:
        operationApplier.applyNonConflictingOps(
            nonConflictingOps ++ fullStateOps
        )
        localWinOpsCreated = 0

    // ═══════════════════════════════════════════════════════════════
    // Step 6: Checkpoint D — 状态验证
    // ═══════════════════════════════════════════════════════════════
    // 白话：所有操作应用完后，跑一遍完整性检查：
    //   任务引用的项目是否存在？子任务的父任务是否存在？
    //   tagIds 和 taskIds 是否双向一致？等等
    validateStateService.validateAndRepairCurrentState('remote-ops-processing')

    return { localWinOpsCreated: 1, allOpsFilteredBySyncImport: false }
```

---

### 5.4 细节放大：向量时钟到底怎么比？

**白话：** 向量时钟是整个系统的"因果追踪器"。它回答的问题是："客户端 A 知不知道客户端 B 做的事？"

#### 5.4.1 compareVectorClocks() 逐行分解

```
compareVectorClocks(clockA, clockB):

    输入：
      clockA = { A: 5, B: 5 }   ← 电脑对 T1 的本地前沿
      clockB = { A: 6, B: 4 }   ← 手机 A6 操作的向量时钟

    算法：
      allKeys = [A, B]
      aGreaterInSome = false   // clockA 有没有在任何 key 上大于 clockB？
      bGreaterInSome = false   // clockB 有没有在任何 key 上大于 clockA？

      key A: valA=5, valB=6 → 5<6 → bGreaterInSome = true
      key B: valA=5, valB=4 → 5>4 → aGreaterInSome = true

      aGreaterInSome=true AND bGreaterInSome=true → return 'CONCURRENT'

    结果解读：
      CONCURRENT = 双方都不知道对方的最新操作
      - 电脑知道 A 做了 5 个操作，但 A 实际上做了 6 个（漏了 A6）
      - 手机知道 B 做了 4 个操作，但 B 实际上做了 5 个（漏了 B5）
      - 两边都"无知"于对方 → 这就是真正的冲突

    其他结果例子：
      {A:7,B:6} vs {A:6,B:4} → A key: 7>6, B key: 6>4 → GREATER_THAN
        解读：电脑完全知道手机的一切（手机上 A 最多到 6，B 最多到 4）
      {A:6,B:4} vs {A:6,B:4} → 所有 key 相等 → EQUAL
      {A:5,B:4} vs {A:7,B:7} → A:5<7, B:4<7 → LESS_THAN
        解读：手机完全知道电脑的一切

    关键直觉：
      向量时钟不是"谁大谁小"的简单数值比较。
      它是"每一方对全局的认知程度"。
      只有当一方在每个维度上都 ≥ 另一方时，才能说"我完全知道你都干了什么"。
```

#### 5.4.2 getEntityFrontier() — 实体的"本地知识边界"

**白话：** "前沿"（frontier）是一个实体的"本地知识边界"——对于实体 T1，本地对它知道多少了？这包括两方面：(1) 已经应用的操作（synced=true），(2) 还没同步的本地修改（synced=false）。把所有时钟 merge 到一起，取每个 clientId 的最大值，就是前沿。

```
getEntityFrontier(entityType="TASK", entityId="T1"):

    // 步骤1: ⏱️ 查 IndexedDB — T1 最后一条已应用操作
    lastAppliedClock = opLogStore.getLastAppliedClock("TASK", "T1")
    // SQL: SELECT vectorClock FROM SUP_OPS
    //      WHERE entityType='TASK' AND entityId='T1' AND synced=1
    //      ORDER BY seq DESC LIMIT 1
    // 结果: { A:5, B:4 }

    // 步骤2: ⏱️ 查 IndexedDB — T1 所有还没同步的操作
    pendingOps = opLogStore.getUnsyncedForEntity("TASK", "T1")
    // SQL: SELECT vectorClock FROM SUP_OPS
    //      WHERE entityType='TASK' AND entityId='T1' AND synced=0
    // 结果: [B5: {A:5, B:5}]

    // 步骤3: merge — 每个 clientId 取最大值
    frontier = lastAppliedClock   // {A:5, B:4}
    for each pending in pendingOps:
        frontier = mergeVectorClocks(frontier, pending.vectorClock)
        // merge({A:5,B:4}, {A:5,B:5}) = {A: max(5,5)=5, B: max(4,5)=5}
    return { A:5, B:5 }
```

**为什么用实体前沿而不是直接用操作的时钟？**
因为一个实体可能被多次修改。如果电脑连续改了 T1 三次（B5, B6, B7），只比较远程 A6 vs 本地 B7 是不够的——B5 和 B6 也是冲突的。前沿把"本地所有关于这个实体的知识"压缩成一个时钟，一次比较就知道全部情况。

**操作保留策略：每个实体保留所有操作，不只最新的**

IndexedDB 保留每个操作（不管是不是同实体），不做"同实体去重"。一个实体被改 10 次就是 10 条操作。这很重要，因为：

- 每条操作都有独立的向量时钟，用于冲突检测时构建完整的 entity frontier
- 启动时回放所有操作来恢复状态
- 如果一个实体的旧操作被删了，就检测不到"远程操作其实是冲突的"——旧操作的时钟也是实体知识边界的一部分

远端 `recentOps` 保留最近 500 条操作（不分实体），超出则裁剪最旧的——这就是需要 `oldestOpSyncVersion` 做 gap 检测的原因。

#### 5.4.3 冲突判断速查表

| 比较结果       | 含义                                               | 处理        |
| -------------- | -------------------------------------------------- | ----------- |
| `GREATER_THAN` | 本地前沿每个key都≥远程：本地已经知道这个操作       | 跳过        |
| `EQUAL`        | 完全相同：本地已经应用过                           | 跳过        |
| `LESS_THAN`    | 远程每个key都≥本地：远程有新东西，本地没改过该实体 | 直接应用    |
| `CONCURRENT`   | 互有高低：两边都改了，互不知道                     | 进 LWW 解决 |

---

### 5.5 阶段 3 详解：LWW 自动解决 — autoResolveConflictsLWW()

**白话：** 检测到 CONCURRENT 冲突后，系统不会弹对话框——而是静默自动解决。规则很简单：**谁的时间戳更大谁就赢**。但有几个特殊情况：

- 双方都删了同一个东西 → 不冲突，效果一致
- 双方操作内容完全一样 → 不冲突，效果一致
- 归档操作（用户明确说"我处理完了"）→ 归档总是赢，不管时间戳

**继续我们的例子：**
电脑收到手机的 A6（改标题为"买有机牛奶"，ts=1000），电脑本地有 B5（改标签为["购物","紧急"]，ts=1005）。

```
ConflictResolutionService.autoResolveConflictsLWW(conflicts, nonConflictingOps):
    // conflicts = [{ entity: T1, local: [B5], remote: [A6] }]
    // B5.ts = 1005, A6.ts = 1000

    resolutions = []
    for each conflict in conflicts:

        // ── 检查特殊情况 ──

        // ① 双方都 DELETE
        if allLocalDelete AND allRemoteDelete:
            resolutions.push({ winner: 'remote' })
            continue
        // 我们的例子: B5 和 A6 都是 UPDATE，不是 DELETE → 跳过

        // ② payload 完全一样
        if localOps.length===1 AND remoteOps.length===1 AND localPayload===remotePayload:
            resolutions.push({ winner: 'remote' })
            continue
        // 我们的例子: B5.payload={tags}, A6.payload={title} → 不一样 → 跳过

        // ③ 归档操作优先
        if remoteOps 中有归档操作:
            resolutions.push({ winner: 'remote' })
            continue
        if localOps 中有归档操作:
            // 本地归档赢 → 创建新操作
            currentState = 从 NgRx Store 读取该实体
            mergedClock = mergeVectorClocks(所有冲突时钟) + increment
            newOp = createLWWUpdateOp(...)
            resolutions.push({ winner: 'local', localWinOp: newOp })
            continue
        // 我们的例子: 没有归档操作 → 跳过

        // ── 正常 LWW：比时间戳 ──
        localMaxTs  = 1005   // B5 的时间戳
        remoteMaxTs = 1000   // A6 的时间戳

        if localMaxTs > remoteMaxTs:    // 1005 > 1000 → TRUE
            // ✅ 本地赢！

            // 从 NgRx Store 读取 T1 的当前状态
            // 注意：电脑上 T1 现在是 { title: "买牛奶", tags: ["购物","紧急"] }
            // 因为电脑离线修改了标签，手机上改的标题还没同步过来
            currentState = store.getState().task.entities["T1"]
            // currentState = { title: "买牛奶", tags: ["购物","紧急"], notes: "" }

            // 🕐 合并双方时钟 + 递增
            // 规则：每个 clientId 取最大值，然后本地 clientId 再 +1
            // 为什么这样设计？
            //   - 取最大值：承认"我知道A做到了第6个，B做到了第5个"
            //   - B再+1：因为B（本地）在这一切基础上又多做了一个操作
            //   - 这样新时钟在每个维度上都 ≥ 所有冲突时钟 → 彻底解决冲突
            allClocks = [{A:5,B:5}, {A:6,B:4}]
            mergedClock = mergeAndIncrement(allClocks, clientId="B")
            // merge: A: max(5,6)=6, B: max(5,4)=5
            // increment B (只有B，不是A): {A:6, B:6}
            // 注意：如果冲突的客户端是3个（A/B/C），A和C都取max，只有本地B+1

            // ⏱️ 创建新的 LWW Update 操作
            newOp = createLWWUpdateOp(
                entityType="TASK",
                entityId="T1",
                state=currentState,           // T1 的完整当前状态
                clientId="B",
                clock={A:6, B:6},             // 合并+递增后的时钟
                timestamp=1005                // 保留本地时间戳
            )
            // newOp 的内容：{ type: UPDATE, entityId: T1,
            //   payload: { title: "买牛奶", tags: ["购物","紧急"] },
            //   clock: {A:6, B:6}, ts: 1005 }

            resolutions.push({ winner: 'local', localWinOp: newOp })
        else:
            // ✅ 远程赢（或平局）
            resolutions.push({ winner: 'remote' })

    // ═══════════════════════════════════════════════════════════════
    // Phase 2: 批量应用
    // ═══════════════════════════════════════════════════════════════
    allOpsToApply = []
    localOpsToReject = []
    remoteOpsToReject = []

    for each resolution in resolutions:
        if resolution.winner === 'local':
            // 拒绝双方原来的冲突操作，用新的合并操作替代
            localOpsToReject.push(B5)       // 电脑原来的标签修改
            remoteOpsToReject.push(A6)      // 手机原来的标题修改
            allOpsToApply.push(OP_NEW)      // 新的合并操作
        else:  // remote wins
            // 拒绝本地操作，接受远程操作
            localOpsToReject.push(...)
            allOpsToApply.push(...)

    // 同时打包非冲突操作
    allOpsToApply.push(...nonConflictingOps)

    // ── 🔒 原子性保护（关键！） ──
    // ⏱️ 先标记哪些操作被拒绝了（写入 IndexedDB rejected 标记），
    // 然后再应用新操作。顺序很重要：
    // 如果反过来（先应用 → 崩溃 → 没标记 rejected）
    // → 重启后旧的 B5 还在 IndexedDB 里且 synced=false → 会被重新上传！
    opLogStore.markRejected(localOpsToReject, remoteOpsToReject)
    // 现在 B5 和 A6 在 IndexedDB 里的状态是 rejected=true

    // ✅ 批量应用（一次 NgRx dispatch，不是逐条 dispatch）
    operationApplier.applyAll(allOpsToApply)
    // applyAll 内部：
    //   对 OP_NEW → 调用对应的 meta-reducer 更新 NgRx Store
    //   ⏱️ 将 OP_NEW 写入 IndexedDB（synced=false，等待上传）
    //   🕐 mergeVectorClocks(localClock, OP_NEW.clock) 更新本地时钟

    // ⏱️ OP_NEW 现在在 IndexedDB 里：
    //   { id: "OP_NEW", entityId: "T1", synced: false,
    //     clock: {A:6,B:6}, ts: 1005,
    //     payload: { title: "买牛奶", tags: ["购物","紧急"] } }

    // 🕐 合并远程操作的时钟到本地全局时钟
    for each appliedOp:
        mergedLocalClock = mergeVectorClocks(localClock, appliedOp.vectorClock)
    opLogStore.setVectorClock(mergedLocalClock)
    // 电脑本地全局时钟现在是 {A:6, B:6}（之前是 {A:5, B:5}）

    // 🔧 Checkpoint D: 验证状态完整性
    validateAndRepairCurrentState('conflict-resolution')

    return { localWinOpsCreated: 1 }
    // 这个 1 会被 SyncWrapperService._sync() 捕获，
    // 触发 LWW 重上传循环 → 再调一次 uploadPendingOps 上传 OP_NEW
```

**关键理解：为什么本地赢了要创建新操作？**

```
错误做法 ❌：拒绝 A6，保留 B5
  结果：B5.clock = {A:5, B:5}，手机下次发来的操作还是 {A:6, B:4}
  → compareVectorClocks({A:6,B:4}, {A:5,B:5}) → 还是 CONCURRENT！
  → 每次同步都冲突，死循环！

正确做法 ✅：拒绝 B5 和 A6，创建新的 OP_NEW
  OP_NEW.clock = merge({A:5,B:5}, {A:6,B:4}) + increment B
              = {A:6, B:6}
  验证：{A:6,B:6} vs {A:6,B:4} → key A: 6=6, key B: 6>4 → GREATER_THAN ✓
  下次手机同步收到 OP_NEW → compareVectorClocks(手机前沿, {A:6,B:6})
  → LESS_THAN 或 EQUAL → 手机直接应用，冲突彻底解决！
```

---

### 5.6 阶段 5 详解：上传本地操作 — uploadPendingOps()

**白话：** 下载和应用完远程操作后，轮到本地"还礼"了——把本地还没同步的操作上传到远端。上传分两层：上层 `OperationLogSyncService` 做编排和检查，底层 `FileBasedSyncAdapterService._uploadOps()` 做实际的文件构建和上传。

**继续我们的例子：** 电脑刚处理完冲突，IndexedDB 里有一个新的 unsynced 操作 OP_NEW。

#### 5.6.1 上层编排

```
OperationLogSyncService.uploadPendingOps(syncProvider):
    // ── 前置检查 ──

    // ⏱️ 确保所有正在写入的操作先落到 IndexedDB
    // 如果有操作刚被 dispatch 到 NgRx，meta-reducer 可能还在异步写 IndexedDB
    // 不刷盘的话，这些操作可能不会被包含在本次上传中
    writeFlushService.flushPendingWrites()

    // ⏱️ 安全检查：全新客户端（无快照、lastSeq=0）不能上传
    // 为什么？新客户端本地是空的，上传会覆盖远端的所有数据
    if isWhollyFreshClient():
        return { kind: 'blocked_fresh_client' }

    // ⏱️ 检查是否要服务器迁移（空远端 + 本地有数据）
    serverMigrationService.checkAndHandleMigration(syncProvider)

    // ── 实际上传 ──
    // ⏱️ 这会触发 FileBasedSyncAdapterService._uploadOps()
    // 内部会：读 IndexedDB 取 unsynced ops → 下载远端 sync-data.json
    // → 合并 → 构建新 sync-data.json → 上传
    result = uploadService.uploadPendingOps(syncProvider)

    // ── 处理 Piggybacked 操作（先于 rejected 处理） ──
    // 白话：上传时服务器可能顺手带回其他客户端的新操作（"piggybacked"）。
    // 这些操作必须先处理——因为它们可能就是导致本地操作被拒的原因。
    // 例如：手机也上传了 T1 的修改 → 服务器返回手机的操作
    // → 需要先处理手机的操作（可能触发 LWW），再处理被拒的操作
    if result.piggybackedOps.length > 0:
        processRemoteOps(result.piggybackedOps)

    // ── 处理被拒操作 ──
    rejectionResult = rejectedOpsHandlerService.handleRejectedOps(
        result.rejectedOps
    )
    // 被拒的原因：CONCURRENT（服务器上的向量时钟比本地操作新）
    // RejectedOpsHandler 会创建 merged ops（类似于 LWW 本地赢时的处理）
    localWinOpsCreated = rejectionResult.mergedOpsCreated

    return {
        kind: 'completed',
        uploadedCount: result.uploadedCount,
        localWinOpsCreated,  // 如果非零 → SyncWrapperService 会触发重上传
    }
```

#### 5.6.2 底层：构建并上传 sync-data.json

**白话：** `_uploadOps()` 是文件上传的核心。它做的事：下载当前远端文件 → 把本地的新操作 merge 进去 → 重新上传。注意双层锁机制：(1) syncVersion 计数器在数据内，(2) ETag + If-Match 在 HTTP 传输层。

```
FileBasedSyncAdapterService._uploadOps(ops, clientId):
    // ops = [OP_NEW]（电脑创建的合并操作）

    // ══════════════════════════════════════════════════════
    // Step 1: 获取远端当前状态
    // ══════════════════════════════════════════════════════
    // 先查缓存：如果 _downloadOps 在本周期内刚下载过，直接用缓存
    // 缓存 TTL=30s，命中 → 省一次 API 调用
    // 未命中 → provider.downloadFile("sync-data.json")
    { currentData, currentSyncVersion, fileExists, revToMatch }
        = _getCurrentSyncState(provider)

    // 在我们的例子中：
    // currentData 包含 A6（手机上传的标题修改）
    // currentSyncVersion = 手机上轮上传后的值
    // revToMatch = 手机的 ETag

    if ops.length === 0 AND fileExists:
        return { results: [] }   // 没有操作要上传

    // ══════════════════════════════════════════════════════
    // Step 2: 构建合并后的 sync-data.json
    // ══════════════════════════════════════════════════════
    newData = _buildMergedSyncData(currentData, ops, clientId, currentSyncVersion):

        // 🔒 乐观锁递增
        newSyncVersion = currentSyncVersion + 1

        // 🕐 合并向量时钟
        mergedClock = currentData?.vectorClock ?? {}    // 比如 {A:6, B:4}
        for each op in ops:      // 只有 OP_NEW
            mergedClock = mergeVectorClocks(mergedClock, {A:6, B:6})
            // merge({A:6,B:4}, {A:6,B:6}) = {A:6, B:6}
            // 注意：A 维持 6（不变），B 从 4 升到 6

        // ⏱️ 合并 recentOps
        compactOps = ops.map(op => compactEncode(op))   // 压缩编码
        for each compactOp in compactOps:
            compactOp.sv = newSyncVersion               // 打上版本标记

        mergedOps = (currentData?.recentOps ?? [])
            .concat(compactOps)                         // 追加新操作
            .slice(-500)                                 // 保留最新 500

        // oldestOpSyncVersion 用于 gap 检测
        oldestOpSyncVersion = mergedOps[0]?.sv

        // ⏱️ 从 NgRx Store 读当前完整状态快照
        currentState = stateSnapshotService.getStateSnapshot()
        // 包含：tasks, projects, tags, notes, config...

        // ⏱️ 从 IndexedDB 读归档数据
        archiveYoung = archiveDbAdapter.loadArchiveYoung()
        archiveOld   = archiveDbAdapter.loadArchiveOld()

        return {
            version: 2,
            syncVersion: newSyncVersion,
            schemaVersion: ops[0]?.schemaVersion,
            vectorClock: mergedClock,         // {A:6, B:6}
            lastModified: Date.now(),
            clientId,                          // "B"
            state: currentState,
            archiveYoung, archiveOld,
            recentOps: mergedOps,
            oldestOpSyncVersion
        }

    // ══════════════════════════════════════════════════════
    // Step 3: 上传（双层乐观锁）
    // ══════════════════════════════════════════════════════
    _uploadWithMismatchFallback(newData, revToMatch):

        // 🔒 加密 + 压缩
        uploadData = encryptAndCompress(newData)

        try:
            // 🔒 HTTP 层乐观锁：If-Match: ETag
            // 如果 ETag 不匹配 → 412 Precondition Failed
            provider.uploadFile("sync-data.json", uploadData, revToMatch)
            return { finalSyncVersion: newData.syncVersion }

        catch UploadRevToMatchMismatchAPIError:
            // 🔥 ETag 变化了！另一个客户端在我们下载后、上传前修改了文件
            // 例如：手机在电脑下载后、上传前又发了一个新操作

            // 重新下载确认
            { freshRev, dataStr } = provider.downloadFile("sync-data.json")

            if freshRev === revToMatch:
                // ETag 没变 → 服务端 ETag 可能因为其他原因不一致
                // 不是真正的并发冲突，强制覆盖
                provider.uploadFile("sync-data.json", uploadData, freshRev,
                                     isForceOverwrite=true)
                return { finalSyncVersion: newData.syncVersion }
            else:
                // 🔥 ETag 真的变了！另一个客户端的操作已经落盘
                // 不能在这里合并——因为我们的 NgRx Store 里还没有
                // 应用那个客户端的操作。抛出异常 →
                //   下次同步周期：downloadRemoteOps() 拿到对方操作
                //   → processRemoteOps() 应用到本地
                //   → uploadPendingOps() 把合并后的数据上传
                throw ConcurrentUploadError(
                    "ETag changed; will merge on next sync cycle"
                )

    // ══════════════════════════════════════════════════════
    // Step 4: 上传后收尾
    // ══════════════════════════════════════════════════════
    clearCachedSyncData(providerKey)   // 清掉 30s 缓存（已过时）
    expectedSyncVersions.set(providerKey, finalSyncVersion)
    persistState()                     // 写入 localStorage（防重启丢失）

    return {
        results: ops.map((op, i) => ({
            opId: op.id,
            accepted: true,
            serverSeq: startingSeq + i + 1
        })),
        latestSeq: finalSyncVersion
    }
```

---

### 5.7 完整端到端追踪：手机 vs 电脑修改同一个任务

**白话：** 把以上所有阶段串起来，用一个具体的例子从头走到尾。每一步都标注了向量时钟和 IndexedDB 的变化。

```
初始状态（手机和电脑都已同步）：
  远端 sync-data.json: syncVersion=5, vectorClock={A:5, B:4}
  T1: { title: "买牛奶", tags: ["购物"], notes: "" }

  ═════════════════════════════════════════════════════════════
  第 0 步：两台设备离线，各改各的
  ═════════════════════════════════════════════════════════════

  手机 (client-A) 修改 T1 标题 → "买有机牛奶"
    ⏱️ IndexedDB 写入 A6: {
        id: "A6", entityId: "T1", opType: UPDATE,
        payload: { title: "买有机牛奶" },
        clock: {A:6, B:4}, ts: 1000, synced: false
      }

  电脑 (client-B) 修改 T1 标签 → ["购物", "紧急"]
    ⏱️ IndexedDB 写入 B5: {
        id: "B5", entityId: "T1", opType: UPDATE,
        payload: { tags: ["购物", "紧急"] },
        clock: {A:5, B:5}, ts: 1005, synced: false
      }

  ═════════════════════════════════════════════════════════════
  第 1 步：手机先上线同步
  ═════════════════════════════════════════════════════════════

  手机 SyncTriggerService 触发 → SyncWrapperService._sync()

  ┌─ 手机 阶段1: 下载 ─────────────────────────────────────┐
  │ 手机从 OneDrive 下载 sync-data.json → recentOps=[]     │
  │ （没有新操作，电脑还没上传）                              │
  │ → downloadResult.kind = 'no_new_ops'                    │
  └────────────────────────────────────────────────────────┘

  ┌─ 手机 阶段2: 上传 ─────────────────────────────────────┐
  │ ⏱️ IndexedDB 查 unsynced → [A6]                        │
  │ 下载远端 sync-data.json (syncVersion=5)                 │
  │ 构建新 sync-data.json:                                  │
  │   syncVersion: 6                                        │
  │   vectorClock: merge({A:5,B:4}, {A:6,B:4}) = {A:6,B:4} │
  │   recentOps: [A6]                                       │
  │   state: 完整应用快照（含 T1={title:"买有机牛奶",...}）  │
  │ PUT → 200 OK                                            │
  │ ⏱️ A6 标记为 synced=true                                │
  └────────────────────────────────────────────────────────┘

  结果：远端 sync-data.json:
    syncVersion: 6, vectorClock: {A:6, B:4}
    recentOps: [A6(sv=6, clock={A:6,B:4}, payload={title:"买有机牛奶"})]

  ═════════════════════════════════════════════════════════════
  第 2 步：电脑上线同步
  ═════════════════════════════════════════════════════════════

  电脑 SyncTriggerService 触发 → SyncWrapperService._sync()

  ┌─ 电脑 阶段1: 下载 ─────────────────────────────────────┐
  │ 从 OneDrive 下载 sync-data.json (syncVersion=6)         │
  │ recentOps = [A6(sv=6, clock={A:6,B:4})]                 │
  │                                                         │
  │ _downloadOps() 返回:                                    │
  │   ops = [{op: A6, serverSeq: 1, receivedAt: ...}]       │
  │   latestSeq = 6                                         │
  │   snapshotVectorClock = {A:6, B:4}                      │
  └────────────────────────────────────────────────────────┘

  ┌─ 电脑 阶段1续: 处理 A6 ────────────────────────────────┐
  │ OperationLogSyncService.downloadRemoteOps():            │
  │   result.snapshotState = undefined (sinceSeq>0)         │
  │   → 进入 processRemoteOps([A6])                         │
  │                                                         │
  │ processRemoteOps Step 4: 冲突检测                       │
  │   ⏱️ getEntityFrontier("TASK", "T1"):                   │
  │     lastApplied = {A:5, B:4}                            │
  │     pending      = [B5: {A:5, B:5}]                    │
  │     frontier     = {A:5, B:5}                           │
  │                                                         │
  │   🕐 compareVectorClocks({A:5,B:5}, {A:6,B:4})          │
  │     → CONCURRENT                                        │
  │                                                         │
  │ → conflicts = [{entity: T1, local: [B5], remote: [A6]}] │
  └────────────────────────────────────────────────────────┘

  ┌─ 电脑 阶段1续: LWW 解决 ───────────────────────────────┐
  │ autoResolveConflictsLWW:                                │
  │   非归档/非相同payload/非双删                           │
  │   → 正常 LWW：                                          │
  │     localMaxTs  = 1005 (B5)                             │
  │     remoteMaxTs = 1000 (A6)                             │
  │     → 本地赢！                                          │
  │                                                         │
  │   创建 OP_NEW:                                          │
  │     clock = merge({A:5,B:5},{A:6,B:4})+inc = {A:6,B:6} │
  │     ts = 1005                                           │
  │     payload = T1 当前完整状态                            │
  │            = { title: "买牛奶", tags: ["购物","紧急"] }  │
  │     （注意：标题是"买牛奶"不是"买有机牛奶"——             │
  │      因为手机改的标题还没被电脑看到！）                    │
  │                                                         │
  │   应用:                                                 │
  │     ⏱️ markRejected(B5, A6) → IndexedDB                 │
  │     ✅ applyAll(OP_NEW) → NgRx Store + IndexedDB         │
  │     🕐 localClock = {A:6, B:6}                          │
  │                                                         │
  │ → localWinOpsCreated = 1                                │
  └────────────────────────────────────────────────────────┘

  ┌─ 电脑 阶段2: 上传本地操作 ─────────────────────────────┐
  │ ⏱️ IndexedDB 查 unsynced → [OP_NEW]                     │
  │   下载远端 sync-data.json (syncVersion=6, rev=ETag6)    │
  │   构建新 sync-data.json:                                │
  │     syncVersion: 7                                      │
  │     vectorClock: merge({A:6,B:4}, {A:6,B:6}) = {A:6,B:6}│
  │     recentOps: [A6, OP_NEW]                             │
  │     state: T1={ title:"买牛奶", tags:["购物","紧急"] }   │
  │   PUT → 200 OK                                          │
  │   ⏱️ OP_NEW 标记为 synced=true                          │
  └────────────────────────────────────────────────────────┘

  ┌─ 电脑 阶段3: LWW 重上传检查 ───────────────────────────┐
  │ localWinOpsCreated = 0（上传过程中没有新的冲突）          │
  │ → 不需要重上传                                          │
  │ → setSyncStatus('IN_SYNC') ✅                            │
  └────────────────────────────────────────────────────────┘

  结果：远端 sync-data.json:
    syncVersion: 7, vectorClock: {A:6, B:6}
    recentOps: [A6, OP_NEW(sv=7, clock={A:6,B:6})]

  ═════════════════════════════════════════════════════════════
  第 3 步：手机再次同步
  ═════════════════════════════════════════════════════════════

  手机 SyncTriggerService 触发 → SyncWrapperService._sync()

  ┌─ 手机 阶段1: 下载 ─────────────────────────────────────┐
  │ 从 OneDrive 下载 sync-data.json (syncVersion=7)         │
  │ recentOps = [A6, OP_NEW(sv=7, clock={A:6,B:6})]         │
  │                                                         │
  │ 注意：A6 是手机自己上传的，excludeClient="A" → 跳过     │
  │ → ops = [OP_NEW]                                        │
  └────────────────────────────────────────────────────────┘

  ┌─ 手机 阶段1续: 处理 OP_NEW ────────────────────────────┐
  │ processRemoteOps Step 4: 冲突检测                       │
  │   ⏱️ getEntityFrontier("TASK", "T1"):                   │
  │     手机对 T1 没有待同步操作 → frontier = {A:6, B:4}    │
  │                                                         │
  │   🕐 compareVectorClocks({A:6,B:4}, {A:6,B:6})          │
  │     key A: 6=6                                          │
  │     key B: 4<6 → bGreaterInSome only                    │
  │     → LESS_THAN                                         │
  │                                                         │
  │ → nonConflictingOps = [OP_NEW]  ← 直接应用！            │
  │                                                         │
  │ 应用 OP_NEW 到 NgRx Store:                              │
  │   T1 更新为 { title: "买牛奶", tags: ["购物","紧急"] }   │
  │   🕐 localClock = merge({A:6,B:4}, {A:6,B:6}) = {A:6,B:6}│
  │   ⏱️ OP_NEW 写入 IndexedDB (synced=true)                │
  └────────────────────────────────────────────────────────┘

  ┌─ 手机 阶段2: 上传 ─────────────────────────────────────┐
  │ ⏱️ 没有 unsynced 操作 → 跳过                            │
  └────────────────────────────────────────────────────────┘

  最终结果：✅
    手机和电脑的 T1 都是 { title: "买牛奶", tags: ["购物","紧急"] }
    时钟都是 {A:6, B:6}
    但注意：手机的标题修改"买有机牛奶"丢失了！
          因为电脑的时间戳（1005）> 手机的时间戳（1000）

  如果你想要保留手机改的标题 → 在 UI 上看到冲突后再手动合并。
  LWW 自动解决是一种"最小惊讶"的默认策略，不是完美的。
```

---

### 5.8 故障处理：什么会失败，数据会不会丢？

**白话：** 这是用户最常问的问题。按照故障点逐一分析。

#### 5.8.1 LWW 重上传失败（3 次都失败了）

```
场景：本地赢了 LWW，创建了 OP_NEW，但上传了 3 次都没成功。

可能原因：
  A. ETag 持续冲突 → 另一个设备一直在上传（极端并发竞争）
  B. 网络持续不通 → 路由器挂了、OneDrive 宕机
  C. Payload 过大 → OneDrive 拒收（413，极少见）

数据安全：
  ✅ 数据不会丢。
  OP_NEW 在 IndexedDB 里，状态是 synced=false。
  SyncWrapperService 把 syncStatus 设为 'UNKNOWN_OR_CHANGED'。
  用户看到的不是绿色对勾，而是警告图标。
  下一次任何触发源（鼠标移动、定时器、网络恢复……）都会重新触发同步，
  SyncWrapperService._sync() 会重新尝试上传。

实际上传次数可能 > 3：
  while 循环只限制连续重试次数。一旦退出循环并 setSyncStatus('UNKNOWN_OR_CHANGED')，
  下一个同步周期重新进入 _sync() → lwwRetries 重置为 0 → 又可以重试 3 次。
  所以总重试次数 = n × 3（n = 同步周期数），直到成功。
```

#### 5.8.2 崩溃安全：markRejected 在 applyAll 之前

```
为什么 markRejected 必须在 applyAll 之前？

时间线 A（正确顺序）：
  1. ⏱️ markRejected(B5, A6) → 写入 IndexedDB（rejected=true）
  2. ✅ applyAll(OP_NEW) → 写入 NgRx Store + IndexedDB
     → 如果这里崩溃了 ↓
  3. 重启后：B5 已经是 rejected=true → 不会被上传
     OP_NEW 已经在 IndexedDB 且 synced=false → 会被上传 ✓

时间线 B（如果反过来）：
  1. ✅ applyAll(OP_NEW) → 写入 NgRx Store + IndexedDB
     → 如果这里崩溃了 ↓
  2. 还没执行 markRejected(B5, A6)
  3. 重启后：B5 在 IndexedDB 里 synced=false 且 rejected=false
     → 会被重新上传！→ 重复冲突！

原则：先把"旧操作"标记为废弃，再写"新操作"。如果中途崩溃，
重启后旧操作不会复活，新操作会重试上传。
```

#### 5.8.3 并发上传冲突（ETag 412）

```
场景：电脑和手机几乎同时上传 sync-data.json

A 先上传（ETag=v1, If-Match: "v1"）→ 200 OK，远端 ETag → v2
B 后上传（ETag=v1, If-Match: "v1"）→ 412 Precondition Failed

B 的处理：
  1. _uploadWithMismatchFallback 捕获 UploadRevToMatchMismatchAPIError
  2. 重新下载 sync-data.json（现在包含 A 的修改）
  3. 比较 ETag：v2 ≠ v1 → 真正的并发上传
  4. 抛出 ConcurrentUploadError → 本次上传失败

  但这不导致数据丢失：
  5. 下次同步周期 → downloadRemoteOps() 拿到 A 的操作
     → processRemoteOps() 应用到本地
     → uploadPendingOps() 把 B 的操作合并后重新上传

  乐观锁保证了"两个并发上传不会互相覆盖"——总会有一个失败并重试。
```

#### 5.8.4 所有故障汇总

| 故障场景               | 数据丢失？ | 恢复机制                              | 用户可见               |
| ---------------------- | ---------- | ------------------------------------- | ---------------------- |
| LWW 重上传 3 次失败    | 否         | 操作留在 IndexedDB，下次同步重试      | 警告状态图标           |
| 崩溃在 markRejected 后 | 否         | 重启后 rejected 标记仍有效            | 无（自动恢复）         |
| 崩溃在 applyAll 中     | 否         | 重启后旧操作已 rejected，新操作可重传 | 无（自动恢复）         |
| ETag 并发冲突          | 否         | 下次同步周期合并                      | 无（自动恢复）         |
| 网络断开               | 否         | 操作留在 IndexedDB，网络恢复后重试    | 同步状态变灰/离线      |
| Token 过期             | 否         | 刷新 token 后重试（单飞锁防并发刷新） | 无（自动恢复）         |
| OneDrive 限流 (429)    | 否         | Retry-After 等待后重试                | 可能稍慢               |
| sync-data.json 过大    | 否         | 下次同步重试（压缩后通常 < 限制）     | 可能持续失败           |
| 本地 IndexedDB 损坏    | 部分       | 从远端重新下载完整状态                | 本地未同步数据可能丢失 |

**核心保证：只要操作还在 IndexedDB 里且 synced=false，同步系统就不会放弃它。**

---

### 5.9 关键数据结构流转图

```
                         ┌──────────────┐
                         │  NgRx Store  │  ← 应用状态（tasks, projects, tags...）
                         └──────┬───────┘
                                │ getStateSnapshot() → 用于构建 sync-data.json 的 state 字段
                                ▼
    ┌───────────────────────────────────────────────────────────────┐
    │              FileBasedSyncAdapterService                      │
    │                                                               │
    │  _downloadOps():                                              │
    │    downloadFile → 解密 → 返回 ops[] + snapshotState           │
    │                        🕐 返回 vectorClock                     │
    │                        🔒 返回 syncVersion (作为 latestSeq)     │
    │                                                               │
    │  _uploadOps():                                                │
    │    getState + mergeOps + mergeClocks → uploadFile             │
    │    ⏱️ 读 NgRx snapshot      🕐 merge vector clocks            │
    │    ⏱️ 读 IndexedDB archives 🔒 syncVersion++                  │
    │    ⏱️ 构建 recentOps                                         │
    └───────────────────────────────────────────────────────────────┘
                                │
                                ▼
    ┌───────────────────────────────────────────────────────────────┐
    │              OperationLogSyncService                          │
    │                                                               │
    │  downloadRemoteOps():                                         │
    │    ⏱️ isFresh? → 检查 IndexedDB 是否有历史                    │
    │    🕐 compareVectorClocks(local, remote) → skip if dominated  │
    │    ⏱️ getUnsynced() → 是否有本地修改需要保护                   │
    │    → 调用 processRemoteOps()                                  │
    │                                                               │
    │  uploadPendingOps():                                          │
    │    ⏱️ flushPendingWrites() → 确保操作已写入 IndexedDB         │
    │    ⏱️ isFresh? → 阻止空客户端上传                             │
    │    ⏱️ getUnsynced() → 获取待上传操作                          │
    └───────────────────────────────────────────────────────────────┘
                                │
                                ▼
    ┌───────────────────────────────────────────────────────────────┐
    │              RemoteOpsProcessingService                       │
    │                                                               │
    │  Step 4: 冲突检测                                             │
    │    ⏱️ getEntityFrontier() → 从 IndexedDB 读取实体最后操作      │
    │    🕐 compareVectorClocks(frontier, remoteClock)               │
    │       → GREATER_THAN / EQUAL / LESS_THAN / CONCURRENT         │
    │                                                               │
    │  Step 5: LWW 解决 (→ ConflictResolutionService)               │
    │    🕐 mergeVectorClocks(allConflictClocks) + increment         │
    │    ⏱️ markRejected(过时 ops) → 写入 IndexedDB                 │
    │    ⏱️ createLWWUpdateOp() → 新操作写入 IndexedDB (unsynced)    │
    └───────────────────────────────────────────────────────────────┘
```

**关键数据结构速查：**

| 数据结构               | 存储位置               | 作用                 | 何时读写                             |
| ---------------------- | ---------------------- | -------------------- | ------------------------------------ |
| `Operation`            | IndexedDB `SUP_OPS`    | 不可变操作记录       | 操作捕获时写；冲突检测/上传时读      |
| `VectorClock`          | Operation 内嵌字段     | 追踪因果顺序         | 🕐 创建操作时递增；比较时 merge      |
| `FileBasedSyncData`    | sync-data.json (远端)  | 文件同步载体         | 下载时解密读取；上传时构建写入       |
| `syncVersion`          | FileBasedSyncData 字段 | 乐观锁计数器         | 🔒 上传前校验；上传后 +1             |
| `recentOps`            | FileBasedSyncData 字段 | 最近 500 条操作      | 冲突检测的实体级比较                 |
| NgRx Store             | 内存                   | 当前应用状态         | LWW 本地赢时读取实体状态；水合时写入 |
| `expectedSyncVersions` | localStorage Map       | 记录预期 syncVersion | 断电重启后恢复乐观锁状态             |

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

## 11. OneDrive PR Review 验证的并发模式

> 2026 年 5 月 OneDrive PR (#7523) 经历了 7 轮 PR conversation comment + 2 轮正式 review。以下是在 review 中被验证或纠正的并发控制模式。完整记录（共 39 个问题）见 [review 经验教训总结](./review-lessons-learned.md)。

### 11.1 Review 验证通过的设计

以下模式在初始实现中就是正确的，reviewer 确认了设计：

**Token 单飞锁**: `_isRefreshingToken` 标志 + while 轮询（50ms 间隔）+ `finally` 保证重置。防止两个并发的 API 调用同时刷新 token。

**双层乐观锁**: syncVersion（内容层）+ ETag（传输层）互补 —— syncVersion 跨 provider 统一，ETag 提供即时 HTTP 412 检测。

**syncVersion 递增的原子性**: `_buildMergedSyncData()` 每次合并都递增 syncVersion，保证版本号单调递增。

### 11.2 Review 发现并修正的问题

**`conflictBehavior=fail` 首次上传保护** (R3):

这是 reviewer 发现的最关键的并发漏洞。双设备同时初始化同步时，两者的第一次上传都 rev 为空。原实现使用 `conflictBehavior=replace`，导致第二个上传静默覆盖第一个。修复为 `conflictBehavior=fail`，让第二个上传感知到"文件已存在"并重试。

详见 [review 经验教训：问题 #9](./review-lessons-learned.md#问题-9-首次创建上传需-conflictbehaviorfail)。

**`?? false` + NgRx reducer 展开交互** (R4):

`updateSettingsFromForm` 中用 `?? false` 处理可选布尔值，导致每次保存都覆盖已有的 `true`。根因是 NgRx reducer 的 `{...oldSection, ...normalizedCfg}` —— key 存在就覆盖，不管值是不是 `undefined`。修复为条件展开：`...(val !== undefined ? { key: val } : {})`。

这是整个 PR 讨论最多的问题，演化过程：原始解构 → 显式字面量 → `?? false`（第 6 轮，更危险）→ 条件展开（第 9 轮最终方案）。

详见 [review 经验教训：问题 #4](./review-lessons-learned.md#问题-4--false-对可选布尔值的破坏)。

**凭证身份三元组检测** (R3 + R7):

OAuth token 绑定到 `(useCustomApp, clientId, tenantId)` 三元组。切换 Azure AD 应用身份时必须原子性清除旧 token。只比较一个字段不够——用户可能从官方应用切换到自建应用。

详见 [review 经验教训：问题 #6](./review-lessons-learned.md#问题-6-切换-azure-ad-应用身份时旧-token-未清除)。

**Refresh-token 端点错误不清除凭证** (Review #1):

`_requestOAuthToken` 在 `400 invalid_grant` 时抛通用 `HttpNotOkAPIError`，坏掉的 refresh_token 永远不清除，导致无限循环失败。Reviewer 标注为 Critical。修复后检测 token 端点的 `400/401` + `error: "invalid_grant"` 并调用 `clearAuthCredentials()`。

详见 [review 经验教训：问题 #11](./review-lessons-learned.md#问题-11-refresh-token-端点错误不清除凭证)。

**clearAuthCredentials() 与 in-flight refresh 竞态** (Review #1 + #2):

`_refreshAccessTokenIfNeeded` 闭包捕获 `cfg`，成功后用捕获的旧 cfg 调用 `setComplete`，可能覆盖并发的 `clearAuthCredentials()` 结果。Reviewer 在第二轮进一步指出修复后的注释过度承诺。风险低但实际存在微任务级 TOCTOU 窗口。

详见 [review 经验教训：问题 #12](./review-lessons-learned.md#问题-12-clearauthcredentials-与-in-flight-refresh-竞态)。

**文件夹缓存未随 syncFolderPath 变化失效** (Review #1):

`_ensuredFolderPath` 只在 404 时置空，用户修改路径后缓存仍指向旧路径。详见 [review 经验教训：问题 #19](./review-lessons-learned.md#问题-19-文件夹缓存未随-syncfolderpath-变化失效)。

**文件夹存在性探测吞掉非 404 失败** (C6):

Folder probe 的 catch 捕获了所有失败（429、5xx、认证错误）并回退到创建逻辑。只应对 404 回退，其他错误原样抛出。详见 [review 经验教训：问题 #38](./review-lessons-learned.md#问题-38-文件夹存在性探测吞掉非-404-失败)。

**`_is401Retry` 实例布尔值与并发请求竞态** (C1):

`maxConcurrentRequests=4` 与实例级 `_is401Retry` 标志竞态——请求 A 在重试中，请求 B 看到标志为 true 就被踢出登录。修复为 per-call `isRetry` 参数。详见 [review 经验教训：问题 #21](./review-lessons-learned.md#问题-21-_is401retry-实例布尔值与-maxconcurrentrequests4-竞态)。

**`_ensureSyncFolderExists` 对文件夹 POST 使用 `conflictBehavior: replace`** (C1):

如果父级有同名文件，Graph 会用文件夹替换它（数据丢失）。修复为 `'fail'` 并保留 409 swallow。详见 [review 经验教训：问题 #24](./review-lessons-learned.md#问题-24-_ensuresyncfolderexists-对文件夹-post-使用-conflictbehavior-replace)。

**`_requestOAuthToken` 吞掉自己刚抛出的 `MissingRefreshTokenAPIError`** (C1 + C2):

`throw` 和 `JSON.parse` 在同一个 `try` 块内，catch 吞掉了正确类型的错误，调用方看到泛型 `HttpNotOkAPIError`。修复为只把 `JSON.parse` 放进 try。详见 [review 经验教训：问题 #22](./review-lessons-learned.md#问题-22-_requestoauthtoken-吞掉了自己刚抛出的-missingrefreshtokenapierror)。

### 11.3 对现有并发模型的影响

好消息是 OneDrive 的并发模式完全是共享层（FileBasedSyncAdapterService）的，不引入新的并发原语。所有并发保护：

- 上传冲突重试（`_uploadWithMismatchFallback`）
- LWW 重上传循环（最多 3 次）
- syncVersion 乐观锁比较
- 同步周期锁（`_isSyncing`）

这些对所有 file-based provider（Dropbox、WebDAV、Nextcloud、LocalFile、OneDrive）统一生效，不需要 per-provider 实现。

| 特性     | Dropbox    | OneDrive      | WebDAV     | LocalFile   | Nextcloud  |
| -------- | ---------- | ------------- | ---------- | ----------- | ---------- |
| 认证方式 | OAuth      | OAuth PKCE    | 用户名密码 | 无          | 用户名密码 |
| 存储位置 | App folder | App folder    | 自定义路径 | 本地文件    | 自定义路径 |
| 乐观锁   | rev (ETag) | ETag          | ETag       | syncVersion | ETag       |
| 冲突解决 | 共享层 LWW | 共享层 LWW    | 共享层 LWW | 共享层 LWW  | 共享层 LWW |
| 操作同步 | 共享适配器 | 共享适配器    | 共享适配器 | 共享适配器  | 共享适配器 |
| 首次上传 | -          | conflict=fail | -          | -           | -          |

**所有文件类 Provider 的同步逻辑完全相同，区别只在认证和文件传输。**
