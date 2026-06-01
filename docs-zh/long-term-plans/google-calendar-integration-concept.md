# Google Calendar 集成——概念设计文档

## 背景

Super Productivity 目前有一个只读的 iCal 日历集成，可在计划视图（planner）和日程视图（schedule）中显示事件。存在一个 Google Calendar 插件（`packages/plugin-dev/google-calendar-provider/src/plugin.ts`），具有完整的 OAuth + CRUD（增删改查）能力。目标是设计一个更丰富的 Google Calendar 集成，让用户完全在 SP 内部管理日历，无需单独的日历应用。该设计不是采用"真正的双向同步"（这存在根本性问题——日历事件和任务是不同的实体），而是使用一个**基于所有权的模型**，行为根据创建者决定。

## 概念：四层架构

### 第 1 层：日历展示（Google → SP）

来自所有已连接 Google 日历的事件出现在计划视图和日程视图中。只读展示，与当前 iCal 行为相同，但通过 Google Calendar API 并使用增量 `syncToken`（同步令牌）同步获取。

### 第 2 层：事件管理（SP ↔ Google，直接 CRUD）

用户可以直接从计划视图和日程 UI 中作为**事件**（而非任务）创建、编辑和删除日历事件。编辑操作会写入事件来源的日历。新事件进入用户选择的默认日历（可通过下拉菜单配置）。这是直接的 API 调用，不是同步。

### 第 3 层：事件提升为任务（一次性快照）

用户在事件详情面板中显式点击"从此事件创建任务"。创建链接的任务，任务独立存在。完成任务或删除任务不会影响日历事件。

### 第 4 层：任务→日历时间块（SP → Google，最低优先级）

当用户安排一个任务（设置了 `dueWithTime` + `timeEstimate`）时，SP 可以将一个时间块事件推送到指定的日历。SP 拥有这些事件。完成任务将事件标记为已完成（保留事件，不删除）。此层为最低优先级，应最后构建。

---

## 配置/设置

**设置 > 集成 > Google Calendar：**

1. **连接 Google 账号**——OAuth 按钮（现有插件流程）
2. **要显示的日历**——用户所有 Google 日历的多选（读 + 写权限）
3. **新事件的默认日历**——可写日历的下拉菜单
4. **时间块日历**——（第 4 阶段）可写日历的下拉菜单，用于任务时间块
5. **自动安排已计划任务的时间块**——（第 4 阶段）开关，默认关闭
6. **同步范围**——向前获取多远的时间（默认：2 周）

### 插件的配置模型变更：

```
displayCalendarIds: string[]        // 所有要展示的日历
defaultWriteCalendarId: string      // 新事件的默认目标
timeBlockCalendarId: string | null  // 任务时间块的目标（第 4 阶段）
isAutoTimeBlock: boolean            // 自动推送已计划任务（第 4 阶段）
syncRangeWeeks: number              // 获取范围（周数）
```

---

## 交互设计

### 第 1 层：日历展示

**无 UI 变更。** Google Calendar 事件流入与 iCal 事件相同的 `CalendarIntegrationEvent[]` 管道。计划视图选择器将其拆分为 allDayEvents（全天事件）/timedEvents（定时事件）。日程视图将其渲染为时间块。

**数据源变更：** `CalendarIntegrationService` 在 iCal 之外新增 Google Calendar 获取路径。使用 `syncToken` 进行增量同步（比重新解析 iCal 订阅快得多）。

### 第 2 层：事件管理

**点击日历事件**——打开一个 **mat-menu**，包含三个选项：

1. **编辑事件**——打开对话框查看/编辑事件详情（标题、时间、时长、描述、日历名称）。保存调用 `PATCH /calendars/{calendarId}/events/{eventId}`。事件保留在其原始日历中。对话框还有"删除事件"按钮，调用 `DELETE /calendars/{calendarId}/events/{eventId}`。对于只读日历，对话框显示详情但不显示编辑/删除控件。
2. **创建为任务**——调用 `IssueService.addTaskFromIssue()`，使用 Google Calendar 提供者密钥。创建任务，`issueId`（问题 ID）指向该事件。一次性快照，无持续同步。日历事件不受任务生命周期影响。
3. **永久隐藏**——从计划视图和日程视图中永久隐藏此事件。本地存储（不同步到 Google）。适用于重复的干扰性事件，如"办公室关闭"或用户不关心的事件。

**创建事件**——问题面板（issue panel）中新增"添加事件"按钮（与现有任务创建并列）。显示标题输入、时间选择器、日历下拉菜单（默认使用 `defaultWriteCalendarId`）。通过 `POST /calendars/{calendarId}/events` 创建。

**拖动重新安排时间**——在日程视图中拖动日历事件时调用 `updateIssue()` 并传入新的开始时间（未来增强）。

### 第 4 层：任务→日历时间块（最低优先级）

**自动创建触发器：** 新的 effect（副作用）监听任务获得 `dueWithTime` + `timeEstimate` 的事件。如果 `isAutoTimeBlock` 已启用且任务尚未链接到 issue，则在 `timeBlockCalendarId` 上创建事件并链接该任务。

**重新安排时间：** 任务时间变更时更新事件（限已链接的事件）。

**完成：** 将事件标记为已完成，不删除。这可保留日历中的时间记录历史。

**删除：** 删除任务时提供可选项——删除关联的日历事件。

**UI：** 任务详情中显示"在日历中查看"链接。第 2 层的日历事件详情对话框不显示"创建为任务"按钮（已经是任务）。

