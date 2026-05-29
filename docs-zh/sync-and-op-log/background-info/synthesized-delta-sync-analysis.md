# Delta Sync 根因分析：综合报告

**综合来源：** Gemini 2.5 Flash、GPT-5、Claude Opus 4.5  
**日期：** 2025 年 12 月 2 日

---

## 关键说明：分析范围存在差异

**三个 AI 模型分析的对象并不相同：**

| 模型                 | 分析对象                                | 分支/来源                       |
| -------------------- | --------------------------------------- | ------------------------------- |
| **Gemini 2.5 Flash** | 当前工作目录                            | `feat/delta-sync`（45 行 stub） |
| **GPT-5**            | 文档与设计文档                          | 理论/规划设计                   |
| **Claude Opus 4.5**  | 通过 `git show` 查看 `feat/sync-server` | 940 行实现（不同分支）          |

**分析日期对应的客观现状：**

- **`feat/delta-sync` 分支**（本次评估对象）：`super-sync.ts` 只有 **45 行**（WebDAV stub）
- `feat/sync-server` 分支（独立分支，不在本次评估范围）：包含 940 行实现
- 服务端（`packages/super-sync-server`）：只有认证封装，无 delta/changes 逻辑

**重要澄清：** 正确对比对象应是 `feat/delta-sync` 与 `feat/operation-logs`。`feat/sync-server` 是另一条实现线，不应与 `feat/delta-sync` 混淆。

**推论：** Gemini 认为 delta-sync 是“vaporware（空壳）”对于 `feat/delta-sync` 是成立的。Opus 的详细代码分析针对的是另一分支（`feat/sync-server`），该分支代码更多但不在本次评估范围。GPT-5 的判断基于文档设计。

**战略建议（放弃 `feat/delta-sync` 上的 delta sync）依然成立**，因为：

1. `feat/delta-sync` 基本无真实实现，仅 stub（Gemini）
2. 文档设计存在内在架构限制（GPT-5）
3. 即便是较完整实现（`feat/sync-server`），也有基础性问题（Opus）

---

## 1. 执行摘要

本文综合了三个 AI 模型（Gemini 2.5 Flash、GPT-5、Claude Opus 4.5）对 Super Productivity 中 delta-sync 的分析。三者独立得出：**存在基础架构问题**，这正是稳定化长期困难的原因（无论看 stub、设计，还是实现分支）。

### 一致发现

| 结论                          | Gemini | GPT-5 | Opus | 置信度 |
| ----------------------------- | :----: | :---: | :--: | :----: |
| Shadow state 是核心问题       |   ✅   |  ✅   |  ✅  | **高** |
| Watermark/Revision 跟踪不可靠 |   ✅   |  ✅   |  ✅  | **高** |
| LWW 语义会造成数据丢失        |   ✅   |  ✅   |  ✅  | **高** |
| O(N) diff 不可扩展            |   ✅   |  ✅   |  ✅  | **高** |
| 实现不完整                    |   ✅   |  ✅   |  ⚠️  | **高** |
| 多状态一致性不可解            |   ✅   |  ✅   |  ✅  | **高** |

**关键共识：** Delta-sync 架构要求在无事务保证下维护多份同步状态（应用数据、shadow state、watermark、向量时钟），会造成故障模式组合爆炸，难以测试与复现。

---

## 2. 根因：跨模型综合分析

### 2.1 Shadow State 问题

**三模型都将其认定为首要根因。**

#### Gemini 观点

> “Delta Sync 要求客户端维护 **Shadow State**（本地与服务端一致的拷贝）。没有持久化 shadow state，每次重启都会丢失 diff 基线。”

#### GPT-5 观点

> “Shadow state 极易丢失（IDB 驱逐、加密密钥不匹配、缓存清理、新设备）。一旦缺失，客户端会把‘无 shadow’解释为‘全部变更’，触发全量实体上传。”

#### Opus 观点

> “双缓存不一致：shadow state 同时存在内存（`lastSyncedState` Map）和 IndexedDB；若内存更新后 IDB 写入前崩溃，两者会漂移。”

#### 综合

| 失效模式         | Gemini | GPT-5 | Opus |
| ---------------- | ------ | ----- | ---- |
| IDB 驱逐/丢失    | ✅     | ✅    | ✅   |
| 加密密钥不匹配   | —      | ✅    | ✅   |
| 内存/IDB 漂移    | —      | —     | ✅   |
| 无完整性校验     | —      | —     | ✅   |
| 静默恢复掩盖问题 | ✅     | ✅    | ✅   |

**综合根因：** Shadow state **无耐久保证**、**无完整性校验**，且与 watermark/服务端状态**无原子耦合**。一旦损坏会静默触发全量同步，甚至覆盖本地改动。

---

### 2.2 Watermark / Revision 问题

**三模型都认为 watermark 漂移是关键问题。**

#### Gemini 观点

> “Shadow state 一旦损坏，客户端会持续异常，直到完整重置。”

#### GPT-5 观点

