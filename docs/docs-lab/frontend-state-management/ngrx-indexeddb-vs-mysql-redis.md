# NgRx + IndexedDB vs MySQL + Redis：前端与后端状态管理架构对比

## 概述

在 Super Productivity 中，状态管理使用 **NgRx（内存 Store）+ IndexedDB（SUP_OPS 数据库）** 组合。这与后端常见的 **MySQL（持久化数据库）+ Redis（内存缓存）** 组合在角色上看似相似——都是"持久层 + 内存层"——但实际面临的挑战完全不同。

本文将两者进行系统性对比，分析后端分布式架构中的高频痛点为何在前端单用户环境中大幅减弱或消失；同时深入剖析 Super Productivity 的真实执行链路、不一致窗口的四层防护、JavaScript 事件循环的影响，以及 `flushPendingWrites` 两阶段设计背后的工程权衡。

---

## 一、架构形态的根本差异

### MySQL + Redis（后端）

```
┌──────────┐     ┌──────────┐
│  App     │────▶│  Redis   │ ← 独立进程，网络连接，可被所有请求独立写入
│  Server  │     └──────────┘
│          │     ┌──────────┐
│          │────▶│  MySQL   │ ← 独立进程，网络连接，可被所有请求独立写入
└──────────┘     └──────────┘
       ▲
   两条独立写入路径，各自可能成功/失败/乱序
   数千并发连接共享同一数据
```

**核心特征：** 多用户共享 + 分布式网络 + 多线程并发。

### NgRx + IndexedDB（前端）

实际执行链路（详见第四节）是**三段式异步**，不是简单的同步调用：

```
用户操作 → Action 派发
              │
              ▼
  ┌─────────────────────────────────────────┐
  │  meta-reducer（同步，不可中断）           │
  │                                         │
  │  1. nextReducer(state, action)          │  ← NgRx 先更新（同步）
  │  2. enqueue(action)  // 仅入内存队列     │  ← 不写 IndexedDB（同步）
  │  3. return afterState                   │
  └─────────────────────────────────────────┘
              │
              ▼  （事件循环下一个 tick）
  ┌─────────────────────────────────────────┐
  │  Effect（concatMap 顺序处理，异步）       │
  │                                         │
  │  writeOperation():                      │
  │    → acquire lock                       │
  │    → dequeue()                          │
  │    → 构建 Operation（含向量时钟）         │
  │    → await indexedDB.put(...)           │  ← 写 IndexedDB（异步）
  │    → release lock                       │
  └─────────────────────────────────────────┘
```

**核心特征：** 单用户私有 + 进程内调用 + 单线程事件循环。但 NgRx 更新和 IndexedDB 持久化**不是同一个函数调用**——中间隔着事件循环。这引入了一个不一致窗口，详见第五节。

---

## 二、核心痛点对比

### 1. 双写一致性问题

**MySQL + Redis 的痛点：**

当数据发生修改时，先写 MySQL 还是先更新/删除 Redis？

- 如果先写 MySQL 再更新 Redis，高并发下可能因网络抖动导致 Redis 写入失败，产生脏数据。
- 如果采用"先删 Redis → 写 MySQL → 延迟再删 Redis"等策略，代码逻辑异常复杂。
- 因为它们是两个**独立的、分布在不同网络节点**的系统，无法轻易实现强一致性事务（2PC 等分布式事务开销极大）。

具体场景：

```
应用服务器：
  1. UPDATE tasks SET title='新标题' WHERE id=1  → MySQL 返回 OK ✓
  2. SET task:1:title '新标题'                    → 网络超时 ✗

结果：MySQL 里是"新标题"，Redis 里是"旧标题"——数据不一致。
```

**NgRx + IndexedDB 的情况：**

两者的关系不是"两个独立数据库"，而是**推导关系**：

- IndexedDB 是权威数据源（op-log），NgRx 是其派生状态。
- 没有两条独立的写入路径——只有一条：用户操作 → meta-reducer → 入内存队列 → Effect → 写 IndexedDB。
- 不存在"NgRx 有独立写入 API，IndexedDB 有另一套独立写入 API"的情况。

