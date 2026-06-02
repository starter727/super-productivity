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
  rrule?: string; // 例如："FREQ=MONTHLY;BYDAY=2TU;COUNT=12"

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
  repeatFromCompletionDate?: boolean; // RFC 5545 中没有
  isPaused: boolean;

  // === 异常处理 ===
  exdates?: string[]; // 从 deletedInstanceDates 重命名
  rdates?: string[]; // 新增：额外的发生

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
  lastTaskCreation?: number; // 旧版
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
  exdates: string[] = [],
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
  exdates: string[] = [],
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

````typescript
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
````

---

## 阶段 2：新的重复模式

**目标：** 添加 UI 以创建第 N 个工作日、最后一天和结束条件

### 2.1 更新的重复对话框 UI

```typescript
// 新的用户可选模式
type RepeatPatternType =
  | 'every_n_days'
  | 'every_weekday' // 周一至周五
  | 'every_n_weeks'
  | 'every_n_months'
  | 'nth_weekday_of_month' // 新增：例如第二个星期二
  | 'last_day_of_month' // 新增
  | 'last_weekday_of_month' // 新增
  | 'every_n_years'
  | 'custom_rrule'; // 新增：高级 RRULE 输入
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

<input
  *ngIf="endType === 'count'"
  type="number"
  [(ngModel)]="endCount"
  min="1"
/>
<input
  *ngIf="endType === 'until'"
  type="date"
  [(ngModel)]="endDate"
/>
```

### 2.3 从 UI 生成 RRULE

```typescript
function generateRRuleFromForm(form: RepeatFormData): string {
  const parts: string[] = [];

  switch (form.patternType) {
    case 'nth_weekday_of_month': {
      const weekdayCode = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'][form.weekday];
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

---

## 阶段 3：迁移

**目标：** 将现有配置转换为 RRULE 格式

### 3.1 迁移函数

```typescript
export function migrateTaskRepeatCfgToRRule(cfg: TaskRepeatCfg): TaskRepeatCfg {
  // 如果已有 RRULE，跳过
  if (cfg.rrule) {
    return cfg;
  }

  // 将旧版转换为 RRULE
  const rrule = legacyToRRule(cfg);

  return {
    ...cfg,
    rrule,
    exdates: cfg.deletedInstanceDates || [],
  };
}
```

### 3.2 迁移策略

**方案 A：惰性迁移（推荐）**

- 保存时转换：用户编辑重复配置时，保存为 RRULE 格式
- 渐进式：旧配置在被编辑前正常工作
- 低风险：无需批量迁移

**方案 B：批量迁移**

- 应用启动时运行迁移
- 一次性转换所有配置
- 风险较高：需要全面测试

### 3.3 服务中的版本检查

```typescript
// 在 task-repeat-cfg.service.ts 中
updateTaskRepeatCfg(id: string, changes: Partial<TaskRepeatCfg>) {
  // 如果使用新字段，确保设置 RRULE
  if (changes.endType || changes.endCount || changes.endDate) {
    changes = this.ensureRRuleFormat(changes);
  }
  // ... dispatch update
}
```

---

## 阶段 4：完善

### 4.1 自然语言显示

在 UI 中显示人类可读的文本：

```typescript
// 在组件中
get repeatDescription(): string {
  if (this.repeatCfg.rrule) {
    return rruleToHumanText(this.repeatCfg.rrule);
    // 返回："每月的第二个星期二"或"每月的最后一天"
  }
  return this.getLegacyDescription();
}
```

### 4.2 热力图改进

更新热力图以显示预计的未来发生：

```typescript
// 获取未来 12 个月的预计日期
const projectedDates = getAllOccurrencesInRange(
  cfg.rrule,
  new Date(),
  addMonths(new Date(), 12),
  cfg.exdates,
);
```

### 4.3 iCal 导出（未来）

```typescript
export function taskRepeatCfgToICalEvent(cfg: TaskRepeatCfg): string {
  return `BEGIN:VEVENT
SUMMARY:${cfg.title}
RRULE:${cfg.rrule}
${cfg.exdates?.map((d) => `EXDATE:${d}`).join('\n') || ''}
END:VEVENT`;
}
```

---

## 测试策略

### 单元测试

```typescript
describe('RRULE 工具', () => {
  it('应计算每月的第二个星期二', () => {
    const rrule = 'FREQ=MONTHLY;BYDAY=2TU';
    const result = getNextOccurrenceFromRRule(rrule, new Date('2024-01-01'));
    expect(result).toEqual(new Date('2024-01-09T12:00:00'));
  });

  it('应计算每月的最后一天', () => {
    const rrule = 'FREQ=MONTHLY;BYMONTHDAY=-1';
    const result = getNextOccurrenceFromRRule(rrule, new Date('2024-02-01'));
    expect(result).toEqual(new Date('2024-02-29T12:00:00')); // 闰年
  });

  it('应遵守 EXDATE', () => {
    const rrule = 'FREQ=WEEKLY;BYDAY=MO';
    const result = getNextOccurrenceFromRRule(rrule, new Date('2024-01-01'), [
      '2024-01-08',
    ]);
    expect(result).toEqual(new Date('2024-01-15T12:00:00'));
  });
});
```

### 夏令时边界情况

```typescript
describe('DST 处理', () => {
  it('应处理春季向前调整', () => {
    const rrule = 'FREQ=DAILY';
    const march9 = new Date('2024-03-09T12:00:00');
    const result = getNextOccurrenceFromRRule(rrule, march9);
    // 仍应为本地时间正午
  });

  it('应处理秋季向后调整', () => {
    const rrule = 'FREQ=DAILY';
    const nov2 = new Date('2024-11-02T12:00:00');
    const result = getNextOccurrenceFromRRule(rrule, nov2);
    // 仍应为本地时间正午
  });
});
```

### 迁移测试

```typescript
describe('旧版迁移', () => {
  it('应将每周带工作日的配置转换为 RRULE', () => {
    const legacy: TaskRepeatCfg = {
      repeatCycle: 'WEEKLY',
      repeatEvery: 2,
      monday: true,
      friday: true,
    };
    const rrule = legacyToRRule(legacy);
    expect(rrule).toBe('FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,FR');
  });
});
```

---

## 风险缓解

| 风险              | 缓解措施                                |
| ----------------- | --------------------------------------- |
| rrule.js 时区 bug | 包装在 DST 安全的工具中，广泛测试       |
| 破坏现有配置      | 保留旧版字段，惰性迁移                  |
| UI 复杂性         | 将高级选项隐藏在"自定义"后面            |
| 包体积增加        | rrule.js 仅约 5KB gzipped               |
| 同步问题          | RRULE 是字符串 — 像任何其他字段一样同步 |

---

## 时间线估算

| 阶段           | 工作量 | 依赖   |
| -------------- | ------ | ------ |
| 阶段 1：基础   | 2-3 天 | 无     |
| 阶段 2：新模式 | 3-5 天 | 阶段 1 |
| 阶段 3：迁移   | 1-2 天 | 阶段 1 |
| 阶段 4：完善   | 2-3 天 | 阶段 2 |

**总计：8-13 天**的专注开发

---

## 成功标准

1. 所有现有的重复配置继续工作
2. 用户可以创建"每月第二个星期二"模式
3. 用户可以创建"每月最后一天"模式
4. 用户可以设置"重复 10 次"结束条件
5. "完成后调度"模式仍然有效
6. 无 DST 相关 bug
7. 跨设备同步正常工作
8. UI 显示人类可读的描述
