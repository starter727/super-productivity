# 操作日志架构

**分支：** `feat/operation-logs`
**分支：** \eat/operation-logs**最后更新：** 2026 年 1 月 8 日

> **注意：** 截至 2026 年 1 月，旧版 PFAPI 系统已完全淘汰。
> 所有同步提供者（SuperSync、WebDAV、Dropbox、LocalFile）现在都使用统一的操作日志系统。

---

## 引言：核心架构

### 核心理念：事件溯源（Event Sourcing）

操作日志从根本上改变了应用对待数据的方式。我们不再把数据库当作一个“桶”来覆盖数据（例如“任务标题现在是 X”），而是将其视为一个**事件时间线**（例如“10:00 AM 时，用户将任务标题改为 X”）。

- **真相源（Source of Truth）：** *日志*就是真相。应用的“当前状态”（你在屏幕上看到的）只是从头重放日志计算出来的结果。
- **不可变性（Immutability）：** 一旦操作被写入，它就永远不会被更改。我们只追加新操作。如果你“删除”一个任务，我们不会删除这一行；而是追加一个 \DELETE\ 操作。

### 1. 数据如何保存（写路径）

当用户执行一个操作（如勾选复选框）时：

1.  **捕获（Capture）：** 系统拦截 Redux 动作（例如 \TaskUpdate\）。
2.  **包装（Wrap）：** 将此动作包装成标准化的 \Operation\ 对象。该对象包含：
    - **载荷（Payload）：** 变更的内容（例如 \{ isDone: true }\）。
    - **ID 和时间戳：** 一个唯一 ID（UUID v7）和发生时间。
    - **向量时钟（Vector Clock）：** 用于追踪因果关系的版本计数器（例如“此变更发生在版本 5 _之后_”）。
3.  **持久化（Persist）：** 此 \Operation\ 立即追加到 IndexedDB 的 \SUP_OPS\ 表中。这非常快，因为我们只是添加一个小 JSON 对象，而不是重写一个大文件。
4.  **广播（Broadcast）：** 该操作被广播到其他打开的标签页，使它们立即更新。

### 2. 数据如何加载（读路径）

从开头重放*每一个*操作会太慢。我们使用**快照（Snapshot）**来加速：

1.  **加载快照：** 启动时，应用加载最近的“保存点”（例如昨天保存的应用状态完整副本）。
2.  **重放尾部：** 然后应用查询日志：“给我所有发生在此快照*之后*的操作。”
3.  **快进：** 将这几个“尾部”操作应用到快照上——至此应用完全更新。
4.  **水合优化（Hydration Optimization）：** 如果刚刚发生了同步，我们可以直接加载新状态，完全跳过重放。

### 3. 同步如何工作

操作日志支持两种同步方式：

**A. 真正的“服务器同步”（现代方式）**
高效且精确。

- **交换：** 设备之间交换单个 \Operation\，而不是完整文件。这节省了大量带宽。
- **冲突检测：** 因为每个操作都有一个**向量时钟（Vector Clock）**，我们可以从数学上证明两个变更是否同时发生。
  - _示例：_ 设备 A 发送“更新标题（版本 1 -> 2）”。设备 B 看到自己有“版本 1”，于是安全地应用该更新。
  - _冲突：_ 如果设备 B *也*做了一个变更，且处于“版本 2”，它会知道“等等，我们俩同时改变了版本 1！” -> **检测到冲突**。
- **解决：** 向用户展示对话框来选择胜出者。败方不会被删除；它会被标记为日志中的“已拒绝（Rejected）”，但保留历史记录。

**B. “基于文件的同步”（Dropbox、WebDAV、本地文件）**
使用带有嵌入操作的单个文件方法。

- 基于文件的提供者同步单个 \sync-data.json\ 文件，包含：完整状态快照 + 最近操作缓冲区
- 同步时，系统下载远程文件，合并任何新操作，然后上传合并后的状态
- 冲突检测使用向量时钟——如果两个客户端并发同步，“捎带（piggybacking）”机制确保不会丢失任何操作
- 这提供了实体级别的冲突解决（对比旧版模型级别的“最后写入者胜出”）

### 4. 安全与自愈（Safety & Self-Healing）

系统假设数据损坏是不可避免的（断电、同步错误、宇宙射线），并建立防御措施：

- **验证检查点：** 在*写入*磁盘前、从磁盘*加载*后以及*接收*同步数据后都会检查数据。
- **自动修复：** 如果状态无效（例如子任务指向不存在的父任务），应用不会崩溃。它会运行自动修复脚本（例如分离子任务）并生成一个特殊的 **\REPAIR\ 操作**。
- **审计追踪：** 此 \REPAIR\ 操作被保存到日志中。这意味着你可以回溯，精确看到系统在*何时*以及*为何*自动修改了你的数据。

### 5. 维护（压缩 Compaction）

如果保留每个操作永久不变，数据库会变得巨大。

- **压缩：** 每约 500 个操作，系统会生成一个新的当前状态快照。
- **清理：** 然后查找已经“烘焙”到该快照中并已成功同步到服务器的旧操作。安全删除它们以释放空间，保持日志精简。

---

## 总览

操作日志服务**四个不同的目的**：

| 目的                  | 描述                                  | 状态                 |
| --------------------- | ------------------------------------- | -------------------- |
| **A. 本地持久化**     | 快速写入、崩溃恢复、事件溯源          | 已完成 ✅            |
| **B. 基于文件的同步** | WebDAV/Dropbox/LocalFile 的单文件同步 | 已完成 ✅            |
| **C. 服务器同步**     | 上传/下载单个操作（SuperSync）        | 已完成 ✅（单版本）¹ |
| **D. 验证与修复**     | 防止损坏、自动修复无效状态            | 已完成 ✅            |

> ¹ **跨版本同步限制：** Part C 对于相同 schema 版本的客户端已完成。跨版本同步（A.7.11）尚未实现——参见 A.7.11 冲突感知迁移策略了解防护措施。

> **✅ 迁移就绪：** 迁移安全性（A.7.12）、尾部操作一致性（A.7.13）和统一迁移接口（A.7.15）现已实现。当 \CURRENT_SCHEMA_VERSION > 1\ 时，系统已准备好进行 schema 迁移。

本文档围绕这四个目的组织。大部分复杂性在 **Part A**（本地持久化）中。**Part B** 处理通过 \FileBasedSyncAdapter\ 的基于文件的同步。**Part C** 处理通过 SuperSync 服务器的基于操作的同步。**Part D** 集成了验证和自动修复。

\┌───────────────────────────────────────────────────────────────┐
│ 用户操作 │
└───────────────────────────────────────────────────────────────┘
│
│
▼
┌─────────────┐
│ NgRx Store │ （运行时真相源）
│ (1) 立即写入 │
└──────┬───────┘
│
│
┌───────┬───────┐
│ 快照缓存 │ （内存中——重启后重建）
└───────┬───────┘
│ (2) 持久化
│
┌──────┬────────┐
│ SUP_OPS │ （IndexedDB —— 不可变操作日志）
│ (ps.COMDB) │
└──────┬────────┘
│ (3) 同步
┌────┬────────────────────────┐
│ 同步提供者 │
│ ├── SuperSync（基于操作）│
│ └── WebDAV/Dropbox/Local│
│ （基于文件） │
└──────────────────────────┘
\

---

## 为什么选择此架构：被拒绝的备选方案

在设计操作日志系统时，我们评估了几种替代方法，并因以下原因拒绝了它们：

| 备选方案                       | 拒绝原因                                                                                                              |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------- |
| **增量状态转储**               | 逐文件同步，仅将增量更改写入同步文件。在长时间离线后，可能没有足够的增量来安全应用；相反，快照 + 尾部操作模式更可靠。 |
| **仅快照**                     | 丢弃操作历史；只有完整状态快照。同步变成最后写入者胜出。无法进行冲突检测。                                            |
| **基于 git 的同步**            | 每几秒提交至 git 仓库。对于频繁变更来说太慢且过于重量级。二进制 blob 压缩效果差。                                     |
| **CRDT（无冲突复制数据类型）** | 学术上很优雅，但会增加显著的复杂性。向量时钟 + LWW（最后写入者胜出）达到 99% 的相同效果，且实现更简单。               |

拒绝的备选方案的完整列表和详细理由在 [rejected-alternatives.md](./rejected-alternatives.md) 中（仓库历史记录）。

---

## Part A：本地持久化

操作日志主要充当本地持久化的**预写日志（Write-Ahead Log, WAL）**。它提供：

1. **快速写入** - 小型操作瞬间完成，无需每次变更都序列化 5MB 数据
2. **崩溃恢复** - 从日志重放未提交的操作
3. **事件溯源（Event Sourcing）** - 用户操作的完整历史记录，用于调试/撤销

## A.1 数据库架构

### SUP_OPS 数据库

` ypescript
// ops 表 - 事件日志
interface OperationLogEntry {
seq: number; // 自增主键
op: Operation; // 操作
appliedAt: number; // 本地应用时间
source: 'local' | 'remote';
syncedAt?: number; // 用于服务器同步（Part C）
rejectedAt?: number; // 冲突解决时被拒绝的时间
}

// state_cache 表 - 定期快照
interface StateCache {
state: AllSyncModels; // 完整快照
lastAppliedOpSeq: number;
vectorClock: VectorClock; // 当前合并的向量时钟
compactedAt: number; // 此快照的创建时间
schemaVersion?: number; // 可选，用于向后兼容
}
`

### IndexedDB 结构

\\\
┌─────────────────────────────────────────────────────────────────────┐
│ IndexedDB │
├─────────────────────────────────────────────────────────────────────┤
│ 'SUP_OPS' database（操作日志） │
│ │
│ ┌──────────────────────────────────────────────────────────┐ │
│ │ ops（事件日志） - 仅追加的操作日志 │ │
│ │ state_cache - 定期状态快照 │ │
│ │ meta - 向量时钟、同步状态 │ │
│ │ archive_young - 最近归档的任务 │ │
│ │ archive_old - 旧归档任务 │ │
│ │ client_id - 同步设备标识（v6） │ │
│ └──────────────────────────────────────────────────────────┘ │
│ │
│ 所有模型数据均持久化于此 │
└─────────────────────────────────────────────────────────────────────┘
\\\

**关键洞察：** 所有应用数据都通过操作日志系统持久化在 SUP_OPS 数据库中。

## A.2 写路径

\\\
User Action（用户操作）
│
▼
NgRx Dispatch（派发动作）
│
├──► Reducer 更新状态（乐观更新，内存中）
│
└──► OperationLogEffects
│
├──► 过滤：action.meta.isPersistent === true？
│ └──► 若为 false 或缺失则跳过
│
├──► 过滤：action.meta.isRemote === true？
│ └──► 跳过（防止重新记录同步/重放）
│
├──► 将 action 转换为 Operation
│
├──► 追加到 SUP_OPS.ops（磁盘）
│
├──► 递增 META_MODEL.vectorClock（Part B 桥接）
│
└──► 广播到其他标签页
\\\

### 操作结构（Operation Structure）

\\\ ypescript
interface Operation {
id: string; // UUID v7（按时间排序）
actionType: string; // NgRx 动作类型
opType: OpType; // CRT | UPD | DEL | MOV | BATCH
entityType: EntityType; // TASK | PROJECT | TAG | NOTE | ...
entityId?: string; // 受影响的实体 ID
entityIds?: string[]; // 用于批量操作
payload: unknown; // 动作载荷
clientId: string; // 设备 ID
vectorClock: VectorClock; // 每操作的因果关系（用于 Part C）
timestamp: number; // 挂钟时间（epoch ms）
schemaVersion: number; // 用于迁移
}

type OpType =
| 'CRT' // 创建（Create）
| 'UPD' // 更新（Update）
| 'DEL' // 删除（Delete）
| 'MOV' // 移动（Move，列表重排序）
| 'BATCH' // 批量操作（导入、批量更新）
| 'SYNC_IMPORT' // 从远程同步导入完整状态
| 'BACKUP_IMPORT' // 从备份文件导入完整状态
| 'REPAIR'; // 自动修复操作，包含完整的修复后状态

type EntityType =
| 'TASK'
| 'PROJECT'
| 'TAG'
| 'NOTE'
| 'GLOBAL_CONFIG'
| 'SIMPLE_COUNTER'
| 'WORK_CONTEXT'
| 'TASK_REPEAT_CFG'
| 'ISSUE_PROVIDER'
| 'PLANNER'
| 'MENU_TREE'
| 'METRIC'
| 'BOARD'
| 'REMINDER'
| 'PLUGIN_USER_DATA'
| 'PLUGIN_METADATA'
| 'MIGRATION'
| 'RECOVERY'
| 'ALL';
\\\

