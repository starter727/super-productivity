# 操作日志架构深度分析

> 基于 [operation-log-architecture.md](../../docs/sync-and-op-log/operation-log-architecture.md) Part A/B 的深度技术分析。
> 涵盖 IndexedDB 结构、写入路径、读取路径（水合）、压缩、O(N) 权衡、LOCAL_ACTIONS、灾难恢复、Schema 迁移、文件型同步完整流程、向量时钟与 Gap 检测等。

---

## 1. IndexedDB Structure 是什么

应用的整个本地数据库结构。所有数据都存在一个叫 `SUP_OPS` 的 IndexedDB 数据库里，6 张表：

| 表名              | 干什么                     | 类比       |
| ----------------- | -------------------------- | ---------- |
| **ops**           | 操作日志，只追加不修改     | 交易流水账 |
| **state_cache**   | 定期存档的完整状态快照     | 游戏存档点 |
| **meta**          | 向量时钟、同步状态等元数据 | 系统配置   |
| **archive_young** | 最近归档的任务（~30天内）  | 近期回收站 |
| **archive_old**   | 很久以前归档的任务         | 深度备份   |
| **client_id**     | 当前设备的同步身份标识     | 设备身份证 |

关键：**所有应用数据都在这个库里**，不存在其他地方。以前的 `pf` 数据库（旧版遗留）已废弃，全部迁移到 `SUP_OPS`。

---

## 2. StateCache 表干什么的

`state_cache` 是快照表，用来加速应用启动。

操作日志是追加写的，如果每次启动都从第一条操作开始重放，几千条操作会太慢。`state_cache` 存一个"存档点"：

- `state` — 某个时间点的完整应用状态
- `lastAppliedOpSeq` — 这个快照包含了到第几号操作
- `vectorClock` — 当时的向量时钟
- `compactedAt` — 快照创建时间
- `schemaVersion` — 数据模型版本（用于迁移）

启动时：加载快照 → 只重放快照之后的少量操作 → 恢复到最新状态。

### lastAppliedOpSeq 的 seq 到底是什么

系统里有三个容易混淆的"序号"，各管各的，互不参与：

| 序号            | 存在哪              | 是什么                   | 用途                                                |
| --------------- | ------------------- | ------------------------ | --------------------------------------------------- |
| `seq`（ops 表） | 本地 IndexedDB      | 本地 ops 表的自增主键    | 启动水合：`WHERE seq > lastAppliedOpSeq` 拿尾部操作 |
| `syncVersion`   | sync-data.json 文件 | 文件版本号，每次上传 +1  | 文件型同步的乐观锁 + gap 检测                       |
| `serverSeq`     | 服务器数据库        | 服务器分配的全局递增序号 | 服务器同步的排序 + 分页下载                         |

`lastAppliedOpSeq` 记录在 `state_cache` 表里，值等于快照时 ops 表的最大 `seq`。它**只用于启动水合**——和本地的 `seq` 比较，拿到快照之后的尾部操作来重放。

它**不参与 gap 检测**。gap 检测用的是 `syncVersion`（文件版本号）和 `oldestOpSyncVersion`（recentOps 里最老操作被写入文件时的 syncVersion）。`sinceSeq`（客户端上次下载到的文件版本号）也是 `syncVersion`，存在 `_localSeqCounters` 里。

```
本地 IndexedDB（同一台设备）：
  ops 表：seq = 1, 2, 3, ... 500
  state_cache：lastAppliedOpSeq = 480
  → 启动时重放 481-500（纯本地，不涉及其他客户端）

文件型同步：
  sync-data.json：syncVersion = 42
  客户端本地：sinceSeq = 38（上次下载到第 38 版文件）
  oldestOpSyncVersion = 36
  → 36 ≤ 38 → 没有 gap（纯文件版本号比较，不涉及 ops seq）

服务器同步：
  客户端本地：lastServerSeq = 1000
  服务器：最大 serverSeq = 1050
  → 下载 1001-1050（纯服务器序号，不涉及本地 seq）
```

**三个序号永远不会互相比较。** 跨客户端同步时用 `syncVersion` 或 `serverSeq`，本地水合时用 `seq`。

---

## 3. A.2 Write Path 详解

写入路径就是**用户做一个操作，数据怎么落盘的**。

```
用户点了个勾 → NgRx dispatch 一个 action
         │
         ├── Reducer 先更新内存状态（乐观更新，用户立刻看到变化）
         │
         └── OperationLogEffects 拦截这个 action
                   │
                   ├── 过滤1: action.meta.isPersistent === true?
                   │         不是 → 跳过（UI操作、临时状态不落盘）
                   │
                   ├── 过滤2: action.meta.isRemote === true?
                   │         是 → 跳过（从别的设备同步来的不重复记录）
                   │
                   ├── 把 action 包装成 Operation 对象
                   │
                   ├── 写入 IndexedDB 的 ops 表（磁盘）
                   │
                   ├── 递增向量时钟
                   │
                   └── 广播给其他浏览器标签页
```

