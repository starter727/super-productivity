# 文档模式 → TipTap 编辑器插件（概念验证 POC）

**状态：** 提案，多轮审查后 v2
**日期：** 2026-05-21
**分支：** eat/doc-mode4-2880bb

## 目标

将当前树内文档模式（src/app/features/document-mode/）重新实现为可选的 iframe 插件，使用 TipTap 作为编辑器。扩展插件 API，支持工作上下文范围（work-context-scoped）的表头按钮、WORK_CONTEXT_CHANGE 钩子，以及在任务视图主体内（替代任务列表）嵌入插件视图。

POC 范围：无数据迁移，不删除现有树内功能，仅可选安装。

## 已锁定的决策

| 问题 | 决策 | 来源 |
| --- | --- | --- |
| 嵌入位置 | **主体嵌入**（body-embed）（镜像当前 <document-view> 的放置位置）。无侧面板变体。 | 用户 |
| 可见性范围 | 主机仅在活动上下文为项目（project）或 TODAY 标签时渲染按钮，**但插件仍通过注册时的 showFor 字段声明**此范围 | 审阅者反馈：硬编码的主机过滤器是可以避免的公共 API 负债 |
| 	askRef 语义 | **只读标签（chip）**（原子节点）——标题 + 复选框。点击标签打开任务面板进行完整编辑。不支持内联标题编辑。 | 两位审阅者都指出了内联编辑的竞态条件（race condition）问题；POC 保持简洁 |
| 持久化 | **单一现有 blob，插件端 {[ctxId]: doc} 映射**。POC 无需新的持久化 API。 | 两位审阅者推荐此方案——推迟有风险的键控 API 设计 |
| 遗留数据 | 不进行迁移 | 用户 |
| 打包 | 可选安装，默认不打包 | 用户 |

## 插件 API 新增内容

`	s
// packages/plugin-api/src/types.ts
interface PluginAPI {
  // ...现有内容...
  getActiveWorkContext(): Promise<ActiveWorkContext | null>;
  registerWorkContextHeaderButton(
    cfg: Omit<PluginWorkContextHeaderBtnCfg, 'pluginId'>,
  ): void;
  showInWorkContext(): void;
  closeWorkContextView(): void;
}

interface ActiveWorkContext {
  id: string;
  type: 'PROJECT' | 'TAG';
  title: string;
  taskIds: string[];
}

interface PluginWorkContextHeaderBtnCfg {
  pluginId: string;
  label: string;
  icon?: string;
  onClick: (ctx: ActiveWorkContext) => void;
  /** 渲染按钮的位置。默认 ['PROJECT']。'TODAY' 是特殊的 TODAY 标签。 */
  showFor: ('PROJECT' | 'TAG' | 'TODAY')[];
}

enum PluginHooks {
  // ...现有内容...
  ANY_TASK_UPDATE, // → 已存在主机端，iframe 枚举中缺失
  WORK_CONTEXT_CHANGE = 'workContextChange', // 新增
}
// WORK_CONTEXT_CHANGE 负载：{ id, type, title, taskIds } | null
// （完整快照，而不仅是 id+type——参见审阅发现 #4）
`

无键控持久化（keyed persistence）——POC 重用单个 blob。

## 主体嵌入所需的主机端修复

多轮审查发现了几项必须在主体嵌入安全之前修复的阻塞问题。这些不是可选的：

### 1. Iframe 消息串扰（Codex）

src/app/plugins/util/plugin-iframe.util.ts:451 中的 handlePluginMessage() 接受任何 PLUGIN_API_CALL 而不检查 event.source 或插件 id。侧面板已挂载 <plugin-index>（plugin-panel-container.component.ts:25）；添加任务视图嵌入后将有两个监听器，它们会用不同的绑定方法响应相同的 API 调用。

**修复：** 在每个 handlePluginMessage 调用点，验证 event.source === iframe.contentWindow 并且用接收插件的 id 标记消息；忽略不匹配的消息。应用到所有嵌入位置：路由页面、侧面板、任务视图嵌入。

### 2. 表头按钮 onClick 回调代理（Codex）