### 持久化动作模式（Persistent Action Pattern）

动作基于显式的 meta.isPersistent: true 进行持久化：

\\\ ypescript
// persistent-action.interface.ts
export interface PersistentActionMeta {
isPersistent?: boolean; // 为 true 时，动作将被持久化
entityType: EntityType;
entityId?: string;
entityIds?: string[]; // 用于批量操作
opType: OpType;
isRemote?: boolean; // 如果来自同步则为 TRUE（防止重新记录）
isBulk?: boolean; // 批量操作为 TRUE
}

// 类型守卫 - 仅持久化具有显式 isPersistent: true 的动作
export const isPersistentAction = (action: Action): action is PersistentAction => {
const a = action as PersistentAction;
return !!a.meta && a.meta.isPersistent === true;
};
\\\

**不应持久化的动作：**

- 仅 UI 动作（selectedTaskId、currentTaskId、切换侧边栏等）
- 加载/水合动作（数据已在日志中）
- Upsert 动作（通常来自同步/导入）
- 内部清理动作

## A.3 读路径（水合 Hydration）

\\\
App Startup（应用启动）
│
▼
OperationLogHydratorService
│
├──► 从 SUP_OPS.state_cache 加载快照
│ │
│ └──► 若无快照：从 'pf' 执行创世迁移（Genesis Migration）
│
├──► 必要时运行 schema 迁移
│
├──► 派发 loadAllData(snapshot, { isHydration: true })
│
└──► 加载尾部操作（seq > snapshot.lastAppliedOpSeq）
│
├──► 如果最后一个 op 是 SyncImport：直接加载（跳过重放）
│
├──► 否则：重放操作（通过 isRemote 标志防止重新记录）
│
└──► 如果重放了超过 10 个操作：保存新快照以加速未来加载
\\\

### 水合优化（Hydration Optimizations）

两项优化加速了水合过程：

1. **跳过 SyncImport 的重放**：当日志中最后一个操作是 SyncImport（完整状态导入）时，水合器直接加载它，而不是重放所有前面的操作。这在导入或同步后显著加快初始加载速度。

2. **重放后保存快照**：在重放超过 10 个尾部操作后，会保存一个新的状态缓存快照。这避免了在后续启动时重放相同的操作。

### 创世迁移（Genesis Migration）

首次启动时（SUP_OPS 为空），系统使用默认状态初始化：

` ypescript
async createGenesisSnapshot(): Promise<void> {
// 使用默认状态初始化，或从旧版迁移（如存在）
const initialState = await this.getInitialState();

// 创建初始快照
await this.opLogStore.saveStateCache({
state: initialState,
lastAppliedOpSeq: 0,
vectorClock: {},
compactedAt: Date.now(),
schemaVersion: CURRENT_SCHEMA_VERSION
});
}
`

从旧版格式升级的用户，ServerMigrationService 在首次同步期间处理迁移。

## A.4 压缩（Compaction）

### 目的

如果没有压缩，操作日志会无限增长。压缩的工作：

1. 从当前 NgRx 状态创建新的快照
2. 删除已"烘焙"到快照中的旧操作

### 触发条件

- 每 **500 个操作**
- 同步下载后（安全考虑）
- 应用关闭时（可选）

### 过程

` ypescript
async compact(): Promise<void> {
// 1. 获取锁
await this.lockService.request('sp_op_log_compact', async () => {
// 2. 从 NgRx 读取当前状态（通过委托）
const currentState = await this.storeDelegate.getAllSyncModelDataFromStore();

    // 3. 保存新快照
    const lastSeq = await this.opLogStore.getLastSeq();
    await this.opLogStore.saveStateCache({
      state: currentState,
      lastAppliedOpSeq: lastSeq,
      vectorClock: await this.opLogStore.getCurrentVectorClock(),
      compactedAt: Date.now(),
      schemaVersion: CURRENT_SCHEMA_VERSION
    });

    // 4. 删除旧操作（同步感知）
    // 仅删除已同步且超过保留期的操作
    const retentionWindowMs = 7 * 24 * 60 * 60 * 1000; // 7 天
    const cutoff = Date.now() - retentionWindowMs;

    await this.opLogStore.deleteOpsWhere(
      (entry) =>
        !!entry.syncedAt && // 绝不丢弃未同步的操作
        entry.appliedAt < cutoff &&
        entry.seq <= lastSeq
    );

});
}
`

### 配置项

| 设置                     | 值      | 描述                         |
| ------------------------ | ------- | ---------------------------- |
| 压缩触发阈值             | 500 ops | 每次快照前的操作数           |
| 保留窗口                 | 7 天    | 保留最近同步的操作           |
| 紧急保留窗口             | 1 天    | 配额超限时使用更短的保留期   |
| 压缩超时                 | 25 秒   | 超时则中止（防止锁过期）     |
| 最大压缩失败次数         | 3       | 失败超过此次数后通知用户     |
| 未同步操作               | ∞       | 永不删除未同步的操作         |
| 内存中最大下载操作数     | 50,000  | 限制 API 下载期间的内存占用  |
| 远程文件保留天数         | 14 天   | 服务端操作文件保留时间       |
| 最大保留远程文件数       | 100     | 服务器上保留的最小最近文件数 |
| 最大冲突重试次数         | 5       | 拒绝失败操作前的重试次数     |
| 拒绝操作警告阈值         | 10      | 触发用户通知的阈值           |
| 锁超时                   | 30 秒   | localStorage 回退锁超时      |
| 锁获取超时               | 60 秒   | 获取锁的最大等待时间         |
| 最大下载重试次数         | 3       | 文件下载失败的重试次数       |
| 快照最大操作数（服务端） | 100,000 | 服务端快照生成的内存保护阈值 |

## A.5 多标签页协调

### 写入锁定

` ypescript
// 首选：Web Locks API
await navigator.locks.request('sp_op_log_write', async () => {
await this.writeOperation(op);
});

// 回退：localStorage 互斥锁（适用于旧版 WebViews）
`

### 状态广播

当一个标签页写入操作时：

1. 写入 SUP_OPS
2. 通过 BroadcastChannel 广播
3. 其他标签页接收并应用（使用 isRemote=true 防止重新记录）

` ypescript
// Tab A 写入
this.broadcastChannel.postMessage({ type: 'NEW_OP', op });

// Tab B 接收
this.broadcastChannel.onmessage = (event) => {
if (event.data.type === 'NEW_OP') {
const action = convertOpToAction(event.data.op); // 设置 isRemote: true
this.store.dispatch(action);
}
};
`

## A.6 Effects 的 LOCAL_ACTIONS 令牌

### 问题

当从远程客户端（其他标签页或设备）同步操作时，它们会以 meta.isRemote: true 派发到 NgRx。执行副作用（snackbar、工作日志、通知、插件钩子）的 Effects **不应**针对这些远程操作运行，因为：

1. **重复的副作用** - 该副作用已在原始客户端上发生过
2. **无效的状态访问** - 动作引用的任务/实体可能尚不存在（乱序交付）
3. **用户困惑** - 针对数小时前在其他设备上完成的操作显示"任务已完成！"提示

### 解决方案：LOCAL_ACTIONS 注入令牌

LOCAL_ACTIONS 注入令牌提供了预先过滤的 Actions 流，排除了远程操作：

` ypescript
// src/app/util/local-actions.token.ts
import { inject, InjectionToken } from '@angular/core';
import { Actions } from '@ngrx/effects';
import { Action } from '@ngrx/store';
import { Observable } from 'rxjs';
import { filter } from 'rxjs/operators';

export const LOCAL_ACTIONS = new InjectionToken<Observable<Action>>('LOCAL_ACTIONS', {
providedIn: 'root',
factory: () => {
const actions$ = inject(Actions);
return actions$.pipe(filter((action: Action) => !(action as any).meta?.isRemote));
},
});
`

### 在 Effects 中使用

对于**不应**针对远程操作运行的 effects，使用 LOCAL_ACTIONS 替代 Actions：

` ypescript
@Injectable()
export class MyEffects {
private \_actions$ = inject(LOCAL_ACTIONS); // 仅本地动作（排除 isRemote）

// ✅ 对副作用使用 LOCAL_ACTIONS
showSnack$ = createEffect(
() =>
this.\_localActions$.pipe(
ofType(TaskSharedActions.updateTask),
filter((action) => action.task.changes.isDone === true),
tap(() => this.snackService.open({ msg: 'Task completed!' })),
),
{ dispatch: false },
);

// ✅ 对应全局应用的状态更新使用常规 actions$
  moveTaskToList$ = createEffect(() =>
this.\_actions$.pipe(
ofType(moveTaskInTodayList),
// 该 effect 派发另一个动作 - 应对所有来源都生效
map(({ taskId }) => TaskSharedActions.updateTask({ ... })),
),
);
}
`

### 何时使用 LOCAL_ACTIONS

| 场景                             | 使用 LOCAL_ACTIONS？ | 原因                               |
| -------------------------------- | -------------------- | ---------------------------------- |
| 显示 snackbar/toast              | ✅ 是                | UI 通知已在原始客户端发生过        |
| 向 Jira/OpenProject 提交工作日志 | ✅ 是                | 外部 API 调用已执行过              |
| 播放音效                         | ✅ 是                | 音频反馈仅本地                     |
| 更新 Electron 任务栏             | ✅ 是                | 桌面 UI 仅本地                     |
| 派发插件钩子                     | ✅ 是                | 插件已在原始客户端运行过           |
| 更新 store 中的其他实体          | ❌ 否                | 状态变更应全局生效                 |
| 导航/路由变更                    | ✅ 是                | 导航仅本地                         |
| 派发级联动作                     | ⚠️ 视情况而定        | 如果修改状态：否。如果仅副作用：是 |

---

## A.7 灾难恢复

### SUP_OPS 损坏

`

1. 检测：水合失败或返回空/无效状态
2. 检查旧版 'pf' 数据库中是否有数据
3. 如果有数据：使用该数据运行恢复迁移
4. 如果没有：检查远程同步是否有数据
5. 如果远程有数据：强制同步下载
6. 如果所有方法都失败：用户必须从备份恢复
   `

### 实现

` ypescript
async hydrateStore(): Promise<void> {
try {
const snapshot = await this.opLogStore.loadStateCache();
if (!snapshot || !this.isValidSnapshot(snapshot)) {
await this.attemptRecovery();
return;
}
// 正常水合...
} catch (e) {
await this.attemptRecovery();
}
}

private async attemptRecovery(): Promise<void> {
// 1. 尝试从 state_cache 备份恢复
const backupState = await this.tryLoadBackupSnapshot();
if (backupState) {
await this.recoverFromBackup(backupState);
return;
}
// 2. 尝试远程同步（必要时触发 ServerMigrationService）
// 3. 向用户显示错误
}
`

## A.7 Schema 迁移

当 Super Productivity 的数据模型发生变化（新字段、重命名属性、重组实体）时，Schema 迁移确保现有数据在应用更新后仍可正常使用。

> **当前状态：** 迁移基础设施已实现，但尚无实际存在的迁移。MIGRATIONS 数组为空，CURRENT_SCHEMA_VERSION = 1。本节记录了为未来迁移而设计的行为。

### 配置

CURRENT_SCHEMA_VERSION 定义在 src/app/op-log/store/schema-migration.service.ts 中：

`	ypescript
export const CURRENT_SCHEMA_VERSION = 1;
export const MIN_SUPPORTED_SCHEMA_VERSION = 1;
export const MAX_VERSION_SKIP = 5; // 我们愿意尝试加载的最大版本跨越数
`

### 核心概念

| 概念                  | 描述                                              |
| --------------------- | ------------------------------------------------- |
| **Schema 版本号**     | 跟踪当前数据模型版本的整数（存储在 ops + 快照中） |
| **迁移（Migration）** | 将状态从版本 N 转换为 N+1 的函数                  |
| **快照边界**          | 在加载快照时运行迁移，创建干净的版本化检查点      |
| **前向兼容性**        | 新版应用可以读取旧版数据（通过迁移）              |
| **向后兼容性**        | 旧版应用接收新版操作（通过优雅降级）              |

### 迁移触发条件

\\\
┌─────────────────────────────────────────────────────────────────────┐
│ 检测到应用更新 │
│ （schemaVersion 不匹配） │
└─────────────────────────────────────────────────────────────────────┘
│
┌───────────────────┼───────────────────┐
▼ ▼ ▼
加载快照 重放操作 接收远程操作
（旧版本） （混合版本） （更新/更旧版本）
│ │ │
▼ ▼ ▼
对完整状态 按原样应用操作 按需迁移
运行迁移 （操作是增量的） （完整状态导入）