两个过滤条件是关键：

- `isPersistent` — 不是所有 action 都需要存。切换侧边栏、选中任务这种纯 UI 操作不存
- `isRemote` — 从别的设备同步来的操作已经存过了，不能再存一次，否则会无限循环

Operation 对象长什么样：

```typescript
{
  id: "019a3f2c-...",       // UUID v7（自带时间排序）
  actionType: "[Task] Update",
  opType: "UPD",             // CRT/UPD/DEL/MOV/BATCH/SYNC_IMPORT/REPAIR
  entityType: "TASK",
  entityId: "task-abc",
  payload: { changes: { isDone: true } },
  clientId: "device-xyz",    // 哪台设备
  vectorClock: { "device-xyz": 42 },
  timestamp: 1717500000000,
  schemaVersion: 1
}
```

靠 `meta.isPersistent: true` 显式标记哪些 action 要落盘，不是猜的。

---

## 4. A.3 Read Path (Hydration) 详解

### 为什么叫"水合"

Hydration 借自 Web 开发（React/Next.js）。化学里 hydrate 是"加水使固体恢复活性"，技术上比喻**把静态的磁盘数据"激活"到内存中，让应用活过来**。

### 启动流程

```
应用启动
    │
    ▼
从 state_cache 加载最新快照（存档点）
    │
    ├── 没有快照？→ 从旧版 pf 数据库迁移（首次升级的用户）
    │
    ├── 快照的 schemaVersion 和当前版本不一致？→ 跑迁移脚本升级
    │
    ▼
把快照的完整状态 dispatch 到 NgRx Store
    │
    ▼
查 ops 表：WHERE seq > 快照的 lastAppliedOpSeq
（拿到快照之后的操作，叫"尾部操作"）
    │
    ├── 最后一条操作是 SYNC_IMPORT？
    │         → 直接用它的状态，不重放（最快）
    │
    ├── 否则：逐条重放尾部操作到 Store
    │
    └── 如果重放了超过 10 条？
              → 存一个新快照，下次启动更快
```

### 为什么 SyncImport 是最后一条就不需要重放

SYNC_IMPORT 包含完整的应用状态。如果它是最后一条，后面没有操作了，直接用它的 payload 就行，不需要重放任何东西。

但如果 SYNC_IMPORT 不是最后一条：

```
op1: SYNC_IMPORT
op2: 创建任务C    ← 这条在 SYNC_IMPORT 之后，必须重放
op3: 修改任务C
```

还是要重放 op2、op3。

### 自动保存快照

重放超过 10 条操作后，自动存一份新快照。下次启动时尾部操作更少，启动更快。用得越多，启动越快。

---

## 5. A.4 压缩（Compaction）Process

### 流程

```
每 500 条操作触发一次压缩
    │
    ▼
① 加锁（Web Locks API，防止多标签页同时压缩）
    │
    ▼
② 从 NgRx Store 读取当前完整状态
    │
    ▼
③ 存一份新快照到 state_cache
    │
    ▼
④ 删除旧操作
   条件：syncedAt 有值（已同步） AND appliedAt < 7天前
    │
    ▼
⑤ 释放锁
```

### 删除条件

```
能删的：  syncedAt ✅  AND  超过7天 ✅  → 删掉，反正快照里已经有了
不能删的：syncedAt ❌（还没同步）       → 无论多久都不删
不能删的：syncedAt ✅  AND  7天内 ✅   → 保留
```

未同步的绝对不删，因为删了就没法上传给其他设备。

### 加锁防止什么

防止多个浏览器标签页同时压缩。加锁后同一时刻只有一个标签页能执行压缩。

### 读 NgRx Store 会冻 UI 吗

读内存不会（几毫秒）。真正可能卡的是 `JSON.stringify` 序列化那一步，但压缩每 500 条才触发一次，代价可以接受。

---

## 6. 压缩的 O(N) 和 Delta Sync 的 O(N) 有什么区别

两者都有 `JSON.stringify` 的 O(N) 开销，区别在于**频率**：

```
Delta Sync（被拒绝）：
  用户改1个任务 → 触发同步 → stringify 全部1万个任务 → 冻UI
  频率：每个用户操作都触发，一天可能几百次

Op-log 压缩：
  攒了 500 条操作 → stringify 一次 → 冻一次
  频率：每 500 条操作才触发，一天可能一两次
```

