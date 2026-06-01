# 日程导航周范围表头实现计划

> **给 Claude：** 必需的子技能：使用 superpowers:executing-plans 按任务逐步实施此计划。

**目标：** 在日程导航中添加 第 N 周 · 4月20日 – 4月26日 / 2026年4月 标题，将周视图对齐到日历周，将"今天"操作移至左侧图标按钮，并压平导航行使其与粘性表头融合。

**架构：** ScheduleComponent 中一个 headerTitle 计算信号（computed signal）为两种视图提供标签。ScheduleService 中的 getDaysToShow 增加 irstDayOfWeek 参数，并将起始日期对齐到前一个周首日。ISO 周号使用现有的 getWeekNumber 工具函数。schedule-month.component 内的独立月表头被删除——共享导航拥有标签。

**技术栈：** Angular 独立组件（standalone components）、Angular 信号（signals）、localeDate 管道、
gx-translate。

---

## 任务 1：添加翻译键（WEEK_LABEL, TODAY）

**文件：**
- 修改：src/assets/i18n/en.json（插入到 F.SCHEDULE 块内，约第 960-975 行）
- 修改：src/app/t.const.ts（插入到 F.SCHEDULE 内，约第 981-990 行）

**步骤 1：** 在 en.json 的 F.SCHEDULE 下添加两个键。保持块内字母顺序。

`json
"TODAY": "Today",
"WEEK_LABEL": "Week {{nr}}"
`

最终块（约第 965-975 行）应如下所示：

`json
"END": "Work End",
"INSERT_BEFORE": "Before",
"LUNCH_BREAK": "Lunch Break",
"MONTH": "Month",
"NO_TASKS": "...",
"NOW": "Now",
"PLAN_END_DAY": "End of {{date}}",
"PLAN_START_DAY": "Start of {{date}}",
"SHIFT_KEY_INFO": "Hold Shift to toggle day planning mode",
"START": "Work Start",
"TODAY": "Today",
"WEEK_LABEL": "Week {{nr}}"
`

**步骤 2：** 在 	.const.ts 的 SCHEDULE 对象下添加对应条目（按字母顺序）：

`	s
TODAY: 'F.SCHEDULE.TODAY',
WEEK_LABEL: 'F.SCHEDULE.WEEK_LABEL',
`

**步骤 3：** 验证：

`ash
npm run checkFile src/app/t.const.ts
`

**步骤 4：** 提交：

`ash
git add src/assets/i18n/en.json src/app/t.const.ts
git commit -m "feat(schedule): add i18n keys for week-label and today button"
`

---

## 任务 2：在 getDaysToShow 中将周视图对齐到日历周

**文件：**
- 修改：src/app/features/schedule/schedule.service.ts:143-151
- 修改：src/app/features/schedule/schedule.service.spec.ts:52-139

**步骤 1：首先更新会失败的测试**（TDD）。编辑 schedule.service.spec.ts ——用新的对齐期望替换现有的 describe('getDaysToShow', ...) 块（第 52-140 行）：

`	s
describe('getDaysToShow', () => {
  it('should return the requested number of days', () => {
    const result = service.getDaysToShow(5, null, 1);
    expect(result.length).toBe(5);
  });

  it('should snap 7-day range to start on firstDayOfWeek (Monday)', () => {
    // Wed Jun 17, 2026 是星期三 → 对齐到周一 6月15日
    const referenceDate = new Date(2026, 5, 17);
    const result = service.getDaysToShow(7, referenceDate, 1);
    expect(result.length).toBe(7);
    const [y, m, d] = result[0].split('-').map(Number);
    expect(new Date(y, m - 1, d).getDay()).toBe(1); // 周一
  });

  it('should snap 7-day range to start on firstDayOfWeek (Sunday)', () => {
    const referenceDate = new Date(2026, 5, 17); // 周三
    const result = service.getDaysToShow(7, referenceDate, 0);
    const [y, m, d] = result[0].split('-').map(Number);
    expect(new Date(y, m - 1, d).getDay()).toBe(0); // 周日
  });

  it('should not snap when day count is less than 7', () => {
    // 响应式移动模式显示较少天数；保持当前行为
    const referenceDate = new Date(2028, 5, 15);
    const result = service.getDaysToShow(3, referenceDate, 1);
    const expectedFirstDay = dateService.todayStr(referenceDate.getTime());
    expect(result[0]).toBe(expectedFirstDay);
    expect(result.length).toBe(3);
  });

  it('should return consecutive days', () => {
    const result = service.getDaysToShow(7, new Date(2028, 0, 20), 1);
    for (let i = 0; i < result.length - 1; i++) {
      const cur = new Date(result[i]);
      const nxt = new Date(result[i + 1]);
      expect((nxt.getTime() - cur.getTime()) / 86_400_000).toBe(1);
    }
  });

  it('should use today when referenceDate is null', () => {
    const result = service.getDaysToShow(3, null, 1);
    expect(result[0]).toBe(dateService.todayStr());
  });
});
`