### A.7.1 快照迁移（本地）

当应用启动时发现快照使用了较旧的 schema 版本：

```
App Startup（schema v1 → v2）
    │
    ▼
加载 state_cache（v1 快照）
    │
    ▼
检测版本不匹配：snapshot.schemaVersion < CURRENT_SCHEMA_VERSION
    │
    ▼
运行迁移链：migrateV1ToV2(snapshot.state)
    │
    ▼
派发 loadAllData(migratedState)
    │
    ▼
强制新快照，schemaVersion = 2
    │
    ▼
继续处理尾部操作（快照之后的操作）
```

### A.7.2 操作重放（混合版本）

日志中的操作可能具有不同的 schema 版本。重放期间：

```typescript
// 操作是"增量的"——它们描述变更内容，而非完整状态
// 示例：{ opType: 'UPD', payload: { task: { id: 'x', changes: { title: 'new' } } } }

// 旧操作可应用于迁移后的状态，因为：
// 1. 它们引用的字段仍然存在（或被映射）
// 2. 新字段已由迁移填充了默认值
// 3. 重命名的字段由迁移别名处理

async replayOperation(op: Operation, currentState: AppDataComplete): Promise<void> {
  // 操作 schema 版本仅供参考——操作应用于当前状态结构
  // 快照已迁移到当前 schema
  await this.operationApplier.applyOperations([op]);
}
```

> **限制：** 重放期间操作**不会被迁移**。如果迁移重命名了字段（例如 `estimate` → `timeEstimate`），引用 `estimate` 的旧操作仍会将值应用到该实体上，可能导致数据不一致。为避免此问题：
>
> 1. **优先使用增量迁移** - 添加带有默认值的新字段，而非重命名
> 2. **在 reducer 中使用别名** - 如果必须重命名，reducer 应同时接受新旧字段名
> 3. **迁移后强制压缩** - 减少混合版本操作的时间窗口
>
> 操作级迁移（在重放期间将旧操作转换为新 schema）被列为 A.7.9 中的未来增强功能。

### A.7.3 远程同步（跨版本客户端）

当客户端运行不同版本的 Super Productivity 时，同步必须处理版本差异：

```
┌─────────────────────────────────────────────────────────────────────┐
│                     远程同步场景                                      │
└─────────────────────────────────────────────────────────────────────┘

场景 1：新版客户端接收旧版操作
──────────────────────────────────────────
客户端 v2 ◄─── 来自 v1 客户端的操作
    │
    └── 操作正常应用（增量变更应用于已迁移状态）
        缺失的新字段使用迁移中的默认值

场景 2：旧版客户端接收新版操作
──────────────────────────────────────────
客户端 v1 ◄─── 来自 v2 客户端的操作
    │
    ├── 单个操作：忽略未知字段（优雅降级）
    │   { task: { id: 'x', changes: { title: 'a', newFieldV2: 'b' } } }
    │                                            ↑ v1 忽略此字段
    │
    └── 完整状态导入（SYNC_IMPORT）：可能验证失败
        → 提示用户更新应用或手动解决

场景 3：混合版本冲突
──────────────────────────────────────────
客户端 v1 与客户端 v2 冲突
    │
    └── 冲突解决使用实体级比较
        版本特定字段在合并期间处理
```

### A.7.4 完整状态导入（SYNC_IMPORT/BACKUP_IMPORT）

当从远程接收完整状态时（例如来自另一个客户端的 SYNC_IMPORT）：

```typescript
async handleFullStateImport(payload: { appDataComplete: AppDataComplete }): Promise<void> {
  const { appDataComplete } = payload;

  // 1. 检测传入状态的 schema 版本（从 schemaVersion 字段或结构检测）
  const incomingVersion = appDataComplete.schemaVersion ?? detectSchemaVersion(appDataComplete);

  if (incomingVersion < CURRENT_SCHEMA_VERSION) {
    // 2a. 将传入状态迁移到当前版本
    const migratedState = await this.migrateState(appDataComplete, incomingVersion);
    this.store.dispatch(loadAllData({ appDataComplete: migratedState }));

  } else if (incomingVersion > CURRENT_SCHEMA_VERSION + MAX_VERSION_SKIP) {
    // 2b. 版本太新 - 拒绝并提示用户更新
    this.snackService.open({
      type: 'ERROR',
      msg: T.F.SYNC.S.VERSION_TOO_OLD,
      actionStr: T.PS.UPDATE_APP,
      actionFn: () => window.open(UPDATE_URL, '_blank'),
    });
    throw new Error(`Schema version ${incomingVersion} 需要更新应用`);

  } else if (incomingVersion > CURRENT_SCHEMA_VERSION) {
    // 2c. 稍新一些 - 尝试加载并显示警告
    PFLog.warn('收到来自新版应用的状态', { incomingVersion, current: CURRENT_SCHEMA_VERSION });
    this.snackService.open({
      type: 'WARN',
      msg: T.F.SYNC.S.NEWER_VERSION_WARNING, // "来自新版应用的数据 - 某些功能可能无法正常工作"
    });
    // 尝试加载 - 未知字段将被 Typia 验证剥离
    // 这可能导致旧版应用无法理解的字段数据丢失
    this.store.dispatch(loadAllData({ appDataComplete }));

  } else {
    // 2d. 相同版本 - 直接加载
    this.store.dispatch(loadAllData({ appDataComplete }));
  }

  // 3. 保存快照（始终使用当前 schema 版本）
  await this.saveStateCache(/* 使用 schemaVersion = CURRENT_SCHEMA_VERSION 的当前状态 */);
}
```

### A.7.5 迁移实现

迁移定义在 `src/app/op-log/store/schema-migration.service.ts` 中。

**如何创建新迁移：**

1. 递增 `CURRENT_SCHEMA_VERSION`
2. 向 `MIGRATIONS` 数组添加条目，包含 `fromVersion`、`toVersion`、`description`、`migrate()`
3. 测试迁移链（v1→v2→v3 应与 v1→v3 结果相同）

```typescript
interface SchemaMigration {
  fromVersion: number;
  toVersion: number;
  description: string;
  migrate: (state: unknown) => unknown;
  migrateOperation?: (op: Operation) => Operation | null; // 用于字段重命名/删除
  requiresOperationMigration: boolean;
}
```

**设计原则：**

| 原则                 | 描述                             |
| -------------------- | -------------------------------- |
| **优先增量变更**     | 添加带有默认值的新可选字段最安全 |
| **避免破坏性重命名** | 使用别名或转换替代               |
| **保留未知字段**     | 不要剥离来自较新版本的字段       |
| **幂等迁移**         | 运行两次应保持安全               |

**版本不匹配处理：** 远程数据太新 → 提示用户更新应用。远程数据太旧 → 显示错误，可能需要手动干预。

### A.7.10 旧版数据迁移

> **注意：** 旧版 PFAPI 系统已移除（2026 年 1 月）。本节记录了历史迁移路径。

对于从旧版本（操作日志之前）升级的用户，`ServerMigrationService` 处理迁移：

1. 首次同步时，检测旧版远程数据格式
2. 以旧版格式下载完整状态
3. 创建包含导入状态的 `SYNC_IMPORT` 操作
4. 将新格式上传到同步提供者

**关键文件：** `src/app/op-log/sync/server-migration.service.ts`

所有未来的 schema 变更应使用上述的 **Schema 迁移**系统（A.7）。

### A.7.6 已实现的安全功能

**迁移安全性（A.7.12）** ✅ - 迁移前创建备份；失败时回滚。

**尾部操作一致性（A.7.13）** ✅ - 尾部操作在水合期间被迁移以匹配当前 schema。

**统一迁移（A.7.15）** ✅ - 状态和操作迁移在单个 `SchemaMigration` 定义中关联。

### A.7.7 何时需要操作迁移？

| 变更类型      | 状态迁移         | 操作迁移                 | 示例                        |
| ------------- | ---------------- | ------------------------ | --------------------------- |
| 添加可选字段  | ✅（设置默认值） | ❌（旧操作只是不设置它） | `priority?: string`         |
| 重命名字段    | ✅（复制旧→新）  | ✅（转换 payload）       | `estimate` → `timeEstimate` |
| 移除字段/功能 | ✅（删除它）     | ✅（丢弃操作或剥离字段） | 移除 `pomodoro`             |
| 更改字段类型  | ✅（转换）       | ✅（转换 payload）       | `"1h"` → `3600`             |
| 添加实体类型  | ✅（初始化）     | ❌（不存在旧操作）       | 新增 `Board` 实体           |

**经验法则：** 增量变更（新的可选字段、新实体）不需要操作迁移。字段重命名/删除需要操作迁移。

### A.7.8 跨版本同步（尚未实现）

**状态：** 设计就绪，尚未实现。`CURRENT_SCHEMA_VERSION = 1` 时安全。

**策略：** 接收方在冲突检测之前迁移传入操作。发送方按原样上传操作。

**临时防护措施：**

- 拒绝 `schemaVersion > CURRENT + MAX_VERSION_SKIP` 的操作
- 接收较新版本操作时提示用户更新应用

**需要此功能的情况：** 任何重命名/删除字段的 schema 迁移。

### A.7.11 跨版本同步实现指南

> **状态：** 尚未实现。本节记录了当 `CURRENT_SCHEMA_VERSION > 1` 时的设计方案。

本指南提供了支持不同 schema 版本的客户端之间同步的实现路线图。

#### 何时递增 CURRENT_SCHEMA_VERSION

在以下情况下递增 schema 版本号：

| 变更类型                 | 递增版本？ | 原因                                           |
| ------------------------ | ---------- | ---------------------------------------------- |
| 添加带有默认值的可选字段 | ✅ 是      | 旧客户端不会设置它；新客户端需要知道应用默认值 |
| 重命名字段               | ✅ 是      | 操作需要 payload 转换                          |
| 移除字段/功能            | ✅ 是      | 操作可能引用已移除的实体                       |
| 更改字段类型             | ✅ 是      | 载荷值需要转换                                 |
| 添加新实体类型           | ✅ 是      | 旧快照需要初始化                               |
| 添加新动作类型           | ❌ 否      | 旧客户端忽略未知动作                           |
| Reducer 的 bug 修复      | ❌ 否      | 非 schema 变更                                 |

**决策规则：** 如果变更影响 `state_cache` 快照或操作 payload 的结构，则递增版本号。

#### 操作转换策略

当接收来自旧版本的操作时：

```typescript
// 在 SchemaMigrationService.migrateOperation() 中
async migrateOperation(op: Operation): Promise<Operation | null> {
  const opVersion = op.schemaVersion ?? 1;

  if (opVersion >= CURRENT_SCHEMA_VERSION) {
    return op; // 已是最新
  }

  // 遍历迁移链
  let migratedPayload = op.payload;
  for (let v = opVersion; v < CURRENT_SCHEMA_VERSION; v++) {
    const migration = MIGRATIONS.find(m => m.fromVersion === v);
    if (migration?.migrateOperation) {
      const result = migration.migrateOperation(op.actionType, migratedPayload);
      if (result === null) {
        // 操作应被丢弃（已移除的功能）
        return null;
      }
      migratedPayload = result;
    }
  }

  return {
    ...op,
    payload: migratedPayload,
    schemaVersion: CURRENT_SCHEMA_VERSION,
  };
}
```

#### 跨版本冲突检测

迁移防护层确保冲突检测始终进行同类比较：

```
远程操作（v1）          本地操作（v2）
     │                       │
     ▼                       │
┌─────────────────┐          │
│  迁移层          │          │
│  (v1 → v2)      │          │
└────────┬────────┘          │
         │                   │
         ▼                   ▼
    ┌────────────────────────────┐
    │   冲突检测                  │
    │   （两个操作现在都是 v2）    │
    └────────────────────────────┘
```

**关键不变性：** 操作**始终**在冲突检测**之前**迁移到当前版本。这确保：

- 向量时钟比较有效（相同的逻辑 schema）
- LWW 时间戳比较公平（相同的字段语义）
- 实体 ID 可比较（没有重命名的引用）

#### 向后兼容性保证

| 场景                                  | 行为                                 | 用户体验         |
| ------------------------------------- | ------------------------------------ | ---------------- |
| 新版客户端 → 旧版客户端               | 操作按原样上传；旧版客户端接收时迁移 | 无缝             |
| 旧版客户端 → 新版客户端               | 新版客户端迁移传入操作               | 无缝             |
| 客户端太旧（落后 > MAX_VERSION_SKIP） | 拒绝操作，提示更新                   | "请更新应用"弹窗 |
| 客户端太新（服务器拒绝）              | 不适用 - 服务器不验证 schema         | 无问题           |