---

## 集成点

### 需要什么：

- 第 1 层的 `CalendarIntegrationService`（现有）
- 第 3 层的 `IssueService.addTaskFromIssue()`
- 第 4 层的双向同步推送/删除 effects

### 需要修改的内容：

- `CalendarIntegrationService`——在 iCal 旁添加 Google Calendar API 获取，支持 `syncToken`
- 日历提供者选择器——除了 `'ICAL'` 之外，还需匹配 Google Calendar 插件密钥
- `PlannerCalendarEventComponent`——点击打开上下文菜单而非转换为任务
- `ScheduleEventComponent.clickHandler()`——日程视图同样的变更
- Google Calendar 插件配置——添加多日历字段

### 新组件：

- `CalendarEventContextMenuComponent`——事件点击时触发的 mat-menu（编辑事件 / 创建为任务 / 永久隐藏）
- `CalendarEventEditDialogComponent`——查看/编辑/删除事件的对话框
- `AddEventInlineComponent` 或问题面板中的模式——用于创建新事件
- `GoogleCalendarCacheService`——管理 `syncToken` 和增量同步
- `HiddenCalendarEventsService`——持久化永久隐藏的事件 ID（localStorage 或 IndexedDB）
- `TimeBlockSyncEffect`（第 4 阶段）——监听任务计划变更，自动创建/更新/删除事件

### 关键数据流：

```
第 1 层：Google Calendar API -> CalendarIntegrationService -> CalendarIntegrationEvent[] -> 计划/日程选择器 -> UI
第 2 层：UI 操作 -> Google Calendar API（直接 CRUD）-> 刷新缓存 -> UI 更新
第 3 层：UI "创建任务"按钮 -> IssueService.addTaskFromIssue() -> 创建带有 issueId 链接的任务
第 4 层：任务计划变更 -> TimeBlockSyncEffect -> Google Calendar API -> 事件创建/更新/删除
```

---

## 分阶段交付

### 第 1 阶段：Google Calendar 展示（第 1 层）

- `CalendarIntegrationService` 中的 Google Calendar API 获取
- `syncToken` 增量同步
- 配置中的多日历选择
- 事件出现在计划/日程视图中（相同渲染，不同数据源）

### 第 2 阶段：上下文菜单 + 事件详情对话框（第 2 层 + 第 3 层细化）

- 构建 `CalendarEventContextMenuComponent`（mat-menu：编辑事件 / 创建为任务 / 永久隐藏）
- 构建 `CalendarEventEditDialogComponent`（查看/编辑/删除事件详情）
- 修改计划/日程视图中的点击处理程序，打开上下文菜单而非自动转换为任务
- `HiddenCalendarEventsService` 用于"永久隐藏"持久化
- "创建为任务"菜单项替代当前的点击即转换行为

### 第 3 阶段：事件 CRUD（第 2 层写入）

- 事件对话框中的编辑模式（标题、时间、描述）
- 事件对话框中的删除按钮
- 问题面板中的"添加事件"创建流程，含日历下拉菜单
- 尊重 `accessRole`（访问角色），对只读日历隐藏编辑/删除控件

### 第 4 阶段：任务时间块（第 4 层）

- `TimeBlockSyncEffect` 用于从已计划任务自动创建日历事件
- 已完成状态处理（标记事件，不删除）
- 配置：时间块日历选择、自动安排开关

---

## 关键设计决策

1. **所有权决定行为**——没有"同步方向"配置。Google 事件作为事件读取和编辑。SP 时间块由 SP 拥有。
2. **事件 CRUD 绕过任务/问题系统**——编辑日历事件不创建或修改任何任务实体。
3. **无重复事件写回**——展示重复实例（通过 `singleEvents: true`），但从不创建或修改重复系列。
4. **编辑保留在源日历中**——编辑事件总是修补其原始日历中的事件。新事件使用可配置的默认日历。
5. **时间块完成 = 标记完成，不删除**——在日历中保留已花费时间的历史记录。
6. **第 4 层优先级最低**——第 1-3 层提供核心价值。时间块是建立在其上的锦上添花功能。

---

## 需要创建/修改的文件

### 第 1 阶段

- `src/app/features/calendar-integration/calendar-integration.service.ts`——添加 Google 获取路径
- `packages/plugin-dev/google-calendar-provider/src/plugin.ts`——扩展配置模型
- `src/app/features/planner/store/planner.selectors.ts`——接受 Google Calendar 提供者密钥

### 第 2 阶段

- 新增：`src/app/features/calendar-integration/calendar-event-context-menu/`——mat-menu 组件
- 新增：`src/app/features/calendar-integration/calendar-event-edit-dialog/`——编辑对话框组件
- 新增：`src/app/features/calendar-integration/hidden-calendar-events.service.ts`——永久隐藏持久化
- `src/app/features/planner/planner-calendar-event/planner-calendar-event.component.ts`——点击打开上下文菜单
- `src/app/features/schedule/schedule-event/schedule-event.component.ts`——点击打开上下文菜单

### 第 3 阶段

- 新增：问题面板区域中的事件创建 UI
- `calendar-event-edit-dialog` 组件——添加编辑模式
- `packages/plugin-dev/google-calendar-provider/src/plugin.ts`——确保 CRUD 方法处理所有情况

### 第 4 阶段

- 新增：`src/app/features/issue/two-way-sync/time-block-sync.effects.ts`
- `packages/plugin-dev/google-calendar-provider/src/plugin.ts`——完成标记逻辑