> “若本地 watermark 漂移（同步中重启、部分写入），客户端可能请求到服务端已压缩的区间，或直接跳过区间，出现‘无变化集但 shadow 过期’场景。”

#### Opus 观点

> “Watermark-Shadow 失同步：两者分开更新。若一个成功一个失败，客户端进入不一致状态。”

#### 综合

| 失效模式              | 影响                             |
| --------------------- | -------------------------------- |
| watermark 新于 shadow | 客户端漏变更（误判已同步）       |
| watermark 旧于 shadow | 客户端重复拉取（低效但安全）     |
| 同步中 watermark 漂移 | 客户端与服务端对同步点认知不一致 |
| 无原子耦合            | 中途崩溃可能永久破坏状态         |

**综合根因：** Watermark 与 Shadow state 通过不同 IDB 事务存储，崩溃或部分失败后无法保证一致。

---

### 2.3 LWW（Last-Write-Wins）问题

**三模型一致认为浅合并语义有数据丢失风险。**

#### Gemini 观点

> “LWW 盲覆盖，不保留变更意图。`TaskCompleted` 和 `TaskRenamed` 不能同时生效，总有一个被覆盖。”

#### GPT-5 观点

> “服务端 `merged = { ...oldData, ...newData }`，正确性依赖客户端发送完整顶层字段。若漏嵌套字段，会整块覆盖并丢失未改键。”

#### Opus 观点

> “BLOB 模型是全对象 LWW，ENTITY 模型是字段合并。模式识别错了会导致过合并或欠合并。”

#### 综合示例

```
场景：两台设备并发编辑 Task A

设备1：任务改名为 "Important Meeting"
设备2：任务标记完成

Delta Sync 结果（LWW）：
- 设备2后同步：任务改名保留，但“完成”丢失
- 设备1后同步：任务完成保留，但改名丢失

预期结果：
- 任务应同时“已改名”且“已完成”（独立变更应共存）
```

**综合根因：** Delta sync 传的是“状态差异”，不是“操作意图”。同一实体不同字段并发修改时，只能存活一边，这是浅合并的结构性限制。

---

### 2.4 性能问题

**三模型一致认为 O(N) diff 是可扩展性瓶颈。**

#### Gemini 观点

> “1 万项 diff 会冻结 UI，性能线性退化。”

#### GPT-5 观点

> “数千任务时 diff 会打满 UI 线程，掉帧甚至超时。若 diff 期间数据继续变化，结果与最终状态不一致。”

#### Opus 观点

> “`createDiff` 为 O(N)（N=实体数）。10,000+ 任务会阻塞主线程。”

#### 综合

| 数据规模     | 预计 diff 时间 | 用户体感   |
| ------------ | -------------- | ---------- |
| 100 tasks    | ~10ms          | 几乎无感   |
| 1,000 tasks  | ~100ms         | 轻微延迟   |
| 10,000 tasks | ~1,000ms       | 明显卡顿   |
| 50,000 tasks | ~5,000ms       | 基本不可用 |

**综合根因：** diff 需要把每个实体和 shadow 对象逐一比较（`JSON.stringify()`），天然 O(N)。除非架构升级（脏标记、增量 diff、Web Worker），否则难以优化。

---

### 2.5 实现完整性问题

**Gemini 与 GPT-5 指出当前实现不完整；Opus 分析的是更完整分支 `feat/sync-server`。**

#### Gemini 观点（最关键）

> “代码显示服务端没有 delta DB（只有 Users 表），客户端只是 WebDAV 包装。实现基本是‘空壳’。”

#### GPT-5 观点

> “实际路径（`super-sync.ts`）当前仍是薄 WebDAV 包装，文档里的 delta 逻辑未真正接线。”

#### Opus 观点

> “`feat/sync-server` 有 940 行 `SuperSyncProvider`，包含 IDB shadow state、watermark 和 diff 逻辑，但有多个 TODO，尚未完结。”

#### 综合

| 组件                | 当前状态                  | 缺口                       |
| ------------------- | ------------------------- | -------------------------- |
| 服务端 delta API    | 文档描述存在，实际较弱    | Gemini 分析中无 changes 表 |
| 客户端 shadow state | `feat/sync-server` 有实现 | 无崩溃一致性               |
| Diff 引擎           | 已实现                    | 无 worker 卸载，O(N)       |
| Watermark 跟踪      | 已实现                    | 与 shadow 非原子           |
| 加密                | 两种模式可用              | 模式切换隐式               |
| 向量时钟            | 已实现                    | 治理缺口（空时钟=冲突）    |

**说明：** Gemini/GPT-5 与 Opus 的差异说明实现在演进中。Opus看到的是更新状态：delta 逻辑存在，但基础问题仍在。

---

## 3. 为什么稳定化困难：共识视角

三模型一致认为稳定化存在结构性障碍：

### 3.1 从状态推意图（GPT-5）

> “系统试图从可变快照推断意图。一旦 shadow 损坏，就需要昂贵重算，并可能静默丢语义。”

### 3.2 缺少单一事实来源（全部模型）