**MAX_VERSION_SKIP = 5**: 落后超过 5 个版本的客户端必须更新后才能同步。这限制了迁移链的复杂度。

#### 迁移部署策略

部署 schema 迁移时：

1. **发布包含迁移代码的新版本**
   - 向 `MIGRATIONS` 数组添加迁移
   - 递增 `CURRENT_SCHEMA_VERSION`
   - 迁移处理状态和操作两方面的转换

2. **优雅降级期**
   - 旧客户端继续正常工作（它们不知道新 schema）
   - 新版客户端无缝迁移传入的旧操作
   - 通过接收方迁移实现混合版本同步

3. **监控**（未来）
   - 在服务器日志中跟踪 `op.schemaVersion` 分布
   - 如有许多客户端落后超过 2 个版本则发出告警

4. **清理**（可选，经过多个版本后）
   - 移除版本 < `MIN_SUPPORTED_SCHEMA_VERSION` 的迁移
   - 更新 `MIN_SUPPORTED_SCHEMA_VERSION`
   - 旧客户端将看到"需要更新"提示

#### 示例迁移：重命名字段

```typescript
// packages/shared-schema/src/migrations.ts
export const MIGRATIONS: SchemaMigration[] = [
  {
    fromVersion: 1,
    toVersion: 2,
    description: '将 task.estimate 重命名为 task.timeEstimate',

    // 迁移状态快照
    migrateState: (state: unknown): unknown => {
      const s = state as AppDataComplete;
      return {
        ...s,
        task: {
          ...s.task,
          entities: Object.fromEntries(
            Object.entries(s.task.entities).map(([id, task]) => [
              id,
              {
                ...task,
                timeEstimate: (task as any).estimate, // 复制旧字段
                estimate: undefined, // 移除旧字段
              },
            ]),
          ),
        },
      };
    },

    // 迁移操作 payload
    requiresOperationMigration: true,
    migrateOperation: (actionType: string, payload: unknown): unknown | null => {
      if (actionType.includes('[Task]') && payload && typeof payload === 'object') {
        const p = payload as Record<string, unknown>;
        if ('estimate' in p) {
          return {
            ...p,
            timeEstimate: p.estimate,
            estimate: undefined,
          };
        }
      }
      return payload; // 其他动作保持不变
    },
  },
];
```

#### 测试跨版本同步

在发布任何迁移之前：

1. **单元测试**在 `schema-migration.service.spec.ts` 中：
   - 状态迁移的正确性
   - 操作迁移的正确性
   - 被丢弃操作的 null 返回

2. **集成测试**在 `cross-version-sync.integration.spec.ts` 中：
   - 客户端 A（v1）与客户端 B（v2）同步
   - 两个客户端收敛到相同状态
   - 迁移过程中无数据丢失

3. **E2E 测试**（手动或自动化）：
   - 安装旧版应用，创建数据
   - 更新到新版
   - 验证数据迁移正确
   - 与另一台设备上的新版同步

---

# Part B：基于文件的同步

基于文件的同步提供者（WebDAV、Dropbox、LocalFile）通过 `FileBasedSyncAdapter` 使用单文件方法。

## B.1 基于文件的同步如何工作

```
触发同步（WebDAV/Dropbox/LocalFile）
    │
    ▼
FileBasedSyncAdapter.downloadOps()
    │
    └──► 从远程下载 sync-data.json
              │
              ├──► 包含：状态快照 + 最近操作缓冲区
              │
              └──► 比较向量时钟进行冲突检测
                        │
                        ▼
                   处理新操作，合并状态
                        │
                        ▼
                   FileBasedSyncAdapter.uploadOps()
                        │
                        └──► 上传合并后的状态 + 操作
```

**关键文件：** `src/app/op-log/sync-providers/file-based/file-based-sync-adapter.service.ts`

## B.2 FileBasedSyncData 格式

```typescript
interface FileBasedSyncData {
  version: 2;
  schemaVersion: number;
  vectorClock: VectorClock;
  syncVersion: number; // 基于内容的乐观锁定
  lastSeq: number;
  lastModified: number;

  // 完整状态快照（约占文件大小的 95%）
  state: AppDataComplete;

  // 用于冲突检测的最近操作（最近 200 个，约占 5%）
  recentOps: CompactOperation[];

  // 用于完整性验证的校验和
  checksum?: string;
}
```

## B.3 捎带机制（Piggybacking）

当两个客户端同时同步时，适配器使用"捎带"（piggybacking）机制确保不会丢失任何操作：

1. 客户端 A 上传状态（syncVersion 1 → 2）
2. 客户端 B 尝试上传，检测到版本不匹配
3. 客户端 B 下载 A 的变更，找到尚未看到的操作
4. 客户端 B 将 A 的操作合并到自己的状态中，上传（syncVersion 2 → 3）
5. 两个客户端最终都拥有所有操作

```typescript
// 在 FileBasedSyncAdapter.uploadOps() 中
const remote = await this._downloadRemoteData(provider);
if (remote && remote.syncVersion !== expectedSyncVersion) {
  // 另一个客户端已同步 - 找到我们尚未处理的操作
  const newOps = remote.recentOps.filter((op) => op.seq > lastProcessedSeq);
  // 将这些作为"捎带"操作返回给调用者处理
  return { localOps, newOps };
}
```

## B.4 同步下载持久化

当远程数据被下载时，同步系统创建一个 SYNC_IMPORT 操作：

```typescript
async hydrateFromRemoteSync(downloadedMainModelData?: Record<string, unknown>): Promise<void> {
  // 1. 使用下载的状态创建 SYNC_IMPORT 操作
  const op: Operation = {
    id: uuidv7(),
    opType: 'SYNC_IMPORT',
    entityType: 'ALL',
    payload: downloadedMainModelData,
    // ...
  };
  await this.opLogStore.append(op, 'remote');

  // 2. 强制快照以确保崩溃安全
  await this.opLogStore.saveStateCache({
    state: downloadedMainModelData,
    lastAppliedOpSeq: lastSeq,
    // ...
  });

  // 3. 派发到 NgRx
  this.store.dispatch(loadAllData({ appDataComplete: downloadedMainModelData }));
}
```

### loadAllData 变体

| 来源           | 创建操作？          | 强制快照？ |
| -------------- | ------------------- | ---------- |
| 水合（启动时） | 否                  | 否         |
| 远程同步下载   | 是（SYNC_IMPORT）   | 是         |
| 备份文件导入   | 是（BACKUP_IMPORT） | 是         |

## B.5 归档数据处理

归档数据（`archiveYoung`、`archiveOld`）包含在基于文件同步的状态快照中。归档文件通过 `ArchiveDbAdapter` 直接写入 IndexedDB（出于性能考虑绕过操作日志）。

### 为什么归档绕过操作日志

1. **大小**：归档任务经过数年累积可能达到数万条记录
2. **频率**：归档更新很少（仅在归档任务或刷新旧数据时）
3. **同步需求**：归档作为状态快照的一部分同步，但不需要操作级别的粒度

### 归档写路径

```
归档操作（例如，归档已完成任务）
    │
    ├──► 1. 通过 ArchiveDbAdapter 直接更新归档
    │
    └──► 2. 下次同步时，归档被包含在状态快照中
```

**关键文件：**

- `src/app/op-log/archive/archive-db-adapter.service.ts`
- `src/app/op-log/archive/archive-operation-handler.service.ts`

---

# Part C：服务器同步

对于基于服务器的同步，操作日志**就是**同步机制。上传/下载的是单个操作，而非完整状态快照。

## C.1 服务器同步与基于文件的同步有何不同

| 方面            | 基于文件的同步（Part B）   | 服务器同步（Part C） |
| --------------- | -------------------------- | -------------------- |
| 同步内容        | 状态快照 + 最近操作        | 单个操作             |
| 冲突检测        | 快照级别的向量时钟         | 实体级别的每操作检测 |
| 传输方式        | 单个文件（sync-data.json） | HTTP API             |
| 操作日志角色    | 从操作构建快照             | 即同步本身           |
| `syncedAt` 跟踪 | 不需要                     | 必需                 |

## C.2 操作同步协议

支持操作同步的提供者实现 `OperationSyncCapable`：

```typescript
interface OperationSyncCapable {
  supportsOperationSync: true;
  uploadOps(
    ops: SyncOperation[],
    clientId: string,
    lastKnownSeq: number,
  ): Promise<UploadResponse>;
  downloadOps(
    sinceSeq: number,
    clientId?: string,
    limit?: number,
  ): Promise<DownloadResponse>;
  getLastServerSeq(): Promise<number>;
  setLastServerSeq(seq: number): Promise<void>;
}
```

### 上传流程

```typescript
async uploadPendingOps(syncProvider: OperationSyncCapable): Promise<void> {
  const pendingOps = await this.opLogStore.getUnsynced();

  // 批量上传（每次请求最多 25 个操作）
  for (const chunk of chunkArray(pendingOps, 25)) {
    const response = await syncProvider.uploadOps(
      chunk.map(entry => toSyncOperation(entry.op)),
      clientId,
      lastKnownServerSeq
    );

    // 将已接受的操作标记为已同步
    const acceptedSeqs = response.results
      .filter(r => r.accepted)
      .map(r => findEntry(r.opId).seq);
    await this.opLogStore.markSynced(acceptedSeqs);

    // 处理来自其他客户端的捎带新操作
    if (response.newOps?.length > 0) {
      await this.processRemoteOps(response.newOps);
    }
  }
}
```

### 下载流程

```typescript
async downloadRemoteOps(syncProvider: OperationSyncCapable): Promise<void> {
  let sinceSeq = await syncProvider.getLastServerSeq();
  let hasMore = true;

  while (hasMore) {
    const response = await syncProvider.downloadOps(sinceSeq, undefined, 500);

    // 过滤已应用的操作
    const newOps = response.ops.filter(op => !appliedOpIds.has(op.id));
    await this.processRemoteOps(newOps);

    sinceSeq = response.ops[response.ops.length - 1].serverSeq;
    hasMore = response.hasMore;
    await syncProvider.setLastServerSeq(response.latestSeq);
  }
}
```

## C.3 通过快照端点的完整状态操作

包含完整应用状态的操作（`SyncImport`、`BackupImport`、`Repair`）可能非常大（10-30MB+）。这些操作不通过常规的 `/api/sync/ops` 端点发送，而是通过专用的 `/api/sync/snapshot` 端点上载，该端点专为大载荷优化。

### 操作路由

```
上传流程
    │
    ├──► 过滤：opType 是否在 { SYNC_IMPORT, BACKUP_IMPORT, REPAIR } 中？
    │         │
    │         ├──► 是：通过 /api/sync/snapshot 上传
    │         │         • 使用 uploadSnapshot() 方法
    │         │         • 将 opType 映射为 reason：initial、recovery、migration
    │         │         • 支持端到端加密（E2EE）
    │         │
    │         └──► 否：通过 /api/sync/ops 上传（常规批量上传）
```

### 实现

```typescript
// 路由到快照端点的完整状态操作类型
const FULL_STATE_OP_TYPES = new Set([
  OpType.SyncImport,
  OpType.BackupImport,
  OpType.Repair,
]);

// 在 OperationLogUploadService._uploadPendingOpsViaApi() 中：
const fullStateOps = pendingOps.filter((entry) =>
  FULL_STATE_OP_TYPES.has(entry.op.opType as OpType),
);
const regularOps = pendingOps.filter(
  (entry) => !FULL_STATE_OP_TYPES.has(entry.op.opType as OpType),
);

// 通过快照端点上载完整状态操作
for (const entry of fullStateOps) {
  await syncProvider.uploadSnapshot(
    entry.op.payload, // 完整应用状态
    entry.op.clientId,
    mapOpTypeToReason(entry.op.opType), // 'initial' | 'recovery' | 'migration'
    entry.op.vectorClock,
    entry.op.schemaVersion,
  );
}

// 通过操作端点上载常规操作（批次）
// ...（现有的批量上传逻辑）
```

### OpType 到 Reason 的映射

| OpType          | 快照 Reason | 用例                   |
| --------------- | ----------- | ---------------------- |
| `SYNC_IMPORT`   | `initial`   | 首次同步或完整状态刷新 |
| `BACKUP_IMPORT` | `recovery`  | 从备份文件恢复         |
| `REPAIR`        | `recovery`  | 使用修正状态的自动修复 |

### 好处

1. **减少请求体大小限制问题** - 快照端点有 30MB 限制，与常规操作分开
2. **语义清晰** - 完整状态上传使用适当的端点
3. **服务端优化** - 服务端可以缓存快照以加速客户端引导