iframe 代理直接 post egisterHeaderButton(cfg)（plugin-iframe.util.ts:329）——onClick 是一个函数，不可结构化克隆（structured-cloneable）。现有主机端 PluginAPI.registerHeaderButton() 之所以工作是因为它在主机运行时中运行。相同的方法不能用于 egisterWorkContextHeaderButton——主机端接收一个无法调用的 onClick。

**修复：** 添加一个 workContextBtnCallbackMap: Map<string, Function>。在主机端调用 egisterWorkContextHeaderButton(cfg) 时，将 cfg.onClick 存储到映射中并仅将 { pluginId, label, icon, showFor } 转发给 iframe 代理。然后添加一个主机端可调用的 invokeWorkContextBtnCallback(pluginId, ctx)，由主机 UI 绑定。

### 3. skipCleanupOnDestroy 输入（Codex）

plugin-index.component.ts 和 plugin-index.component.html 目前总是销毁 iframe 并清除全部状态。但对于任务视图嵌入，嵌入使用不同的组件实例独立于侧面板运行其生命周期。当用户在任务视图和侧面板之间导航时会发生不必要的重建。

**修复：** 添加 @Input() skipCleanupOnDestroy: boolean = false。当为 	rue 时，
gOnDestroy 跳过 destroyIframe() 和 cleanupStyles()。同时确保 plugin-index 可以嵌入到任务视图主体中而不受侧面板状态影响。

### 4. 主机端 ANY_TASK_UPDATE 枚举条目

枚举条目在 src/app/plugins/plugin-hooks.ts 中存在但不在 packages/plugin-api/src/types.ts 的 iframe 枚举中。canHandleHook 需要两个枚举同步。修复：在 PluginHooks（API 类型）中添加缺失的 ANY_TASK_UPDATE 条目。

### 5. 嵌入生命周期——使用不同的 Tab / 上下文

| 场景 | 预期行为 |
| --- | --- |
| 用户切换到不同项目 | WORK_CONTEXT_CHANGE → 插件卸载旧项目文档，加载新项目文档 |
| 用户切换到 TODAY | 同上，但 	ype: 'TAG' |
| 用户切回同一项目 | WORK_CONTEXT_CHANGE → 重新加载文档 |
| 在任务视图嵌入中编辑时切换上下文 | 提示保存再离开 |
| 任务视图嵌入打开，用户在侧面板中打开相同上下文 | 两个实例独立渲染相同文档 |
| 任务视图嵌入打开，用户导航到设置 | 嵌入的 iframe 被销毁 |
| Electron 退出 | 通过组件的 ngOnInit 中的 eforeunload 保存 |

### 6. pagehide / eforeunload 保存

Electron 退出时需要保存——在 iframe 内 pagehide 不会触发。需要主机端 eforeUnload 钩子，POC 中作为已知限制。

---

## 主机 UI 变更

| 变更 | 描述 |
| --- | --- |
| src/app/plugins/plugin-hooks.ts | 添加 WORK_CONTEXT_CHANGE 调度逻辑 |
| src/app/plugins/plugin-bridge.service.ts | getActiveWorkContext()、egisterWorkContextHeaderButton()、showInWorkContext()、closeWorkContextView() 的代理 |
| src/app/core-ui/main-header/main-header.component.html + 新增 plugin-work-context-header-btns.component.ts | 在现有 <plugin-header-btns> 旁边渲染上下文范围按钮 |
| src/app/features/work-view/work-view.component.ts/html | 分支：如果 pluginBridge.workContextEmbedPluginId() 已设置且上下文是项目或 TODAY 标签，则在任务列表位置渲染 <plugin-index [directPluginId]="..." [showFullUI]="false" [skipCleanupOnDestroy]="true">；像当前 isDocumentMode() 一样抑制工作视图表头 |

## 插件（packages/plugin-dev/document-mode/）

从 sync-md 脚手架搭建。使用 Vite 构建。打包：@tiptap/core + @tiptap/starter-kit + @tiptap/extension-placeholder + @tiptap/suggestion。原生节点视图（vanilla node-views）——不依赖 React（约 150 KB gzipped）。

**清单（Manifest）：** iFrame: true, isSkipMenuEntry: true, sidePanel: false, 钩子 WORK_CONTEXT_CHANGE + ANY_TASK_UPDATE, uiKit: true。