但也**并非完美无瑕**——真实执行顺序是"先 NgRx，后 IndexedDB（异步）"，因此存在一个不一致窗口：NgRx 已更新但 IndexedDB 尚未写入。这是一个已知且被明确承认的设计权衡，由四层防护兜底（详见第五节）。

**本质区别：** 后端的双写问题是**架构性的**——两条独立网络路径本质不可原子化；前端的窗口是**时序性的**——同一条调用链上的异步延迟，窗口极短且有锁和队列保序。

---

### 2. 并发锁与竞争条件

**MySQL + Redis 的痛点：**

- 数万个连接同时请求修改同一条数据（例如抢购场景）。
- MySQL 需要通过行锁、表锁、乐观锁或分布式锁（利用 Redis `SETNX`）来避免超卖或数据覆盖。
- 锁竞争导致系统吞吐量急剧下降，甚至引发死锁。

并发乱序写入场景：

```
线程A:                         线程B:
  1. 读 MySQL → title='旧'       1. 读 MySQL → title='旧'
  2. 更新 MySQL → 'A改的'         2. 更新 Redis → 'B改的'
  3. 更新 Redis → 'A改的'  ← 后到  3. 更新 MySQL → 'B改的'  ← 先到

结果：MySQL='B改的'，Redis='A改的'（不一致且无法自动修复）
```

**为什么在 NgRx + IndexedDB 中没有了：**

- **JavaScript 单线程：** 同一时间只有一个 Action 被 Reducer 处理。不存在"两个线程交错执行"。
- **单用户私有：** IndexedDB 只有当前用户能够读写。不存在成千上万个并发请求竞争同一条本地数据。
- **concatMap 顺序化：** Effect 用 `concatMap` 逐个处理，等前一个 `writeOperation` 的 Promise resolve 后才处理下一个。并发在入口处就被序列化了。

```
事件循环：
  处理事件1（用户修改任务标题）→ meta-reducer → enqueue → Effect → IndexedDB → 完成
  处理事件2（用户修改任务标签）→ meta-reducer → enqueue → Effect → IndexedDB → 完成

  永远不会："两个事件同时处理，中间步骤互相穿插"
```

**本质：** NgRx 不需要分布式锁，状态更新是绝对线性安全的。

---

### 3. 网络延迟与连接开销

**MySQL + Redis 的痛点：**

- 应用服务器与 MySQL、Redis 之间存在物理网络延迟（毫秒级）。
- 需要维护复杂的连接池（Connection Pool），连接数耗尽会导致服务崩溃。
- 网络抖动可能导致请求超时、重试，引发雪崩效应。

**为什么在 NgRx + IndexedDB 中没有了：**

- **进程内调用：** NgRx 是内存访问（纳秒级）。
- **本地 API：** IndexedDB 是浏览器内核提供的本地数据库，不经过网络协议栈，没有网络丢包和延迟问题。
- **无连接池：** 浏览器内部管理 IndexedDB 连接，不暴露连接池概念给开发者。

---

### 4. 缓存穿透、击穿与雪崩

**MySQL + Redis 的痛点：**

| 问题     | 描述                                                      |
| -------- | --------------------------------------------------------- |
| **击穿** | 某个热点 Key 失效的瞬间，大量请求直奔 MySQL，压垮数据库。 |
| **穿透** | 恶意请求查询不存在的数据，每次都穿透到数据库。            |
| **雪崩** | 大量缓存同时过期，或者 Redis 宕机，流量瞬间涌入 MySQL。   |

**为什么在 NgRx + IndexedDB 中没有了：**

- NgRx 是"当前状态的唯一内存持有者"，不是缓存层。没有 TTL、没有淘汰策略。
- 如果 NgRx 中没有数据 = 整个 tab 未初始化或已崩溃 = 从 IndexedDB 重建，没有"增量回源"概念。
- 数据量是单用户的本地数据，不存在被"并发流量压垮"的物理基础。

