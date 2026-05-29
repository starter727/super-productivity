# Delta Sync 与 Operation Log：综合对比

**综合来源：** Gemini 2.5 Flash、GPT-5、Claude Opus 4.5  
**日期：** 2025 年 12 月 2 日  
**对比分支：** `feat/delta-sync` vs `feat/operation-logs`

---

## 实现状态

**两种方案都已有较完整实现。**

### 当前实现状态

| 分支                  | 关键文件                                                                | 行数   | 状态                                                      |
| --------------------- | ----------------------------------------------------------------------- | ------ | --------------------------------------------------------- |
| `feat/delta-sync`     | `super-sync.ts`, `diff-utils.ts`, `super-sync-api.ts`                   | ~1,600 | 完整实现：影子状态（IDB）、diff、watermark、细粒度加密    |
| `feat/operation-logs` | `operation-log-store.service.ts`, `operation-log-sync.service.ts`, etc. | ~600+  | 核心逻辑已实现：op store、sync service、effects、hydrator |

### 分析来源

| 模型       | Delta Sync 来源                 | 说明                               |
| ---------- | ------------------------------- | ---------------------------------- |
| **Gemini** | `feat/delta-sync` 的早期状态    | 分析时分支尚未更新到完整实现       |
| **GPT-5**  | 设计文档 + 代码                 | 侧重架构层分析                     |
| **Opus**   | `feat/delta-sync`（940 行实现） | 对已实现 Delta Sync 的完整代码分析 |

**更新：** Gemini 关于 Delta Sync 是“vaporware（空壳）”的结论已过时。`feat/delta-sync` 分支已更新，包含完整 940 行 `SuperSyncProvider` 实现（含 IDB shadow state、diff 引擎、watermark 跟踪）。两种方案现在可在“已实现代码”层面公平比较。

---

## 1. 执行摘要

本文比较了 Super Productivity 的两种同步**架构**（两者目前都已有较完整实现）：

- **Delta Sync：** 基于状态快照 + shadow state + diff + watermark 的同步
- **Operation Log：** 基于事件溯源 + append-only 操作日志的同步

### 对比对象

| 方案              | 分支                  | 核心原则                    | 实现状态                 |
| ----------------- | --------------------- | --------------------------- | ------------------------ |
| **Delta Sync**    | `feat/delta-sync`     | 比较状态快照并传输差异      | **已实现**（~1,600 行）  |
| **Operation Log** | `feat/operation-logs` | 记录用户操作并传输/回放操作 | **部分实现**（~600+ 行） |

### 结论（模型一致）

三种模型均基于架构分析推荐 **Operation Log**：

| 模型   | 理由                                              |
| ------ | ------------------------------------------------- |
| Gemini | Delta Sync 在 shadow state 一致性上存在结构性问题 |
| GPT-5  | Delta Sync 设计天然存在 LWW 数据丢失风险          |
| Opus   | 代码层发现状态更新非原子、向量时钟治理存在缺口    |

---

## 2. 架构对比

### 2.1 Delta Sync（按当前实现）

```
Client Storage (super-sync.ts):
├── App data (IndexedDB)
├── Shadow state (super-sync-shadow IDB)
│   ├── shadow_state: last synced state per model
│   └── watermarks: revision cursors per model
└── Memory cache (lastSyncedState Map)

Sync Flow:
1. Load shadow state from IDB (or memory cache)
2. Compute diff via createDiff() in diff-utils.ts
3. Upload changes to /api/sync/changes
4. Server shallow-merges (LWW)
5. Update shadow + watermark in IDB
```

**代码验证问题（来自 Opus 对 super-sync.ts 的分析）：**

- shadow state 同时存在于内存和 IDB（可能漂移）
- watermark 与 shadow 分开事务写入 IDB（非原子）
- diff 计算是基于 `JSON.stringify` 的 O(N)
- LWW 合并会丢失并发独立修改
- 空向量时钟被当作 CONCURRENT（假冲突）

### 2.2 Operation Log（按当前实现）