**步骤 2：运行测试**（应失败，因为签名/行为不匹配）：

`ash
npm run test:file src/app/features/schedule/schedule.service.spec.ts
`
预期：编译错误或断言失败，引用 getDaysToShow。

**步骤 3：更新实现** 在 schedule.service.ts：

`	s
getDaysToShow(
  nrOfDaysToShow: number,
  referenceDate: Date | null = null,
  firstDayOfWeek: number = 0,
): string[] {
  const baseTime = referenceDate ? referenceDate.getTime() : Date.now();
  // 对齐：当显示整周时，将起始日期对齐到周首日
  const effectiveStart = nrOfDaysToShow >= 7
    ? getStartOfWeek(new Date(baseTime), firstDayOfWeek)
    : new Date(baseTime);
  const days: string[] = [];
  for (let i = 0; i < nrOfDaysToShow; i++) {
    const d = new Date(effectiveStart);
    d.setDate(effectiveStart.getDate() + i);
    days.push(dateService.todayStr(d.getTime()));
  }
  return days;
}
`

**步骤 4：重新运行测试**（应全部通过）：

`ash
npm run test:file src/app/features/schedule/schedule.service.spec.ts
`

**步骤 5：** 提交：

`ash
git add src/app/features/schedule/schedule.service.ts src/app/features/schedule/schedule.service.spec.ts
git commit -m "feat(schedule): snap week view to calendar-aligned weeks"
`

---

## 任务 3：添加 headerTitle 计算信号

**文件：**
- 新建：src/app/features/schedule/schedule-header-title.util.ts
- 修改：src/app/features/schedule/schedule/schedule.component.ts:16-45

**步骤 1：** 新建工具文件：

`	s
// schedule-header-title.util.ts
export interface HeaderTitleConfig {
  days: string[];
  weekNumber: number;
  view: ScheduleView;
  dateFormat: 'week' | 'month';
}

export function computeHeaderTitle(cfg: HeaderTitleConfig): string {
  // ... 合并周号、日期范围或月份名称
}
`

**步骤 2：** 在 schedule.component.ts 中添加信号：

`	s
readonly headerTitle = computed(() => {
  const view = this.view();
  const days = this.scheduleService.daysList();
  // ... 委托给工具函数
});
`

**步骤 3：** Lint：

`ash
npm run checkFile src/app/features/schedule/schedule/schedule.component.ts
`

**步骤 4：** 提交：

`ash
git add src/app/features/schedule/schedule-header-title.util.ts src/app/features/schedule/schedule/schedule.component.ts
git commit -m "feat(schedule): add headerTitle computed signal"
`

---

## 任务 4：移除 ISO 周号重复

## 任务 5：在导航中显示标题，将"今天"移至左侧

**文件：**
- 修改：src/app/features/schedule/schedule/schedule.component.html:1-10
- 修改：src/app/features/schedule/schedule/schedule.component.ts:48-62

**步骤 1：** 替换模板中的导航行，使用 headerTitle 替代简单的"今天/周"标签：

`html
<header>
  <div class="schedule-nav-controls">
    <button class="today-btn" (click)="goToToday()" [disabled]="isTodayInView()">
      <mat-icon>today</mat-icon>
    </button>
    <div class="center-group">
      <button mat-icon-button (click)="goBack()"><mat-icon>chevron_left</mat-icon></button>
      <span class="title">{{ headerTitle() }}</span>
      <button mat-icon-button (click)="goForward()"><mat-icon>chevron_right</mat-icon></button>
    </div>
    <div class="right-spacer"></div>
  </div>
  <!-- 其余导航控件 -->
</header>
`

**步骤 2：** 在组件类中添加方法：

`	s
readonly isTodayInView = computed(() => {
  // 检查"今天"是否在当前视图范围内
});

goToToday(): void {
  this.scheduleService.goToToday();
}
`

**步骤 3：** 提交：

`ash
git add src/app/features/schedule/schedule/schedule.component.html src/app/features/schedule/schedule/schedule.component.ts
git commit -m "feat(schedule): show title between arrows, move today to left icon"
`

---

