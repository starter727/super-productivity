# CalDAV VEVENT 扩展——设计文档

> **状态：已计划**

## 概述

扩展现有的 CalDAV 提供程序（provider），使其在 VTODO（任务）之外额外支持 VEVENT（日历事件）。这使得自托管日历用户（Nextcloud、Radicale、Baikal、Fastmail）能够实现双向事件同步，无需新的认证基础设施——与 VTODO 使用相同的基本认证（basic auth）。

## 动机

- **注重隐私的用户**通常通过 CalDAV 自托管日历。对于这类用户群体而言，这是在最低复杂度下实现日历同步最高价值的路径。
- **无新增认证复杂度**——基于 HTTPS 的基本认证，已经实现。
- **无需外部依赖**——无需 OAuth、认证代理或 Google 应用验证。
- **已有库支持**——`@nextcloud/cdav-library` 已支持 `findByType('VEVENT')` 和 `findByTypeInTimeRange('VEVENT', from, to)`。`ical.js` 已用于解析。
- **与 Google 日历互补**——服务于自托管用户群体，而 Google 日历（独立的提供程序，基于 OAuth）则服务于主流用户。

## 决策

| 决策              | 选择                                                                  | 理由                                                                                      |
| ----------------- | --------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| 提供程序方式      | 扩展现有 CalDAV 提供程序                                              | 单个提供程序从同一服务器连接处理 VTODO 和 VEVENT                                          |
| 事件行为          | 按提供程序配置：横幅通知（默认）或自动导入为任务                       | 符合用户需求；复用 ICAL 提供程序中已有的 `isAutoImportForCurrentDay` 模式                 |
| 数据模型          | 复用 `CalendarIntegrationEvent` + CalDAV 专用的 etag/URL 包装器        | 与 ICAL 提供程序共享展示层；为写回操作添加同步元数据                                      |
| 认证              | 与 VTODO 相同的认证——无需更改                                          | 已实现且正常工作                                                                          |
| 同步方向          | 双向（按字段配置，与 VTODO 类似）                                      | 与现有 CalDAV 同步行为一致                                                                |

---

## 当前状态

### 已存在的功能

**CalDAV 提供程序**（`src/app/features/issue/providers/caldav/`）：

- 基于基本认证的双向 VTODO 同步
- 使用 `@nextcloud/cdav-library` + `ical.js`
- 同步适配器模式：`CaldavSyncAdapterService` 实现 `IssueSyncAdapter<CaldavCfg>`
- 字段级同步方向配置（`SyncDirection = 'off' | 'pullOnly' | 'pushOnly' | 'both'`）
- 基于 ETag 的变更检测（哈希为 32 位整数以进行数值比较）
- 每个连接的客户端/日历缓存

**ICAL 提供程序**（`src/app/features/issue/providers/calendar/`）：

- 从 `.ics` URL 只读展示 VEVENT
- `CalendarIntegrationEvent` 模型：`{ id, calProviderId, title, description, start, duration, isAllDay }`
- `isAutoImportForCurrentDay` 标记，用于从事件自动创建任务
- 即将发生事件的横幅通知（`showBannerBeforeThreshold`）
- 完整的 RFC 5545 支持：重复事件（RRULE）、EXDATE、RECURRENCE-ID 覆盖

### 缺失部分

- CalDAV VEVENT 查询（库支持，但代码未使用）
- CalDAV 客户端中的 VEVENT 解析（目前仅解析 `vtodo` 子组件）
- 来自 CalDAV 源的日历事件展示（目前仅来自 `.ics` URL）
- VEVENT 的写回操作（在 CalDAV 服务器上更新事件状态/字段）

---

## 架构

### 配置模型扩展