## C.4 冲突检测

使用实体级别的向量时钟检测冲突。**重要的是，冲突只可能发生在实体存在待处理（未同步）本地操作的情况下。** 如果本地对某个实体没有待处理的变更，那么任何远程操作都可以安全应用——本地没有内容与之冲突。

```typescript
async detectConflicts(remoteOps: Operation[]): Promise<ConflictResult> {
  const localPendingByEntity = await this.opLogStore.getUnsyncedByEntity();
  const appliedFrontierByEntity = await this.opLogStore.getEntityFrontier();

  for (const remoteOp of remoteOps) {
    const entityKey = `${remoteOp.entityType}:${remoteOp.entityId}`;
    const localPendingOps = localPendingByEntity.get(entityKey) || [];

    // 快速路径：没有待处理的本地操作 = 不可能冲突
    // 冲突需要并发修改。如果自上次同步以来本地未修改此实体，
    // 则可以安全应用任何远程操作。
    if (localPendingOps.length === 0) {
      nonConflicting.push(remoteOp);
      continue;
    }

    // 从已应用 + 待处理操作构建本地前沿向量
    const localFrontier = mergeClocks(
      appliedFrontierByEntity.get(entityKey),
      ...localPendingOps.map(op => op.vectorClock)
    );

    const comparison = compareVectorClocks(localFrontier, remoteOp.vectorClock);
    if (comparison === VectorClockComparison.CONCURRENT) {
      conflicts.push({
        entityType: remoteOp.entityType,
        entityId: remoteOp.entityId,
        localOps: localPendingOps,
        remoteOps: [remoteOp],
        suggestedResolution: 'manual'
      });
    } else {
      nonConflicting.push(remoteOp);
    }
  }

  return { nonConflicting, conflicts };
}
```

### 为什么待处理操作对冲突检测至关重要

关键洞察是**冲突是关于未提交的变更，而非历史状态**：

- **已应用/已同步的操作**：已在客户端之间协调完成。它们的向量时钟贡献给了全局同步状态，但不再代表可能丢失的"进行中"变更。
- **待处理操作**：尚未同步。这些代表可能与传入远程操作冲突的变更。

如果客户端 A 发送了一个任务的删除操作，而客户端 B 对此任务没有待处理操作，客户端 B 应该直接应用删除 —— 没有本地工作会丢失。快照/前沿向量时钟跟踪的是*历史*，而非*意图*。

## C.5 冲突解决（LWW 自动解决）

冲突使用最后写入者胜出（Last-Write-Wins, LWW）策略通过 `ConflictResolutionService.autoResolveConflictsLWW()` 自动解决：

### LWW 解决策略

1. **比较时间戳**：比较双方各自的最大操作时间戳
2. **较新者胜出**：具有较新时间戳的一方胜出
3. **打破平局**：时间戳相等时，远程胜出（以服务器为准）

```typescript
async autoResolveConflictsLWW(conflicts: EntityConflict[], nonConflictingOps: Operation[]): Promise<void> {
  for (const conflict of conflicts) {
    const localMaxTimestamp = Math.max(...conflict.localOps.map(op => op.timestamp));
    const remoteMaxTimestamp = Math.max(...conflict.remoteOps.map(op => op.timestamp));

    if (localMaxTimestamp > remoteMaxTimestamp) {
      // 本地胜出 - 使用当前实体状态创建新的 UPDATE 操作
      const localWinOp = await this._createLocalWinUpdateOp(conflict);
      // 拒绝旧版本地和远程操作
      await this.opLogStore.markRejected([...localOpIds, ...remoteOpIds]);
      // 新操作将在下次上传时同步本地状态
      await this.opLogStore.append(localWinOp, 'local');
    } else {
      // 远程胜出（包括平局）
      await this.operationApplier.applyOperations(conflict.remoteOps);
      await this.opLogStore.markRejected(localOpIds);
    }
  }
}
```

### 本地胜出时

当本地状态更新时，我们不能仅仅拒绝远程操作——这会导致本地状态永远不会同步到服务器。改为：

1. **拒绝**本地和远程操作（它们现已过时）
2. **创建新的 UPDATE 操作**，包含：
   - 来自 NgRx store 的当前实体状态
   - 合并后的向量时钟（本地 + 远程）并递增
   - **保留来自本地操作的最大时间戳**（对正确的 LWW 语义至关重要——使用 `Date.now()` 会在未来的冲突中给予不公平的优势）
3. **此新操作将在下一个同步周期上传**，将本地状态传播到服务端

会发出警告级别的日志：`OpLog.warn('LWW local wins - creating update op for ${entityType}:${entityId}')`

### 被拒绝的操作

当操作被拒绝时（无论是本地还是远程）：

- 被拒绝的操作保留在日志中用于历史/调试
- `getUnsynced()` 排除被拒绝的操作（不会重新上传）
- 压缩最终可能删除旧版被拒绝的操作

### 归档胜出规则

当 `moveToArchive` 操作与字段级更新（如重命名、时间跟踪变更）冲突时，归档操作**始终胜出**，无论时间戳如何。这绕过了正常的 LWW 时间戳比较，因为归档代表了不应被并发字段更新撤销的显式用户意图。

**原理：** 如果客户端 A 归档一个任务，而客户端 B 同时重命名它，归档必须胜出 —— 否则 LWW 更新会通过替换状态将已归档的任务"复活"回活动 store。

**实现：** `ConflictResolutionService` 检查本地或远程是否包含 `TASK_SHARED_MOVE_TO_ARCHIVE` 动作。如果是，归档方自动胜出，并使用合并后的向量时钟创建新的归档操作（通过 `_createArchiveWinOp()`）。

