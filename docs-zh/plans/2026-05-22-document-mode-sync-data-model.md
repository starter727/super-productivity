# 文档模式——精简同步数据模型

**状态：** 提案，多轮审查后修订
**日期：** 2026-05-22
**分支：** eat/how-fat-is-data-model-for-sync-for-new-fbd044
**前置文档：** [2026-05-21-document-mode-tiptap-plugin.md](./2026-05-21-document-mode-tiptap-plugin.md)
（POC 有意推迟了"键控 persistDataSynced API"——请参阅其限制章节）

## 问题

文档模式插件通过 persistDataSynced 持久化一个**单一 blob**，在主机端存储为一条由**插件 id** 键控的 PluginUserData 条目：

`jsonc
{ "version": 1,
  "docs": { "<ctxId>": <完整的 ProseMirror JSON>, ... },  // 每个项目/标签/TODAY 一个文档
  "enabledCtxIds": ["..."] }
`

每次保存 → upsertPluginUserData → **一个操作**（entityType: PLUGIN_USER_DATA、entityId: pluginId、opType: Update），其负载嵌入_整个_ data 字符串。三个问题叠加：

1. **每个操作携带所有上下文。** 在 TODAY 文档中键入一个字符就会发出一个包含 TODAY + 每个项目文档 + 每个标签文档的操作。输入时约每 2 秒节流一次（SAVE_THROTTLE_MS；主机额外通过 MIN_PLUGIN_PERSIST_INTERVAL_MS 合并到每秒 ≤1 次提交）。硬上限 1 MB（MAX_PLUGIN_DATA_SIZE）——超过则写入抛出。操作日志保留最多 COMPACTION_THRESHOLD = 500 个操作，7 天窗口内，因此每个庞大 blob 在压缩前会被多次重新存储到 IndexedDB 和重新同步。

2. **每个标签（chip）存储任务标题的冗余副本。** 	askRef / subTaskRef 标签将任务标题持久化为内联文本内容加上 isDone 属性。但在加载时，prepareStoredDoc → migrateStoredDoc + efreshChipContentFromCache **丢弃**存储的标题/isDone，并从实时任务缓存中重新推导两者；标签 NodeView 同样"信任 	ask.isDone，而非属性"（	ask-ref-node.ts）。存储的标题在同步负载中是死重量——通常是文档中字节较重、可变长度的部分。标签标识、顺序和子任务成员关系同样是推导出来的（从 ctx.taskIds / subTaskIds 重建；重新排序通过主机往返——PROJECT 上下文使用 eorderTasks，TODAY/TAG 上下文使用 ctx.taskIds 重新排序）。因此标签是可重构的；只有它们**之间的文本**是插件拥有的。

3. **并发编辑不能正确解析。** entityId 是_插件 id_，因此所有 N 个文档折叠为一个同步实体：设备 A 编辑项目 X 和设备 B 编辑项目 Y 在_同一实体_上产生 CONCURRENT 向量时钟 → 冲突，即使它们修改了不同文档。更糟的是，PLUGIN_USER_DATA 注册为 **irtual** 实体（entity-registry.ts），而 ConflictResolutionService.getCurrentEntityState 没有 **irtual 分支**——它返回 undefined。因此 LWW（Last-Writer-Wins，后写胜出）本地胜出路径（_createLocalWinUpdateOp）无法读取实体，不会产生替换操作。LWW 对 PLUGIN_USER_DATA 不能正确工作；并发编辑丢失数据，且不可通过可预测的"后写胜出"规则判定。

   _注意：_ 即使今天丢失 blob 的冲突只丢失**文本**——重新加载时标签无论如何都会从主机重建。因此问题 3 是一个正确性缺口，与问题 1–2（大小）不同。

## 目标

1. 通过移除插件冗余存储的数据来缩小同步负载。
2. 无 schema 破坏——保持变更对新旧客户端都可读。
3. 加载行为无回归（标签顺序、文本锚定、子任务回填、过期标签处理均已由 doc-transform.spec.ts 覆盖）。

## 非目标

- **现在修复问题 3。** 它需要主机端工作（每个上下文的实体（per-context entities）_和_虚拟实体 LWW 支持），推迟进行——请参阅未来工作。
- **同一文档的细粒度并发编辑。** 两台设备编辑_同一_文档的文本将始终以整个文档为单位解析；字符级合并需要 CRDT（Yjs），不在范围内。
- 移除树内 src/app/features/document-mode/ 功能。

## 第一阶段——保存时剥离冗余标签内容（插件本地）

修复问题 1 和 2 的最小变更：停止在标签上持久化标题文本和 isDone 属性。将每个标签存储为**裸标识原子（bare identity atom）**：

`jsonc
{ "type": "taskRef", "attrs": { "taskId": "<id>" } } // 无内容，无 isDone
`

持久化的文档仍然是普通的 ProseMirror 文档（	ype: "doc"，标签和文本交错）——仅标签节点变得更轻。

### 为什么这不需要 schema 版本号提升和迁移

