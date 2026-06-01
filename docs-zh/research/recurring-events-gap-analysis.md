# 重复事件差距分析

## 当前 Super Productivity 实现

### 数据模型：TaskRepeatCfg

位于 `src/app/features/task-repeat-cfg/task-repeat-cfg.model.ts`

```typescript
interface TaskRepeatCfg {
  id: string;
  projectId: string | null;
  title: string | null;
  tagIds: string[];

  // 重复模式
  repeatCycle: 'DAILY' | 'WEEKLY' | 'MONTHLY' | 'YEARLY';
  repeatEvery: number;  // 间隔（每 N 天/周/等）
  startDate?: string;   // YYYY-MM-DD

  // 每周：哪些天
  monday?: boolean;
  tuesday?: boolean;
  wednesday?: boolean;
  thursday?: boolean;
  friday?: boolean;
  saturday?: boolean;
  sunday?: boolean;

  // 控制
  isPaused: boolean;
  repeatFromCompletionDate?: boolean;

  // 实例追踪
  lastTaskCreationDay?: string;
  deletedInstanceDates?: string[];  // 跳过的发生

  // 任务模板
  defaultEstimate?: number;
  startTime?: string;
  remindAt?: TaskReminderOptionId;
  notes?: string;
  subTaskTemplates?: SubTaskTemplate[];
}
```

### 运行良好的部分

| 功能 | 实现 | 备注 |
|---------|---------------|-------|
| 基本周期 | `repeatCycle` 枚举 | DAILY、WEEKLY、MONTHLY、YEARLY |
| 间隔 | `repeatEvery: number` | 每 2 天、每 3 周等 |
| 工作日选择 | 7 个布尔字段 | 用于每周重复 |
| 跳过发生 | `deletedInstanceDates[]` | 相当于 EXDATE |
| 基于完成 | `repeatFromCompletionDate` | 独特优势 |
| 暂停/恢复 | `isPaused` | 简单的开关 |
| 子任务模板 | `subTaskTemplates[]` | 强大功能 |
| DST 安全 | 基于正午的计算 | 避免边界情况 |
| 同步安全 | 确定性 ID | `rpt_${cfgId}_${day}` |

### 架构优势

1. **关注点分离** —— `TaskRepeatCfg` 独立于 `Task`，作为模板
2. **投影系统** —— 在日程中显示未来的发生，而不创建实际任务
3. **确定性 ID** —— 多设备同步创建相同的任务 ID，防止重复
4. **DST 处理** —— 所有日期计算使用正午（12:00）
---

## 差距分析：缺失的模式

### 关键差距（高用户影响）

| 模式 | 示例用例 | RFC 5545 | 当前 SP |
|---------|------------------|----------|------------|
| 月份的第 N 个工作日 | "团队会议，每月的第二个星期二" | `BYDAY=2TU` | 缺失 |
| 月份的最后一个工作日 | "报告截止日期为最后一个星期五" | `BYDAY=-1FR` | 缺失 |
| 月份的最后一天 | "最后一天付房租" | `BYMONTHDAY=-1` | 缺失 |
| N 次后结束 | "重复 10 次后停止" | `COUNT=10` | 缺失 |
| 在日期结束 | "直到 2025 年 12 月 31 日" | `UNTIL=20251231` | 缺失 |

### 中等差距

| 模式 | 示例用例 | RFC 5545 | 当前 SP |
|---------|------------------|----------|------------|
| 每月多天 | "每月 1 日和 15 日" | `BYMONTHDAY=1,15` | 缺失 |
| 最后一个工作日（营业） | "最后一个营业日" | `BYSETPOS=-1` | 缺失 |
| 年的特定周 | "第 1 周和第 26 周" | `BYWEEKNO=1,26` | 缺失 |

### 低优先级差距

| 模式 | 示例用例 | RFC 5545 | 当前 SP |
|---------|------------------|----------|------------|
| 年的第几天 | "一年的第 100 天" | `BYYEARDAY=100` | 缺失 |
| 每小时/每分钟 | "每 30 分钟" | `FREQ=MINUTELY` | 缺失 |
| 秒精度 | 亚分钟调度 | `FREQ=SECONDLY` | 缺失 |

### 异常处理差距