**本质：** NgRx 不是"缓存"，它是状态的唯一内存副本。丢了就全量重建。

---

## 三、本质原因：三维降维

| 维度         | MySQL + Redis（后端）                                                  | NgRx + IndexedDB（前端）                                            | 降维带来的效果                                                 |
| :----------- | :--------------------------------------------------------------------- | :------------------------------------------------------------------ | :------------------------------------------------------------- |
| **用户规模** | **多用户共享**（Multi-tenant）。成千上万用户读写同一张表。             | **单用户私有**（Single-tenant）。只有当前浏览器用户操作自己的数据。 | 消除了由于多用户并发引起的所有**锁竞争、死锁和隔离级别**问题。 |
| **网络环境** | **分布式网络**（Distributed）。应用服务器、Redis、MySQL 通过网络连接。 | **进程内调用**（In-process）。内存访问和本地磁盘文件读写。          | 消除了**网络抖动、连接池耗尽、序列化/反序列化延迟**。          |
| **线程模型** | **多线程/多进程并发**。需要处理线程安全、竞态条件。                    | **单线程事件循环**（Event Loop）。JS 引擎单线程顺序执行。           | 数据的修改是线性的、顺序的，**天然避免了多线程死锁**。         |

---

## 四、Super Productivity 真实数据流

### 4.1 正常操作流程（精确执行顺序）

```
用户点击"完成任务"
  │
  ▼
dispatch(completeTask({ id: 1 }))
  │
  ▼  [同步，不可中断 — 同一个 JavaScript call stack]
  │
  │  operationCaptureMetaReducer(state, action):
  │    1. afterState = nextReducer(state, action)     ← t=0：NgRx 状态已变更
  │    2. captureService.enqueue(action)               ← t=0：仅 push 到内存数组
  │    3. return afterState
  │
  ▼  [同步阶段结束，call stack 清空]
  │
  ▼  [事件循环：微任务 → 宏任务]
  │
  │  Effect 被 Actions 流触发
  │    concatMap(action => writeOperation(action)):
  │      → lockService.request(OPERATION_LOG, ...)     ← 获取锁
  │        → dequeue()                                  ← 从内存队列取出
  │        → 构建 Operation 对象                        ← 含向量时钟、clientId
  │        → opLogStore.appendWithVectorClockUpdate()   ← IndexedDB 写入
  │        → immediateUploadService.trigger()           ← 触发上传
  │      → 释放锁
```

**关键认知矫正：** NgRx 更新是同步的、先发生的；IndexedDB 写入是异步的、通过 Effect 后发生的。两者之间有一条内存 FIFO 队列和一把锁做中间协调。

### 4.2 IndexedDB 存储结构：日志 + 快照混合

SUP_OPS 不是纯日志，也不是纯快照，而是**混合模型**：

| 表                              | 内容                                                   |
| ------------------------------- | ------------------------------------------------------ |
| `ops`                           | 操作日志（每条用户操作一行），含 seq/向量时钟/同步状态 |
| `state_cache`                   | 压缩后的全量状态快照（compaction 时写入）              |
| `vector_clock`                  | 当前向量时钟                                           |
| `client_id`                     | 当前设备标识                                           |
| `archive_young` / `archive_old` | 已归档任务                                             |
| `import_backup`                 | 导入前的安全备份                                       |
| `profile_data`                  | 用户 Profile 数据                                      |

### 4.3 启动恢复：快照 + 尾巴回放，非全量重放

```
启动 → 读 state_cache 快照
         │
     快照存在？── 是 → 加载快照 → NgRx 瞬间恢复绝大部分状态
         │                │
         │                └→ 读 ops 表中 seq > 快照.lastAppliedOpSeq 的"尾巴"
         │                      ↓
         │                  回放尾巴（通常几条到几十条）→ 恢复完成 ✅
         │
         否 → 读全部 ops → 从头全量回放（仅首次启动/快照损坏时）
```