migrateStoredDoc 本就是_设计用来_加载原子形状的标签的（"旧版文档将 taskRef 存储为原子节点（无 content 数组）"）——它从任务缓存回填 content 并默认 isDone。然后 efreshChipContentFromCache 无条件覆盖两者。因此裸原子标签能正确地通过**现有的、未修改的**加载管道流动，并且只更改保存路径（getJSON() 后的 stripChipContent）。如果解码器从带有 content 数组的标签接收到 isDone，它仍然正常处理——migrateStoredDoc 检查 content 是否存在，如果存在则不覆盖。因此旧数据与新解码器兼容，无需迁移。

迁移以幂等方式运行：如果标签已经有 content，stripChipContent 是空操作。没有版本检查，没有 1→v2 映射。

### 保存路径

- editor.on('update') → 5s 防抖 → getJSON() → stripChipContent(doc) → 序列化 → 通过 persistDataSynced 持久化。

### 加载路径（未修改）

- persistDataSynced 返回 → 解析 → prepareStoredDoc(doc) → migrateStoredDoc(doc)（回填标签）→ efreshChipContentFromCache(doc)（用实时数据覆盖）→ 设置编辑器内容。

### 为什么子任务（subTaskRef）被同样处理

在文档模型中，子任务与普通 	askRef 一样是引用；它们的标题和 isDone 同样可以从任务缓存中推导。stripChipContent 用相同的逻辑处理 subTaskRef 节点。

### 为什么 enabledCtxIds 不受影响

enabledCtxIds 是在加载时用于上下文门控的元列表。它是一个短字符串数组，在负载中可忽略不计。不改变。

## 未来工作——每个上下文的同步实体（主机端变更，推迟）

> 跟踪为
> [super-productivity/super-productivity#7749](https://github.com/super-productivity/super-productivity/issues/7749)——
> A 阶段（用于每个上下文同步实体的键控插件持久化 API）。
> 多轮审查设计见
> [2026-05-23-stage-a-keyed-plugin-persistence.md](./2026-05-23-stage-a-keyed-plugin-persistence.md)。
> 以下摘要对问题 3 的主机端范围仍然准确。

这是对**问题 3** 的修复。已推迟，未安排时间：文档模式是可选（用户按上下文启用）且第 0 阶段已发布，因此大小压力已解除。当在实践中观察到跨上下文冲突时再处理——参见链接的计划以获取完整的分阶段设计。

它**比"添加一个 key 参数"**要大——多轮审查揭示了完整范围：

1. **插件 API**——为 persistDataSynced / loadSyncedData 添加可选的 key，贯穿_整个_链路：plugin-api/types.ts、plugin-bridge.service.ts、iframe 包装器（plugin-api.ts）和 iframe postMessage 工具（plugin-iframe.util.ts）——当前会丢弃第二个参数。
2. **复合实体 id**——PluginUserData.id 变为 pluginId:key，以便每个 (plugin, context) 成为自己的同步实体；不同上下文的并发编辑不再冲突。
3. **虚拟实体 LWW**——_必需，不是可选。_ 每个上下文的实体 id 本身并**不能**修复问题 3：getCurrentEntityState 仍然没有 irtual 分支，因此相同上下文的冲突仍然错误解析。冲突解析必须学会从 selectPluginUserDataFeatureState 读取虚拟实体（PLUGIN_USER_DATA）。
4. **速率限制和大小上限语义**——PluginUserPersistenceService 按键控其合并/节流映射；按 key 的键控削弱了每插件洪泛防护（MIN_PLUGIN_PERSIST_INTERVAL_MS）并使 MAX_PLUGIN_DATA_SIZE 变为按 key。保留额外的每_插件_聚合上限，以便多 key 插件不能绕过限制。
5. **卸载清理**——emovePluginUserData(pluginId) 只删除精确的 id；键控条目 pluginId:* 会泄漏。使删除操作支持前缀感知。
6. **ackground.ts** 必须从无 key API 迁移（例如使用 key: 'meta' 存储 enabledCtxIds），否则它会与编辑器的元实体失去同步。
7. **迁移**——将遗留的单个 blob 拆分为按 key 的实体，一次性且幂等（以元键的存在性作为防护）。

此工作后的残余：对**相同**上下文的并发编辑仍然以整个文档为单位解析——根据非目标可接受。

---

## 风险

| 风险 | 缓解措施 |
| --- | --- |
| migrateStoredDoc / efreshChipContentFromCache 停止回填 → 剥离的标签渲染为空 | 两者都是现有的加载管道不变量，有 spec 覆盖；添加往返测试，验证剥离的文档重建完整标签。 |
| 剥离意外修改实时编辑器文档或非标签文本 | stripChipContent 是纯函数，在 getJSON() 副本上运行；仅修改 	askRef/subTaskRef 节点。对两者进行单元测试。 |
| 剥离为空的标签被写回主机作为标题擦除 | 不可能发生——写回（econcileTitlesFromDoc）读取_实时_编辑器文档，始终有刷新的内容；只有存储副本被剥离。 |

## 测试

- 
pm --prefix packages/plugin-dev/document-mode test（esbuild + 
ode --test）。
- 
pm run test:file packages/plugin-dev/document-mode/src/doc-transform.spec.ts。
- 手动测试：输入文本 + 切换完成状态，重新加载，切换上下文再返回——标签显示正确的标题/完成状态，文本保持其位置。

## 开放问题

1. 仅第一阶段，还是安排未来工作？建议：立即执行第一阶段（低风险，无 schema 破坏）；在未来工作默认打包插件之前，将其视为文档化的已知限制。