```
Client Storage (actual):
├── SUP_OPS IndexedDB
│   ├── ops: append-only operation log
│   └── state_cache: periodic snapshots
└── NgRx Store (derived from ops)

Sync Flow:
1. Local action → append to ops log
2. Upload pending ops to remote
3. Download remote ops
4. Detect conflicts via vector clock comparison
5. Apply non-conflicting ops; surface conflicts to user
```

**代码验证特征：**

- 单一事实来源（operation log）
- 冲突检测粒度为实体级（per-entity）
- compaction service 限制日志膨胀
- 启动通过 snapshot + tail ops 回放恢复

---

## 3. 评估维度对比

### 3.1 冲突处理

这是最关键差异，并且是**架构层差异**，不依赖具体实现细节。

| 维度         | Delta Sync（设计）             | Operation Log（实现）          |
| ------------ | ------------------------------ | ------------------------------ |
| 冲突检测     | 文件级向量时钟                 | 实体级向量时钟                 |
| 合并方式     | 浅层 LWW（`{...old, ...new}`） | 语义合并（独立操作可同时生效） |
| 用户决策     | 全有或全无                     | 实体级细粒度                   |
| 数据丢失风险 | **高**（静默覆盖）             | **低**（冲突显式暴露）         |

**例子：**

```
Device A: Renames task to "Meeting"
Device B: Marks task complete

Delta Sync (LWW): One change lost
Operation Log: Both changes applied (independent operations)
```

**胜出：Operation Log**（一致结论，置信度高）

### 3.2 可维护性

| 维度     | Delta Sync（设计）                   | Operation Log（实现）  |
| -------- | ------------------------------------ | ---------------------- |
| 数据模型 | 2 套（app state + shadow）           | 1 套（operation log）  |
| 增加功能 | 需要同步更新 shadow 处理 + diff 规则 | 添加 action 白名单即可 |
| 调试方式 | 对比 shadow vs actual vs server      | 检查操作序列           |
| 真相来源 | 模糊（shadow 可漂移）                | 清晰（operation log）  |

**胜出：Operation Log**（一致）

### 3.3 性能

| 指标      | Delta Sync         | Operation Log    | 依据                                   |
| --------- | ------------------ | ---------------- | -------------------------------------- |
| Diff 成本 | 每次同步 O(N)      | O(1) 追加        | **代码验证**（diff-utils.ts 遍历实体） |
| 启动成本  | 快（直接载入状态） | 快照 + tail 回放 | **代码验证**                           |
| 带宽      | 补丁更小           | 负载更大         | **代码验证**（delta 仅发变更字段）     |
| 大数据集  | 10k+ 可能卡 UI     | 随变更率扩展     | **待实测**                             |

**结果：平局**。Delta Sync 在带宽上占优；Operation Log 在 CPU 成本上占优。需用真实数据集做 benchmark。

### 3.4 磁盘占用

| 指标     | Delta Sync（已实现）                  | Operation Log（已实现）                 |
| -------- | ------------------------------------- | --------------------------------------- |
| 稳态占用 | ~2X（IDB 中额外 shadow state）        | ~1.2X（启用 compaction）                |
| 依据     | **代码验证**（super-sync-shadow IDB） | **代码验证**（存在 compaction service） |

**胜出：Operation Log**（前提是 compaction 正确）

---

## 4. 实现工作量

### Delta Sync：稳定现有实现

`feat/delta-sync` 已有完整实现（~1,600 行）。剩余稳定化工作：

| 组件                      | 预估   | 说明                           |
| ------------------------- | ------ | ------------------------------ |
| shadow/watermark 原子更新 | 1-2 周 | 目前是分离 IDB 事务            |
| diff 放入 Web Worker      | 1 周   | 避免大数据集下 UI 卡顿         |
| 服务端 delta API 加固     | 1-2 周 | 分页、错误处理                 |
| 冲突 UI 改进              | 1 周   | 自动合并反馈                   |
| 测试/加固                 | 2-4 周 | 边界场景、并发客户端、崩溃恢复 |

**总计：6-10 周**（高风险，主要在多状态一致性）

### Operation Log：补齐实现

`feat/operation-logs` 已有核心逻辑（~600+ 行）。剩余工作：

