# 贡献者同步模型

**在编写任何影响同步状态的 Effect、Reducer 或批量分发（Bulk Dispatch）之前，需要理解的核心概念。**

Super Productivity 通过重放操作日志（Operation Log）实现同步。几乎所有你遇到的同步正确性规则，都是一个**单一不变式**的体现：

> ## 一个用户意图 = 一个操作。重放操作和远程操作绝不能重新触发副作用（Effect）。

Reducer **必须**对远程/重放操作执行（因为状态就是这样重建的）。Effect **不得**执行——界面上的副作用（Snack 提示、音效、导航跳转）已经在原始客户端发生过了，任何级联变更也已经是操作日志中的独立条目。在重放时重新执行 Effect 会重复产生副作用，并发出与同步产生冲突的幻影操作（Phantom Operation）。

以下所有内容，都是这个不变式在三个关键点的具体应用。

---

## 边界 1 —— Action 边界

**Effect 应注入 `LOCAL_ACTIONS`，而非 `inject(Actions)`。**

`LOCAL_ACTIONS` 是标准 Action 流，但已过滤掉 `meta.isRemote`（参见 `src/app/util/local-actions.token.ts`）。远程/重放操作通过一个 `bulkApplyOperations` Action 批量应用；`LOCAL_ACTIONS` 确保你的 Effect 只看到真正的本地用户意图。

- **所有** Effect 的默认写法：`private _actions$ = inject(LOCAL_ACTIONS);`
- 唯一合法的例外是使用 `ALL_ACTIONS` 并自行处理 `isRemote`：`operation-log.effects.ts`（捕获/持久化每个 Action）。你几乎不可能需要再添加第二个这样的例外。
- 远程**归档**副作用并_不是_ `ALL_ACTIONS` 的适用场景：`archive-operation-handler.effects.ts` 本身使用 `LOCAL_ACTIONS`；远程客户端的归档写入/删除由 `OperationApplierService` → `ArchiveOperationHandler` 分别驱动。

✅ **由 `local-rules/no-actions-in-effects` 强制检查**——你不可能犯这个错误；linter 会拒绝 `*.effects.ts` 中的 `inject(Actions)` / `Actions` 导入。

## 边界 2 —— 选择器边界

**选择器驱动的 Effect 必须使用 `skipDuringSyncWindow()` 进行保护。**

响应_选择器（Selector）_（Store 状态）而非特定 _Action_ 的 Effect，会完全绕过边界 1——它在每次 Store 变化时都会触发，包括状态水合（Hydration）和同步重放。两个时间窗口（首次启动但尚未完成首次同步之前；同步完成后的重新评估窗口）会使这类 Effect 发出的操作携带过期的向量时钟（Vector Clock），立即产生冲突。

- 对于会修改频繁同步的实体或执行"修复"/"一致性"工作的选择器驱动 Effect，请使用 `skipDuringSyncWindow()`。
- 更细粒度的 `skipWhileApplyingRemoteOps()` / `HydrationStateService.isApplyingRemoteOps()` 适用于需要更精细控制的场景。
- **优先使用基于 Action 的 Effect。** 基于选择器的 Effect 是直觉上合理但通常错误的选择；只有在没有可供响应的 Action 时才使用它。

✅ **由 `local-rules/require-hydration-guard` 强制检查**（已有规则）。

## 原子性规则 —— 一个意图，一个操作

**多实体变更是 Meta-Reducer 的职责，而非 Effect。批量分发循环需要让出执行权。**

- 一个涉及多个实体的变更（例如删除一个标签同时也要从所有任务中移除它）必须在一个 **Reducer 执行过程**中完成，这样它才能成为**一个操作**。应将此类逻辑放在 `src/app/root-store/meta/task-shared-meta-reducers/` 中，而不是放在一个会分发多个后续 Action 的 Effect 里。基于 Effect 的扇出（Fan-out）会为一个意图发出 N 个操作，并在重放时再次执行（这是边界 1 的另一种体现）。
- `store.dispatch()` 是非阻塞的。在 50+ 次分发的循环后，请添加 `await new Promise((r) => setTimeout(r, 0))`，以确保捕获的操作不会丢失中间状态。

⚠️ `local-rules/no-multi-entity-effect`（`warn` 级别）以启发式方式标记此类问题——它能捕获数组字面量扇出模式（`map(() => [a(), b()])`），但无法捕获所有多实体分发场景（例如 `of(a(), b())` 变长参数扇出会漏检）。推荐的模式是使用 `task-shared-meta-reducers/` 中的 Reducer。

---

## 决策表 ——"我正在编写一个 Effect"

| 问题                                             | 答案                                                          | Linter                                 |
| ------------------------------------------------ | ------------------------------------------------------------- | -------------------------------------- |
| 是否注入了 Action 流？                            | 使用 `LOCAL_ACTIONS`（而非 `Actions`）                        | ✅ `no-actions-in-effects`（error）    |
| 是否响应**选择器**而非 Action？                   | 添加 `skipDuringSyncWindow()`                                 | ✅ `require-hydration-guard`（error）  |
| 一个用户意图是否变更了 **>1 个实体**？            | 将其改为 Meta-Reducer，而非 Effect                            | ⚠️ `no-multi-entity-effect`（warn）    |
| 是否在 **50+ 次**的循环中分发？                    | 循环后添加 `await new Promise(r => setTimeout(r, 0))`          | —（约定）                              |

其中两条规则由工具自动强制检查——你不需要死记硬背，只需要理解_为什么_（即最上面那个不变式即可）。

---

## 深入理解

- **机制与规则：** [`operation-rules.md`](./operation-rules.md)
- **架构：** [`operation-log-architecture.md`](./operation-log-architecture.md)
- **图示：** [`diagrams/05-meta-reducers.md`](./diagrams/05-meta-reducers.md), [`diagrams/08-sync-flow-explained.md`](./diagrams/08-sync-flow-explained.md)
- **参考源码：** `src/app/util/local-actions.token.ts`, `src/app/util/skip-during-sync-window.operator.ts`, `src/app/op-log/apply/hydration-state.service.ts`
