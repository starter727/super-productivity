# 接线 PluginHooks.PERSISTED_DATA_CHANGED

**状态：** 提案（多轮审查后 v4）
**日期：** 2026-05-23
**触发：** 199e816479 的多轮审查发现文档模式的编辑器在远程 PLUGIN_USER_DATA 更新后变得陈旧，因为没有任何机制通知插件。钩子 PluginHooks.PERSISTED_DATA_UPDATE 在 packages/plugin-api/src/types.ts:24 中声明但从未在主机端调度（src/app/ 的 grep 确认零命中）。
**相关：** [A 阶段计划](./2026-05-23-stage-a-keyed-plugin-persistence.md) 的风险表——相同的陈旧缺口，A 阶段本身无法修复。

## TL;DR

触发这个死钩子。此 PR 仅发布**主机能力**——选择器订阅、每插件调度、枚举重命名、API 契约。文档模式的采纳（横幅 UX、脏状态跟踪、选区保持）在另一个问题中跟踪，在此基础工作稳定后发布：见下面的"后续：文档模式采纳"。

主机机制：在 PluginHooksEffects 中对 selectPluginUserDataFeatureState 的选择器订阅。在同步窗口期间跳过（SYNC_IMPORT / BACKUP_IMPORT 整体替换状态——语义上是重新加载，而非变更）。无缓存、无负载、无独立的删除钩子。插件接收一个 oid 信号并重新调用 loadSyncedData() 获取新数据。将枚举条目重命名为 PERSISTED_DATA_CHANGED 以与兄弟钩子（*_CHANGE）保持一致；重命名是免费的，因为今天没有触发此钩子。

预估包括 spec 在内 3–5 小时。

## 目标

插件在其持久化数据因**非整体状态替换**（SYNC_IMPORT、BACKUP_IMPORT、应用启动）以外的任何原因发生变化时收到通知。本地用户写入、远程同步应用和跨标签写入都会触发。

## 非目标

- 自动刷新插件 UI。主机触发钩子；插件决定。
- 在负载中区分"本地"与"远程"。插件处理器必须是幂等的；如果插件写入然后接收到自己的变更事件，重新读取和重新渲染是无害的。（审阅者 3 的 source 标志被考虑并拒绝为 YAGNI——仅在真正的插件需要区分时重新添加。）
- 独立的 PERSISTED_DATA_DELETED 钩子。今天不存在插件可调用的删除 API；唯一的触发路径是在卸载时插件正在被拆除且无法有效响应。YAGNI。
- 注册时重放。插件契约是"在初始化时调用 loadSyncedData() 获取最新状态，然后 egisterHook(...) 用于后续变更。"明确，无意外。
- 节流。持久化服务已经将本地写入合并到每个插件每秒 ≤1 次操作；同步应用是事件驱动的，不会洪泛。

## 设计

### 选择器效果

在 src/app/plugins/plugin-hooks.effects.ts 中，与现有钩子效果并行但**基于选择器，而非基于动作**。基于动作的效果注入 LOCAL_ACTIONS（同步规则 1，:55）并且会错过通过 ulkApplyOperations 到达的远程 upsert（见 src/app/op-log/apply/bulk-hydration.meta-reducer.ts）——动作类型是批量包装器，而非 upsertPluginUserData，因此 ofType(upsertPluginUserData) 过滤器永远不会针对远程操作触发。状态仍然会变化，因此状态选择器订阅确实能观察到它。

> 注意：这是代码库中的一个*新模式*。plugin-hooks.effects.ts:341 的现有 PROJECT_LIST_UPDATE 效果是基于动作的，而非基于选择器的，因此对远程项目变更视而不见（可能是一个潜在缺陷，但不是此 PR 的问题）。早期草案错误地将其引用为先例。

骨架：

`	s
firePersistedDataChanged$ = createEffect(
  () =>
    this.store.pipe(
      select(selectPluginUserDataFeatureState),
      startWith([] as PluginUserData[]),  // 为 pairwise 提供确定性
      pairwise(),
      skipDuringSyncWindow(),             // 见"同步窗口"下面的说明
      map(([prev, next]) => diffChangedPluginIds(prev, next)),
      filter((ids) => ids.length > 0),
      switchMap((ids) =>
        from(ids).pipe(
          tap((pluginId) =>
            this.pluginService.dispatchHookToPlugin(
              pluginId,
              PluginHooks.PERSISTED_DATA_CHANGED,
            ),
          ),
        ),
      ),
    ),
  { dispatch: false },
);
`

### diffChangedPluginIds

纯函数。通过 id 成员性和 data 字段比较 prev 和 
ext 数组。返回满足以下条件的 pluginId 集合：

- id 存在于 
ext 但不存在于 prev（新增），或
- id 存在于两者但 data 不同（更新），或
- id 存在于 prev 但不存在于 
ext（删除）

编码是确定性的（gzip + base64；已验证——相同输入 → 相同字节），因此通过服务往返的无操作本地写入产生相同的 data 字符串，并被差异比较器正确跳过。**不需要单独的重复数据删除缓存。** 单独的差异比较器抑制来自无操作写入的自我回显。

