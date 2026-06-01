# 重复事件实施计划

## 概述

本计划概述了如何将 Super Productivity 的重复任务系统从自定义格式升级到 RFC 5545 RRULE，同时保持向后兼容性并保留"完成后调度"等独特功能。

---

## 提议的数据模型

### 新的 TaskRepeatCfg 结构

```typescript
interface TaskRepeatCfgV2 {
  // 标识
  id: string;
  projectId: string | null;
  title: string | null;
  tagIds: string[];

  // === 新增：RFC 5545 RRULE ===
  rrule?: string;  // 例如："FREQ=MONTHLY;BYDAY=2TU;COUNT=12"

  // === 已弃用：保留用于迁移 ===
  repeatCycle?: 'DAILY' | 'WEEKLY' | 'MONTHLY' | 'YEARLY';
  repeatEvery?: number;
  monday?: boolean;
  tuesday?: boolean;
  wednesday?: boolean;
  thursday?: boolean;
  friday?: boolean;
  saturday?: boolean;
  sunday?: boolean;
  startDate?: string;

  // === SP 特定扩展 ===
  repeatFromCompletionDate?: boolean;  // RFC 5545 中没有
  isPaused: boolean;

  // === 异常处理 ===
  exdates?: string[];  // 从 deletedInstanceDates 重命名
  rdates?: string[];   // 新增：额外的发生

  // === 结束条件（从 RRULE 提取用于 UI） ===
  endType?: 'never' | 'count' | 'until';
  endCount?: number;
  endDate?: string;

  // === 任务模板（未更改） ===
  defaultEstimate?: number;
  startTime?: string;
  remindAt?: TaskReminderOptionId;
  notes?: string;
  subTaskTemplates?: SubTaskTemplate[];

  // === 追踪（未更改） ===
  lastTaskCreationDay?: string;
  lastTaskCreation?: number;  // 旧版
}
```

### 关键设计决策

1. **RRULE 作为主要格式** —— 当存在 `rrule` 字段时使用它；否则回退到旧版字段
2. **保留 SP 扩展** —— `repeatFromCompletionDate` 保持独立（无法在 RRULE 中表达）
3. **提取结束条件** —— 存储 `endType`/`endCount`/`endDate` 方便 UI 使用，同步到 RRULE
4. **为重命名清晰** —— `deletedInstanceDates` -> `exdates`（匹配 RFC 5545）
---

## 阶段 1：基础

**目标：** 添加 RRULE 支持，不破坏现有功能

### 1.1 添加 rrule.js 依赖

```bash
npm install rrule
```

**包体积影响：** ~5KB gzipped

### 1.2 创建 RRULE 工具包装器

创建 `src/app/features/task-repeat-cfg/rrule-utils.ts`：

```typescript
import { RRule, RRuleSet, Frequency } from 'rrule';
import { dateStrToUtcDate } from '../../util/date-str-to-utc-date';

/**
 * DST 安全的 rrule.js 包装器
 * 使用正午时间以避免夏令时边界情况
 */
export function getNextOccurrenceFromRRule(
  rruleString: string,
  afterDate: Date,
  exdates: string[] = []
): Date | null {
  const rruleSet = new RRuleSet();

  // 解析 RRULE
  const rule = RRule.fromString(rruleString);
  rruleSet.rrule(rule);

  // 添加异常
  for (const exdate of exdates) {
    rruleSet.exdate(dateStrToUtcDate(exdate));
  }

  // 获取给定日期之后的下一次发生
  const next = rruleSet.after(afterDate, false);
  return next;
}

export function getAllOccurrencesInRange(
  rruleString: string,
  startDate: Date,
  endDate: Date,
  exdates: string[] = []
): Date[] {
  const rruleSet = new RRuleSet();
  const rule = RRule.fromString(rruleString);
  rruleSet.rrule(rule);

  for (const exdate of exdates) {
    rruleSet.exdate(dateStrToUtcDate(exdate));
  }

  return rruleSet.between(startDate, endDate, true);
}

export function rruleToHumanText(rruleString: string): string {
  try {
    const rule = RRule.fromString(rruleString);
    return rule.toText();
  } catch {
    return '自定义日程';
  }
}
```

### 1.3 创建旧版到 RRULE 的转换器

创建 `src/app/features/task-repeat-cfg/rrule-migration.ts`：