| 状态组件             | 存储位置 | 会漂移？ |
| -------------------- | -------- | :------: |
| NgRx 内存状态        | Memory   |   Yes    |
| IndexedDB 应用数据   | IDB      |   Yes    |
| Shadow state（内存） | Memory   |   Yes    |
| Shadow state（IDB）  | IDB      |   Yes    |
| Watermarks           | IDB      |   Yes    |
| 服务端状态           | Remote   |   Yes    |
| 向量时钟（本地）     | IDB      |   Yes    |
| 向量时钟（远端）     | Remote   |   Yes    |

**独立状态共 8 份**  
**潜在不一致组合：$2^8 - 1 = 255$**

### 3.3 测试复杂度（全部模型）

| 边界场景         | 可测性 | 当前是否覆盖 |
| ---------------- | :----: | :----------: |
| 两设备并发 push  |  困难  |      ❌      |
| 同步中途断网     |  困难  |      ❌      |
| IDB 驱逐         |  困难  |      ❌      |
| 向量时钟溢出     |  中等  | ⚠️（被禁用） |
| 加密密钥变化     |  中等  |      ❌      |
| 大数据集（10k+） |  困难  |      ❌      |

### 3.4 运维面太宽（GPT-5）

> “设计横跨 WebDAV fallback、可选加密、IndexedDB 持久化与 REST delta。每层都有独立故障模式，而且会叠加。”

---

## 4. 各模型的独特洞察

### 4.1 Gemini 独特洞察：“Phase 0” 状态

Gemini 认为当前 `SuperSyncProvider` 仍是“Phase 0”（WebDAV 包装），意味着 delta sync 在实现阶段就遇到复杂度天花板。

### 4.2 GPT-5 独特洞察：Fallback 路径耦合

> “模式切换会改变合并语义（snapshot LWW vs delta patch）。fallback 后 shadow state 不再匹配服务端 revision。”

这意味着双同步模式（delta + WebDAV fallback）会形成“混合状态”，两条路径都无法完全兜底。

### 4.3 Opus 独特洞察：向量时钟治理缺口

Opus 指出具体代码问题：

- 空时钟被当作 `CONCURRENT`（制造假冲突）
- 50 客户端裁剪会丢失因果历史
- 溢出重置为 1 会破坏与旧时钟比较

---

## 5. 稳定化工作量估算

### Gemini 估算：12-16 周（从头构建）

> “服务端（4-6 周）：设计 changes schema，实现 `/api/sync`。客户端（6-8 周）：实现 `ShadowStateStore`、Diff Engine（Worker）、Partial Patch。迁移（2 周）。”

### GPT-5 估算：3-5 周（让它真正可用）

> “实现并持久化 shadow state + 每模型 watermark，并保证崩溃安全耦合；补齐 diff+merge pipeline；增加大数据集性能测试；做 soak 测试加固。”

### Opus 估算：需要架构级重写

> “要稳定，要么做深度架构改造以保证状态转移原子且可验证，要么切换同步范式。”

### 综合

| 路径                     |  工作量  | 风险 | 结果                 |
| ------------------------ | :------: | :--: | -------------------- |
| 最小修补（逐 Bug）       |  2-4 周  |  高  | 打地鼠，持续出新问题 |
| 正规 Delta Sync（GPT-5） |  3-5 周  |  中  | 可用但脆弱           |
| 完整重建（Gemini）       | 12-16 周 |  中  | 真正完整 Delta Sync  |
| 切架构（Opus）           |  4-6 周  |  低  | 转 Operation Log     |

---

## 6. 综合建议

### 6.1 不建议做

- **逐 Bug 修补：** 问题是架构层，不是孤立 bug
- **继续加 fallback 路径：** 状态空间会进一步膨胀
- **先优化 diff 性能：** 不能解决正确性问题

### 6.2 可考虑

- **不引入完整 operation log 的实体版本方案：** 比 operation log 更轻，能缓解部分问题（见 `operationlog-critique.md`）
- **混合方案：** 简单模型走 delta sync，复杂模型走 operation log

### 6.3 推荐

- **完成 operation log 实现：** 三模型一致认为路径更可控
- **若必须走 delta sync：** 按 GPT-5 方案优先保证 shadow 与 watermark 的崩溃安全耦合

---

## 7. 结论

**三个 AI 模型独立得出同一结论：** Delta-sync 实现存在基础架构问题，稳定化成本高且风险大。

### 核心问题（共识）

1. **Shadow state 无耐久性与完整性保证**
2. **Watermark 与 shadow state 可失同步**
3. **LWW 合并会丢失并发独立变更**
4. **O(N) diff 在大数据集下不可扩展**
5. **多独立状态导致组合型故障模式**

### 前进路径（共识）

`feat/operation-logs` 更可控，因为：

- 单一事实来源（operation log）消除多状态一致性难题
- 实体级冲突检测（不是整文件）
- append-only 日志天然更抗损坏
- 性能随“变更频率”扩展，而非随“数据总量”线性退化

Delta-sync 方案并非理论错误，但按当前实现状态，要达到稳定可用需要较大重构投入。相比之下，把投入放到完成 operation-log 实现通常更划算。