不是说 Op-log 完全不冻，而是**把冻的次数从每天几百次降到了每天一两次**。Delta Sync 没法绕过 stringify（必须对比两个快照才知道变了什么），Op-log 不需要对比，操作本身就是差异。

---

## 7. A.6 LOCAL_ACTIONS Token

### 为什么需要

远程同步来的操作（`isRemote: true`）dispatch 到 NgRx 时，effects 不应该执行副作用（弹通知、调外部 API、播放声音等），因为这些副作用在原始设备上已经执行过了。

### 怎么用

```typescript
// 错误：所有操作都触发
private _actions$ = inject(Actions);

// 正确：只触发本地操作
private _localActions$ = inject(LOCAL_ACTIONS);
```

### 什么时候用

| 场景            | 用 LOCAL_ACTIONS? | 原因                   |
| --------------- | ----------------- | ---------------------- |
| 弹通知          | ✅                | 原始设备已经弹过了     |
| 调 Jira API     | ✅                | 原始设备已经调过了     |
| 播放声音        | ✅                | 本地才需要             |
| 更新 Store 状态 | ❌                | 远程操作也需要更新状态 |

---

## 8. A.7 Disaster Recovery

灾难恢复就是**数据库坏了怎么办**。

```
应用启动 → 加载 state_cache
    │
    ├── 加载失败或数据无效？
    │
    ▼
attemptRecovery() 按优先级逐个尝试：
    │
    ├── ① 从 state_cache 的备份快照恢复（压缩时保留的上一份）
    │
    ├── ② 从旧版 pf 数据库恢复
    │
    ├── ③ 从远程同步恢复（从服务器下载完整数据）
    │
    └── ④ 全部失败 → 报错给用户，让用户手动恢复备份
```

---

## 9. A.7 Schema Migrations

### 核心概念

当应用升级改了数据结构（加字段、改名、删功能），怎么让旧数据还能用。

```
CURRENT_SCHEMA_VERSION = 1   ← 每改一次 +1
MIGRATIONS = []              ← 迁移函数列表（目前空）
```

### 迁移触发点

| 场景                        | 怎么处理                   |
| --------------------------- | -------------------------- |
| 启动时快照是旧版本          | 迁移快照，重放尾部操作     |
| 收到旧版本的操作            | 直接应用（大多数情况够用） |
| 收到旧版本的 SYNC_IMPORT    | 先迁移再加载               |
| 收到太新的版本（超5个版本） | 拒绝，提示用户更新         |

### 什么时候需要迁移操作

| 改动类型   | 需要迁移状态？ | 需要迁移操作？ |
| ---------- | -------------- | -------------- |
| 加可选字段 | ✅             | ❌             |
| 改字段名   | ✅             | ✅             |
| 删功能     | ✅             | ✅             |
| 改字段类型 | ✅             | ✅             |

规律：只加东西不需要迁移操作，改名/删东西才需要。

### 跨版本同步

**接收端负责迁移**，发送端不用管。操作永远先迁移到当前版本，再做冲突检测。

---

## 10. FileBasedSyncData 每个字段干什么

文件型同步（WebDAV/Dropbox/LocalFile）的 `sync-data.json` 结构：

| 字段            | 干什么                                         |
| --------------- | ---------------------------------------------- |
| `version`       | 文件格式版本号（硬编码 2）                     |
| `schemaVersion` | 数据模型版本（迁移系统那个）                   |
| `vectorClock`   | 整个文件的向量时钟                             |
| `syncVersion`   | 乐观锁，每次上传 +1，用于检测并发修改          |
| `lastSeq`       | 最后一条操作的序号                             |
| `lastModified`  | 最后修改时间（给人看的，不参与逻辑）           |
| `state`         | 完整应用状态，占文件 95% 体积                  |
| `recentOps`     | 最近 200 条操作（压缩版），占 5%，用于冲突检测 |
| `checksum`      | 校验和，验证传输有没有损坏                     |

### syncVersion 乐观锁

```
设备A：读到 syncVersion = 5，改了，想上传
设备B：也读到 5，先上传了 → syncVersion 变成 6
设备A：上传时发现 5 ≠ 6 → 不能直接覆盖，要先下载合并
```

---

## 11. 文件型同步完整流程

### 上传流程

```
① 下载远程文件（或用30秒缓存）
    │
    ▼
② 构建合并数据
   - 从 NgRx 拿完整状态（getStateSnapshot()）← O(N) 在这里
   - 从 IndexedDB 拿归档数据
   - 合并 recentOps（旧的 + 新的，保留最近200条）
   - 合并向量时钟
   - syncVersion + 1
    │
    ▼
③ 加密 + 压缩 + 上传
   - 成功 → 完成
   - 版本冲突 → 重新下载，确认是否真的有并发上传
```

