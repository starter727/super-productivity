# 专注模式与时间追踪同步——概念重新设计

## 上下文

GitHub 讨论 [#6781](https://github.com/super-productivity/super-productivity/discussions/6781) 调查了番茄钟+时间追踪用户是否同步这两者；结果约 100% 的用户会同步。当前默认值 `focusMode.isSyncSessionWithTracking: false` 因此对于同时使用这两者的用户群体是错误的。更糟的是，非同步模式存在用户可见的缺陷（[#6731](https://github.com/super-productivity/super-productivity/issues/6731)：暂停专注并不会暂停追踪——用户称之为错误，而非配置权衡）。[#5737](https://github.com/super-productivity/super-productivity/issues/5737) 记录了一位长期用户丢失了*旧*的简单工作流程——按下追踪播放按钮即可静默地同时开始番茄钟。[#7112](https://github.com/super-productivity/super-productivity/issues/7112) 提出了替代设置。

时间追踪和专注模式默认是独立功能——按下播放按钮只追踪时间；专注模式通过 F 键或标题栏专注按钮选择加入。将它们关联起来是高级用户的选择。重新设计保持这一界限不变，同时使关联（当激活时）更清晰、更可预测。

## 目标

1. **当两个功能都在使用时，生命周期始终同步。** 暂停→暂停，停止→停止，恢复→恢复。无需用户可见的切换开关。
2. **为播放按钮自动启动提供一个新的选择加入开关。** 希望使用 #5737 旧工作流程的用户翻转一个开关。默认为关闭。
3. **入口点决定显示方式。** 手动进入（F 键、专注按钮、右键菜单"专注会话"）→覆盖层。从追踪播放按钮自动启动→一个简洁的专用会话指示器（见下文"安静/自动启动会话的显示表面"）。无需为此添加新设置——现有的 `isOverlayShown` reducer 字段已支持运行带有隐藏覆盖层的会话。
4. **整理设置 UI。** 将附带标志移入可折叠的"高级"部分。`isPauseTrackingDuringBreak` 是高级选项；"暂停意味着暂停"是默认行为。

## 决策总结

| 当前 | 变更后 |
|---|---|
| `isSyncSessionWithTracking: false`（默认）控制 8 个效果；关闭模式有缺陷 | 标志移除。同步始终开启。8 个效果移除门控条件。 |
| 播放按钮→追踪时间；如果同步开启，同时打开覆盖层 | 播放按钮→追踪时间。如果新的选择加入 `autoStartFocusOnPlay: true`，还会启动一个专注会话，通过一个安静的标题指示器显示（从不打开覆盖层）。 |
| `isPauseTrackingDuringBreak`（默认 true）与其他标志平铺排列 | 默认值不变。标志移入折叠的"高级"部分。 |
| `isStartInBackground` 和 `isSkipPreparation` 适用于所有入口点 | 仅适用于**手动**进入（F键/专注按钮/右键菜单）。自动启动忽略它们：仅指示器，无火箭动画。两者移至"高级"。 |
| `isManualBreakStart` 在表单中声明，缺失默认值 | 添加 `false` 默认值。移至"高级"。 |

## 行为变化——具体说明

### 始终同步（当两者都在运行时）
`src/app/features/focus-mode/store/focus-mode.effects.ts` 中的 8 个效果（`autoShowOverlay$`、`syncTrackingStartToSession$`、`syncTrackingStopToSession$`、`syncSessionPauseToTracking$`、`syncSessionResumeToTracking$`、`syncSessionStartToTracking$`、`stopTrackingOnSessionEnd$`、`stopTrackingOnExitBreakToPlanning$`）移除 `cfg?.isSyncSessionWithTracking` 过滤器。它们的其他门控条件（`isFocusModeEnabled`、屏幕状态等）保留。这从结构上修复了 [#6731](https://github.com/super-productivity/super-productivity/issues/6731)。

### 播放时自动启动
- 新标志：`focusMode.autoStartFocusOnPlay: boolean`，默认 `false`。
- 新效果，与现有同步效果同级：当 `currentTaskId$` 从 `null → id` 转换且 `autoStartFocusOnPlay` 且 `isFocusModeEnabled` 且没有正在运行的会话时→调度 `startFocusSession({ duration })`。**不要**调度 `showFocusOverlay()`。
- 在安静/自动启动的会话期间按 F 键→现有的 `showFocusOverlay()` 调度升级为覆盖层（免费）。
- 在会话期间关闭覆盖层→返回到安静指示器（免费；现有行为——会话继续运行，覆盖层只是隐藏）。

### 安静/自动启动会话的显示表面

现有的 `updateBanner$` 效果（约第 829-978 行）重用全局 `BannerService`（`BannerId.FocusMode`）。这对于正在进行的会话来说是错误的显示表面：

- 专注模式横幅与临时横幅（`TakeABreak`、`Offline`、`CalendarEvent` 等）位于同一插槽——参见 `src/app/core/banner/banner.model.ts:3-31`。
- `BannerId.FocusMode` 是优先级 `1`，系统中最低。更高优先级的横幅（`TakeABreak: 6`、`CalendarEvent: 5` 等）完全隐藏它——意味着在会话期间，当其他横幅到达时，用户可能丢失专注控制和倒计时。
- 横幅视觉上很重；一个始终在线的会话

**锚点 A**：在使用 `selectIsSessionRunning` 为 true 且覆盖层隐藏时，在播放按钮区域显示一个嵌入式的可靠倒计时，以及一个悬停时显示的控制行（暂停/恢复/跳过/结束/打开覆盖层）。
- **锚点 B**：对 `src/app/core-ui/main-header/focus-button/focus-button.component.ts` 做同样处理。
- 桌面端悬停行使用 CSS `:hover`；在触屏/移动设备上，该行始终可见（使用 `@media (hover: none)` 或现有的平台检查）。
- 无论哪种方式，移除与 `BannerId.FocusMode` 相关的 `BannerService` 调用和 `updateBanner$` 效果。

### 迁移
- `src/app/op-log/validation/repair-global-config.ts` 目前完全被注释掉。要么恢复它并添加 focusMode 特定的修复（移除过时的 `isSyncSessionWithTracking`；回填 `autoStartFocusOnPlay`）**要么**依赖现有的针对 `DEFAULT_GLOBAL_CONFIG` 的深度合并来回填，并添加一行代码删除旧键。推荐第二条路径以最小化影响范围；仅在测试显示默认值未合并时才恢复 `repair-global-config.ts`。

### 测试
- 更新引用 `isSyncSessionWithTracking` 的 spec 文件：
  - `src/app/features/focus-mode/store/focus-mode.effects.spec.ts`
  - `src/app/features/focus-mode/store/focus-mode.bug-5875.spec.ts`
  - `src/app/features/focus-mode/store/focus-mode.bug-5995.spec.ts`
  - `src/app/features/focus-mode/store/focus-mode.bug-6064.spec.ts`
  - `src/app/features/focus-mode/store/focus-mode.bug-6575.spec.ts`
  - `src/app/features/focus-mode/focus-mode-main/focus-mode-main.component.spec.ts`
- 新测试：`focus-mode.effects.spec.ts` 中为 `autoStartFocusOnTracking$` 添加用例（仅指示器生成；会话已运行时不会双重生成；当 `autoStartFocusOnPlay: false` 时忽略）。
- 新测试：回归测试，暂停专注无条件停止追踪（覆盖 #6731）。

## 开放给社区讨论

- **会话指示器锚点**：锚点 A（播放按钮）或锚点 B（专注按钮）。交互模式已确定：按钮上内联倒计时，桌面端悬停控制行，移动端始终可见。见上文"安静/自动启动会话的显示表面"。
- **新切换开关的命名**：`autoStartFocusOnPlay`（内部）和"当我开始追踪任务时启动专注会话"（标签，几乎逐字模仿 Toggl Track 的措辞）是当前的提案——欢迎替代方案。

## 明确排除的范围

- 重命名 `isPauseTrackingDuringBreak` → `isContinueTrackingDuringBreak`。默认值保持 `true`（= "暂停意味着暂停"）；仅改动 UI 位置。反转是一个干净的后续操作，但不是此更改必需的。
- #7112 中的第二个提议设置（"启动专注模式时自动选择任务"）。
- 首次运行介绍 `autoStartFocusOnPlay` 的引导提示。
- 移动端特定默认值。
- 空闲检测与新的始终同步行为的交互。

## 风险

- **对于 `isSyncSessionWithTracking: false` 的用户的行为变更**：暂停专注现在会停止追踪。这是用户报告的错误；有意为之。在提交信息中说明。
- **对于 `isSyncSessionWithTracking: true` 的用户的行为变更**：自动启动仍然发生，但产生一个安静的标题指示器而不是打开覆盖层。依赖覆盖层在播放时弹出的用户需要按 F（或点击指示器）。在 CHANGELOG 中记录。
- **横幅移除**：任何依赖 `BannerId.FocusMode` 横幅的用户（罕见——仅当覆盖层关闭且没有更高优先级横幅活动时才可见）丢失它。会话指示器是替代品。
- **效果重构触及一个文件中的 8 个位置**。每个门控在局部是隔离的；风险中等，且由现有的错误修复 spec 充分测试。
- **表单重构**：`isManualBreakStart` 目前缺少默认值；添加一个可能解锁潜在的代码路径。在测试中验证。

## 验证

- `npm run test:file src/app/features/focus-mode/store/focus-mode.effects.spec.ts`——所有更新的效果 spec 通过。
- `npm test`——完整单元套件绿色。
- `npm run checkFile` 在每个修改过的 `.ts` 和 `.scss` 上执行。
- 手动冒烟测试（web `ng serve`）：
  1. 新配置：在任务上按播放→无指示器、无覆盖层、时间累积。
  2. 按 F→覆盖层打开带火箭动画。按暂停→追踪停止。按恢复→追踪恢复。
  3. 通过覆盖层停止会话→追踪停止。
  4. 打开 `autoStartFocusOnPlay`。在任务上按播放→标题指示器显示倒计时，覆盖层不显示。按 F→覆盖层打开（升级）。关闭覆盖层→指示器返回，会话继续。
  5. `autoStartFocusOnPlay` 开启时：暂停专注→追踪停止；恢复专注→追踪恢复；停止专注→追踪停止。
  6. `autoStartFocusOnPlay` 开启且番茄钟模式：会话结束时，休息开始。确认 `isPauseTrackingDuringBreak: true`（默认）→休息开始时追踪停止。切换为 `false`（高级）→追踪在休息期间继续。
- E2E：扩展 `e2e/tests/focus-mode/`（如果存在）添加一个自动启动流程。
