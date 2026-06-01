# 高级引导：预设特定提示与欢迎任务

## 状态：已推迟（对初始实现来说过于复杂）

## 问题

用户选择预设并创建第一个任务后，没有针对其选定工作流程的进一步指导。"探索"提示过于通用，不会教授预设特定功能（时间追踪、计划器等）。

## 建议设计

### 欢迎任务

在预设选择时创建一个预设特定的欢迎任务。任务标题本身就是指令：

- **简单待办事项**："你的第一个任务——试着勾选我！"
- **时间追踪器**："尝试点击播放按钮来追踪此任务的时间"
- **生产力套件**："规划你的周——尝试在计划器中为我安排明天的日程"

### 预设特定提示（空闲后）

不显示通用的探索提示，而是等待用户交互约 8 秒。如果他们没有操作：

- **简单待办事项**：脉冲任务复选框 →"试着勾选你的第一个任务！"
- **时间追踪器**：脉冲播放按钮（`.tour-playBtn`）→"点击播放开始追踪时间"
- **生产力套件**：脉冲计划器导航项（`.tour-plannerMenuBtn`）→"打开计划器来安排你的任务"

如果用户在 8 秒内进行了交互（添加/更新任务、开始追踪、导航），则完全跳过提示——他们自己已经弄明白了。

### 翻译键

```json
"HINTS": {
  "NUDGE_TODO": "Try checking off your first task!",
  "NUDGE_TIME_TRACKER": "Click play to start tracking time",
  "NUDGE_TIME_TRACKER_TOUCH": "Tap play to start tracking time",
  "NUDGE_PRODUCTIVITY": "Open the Planner to schedule your tasks",
  "SKIP_ARIA": "Dismiss hint"
}
```

## 实现中遇到的挑战

### 1. 欢迎任务触发"任务已创建"的 snackbar
Snackbar 效果会在每个 `addTask` 动作时触发。需要通过 `OnboardingHintService.isOnboardingInProgress()` 检查来抑制。此外，由 `ExampleTasksService` 创建的示例任务也会触发 snackbar。

### 2. 示例任务与欢迎任务冲突
当 `tasks.length === 0` 时，`ExampleTasksService` 会在收件箱中创建 4 个教程任务。使用欢迎任务时，要么：
- 欢迎任务阻止示例任务（tasks.length > 0），要么
- 在尚未选择引导预设时需要抑制示例任务

### 3. 交互检测脆弱
监听"有意义的交互"来取消空闲计时器很棘手：
- 初始页面加载时会触发 `NavigationEnd`→必须 `skip(1)` 忽略
- 欢迎任务本身的 `addTask` 可能在时间重叠时触发
- 状态水合（hydration）/重放期间会触发 `updateTask`
- 需要跟踪多个订阅来正确清理

### 4. 时序链复杂
预设选择 → 1 秒动画 → 再 1 秒 → `startAfterPresetSelection()` → 8 秒空闲 → 显示提示 → 12 秒自动关闭。需要管理和清理多个超时。

### 5. "创建任务"提示变成死代码
有了欢迎任务，用户总是有任务，所以原始的"点击 + 添加你的第一个任务"提示永远不会触发。这意味着脉冲 + 按钮（一个强大的视觉锚点）丢失了。

## 实现前提条件

1. 在 `magic-nav-config.service.ts` 的计划器导航项中添加 `tourClass: 'tour-plannerMenuBtn'`
2. 验证启用时间追踪时 `.tour-playBtn` 可见（它在播放按钮组件上）
3. 确保 `task:first-of-type .check-done` 可靠地定位第一个任务的复选框
4. 考虑是否应完全移除 `ExampleTasksService` 转而使用欢迎任务

## 关键文件

- `src/app/features/onboarding/onboarding-hint.service.ts` — 核心提示编排
- `src/app/features/onboarding/onboarding-hint.component.ts` — 提示 UI（定位、脉冲、箭头）
- `src/app/features/onboarding/onboarding-presets.const.ts` — 包含提示元数据的预设定义
- `src/app/features/onboarding/onboarding-preset-selection.component.ts` — 欢迎任务创建
- `src/app/features/tasks/store/task-ui.effects.ts` — Snackbar 抑制
- `src/app/core/example-tasks/example-tasks.service.ts` — 示例任务创建守卫
- `src/app/core-ui/magic-side-nav/magic-nav-config.service.ts` — 计划器 tourClass

## 建议

在基础引导流程稳定并通过真实用户验证后实施此功能。简单的"添加你的第一个任务"→"探索"流程以 20% 的复杂度覆盖了 80% 的价值。