**Compaction 的职责：** 每写入一定数量操作后触发——获取当前 NgRx 全量状态 → 经过 `hasMeaningfulStateData()` 空状态守卫 → 写入 `state_cache` 快照 → 删除 ops 中"已同步 + 超过 7 天 + seq ≤ 快照序号"的旧日志。

ops 表永远只保留最近 7 天的已同步操作 + 全部未同步操作。不会出现"几万条全量重放"的情况。

### 4.4 同步流程

```
上传：从 ops 读取未同步条目 → 批量上传到云端 → 标记 syncedAt
下载：云端拉取远程 op-log → 写入 ops → 回放到 NgRx → 更新向量时钟
```

---

## 五、不一致窗口与四层防护

### 5.1 窗口在哪

```
t=0:  meta-reducer 返回 → NgRx 状态已变更 ✅
      队列中有待处理条目
      IndexedDB 尚未写入 ❌

t=~50ms: Effect 完成 IndexedDB 写入 ✅
         窗口关闭
```

如果浏览器在 t=0 到 t=~50ms 之间崩溃，那条操作永久丢失（NgRx 的变更有，但 IndexedDB 没有记录）。这是一个**已知且被明确承认的设计局限**，代码注释写得很直白（`operation-capture.meta-reducer.ts:274-276`）：

> "Don't block the reducer - state change already happened. If capture fails, local state diverges from other clients until a SYNC_IMPORT is triggered. This is a known limitation."

### 5.2 第一层：FIFO 队列 + concatMap 保序

**如果没队列：** Effect 从 Actions 流收到 action 后直接处理，但 `concatMap` 的串行化只保证 Effect 内部顺序。meta-reducer 入队顺序和 Effect 出队顺序可能因 RxJS 调度产生偏差，在没有队列的情况下无法追踪"还有哪些操作没持久化"。

```typescript
// operation-capture.service.ts
enqueue(action): void {
  this.queue.push(entityChanges);  // 纯内存操作，不抛异常
}

dequeue(): EntityChange[] {
  return this.queue.shift();       // FIFO，严格先入先出
}
```

**为什么队列不可能失败：** `Array.push()` 在浏览器里不抛异常（除非整页 OOM，此时整个 tab 崩溃，一致性已无意义）。这比直接写 IndexedDB 可靠得多——IndexedDB 可能因配额满了抛 `QuotaExceededError`，但数组 push 不会。

Effect 侧用 `concatMap` 配合队列：

```typescript
// operation-log.effects.ts
concatMap((action) => this.writeOperation(action)),
```

`concatMap` 等前一个 Promise resolve 后才处理下一个。入队顺序 = 出队顺序 = 写入 IndexedDB 的顺序。

### 5.3 第二层：锁防竞态（最关键）

单独的队列不够。考虑这个竞态：

```
t1: 用户完成任务 → meta-reducer enqueue → queue=[op1]
t2: 同步触发 → flushPendingWrites() 开始
t3: Effect 拿到 op1，正在写 IndexedDB（还未完成）
t4: flushPendingWrites() 看到 queue.size=0 → 认为没有待处理操作
t5: flushPendingWrites() 返回 → 开始上传 → "无新操作，跳过"
t6: Effect 写入 IndexedDB 完成 → 晚了，该操作已被跳过
```

**结果：操作持久化了，但同步跳过了它。** 下次同步之前其他客户端看不到这条操作。

锁解决这个问题——Effect 和 flushPendingWrites 用同一把锁：

```typescript
// Effect 里
await this.lockService.request(
  LOCK_NAMES.OPERATION_LOG, // ← 同一把锁
  writeInsideOperationLogLock, // 包含 dequeue + 构建 op + 写 IndexedDB
);

// flushPendingWrites 里
await this.lockService.request(LOCK_NAMES.OPERATION_LOG, async () => {
  // 空函数 — 拿到锁 = 上一个持有者已释放 = IndexedDB 写入已完成
});
```

**锁保证的 invariant：** "持有 OPERATION_LOG 锁" = "没有 Effect 正在写 IndexedDB" = "所有已入队的操作均已持久化完成"。

加锁后的正确时序：