```typescript
// 现有 CaldavCfg，已扩展：
interface CaldavCfg extends BaseIssueProviderCfg {
  caldavUrl: string | null;
  resourceName: string | null;
  username: string | null;
  password: string | null;
  categoryFilter: string | null;

  // 现有 VTODO 同步
  twoWaySync?: CaldavTwoWaySyncCfg;

  // 新增 VEVENT 支持
  includeEvents?: boolean; // 启用 VEVENT 获取（默认：false）
  eventBehavior?: 'banners' | 'auto-import'; // 事件在 SP 中的展示方式
  eventTwoWaySync?: CaldavEventTwoWaySyncCfg; // 事件的字段级同步
  showBannerBeforeThreshold?: number | null; // 事件前多少分钟显示横幅通知
  eventCheckInterval?: number; // 事件轮询间隔（毫秒）
}

interface CaldavEventTwoWaySyncCfg {
  title?: SyncDirection;
  description?: SyncDirection;
  // VEVENT 没有"完成"状态——状态是 confirmed/tentative/cancelled
  // 映射：任务完成 → 事件取消（可配置）
  markDoneAs?: 'cancelled' | 'none';
}
```

### VEVENT 数据模型

```typescript
// 使用 CalDAV 同步元数据扩展 CalendarIntegrationEvent
interface CaldavCalendarEvent extends CalendarIntegrationEvent {
  etag_hash: number; // 用于变更检测（与 VTODO 相同的模式）
  caldavUrl: string; // 用于写回操作
  etag: string; // 原始 ETag 字符串
}
```

### CalDAV 客户端扩展

`CaldavClientService` 新增方法：

```typescript
class CaldavClientService {
  // 现有方法（VTODO）保持不变

  // 新增 VEVENT 方法
  async _getCalendarObject(): Promise<CalendarObject|void> {
    // 获取底层 calendarObject，用于 VEVENT 查询
  }

  async _getAllEvents(fromIncl: Date, toExcl: Date): Promise<CaldavCalendarEvent[]> {
    // 使用 findByTypeInTimeRange('VEVENT', from, to)
    // 将 ical.ts 事件映射为统一的 CalendarIntegrationEvent 格式
    // 附加 CalDAV 元数据（etag_hash、caldavUrl、etag）
  }

  async _mapEvent(eventComponent: ICAL.Event, ...): Promise<CaldavCalendarEvent> {
    // 解析 VEVENT 组件为 CaldavCalendarEvent
    // 处理：摘要→标题、描述→说明、DTSTART→开始时间、DTEND→持续时间
    // 使用 ical.js 解析 RRULE 并扩展重复实例
  }

  async _updateEvent(url: string, etag: string, updates: Partial<CaldavCalendarEvent>): Promise<void> {
    // 构建 VEVENT 的 CALDAV:calendar-data，使用 PUT 更新
    // 处理以下字段变更：
    //   - 标题（SUMMARY）
    //   - 描述（DESCRIPTION）
    //   - 状态（STATUS: CONFIRMED / CANCELLED / TENTATIVE）
    // 在 If-Match 头中使用 ETag 进行乐观并发控制
  }
}
```

### CalDAV 事件同步适配器（新增）

新增文件：`CaldavEventSyncAdapterService`，遵循与 `CaldavSyncAdapterService` 相同的模式，但用于事件。在 `issue-two-way-sync.effects.ts` 中注册。

该适配器处理：
- **从 CalDAV 拉取变更**：轮询变更（ETag 哈希变更）
- **推送 SP 变更到 CalDAV**：将任务完成映射为事件取消
- **字段级同步方向**：标题、描述

将任务标记为完成时映射为事件取消：

- 如果 `markDoneAs === 'cancelled'`：将 VEVENT `STATUS` 设为 `CANCELLED`
- 如果 `markDoneAs === 'none'`：不写回完成状态

### 与 CalendarIntegrationEffects 集成

现有的 `CalendarIntegrationEffects.pollChanges$` 目前仅处理 ICAL 提供程序。它还需要轮询设置了 `includeEvents: true` 的 CalDAV 提供程序：

1. 定时（按 `eventCheckInterval`）调用 `CaldavClientService._getAllEvents()` 获取相关时间窗口
2. 通过与 ICAL 事件相同的展示管道发射 `CalendarIntegrationEvent[]`
3. 如果 `eventBehavior === 'auto-import'`，创建任务（复用现有的 `isAutoImportForCurrentDay` 逻辑）
4. 显示横幅通知（复用现有的阈值逻辑）

