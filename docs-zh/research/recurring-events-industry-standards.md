# 重复事件研究报告

## 执行摘要

Super Productivity 拥有功能性的重复任务系统，具备良好的基础模式（确定性 ID、同步安全设计、夏令时处理）。然而，它实现的是**自定义的重复模型**，缺乏用户对现代任务/日历应用所期望的许多模式。采用 **RFC 5545 RRULE** 作为重复格式，将以相对较低的实现成本解锁显著的能力提升。

---

## 1. 当前实现分析

### Super Productivity 已具备的功能

| 特性             | 实现                                             | 状态 |
|-----------------|-------------------------------------------------|------|
| 每日重复         | `repeatCycle: '\''DAILY'\''`                      | 是   |
| 每周重复         | `repeatCycle: '\''WEEKLY'\''` + 工作日标志         | 是   |
| 每月重复         | `repeatCycle: '\''MONTHLY'\''`                    | 是   |
| 每年重复         | `repeatCycle: '\''YEARLY'\''`                     | 是   |
| 间隔（每 N 次）   | `repeatEvery: number`                             | 是   |
| 工作日选择       | `monday`、`tuesday` 等布尔值                       | 是   |
| 开始日期         | `startDate: string`                               | 是   |
| 跳过重复实例     | `deletedInstanceDates: string[]`                  | 是   |
| 基于完成         | `repeatFromCompletionDate: boolean`               | 是   |
| 暂停/恢复        | `isPaused: boolean`                               | 是   |
| 确定性 ID        | `rpt_${cfgId}_${dueDay}`                          | 是   |
| 夏令时安全计算   | 使用中午（12:00）进行比较                          | 是   |
| 子任务模板       | `subTaskTemplates[]`                               | 是   |

### 优势

1. **同步安全架构** —— 确定性任务 ID 可防止跨设备重复
2. **夏令时处理** —— 使用基于中午的计算，避免夏令时问题
3. **清晰分离** —— `TaskRepeatCfg` 与任务分离，支持基于模板的生成
4. **预览系统** —— 在日程中显示未来重复实例，无需创建实际任务
5. **基于完成模式** —— 支持"完成后"调度（RFC 5545 中不包含）

---

## 2. 差距分析：缺失的功能

### 高影响缺失功能

| 模式                              | RFC 5545             | 行业应用       | Super Productivity |
|----------------------------------|----------------------|---------------|-------------------|
| 月的第 N 个工作日（如"第二个星期二"）  | `BYDAY=2TU`          | 所有主流应用   | 缺失              |
| 月的最后一天                      | `BYMONTHDAY=-1`      | 所有主流应用   | 缺失              |
| 月的最后一个工作日                | `BYDAY=-1FR`         | 多数应用       | 缺失              |
| 在 N 次重复后结束                  | `COUNT=10`           | 所有主流应用   | 缺失              |
| 在特定日期结束                    | `UNTIL=20251231`     | 所有主流应用   | 缺失              |
| 最后一个工作日（营业日）           | `BYDAY=MO-FR;BYSETPOS=-1` | 部分应用  | 缺失              |
| 每月多天                          | `BYMONTHDAY=1,15`    | 部分应用       | 缺失              |
| 每 N 个月的第 N 个工作日           | 复杂 RRULE           | Google/Outlook | 缺失              |

### 中等影响缺失功能

| 模式                     | RFC 5545               | 影响                               |
|-------------------------|------------------------|-----------------------------------|
| 修改单个重复实例         | `RECURRENCE-ID`         | 用户无法重新安排单个实例             |
| "本次及以后"的更改       | `RANGE=THISANDFUTURE`   | 必须删除后重新创建                   |
| 每两周多天重复           | `INTERVAL=2;BYDAY=MO,WE,FR` | 可用但 UI 有限                |
| 年中特定周               | `BYWEEKNO=1,26`         | 少见但有用                         |
| 年中的第几天             | `BYYEARDAY=100`         | 极少使用                           |

### 当前数据模型的限制