### 下载流程

```
① 下载远程文件
    │
    ▼
② 检测是否有 gap（操作丢失）
    │
    ▼
③ 有 gap → 返回完整快照，整个替换
   没 gap → 返回 recentOps，增量更新
```

### 一次完整同步周期

```
触发同步 → 下载 → 合并/冲突检测 → 上传
```

---

## 12. state 是怎么达成共识的

**不是投票，是操作的并集。**

```
设备A 有的操作：{op480, ..., op500}
设备B 有的操作：{op480, ..., op495}
合并后：        {op480, ..., op500}  ← 并集

用并集重新计算 state → 大家的 state 一样了
```

state 和 recentOps 的关系：

- state 已经包含了 recentOps 的效果
- recentOps 带着是为了冲突检测，不是为了计算 state
- 对方拿到 state 后，用 recentOps 检查"你改了什么"，判断有没有冲突

下载时是**整个替换 state**，不是拿 recentOps 来补：

- B 下载 A 的文件 → 直接用 A 的 state 替换 B 的 state
- B 的旧 state 被丢弃
- recentOps 只用于冲突检测

---

## 13. Gap 检测详解

### sinceSeq 和 oldestOpSyncVersion 都是什么

**都是文件版本号（syncVersion），不是操作序号。**

- `sinceSeq` — "我上次下载到了第几版文件"。客户端本地记住的上次同步到的文件版本号
- `oldestOpSyncVersion` — "文件里最老的操作是在第几版文件里被写进来的"。每个操作被写进文件时会打上当时文件的 syncVersion

### 怎么判断 gap

```
sinceSeq = 5（我上次下载到第 5 版）
oldestOpSyncVersion = 3（文件里最老的操作在第 3 版出现的）

→ 3 ≤ 5 → 这个操作我第 5 版时肯定已经见过了 → 没有 gap

────────────────────────────────

sinceSeq = 2（我上次下载到第 2 版）
oldestOpSyncVersion = 4（文件里最老的操作在第 4 版才出现）

→ 4 > 2 → 第 3 版的操作被裁剪了，我永远拿不到了 → gap！→ 用完整 state 替换
```

### syncVersion 为什么会重置

`_uploadSnapshot` 上传快照时会把 syncVersion 重置为 1。比如用户做了"恢复到某个备份"，会上传新快照，syncVersion 重置。

### 三种 gap 触发条件

```
条件A：syncVersion 重置（变小了，比如 10 → 1）
条件B：recentOps 为空但有 state（别人上传了新快照）
条件C：oldestOpSyncVersion > sinceSeq（操作被裁剪了）
```

---

## 14. Piggybacking 和 Gap 的区别

**Piggybacking** 发生在上传阶段：别人先上传了 → 重新下载合并再上传。没有操作丢失。

**Gap** 发生在下载阶段：操作被裁剪了，追不上了。需要用完整 state 替换。

|              | Piggybacking       | Gap               |
| ------------ | ------------------ | ----------------- |
| 发生在       | 上传阶段           | 下载阶段          |
| 原因         | 别人先上传了       | 操作被裁剪了      |
| 操作有没有丢 | 没有               | 有                |
| 处理方式     | 重新下载合并再上传 | 用完整 state 替换 |

---

## 15. recentOps 缓冲区 200 条会不会导致频繁全量同步

会。如果 A 和 B 是重度用户，C 一个月才同步一次，C 很可能每次都全量同步。

但代价可以接受：全量同步就是下载一个几 MB 的文件。当前设计的思路是 200 条缓冲区覆盖大多数用户的大多数同步场景，极端落后的用全量兜底。

---

## 16. 为什么要拿归档数据

因为 `getStateSnapshot()` 拿的是 NgRx Store 里的数据，但归档数据**不在 NgRx 里**：

```
NgRx Store（内存）：活跃任务、项目、配置……
IndexedDB archive_young：最近归档的任务
IndexedDB archive_old：很久以前归档的任务
```

归档不在 NgRx 里是为了性能——归档可能有几万条任务，放 NgRx 里会拖慢启动和内存。所以构建同步文件时要额外从 IndexedDB 加载归档数据。

---

## 相关文档

- [Operation Log Architecture](../../docs/sync-and-op-log/operation-log-architecture.md) — 英文源文档
- [被拒绝的备选方案深度分析](./rejected-alternatives-deep-dive.md) — 为什么选操作日志
- [NgRx + IndexedDB vs MySQL + Redis](./frontend-state-management/ngrx-indexeddb-vs-mysql-redis.md) — 前端状态管理架构对比