| 组件         | 预估     | 说明                       |
| ------------ | -------- | -------------------------- |
| 冲突解决 UI  | 1-2 周   | 当前为 stub                |
| 依赖补偿重试 | 0.5-1 周 | 处理缺失父实体             |
| 智能建议     | 1 周     | 简单冲突走 LWW fallback    |
| Genesis 迁移 | 1 周     | 将现有数据转首批 operation |
| Effect 防护  | 0.5-1 周 | 回放时避免副作用           |
| 测试/加固    | 1-2 周   | 压缩、大日志、并发标签页   |

**总计：4-6 周**（中风险，核心在 compaction 正确性）

---

## 5. 如何验证这些结论

在最终拍板前，建议量化：

### 对 Delta Sync（若继续）

1. **Diff 成本：** 用 1k、10k、50k 实体测试 `createDiff()` 耗时
2. **Shadow 存储：** 比较有/无 shadow 的 IDB 体积
3. **Watermark 一致性：** 中途崩溃恢复测试
4. **LWW 丢失率：** 模拟并发编辑并统计丢失变更

### 对 Operation Log

1. **日志增长：** 统计典型日常 ops/day，并验证 compaction 是否可控
2. **回放耗时：** 1k、10k、100k operation 启动时间
3. **压缩正确性：** 验证 compaction 后无数据丢失
4. **冲突准确率：** 并发编辑测试，检查冲突是否正确暴露

---

## 6. 风险评估

### Delta Sync 风险（代码验证）

| 风险                    | 可能性 | 影响 | 说明                       |
| ----------------------- | :----: | :--: | -------------------------- |
| shadow/watermark 失同步 |   高   |  高  | super-sync.ts 中事务非原子 |
| LWW 数据丢失            |   高   |  高  | 架构层固有问题             |
| O(N) 导致 UI 卡顿       |   中   |  中  | 可用 Web Worker 缓解       |
| 向量时钟治理问题        |   中   |  中  | 空时钟导致假冲突           |

### Operation Log 风险（观察）

| 风险                | 可能性 | 影响 | 说明                    |
| ------------------- | :----: | :--: | ----------------------- |
| compaction 误删数据 |   低   |  高  | 通过保守保留策略缓解    |
| 回放非确定性        |   中   |  中  | 依赖 reducer 纯函数性   |
| 日志无界增长        |   中   |  低  | 已有 compaction service |

**结论：** Operation Log 的高概率高影响风险更少。

---

## 7. 推荐方案

### 共识

**建议继续完成 Operation Log 实现**（`feat/operation-logs`）。

### 理由

1. **两者都可用，但** Operation Log 在代码层架构风险更低
2. **冲突处理更优：** 实体级优于文件级
3. **风险画像更好：** 无多状态一致性结构风险
4. **工作量更可控：** Delta Sync 6-10 周 vs Operation Log 4-6 周

### 如果选择 Delta Sync

1. 先修 shadow/watermark 原子更新（关键缺陷）
2. 把 diff 计算移到 Web Worker（性能）
3. 修正向量时钟治理（空时钟误判）
4. 接受并文档化 LWW 限制
5. 强化崩溃恢复场景测试

---

## 8. 结论

| 维度         | Delta Sync              | Operation Log           |
| ------------ | ----------------------- | ----------------------- |
| 实现状态     | **已实现**（~1,600 行） | 部分实现（~600+ 行）    |
| 冲突处理     | LWW（有损）             | 实体级（保留语义）      |
| 到生产工作量 | 6-10 周                 | 4-6 周                  |
| 风险等级     | 高（多状态一致性）      | 中（compaction 正确性） |
| 推荐         | 可行但风险高            | **推荐**                |

两种方案都已具备较完整实现。推荐 Operation Log 的原因来自 **Delta Sync 代码层可验证的架构问题**：

- shadow/watermark 非原子更新会引入崩溃一致性风险
- LWW 语义在并发独立修改下会导致数据丢失
- 空向量时钟会触发假冲突

**一句话：** 对 Super Productivity 的多设备同步场景，Operation Log 的架构鲁棒性更强。若继续 Delta Sync，需要先完成较大规模稳定化工作。