```typescript
// 当前：自定义格式
interface TaskRepeatCfg {
  repeatCycle: '\''DAILY'\'' | '\''WEEKLY'\'' | '\''MONTHLY'\'' | '\''YEARLY'\'';
  repeatEvery: number;
  monday?: boolean;
  tuesday?: boolean;
  // ... 另外 5 个布尔字段
  startDate?: string;
  // 无结束条件（COUNT/UNTIL）
  // 无 BYMONTHDAY 用于指定日期
  // 无 BYDAY 序数（1MO、-1FR）
}

// RFC 5545：单一字符串编码所有信息
// "FREQ=MONTHLY;BYDAY=2TU;COUNT=12"
```

---

## 3. 主流应用对比

| 特性                   | Google Calendar | Todoist | Things 3 | TickTick | Super Productivity |
|-----------------------|----------------|---------|----------|----------|-------------------|
| 基础（日/周/月/年）     | 是             | 是      | 是       | 是       | 是                |
| 每 N 间隔              | 是             | 是      | 是       | 是       | 是                |
| 工作日选择             | 是             | 是      | 是       | 是       | 是                |
| 月的第 N 个工作日       | 是             | 是      | 是       | 是       | 缺失              |
| 月的最后一天           | 是             | 是      | 是       | 是       | 缺失              |
| 在 N 次后结束           | 是             | 缺失    | 缺失     | 是       | 缺失              |
| 在日期结束             | 是             | 缺失    | 缺失     | 是       | 缺失              |
| 完成后重复             | 缺失           | 是      | 是       | 是       | 是                |
| 跳过实例               | 是             | 是      | 是       | 是       | 是                |
| 自然语言               | 是             | 是      | 缺失     | 缺失     | 缺失              |
| iCal 导出              | 是             | 是      | 缺失     | 是       | 缺失              |

---

## 4. 行业标准：RFC 5545 RRULE

**iCalendar 规范（RFC 5545）** 是定义重复模式最广泛采用的标准。**RRULE**（重复规则）属性是其核心机制。

### RRULE 核心组件

| 参数              | 说明             | 有效值                                     |
|------------------|-----------------|-------------------------------------------|
| **FREQ**（必需）   | 重复频率         | `YEARLY`、`MONTHLY`、`WEEKLY`、`DAILY`、`HOURLY`、`MINUTELY`、`SECONDLY` |
| **INTERVAL**     | 迭代间隔         | 任意正整数（默认：1）                         |
| **COUNT**        | 总重复次数       | 任意正整数                                   |
| **UNTIL**        | 结束日期/时间    | 日期时间值                                    |
| **BYDAY**        | 星期几           | `MO`、`TU`、`WE`、`TH`、`FR`、`SA`、`SU`（可加前缀 +n/-n） |
| **BYMONTHDAY**   | 月中的第几天     | 1–31 或 -1 至 -31（从月末倒数）              |
| **BYSETPOS**     | 按位置选择       | 正数或负数，从集合中选择第 N 个               |
| **WKST**         | 周起始日         | `MO`、`TU`、`WE`、`TH`、`FR`、`SA`、`SU`    |

### RRULE 示例

| 模式                                | RRULE                                   |
|-------------------------------------|-----------------------------------------|
| 每天                                | `FREQ=DAILY`                            |
| 每个工作日                          | `FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR`      |
| 每周一                              | `FREQ=WEEKLY;BYDAY=MO`                  |
| 每两周的周一和周三                   | `FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE`    |
| 每月 15 日                           | `FREQ=MONTHLY;BYMONTHDAY=15`            |
| 每月第二个星期二                     | `FREQ=MONTHLY;BYDAY=2TU`                |
| 每月最后一个星期五                   | `FREQ=MONTHLY;BYDAY=-1FR`               |
| 每年 3 月 15 日                      | `FREQ=YEARLY;BYMONTH=3;BYMONTHDAY=15`   |
| 每 2 年                              | `FREQ=YEARLY;INTERVAL=2`                |
| 重复 10 次后结束                     | `FREQ=WEEKLY;COUNT=10`                  |
| 2025 年 12 月 31 日前                | `FREQ=WEEKLY;UNTIL=20251231T235959Z`    |

---

## 5. 建议

### 建议 1：采用 RFC 5545 RRULE 作为重复数据格式

**优先级：高 | 工作量：中等**