### 同步窗口

从效果流中抑制在 SYNC_IMPORT 或 BACKUP_IMPORT 动作期间发出的 selectPluginUserDataFeatureState 排放。这些动作在同步窗口期间整体替换状态——语义上是导航到新状态或重新加载，而非数据变更。插件应重新读取自身，但作为其初始化/刷新的一部分，而非作为对远程变更的反应。

实现：现有的 skipDuringSyncWindow() 操作符（在效果文件中且已用于其他效果）干净地处理此问题。不需要新代码。

### dispatchHookToPlugin

新方法，在 plugin-hooks.ts 中（补充现有的 	riggerHookForEveryPlugin / 	riggerHookForCurrentPlugin）：

`	s
dispatchHookToPlugin(pluginId: string, hook: PluginHooks): void {
  const plugin = this.plugins.find((p) => p.id === pluginId);
  if (!plugin || !canHandleHook(plugin, hook)) return;
  plugin.dispatchHook(hook, undefined);
}
`

与 	riggerHookForEveryPlugin 不同，此方法**不广播**——它定位单数插件。与 	riggerHookForCurrentPlugin 不同，它接受一个非当前的 pluginId。undefined 负载记录了下游插件接收 oid。

### API 表面变更

在 packages/plugin-api/src/types.ts 中：

`	s
enum PluginHooks {
  // ...现有条目...
  // PERSISTED_DATA_UPDATE = 'persistedDataUpdate', // 已删除
  PERSISTED_DATA_CHANGED = 'persistedDataChanged', // 新增。负载：void。
}
`

packages/plugin-api/README.md 中的文档：

`markdown
### PERSISTED_DATA_CHANGED
在插件通过 persistDataSynced/loadSyncedData 可访问的数据因任何原因
（本地写入、远程同步、跨标签写入）发生变化时触发，但不包括应用启动或
整体状态替换（导入/恢复）。

**负载：** 无。处理器调用 loadSyncedData() 获取新数据。
**处理器必须是幂等的。** 如果插件写入然后接收到自己的写回，这是无害的
（重新读取和重新渲染是稳定的）。
`

---

## 测试计划

### 效果单元测试（plugin-hooks.effects.spec.ts）

添加到现有的 describe('plugin-hooks effects', ...)。六个测试（约 60–80 LOC）：

| # | 场景 | 断言 |
| --- | --- | --- |
| 1 | diffChangedPluginIds——仅新增 | ['a'] → ['a', 'b'] 返回 ['b'] |
| 2 | diffChangedPluginIds——仅数据更新 | [{id:'a', data:'x'}] → [{id:'a', data:'y'}] 返回 ['a'] |
| 3 | diffChangedPluginIds——仅删除 | ['a', 'b'] → ['a'] 返回 ['b'] |
| 4 | diffChangedPluginIds——无变化 | 相同数组 → [] |
| 5 | 效果调度 dispatchHookToPlugin | 模拟 store 排放 → 验证 pluginService.dispatchHookToPlugin 被调用 |
| 6 | 同步窗口抑制 | 在 SYNC_IMPORT 动作期间排放 → 无钩子调用 |
| 7 | 注册时启动 | 确认 startWith([]) 防止第一个真实状态被 pairwise 丢弃 |

测试细节：

- 测试 1–4：直接调用纯函数 diffChangedPluginIds(prev, next)。不需要 store 或 TestBed。
- 测试 5–6：需要 TestBed 设置的 PluginHooksEffects。模拟 store（MockStore）和 PluginService。
- 测试 7：与测试 5 相同设置——验证 startWith([]) 产生第一个真实排放。

### 集成——跨标签（手动，非自动化）

1. 打开两个浏览器标签到相同的 super-productivity 实例，使用相同的项目。
2. 在标签 A 中：启用文档模式，键入文本。保存。
3. 标签 B：验证文档模式显示更新后的文本（无需手动重新加载）。

### 插件端单元测试（文档模式，如下所述）

在文档模式将钩子纳入后：

| # | 场景 | 断言 |
| --- | --- | --- |
| 9 | 接收到 PERSISTED_DATA_CHANGED → 重新加载文档 | 编辑器内容替换为最新存储的文本；之前的选择丢失（已知：setContent 不保持选择；在文档模式中这是一个单独的 UX 问题——见"后续"，测试只是记录当前行为） |
| 10 | 在脏编辑期间收到 PERSISTED_DATA_CHANGED → 横幅 + 不替换 | 编辑器内容不变；横幅可见 |
| 11 | 同步窗口抑制 | 在 SYNC_IMPORT 期间排放 → 无钩子到达插件 |

## 风险