```
t1: 用户完成任务 → meta-reducer enqueue → queue=[op1]
t2: 同步触发 → flushPendingWrites() 开始
t3: Effect 获取锁 → dequeue → 构建 op → 写 IndexedDB → 释放锁
t4: flushPendingWrites Phase 1: poll 队列直到 size=0
t5: flushPendingWrites Phase 2: 获取锁（Effect 已释放）→ 确认写入完成 → 释放
t6: flushPendingWrites() 返回 → 安全上传 ✅
```

### 5.4 第三层：flushPendingWrites 两阶段等待

详见第七节——为什么是两阶段，为什么锁优先方案也正确但选择了 poll 优先。

### 5.5 第四层：失败检测 + 强制刷新

如果前三层都没挡住（如 IndexedDB 真的满了、写失败了），系统不静默：

```typescript
// operation-log.effects.ts
private notifyUserAndTriggerRollback(): void {
  this.snackService.open({
    type: 'ERROR',
    msg: T.F.SYNC.S.PERSIST_FAILED,  // "持久化失败"
    actionStr: T.PS.RELOAD,           // 按钮："刷新页面"
    config: { duration: 0 },          // 粘在屏幕上，不自动消失
  });
}
```

`duration: 0` 是关键——不自动消失，用户必须看到。刷新后从 IndexedDB 重建 NgRx 状态，那条没持久化的操作不会出现——数据一致。

还有一个紧急压缩路径：捕获 `QuotaExceededError` → 获取 `sp_quota_exceeded` 跨 tab 锁 → 触发 `emergencyCompact()`（用 1 天保留窗口代替 7 天）→ 重试写入。压缩成功则恢复，失败则弹粘性错误。

**设计哲学：宁可让用户看到错误、手动刷新、丢失最近一次操作，也绝不让不一致静默存在。** Fail loudly, recover cleanly。

---

## 六、JavaScript 单线程与事件循环

### 6.1 "单线程"到底什么含义

JavaScript 引擎只有一个 **call stack**（调用栈）。同一时刻只能执行一段代码。

但这不等于"所有事情串行排好队一个接一个"。异步操作（Promise、setTimeout、IndexedDB）不会阻塞 call stack——它们把回调注册到任务队列中，call stack 清空后再逐个取出来执行。

```
宏任务（macrotask）：     setTimeout, I/O, UI 渲染, IndexedDB 事务完成回调
微任务（microtask）：     Promise.then, MutationObserver, queueMicrotask
```

事件循环的调度规则：一个宏任务执行完 → 清空所有微任务 → 可能渲染 → 下一个宏任务。

### 6.2 为什么 meta-reducer 不能异步写 IndexedDB

NgRx/Redux 的 reducer 签名是 `(state, action) => state`，**不能返回 Promise**。这是框架的硬约束——store 的状态变更必须是同步、可预测的。如果 reducer 能返回 Promise，整个状态树在 Promise resolve 之前处于不确定状态——选择器可能读到中间态、其他 reducer 无法确定执行顺序。

### 6.3 为什么 IndexedDB 不提供同步 API

历史上 Firefox 有过实验性的同步 IndexedDB API，但已被废弃。原因是 IndexedDB 的读写可能涉及磁盘 I/O，同步阻塞主线程会导致整个浏览器标签页冻结——用户无法点击、无法滚动，直到 I/O 完成。异步 API 让浏览器在等待磁盘时可以处理用户交互和渲染。

### 6.4 meta-reducer 和 Effect 之间发生了什么

```
// ===== 同步阶段（同一个宏任务，不可中断）=====
dispatch(action)
  → 所有 meta-reducer 依次执行
    → operationCaptureMetaReducer 执行
      → nextReducer(state, action)  // NgRx 状态变更
      → enqueue(action)              // 入内存队列
      → return afterState
  → 所有 reducer 执行完毕
  → RxJS Subject.next(action) —— 通知所有订阅者（同步）
  → dispatch() 返回

// call stack 清空

// ===== 微任务阶段 =====
// Effect 管道被 RxJS 调度，concatMap 开始处理

// ===== 下一个宏任务 =====
// IndexedDB 事务完成 → Promise 回调执行 → 释放锁 → 触发上传
```

