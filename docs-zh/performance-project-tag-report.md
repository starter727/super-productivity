# 性能调查——项目/标签导航

## 代码路径

1. **侧边栏选择**：NavItemComponent 渲染指向 project/:id/tasks 或 	ag/:id/tasks 的路由链接，并显示任务计数（src/app/core-ui/magic-side-nav/nav-item/nav-item.component.html:12、.ts:115-139）。
2. **路由目标**：pp.routes.ts:65-186 将任务视图解析为 ProjectTaskPageComponent 或 TagTaskPageComponent，它们简单地嵌入 <work-view> 并绑定到 WorkContextService。
3. **工作上下文服务**：WorkContextService 响应 NavigationEnd，分发 setActiveWorkContext，并重新计算 	odaysTasks$、acklogTasks$、undoneTasks$、doneTasks$、预估时间等（src/app/features/work-context/work-context.service.ts:254-406）。
4. **专注模式覆盖层**：FocusModeOverlayComponent.closeOverlay() 分发 hideFocusOverlay（src/app/features/focus-mode/focus-mode-overlay/focus-mode-overlay.component.ts:120-152）；pp.component.html 根据条件渲染覆盖层或整个应用外壳，因此关闭覆盖层会重新挂载 magic-side-nav、outer-outlet 和 WorkViewComponent。

## 疑似瓶颈点

| 区域                                                                                                                | 为什么在任务多时造成问题                                                                                                                                                                                   |
| ------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| pp.component.html:26-69                                                                                          | 挂载 <focus-mode-overlay> 会替换整个应用，因此关闭覆盖层会重建每个主要组件和任务列表。                                                                                  |
| _getTasksByIds$ + selectTasksWithSubTasksByIds（work-context.service.ts:266-406、	ask.selectors.ts:254-409） | 每次导航都会为所有 ID 填充完整的 TaskWithSubTasks 结构，然后多个下游过滤器/归约操作重新运行（undone/done/backlog/预估）。                                                      |
| doneTasks$ 的"今日"情况（work-context.service.ts:401-405）                                                         | 回退到 selectAllTasksWithSubTasks，因此每当"今日"活动时，工作区中的每个任务都会被填充。                                                                                               |
| 侧边栏徽章（
av-item.component.ts:115-129）                                                                    | 对于每个导航项，我们过滤其 	askIds 并在全局已完成列表中调用 includes → O(上下文数 × 每个上下文的任务数)。                                                                             |
| 渲染（work-view.component.html:84-210、	ask-list.component.html:17-45）                                     | 每个任务都会渲染一个完整的 <task> 组件，支持拖放，没有虚拟滚动或延迟渲染，因此大型上下文必须在 UI 响应之前完成数百或数千个元素的实例化。 |

## 推荐的更改

1. **在专注模式期间保持应用挂载**：将 <focus-mode-overlay> 渲染为绝对定位的覆盖层，使用 CSS 隐藏下方的应用，而不是 pp.component.html 中的 @else 分支。防止关闭覆盖层时拆卸/重建。
2. **按上下文记忆化任务填充**：用按 ID 缓存 TaskWithSubTasks 的选择器替换 _getTasksByIds$/selectTasksWithSubTasksByIds，仅在实体或 ID 列表变化时重新计算。在 undoneTasks$、doneTasks$ 和预估中复用相同的记忆化数据。
3. **预计算轻量级计数**：在工作上下文状态中存储每个项目/标签的未完成/已完成计数，使侧边栏徽章可以读取一个数字而不是扫描 	askIds。
4. **避免"今日"已完成任务的工作区级扫描**：按上下文（包括"今日"）跟踪已完成 ID，使 doneTasks$ 永远不会回退到 selectAllTasksWithSubTasks。
5. **虚拟化或分块渲染任务**：对长列表引入 cdk-virtual-scroll-viewport，或将积压/已完成渲染推迟到首次绘制之后。即使在低性能设备上，骨架屏状态也能将交互保持在 1 秒以内。

## 性能分析指导

- **路由检测**：WorkContextService 已经标记了 work-view-route；使用 Chrome DevTools Performance 面板在大型项目/标签间切换，查看这些测量的 JS 帧持续时间。
- **填充计时**：在 _getTasksByIds$ 或 selectTasksWithSubTasksByIds 中包裹 console.time('hydrateTasks')，量化每次导航的填充耗时。
- **覆盖层拆卸**：在关闭专注覆盖层时捕获 Angular DevTools 分析数据，确认整个应用树被重建。
- **侧边栏成本**：在多个上下文存在时，临时在 
rOfOpenTasks（nav-item）中记录计时，以揭示 O(n²) 行为。
- **渲染**：使用 Chrome DevTools Rendering（FPS）和 Angular DevTools 对比添加虚拟化或延迟渲染前后的效果；确保首次绘制保持在 400–1000 毫秒内。