| 风险 | 缓解措施 |
| --- | --- |
| 效果触发一次性初始注册 | startWith([]) 前置一个空数组，以便第一个真实状态是第二次发射，pairwise 产生 [[], firstState]。匹配 plugin-hooks.effects.ts:94 的 onCurrentTaskChange$ 模式。 |
| 插件卸载/重新注册遗留过期处理器 | 现有的 unregisterPluginHooks（plugin-hooks.ts:65-68）已经清除每个插件的所有钩子。无需额外工作。 |
| 跨标签"自我回显" | 标签 B 合法地将标签 A 的写入视为远程——没有需要防御的自我回显。将这种情况作为测试 #3 的一部分规范。 |

## 范围外

- **文档模式采纳。** 单独跟踪（见上面的"后续"部分）。主机钩子先发布；文档模式在其自己的 PR 中在此基础工作稳定后采纳。
- **所有其他插件的采纳**（sync-md、automations、brain-dump、ai-productivity-prompts）。相同模式——主机钩子发布，每个插件根据自己的时间线和 UX 决策选择加入。
- PERSISTED_DATA_DELETED 钩子——无真实消费者。
- source: 'local' | 'remote' 负载标志——YAGNI；幂等契约足够；如果插件需要区分器则重新审视。
- 跨上下文并发编辑数据丢失（LWW 将不同上下文的编辑折叠到一个整个 blob 实体）。A 阶段的领域。
- 相同上下文并发编辑冲突解决。仍然是整个文档 LWW。CRDT 领域（C 阶段，无限期推迟）。
- A 阶段键空间交互。当 A 阶段落地时，重新审视负载是否需要 key（dispatchHookToPlugin 的 pluginId 参数变为复合 id，插件可以解析）。在此之前，钩子每个 pluginId 触发一次，仅此而已。
- 节流。持久化服务对写入进行速率限制；同步应用是事件驱动的。如果实践中出现真正的洪泛，届时再添加节流。
- BACKUP_IMPORT 与 SYNC_IMPORT 的区分。两者都由相同的同步窗口操作符抑制；相同的理由适用。

## 实现顺序

1. plugin-hooks.ts——添加 dispatchHookToPlugin。约 15 行 + JSDoc。
2. plugin.service.ts——透传 dispatchHookToPlugin。约 5 行。
3. 辅助文件（plugin-data-diff.util.ts 或内联在效果文件中）——diffChangedPluginIds(prev, next): string[]。纯函数。约 20 行。
4. plugin-hooks.effects.ts——按上面"骨架"的效果。约 20 行。
5. packages/plugin-api/src/types.ts——重命名枚举条目；负载变为 oid。约 3 行。
6. packages/plugin-api/README.md——按"API 表面变更"下的片段加一段说明。
7. 按测试计划的 spec 文件。

总计：约 80 行 + spec。实际预估**3–5 小时**端到端。

## 变更日志

- 2026-05-23 v1——初始提案：持久化服务中按 pluginId 的缓存、编码数据负载、独立的 PERSISTED_DATA_DELETED 钩子、同一 PR 中的文档模式采纳。多轮审查。
- 2026-05-23 v2——根据多轮审查剪切和重新构建：
  - 移除重复数据删除缓存：单独的差异比较器就足够了，因为编码是确定性的（审阅者 2）。
  - 枚举重命名为 PERSISTED_DATA_CHANGED 以与 *_CHANGE 兄弟保持一致（审阅者 3）。
  - 负载简化为 oid（审阅者 2 + 3）。
  - 放弃 PERSISTED_DATA_DELETED（所有三位审阅者）。
  - 通过 skipDuringSyncWindow 显式抑制 SYNC_IMPORT（审阅者 1 + 2）。理由已文档化；规则 2 已满足。
  - 放弃错误的 PROJECT_LIST_UPDATE 先例引用；选择器方法基于自身优点呈现（审阅者 1）。
  - 为 pairwise 确定性添加 startWith([])（审阅者 1）。
  - 差异比较器明确为 id 成员性 + 数据比较；从数组结构检测删除（审阅者 1）。
  - 文档模式采纳拆分为独立变更（审阅者 2）。
  - A 阶段理由缩减为一行（审阅者 2）。
  - 预估修正为 3–5 小时（审阅者 2）。
- 2026-05-23 v3——根据用户要求将文档模式采纳重新纳入范围。理由：仅发布主机钩子不会带来任何用户可见的收益；在插件采纳之前陈旧缺口仍然存在。将它们捆绑在一个 PR 中避免了后面重新讨论横幅 UX。添加了显式的 ackground.ts 和 ui/editor.ts 采纳部分、横幅 UX 理由（"脏时不自动替换"）、插件端 spec（#9–13）和部署步骤。预估修正为 6–8 小时。
- 2026-05-23 v4——拆分范围。用户明确：此 PR 应是基础工作（更好的插件数据同步处理）；文档模式采纳是单独的问题，在基础工作落地后开始。v3 多轮审查暴露了文档模式 UX 的阻塞问题（setContent 破坏选区；挂载竞态；仅重新加载的横幅无法防止覆盖），这些问题现在成为后续问题的种子，而不是在此尝试修复。恢复仅主机范围；预估回到 3–5 小时。文档模式采纳说明保留在"后续"部分，以便后续实施者从多轮审查的见解开始，而非空白页。