当前格式不足以支持用户期望的重复模式。切换到 RFC 5545 RRULE（通过 [rrule.js](https://github.com/jakubroztocil/rrule)）将为所有高级模式提供标准化的实现方式。

**迁移策略：**

1. 向 `TaskRepeatCfg` 模型添加一个可选的 `rrule` 字段（字符串）
2. 保留现有字段以实现向后兼容
3. 编写双向转换器：旧格式 ↔ RRULE
4. 在保存时逐步迁移现有配置
5. 从手动转换器过渡到将 rrule.js 作为权威数据源

**示例双向转换：**

```typescript
// 旧格式 → RRULE
function toRRULE(cfg: TaskRepeatCfg): string {
  // 每日：FREQ=DAILY;INTERVAL=N
  // 每周：FREQ=WEEKLY;INTERVAL=N;BYDAY=MO,WE,FR
  // 每月：FREQ=MONTHLY;BYMONTHDAY=D
  // 年度：FREQ=YEARLY;BYMONTH=M;BYMONTHDAY=D
}

// RRULE → 旧格式
function fromRRULE(rrule: string): Partial<TaskRepeatCfg> {
  // 解析 RRULE 字符串并映射回旧字段
}
```

### 建议 2：添加结束条件

**优先级：高 | 工作量：中等**

添加两种结束重复的方式：

1. **在 N 次后结束**
   - UI：数字输入（"重复 ___ 次后结束"）
   - 存储：`COUNT=N` 参数

2. **在特定日期结束**
   - UI：日期选择器（"结束于 ___"）
   - 存储：`UNTIL=YYYYMMDD` 参数

### 建议 3：添加高级日期模式

**优先级：高 | 工作量：小到中等**

1. **月的第 N 个工作日** —— 例如"第二个星期二"
   - RRULE：`FREQ=MONTHLY;BYDAY=2TU`
   - UI：两个选择器 —— [第一/第二/第三/第四/最后一个] [周一/周二/...]

2. **月的最后一天 / 最后一个工作日** —— 例如"每个月的最后一个工作日"
   - RRULE：`FREQ=MONTHLY;BYMONTHDAY=-1` 或 `FREQ=MONTHLY;BYDAY=-1FR`
   - UI：可从月视图直观选择，或使用"最后一天/最后一个工作日"切换

3. **结束条件** —— "重复 10 次"或"截至 12 月 31 日"
   - RRULE：`COUNT=10` 或 `UNTIL=20251231T235959Z`

### 建议 4：改进快速设置 UI

**优先级：中等 | 工作量：低**

```typescript
// 推荐的快速设置
type TaskRepeatCfgQuickSettingV2 =
  | '\''DAILY'\''
  | '\''WEEKDAYS'\''                    // 周一至周五
  | '\''WEEKLY_SAME_DAY'\''             // 每[当前工作日]
  | '\''BIWEEKLY_SAME_DAY'\''           // 每两周
  | '\''MONTHLY_SAME_DATE'\''           // 每月同一天
  | '\''MONTHLY_SAME_WEEKDAY'\''        // 例如"第三个星期三"（新增）
  | '\''MONTHLY_LAST_DAY'\''            // 每月最后一天（新增）
  | '\''MONTHLY_LAST_WEEKDAY'\''        // 每月最后一个[当前工作日]（新增）
  | '\''YEARLY_SAME_DATE'\''
  | '\''CUSTOM'\'';
```

### 建议 5：保留"完成后重复"模式

**优先级：中等 | 工作量：不适用（已实现）**

这是一个**竞争优势**。RFC 5545 不支持此功能，但 Todoist、Things 和 TickTick 都支持。保留 `repeatFromCompletionDate` 标志作为 Super Productivity 的扩展。

---

## 6. 实施路线图

### 第一阶段：基础（低风险）
1. 添加 `rrule` 依赖
2. 创建具有夏令时安全处理的 rrule.js 工具包装器
3. 向 `TaskRepeatCfg` 模型添加 `rrule` 字段（保留旧字段）
4. 编写双向转换：旧格式 ↔ RRULE 字符串
5. 更新 `getNextRepeatOccurrence()`，在 `rrule` 字段存在时使用 rrule.js

### 第二阶段：新模式（中等风险）
1. 更新 UI 以支持新模式（第 N 个工作日、最后一天等）
2. 在 UI 中添加结束条件（COUNT、UNTIL）
3. 添加新的快速设置
4. 在保存时将现有配置迁移到 RRULE 格式

### 第三阶段：完善（低风险）
1. 添加自然语言显示："每第二个星期二重复"
2. 改进热力图，展示预计的未来重复实例
3. 考虑为日历集成添加 iCal 导出

### 第四阶段：高级（高风险，可选）
1. 单个实例修改
2. "本次及以后"的更改
3. 带重复功能的 iCal 导入

---

## 7. RRULE 映射示例

| 用户要求                       | 当前 SP            | RRULE                               |
|-------------------------------|-------------------|-------------------------------------|
| 每天                           | `DAILY`，every=1   | `FREQ=DAILY`                        |
| 每 3 天                        | `DAILY`，every=3   | `FREQ=DAILY;INTERVAL=3`             |
| 每周一                         | `WEEKLY`，mon=true | `FREQ=WEEKLY;BYDAY=MO`              |
| 每两周的周一和周三              | `WEEKLY`，every=2, mon=true, wed=true | `FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE` |
| 每月 15 日                     | `MONTHLY`，every=1 | `FREQ=MONTHLY;BYMONTHDAY=15`        |
| **每月第二个星期二**            | 不可实现           | `FREQ=MONTHLY;BYDAY=2TU`            |
| **每月最后一个星期五**          | 不可实现           | `FREQ=MONTHLY;BYDAY=-1FR`           |
| **每月最后一天**                | 不可实现           | `FREQ=MONTHLY;BYMONTHDAY=-1`        |
| 每年 3 月 15 日                 | `YEARLY`，every=1  | `FREQ=YEARLY;BYMONTH=3;BYMONTHDAY=15` |
| **重复 10 次后停止**            | 不可实现           | `FREQ=WEEKLY;COUNT=10`              |
| **截至 2025 年 12 月 31 日**    | 不可实现           | `FREQ=WEEKLY;UNTIL=20251231`        |

---

## 8. 库对比

| 标准           | rrule.js    | rSchedule | later.js |
|---------------|-------------|-----------|----------|
| **RFC 5545 合规性** | 高          | 部分      | 否       |
| **打包大小**       | ~5KB gzip   | 更小      | ~8KB     |
| **TypeScript**    | 是          | 原生      | 社区     |
| **时区支持**       | 有缺陷      | 优秀      | 基础     |
| **自然语言支持**   | 是          | 否        | 是       |
| **积极维护**       | 较慢        | 是        | 仅分支   |
| **GitHub Stars**  | 3.7k        | 43        | 1.7k     |

**建议：** 使用 rrule.js 以获得 RFC 5545 合规性和社区支持。需谨慎包装时区处理逻辑。

---

## 9. 当前实现中的关键文件

| 功能             | 文件                                                          |
|-----------------|--------------------------------------------------------------|
| 任务日期属性      | `src/app/features/tasks/task.model.ts`                        |
| 重复配置模型      | `src/app/features/task-repeat-cfg/task-repeat-cfg.model.ts`   |
| 重复计算          | `src/app/features/task-repeat-cfg/store/get-next-repeat-occurrence.util.ts` |
| 重复选择器        | `src/app/features/task-repeat-cfg/store/task-repeat-cfg.selectors.ts`        |
| 重复服务          | `src/app/features/task-repeat-cfg/task-repeat-cfg.service.ts`                |
| 对话框 UI         | `src/app/features/task-repeat-cfg/dialog-edit-task-repeat-cfg/`             |
| 日程集成          | `src/app/features/schedule/schedule.service.ts`                             |
| 计划器集成        | `src/app/features/planner/planner.service.ts`                              |

---

## 结论

Super Productivity 的重复任务系统拥有坚实的基础（同步安全性、夏令时处理），但使用了功能有限的自定义格式。采用 RFC 5545 RRULE——同时保留 `repeatFromCompletionDate` 扩展——将带来以下好处：

1. **启用常用请求模式**（第 N 个工作日、最后一天、结束条件）
2. **减少维护负担**，利用经过实战检验的库
3. **启用未来的 iCal 集成**，实现日历同步
4. **与行业标准对齐**，与 Google、Microsoft、Apple 保持一致

推荐的方法是渐进式的：在保留现有字段的同时添加 RRULE 支持，逐步迁移，并保持向后兼容。
