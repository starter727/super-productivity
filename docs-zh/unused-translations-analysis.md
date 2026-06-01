# 未使用翻译深度分析

## 执行摘要

在 350 个"未使用"的翻译键中，分析结果如下：

| 类别                  | 数量   | 根本原因                     | 建议操作         |
| --------------------- | ------ | ---------------------------- | ---------------- |
| **孤立重复项**        | ~54    | 键位于错误 JSON 路径         | 删除重复项       |
| **从未实现的功能**    | ~43    | 功能从未构建                 | 删除             |
| **动态对象访问**      | ~18    | 扫描器限制                   | 保留（误报）     |
| **已计划/未完成**     | ~50    | 为未来准备                   | 逐案审查         |
| **硬编码字符串**      | ~5     | 代码使用英语而非 T.*         | 修复代码         |
| **需要调查**          | ~180   | 各种原因                     | 逐案审查         |

---

## 类别 1：孤立重复项（可安全删除）

存在于错误 JSON 路径的键 — 正确的键在别处存在并有实际翻译。

### F.SAFETY_BACKUP.*（32 个键）

**问题：** 与 `F.SYNC.SAFETY_BACKUP.*` 重复
**证据：** `F.SAFETY_BACKUP.*` 为空字符串，`F.SYNC.SAFETY_BACKUP.*` 有实际翻译并在代码中使用。

```
F.SAFETY_BACKUP.BACKUP_NOT_FOUND   → 删除（F.SYNC.SAFETY_BACKUP.BACKUP_NOT_FOUND 被使用）
F.SAFETY_BACKUP.BTN_CLEAR_ALL     → 删除（F.SYNC.SAFETY_BACKUP.BTN_CLEAR_ALL 被使用）
...（所有 32 个键）
```

### GCF.PAST.*（11 个键）

**问题：** 与 `GLOBAL_RELATIVE_TIME.PAST.*` 重复
**证据：** `humanize-timestamp.ts` 使用 `T.GLOBAL_RELATIVE_TIME.PAST.*`，而不是 `T.GCF.PAST.*`

```
GCF.PAST.AN_HOUR     → 删除（GLOBAL_RELATIVE_TIME.PAST.AN_HOUR 被使用）
GCF.PAST.A_DAY       → 删除（GLOBAL_RELATIVE_TIME.PAST.A_DAY 被使用）
...（所有 11 个键）
```

---

## 类别 2：从未实现的功能（可安全删除）

### F.PROCRASTINATION.*（32 个键）

**问题：** 整个功能从未实现
**证据：** `src/app/features/procrastination/` 下不存在文件，没有组件使用这些键

### GCF.TIMELINE.*（10 个键）

**问题：** 时间轴设置表单从未实现
**证据：** 不存在 `timeline-form.const.ts`，没有代码引用这些键

### WW.HELP_PROCRASTINATION（1 个键）

**问题：** 与未实现的拖延功能相关

---

## 类别 3：动态对象访问（误报 — 保留）

当 `T.F.SECTION` 被赋值给变量并且子项被动态访问时，扫描器无法检测。

### F.TAG_FOLDER.*（9 个键）
### F.PROJECT_FOLDER.*（9 个键）

**操作：** 保留所有键

---

## 类别 4：硬编码英文字符串（修复代码）

翻译键存在，但代码使用硬编码英文。

### F.TASK_REPEAT.F.SCHEDULE_TYPE_*（2 个键）

**问题：** 应使用翻译键而非字符串拼接

---

## 类别 5：已计划/未完成功能（逐案审查）

### F.FOCUS_MODE.*（11 个未使用键）
### F.SYNC.*（36 个键，不包括 SAFETY_BACKUP）
### F.METRIC.*（21 个键）

---

## 推荐的清理脚本

```javascript
// 添加到 tools/cleanup-unused-translations.js

const SECTIONS_TO_REMOVE = [
  'ANDROID', // 已移除
  'THEMES',  // 已移除
  'PROCRASTINATION', // 从未实现
];

const NESTED_PATHS_TO_REMOVE = [
  ['F', 'CALDAV', 'ISSUE_CONTENT'], // 已移除
  ['F', 'SAFETY_BACKUP'], // 与 F.SYNC.SAFETY_BACKUP 重复
  ['GCF', 'PAST'], // 与 GLOBAL_RELATIVE_TIME.PAST 重复
  ['GCF', 'TIMELINE'], // 从未实现
];
```

---

## 可立即安全删除的摘要

| 部分                    | 键数   | 原因                             |
| ----------------------- | ------ | -------------------------------- |
| F.SAFETY_BACKUP.*       | 32     | 与 F.SYNC.SAFETY_BACKUP 重复     |
| F.PROCRASTINATION.*     | 32     | 功能从未实现                     |
| GCF.PAST.*              | 11     | 与 GLOBAL_RELATIVE_TIME.PAST 重复|
| GCF.TIMELINE.*          | 10     | 功能从未实现                     |
| WW.HELP_PROCRASTINATION | 1      | 与未实现功能相关                 |
| **总计**                | **86** | 可立即安全删除                   |

清理后：约 264 个键需要逐案审查。