## 任务 6：更新样式（透明导航行，居中标题固定最小宽度）

**文件：**
- 修改：src/app/features/schedule/schedule/schedule.component.scss:49-93

将 header 和 .schedule-nav-controls 规则替换为：

`scss
header {
  display: flex;
  flex-direction: column;
  position: sticky;
  top: 0;
  left: 0;
  right: 0;
  @include extraBorder('-top');
  @include extraBorder('-bottom');
  box-shadow: var(--whiteframe-shadow-1dp);
  z-index: 10;
  color: var(--text-color);
  background: var(--bg-lighter);
  padding-right: -header-scrollbar-padding;
}

.schedule-nav-controls {
  display: grid;
  grid-template-columns: 48px 1fr 48px;
  align-items: center;
  background: transparent;
  @include extraBorder('-bottom');
  min-height: 48px;

  .today-btn {
    justify-self: start;
  }

  .right-spacer {
    width: 48px;
  }

  .center-group {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: var(--s);
    min-width: 0;
  }

  .title {
    font-weight: 600;
    font-size: 18px;
    text-align: center;
    min-width: 260px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;

    @include mq(xs, max) {
      font-size: 14px;
      min-width: 180px;
    }
  }

  button {
    flex-shrink: 0;
  }
}
`

**步骤 2：** Lint：

`ash
npm run checkFile src/app/features/schedule/schedule/schedule.component.scss
`

**步骤 3：** 提交：

`ash
git add src/app/features/schedule/schedule/schedule.component.scss
git commit -m "style(schedule): transparent nav row, fixed-width centered title"
`

---

## 任务 7：移除 schedule-month.component 中重复的月表头

**文件：**
- 修改：src/app/features/schedule/schedule-month/schedule-month.component.html:1-3
- 修改：src/app/features/schedule/schedule-month/schedule-month.component.scss:4-35

**步骤 1：** 在 .html 中，删除第 1-3 行（<header class="month-header"> 包装器和 .month-title div）。模板现在应从 <div class="month-grid-container"> 直接开始。

**步骤 2：** 在 .scss 中，删除整个 .month-header { ... } 块（当前文件第 4-35 行）。

**步骤 3：** Lint 两个文件：

`ash
npm run checkFile src/app/features/schedule/schedule-month/schedule-month.component.scss
`
（.ts 无需修改；html 通过 
pm run prettier / 
pm run lint 检查，但没有 checkFile 目标——lint 已通过 spec 和父级 TS 运行。）

**步骤 4：** 同时检查 schedule-month.component.spec.ts 是否没有断言 .month-header：

`ash
grep -n "month-header\|month-title" src/app/features/schedule/schedule-month/schedule-month.component.spec.ts
`

如果存在此类断言则移除（更新测试以断言 ScheduleComponent 中的 headerTitle 处理月视图——但仅在测试确实引用它时）。

**步骤 5：** 提交：

`ash
git add src/app/features/schedule/schedule-month/schedule-month.component.html src/app/features/schedule/schedule-month/schedule-month.component.scss
git commit -m "refactor(schedule): drop redundant month-header (now in shared nav)"
`

---

## 任务 8：最终验证

**步骤 1：** 运行完整的日程测试套件：

`ash
npm run test:file src/app/features/schedule/schedule.service.spec.ts
npm run test:file src/app/features/schedule/schedule/schedule.component.spec.ts
npm run test:file src/app/features/schedule/schedule-month/schedule-month.component.spec.ts
`

**步骤 2：** 对所有修改过的文件运行 lint：

`ash
npm run checkFile src/app/features/schedule/schedule.service.ts
npm run checkFile src/app/features/schedule/schedule/schedule.component.ts
npm run checkFile src/app/features/schedule/schedule/schedule.component.scss
npm run checkFile src/app/features/schedule/schedule-month/schedule-month.component.scss
npm run checkFile src/app/t.const.ts
`

**步骤 3：** 在开发服务器中手动验证：

`ash
npm run startFrontend
`

- 周视图"今天"：应显示 第 N 周 · {开始} – {结束}，"今天"在范围内的某个位置高亮（不一定在左侧）。
- 点击"下一个" → 前进到下一日历周。
- 点击左侧的"今天"图标 → 重置到当前周，图标变为禁用。
- 切换到月视图 → 标题变为 2026年4月，内部月份标题行消失。
- 导航行与粘性表头融合（透明），标题变化时箭头不会跳动。

**步骤 4：** 除非手动 QA 发现问题，否则无需最终提交。如果有问题，修复并提交清晰的信息（例如 ix(schedule): ...）。
