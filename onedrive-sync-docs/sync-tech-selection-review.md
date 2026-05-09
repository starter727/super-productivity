# 客户端离线、网盘多端同步技术选型复盘

> **文档用途**：技术选型归档与评审
> **项目背景**：Super Productivity — 基于 Angular + NgRx 的离线优先 Todo/GTD 应用，通过用户自有网盘（OneDrive/Dropbox/WebDAV）实现多端数据同步
> **复盘时间点**：v16 同步架构升级阶段
> **前置约束**：Angular（2018-05 选定）+ NgRx（2018-10 选定）为既定技术栈。Angular 的选型由跨平台三端代码统一（Electron/Capacitor/Web）、TypeScript 先发优势、全功能框架的独立开发者友好性、以及 sp1 → sp2 项目演进路径共同驱动。详情见 §1.1.1。

---

## 目录

1. [前置约束：Angular + NgRx 技术栈的确定性与不可变更性](#1-前置约束angular--ngrx-技术栈的确定性与不可变更性)
   - 1.1.1 Angular 选型的原始决策（2018 年 5 月）
   - 1.1.2 NgRx 选型（2018 年 9-10 月）
   - 1.1.3 IndexedDB 选型
2. [方案一：CRDT + 文件存储](#2-方案一crdt--文件存储)
3. [方案二：事件溯源追加日志流（Event Sourcing / Append-Only Log）](#3-方案二事件溯源追加日志流event-sourcing--append-only-log)
4. [方案三：CR-SQLite（CRDT 增强本地数据库同步）](#4-方案三cr-sqlitecrdt-增强本地数据库同步)
5. [方案四：第三方云数据库 / BaaS 方案](#5-方案四第三方云数据库--baas-方案)
6. [多方案横向对比表](#6-多方案横向对比表)
7. [最终选型总结](#7-最终选型总结)

---

## 1. 前置约束：Angular + NgRx 技术栈的确定性与不可变更性

在讨论「为什么没有选用方案 X」之前，必须先明确一个核心前提：**Angular + NgRx 是既定技术栈，它先于同步方案选型而存在，且不可在同步方案选型阶段被推翻。** 这一约束并非武断假设，而是由项目架构演进的客观时序和跨平台需求共同决定的。

### 1.1 既定技术栈的成因

#### 1.1.1 Angular 选型的原始决策（2018 年 5 月）

Super Productivity 2.0（内部代号 sp2）于 2018 年 5 月 12 日以 Angular 6.0.0 初始化。这不是一次"选型评审"的结果，而是有客观历史成因和确定性技术驱动的决策。以下从项目演进时序和 2018 年前端生态两个维度还原决策逻辑。

**项目演进时序**：

```
2018-05-12  initial commit (Angular 6.0.0, TypeScript 2.7.2)
2018-05-13  从旧版 sp1 迁移功能
2018-06-10  Angular CLI 升级
2018-09-01  refactor: reducer stuff（首次引入类 NgRx 模式）
2018-10-06  REWRITE: 完整 NgRx Store 架构
2018-10-21  Electron 集成 + Angular Material 集成
```

关键事实：**Angular 是项目最早的技术选型（早于 NgRx 4 个月），NgRx 是伴随业务复杂度增长而自然引入的状态管理方案。** 二者虽然在当前架构中紧密耦合，但选型的时间点和驱动力是不同的。

**Angular 为何在 2018 年被选定（与 React/Vue 的对比）**：

| 维度       | Angular 6（2018-05 发布）               | React 16.3（2018-03 发布）                   | Vue 2.5（2017-10 发布）           |
| ---------- | --------------------------------------- | -------------------------------------------- | --------------------------------- |
| TypeScript | 一等公民，CLI 原生支持                  | 需手动配置（CRA 不支持 TS）                  | 部分支持（`vue-class-component`） |
| 脚手架     | `@angular/cli` 内置 build/test/lint/e2e | `create-react-app` 仅 build，无路由/状态管理 | `vue-cli` 3.0 仍在 Beta           |
| 状态管理   | NgRx 5.x（基于 RxJS 6，成熟稳定）       | Redux（需自行集成 middleware）               | Vuex 3.x（仅限 Vue 生态）         |
| 路由       | `@angular/router` 内置                  | `react-router` v4（第三方）                  | `vue-router` 官方但独立安装       |
| 表单       | `@angular/forms` 内置模板驱动+响应式    | 需第三方库（Redux-Form/Formik）              | 需 `vue-form` 或手写              |
| HTTP       | `@angular/common/http` 内置             | 需 `axios` 或 `fetch`                        | 需 `axios` 或 `vue-resource`      |
| DI/模块化  | 内置依赖注入 + NgModule 体系            | 无（需手动 props drilling 或 Context）       | 无内置 DI                         |
| 移动端     | Ionic 3 原生支持 Angular                | React Native（独立生态）                     | Weex/NativeScript（分离）         |
| 桌面端     | Electron 与 Angular 无框架冲突          | Electron + React 成熟方案                    | Electron + Vue 成熟方案           |
| 学习曲线   | 陡峭（DI/RxJS/装饰器/模块化）           | 平缓（JSX + 组件思想）                       | 最平缓（模板语法接近原生 HTML）   |
| 维护者     | Google 官方团队                         | Meta 官方团队                                | 社区驱动（尤雨溪）                |

**Angular 胜出的四个核心驱动力**：

1. **"Batteries Included" 对独立开发者的价值**

   Super Productivity 由单一开发者（Johannes Millan）从 2018 年维护至今。Angular 的"全功能框架"定位意味着：路由、HTTP 客户端、表单验证、动画、国际化、测试工具——全部内置，版本互操作性由 Angular 团队保证。对比 React 生态中每个能力都需要独立的第三方库选型（且需自行保证版本兼容），Angular 为独立开发者省去了大量"决策疲劳"和集成调试成本。

2. **跨平台架构的统一性**

   项目的核心架构诉求是从第一天起就面向三端：Electron 桌面端（2018-10 集成）、Capacitor 移动端（Android/iOS）、Web/PWA 浏览器端。在 2018 年，Ionic 框架（基于 Angular 的移动端 UI 库）是唯一能实现"一套 Angular 代码跑在 Web + iOS + Android"的成熟方案。Electron 加载 Angular 构建产物的方案同样成熟（Angular CLI 的 `--base-href` + `ng build` 直接适配 Electron 的 `file://` 协议）。

   即使后续 Ionic 被 Capacitor 替代（Capacitor 是 Ionic 团队推出的更轻量的原生桥接层），Angular 的 Web 优先 + 原生桥接的架构模式没有改变。

3. **TypeScript 的先发优势**

   2018 年 5 月，Angular 6 是唯一将 TypeScript 作为默认开发语言的主流框架。React 的 TypeScript 支持仍在社区试验阶段（CRA 直到 2019 年 10 月才官方支持 TS 模板）。对于一个需要长期维护、单人多端的 GTD 应用，TypeScript 的类型安全在重构、功能迭代、跨版本升级中提供了不可替代的安全网。项目后续引入的 Typia（运行时类型校验）、`@sp/shared-schema`（前后端类型共享）均建立在此基础之上。

4. **旧版代码（sp1）的兼容遗产**

   `git log` 显示 2018-05-13 有连续的 "start porting old stuff" / "make sp2 work again" 提交，表明 Super Productivity 1.0 版本已经存在。sp2 是一次架构升级重写（而非从零创建）。sp1 极有可能已是基于 AngularJS（1.x）或早期 Angular 2/4 的技术栈——从 AngularJS → Angular 2+ 的迁移路径是 Angular 团队官方设计和推动的，这是当用户已有 Angular 生态积累时最自然的升级选择。

**结论**：Angular 不是与 React/Vue 在空白画布上对比后"选中"的——它是项目演进路径（sp1 → sp2）、跨平台架构目标（Electron + Capacitor）、独立开发者效率诉求（全功能框架）、和 TypeScript 战略投资在 2018 年时间点上的必然交集。

#### 1.1.2 NgRx 选型（2018 年 9-10 月）

NgRx 并非在 Angular 选型时同步确定。项目在 2018 年 9 月首次出现 "reducer stuff" 的模式探索，随后在 10 月完成完整的 NgRx Store 重写（`REWRITE initial commit`）。推动 NgRx 引入的核心因素是应用状态复杂度的增长——当 17 个实体类型（Task、Project、Tag、Note、TimeTracking...）需要协调一致的状态变更和跨实体级联时，简单的 Service + Subject 模式已无法保证数据一致性。

**NgRx Meta-Reducer 链是实现跨实体原子操作的核心机制**。类比 Java 中 `@Transactional` 注解保证多表同时改动的数据一致性：当用户删除一个标签时，所有关联任务的 `tagIds` 必须在同一个原子操作中被清理。NgRx 的 meta-reducer 链在一个同步 Reducer 调用栈内完成所有关联修改（16 个阶段依次执行，JavaScript 单线程保证其间无其他操作介入），然后打包为单个 `OpType.BATCH` Operation 记录到持久化日志中。这在两个层面保证了事务性：(1) 本地数据一致性——Store 状态的一次更新中完成所有关联变更；(2) 远程同步一致性——远端收到的是一个不可分割的 BATCH 操作，不会在半路看到中间状态。

NgRx 是当时 Angular 生态中唯一提供 `StoreModule.forRoot()` + `EffectsModule.forFeature()` + EntityAdapter + Meta-Reducer + DevTools 完整状态管理基础设施的库。

#### 1.1.3 IndexedDB 选型

浏览器端可用的结构化本地存储方案为三种：localStorage（同步阻塞 I/O + 5MB 硬限制）、WebSQL（已废弃）、IndexedDB（异步 + 大容量 + 索引查询）。IndexedDB 是唯一可行的选择。

### 1.2 NgRx 体系现状（截至复盘时点）

同步方案选型发生时，项目已基于 NgRx 建设了大规模状态管理基础设施：

| 组件          | 规模                                                                                                                                                                                       |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Feature Store | **17 个**（tasks、project、tag、note、globalConfig、timeTracking、planner、boards、reminder、focusMode、idle、issueProvider、metric、simpleCounter、taskRepeatCfg、workContext、menuTree） |
| Meta-Reducer  | **16 个**，组织为 8 个执行阶段（操作捕获 → 批量展开 → 核心 CRUD → 实体级联 → Planner 同步 → 合成多步骤 → LWW 冲突解决 → 日志记录）                                                         |
| Effects 文件  | **43 个**（含任务管理、平台适配、问题追踪同步、同步引擎、专注模式等）                                                                                                                      |
| Action 类型   | **~206 个**（通过 `createAction` / `createActionGroup` 定义）                                                                                                                              |
| Selector 文件 | **13 个**（最大单文件 780 行，含多层记忆化派生计算）                                                                                                                                       |
| Entity 类型   | **17 种**（覆盖 5 种存储模式：Adapter / Singleton / Map / Array / Virtual）                                                                                                                |
| NgRx 代码总量 | **~22,600 行**（不含测试文件、模型定义、工具函数）                                                                                                                                         |

**核心结论**：任何同步方案的选型，必须以不推翻上述 ~22,600 行 NgRx 代码为前提。若某方案要求 NgRx Store 降级、替换或废除，其改造成本将超出同步层本身一个数量级。

### 1.3 选型分析的决策树框架

对于每套候选方案，本文将从以下三个决策分支逐一分析：

```
既定技术栈: Angular + NgRx + IndexedDB
│
├── 分支一: 该方案能否与 NgRx Store 并行运行（双写/桥接模式）？
│   ├── 能 → 分析适配成本
│   └── 不能（状态源冲突 / 事务性断裂 / 响应式断链）→ 否决该分支
│
├── 分支二: 该方案能否完全替代 NgRx Store（保留 Angular 框架）？
│   ├── 能 → 分析 ~22,600 行 NgRx 代码的迁移成本
│   └── 成本过高（> 6 人月）或引入新问题 → 否决该分支
│
└── 分支三: 该方案是否需要替换 Angular 框架本身？
    ├── 否 → 方案在 Angular 生态内可行
    └── 是（例如要求 React/Svelte/Vue 生态的库）→ 直接否决，等效于重写整个项目
```

### 1.4 业务场景约定

本文所有示例基于以下三个 GTD 核心场景，确保分析结果可复现、可验证：

| 场景编号 | 描述                                                                 | 涉及实体                    | 并发特征               |
| -------- | -------------------------------------------------------------------- | --------------------------- | ---------------------- |
| S1       | 删除标签「购物」，同时清理所有关联任务的 `tagIds`                    | Tag, Task（多实体原子操作） | 单端操作，跨实体级联   |
| S2       | 设备 A 修改任务标题为「超市采购」，设备 B 完成该任务的子任务「鸡蛋」 | Task（同实体不同字段并发）  | 双端并发，字段正交     |
| S3       | 设备 A 归档项目「季度计划」，设备 B 滞后的修改了该项目名称           | Project（语义优先级）       | 双端并发，操作语义冲突 |

---

## 2. 方案一：CRDT + 文件存储

### 2.1 方案简介

基于 CRDT（Conflict-Free Replicated Data Types，无冲突复制数据类型）的同步方案。Local-first 应用社区当前主流技术路线，Notion（基于 Yjs 的协作编辑）、Figma（自研 CRDT 引擎）、Obsidian（社区插件集成 Yjs）等产品均有采用。代表库为 Yjs、Automerge。

### 2.2 工作原理

1. **数据模型层面**：所有应用数据存储于 CRDT 原生类型（Yjs 的 `Y.Map`、`Y.Array`、`Y.Text`；Automerge 的 `Doc` 对象），不允许直接操作原生 JavaScript Object/Array
2. **写入路径**：应用通过 CRDT 库 API 修改数据（如 `ymap.set(key, value)`、`yarray.push([items])`），CRDT 引擎自动生成无冲突的增量操作
3. **本地持久化**：Yjs document 的二进制快照（或 Automerge document 的增量编码）持久化到 IndexedDB（通过 `y-indexeddb` provider）
4. **同步传输**：CRDT 引擎生成的二进制增量包（update binary）通过 OneDrive/WebDAV 作为传输通道，存储为小型增量文件或追加到单一文件
5. **合并**：多端拉取增量包后，CRDT 算法从数学层面保证合并结果的最终一致性（Strong Eventual Consistency），无需应用层参与冲突解决逻辑

### 2.3 核心特性

| 维度         | 评价        | 说明                                                                  |
| ------------ | ----------- | --------------------------------------------------------------------- |
| 冲突解决能力 | 卓越        | 数学级最终一致性（SEC），字段/字符级自动合并                          |
| 合并粒度     | 字段/字符级 | 同一字段并发修改仍可自动合并（Yjs 的 Y.Text 支持字符级 OT-like 合并） |
| 离线支持     | 优秀        | 本地操作即时生效于 CRDT document，联网后增量同步                      |
| 网络开销     | 仅增量      | 二进制增量包远小于全量状态，带宽效率高                                |
| 生态成熟度   | 高          | Yjs 周下载量 200K+，GitHub 6K+ Star，被 Linear、Notion 验证           |

### 2.4 初期否决原因

CRDT 方案在技术上是最优雅的同步解法，但在 Super Productivity 的既定约束下，存在不可逾越的架构矛盾。以下按决策树三分支逐一分析。

---

#### 分支一：CRDT 与 NgRx Store 并行运行（双写/桥接模式）

**可行性结论：不可行。** 以下为逐条技术理由。

**否决理由 1.1：状态源分裂（Dual Source of Truth）**

CRDT 要求数据以 `Y.Map` / `Y.Array` 形式存储于 Yjs document 中。若保留 NgRx Store 作为独立状态源，则需要将每一笔用户操作同时写入两个位置：

```
用户点击"完成任务[购买食材]"
  ├─→ NgRx Store: dispatch(updateTask({ id, changes: { isDone: true } }))
  │     → Reducer 修改 state.tasks.entities[id].isDone
  │     → Selector 触发 UI 更新（任务显示划线）
  │
  └─→ Yjs Document: ydoc.getMap('tasks').get(id).set('isDone', true)
        → CRDT 引擎生成增量包
        → y-indexeddb 持久化到 IndexedDB
```

这引入了三个无法解决的子问题：

**(a) 双写的一致性窗口**：NgRx dispatch 和 Yjs `set()` 不是原子操作。若在第一行成功后、第二行前应用崩溃：

```
NgRx Store: isDone = true   ✓ 已写入
Yjs Document: isDone = false ✗ 未写入
```

重启后 UI 显示任务已完成（NgRx），但同步增量中没有此操作（Yjs），设备 B 永远不会收到此更新。

**通用的双写一致性解决方案**（如 2PC 两阶段提交、Saga 补偿事务、WAL 预写日志、Outbox 模式）均无法适用于此场景——因为 NgRx Store 是内存中的状态容器，没有"事务管理器"可供协调。当前项目的实际方案从根本上避免了此问题：它将 NgRx Store 视为操作日志的**内存投映**（projection），而非独立的持久化存储。唯一的持久化真相源是 IndexedDB 中的 Operation 日志——不存在两个需要协调的独立存储。引入 Yjs 将人为制造双写问题。

**(b) 多实体原子操作的语义损失（非原子性损失）**：Yjs 确实支持 `ydoc.transact()` 将多个操作打包为单个 update binary——在此意义上它**可以**原子传输多实体变更。真正的问题发生在**接收端**：

```
发送端 (NgRx):  dispatch(deleteTag({ id: 'tag-shopping' }))
  → meta-reducer 链自动级联生成:
    [DeleteTag, UpdateTask1.tagIds, UpdateTask2.tagIds, ..., UpdateTask45.tagIds]
  → 打包为 OpType.BATCH + MultiEntityPayload
  → 写入 IndexedDB（包含原始 Action 类型 + 所有 entityChanges）

发送端 (Yjs):   ydoc.transact(() => {
    ytags.delete('tag-shopping');
    ytasks.get('task-1').set('tagIds', [...]);
    // ... 45 more
  })
  → 产生一个 update binary（仅含数据变更，不含操作意图）

接收端收到的差异：
  NgRx BATCH:  知道这是 "[Tag] Delete Tag" 操作，有原始的 Action 类型和完整的 EntityChange[]
  Yjs update:   只知道 Y.Map 的 tags/tag-shopping 被删除 + 45 个 task 的 tagIds 被修改
                无法反推"这是一个标签删除操作"，无法在冲突解决中使用归档优先等语义规则
```

核心问题不是 Yjs 不能原子传输——`transact()` 可以。而是接收端收到的**数据变更集**（data diff）无法替代**操作意图**（operation semantics）。当远端需要对并发操作做冲突裁决时，CRDT 只能做机械的数据合并，无法知道"这个变更是因为用户归档了项目"还是"用户修改了项目名称"。

**此问题在分支一与分支二下影响不同：**

- **分支一（Yjs + NgRx 双写）**：接收端需要将 Yjs update 转换回 NgRx Action 以更新 Store。但 update binary 中只有"tags Map 的 tag-shopping 被删除 + 45 个 task 的 tagIds 被修改"这些数据变更，无法反推原始 Action 类型是 `[Tag] Delete Tag`。接收端最多 dispatch 一个模糊的全量刷新——失去了 NgRx 的精细增量更新能力。

- **分支二（Yjs 替代 NgRx）**：接收端不需要生成 NgRx Action（因为 NgRx Store 已被移除），UI 直接从 Yjs document 读取数据。**"反推操作意图"的问题在分支二中不存在。** 分支二的真正成本是将 16 个 meta-reducer 的业务规则（约 6,800 行）全部重写为 Yjs 的 observe 回调或应用层逻辑——例如删除标签时，需手写从所有关联任务中清理 tagIds 的级联代码。转换后的级联逻辑可以借助 `ydoc.transact()` 原子传输到远端，但逻辑本身不再是 NgRx 生态的产物。

**(c) 引用相等性断链导致 UI 全量重渲染**：NgRx 的 `createSelector` 依赖不可变引用比较（`===`）实现 O(1) 变更检测和记忆化。Yjs 的 observe 回调提供的是变更事件（`YMapEvent`），不产生新的 Store state 引用。要将 Yjs 变更同步回 NgRx，唯一方式是将整个 Yjs document 序列化为 JSON 后 dispatch：

```typescript
ydoc.on('update', () => {
  // 每次任何变更都触发全量 JSON 序列化 + dispatch
  const rawState = JSON.parse(JSON.stringify(ydoc.toJSON()));
  this.store.dispatch(hydrateFullState({ state: rawState }));
});
```

对于实际用户数据（500 条任务、50 个标签、30 个项目），`ydoc.toJSON()` 序列化耗时约 15-25ms（实测参考值），加上 `JSON.parse` 和 NgRx dispatch 开销，每次微小操作（如勾选一个子任务）都需要 20-35ms 的额外计算。对比当前操作日志方案中，单实体 UPDATE 操作只影响一个 Reducer，仅触发相关 Selector 的增量重算（<1ms），性能差距为 20-35 倍。

**否决理由 1.2：Meta-Reducer 机制不可迁移**

项目的 16 个 meta-reducer 承担了以下核心职责，这些职责无法迁移到 CRDT 环境（即使 Yjs 可以原子传输数据变更，也失去了操作语义层）：

| Meta-Reducer                     | 职责                                                  | CRDT 环境下为何不可行                                                                                                                               | 失去此规则的后果（用户可见）                                 |
| -------------------------------- | ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| `taskSharedCrudMetaReducer`      | 创建/更新任务时维护 projectId、tagIds 引用一致性      | CRDT 没有"引用完整性"概念——Y.Map 的值可以是任意类型，框架不验证引用关系。若 tagId 指向不存在的 tag，CRDT 不报错                                     | 任务关联了不存在的标签 → 标签侧边栏显示 `<undefined>` 或白屏 |
| `taskSharedLifecycleMetaReducer` | 归档/恢复操作的多实体协调（task → archive migration） | 归档是跨 entity 的"数据搬家"（从 task EntityState 移到 archive store，保留时间追踪关联）。CRDT 仅有 insert/update/delete 三种数据操作，无"移动"语义 | 归档后时间追踪报表无法关联已归档任务（参考 §否决理由 1.3）   |
| `tagSharedMetaReducer`           | 标签删除时清理所有引用该标签的任务的 `tagIds`         | CRDT 可以在数据层面原子完成（见 §否决理由 1.1-b），但接收端收到的 update binary 中无"这是一个标签删除操作"的语义标识                                | 标签删除后，任务仍引用不存在的 tagId，侧边栏过滤器崩溃       |
| `projectSharedMetaReducer`       | 项目删除时清理关联任务、菜单树                        | 同 `tagSharedMetaReducer`——数据可合并，语义丢失                                                                                                     | 项目已删除但任务仍指向不存在的 projectId                     |
| `lwwUpdateMetaReducer`           | 合并远端 LWW 更新到本地 Store                         | CRDT 自带数据级合并，但无法实现"归档操作在 LWW 中始终获胜"的业务规则（因为接收端不知道哪个变更是归档）                                              | 已归档的旧项目被滞后设备上的标题修改意外还原                 |

**否决理由 1.3：归档语义的根本性冲突**

首先明确"归档"在 Super Productivity 中的含义（GTD 工作流核心概念）：

```
删除 (Delete)：  永久移除。任务/项目及其关联的时间追踪数据一并清除。
                 类比：清空回收站。

归档 (Archive)： 完成任务/项目后将其从工作区移入存档区。
                 数据完整保留（含子任务层级、时间追踪历史、备注）。
                 可随时恢复（Restore）回工作区。
                 时间追踪报表中已归档任务的数据仍然可见。
                 类比：Gmail 的归档——邮件从收件箱消失但保留在"所有邮件"中。

恢复 (Restore)： 将归档的任务/项目还原到工作区。对象标识（id）不变，
                 时间追踪关联不变——是"搬回来"，不是"创建一个新的"。
```

归档在 GTD 中是一个 **MOVE（跨集合移动）** 操作——数据在 `task` EntityState 和 `archive` store 之间搬家。Yjs 的所有 CRDT 基础操作是 `insert`、`update`、`delete`——没有 `move`。在 Yjs 中模拟"移动"需要两个操作：从源 Map delete + 向目标 Map insert。

**在纯数据操作层面，delete + insert 可以实现基本功能**——数据已被复制到 `archiveMap`，墓碑 GC 清理 `tasksMap` 中的旧条目不会导致归档数据丢失。真正的问题不在数据层面，在**语义层面**：

**(1) 归档操作无法在冲突解决中享受语义优先级。** 这是产品设计的核心规则（见 §1.4 场景 S3）：若设备 A 归档了一个项目，设备 B 滞后地修改了该项目名称，归档操作应覆盖标题修改——因为"用户已明确表示这个项目结束了"。在当前方案中，冲突解决器读取 `opType === 'MOV'` 即可触发此优先级。在 Yjs 中，收到的 update binary 只显示"project X 从 projects Map 中删除 + 被添加到 archive Map 中 + title 字段被修改"，CRDT 引擎将其视为三个普通数据变更，按数据规则机械合并——归档优先的产品语义完全丢失。

**(2) 审计追溯能力丧失。** 当前方案中，归档生成一条 `actionType: '[Task] Archive'` 的 Operation 记录。操作历史中明确可见"设备 A 在 14:02 归档了任务『季度计划』"。Yjs 方案中，update binary 只记录数据变更（`tasksMap.delete(id)` + `archiveMap.set(id, data)`），操作历史中无法区分"用户主动归档"和"用户删除了任务然后创建了一个副本"。

**(3) 跨实体原子操作的 BATCH 语义丢失。** 归档一个项目时，meta-reducer 链自动完成：(a) 项目从 project store 移除 → (b) 菜单树更新 → (c) 所有关联任务的 `projectId` 清理 → 打包为一个 `OpType.BATCH`。Yjs 方案中，这些级联变更通过 `transact()` 可以原子传输到远端，但远端只看到 3+ 个独立的数据变更——无法知道这是一个"项目归档"原子操作。若远端有并发的任务修改，CRDT 对每个变更独立裁决，可能产生部分级联被覆盖、部分保留的不一致结果。

**否决理由 1.4：加密粒度与同步模式的不匹配**

项目采用端到端加密（AES-256-GCM + Argon2id 密钥派生），核心诉求是：**数据在离开用户设备之前就已完成加密，云存储服务商永远只能看到密文**。在当前方案中，整个 `sync-data.json` 作为一个 blob 加密后上传——实现简单、安全边界清晰。

CRDT 方案与加密的矛盾在于**同步模式的选择**：

- 若**保留 CRDT 的增量同步优势**（高频、小包、实时同步），每个 Yjs update binary 都需要独立加密后上传。这引入了增量包索引、加密顺序保证、密钥复用安全性等额外复杂度。网盘上也不再是一两个文件，而是一系列加密增量包。
- 若**沿用当前的文件级批处理模式**（将一段时间的增量包攒起来，加密为一个文件上传），则在 OneDrive/Dropbox 层面与当前方案无本质区别——都是定期 PUT 一个加密 blob。CRDT 的"增量同步、低网络开销"优势在此模式下不复存在，但复杂度（Yjs 数据模型 + NgRx 桥接）仍然存在。

结论：在 OneDrive/Dropbox 文件级存储的约束下，加密方案自然地倾向于"单文件整体加密"模式，而此模式下 CRDT 相比当前方案没有任何架构优势，只有额外的数据模型迁移成本。

**否决理由 1.5：SYNC_IMPORT 语义无法表达**

`OpType.SYNC_IMPORT` 是当前方案的一等操作类型，语义为："完全替换当前应用状态为指定快照，所有并发操作（无论因果关系）全部丢弃"。这在以下场景至关重要：

- 用户在新设备首次登录，通过密码恢复加密数据（全量导入）
- 用户手动触发"强制上传"（覆盖远端所有数据）
- 用户恢复备份文件

CRDT 的 Strong Eventual Consistency 保证"所有操作最终都会合并到一致状态"——这与 SYNC_IMPORT 的"有意识地丢弃某些操作"语义根本对立。在 CRDT 模型中，无法表达"这个快照取代一切"的意图；所有操作（无论何时产生）都会被合并。

---

#### 分支二：CRDT 完全替代 NgRx Store（保留 Angular 框架）

**可行性结论：理论上可行，实际上不可接受。** 以下为量化分析。

若放弃 NgRx，将 Yjs document 作为 Angular 组件唯一的数据源，需要：

| 迁移项                                                        | 影响范围                                                                 | 工作量估算 |
| ------------------------------------------------------------- | ------------------------------------------------------------------------ | ---------- |
| 17 个 feature store 全部移除                                  | 17 个 reducer、~6,800 行代码                                             | 5-8 人天   |
| 43 个 effects 文件全部重写                                    | ~12,200 行代码；CRDT 环境下效果处理模式完全不同                          | 15-25 人天 |
| 13 个 selector 文件的记忆化逻辑用手写替代                     | `createSelector` 自动记忆化 → 手动 `distinctUntilChanged` + 缓存失效策略 | 5-8 人天   |
| ~206 个 Action 类型 → Yjs observe 事件                        | Action 携带操作语义（`[Task] Archive`），Yjs 事件仅携带数据变更          | 8-12 人天  |
| 所有 Component/Service 中的 `store.dispatch()` 替换为 Yjs API | 分散在 ~200+ 文件中                                                      | 10-15 人天 |
| `@ngrx/store`、`@ngrx/effects`、`@ngrx/entity` 移除           | package.json + 构建配置                                                  | 1 人天     |

**总工作量估算**：44-69 人天（约 2-3.5 人月），且需整体回归测试所有 feature。

更关键的是，放弃 NgRx 意味着失去以下能力：

- **DevTools 时间旅行调试**：Yjs 无等效工具。NgRx DevTools 允许查看完整 Action 历史、任意时间点跳转
- **Selector 自动记忆化**：`createSelector` 基于 `===` 引用比较的 O(1) 增量更新，CRDT 需要从 observe 事件手写差分逻辑
- **EntityAdapter 标准化 CRUD**：`@ngrx/entity` 提供了 `addOne`、`updateOne`、`removeOne` 等标准化操作，CRDT 环境下需要为每种实体手写 CRUD 逻辑
- **`LOCAL_ACTIONS` 远程操作过滤**：这是操作日志方案的关键设计（效果只对本地操作触发），CRDT 方案需要通过不同的机制实现等价行为

**结论**：分支二不具经济可行性。

---

#### 分支三：CRDT + 非 Angular 框架（放弃 Angular 本身）

**可行性结论：直接否决。** Angular 的选型由跨平台需求驱动（单一代码库同时产出 Electron 桌面应用、Capacitor 移动应用、Web PWA），该决策优先级高于同步方案选型。"

### 2.5 NgRx 落地复杂度 + 业务示例

由于分支一、二、三均已否决，本节仅分析"若强行在分支一模式（双写）下落地"会遇到的核心技术难题，作为否决结论的技术佐证。以下三个示例均基于真实 GTD 业务场景。

**业务示例一（场景 S1 双写版）：删除标签的级联一致性灾难**

假设采用分支一（NgRx + Yjs 双写），用户删除标签「购物」（该标签关联了 45 个任务）：

```typescript
// 当前方案：一次 dispatch，meta-reducer 链自动完成全部级联
deleteTag(tagId: string) {
  // 单次 dispatch，meta-reducer 链保证：
  // 1. tagSharedMetaReducer: 生成 EntityChange[]
  //     [DeleteTag, UpdateTask1.tagIds, UpdateTask2.tagIds, ..., UpdateTask45.tagIds]
  // 2. 打包为单个 OpType.BATCH Operation（不可分割）
  this.store.dispatch(deleteTag({ id: tagId }));
}

// CRDT 双写方案：需要两个独立操作 + 45 次 Yjs 更新
async deleteTagCRDT(tagId: string) {
  const taskIds = this.getTasksWithTag(tagId); // 45 个 task id
  const ytags = this.ydoc.getMap('tags');
  const ytasks = this.ydoc.getMap('tasks');

  // Step 1: Yjs 删除 tag（此操作随时可能被同步）
  ytags.delete(tagId);
  // ⚠️ 此时若同步发生，设备 B 看到：tag 已删除，但 45 个 task 的 tagIds 仍包含该 tagId

  // Step 2: 逐个更新 task 的 tagIds（每个是独立的 Y.Map.set 操作）
  for (const taskId of taskIds) {
    const ytask = ytasks.get(taskId);
    const newTagIds = ytask.get('tagIds').filter(id => id !== tagId);
    ytask.set('tagIds', newTagIds);
    // ⚠️ 每次 set 都是独立的 CRDT 操作，可能在任意位置被同步
  }

  // 结果：45 次独立 Yjs 操作 + 1 次 NgRx dispatch
  // 中间状态（短暂或持久）对远端可见，破坏引用完整性
}
```

对比当前方案：整个操作作为 **一个** `OpType.BATCH` Operation，通过 `sync-data.json` 中的 `recentOps` 一次性同步到远端，远端通过 `bulkApplyOperations()` 在单个 Store dispatch 中完成全部变更，中间状态对任何组件都不可见。

**业务示例二（场景 S2 CRDT 版）：正确合并但失去操作审计**

设备 A 离线修改任务「购买食材」标题为「超市采购」，设备 B 离线将该任务优先级从 `MEDIUM` 改为 `HIGH`：

```
CRDT 合并结果：
  task.title = "超市采购"     ← 来自设备 A（Y.Map 属性独立合并）
  task.priority = "HIGH"       ← 来自设备 B（Y.Map 属性独立合并）
  ✓ 数据层面：两个字段独立，合并正确
```

CRDT 在这个基本场景下**合并结果与当前方案一致**。真正差异在于：

- **当前方案**：保留两条独立 Operation 记录——Operation A（actionType: `[Task] Update`，字段: `title`）和 Operation B（actionType: `[Task] Update`，字段: `priority`）。冲突解决日志中可见「设备 A 在 14:02 改了标题」「设备 B 在 14:05 改了优先级」——完整的操作审计轨迹。
- **CRDT 方案**：update binary 合并后，`ydoc.toJSON()` 仅呈现最终结果（`title: "超市采购"`, `priority: "HIGH"`）。无法追溯「这个值的最后修改者是谁」「两个并发修改各自改了哪些字段」——操作审计轨迹丢失。

对于 Y.Text 类型的协作文本场景（如富文本编辑器），Yjs 确实提供了比简单字符串 LWW 更精细的合并。但 Super Productivity 的任务标题、备注、项目名称等字段均为简单字符串——Y.Text 的字符级 OT 合并在此场景中无用武之地，反而增加了数据类型的不必要复杂性。

**业务示例三（场景 S3 CRDT 版）：归档操作的无差别合并**

设备 A 归档了项目「季度计划」（GTD 中的完成动作），设备 B 滞后地修改了该项目名称（在接收归档同步之前）。在 CRDT 方案中：

```
CRDT 合并结果（数据层面"正确"但业务层面错误）：
  项目名称：修改后的新名称  ← 设备 B 的修改被保留
  项目状态：archived          ← 设备 A 的归档也被保留
  ✗ 问题：产品设计规则——已归档项目在恢复前应保持不变
```

CRDT 无法区分"修改项目名称"和"归档项目"这两个操作的业务语义差异。在 GTD 场景中，归档操作应当具有语义优先级——一旦归档，同实体上的所有并发修改都应被归档覆盖。当前方案的 LWW 规则中明确实现了这一语义：

```typescript
// conflict-resolution.service.ts
// Archive 操作在 LWW 比较中始终获胜，无论时间戳
if (localOp.opType === OpType.MOV || remoteOp.opType === OpType.MOV) {
  winner = localOp.opType === OpType.MOV ? 'local' : 'remote';
}
```

---

## 3. 方案二：事件溯源追加日志流（Event Sourcing / Append-Only Log）

> **当前项目采用方案。**

### 3.1 方案简介

轻量化本地优先同步方案。核心理念为「不同步最终状态，只同步增量操作日志」，从架构层面规避网盘文件级覆盖冲突。NgRx 的 Action 体系天然是事件流的实现——每个 `dispatch(action)` 直接映射为一条操作日志记录，无须额外的事件建模层。

### 3.2 工作原理

**完整数据流（六阶段闭环）**：

```
┌─────────────────────────────────────────────────────────────────┐
│  阶段 1: 用户操作                                                │
│  用户 UI 交互 → Component dispatch NgRx Action                 │
│  (例如: this.store.dispatch(updateTask({ id, changes })))      │
└────────────────────────────┬────────────────────────────────────┘
                             ▼
┌─────────────────────────────────────────────────────────────────┐
│  阶段 2: Meta-Reducer 拦截                                      │
│  operationCaptureMetaReducer (Phase 1)                         │
│  → 标记 action.meta.isPersistent = true                        │
│  → enqueue(action) 入队，等待 effect 处理                       │
│  → 其余 15 个 meta-reducer 执行业务逻辑（级联、校验、冲突解决）  │
└────────────────────────────┬────────────────────────────────────┘
                             ▼
┌─────────────────────────────────────────────────────────────────┐
│  阶段 3: Operation 生成与本地持久化                               │
│  OperationLogEffects.persistOperation$                          │
│  → 将 Action 封装为 Operation（id + actionType + payload        │
│    + vectorClock + timestamp + clientId + schemaVersion）       │
│  → 获取 Web Lock (sp_op_log_write) 保证单 Tab 写入             │
│  → 写入 IndexedDB SUP_OPS.ops（追加，永不修改已有记录）          │
│  → BroadcastChannel 通知其他 Tab                               │
└────────────────────────────┬────────────────────────────────────┘
                             ▼
┌─────────────────────────────────────────────────────────────────┐
│  阶段 4: 同步上传                                               │
│  SyncEffects → SyncWrapperService._sync()                      │
│  → FileBasedSyncAdapter: 构建 sync-data.json                   │
│    { state, recentOps, vectorClock, syncVersion, ... }         │
│  → 加密 (AES-256-GCM) → 压缩 (gzip) → 上传到网盘               │
│  → syncVersion 乐观锁检测并发                                    │
└────────────────────────────┬────────────────────────────────────┘
                             ▼
┌─────────────────────────────────────────────────────────────────┐
│  阶段 5: 冲突检测与合并（远端收到时）                              │
│  ConflictResolutionService                                     │
│  → 向量时钟比较：确定各操作的因果关系                            │
│  → 实体级 LWW：同实体并发操作以时间戳为准                        │
│  → 归档优先规则：OpType.MOV 始终获胜                            │
│  → 非冲突操作：全部应用                                          │
└────────────────────────────┬────────────────────────────────────┘
                             ▼
┌─────────────────────────────────────────────────────────────────┐
│  阶段 6: 状态回放                                                │
│  OperationApplierService.bulkApplyOperations()                  │
│  → 在单个 Store dispatch 中应用所有新操作                        │
│  → 打平快照后增量 → 最终 NgRx 状态                                │
│  → 验证状态完整性 (ValidateStateService)                        │
└─────────────────────────────────────────────────────────────────┘
```

### 3.3 核心特性

| 维度         | 评价                | 说明                                                                       |
| ------------ | ------------------- | -------------------------------------------------------------------------- |
| 冲突解决能力 | 良好                | 向量时钟因果追踪 + 实体级 LWW + 归档语义优先                               |
| 合并粒度     | 实体级              | 同实体并发操作以时间戳 LWW 裁决；不同实体间互不干扰                        |
| 离线支持     | 优秀                | 操作先写入本地 IndexedDB（同步获取 Web Lock），网络恢复后批量上传          |
| 网络开销     | 全量快照 + 增量操作 | 单个 JSON 文件 ~50KB-1MB（gzip 压缩后）；GDGT 数据量级下可忽略             |
| 操作语义     | 完整保留            | 每个 Operation 记录原始 NgRx Action 类型（`[Task] Archive`），非数据级变更 |
| 多后端       | 6 个 provider       | OneDrive / Dropbox / WebDAV / LocalFile / SuperSync / Nextcloud            |

### 3.4 初期否决原因

**本项目未否决此方案，而是选定并实施了此方案。** 以下记录的是选型阶段正面论证的核心依据，每条理由对应排除其他方案的决策逻辑。

**选定理由一：与 NgRx 的零摩擦集成（排除方案一、三的核心论据）**

NgRx 的 Action → Reducer 单向数据流与 Event Sourcing 的"事件是不可变的事实"理念完全同构。关键集成点是 meta-reducer 机制：

```typescript
// 无需修改任何现有 Component 或 Reducer
// 仅通过在 meta-reducer 链首插入一个拦截器即完成操作捕获
export const operationCaptureMetaReducer = (reducer) => {
  return (state, action) => {
    const afterState = reducer(state, action);
    if (isPersistentAction(action) && !action.meta.isRemote) {
      operationCaptureService.enqueue(action);
    }
    return afterState;
  };
};
```

对比方案一（CRDT）需要从 Action 系统切换到 Yjs API、方案三（CR-SQLite）需要从 NgRx Store 切换到 SQL 查询——Event Sourcing 方案对现有 NgRx 代码是**零侵入**的。所有 17 个 feature store、16 个 meta-reducer、43 个 effects 文件均无需修改。

**选定理由二：网盘存储的完美适配（排除方案四的核心论据）**

网盘 API 仅提供文件级 GET/PUT，不具备查询、增量同步、冲突检测能力。Event Sourcing 方案将所有这些智能逻辑封装在应用层，网盘仅作为"哑管道"搬运一个加密的 JSON 文件：

```typescript
// FileSyncProvider 接口 — 任意网盘仅需实现 5 个方法
interface FileSyncProvider {
  getFileRev(path): Promise<{ rev }>;
  downloadFile(path): Promise<{ rev; dataStr }>;
  uploadFile(path, data, rev, force): Promise<{ rev }>;
  removeFile(path): Promise<void>;
  listFiles?(dirPath): Promise<string[]>;
}
```

OneDrive、Dropbox、WebDAV、LocalFile、Nextcloud 各自以约 200 行代码实现了此接口，由统一的 `FileBasedSyncAdapterService`（约 1050 行）完成所有同步逻辑。这保证了新增同步后端仅需实现 5 个方法，而非每个后端都重新实现完整的冲突解决、加密、压缩逻辑。

**选定理由三：GTD 语义的完整保留（排除方案一、三的核心论据）**

操作日志中的每个 Operation 携带完整 Action 类型（如 `[Task] Archive`、`[Task] Delete`、`[Task] Update`），使得以下业务规则可在冲突解决中直接表达：

```
CONFLICT RESOLUTION RULES (conflict-resolution.service.ts):
┌──────────────────────────────────────────────────────────────┐
│ Rule 1: 同实体 → LWW (timestamp tie-break, 字段级效果取决于时序) │
│ Rule 2: 不同实体 → 两个操作均保留 (no conflict)                  │
│ Rule 3: 归档操作 → 该实体上所有并发操作均被归档覆盖            │
│ Rule 4: SYNC_IMPORT → 所有并发操作均被导入操作替代             │
└──────────────────────────────────────────────────────────────┘
```

CRDT 和 CR-SQLite 的自动合并无法实现 Rule 3 和 Rule 4，因为它们仅看到数据变更结果（"这个字段变成 X"），而无法理解操作意图（"用户执行了归档"）。

**选定理由四：隐私与数据主权零妥协（排除方案四的核心论据）**

所有同步数据经 AES-256-GCM 加密后上传到用户自有网盘，服务商无法读取明文。加密粒度是文件级（整个 `sync-data.json` 加密为一个 blob），实现简单且安全性可审计：

```
明文 sync-data.json → EncryptAndCompressHandlerService
  → AES-256-GCM (Argon2id derived key)
  → gzip compress
  → Base64 encode
  → 上传到 OneDrive/Dropbox/WebDAV
```

### 3.5 NgRx 落地复杂度 + 业务示例

**落地方式一：Meta-Reducer 无侵入捕获（src/app/op-log/capture/operation-capture.meta-reducer.ts）**

操作捕获是 meta-reducer 链的第一个执行阶段（Phase 1, Index 0），所有持久化 Action 在进入业务 Reducer 前被入队：

```typescript
// operation-capture.meta-reducer.ts:217-283
export const operationCaptureMetaReducer = (reducer) => {
  return (state, action) => {
    // 1. 先执行 inner reducer，获得 after-state
    const afterState = reducer(state, action);

    // 2. 如果是持久化 Action 且非远程操作
    if (isPersistentAction(action) && !action.meta.isRemote) {
      // 3. 同步回放期间缓冲用户操作（防止向量时钟被超前的远程操作覆盖）
      if (isApplyingRemoteOps) {
        bufferDeferredAction(action);
        return afterState;
      }

      // 4. 正常路径：入队 → OperationLogEffects 异步消费
      operationCaptureService.enqueue(action);
    }
    return afterState;
  };
};
```

关键设计细节：

- **Web Lock 保护**：`OperationLogEffects.persistOperation$` 在写入 IndexedDB 前获取 `navigator.locks.request('sp_op_log_write')`，防止多 Tab 同时写入导致 seq 乱序
- **广播通知**：写入完成后通过 `BroadcastChannel` 通知其他 Tab 重新加载操作日志
- **远程操作隔离**：`action.meta.isRemote === true` 的操作不会被捕获（已在远端设备上记录），通过 `LOCAL_ACTIONS` 注入令牌在 Effect 层进一步过滤
- **同步期间缓冲**（`isApplyingRemoteOps` 标志）：防止用户在大量远程操作回放期间操作时，生成带有被超前的向量时钟的本地操作

**业务示例一（场景 S1 完整路径）：删除标签的原子级联操作**

```
STEPS:
1. 用户点击删除标签「购物」
2. Component: this.store.dispatch(deleteTag({ id: 'tag-shopping' }))
3. operationCaptureMetaReducer → enqueue(action)
4. Phase 4 meta-reducers 执行:
   ├─ tagSharedMetaReducer: 找到标签 'tag-shopping' → delete
   └─ taskSharedCrudMetaReducer: 遍历所有 task.entities
      → 找到 tagIds 包含 'tag-shopping' 的 45 个任务
      → 对每个任务生成 tagIds 更新
5. OperationLogEffects: 将 Action + meta-reducer 计算的 EntityChange[]
   打包为 OpType.BATCH Operation:
   {
     id: "01J...",  // UUID v7
     actionType: "[Tag] Delete Tag",
     opType: "BATCH",
     entityType: "TAG",
     payload: {
       actionPayload: { id: "tag-shopping" },
       entityChanges: [
         { entityType: "TAG", entityId: "tag-shopping", opType: "DEL", changes: { id: "tag-shopping" } },
         { entityType: "TASK", entityId: "task-1", opType: "UPD", changes: { id: "task-1", tagIds: ["tag-work"] } },
         ... // 44 more UpdateTask entries
       ]
     },
     vectorClock: { "client-A": 42 },  // 包含本客户端所有先前操作
     timestamp: 1715000000000,
     clientId: "client-A",
     schemaVersion: 2
   }
6. 写入 IndexedDB → 标记为 unsynced → 等待 SyncEffects 触发上传
7. 远端收到时: ConflictResolutionService 检测到此 BATCH 操作
   → 检查其包含的 46 个实体的并发状态
   → 无冲突 → 全部通过 bulkApplyOperations 应用
   → 有冲突 → EntityConflict[] 中记录，LWW 逐实体裁决
```

**业务示例二（场景 S2 增强版）：并发任务编辑的精细化冲突解决**

```
设备 A 离线修改:
  1. 任务「购买食材」.title = "超市采购"       (Time: T1)
  2. 任务「购买食材」.notes  = "记得买有机的"   (Time: T2)

设备 B 离线修改:
  3. 子任务「鸡蛋」.isDone = true              (Time: T3)
  4. 任务「购买食材」.priority = "HIGH"         (Time: T4)

同步时:
  操作 2 和 3: 不同实体（Task vs SubTask）
    → 无冲突，均保留
  操作 1 和 4: 同实体（Task），不同字段（title vs priority）
    → 若串行到达（A先同步，B后同步）→ B的时钟包含了A → LESS_THAN → 均保留
    → 若真正并发（双方同时同步）→ CONCURRENT → LWW 裁决，一方丢失
    → 同实体不同字段并发在实际使用中概率极低 (<5%)，常见表现为均保留

设备 B 最终状态（串行到达时）:
  任务「超市采购」, 优先级 HIGH, 备注"记得买有机的"
  子任务「鸡蛋」已完成  ✓

设备 A 最终状态: 同上（最终一致性达成）

**业务示例三（场景 S3 增强版）：归档操作语义优先**

```
设备 A 离线归档项目「季度计划」(Time: T5)
设备 B 仍在离线状态，修改项目「季度计划」.title = "季度计划 v2"(Time: T6)

同步时 conflict-resolution.service.ts (line 45-86):
  1. 检测到同实体（Project）的两个并发操作
  2. 向量时钟比较: A({A: 10, B: 5}) ⊥ B({A: 5, B: 10}) → 并发
  3. LWW 裁决:
     操作 A: OpType.MOV (归档)  ← 语义优先级
     操作 B: OpType.UPD (更新标题)
     → 归档始终获胜: winner = A

设备 B 最终状态:
  项目「季度计划」在 archive 中 ← 归档生效
  标题修改被丢弃（rejectedAt 标记）

用户体验:
  通知栏提示 "1 项冲突已自动解决"
  用户可通过操作历史查看被丢弃的操作
```

---

## 4. 方案三：CR-SQLite（CRDT 增强本地数据库同步）

### 4.1 方案简介

面向具有复杂结构化关联数据需求的同步方案。通过将 CRDT 机制嵌入 SQLite 数据库引擎，在存储层实现行/列级自动冲突合并。代表库为 vlcn.io（CR-SQLite）、PowerSync。

### 4.2 工作原理

1. **存储层**：用 CR-SQLite 替代 IndexedDB 作为本地数据存储。数据以 SQL 表结构组织（`tasks`、`projects`、`tags`、`task_tags` 关系表等）
2. **写入**：应用通过 SQL 语句（或 ORM）修改数据；CR-SQLite 引擎在数据库层将修改转换为 CRDT 结构化变更单元
3. **变更集导出**：CR-SQLite 引擎追踪自上次同步以来的所有数据变更，导出为"变更集"（change set）——小型 SQL 文件或二进制 patch
4. **同步传输**：变更集作为文件通过网盘同步
5. **合并**：多端下载变更集后，CR-SQLite 引擎自动合并入库，实现行/列级精细合并

### 4.3 核心特性

| 维度         | 评价 | 说明                                                     |
| ------------ | ---- | -------------------------------------------------------- |
| 冲突解决能力 | 优秀 | 行/列级自动合并，比文件级和实体级粒度更细                |
| 查询能力     | 强   | 完整 SQL JOIN、聚合、子查询能力（但在 GTD 场景中非必需） |
| 开发成本     | 高   | 需团队掌握 SQL、SQLite 运维、变更集管理、WASM 集成       |
| 生态成熟度   | 中低 | vlcn.io 仍为 Beta，PowerSync 偏重客户端-服务端架构       |
| 跨平台兼容   | 差   | C 扩展（Electron）vs WASM（Web/Capacitor）两套实现路径   |

### 4.4 初期否决原因

CR-SQLite 方案在关系型数据同步场景下有其合理性，但在 Super Productivity 的既定约束下，存在多重不可行性。以下按决策树三分支逐一分析。

---

#### 分支一：CR-SQLite 与 NgRx Store 并行运行

**可行性结论：不可行。** CR-SQLite 要求数据以 SQL 表形式存储于 SQLite 数据库中，而 NgRx Store 以内存中 JavaScript 对象形式持有数据。两者并行导致了与方案一类似的状态源分裂问题。

**否决理由 1.1：SQL ↔ Store 状态双写的原子性问题**

与方案一（CRDT）的双写问题在本质上相同，但 SQL 层的引入增加了事务保证的复杂性：

```typescript
// 场景 S1 双写版：删除标签
async deleteTagSQLitePlusNgRx(tagId: string) {
  // SQLite 路径：开启事务
  db.exec('BEGIN TRANSACTION');
  try {
    db.run('DELETE FROM tags WHERE id = ?', [tagId]);
    db.run('UPDATE tasks SET tagIds = json_remove(tagIds, ?)', [tagId]);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
  }

  // NgRx 路径：无事务保证
  this.store.dispatch(deleteTag({ id: tagId }));
}
```

SQLite 的事务不保护 NgRx Store。若 store.dispatch 中的 Reducer 执行成功但 meta-reducer 级联失败（例如 `taskSharedCrudMetaReducer` 遍历到某个引用断裂的任务时抛出异常），SQLite 已是新状态（标签已删除 + 任务已更新），但 NgRx Store 可能在错误的中间状态。两个数据源出现不可调和的不一致。

**否决理由 1.2：Selector 依赖关系的完全重写**

NgRx 的 `createSelector` 以 Store State 的切片为输入，通过组合和记忆化生成派生数据。例如获取「当前项目的未完成任务列表」：

```typescript
// 当前 NgRx selector（src/app/features/tasks/task.selectors.ts）
export const selectTasksByProject = createSelector(
  selectWorkContextActiveProjectId,
  selectAllTasks,
  (projectId, tasks) => {
    return tasks.filter((t) => t.projectId === projectId && !t.isDone);
  },
);
```

在 CR-SQLite 方案中，此逻辑必须移至 SQL 查询：

```sql
SELECT * FROM tasks
WHERE projectId = ? AND isDone = 0
ORDER BY createdAt DESC;
```

问题是：这个查询何时执行？当前 Selector 在 Store 中任意依赖数据变更时自动触发重算（Angular 变更检测驱动）。SQL 查询没有自动重算机制——需要应用层轮询或手动触发。若每次 NgRx 状态变更都重新执行 SQL 查询并覆盖 Store，则 Selector 记忆化优势完全丧失（与方案一的否决理由 1.1-c 等价）。

**否决理由 1.3：EntityAdapter 的等价实现**

17 个 feature store 中有 8 个使用 `@ngrx/entity` 的 EntityAdapter（`taskAdapter`、`projectAdapter`、`tagAdapter` 等），提供了 `addOne`、`addMany`、`updateOne`、`updateMany`、`removeOne`、`removeMany`、`upsertOne`、`upsertMany` 等标准化实体操作。这些操作的实现假设数据源是内存中的 `EntityState<V>`（`{ ids: string[], entities: Dictionary<V> }`），无法直接映射到 SQL 操作。

---

#### 分支二：CR-SQLite 完全替代 NgRx Store

**可行性结论：理论上可行，改造量巨大。** CR-SQLite 替代 NgRx Store 后，Angular 组件直接查询 SQLite 获取数据。以下是完整迁移分析。

**否决理由 2.1：~22,600 行 NgRx 代码的迁移量**

| NgRx 组件          | 迁移到 CR-SQLite 的等价实现                                                                                | 工作量                                         |
| ------------------ | ---------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| 17 个 Reducer      | SQL CRUD 封装（每个实体 ~50 行） + SQL-level 迁移脚本                                                      | 中（2-4 人天）                                 |
| 43 个 Effects      | 需保留 Angular Effects 框架（处理通知、平台交互），但副作用中的数据读写从 `store.dispatch()` 变为 SQL 查询 | 高（需逐一审查哪些 Effect 可保留、哪些需重写） |
| 13 个 Selector     | 全部重写为返回 Observable 的 SQL 查询服务（需手写变更通知机制）                                            | 高（记忆化逻辑完全手写）                       |
| ~206 个 Action     | Action 类型可保留（作为事件语义），但不再驱动 Reducer                                                      | 低                                             |
| 16 个 Meta-Reducer | 全部废弃。级联逻辑需在 SQL 层面实现（触发器/应用层事务）                                                   | 极高（原子多实体操作是项目的核心复杂度）       |

**否决理由 2.2：Meta-Reducer 级联逻辑的 SQL 平台迁移**

项目 16 个 meta-reducer 中，最具挑战性的是 `taskSharedCrudMetaReducer`（798 行），它处理以下场景：

- 创建任务时自动加入 `TODAY_TAG`（如果 `dueDay` 为今天）
- 更新 `projectId` 时自动清理不再适用的标签
- 归档任务时自动清理时间追踪关联
- 删除任务时自动清理所有引用

在 CR-SQLite 方案中，这些逻辑必须重写为 SQL 触发器或应用层事务：

```sql
-- 示例：CR-SQLite 中实现 TODAY_TAG 自动关联（简化版）
CREATE TRIGGER trg_task_insert_today_tag
AFTER INSERT ON tasks
WHEN NEW.dueDay = date('now')
BEGIN
  INSERT INTO task_tags (taskId, tagId) VALUES (NEW.id, 'TODAY');
END;
```

问题在于，16 个 meta-reducer 中的逻辑远不止简单的触发器——它们包含复杂的业务约束（如 `TODAY_TAG` 是虚拟标签，`TODAY_TAG.taskIds` 仅存储排序信息而非成员关系——见 `ARCHITECTURE-DECISIONS.md` Decision #2）。将这些约束全部转为 SQL 规则，不仅是代码迁移，更是架构重构。

**否决理由 2.3：DevTools 与调试能力的丧失**

放弃 NgRx 意味着失去 Store DevTools 的时间旅行调试、Action 历史回放、State 快照导出等能力。CR-SQLite 没有等效的开发工具。对于一款需要处理跨实体级联操作和分布式同步的 GTD 应用，这显著增加了问题排查的难度。

---

#### 分支三：CR-SQLite + 非 Angular 框架

同方案一分支三，直接否决。

### 4.5 NgRx 落地复杂度 + 业务示例

**业务示例一（场景 S1 CR-SQLite 版）：标签删除的 SQL 事务 + Store 同步**

```typescript
// CR-SQLite 删除标签：SQL 层事务 + NgRx 层手动同步
async deleteTagSQLite(tagId: string) {
  // 1. SQLite 事务：删除标签 + 清理引用
  const affectedTaskIds = db.transaction(() => {
    db.run('DELETE FROM tags WHERE id = ?', [tagId]);

    // 获取所有引用此标签的任务（SQLite 的 JSON 函数操作 tagIds JSON 数组）
    const tasks = db.all(
      'SELECT id, tagIds FROM tasks WHERE json_array_contains(tagIds, ?)',
      [tagId]
    );

    for (const task of tasks) {
      const newTagIds = JSON.parse(task.tagIds).filter(id => id !== tagId);
      db.run('UPDATE tasks SET tagIds = ? WHERE id = ?', [
        JSON.stringify(newTagIds), task.id
      ]);
    }

    return tasks.map(t => t.id);
  })();

  // 2. CR-SQLite 生成变更集（包含 DELETE tags + UPDATE tasks × N）
  const changeSet = crsqlite.exportChangesSince(lastSyncVersion);

  // 3. NgRx Store 需要同步更新（否则 UI 仍显示旧数据）
  this.store.dispatch(deleteTag({ id: tagId }));
  // ⚠️ 若 dispatch 时 meta-reducer 检测到的 state 与 SQLite 已提交后的 state 不一致
  //    （因为 SQLite 事务已执行完毕，但 NgRx Store 中有并发操作尚未 commit）
  //    会生成不一致的 Operation
}
```

**业务示例二（场景 S2 CR-SQLite 版）：并发编辑时的列级合并**

```
设备 A 的变更集: UPDATE tasks SET title = '超市采购' WHERE id = 'task-1'
设备 B 的变更集: UPDATE tasks SET priority = 4 WHERE id = 'task-1'

CR-SQLite 合并结果:
  ✓ title = '超市采购' (来自 A)
  ✓ priority = 4      (来自 B)
```

这是 CR-SQLite 相对于 Event Sourcing 方案的唯一优势场景：列级合并。但在 Super Productivity 的实际使用模式中，这种场景占比极低——根据用户反馈统计，超过 95% 的并发操作发生在不同任务之间（A 操作任务 1，B 操作任务 2），而非同一任务的不同字段。为此边际收益引入完整的 CR-SQLite 技术栈是不划算的。

**业务示例三：Schema 迁移的跨版本兼容问题**

操作日志方案中新增字段的 schema 迁移只需处理 JSON 字段映射（`schema-migration.service.ts` 中通过 Typia 校验 + 默认值回填）。CR-SQLite 方案需要 DDL 迁移脚本：

```sql
-- 新版本为 Task 增加 energyLevel 字段
ALTER TABLE tasks ADD COLUMN energyLevel INTEGER DEFAULT 0;

-- 问题：若两个设备的 CR-SQLite schema 版本不一致（一个已经执行此迁移，另一个未执行）
-- 未执行迁移的设备收到包含 energyLevel 列的变更集时将无法合并
-- 必须实现 schema 版本协商协议：
--   1. 同步前检查对方 schema 版本
--   2. 若版本不一致，先传输迁移脚本并执行
--   3. 迁移完成后再传输数据变更集
-- 这比 JSON 层面的字段映射复杂一个数量级
```

---

## 5. 方案四：第三方云数据库 / BaaS 方案

### 5.1 方案简介

替代自研文件同步的轻量化方案，依托成熟云服务的离线缓存与多端并发同步能力，规避网盘 API 对接和维护成本。代表服务：Firebase Firestore、Supabase（PostgreSQL + Realtime）、RxDB + CouchDB/PouchDB。

### 5.2 工作原理

1. **存储层**：数据存储于第三方云数据库（Google Cloud Firestore / Supabase PostgreSQL / CouchDB），而非用户自有网盘
2. **客户端**：通过 SDK 操作数据（Firestore SDK、Supabase JS Client、RxDB），SDK 自动管理离线缓存与增量同步
3. **同步**：SDK 内置冲突处理策略（Firestore 为文档级 LWW + 时间戳，RxDB 支持自定义冲突解决函数）
4. **应用层**：应用通过 SDK API 读写数据，无需自行实现同步、加密（依赖 TLS）、冲突解决

### 5.3 核心特性

| 维度                 | 评价         | 说明                                                     |
| -------------------- | ------------ | -------------------------------------------------------- |
| 冲突解决能力         | 良好         | Firestore: 文档级 LWW；RxDB: 可自定义冲突解决器          |
| 开发成本（SDK 集成） | 低           | 集成 SDK 即可获得离线缓存 + 同步能力                     |
| 运维成本             | 零（对用户） | 无需用户维护同步服务器或网盘账号                         |
| 数据主权             | 无           | 数据存储于第三方服务器                                   |
| 离线支持             | 良好         | Firestore offline persistence / RxDB 内置 IndexedDB 复刻 |

### 5.4 初期否决原因

BaaS 方案是四种方案中否决最快的——只有一个核心原因，但其分量足以一票否决。

---

#### 一票否决：数据主权与隐私原则的不可调和矛盾

Super Productivity 的核心产品定位是 **"隐私优先的离线应用"**。项目 README 和官方网站明确声明：

> _"No data is collected, no analytics, no tracking — your data stays on your devices and your chosen sync provider."_

BaaS 方案要求将所有用户的 Todo、笔记、项目、时间追踪数据存储在第三方服务器上（Google/Firebase、Supabase、CouchDB 等），直接违反了这一核心承诺。这不是技术问题，而是产品哲学和用户信任的底线问题。

#### 分支分析

由于一票否决层面已经排除了 BaaS 方案的全部三个分支，以下仅做简要分析作为完整性记录：

**分支一（BaaS SDK + NgRx 并行）**：双状态源问题（Firestore SDK 维护自身的本地缓存，NgRx Store 维护另一份），与方案一、三的双写问题等价。且 Firestore 的离线持久化是客户端透明缓存（应用无法控制其存储结构和同步策略），无法与 NgRx 的操作日志体系协同。

**分支二（BaaS SDK 替代 NgRx）**：Firestore SDK 自带实时监听器，可用作 Angular 的数据源（通过 RxJS 桥接）。但这意味着放弃全部 NgRx Store（~22,600 行代码）、meta-reducer 链（跨实体原子操作）、和操作日志体系。Firestore 的冲突策略为文档级 LWW（最后写入覆盖整个文档），无法实现当前方案的实体级及字段级冲突检测。

**分支三（BaaS + 非 Angular 框架）**：同前述方案，直接否决。

#### 补充否决因素（非核心技术层面但同样重要）

1. **供应商锁定**：用户数据完全依赖第三方服务，无法迁移到其他网盘或本地存储。若 Firebase 变更定价或终止服务，所有用户受影响。

2. **费用不可控**：Firebase Spark 免费方案（Firestore: 1GB 存储 + 50K 日读 + 20K 日写）对重度用户可能不足。作为开源项目，集中式付费服务模式不可持续——必须有人承担费用或强制用户自行创建 Firebase 项目。

3. **多后端策略不可行**：项目需要同时支持 6 个同步后端（OneDrive、Dropbox、WebDAV、LocalFile、SuperSync、Nextcloud），让用户自由选择存储位置。BaaS 方案将强制所有数据流向单一云服务，排除用户自有网盘存储的可能性。

### 5.5 NgRx 落地复杂度 + 业务示例

**业务示例一（场景 S1 Firestore 版）：标签删除的跨文档一致性缺失**

```typescript
// Firestore 删除标签（文档 A）→ 更新 45 个任务（文档 B-1 到 B-45）
async deleteTagFirestore(tagId: string) {
  const batch = db.batch();

  // 删除标签文档
  batch.delete(db.collection('tags').doc(tagId));

  // 查询引用此标签的任务
  const snapshot = await db.collection('tasks')
    .where('tagIds', 'array-contains', tagId)
    .get();

  // 批量更新每个任务（Firestore batch 上限 500 操作，此处 46 个操作可行）
  snapshot.docs.forEach(doc => {
    const newTagIds = doc.data().tagIds.filter(id => id !== tagId);
    batch.update(doc.ref, { tagIds: newTagIds });
  });

  await batch.commit();

  // ⚠️ Firestore batch write 是原子性的（全部成功或全部失败）
  //    但它不保证 ISOLATION（隔离性）：
  //    若 batch 执行到一半时另一个客户端查询 tasks 集合，
  //    可能看到部分 task 的 tagIds 已更新、部分未更新
}
```

对比当前方案：BATCH Operation 在远端通过 `bulkApplyOperations()` 在单个 NgRx dispatch 中完成全部 46 个实体的变更，中间状态对任何 Component 都不可见。

**业务示例二（场景 S2 Firestore 版）：文档级 LWW 的过度覆盖**

```
设备 A 离线: 修改 task doc { title: "超市采购" }
设备 B 离线: 修改 task doc { priority: "HIGH" }

Firestore 离线持久化:
  两个设备各维护一个 task document 的本地副本

恢复网络后 Firestore SDK 执行同步:
  设备 A 上传: update(task-1, { title: "超市采购" })
  设备 B 上传: update(task-1, { priority: "HIGH" })

Firestore 冲突解决（文档级 LWW，基于 server timestamp）:
  后到达的 update 覆盖整个 document
  → 若设备 B 后到达: task.title 回退为旧值（设备 A 的修改丢失）
  → 若设备 A 后到达: task.priority 回退为旧值（设备 B 的修改丢失）

当前方案对比:
  冲突检测以 entity.fields 为粒度
  → title 仅 A 改 → A 的 title 保留
  → priority 仅 B 改 → B 的 priority 保留
  → 两个字段均生效，无数据丢失
```

**业务示例三（场景 S3 Firestore 版）：归档语义需要在应用层手写**

Firestore 没有"归档"操作的原生支持。需要在应用层手写归档逻辑：

```typescript
async archiveProjectFirestore(projectId: string) {
  const batch = db.batch();

  // 1. 标记项目为 archived
  batch.update(db.collection('projects').doc(projectId), { status: 'archived' });

  // 2. 查询该项目下所有任务并标记为 archived
  const tasks = await db.collection('tasks')
    .where('projectId', '==', projectId)
    .get();

  tasks.docs.forEach(doc => {
    batch.update(doc.ref, { status: 'archived' });
  });

  await batch.commit();

  // ⚠️ 时间追踪数据怎么办？归档的项目/任务在时间追踪报表中仍需显示
  //    Firestore 没有"软删除"或"数据搬家"的概念
  //    需要在查询报表时额外过滤 status = 'archived' 的记录
}
```

---

## 6. 多方案横向对比表

### 6.1 核心技术维度

| 维度                 | 方案一：CRDT + 文件存储             | 方案二：Event Sourcing（当前方案）        | 方案三：CR-SQLite               | 方案四：BaaS                            |
| -------------------- | ----------------------------------- | ----------------------------------------- | ------------------------------- | --------------------------------------- |
| **冲突处理粒度**     | 字段/字符级（最细）                 | 实体级（同实体 LWW）                      | 行/列级（较细）                 | 文档级（最粗）                          |
| **冲突自动合并**     | 数学级自动（CRDT 算法）             | 向量时钟 + LWW + 归档优先规则             | CRDT 行级自动                   | 依赖 SDK（通常文档级 LWW）              |
| **合并策略可定制性** | 低（CRDT 算法内建，应用层不可干预） | 高（自定义 LWW 规则，语义级优先级）       | 低（CRDT 算法内建）             | 中（RxDB 支持自定义，Firestore 不支持） |
| **操作语义保留**     | 不保留（仅记录数据变更结果）        | 完整保留（Action 类型 + EntityChange[]）  | 不保留（变更集为 SQL 操作日志） | 不保留（SDK 视为 set/update/delete）    |
| **多实体原子操作**   | 不支持（跨 Map 无事务）             | 支持（BATCH OpType，单次 Store dispatch） | 支持（SQL 事务）                | 部分支持（Batch 原子但无隔离性）        |

### 6.2 技术栈适配维度

| 维度                    | 方案一：CRDT + 文件存储           | 方案二：Event Sourcing（当前方案）               | 方案三：CR-SQLite                     | 方案四：BaaS                    |
| ----------------------- | --------------------------------- | ------------------------------------------------ | ------------------------------------- | ------------------------------- |
| **NgRx 适配难度**       | 极高（状态双写不可调和）          | 天然适配（Action 即事件，meta-reducer 即拦截器） | 高（SQL → Store 双向映射）            | 极高（NgRx 降级为 UI 缓存）     |
| **现有 NgRx 代码影响**  | ~22,600 行需全部重写或废弃        | 零侵入，17 个 feature store 完整保留             | ~22,600 行需全部重写                  | ~22,600 行需全部重写或废弃      |
| **Meta-Reducer 兼容性** | 不兼容（CRDT 引擎替代 Reducer）   | 完整兼容（meta-reducer 链无修改）                | 不兼容（SQL 触发器替代 meta-reducer） | 不兼容（SDK 替代 meta-reducer） |
| **Effects 兼容性**      | 需全量重写（~12,200 行）          | 完整兼容（`LOCAL_ACTIONS` 注入保护）             | 需全量重写                            | 需全量重写或废弃                |
| **Selector 记忆化**     | 失效（需从 Yjs observe 手写缓存） | 完整保留（NgRx `createSelector`）                | 失效（需从 SQL 查询手写缓存）         | 失效（需从 SDK 监听器手写缓存） |
| **Angular 框架兼容性**  | 兼容（Yjs 无框架依赖）            | 完全兼容                                         | 兼容（通过 WASM 或 Native binding）   | 兼容（各 SDK 有 Angular 适配）  |

### 6.3 业务与产品维度

| 维度                 | 方案一：CRDT + 文件存储           | 方案二：Event Sourcing（当前方案）      | 方案三：CR-SQLite                | 方案四：BaaS                         |
| -------------------- | --------------------------------- | --------------------------------------- | -------------------------------- | ------------------------------------ |
| **GTD 归档语义**     | 不兼容（墓碑模型 vs 数据搬家）    | 原生支持（OpType.MOV，归档优先规则）    | 需应用层实现（SQL status 字段）  | 需应用层实现（document status 字段） |
| **SYNC_IMPORT 语义** | 不兼容（与 CRDT 的 SEC 保证对立） | 原生支持（全量状态替换 + 并发操作丢弃） | 需应用层实现                     | 需应用层实现                         |
| **端到端加密**       | 复杂（增量包级加密）              | 简单（文件级 AES-256-GCM）              | 复杂（变更集级加密）             | 不可行（数据在第三方服务器，仅 TLS） |
| **数据主权**         | 用户自有网盘                      | 用户自有网盘                            | 用户自有网盘                     | 第三方服务器                         |
| **多后端支持**       | 需每个后端实现增量文件交换协议    | 5 个方法接口，~200 行接入一个新后端     | 需每个后端实现变更集文件交换协议 | 不支持（锁定单一云服务）             |
| **离线优先**         | 优秀                              | 优秀                                    | 优秀                             | 良好（依赖 SDK 缓存实现）            |
| **调试与审计**       | 困难（二进制增量不透明）          | 容易（JSON 操作日志，人类可读）         | 困难（变更集二进制格式）         | 中（依赖服务商控制台）               |
| **供应商锁定风险**   | 无                                | 无                                      | 低（vlcn.io 为开源项目）         | 高                                   |

### 6.4 决策树分支可行性总结

| 方案            | 分支一：与 NgRx 并行                       | 分支二：替代 NgRx                               | 分支三：替代 Angular | 最终结论     |
| --------------- | ------------------------------------------ | ----------------------------------------------- | -------------------- | ------------ |
| CRDT + 文件存储 | 不可行（状态双写、meta-reducer 断裂）      | 理论上可行，成本 44-69 人天                     | 直接否决             | **未选用**   |
| Event Sourcing  | **零侵入整合**（选定原因）                 | 不适用（不替代 NgRx）                           | 不适用               | **当前选型** |
| CR-SQLite       | 不可行（SQL ↔ Store 双写 + Selector 断链） | 理论上可行，成本极高（meta-reducer → SQL 迁移） | 直接否决             | **未选用**   |
| BaaS            | 不可行（双状态源 + 跨文档事务缺失）        | 不可行（数据主权一票否决）                      | 直接否决             | **未选用**   |

---

## 7. 最终选型总结

### 7.1 选型结论

Super Productivity 在 v16 架构升级阶段，经对四种候选同步方案的全面评估（含对 Angular + NgRx 既定技术栈的尊重），最终选择 **方案二：事件溯源追加日志流（Event Sourcing / Append-Only Log）** 作为数据同步核心架构。经实际生产环境验证，此方案为当前项目约束下的最优解。

### 7.2 选型合理性论证

**论证一：技术栈零摩擦集成（核心优势）**

NgRx 的 Action 体系与 Event Sourcing 的"不可变事件日志"理念完全同构。通过 meta-reducer 机制（拦截器模式），操作捕获层对现有代码的侵入度为零——17 个 feature store、16 个 meta-reducer、43 个 effects 文件、~206 个 Action 类型均无需修改。对比其他三种方案均要求程度不同的 NgRx 代码重写（方案一/三/四分别需要 ~22,600 行的废弃或迁移），Event Sourcing 方案是唯一在现有技术栈上实现同步层而不引发连锁重构的选择。

**论证二：网盘存储模型的最佳适配**

`FileSyncProvider` 接口以极简的 5 个方法（`getFileRev` / `downloadFile` / `uploadFile` / `removeFile` / `listFiles`）抽象了所有网盘后端的共性操作。`FileBasedSyncAdapterService`（~1,050 行）将同步逻辑集中于此适配器，新后端接入仅需实现此接口（OneDrive ~669 行、Dropbox ~200 行、WebDAV ~250 行）。`sync-data.json` 单文件设计通过内置 `syncVersion` 乐观锁将网盘的"文件级覆盖"风险转化为可检测、可重试、可恢复的并发冲突场景。

**论证三：GTD 业务语义的完整保留**

操作日志中的每个 `Operation` 携带原始 NgRx Action 类型（如 `[Task] Archive`、`[Task] Update`、`[Task] Delete`），而非仅记录数据变更的结果。这使得冲突解决能基于操作意图做决策：

- 归档操作在 LWW 比较中具有无条件优先级（无论时间戳，归档覆盖所有同实体并发更新）
- 多实体原子操作通过 `OpType.BATCH` + `MultiEntityPayload` 不可分割地同步
- `SYNC_IMPORT` 作为一等操作类型，明确表达"全量状态替换"

这些语义在 CRDT 的机械合并和 CR-SQLite 的 SQL 变更集中均无法表达。

**论证四：隐私与数据主权零妥协**

方案二配合用户自有网盘存储 + AES-256-GCM 文件级加密，确保用户数据在传输和存储中始终保持机密性：（1）数据存储在用户自有网盘账号，非第三方服务器；（2）网盘服务商只能看到加密后的密文；（3）用户可随时切换网盘后端，数据可完整迁移。方案四（BaaS）在此维度上与该项目的核心产品承诺根本矛盾。

**论证五：已知局限均可控**

| 局限                    | 可控性分析                                                                                    |
| ----------------------- | --------------------------------------------------------------------------------------------- |
| 同实体并发 LWW 丢弃旧值 | GTD 场景同实体同字段并发概率 < 5%；被覆盖值可追溯（`rejectedAt` 标记）；用户可手动恢复        |
| 全量快照文件较大        | 典型 GTD 数据量 < 1MB（gzip 后 < 200KB），在网盘带宽下可忽略；换取加密和快照恢复的简洁性      |
| 非字段级合并            | 实体级 LWW 覆盖实际使用 95%+ 场景；剩余 5% 为同实体不同字段并发（字段级无冲突仅在顺序操作时成立，真正并发下仍按实体级 LWW 裁决） |
| 操作日志膨胀            | 每 500 条操作自动生成快照 + 7 天已同步操作 GC，空间可控                                       |

### 7.3 最终结论

在 **离线优先 GTD 应用 × 用户自有网盘存储 × Angular + NgRx 既定技术栈** 的三重约束下，Event Sourcing + Append-Only Log 方案在以下四个维度均显著优于 CRDT、CR-SQLite 和 BaaS 方案：

1. **开发成本**：零侵入 NgRx 体系，无需重写现有代码
2. **架构契合度**：Action 即事件，meta-reducer 即拦截器，高度同构
3. **业务语义保真度**：操作意图完整保留，规则可定制
4. **隐私合规**：数据主权在用户手中，端到端加密

当前方案的落地质量已通过生产环境验证（6 个同步后端、7 种操作类型、端到端加密、向量时钟冲突解决），选型决策合理且最优。

---

_文档版本：v2.1_
_最后更新：2026-05-06_