meta-reducer 和 Effect 之间不是"同时执行"（不可能），而是同一个宏任务内的同步阶段和后续微任务阶段的关系。两者之间可能只隔几十微秒，所以感觉像是连续的，但它们是两个独立的事件循环 tick。

**这就解释了为什么不一致窗口存在：** 同步阶段（meta-reducer）不能等异步阶段（Effect）完成——因为 JavaScript 事件循环不允许同步代码"等待"异步代码。同步代码只能把异步任务排入队列然后继续执行。

---

## 七、两阶段刷新（flushPendingWrites）的设计权衡

### 7.1 实际实现：先 Poll 队列，再拿锁

```typescript
// operation-write-flush.service.ts
async flushPendingWrites(): Promise<void> {
  // Phase 1: 轮询队列大小（无锁，纯读内存，每 10ms 一次，最长 30s）
  while (this.captureService.getQueueSize() > 0) {
    await new Promise(resolve => setTimeout(resolve, 10));
  }

  // Phase 2: 队列空了，拿一次锁确认最后一条 IndexedDB 写入已完成
  await this.lockService.request(LOCK_NAMES.OPERATION_LOG, async () => {
    // no-op — 拿到锁 = 最后一个持有者（Effect）已释放 = IndexedDB 写入完成
  });
}
```

### 7.2 为什么有两个阶段

**Phase 1 为什么需要？** 如果跳过 Phase 1 直接拿锁：大量操作积压时，需要反复拿锁-检查-释放-等待-重试。N 条操作 = N+1 次锁获取。

**Phase 2 为什么需要？** 如果只有 Phase 1（只 poll 队列）：队列为空只能确认 Effect 已经 `dequeue()` 了，不能确认 IndexedDB 事务已提交。Phase 2 拿锁填补了"dequeue"和"IndexedDB 写入完成"之间的窗口——因为这两步都持有锁。

### 7.3 另一种正确方案：锁优先 + 重试

用户可能想到的方案也完全正确：

```typescript
async flushPendingWrites_LockFirst(): Promise<void> {
  while (true) {
    let done = false;
    await lockService.request(OPERATION_LOG, () => {
      if (captureService.getQueueSize() === 0) done = true;
    });
    if (done) return;
    await sleep(10);
  }
}
```

**为什么正确：** Effect 的 `dequeue` + `IndexedDB 写入` 都在锁内。如果你拿到锁且队列为空，意味着：

- 没有 Effect 正在处理（否则你拿不到锁）
- 所有已入队的都已被 dequeue + 写入 IndexedDB

但缺点是：如果队列有 50 条，需要获取-释放锁 50+ 次。每次锁获取有开销（跨 tab 协调）。

### 7.4 为什么 poll 优先方案更优

**Poll 队列不需要锁。** `getQueueSize()` 读的是一个整数——在 JS 单线程环境下不可能被"半个写入"，读操作是原子的。就算 meta-reducer 恰好在你读之后 push 了一条，下一轮 poll（10ms 后）会看到。最多多等 10ms。

|            | 锁优先 + 重试        | Poll 优先 + 单次锁             |
| ---------- | -------------------- | ------------------------------ |
| 锁获取次数 | N+1 次（N=队列深度） | 1 次                           |
| 正确性     | ✓                    | ✓                              |
| 无竞态读取 | 不需要（锁保护）     | 利用 JS 单线程保证整数读原子性 |
| 性能       | 队列越深越差         | 恒定                           |

**结论：两阶段是一个性能优化，不是正确性补丁。** 两种方案在逻辑上等价，选 poll 优先是因为少拿锁 = 少跨 tab 协调 = 更快。

### 7.5 Phase 1 不拿锁有没有风险？

`getQueueSize()` 读的是数组 `length` 属性。在 JS 单线程中，对 `length` 的读不可能看到"半个 push"的结果——`push` 要么执行了（`length` 增加了），要么没执行（`length` 不变）。没有中间态。