```typescript
import { RRule, Frequency, Weekday } from 'rrule';
import { TaskRepeatCfg } from './task-repeat-cfg.model';

const WEEKDAY_MAP = {
  monday: RRule.MO,
  tuesday: RRule.TU,
  wednesday: RRule.WE,
  thursday: RRule.TH,
  friday: RRule.FR,
  saturday: RRule.SA,
  sunday: RRule.SU,
};

const FREQ_MAP = {
  'DAILY': Frequency.DAILY,
  'WEEKLY': Frequency.WEEKLY,
  'MONTHLY': Frequency.MONTHLY,
  'YEARLY': Frequency.YEARLY,
};

export function legacyToRRule(cfg: TaskRepeatCfg): string {
  const options: Partial<RRule.Options> = {
    freq: FREQ_MAP[cfg.repeatCycle],
    interval: cfg.repeatEvery || 1,
  };

  // 如果可用，添加 DTSTART
  if (cfg.startDate) {
    options.dtstart = new Date(cfg.startDate + 'T12:00:00');
  }

  // 为每周添加 BYDAY
  if (cfg.repeatCycle === 'WEEKLY') {
    const byweekday: Weekday[] = [];
    for (const [key, rruleDay] of Object.entries(WEEKDAY_MAP)) {
      if (cfg[key as keyof TaskRepeatCfg]) {
        byweekday.push(rruleDay);
      }
    }
    if (byweekday.length > 0) {
      options.byweekday = byweekday;
    }
  }

  const rule = new RRule(options);
  return rule.toString();
}
### 1.4 更新获取下一次发生

```typescript
// 在 task-repeat-cfg.service.ts 或 get-next-repeat-occurrence.util.ts 中

function getNextOccurrence(cfg: TaskRepeatCfg, fromDate: Date): Date | null {
  // 如果存在 RRULE，使用它
  if (cfg.rrule) {
    return getNextOccurrenceFromRRule(
      cfg.rrule,
      fromDate,
      cfg.exdates ?? cfg.deletedInstanceDates
    );
  }

  // 否则，使用旧版逻辑
  return getLegacyNextOccurrence(cfg, fromDate);
}
```

---

## 阶段 2：新的重复模式

**目标：** 添加 UI 以创建第 N 个工作日、最后一天和结束条件

### 2.1 更新的重复对话框 UI

```typescript
// 新的用户可选模式
type RepeatPatternType =
  | 'every_n_days'
  | 'every_weekday'           // 周一至周五
  | 'every_n_weeks'
  | 'every_n_months'
  | 'nth_weekday_of_month'    // 新增：例如第二个星期二
  | 'last_day_of_month'       // 新增
  | 'last_weekday_of_month'   // 新增
  | 'every_n_years'
  | 'custom_rrule';           // 新增：高级 RRULE 输入
```

### 2.2 UI 组件变更

对话框需要更新以显示新选项：

```html
<!-- 新增：第 N 个工作日的选择器 -->
<mat-form-field *ngIf="patternType === 'nth_weekday_of_month'">
  <mat-label>工作日序数</mat-label>
  <mat-select [(ngModel)]="weekdayOrdinal">
    <mat-option [value]="1">第一个</mat-option>
    <mat-option [value]="2">第二个</mat-option>
    <mat-option [value]="3">第三个</mat-option>
    <mat-option [value]="4">第四个</mat-option>
    <mat-option [value]="-1">最后一个</mat-option>
  </mat-select>
</mat-form-field>

<!-- 新增：结束条件 -->
<mat-radio-group [(ngModel)]="endType">
  <mat-radio-button value="never">永远重复</mat-radio-button>
  <mat-radio-button value="count">在以下次数后结束：</mat-radio-button>
  <mat-radio-button value="until">在以下日期结束：</mat-radio-button>
</mat-radio-group>

<input *ngIf="endType === 'count'" type="number" [(ngModel)]="endCount" min="1" />
<input *ngIf="endType === 'until'" type="date" [(ngModel)]="endDate" />
```

### 2.3 从 UI 生成 RRULE

```typescript
function generateRRuleFromForm(form: RepeatFormData): string {
  const parts: string[] = [];

  switch (form.patternType) {
    case 'nth_weekday_of_month': {
      const weekdayCode = ['SU','MO','TU','WE','TH','FR','SA'][form.weekday];
      parts.push('FREQ=MONTHLY', `BYDAY=${form.weekdayOrdinal}${weekdayCode}`);
      break;
    }
    case 'last_day_of_month': {
      parts.push('FREQ=MONTHLY', 'BYMONTHDAY=-1');
      break;
    }
    // ... 其他情况
  }

  if (form.endType === 'count') {
    parts.push(`COUNT=${form.endCount}`);
  } else if (form.endType === 'until') {
    parts.push(`UNTIL=${form.endDate.replace(/-/g, '')}T235959Z`);
  }

  return parts.join(';');
}
```