---

## VEVENT 与 VTODO：共存方式

单个 CalDAV 提供程序实例连接到一个日历资源。该资源可能同时包含 VTODO 和 VEVENT。提供程序同时处理两者：

| 方面              | VTODO（现有）                                       | VEVENT（新增）                                         |
| ----------------- | --------------------------------------------------- | ------------------------------------------------------ |
| 查询方式          | `calendar.calendarQuery()` 使用 VTODO 组件过滤器      | `calendar.findByTypeInTimeRange('VEVENT', from, to)`   |
| 展示方式          | backlog/今日列表中的任务                              | 日历横幅或导入的任务                                   |
| 双向字段          | isDone、title、notes                                 | title、description、done→cancelled                     |
| 变更检测          | ETag 哈希                                            | ETag 哈希（相同机制）                                  |
| 时间窗口          | 所有未完成任务（无时间过滤）                          | 当天/当周（可配置）                                    |

---

## 不同步的内容

- 参与者（SP 没有事件参与者的概念）
- 提醒/闹钟（SP 有自己的通知系统）
- 重复规则（复杂——展示重复实例，但重复编辑不在范围内）
- 附件
- SP 专用字段：子任务、时间追踪、标签、优先级、预估

---

## 实施阶段

### 阶段一：只读 VEVENT 导入

- 在 `CaldavClientService` 中添加 `_getAllEvents()` 和 `_mapEvent()`
- 使用 `includeEvents` 标记扩展 `CaldavCfg`
- 将 VEVENT 接入 `CalendarIntegrationEvent` 展示管道
- 支持横幅通知和 `auto-import` 行为
- 设置 UI：启用事件的复选框、行为选择器

### 阶段二：双向 VEVENT 同步

- 添加 `CaldavEventSyncAdapterService`
- 在双向同步效果中注册，与现有的 VTODO 适配器并列
- 支持标题/描述写回和 done→cancelled 映射
- 基于 ETag 的冲突检测（与 VTODO 相同）

### 阶段三：增强事件功能（未来）

- 时间范围配置（提前获取多少事件）
- 事件的分类/日历过滤
- 事件横幅中的位置展示
- 重复事件处理改进

---

## 与其他日历工作的关系

| 提供程序                          | 目标用户                     | 认证               | API        | 状态              |
| --------------------------------- | ---------------------------- | ------------------ | ---------- | ----------------- |
| **ICAL**（现有）                  | 拥有公共 .ics URL 的任何用户  | 无                 | HTTP GET   | 已完成（只读）    |
| **CalDAV VTODO**（现有）          | 自托管日历用户               | 基本认证           | CalDAV     | 已完成（双向）    |
| **CalDAV VEVENT**（本文档）       | 自托管日历用户               | 基本认证           | CalDAV     | 已计划            |
| **Google 日历**（独立文档）       | 主流用户                     | OAuth 2.0（混合代理）| REST API v3 | 已计划            |

CalDAV VEVENT 和 Google 日历是互补的：

- CalDAV VEVENT 为注重隐私、自托管的用户提供服务，零认证开销
- Google 日历为需要 OAuth 基础设施的主流用户提供服务
- 两者共享 `CalendarIntegrationEvent` 展示层和可配置的导入行为

---

## 参考资料

- 现有 CalDAV 提供程序：`src/app/features/issue/providers/caldav/`
- 现有 ICAL 提供程序：`src/app/features/issue/providers/calendar/`
- 日历集成效果：`src/app/features/calendar-integration/calendar-integration.effects.ts`
- 日历集成模型：`src/app/features/calendar-integration/calendar-integration.model.ts`
- 双向同步适配器接口：`src/app/features/issue/two-way-sync/issue-sync-adapter.interface.ts`
- 双向同步效果：`src/app/features/issue/two-way-sync/issue-two-way-sync.effects.ts`
- Google 日历提供程序设计：`docs/long-term-plans/google-calendar-provider-design.md`
- 通用日历同步分析：`docs/long-term-plans/calendar-two-way-sync-technical-analysis.md`