| 功能 | RFC 5545 | 当前 SP |
|---------|----------|------------|
| 跳过发生 | `EXDATE` | 存在——`deletedInstanceDates` |
| 添加额外发生 | `RDATE` | 缺失 |
| 修改单个实例 | `RECURRENCE-ID` | 缺失 |
| "本次及以后" | `RANGE=THISANDFUTURE` | 缺失 |
---

## 与主要应用的比较

### 功能矩阵

| 功能 | Google Cal | Outlook | Todoist | Things 3 | TickTick | SP |
|---------|------------|---------|---------|----------|----------|-----|
| 每日 | 是 | 是 | 是 | 是 | 是 | 是 |
| 每周 | 是 | 是 | 是 | 是 | 是 | 是 |
| 每月 | 是 | 是 | 是 | 是 | 是 | 是 |
| 每年 | 是 | 是 | 是 | 是 | 是 | 是 |
| 每 N 间隔 | 是 | 是 | 是 | 是 | 是 | 是 |
| 工作日选择 | 是 | 是 | 是 | 是 | 是 | 是 |
| 第 N 个工作日 | 是 | 是 | 是 | 是 | 是 | 缺失 |
| 月份最后一天 | 是 | 是 | 是 | 是 | 是 | 缺失 |
| N 次后结束 | 是 | 是 | 缺失 | 缺失 | 是 | 缺失 |
| 在日期结束 | 是 | 是 | 缺失 | 缺失 | 是 | 缺失 |
| 完成后 | 缺失 | 缺失 | 是 | 是 | 是 | 是 |
| 跳过发生 | 是 | 是 | 是 | 是 | 是 | 是 |
| 修改实例 | 是 | 是 | 缺失 | 缺失 | 缺失 | 缺失 |
| 自然语言 | 是 | 是 | 是 | 缺失 | 缺失 | 缺失 |
| iCal 导出 | 是 | 是 | 是 | 缺失 | 是 | 缺失 |

### 关键观察

1. **SP 在基础功能上具有竞争力** —— 覆盖了大多数任务应用的功能
2. **日历应用更完整** —— Google/Outlook 拥有完整的 RFC 5545
3. **"完成后"是差异化优势** —— Google/Outlook 缺乏此功能
4. **第 N 个工作日是基本要求** —— 所有竞品都具备
---

## 根本原因：自定义格式的限制

### 当前格式的问题

```typescript
// 问题 1：无法表达"第二个星期二"
// 没有工作日序数位置字段

// 问题 2：无法表达"最后一天"
// MONTHLY 假设相同的日期数字，不支持负索引

// 问题 3：没有结束条件
// 默认永远重复，没有 COUNT 或 UNTIL

// 问题 4：工作日的布尔字段无法扩展
// 添加 BYMONTHDAY 需要再增加 31 个布尔值
```

### 为什么 RRULE 更好

```
// 单字符串编码复杂模式：

"FREQ=MONTHLY;BYDAY=2TU"           # 第二个星期二
"FREQ=MONTHLY;BYMONTHDAY=-1"       # 最后一天
"FREQ=WEEKLY;COUNT=10"             # 重复 10 次
"FREQ=MONTHLY;BYDAY=-1FR;UNTIL=20251231"  # 最后一个星期五，直到 2025 年 12 月
```
---

## 影响评估

### 用户请求（从行业模式推断）

| 请求 | 频率 | 当前回答 |
|---------|-----------|----------------|
| "每月的第二个星期二" | 非常常见 | "不支持" |
| "月份的最后一天" | 常见 | "使用 28 日/30 日/31 日" |
| "重复 10 次" | 常见 | "之后手动删除" |
| "直到项目结束" | 常见 | "手动暂停" |

### 技术债务

| 问题 | 影响 |
|-------|--------|
| 自定义计算逻辑 | 高维护负担 |
| 未利用库 | 重复造轮子 |
| 无 iCal 兼容性 | 无法导入/导出 |
| 硬编码模式 | 每个新模式 = 代码更改 |

---

## 结论

Super Productivity 的重复任务系统**功能但有限**。自定义数据模型适用于基本模式，但无法表达用户的常见需求。差距不在于架构（架构很扎实），而在于**重复模式表达能力**。

采用 RFC 5545 RRULE 格式将：
- 通过一次更改填补所有关键差距
- 支持使用库（rrule.js）
- 为未来 iCal 集成做好准备
- 减少自定义代码维护