**编辑器模型：** ProseMirror JSON。无 DocumentBlock[]。自定义 **	askRef** 原子节点 { atom: true, draggable: true, selectable: true, attrs: { taskId } }：

- NodeView 从本地缓存渲染复选框 + 标题，缓存由 getTasks() 填充。只读显示。
- 复选框切换 → updateTask(taskId, { isDone })。
- 点击标签 → dispatchAction 在现有侧面板中打开任务（不在编辑器中编辑）。
- 	askRef 开头退格键：确认对话框（通过主机 openDialog——_isBareTask 启发式判断移至主机端，因为插件的 Task 接口缺少 deadlineDay/eminderId；在 API 上暴露新的 confirmTaskDeletion(taskId): Promise<boolean> 辅助方法，或在 v1 中始终确认）。
- 	askRef 末尾回车键：ddTask({...}) + 插入兄弟 	askRef。

**其他块：** StarterKit（段落/标题/粗体/斜体/删除线/代码）、HorizontalRule（分隔线）、Placeholder（空状态）。

**斜杠菜单：** @tiptap/suggestion，配置 char: '/', llowedPrefixes: null（这样任意文本后的 / 都会触发——当前行为）。菜单项：任务 / 段落 / H1 / H2 / H3 / 分隔线以及类型转换。

**块菜单 + 拖拽手柄：** 在 .ProseMirror 鼠标移动上使用原生浮动 UI（vanilla floating UI）。

**生命周期：**

- 加载时 → 注册上下文表头按钮，使用 showFor: ['PROJECT', 'TODAY']。
- 收到 WORK_CONTEXT_CHANGE → 刷新待保存的上一个上下文；从 persistDataSynced blob（{[ctxId]: doc} 映射）加载新上下文的文档 → 初始化编辑器。如果没有存储文档，从 payload.taskIds 初始化。
- 收到当前上下文的 ANY_TASK_UPDATE，且操作为任务已添加 → 如果缺失则追加 	askRef（类似 syncMissingTasks）。
- editor.on('update') → 5 秒防抖 → 写入映射，持久化整个 blob。在 pagehide 和 WORK_CONTEXT_CHANGE 时刷新。注意：iframe 内的 pagehide 在 Electron 退出时不会触发——最后一个防抖窗口可能丢失。POC 接受此限制；v2 可以暴露主机端 eforeUnload 钩子。

## 工作顺序

1. **主机管道——先处理审阅修复**（event.source 检查、skipCleanupOnDestroy、iframe 枚举中的 ANY_TASK_UPDATE）。无论此功能如何，这些都是 bug/缺口。
2. **API 扩展**：新类型、WORK_CONTEXT_CHANGE 钩子（使用适当的 distinct-untils + 门控）、getActiveWorkContext、上下文按钮 onClick 的回调代理。
3. **主机 UI**：<plugin-work-context-header-btns> + workContextEmbedPluginId 信号 + 工作视图分支。
4. **插件脚手架** + 清单 + 注册按钮 + 打开空编辑器。
5. **TipTap 编辑器**：段落/标题/分隔线 + 在单个 blob 中按上下文的持久化。
6. **	askRef 只读节点** + 通过钩子创建/删除。
7. **斜杠菜单 + 块菜单 + 拖拽手柄。**

## 范围外（推迟到 v2）

- 可内联编辑的 	askRef 标题（POC 中为只读标签）。
- 键控 persistDataSynced(data, key) API——POC 在单个 blob 中使用 {[ctxId]: doc}。
- 移除树内 src/app/features/document-mode/、documentBlocks/isDocumentMode 字段、isDocumentModeEnabled 标志。
- 从遗留 documentBlocks 的数据迁移。
- 默认安装打包。
- 用于 iframe 的 Electron eforeUnload 钩子。

## 开放风险（已确认，未解决）

- nyTaskUpdate$ 不覆盖子任务重排序 / Today 列表移动 / 项目列表重排序。对于只读标签影响较小（标题 + isDone），但其他上下文的标题更新在切换回来之前不会反映。
- getTasks() 每次调用返回 ALL 所有任务——当前规模没问题，但在任务图增长时需要关注。
- 主机端修复（"必需的主机端修复"部分）影响现有插件（sync-md 等）。为 plugin-bridge.service.spec.ts 添加回归测试，并验证 sync-md 仍然正常加载。