这是**归档复活预防的第一级防线**。**第二级防线**在 `bulkOperationsMetaReducer` 中（参见[归档复活预防](diagrams/06-archive-operations.md#archive-resurrection-prevention-two-level-defense)），它在操作批次中预扫描归档操作，并跳过同一批次中针对正在归档实体的任何 LWW 更新操作。这个两级防线处理了 3+ 客户端场景，其中 LWW 更新可能在同一批次中在归档操作之前或之后到达。

**关键文件：**

- `src/app/op-log/sync/conflict-resolution.service.ts` — 归档胜出检查和 `_createArchiveWinOp()`
- `src/app/op-log/apply/bulk-hydration.meta-reducer.ts` — 预扫描归档过滤

### moveToArchive 的被取代操作处理

`SupersededOperationResolverService` 将 `moveToArchive` 视为与 DELETE 操作并列的特殊情况。当 `moveToArchive` 操作因并发冲突被服务器拒绝时，它不会被丢弃，而是**使用合并后的向量时钟重新创建**。

这是必要的，因为 `moveToArchive` 会将实体从 NgRx store 中移除（通过归档 reducer），因此 `getCurrentEntityState()` 对已归档实体返回 `undefined`。没有这个特殊处理，被取代的操作解析器将无法重新创建该操作，归档的任务将丢失。

**实现：** 在逐实体处理之前，`SupersededOperationResolverService` 识别诸如 `moveToArchive` 之类的批量语义操作，并使用原始 payload 和合并后的向量时钟重新创建它们，以 `MultiEntityPayload` 格式保留完整的任务数据。

**关键文件：** `src/app/op-log/sync/superseded-operation-resolver.service.ts`

### 单例实体的 LWW 更新

`lwwUpdateMetaReducer` 处理 LWW 更新动作（本地方在冲突中胜出时创建）的方式因实体的存储模式而异：

| 存储模式      | 实体类型                                              | LWW 更新行为                                                    |
| ------------- | ----------------------------------------------------- | --------------------------------------------------------------- |
| **Adapter**   | TASK、PROJECT、TAG、NOTE、TASK_REPEAT_CFG 等          | 通过 NgRx 实体适配器进行单个实体替换（`updateOne` 或 `addOne`） |
| **Singleton** | GLOBAL_CONFIG、TIME_TRACKING、MENU_TREE、WORK_CONTEXT | 整个功能状态被胜出数据替换，伴随全量的 isDirty 检查             |

### 单例实体 LWW 更新的差异

对于单例存储模式，LWW 更新动作包含整个功能状态（例如 `timeTracking` 对象包含所有项目和标签的所有时间数据）。`lwwUpdateMetaReducer` 将该状态与 store 中的当前状态合并，忽略 `isDirty` 为 true 的条目，并以更新后的向量时钟追加一个新的 LWW 更新操作。

**关键文件：** `src/app/op-log/apply/lww-update-meta-reducer.ts`

## C.6 依赖解析

`DependencyResolverService` 确保操作以正确的顺序应用，并处理实体之间的引用：

```typescript
interface DependencyResult {
  hardDependencies: string[]; // 必须存在
  softDependencies: string[]; // 应为存在，但非强制
}

type DependencyType = 'hard' | 'reference';

interface OperationDependency {
  opId: string;
  entityType: EntityType;
  entityId: string;
  dependencyType: DependencyType;
}
```

依赖硬依赖缺失的操作会被排队等待重试。经过 `MAX_RETRY_ATTEMPTS`（3 次）后，它们被标记为永久失败。

## C.7 SYNC_IMPORT 过滤（全新状态语义）

当接收到 `SYNC_IMPORT` 或 `BACKUP_IMPORT` 操作时，它代表用户将**所有客户端**恢复到某个特定时间点的显式操作。在不知晓该导入的情况下创建的操作将被过滤掉。

**实现：** `SyncImportFilterService.filterOpsInvalidatedBySyncImport()`

### 问题

考虑以下场景：

1. 客户端 A 创建 Op1、Op2（离线）
2. 客户端 B 执行 SYNC_IMPORT（从备份恢复）
3. 客户端 B 将 SYNC_IMPORT 上传到服务器
4. 客户端 A 上线，上传 Op1、Op2，然后下载 SYNC_IMPORT
5. **问题**：Op1、Op2 引用了被导入操作抹除的实体

### 解决方案：全新状态语义

SYNC_IMPORT/BACKUP_IMPORT 是将状态恢复到特定时间点的显式用户操作。**所有不知晓该导入的操作都被丢弃**——这确保了真正的"恢复到时间点"语义。

我们使用**向量时钟比较**（而非 UUIDv7 时间戳），因为向量时钟跟踪的是**因果关系**（"客户端知道导入的存在吗？"）而非挂钟时间（可能受时钟漂移影响）。

```typescript
// 在 SyncImportFilterService.filterOpsInvalidatedBySyncImport() 中
for (const op of ops) {
  // 完整状态导入操作本身始终有效
  if (op.opType === OpType.SyncImport || op.opType === OpType.BackupImport) {
    validOps.push(op);
    continue;
  }

  // 使用向量时钟比较确定因果关系
  const comparison = compareVectorClocks(op.vectorClock, latestImport.vectorClock);

  if (
    comparison === VectorClockComparison.GREATER_THAN ||
    comparison === VectorClockComparison.EQUAL
  ) {
    // 操作由知晓导入的客户端创建
    validOps.push(op);
  } else {
    // CONCURRENT 或 LESS_THAN：操作在不知晓导入的情况下创建
    // 过滤掉以确保全新状态语义
    invalidatedOps.push(op);
  }
}
```

### 向量时钟比较结果

| 比较结果       | 含义                         | 操作                |
| -------------- | ---------------------------- | ------------------- |
| `GREATER_THAN` | 操作在看见导入后创建         | ✅ 保留（知晓导入） |
| `EQUAL`        | 与导入相同的因果历史         | ✅ 保留             |
| `LESS_THAN`    | 操作被导入支配               | ❌ 丢弃（已被包含） |
| `CONCURRENT`   | 操作在不知晓导入的情况下创建 | ❌ 丢弃（全新状态） |

**示例：**

- SYNC_IMPORT 时钟：`{A: 10, B: 5}`
- 操作时钟：`{A: 11, B: 5}` → `GREATER_THAN` → ✅ 保留（客户端 A 看见了导入）
- 操作时钟：`{B: 3}` → `LESS_THAN` → ❌ 丢弃（被导入支配）
- 操作时钟：`{C: 1}` → `CONCURRENT` → ❌ 丢弃（客户端 C 不知道导入的存在）

**为什么丢弃 CONCURRENT？** 从未见过导入的客户端发出的操作可能引用导入状态中不再存在的实体。丢弃这些操作确保导入真正将所有客户端恢复到同一时间点。

参见 [diagrams/03-conflict-resolution.md](./diagrams/03-conflict-resolution.md) 查看可视化图示。

---

# Part D：数据验证与修复

操作日志包含全面的验证和自动修复功能，以防止数据损坏并从无效状态中恢复。

## D.1 验证架构

四个验证检查点确保整个操作生命周期中的数据完整性：

| 检查点 | 位置                                | 时机                | 失败时的操作                      |
| ------ | ----------------------------------- | ------------------- | --------------------------------- |
| **A**  | `operation-log.effects.ts`          | 写入 IndexedDB 之前 | 拒绝操作、记录错误、显示 snackbar |
| **B**  | `operation-log-hydrator.service.ts` | 加载快照后          | 尝试修复、创建 REPAIR 操作        |
| **C**  | `operation-log-hydrator.service.ts` | 重放尾部操作后      | 尝试修复、创建 REPAIR 操作        |
| **D**  | `operation-log-sync.service.ts`     | 应用远程操作后      | 尝试修复、创建 REPAIR 操作        |

## D.2 REPAIR 操作类型

当在检查点 B、C 或 D 验证失败时，系统使用 `dataRepair()` 函数尝试自动修复。如果修复成功，会创建一个 REPAIR 操作：

```typescript
enum OpType {
  // ... 现有类型
  Repair = 'REPAIR', // 自动修复操作，包含完整的修复后状态
}

interface RepairPayload {
  appDataComplete: AppDataCompleteNew; // 完整的修复后状态
  repairSummary: RepairSummary; // 修复内容摘要
}

interface RepairSummary {
  entityStateFixed: number; // 修复的 id/entities 数组同步问题
  orphanedEntitiesRestored: number; // 从归档中恢复的任务
  invalidReferencesRemoved: number; // 移除的不存在的项目/标签 ID
  relationshipsFixed: number; // 项目/标签 ID 一致性
  structureRepaired: number; // 菜单树、收件箱项目创建
  typeErrorsFixed: number; // 自动修复的 Typia 错误
}
```

### REPAIR 操作行为

- **重放期间**：REPAIR 操作直接加载状态（类似 SyncImport），跳过前面的操作
- **用户通知**：显示 snackbar，说明修复的问题数量
- **审计追踪**：REPAIR 操作在操作日志中可见，便于调试

## D.3 检查点 A：载荷验证

在写入 IndexedDB 之前，操作载荷在 `validate-operation-payload.ts` 中进行验证：

```typescript
validateOperationPayload(op: Operation): PayloadValidationResult {
  // 1. 结构验证 - payload 必须是对象
  // 2. OpType 特定验证：
  //    - CREATE：需要包含有效 'id' 字段的实体
  //    - UPDATE：需要 id + changes，或包含 id 的实体
  //    - DELETE：需要 entityId/entityIds
  //    - MOVE：需要 ids 数组
  //    - BATCH：需要非空 payload
  //    - SYNC_IMPORT/BACKUP_IMPORT：需要 appDataComplete 结构
  //    - REPAIR：跳过（内部生成）
}
```

此验证**故意宽松**——它检查结构要求而非深度实体验证。完整的 Typia 验证在状态检查点进行。

## D.4 检查点 B 和 C：水合验证

在水合过程中，状态在两个点进行验证：

```
应用启动
    │
    ▼
从 state_cache 加载快照
    │
    ├──► 检查点 B：验证快照
    │         │
    │         └──► 如果无效：修复 + 创建 REPAIR 操作
    │
    ▼
派发 loadAllData(snapshot)
    │
    ▼
重放尾部操作
    │
    └──► 检查点 C：验证当前状态
              │
              └──► 如果无效：修复 + 创建 REPAIR 操作 + 派发修复后状态
```

### 实现

```typescript
// 在 operation-log-hydrator.service.ts 中
private async _validateAndRepairState(state: AppDataCompleteNew): Promise<AppDataCompleteNew> {
  if (this._isRepairInProgress) return state; // 防止无限循环

  const result = this.validateStateService.validateAndRepair(state);
  if (!result.wasRepaired) return state;

  this._isRepairInProgress = true;
  try {
    await this.repairOperationService.createRepairOperation(
      result.repairedState,
      result.repairSummary,
    );
    return result.repairedState;
  } finally {
    this._isRepairInProgress = false;
  }
}
```

## D.5 检查点 D：同步后验证

应用远程操作后，状态需要验证：

- 在 `operation-log-sync.service.ts` 中——应用无冲突操作后（当没有冲突时）
- 在 `conflict-resolution.service.ts` 中——解决所有冲突后

这可以捕获：

- 远程操作导致的状态漂移
- 同步过程中引入的损坏
- 来自其他客户端的无效操作

## D.6 ValidateStateService

使用 Typia 和跨模型验证封装验证和修复功能：

```typescript
@Injectable({ providedIn: 'root' })
export class ValidateStateService {
  validateState(state: AppDataCompleteNew): StateValidationResult {
    // 1. 运行 Typia schema 验证
    const typiaResult = validateAllData(state);

    // 2. 运行跨模型关系验证
    //    注意：isRelatedModelDataValid 的错误现在被捕获并视为验证失败
    //    而非崩溃，允许 validateAndRepair 触发 dataRepair。
    let isRelatedValid = true;
    try {
      isRelatedValid = isRelatedModelDataValid(state);
    } catch (e) {
      PFLog.warn('isRelatedModelDataValid 抛出错误，视为验证失败', e);
      isRelatedValid = false;
    }

    return {
      isValid,
      typiaErrors,
      crossModelError: !isRelatedValid ? 'isRelatedModelDataValid 抛出错误' : undefined,
    };
  }

  validateAndRepair(state: AppDataCompleteNew): ValidateAndRepairResult {
    // 1. 验证
    // 2. 如果无效：运行 dataRepair()
    // 3. 重新验证修复后状态
    // 4. 返回修复后状态 + 摘要
  }
}
```

## D.7 RepairOperationService

创建 REPAIR 操作并通知用户：

```typescript
@Injectable({ providedIn: 'root' })
export class RepairOperationService {
  async createRepairOperation(
    repairedState: AppDataCompleteNew,
    repairSummary: RepairSummary,
  ): Promise<void> {
    // 1. 创建包含修复后状态 + 摘要的 REPAIR 操作
    // 2. 追加到操作日志
    // 3. 保存状态缓存快照
    // 4. 向用户显示通知
  }

  static createEmptyRepairSummary(): RepairSummary {
    return {
      entityStateFixed: 0,
      orphanedEntitiesRestored: 0,
      invalidReferencesRemoved: 0,
      relationshipsFixed: 0,
      structureRepaired: 0,
      typeErrorsFixed: 0,
    };
  }
}
```

---

# 边界情况与未解决的问题

本节记录了已知的边界情况以及需要进一步设计或实现的领域。

## 存储与资源限制

### IndexedDB 配额耗尽

**状态：** ✅ 已实现（2025 年 12 月）

当 IndexedDB 存储配额超限时，系统会优雅处理：

**实现**（参见 `operation-log.effects.ts`）：

1. **错误检测**：捕获 `QuotaExceededError`，包括浏览器变体：
   - 标准：`DOMException`，名称为 `QuotaExceededError`
   - Firefox：`NS_ERROR_DOM_QUOTA_REACHED`
   - Safari（旧版）：错误代码 22

2. **紧急压缩**：触发 `emergencyCompact()`，使用更短的保留期：
   - 正常保留期：7 天（`COMPACTION_RETENTION_MS`）
   - 紧急保留期：24 小时（`EMERGENCY_COMPACTION_RETENTION_MS`）
   - 仅删除已同步的操作（设置了 `syncedAt`）

3. **断路器**：标志 `isHandlingQuotaExceeded` 防止无限重试循环：
   - 如果重试期间再次超出配额，立即中止
   - 向用户显示错误而不是无限循环

4. **用户通知**：永久失败时（紧急压缩也失败后）：
   - 显示包含错误消息的 snackbar
   - 派发回滚动作以撤销乐观更新
   - NgRx store 中的用户数据保持一致

**常量**（`operation-log.const.ts`）：

- `EMERGENCY_COMPACTION_RETENTION_MS = 24 * 60 * 60 * 1000`（1 天）
- `MAX_COMPACTION_FAILURES = 3`

### 压缩触发协调

**状态：** 已实现 ✅

500 操作的压缩触发器使用存储在 `state_cache.compactionCounter` 中的持久计数器：

- 计数器通过 IndexedDB 在标签页之间共享
- 计数器在应用重启后持久保存
- 计数器在成功压缩后重置
- Web Locks 仍防止并发压缩执行

## 数据完整性边界情况

### 部分数据的创世迁移

**状态：** ⚠️ 未完全定义——边界情况风险

**风险级别：** 中——在崩溃/中断场景中可能出现静默数据丢失。

如果数据同时存在于 `pf` 和 `SUP_OPS` 数据库中怎么办？

- **场景**：创世迁移期间崩溃，或迁移后应用降级
- **当前行为**：如果 `SUP_OPS.state_cache` 存在，使用它；完全忽略 `pf`
- **风险**：可能在部分迁移完成后丢失写入 `pf` 的较新数据
- **检测缺口**：没有机制检测 `pf` 是否有比 `SUP_OPS` 更新的数据

**建议的解决方案：**

1. 在 `SUP_OPS.state_cache` 和 `pf.META_MODEL` 中都存储 `migrationTimestamp`
2. 启动时比较时间戳：
   - 如果 `pf.lastUpdate > SUP_OPS.migrationTimestamp`：警告用户，提供合并或重新迁移选项
   - 如果相等或 `pf` 更旧：继续使用 SUP_OPS（当前行为）
3. 应用降级时：显示明确错误，说明降级可能导致数据丢失，要求用户明确确认

**当前缓解措施：** 创世迁移是一次性事件。一旦 SUP_OPS 建立，所有写入都定向到此。风险仅限于迁移发生的时刻。

**同步 `clientId`（SUP_OPS schema v6，问题 #7732）：** 同步 `clientId`——设备的稳定同步标识——存储在 `SUP_OPS` 的 `client_id` store 中（键为 `current`）。以前它存储在旧版 `pf` 数据库中；将其存储在 `SUP_OPS` 中允许破坏性流程（全新状态、备份恢复）在 `runDestructiveStateReplacement` 的事务中原子性地轮换它，而非使用手工编写的跨数据库两阶段提交。`pf` 仍然是只读的一次性迁移源：首次读取尚未迁移的设备时，会将 id 复制过来（`ClientIdService`）。clientId 不可重新生成（它作为向量时钟的键），因此瞬时的 IndexedDB 读取失败会传播异常而非创建新 id。

### 同步期间的压缩

**状态：** 通过锁处理

- 压缩获取 `sp_op_log_compact` 锁
- 同步操作使用单独的锁
- **已验证安全**：压缩仅删除设置了 `syncedAt` 的操作，因此来自活跃同步的未同步操作将被保留

---

# Part E：智能归档处理

应用将数据分为"活跃状态"（内存中、Redux）和"归档状态"（磁盘上、极少访问）以保持性能。

- **ArchiveYoung**：最近归档的任务及其工作日志（例如最近 30 天）。
- **ArchiveOld**：历史数据的深层存储（数月/年前的数据）。

## E.1 归档同步的问题

在旧版系统中，更改归档中的一个任务需要重新上传完整（可能非常庞大）的归档文件。这既占用带宽又速度缓慢。

## E.2 新策略：确定性本地副作用

在操作日志架构中，**我们不直接同步归档文件。** 相反，我们同步修改归档的**指令**。由于逻辑是确定性的，所有客户端最终都会拥有相同的归档文件，而无需实际传输它们。

| 组件             | 同步策略         | 机制                                                               |
| ---------------- | ---------------- | ------------------------------------------------------------------ |
| **活跃状态**     | **操作日志**     | 标准同步（操作应用到 Redux）                                       |
| **ArchiveYoung** | **确定性副作用** | `moveToArchive` 操作在所有客户端上触发从 Active → Young 的本地移动 |
| **ArchiveOld**   | **确定性副作用** | `flushYoungToOld` 操作在所有客户端上触发从 Young → Old 的本地刷新  |

### E.3 工作流：moveToArchive

当用户归档任务时：

1. **客户端 A（发起方）：**
   - 生成 `moveToArchive` 操作。
   - 本地将任务 + 工作日志从 Active Store → `ArchiveYoung` 移动。
2. **同步：** 操作传输到客户端 B。
3. **客户端 B（远程）：**
   - 接收 `moveToArchive` 操作。
   - 执行**完全相同的逻辑**：
     - 从自己的 Active Store 中选择目标任务。
     - 将任务 + 工作日志移动到自己的 `ArchiveYoung`。
     - 从 Active Store 中移除它们。

**结果：** 两个客户端拥有相同的 `ArchiveYoung` 文件，但零归档数据通过网络传输。

### E.4 工作流：刷新（Young → Old）

_计划未来实现。_ 当 `ArchiveYoung` 增长过大时，客户端发出 `flushYoungToOld` 操作。所有客户端执行相同的刷新逻辑（移动早于 X 天的项目），保持 `ArchiveOld` 一致。

### E.5 幂等性要求

所有归档操作必须具有幂等性：

| 操作                 | 保证                         |
| -------------------- | ---------------------------- |
| `moveToArchive`      | 如果任务已在归档中则跳过     |
| `flushYoungToOld`    | 仅移动尚未在 Old 中的项目    |
| `restoreFromArchive` | 如果任务已在活跃状态中则跳过 |

**边界情况：** 缺失实体（已删除/乱序）→ 排队等待重试或跳过。乱序刷新 → 如果 Young 为空，则幂等地无操作。

## E.6 时间跟踪同步语义

时间跟踪数据遵循与常规实体不同的特殊同步模式。

### E.6.1 TimeTrackingState 结构

```typescript
interface TimeTrackingState {
  project: {
    [projectId: string]: {
      [dateStr: string]: { s?: number; e?: number; b?: number; bt?: number };
    };
  };
  tag: {
    [tagId: string]: {
      [dateStr: string]: { s?: number; e?: number; b?: number; bt?: number };
    };
  };
}
// s = 开始时间, e = 结束时间, b = 休息次数, bt = 休息时间
```

这是一个三级嵌套结构：`category → contextId → date → data`。

### E.6.2 三级存储模型

时间跟踪数据存在于三个位置：

| 位置             | 内容                | 同步频率         |
| ---------------- | ------------------- | ---------------- |
| **活跃状态**     | 仅当天的时间跟踪    | 每次同步（小）   |
| **archiveYoung** | 近期数据（< 21 天） | 每日（中等）     |
| **archiveOld**   | 历史数据（≥ 21 天） | 仅刷新时（很少） |

这种拆分显著减小了同步载荷大小。

### E.6.3 数据流

```
每日（结束工作时）：
  活跃 TimeTracking → archiveYoung
  （仅当天数据保留在活跃状态）

每约 14 天（刷新时）：
  archiveYoung → archiveOld
  （所有 timeTracking 数据移动，非基于阈值）
```

### E.6.4 合并行为

当从多个来源合并时间跟踪时（例如导入期间）：

**优先级：** `current > archiveYoung > archiveOld`

**字段级深度合并**：

```typescript
// 如果 current 有 {s: 100}，archiveYoung 有 {e: 200}，archiveOld 有 {b: 5}
// 结果：{s: 100, e: 200, b: 5}
```

这确保了当字段在多个来源中部分填充时，不会丢失数据。

### E.6.5 冲突解决

时间跟踪使用**最后写入者胜出（LWW）** 解决冲突：

- 如果客户端 A 和 B 都修改了 `project[id][date]`，最后一个操作胜出
- 这是有意为之：之后的准确测量应覆盖之前的估算
- 无需用户冲突对话框——LWW 自动应用

### E.6.6 新客户端水合

新客户端通过 SYNC_IMPORT 接收时间跟踪：

1. 服务器找到最新的 SYNC_IMPORT 操作（快照跳过优化）
2. SYNC_IMPORT 包含完整的 `timeTracking` + `archiveYoung.timeTracking` + `archiveOld.timeTracking`
3. 客户端应用 SYNC_IMPORT → 所有时间跟踪数据一次填充完成

**没有 SYNC_IMPORT 时：** 客户端逐步重放所有单独的 `syncTimeTracking` 操作（速度较慢但正确）。

### E.6.7 关键实现文件

| 文件                                   | 用途                             |
| -------------------------------------- | -------------------------------- |
| `merge-time-tracking-states.ts`        | 三源合并（带优先级）             |
| `sort-data-to-flush.ts`                | 归档刷新逻辑（young → old）      |
| `time-tracking.reducer.ts`             | syncTimeTracking 的 NgRx reducer |
| `archive-operation-handler.service.ts` | 远程处理 flushYoungToOld         |

## E.7 归档载荷：被拒绝的优化方案

`moveToArchive` 刻意携带**完整任务数据**（约 2 KB/任务），而不仅仅是 ID。原因：归档同步涉及两个系统——操作立即同步，但归档模型文件稍后同步。接收到 `moveToArchive` 的远程客户端必须*现在*就将任务写入其本地归档，在归档文件到达之前，而此时任务已从发起客户端的活跃状态中删除。因此操作必须自给自足。

较小的载荷方案经过探索后被拒绝：

| 选项                      | 想法                     | 被拒绝的原因                                                                                             |
| ------------------------- | ------------------------ | -------------------------------------------------------------------------------------------------------- |
| A — 私有 `_tasks` 字段    | 存储前剥离               | 远程操作仍需要完整数据进行同步                                                                           |
| B — meta-reducer 丰富     | 删除前从状态捕获任务     | meta-reducer 必须保持纯函数；从同步 reducer 异步操作很麻烦                                               |
| C — 两阶段（写入 + 删除） | 拆分为两个操作           | 总载荷相同，只是增加了复杂性                                                                             |
| D — 基于操作的归档 store  | 归档完全由仅 ID 操作填充 | 迁移多年现有归档数据；初始同步必须重放 20K+ 归档操作；无界操作日志增长；压缩必须保留归档状态；PFAPI 过渡 |

**决定：保留完整载荷方案**——它能工作，没有时序边界情况，简单直接，且归档不频繁（一天结束时，而非持续）。大小缩减不值得增加的复杂性。对于非常大的归档，以 `ARCHIVE_CHUNK_SIZE = 25` 分块派发。

**逃生口（如果大小成为实际而非理论问题时的首选方法）：** 任务数据是文本/JSON，可压缩超过 90%——在发送前压缩 `moveToArchive` 操作中的 `_tasks` payload（LZ-string/GZIP）。这消除了大小问题，而无需选项 D 那样的架构性改造。

---

# Part F：原子状态一致性

本节记录了确保相关模型变更原子性地发生、防止同步期间状态不一致的架构原则。

## F.1 问题：Effect 产生非原子性变更

当用户删除标签时，多个实体必须更新：

- 标签本身被删除
- 引用该标签的任务更新其 `tagIds`
- 引用该标签的 TaskRepeatCfgs 被更新或删除
- 该标签的时间跟踪数据被清理

如果这些变更发生在单独的 NgRx effects 中：

1. 每个 effect 派发一个单独的动作
2. 每个动作成为日志中的单独操作
3. 同步期间，操作可能乱序或部分到达
4. **结果**：临时或永久的状态不一致

## F.2 解决方案：Meta-Reducer 实现原子性变更

**原则**：来自单个用户操作的所有相关实体变更应在单个 reducer 传递中完成。

Meta-reducer 在动作到达功能 reducer 之前拦截它们，并可原子性地修改整个 store 状态：

```typescript
// tag-shared.reducer.ts - 原子性地处理 deleteTag
[deleteTag.type]: () => {
  // 1. 从任务中移除标签引用
  // 2. 删除孤立任务（无项目、无标签、无父任务）
  // 3. 清理任务重复配置
  // 4. 清理时间跟踪状态
  return updatedState; // 一次传递完成所有更改
},
```

### 正在使用的 Meta-Reducer

| Meta-Reducer                      | 用途                                     |
| --------------------------------- | ---------------------------------------- |
| `tagSharedMetaReducer`            | 标签删除清理（任务、重复配置、时间跟踪） |
| `projectSharedMetaReducer`        | 项目删除清理                             |
| `taskSharedCrudMetaReducer`       | 任务 CRUD（含标签/项目更新）             |
| `taskSharedLifecycleMetaReducer`  | 任务生命周期（归档、恢复）               |
| `taskSharedSchedulingMetaReducer` | 任务排程（含今日标签更新）               |
| `plannerSharedMetaReducer`        | 规划器日管理                             |
| `taskRepeatCfgSharedMetaReducer`  | 重复配置删除（含任务清理）               |
| `issueProviderSharedMetaReducer`  | 问题提供者更新                           |
| `operationCaptureMetaReducer`     | 捕获 before/after 状态，排入实体变更队列 |

## F.3 多实体操作捕获

`OperationCaptureService` 和 `operation-capture.meta-reducer` 使用**简单的 FIFO 队列**协作捕获动作：

1. **动作后**：Meta-reducer 使用 action 调用 `OperationCaptureService.enqueue()`
2. **Effect 处理**：Effect 调用 `OperationCaptureService.dequeue()` 获取实体变更
3. **结果**：包含 action payload 和可选的 `entityChanges[]` 数组的单个操作

FIFO 队列之所以有效，是因为 NgRx reducer 顺序处理动作，而 effects 使用 `concatMap` 进行顺序处理。入队和出队之间的顺序得以保持。

**注意**：大多数动作返回空的 `entityChanges[]`——action payload 足以进行重放。只有 TIME_TRACKING 和 TASK 时间同步动作有特殊处理，可以从 action payload 中提取实体变更。

\`\`\`
用户操作（例如删除标签）
│
▼
tagSharedMetaReducer（+ 其他 meta-reducer）
├──► 原子性地更新所有相关实体
│
▼
功能 Reducers
│
▼
operation-capture.meta-reducer
├──► 调用 OperationCaptureService.enqueue(action)
│ └──► 从 action payload 提取实体变更（针对特殊情况）
│ └──► 推入 FIFO 队列
│
▼
OperationLogEffects
├──► 调用 OperationCaptureService.dequeue() 获取实体变更
└──► 创建包含 action payload 的单个 Operation

## F.4 何时使用 Meta-Reducer vs Effect

| 场景                      | 使用 Meta-Reducer | 使用 Effect |
| ------------------------- | ----------------- | ----------- |
| 更新 store 中的相关实体   | ✅                | ❌          |
| 删除实体及其清理          | ✅                | ❌          |
| UI 通知（snackbar、音效） | ❌                | ✅          |
| 外部 API 调用             | ❌                | ✅          |
| 归档操作（异步 I/O）      | ❌                | ✅          |
| 导航/路由                 | ❌                | ✅          |

**经验法则**：如果修改 NgRx 状态，使用 meta-reducer。如果是副作用（I/O、UI、外部），使用带有 `LOCAL_ACTIONS` 的 effect。

## F.5 看板式混合模式

对于实体之间的引用（例如 `tag.taskIds`），我们使用"看板式"模式，其中：

- **真相源**：子实体的引用（例如 `task.tagIds`）
- **派生列表**：父实体的列表（例如 `tag.taskIds`）仅用于排序

选择器从真相源重新计算成员关系，提供自愈能力：

```typescript
// work-context.selectors.ts
export const computeOrderedTaskIdsForTag = (
  tag: Tag,
  allTasks: Dictionary<Task>,
): string[] => {
  // 使用 tag.taskIds 排序，但按实际 task.tagIds 成员关系过滤
  const validFromTagList = tag.taskIds.filter((id) => {
    const task = allTasks[id];
    return task && !task.parentId && task.tagIds.includes(tag.id);
  });

  // 添加任何引用此标签但不在列表中的任务
  const missingTasks = Object.values(allTasks).filter(
    (task) =>
      task &&
      !task.parentId &&
      task.tagIds.includes(tag.id) &&
      !tag.taskIds.includes(task.id),
  );

  return [...validFromTagList, ...missingTasks.map((t) => t.id)];
};
```

这确保了过期的引用被过滤掉，缺失的引用被自动添加。

## F.6 新功能指南

添加新实体或关系时：

1. **识别必须一起变更的相关实体**
2. **创建或扩展 meta-reducer** 以处理原子更新
3. **将动作添加到 `ACTION_AFFECTED_ENTITIES`** 在 `state-change-capture.service.ts` 中
4. **在 effects 中使用 `LOCAL_ACTIONS`** 仅用于副作用
5. **考虑看板式模式**用于父子列表引用

---

# 源码索引

## Part A：本地持久化

### 已完成 ✅

- SUP_OPS IndexedDB 存储（ops + state_cache）
- 带 isPersistent 模式的 NgRx effect 捕获
- 快照 + 尾部重放的水合机制
- 多标签页 BroadcastChannel 协调
- Web Locks + localStorage 回退
- 来自旧版数据的创世迁移
- 7 天保留窗口的压缩机制
- 来自旧版 'pf' 数据库的灾难恢复
- Schema 迁移服务基础设施（尚未定义迁移）
- 所有模型动作上的持久化动作元数据
- 持久化失败时的回滚通知（显示带有重新加载操作的 snackbar）
- 水合优化（跳过 SyncImport 重放，重放超过 10 个操作后保存快照）
- **迁移安全备份（A.7.12）** - 迁移前创建备份，失败时恢复
- **尾部操作迁移（A.7.13）** - 在水合期间、重放前迁移操作
- **统一迁移接口（A.7.15）** - `SchemaMigration` 包含 `migrateState` 和可选的 `migrateOperation`
- **持久化压缩计数器** - 计数器存储在 `state_cache` 中，跨标签页/重启共享
- **`syncedAt` 索引** - ops store 上的索引，加速 `getUnsynced()` 查询
- **配额处理** - 在 `QuotaExceededError` 时进行紧急压缩，带断路器防止无限循环

### 未实现 ⚠️

| 项目                 | 章节   | 缺少时的风险                | 何时关键                                |
| -------------------- | ------ | --------------------------- | --------------------------------------- |
| **冲突感知操作迁移** | A.7.11 | 冲突可能比较不匹配的 schema | 在任何重命名/移除字段的 schema 迁移之前 |

> **注意**：A.7.11 是跨版本同步所必需的。目前安全，因为 `CURRENT_SCHEMA_VERSION = 1`（所有客户端版本相同）。参见 [A.7.11 临时防护措施](#interim-guardrails-until-implementation) 了解预发布检查清单。

## Part B：旧版同步桥接

### 已完成 ✅

- `PfapiStoreDelegateService`（读取所有 NgRx 模型用于同步）
- META_MODEL 向量时钟更新（B.2）
- 通过 `hydrateFromRemoteSync()` 的同步下载持久化（B.3）
- NgRx 中的所有模型（无混合持久化）
- 同步期间跳过 META_MODEL 更新（防止锁错误）

## Part C：服务器同步

### 已完成 ✅（单版本）

- 操作同步协议接口（`OperationSyncCapable`）
- `OperationLogSyncService`（编排、processRemoteOps、detectConflicts）
- `OperationLogUploadService`（API 上传 + 基于文件的回退、批处理）
- `OperationLogDownloadService`（API 下载 + 基于文件的回退、分页）
- 实体级冲突检测（向量时钟比较）
- `ConflictResolutionService`（LWW 自动解决 + 批量应用）
- `VectorClockService`（全局/实体前沿跟踪、压缩恢复）
- `DependencyResolverService`（提取/检查硬/软依赖）
- `OperationApplierService`（缺失依赖时快速失败 → 抛出 `SyncStateCorruptedError`）
- 被拒绝操作跟踪（`rejectedAt` 字段 + 用户通知）
- 新客户端安全检查（防止空客户端覆盖服务器）
- 下载期间的内存限制（`MAX_DOWNLOAD_OPS_IN_MEMORY = 50,000`）
- 集成测试套件（`sync-scenarios.integration.spec.ts`）
- E2E 测试基础设施（`supersync.spec.ts`，使用 Playwright）
- **端到端加密**（2025 年 12 月）：
  - `OperationEncryptionService` 用于 payload 加密/解密
  - AES-256-GCM 配合 Argon2id 密钥派生
  - 每个提供者可选的加密密码
  - 参见 [supersync-encryption-architecture.md](./supersync-encryption-architecture.md)
- **服务端安全加固**（2025 年 12 月）：
  - 结构化审计日志记录安全事件
  - 上传结果的结构化错误码（`SYNC_ERROR_CODES`）
  - 下载操作的间隙检测
  - 请求 ID 去重，实现幂等上传
  - 下载操作的事务隔离
  - 实体类型允许列表，防止注入
  - 操作 ID、实体 ID 和 schema 版本的输入验证
  - 服务端冲突检测
  - 向量时钟净化
  - 插件数据的速率限制和大小验证
  - JWT 密钥最小长度验证（32 字符）
  - 批量清理查询（替换了 N+1 模式）
  - `(user_id, received_at)` 数据库索引，用于清理查询

> **跨版本限制**：Part C 对于相同 schema 版本的客户端已完成。当 `CURRENT_SCHEMA_VERSION > 1` 且客户端运行不同版本时，需要 A.7.11（冲突感知操作迁移）来确保正确的冲突检测。

## Part D：验证与修复

### 已完成 ✅

- 写入时的载荷验证（检查点 A——写入 IndexedDB 前的结构验证）
- 水合期间的状态验证（检查点 B 和 C——Typia + 跨模型验证）
- 同步后验证（检查点 D——应用远程操作后的验证）
- REPAIR 操作类型（带完整状态 + 修复摘要的自动修复）
- ValidateStateService（Typia 验证 + dataRepair() 集成）
- RepairOperationService（创建 REPAIR 操作 + 用户通知）
- 修复时的用户通知（包含问题计数的 snackbar）
- 带有 `isRepairInProgress` 标志的无限循环防护

---

# 未来增强功能 🔮

| 组件      | 描述                     | 优先级 | 备注                                                  |
| --------- | ------------------------ | ------ | ----------------------------------------------------- |
| 自动合并  | 对非冲突字段进行自动合并 | 低     |                                                       |
| 撤销/重做 | 利用 op-log 实现撤销历史 | 低     |                                                       |
| 墓碑机制  | 带保留窗口的软删除       | 中     | 2025 年 12 月推迟——当前安全措施已足够（详见 todo.md） |
| A.7.11    | 冲突感知操作迁移         | 高     | `CURRENT_SCHEMA_VERSION > 1` 时跨版本同步所必需       |

> **最近已完成（2025 年 12 月）：**
>
> - **服务器同步（SuperSync）**：完整上传/下载基础设施，包含冲突检测、用户解决方案 UI 和集成测试
> - **端到端加密**：通过 `OperationEncryptionService` 实现 AES-256-GCM 载荷加密及 Argon2id 密钥派生
> - **服务器安全加固**：审计日志、结构化错误码、请求去重、事务隔离、输入验证、速率限制
> - **统一归档处理**：`ArchiveOperationHandler` 现在是所有归档操作的唯一真相源，由本地 effects 和远程操作应用共同使用
> - **简化的 OperationCaptureService**：重构为 FIFO 队列，配合引用相等性优化检测已变更的功能状态
> - **简化的 OperationApplierService**：重构为快速失败方法——缺少硬依赖时抛出 `SyncStateCorruptedError`（无重试队列）
> - **标签清理**：删除父任务时从标签中移除子任务 ID，同步时过滤不存在的 taskIds
> - **基于锚点的移动操作**：所有任务拖放移动现在使用 `afterTaskId` 而非完整列表替换（包括子任务移动）
> - **配额处理**：`QuotaExceededError` 时进行紧急压缩和断路器保护
> - **`syncedAt` 索引**：加速 `getUnsynced()` 查询
> - **持久化压缩计数器**：跨标签页/重启跟踪操作计数
> - **插件数据同步**：插件用户数据和元数据的操作日志记录
> - **间隙检测**：下载操作检测并报告序列间隙
> - **服务端冲突检测**：防止服务端的并发修改
> - **压缩竞态安全**：安全检车——若快照期间写入了新操作则中止删除
> - **meta-reducer 中的实体验证**：改进的 getTag/getProject 辅助函数，包含验证和安全变体
> - **deleteTasks 中的项目清理**：handleDeleteTasks 现在清理项目的 taskIds/backlogTaskIds
> - **归档验证**：archiveOld 任务现在验证项目/标签引用，添加了 null 安全检查
> - **锁服务鲁棒性**：在回退锁中处理 NaN 时间戳和无效锁格式
> - **数组载荷拒绝**：显式检查拒绝数组（会绕过 `typeof === 'object'`）
> - **待处理操作过期**：待处理超过 24 小时的操作被拒绝而非重放（PENDING_OPERATION_EXPIRY_MS）

---

# 文件结构：操作日志服务

```
src/app/op-log/
├── operation.types.ts                        # 类型定义（Operation、OpType、EntityType）
├── operation-log.const.ts                    # 常量（阈值、超时、限制）
├── operation-log.effects.ts                  # 动作捕获 + META_MODEL 桥接
├── operation-converter.util.ts               # Op ↔ Action 转换
├── persistent-action.interface.ts            # PersistentAction 类型 + isPersistentAction 守卫
├── entity-key.util.ts                        # 实体键生成工具
├── store/
│   ├── operation-log-store.service.ts        # SUP_OPS IndexedDB 封装
│   ├── operation-log-hydrator.service.ts     # 启动水合（快照 + 尾部重放）
│   ├── operation-log-compaction.service.ts   # 快照 + 清理 + 紧急模式
│   ├── operation-log-manifest.service.ts     # 基于文件的同步清单管理
│   ├── operation-log-migration.service.ts    # 来自旧版的创世迁移
│   └── schema-migration.service.ts           # 状态 schema 迁移
├── sync/
│   ├── operation-log-sync.service.ts         # 编排（Part C）
│   ├── operation-log-download.service.ts     # 下载操作（API + 文件回退）
│   ├── operation-log-upload.service.ts       # 上传操作（API + 文件回退）
│   ├── operation-encryption.service.ts       # E2EE payload 加密（AES-256-GCM）
│   ├── vector-clock.service.ts               # 全局/实体前沿跟踪
│   ├── lock.service.ts                       # 跨标签页锁定（Web Locks + 回退）
│   ├── conflict-resolution.service.ts        # LWW 冲突解决 + 用户通知
│   ├── sync-import-filter.service.ts         # 过滤被 SYNC_IMPORT 无效化的操作
│   ├── immediate-upload.service.ts           # 在关键操作上触发立即同步
│   ├── super-sync-status.service.ts          # SuperSync 连接状态跟踪
│   ├── server-migration.service.ts           # 服务端 schema 迁移处理
│   ├── operation-write-flush.service.ts      # 批量写入操作（带刷新）
│   └── operation-sync.util.ts                # 同步辅助工具
├── processing/
│   ├── operation-applier.service.ts          # 应用操作（带快速失败依赖处理）
│   ├── operation-capture.service.ts          # 捕获实体变更的 FIFO 队列
│   ├── operation-capture.meta-reducer.ts     # 用于 before/after 状态捕获的 meta-reducer
│   ├── hydration-state.service.ts            # 跟踪水合/远程操作应用状态
│   ├── archive-operation-handler.service.ts  # 归档副作用的统一处理器
│   ├── archive-operation-handler.effects.ts  # 将本地动作路由到 ArchiveOperationHandler
│   ├── validate-state.service.ts             # Typia + 跨模型验证
│   ├── validate-operation-payload.ts         # 检查点 A——载荷验证
│   └── repair-operation.service.ts           # REPAIR 操作创建
├── integration/                              # 集成测试套件
│   ├── sync-scenarios.integration.spec.ts    # 协议级同步测试
│   ├── multi-client-sync.integration.spec.ts # 多客户端场景
│   ├── state-consistency.integration.spec.ts # 状态验证测试
│   └── helpers/                              # 测试工具
│       ├── mock-sync-server.helper.ts        # 用于测试的服务器模拟
│       ├── simulated-client.helper.ts        # 客户端模拟
│       ├── test-client.helper.ts             # 测试客户端工具
│       └── operation-factory.helper.ts       # 测试操作构建器
└── benchmarks/
    └── operation-log-stress.spec.ts          # 性能压力测试

src/app/features/work-context/store/
├── work-context-meta.actions.ts          # 移动操作（moveTaskInTodayList 等）
└── work-context-meta.helper.ts           # 基于锚点的定位辅助工具

src/app/op-log/sync-providers/
├── super-sync/                           # SuperSync 服务器提供者
│   ├── super-sync.ts                     # 基于服务器的同步实现
│   └── super-sync.model.ts               # SuperSync 类型定义
├── file-based/                           # 基于文件的提供者（Part B）
│   ├── file-based-sync-adapter.service.ts  # 文件提供者的统一适配器
│   ├── file-based-sync.types.ts          # FileBasedSyncData 类型
│   ├── webdav/                           # WebDAV 提供者
│   ├── dropbox/                          # Dropbox 提供者
│   └── local-file/                       # 本地文件同步提供者
├── provider-manager.service.ts           # 提供者激活/管理
├── wrapped-provider.service.ts           # 带加密的提供者包装器
└── credential-store.service.ts           # OAuth/凭据存储

e2e/
├── tests/sync/supersync.spec.ts          # E2E SuperSync 测试（Playwright）
├── pages/supersync.page.ts               # 同步测试的页面对象
└── utils/supersync-helpers.ts            # E2E 测试工具
```

---

# 参考文献

- [操作规则](./operation-rules.md) - 载荷和验证规则
- [贡献者同步模型](./contributor-sync-model.md) - effects、reducers 和批量派发的单一不变性
- [SuperSync 加密](./supersync-encryption-architecture.md) - 端到端加密实现
- [向量时钟](./vector-clocks.md) - 向量时钟实现细节