唯一的"误差"是：你在轮询的间隙，meta-reducer 刚 push 了一条。但这不影响正确性——下一轮 poll 会看到它，最多晚 10ms 检测到。而 Phase 2 的锁保证了最后一轮 poll 到拿锁之间的窗口也被覆盖。

---

## 八、NgRx + IndexedDB 自身的新挑战

虽然 MySQL + Redis 的很多问题在前端消失了，但由于运行在客户端受限的环境中，前端架构也引入了自己特有的挑战：

### 1. 数据安全性与易失性

- 用户可以随时手动清空浏览器缓存，或者在无痕模式下运行，导致 IndexedDB 中的数据丢失。
- 敏感数据留在前端容易受到 XSS 攻击或被用户通过开发者工具篡改。
- **应对：** 端到端加密（Argon2id + AES-GCM），同步到云端的 op-log 加密传输和存储；本地 IndexedDB 可通过密码加密。

### 2. 存储容量限制

- 浏览器对 IndexedDB 的存储空间有限制（基于磁盘剩余空间的一定比例，各浏览器策略不同），不能像 MySQL 那样扩展。
- **应对：** Compaction 定期将旧 op-log 折叠为状态快照，删除已同步的过期操作。`MAX_VECTOR_CLOCK_SIZE = 20` 防止向量时钟膨胀。紧急压缩（1 天保留窗口）在配额不足时触发。

### 3. 多标签页同步问题

- 多个标签页共享同一个 IndexedDB，但各有独立的 NgRx Store 内存实例。
- A 标签页修改了 IndexedDB，B 标签页的 NgRx 如何感知？
- **应对：** 同步触发后，从云端拉取远程 op-log 时会检测本地 IndexedDB 中是否有其他标签页写入的新条目，统一回放。LockService 提供跨 tab 的锁协调。

### 4. 内存泄漏风险

- NgRx Store 中积压过多历史数据会持续占用物理内存，低端设备可能卡顿或崩溃。
- **应对：** Archive 机制将不活跃实体移出主 Store。`hasMeaningfulStateData()` 空状态守卫防止无效数据污染。

### 5. IndexedDB 事务模型的限制

- IndexedDB 事务是自动提交的（auto-commit），在事件循环微任务结束后自动关闭，不支持长时间持有的读写事务。
- 不能像 MySQL 那样开启长事务、做一系列操作后手动 COMMIT。
- **应对：** 每个操作的持久化是独立事务。跨操作的一致性由 op-log 的幂等回放和向量时钟保证，而非数据库事务。

### 6. 已知的不一致窗口

- 如第五节所述，NgRx 先更新、IndexedDB 异步写入之间存在 ~50ms 窗口。
- 此时如果浏览器崩溃，最近一次操作丢失（刷新后从 IndexedDB 重建时不包含该操作）。
- **应对：** 四层防护（队列 + 锁 + 两阶段刷新 + 粘性错误提示），失败时 loud failure 而非 silent corruption。

---

## 九、总结

**"MySQL + Redis" 解决的是：** 高并发、大吞吐、多用户共享、强一致性保障的集群级问题。

**"NgRx + IndexedDB" 解决的是：** 单用户体验、离线可用、快速响应、前端复杂交互状态管理的客户端问题。

前者的许多复杂问题在后者中消失，并不是因为后者的技术更先进，而是因为**应用场景从"复杂的分布式多用户环境"降维到了"简单的本地单用户环境"**：

- 网络变成进程内调用
- 多线程并发变成单线程事件循环
- 多用户共享变成单用户私有

但前端也付出了代价——数据更易丢失、存储容量受限、多标签页引入新的同步挑战、Redux 同步约束 + IndexedDB 异步 API 之间的矛盾引入了不一致窗口。这些都不是"bug"，而是在约束条件下有意识的设计取舍。

核心设计哲学：**"fail loudly, recover cleanly"。** 遇到无法自动修复的不一致时，宁可弹红色横幅强制用户刷新，也不让不一致静默扩散。
