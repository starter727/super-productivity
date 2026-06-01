# I18n 翻译管理脚本

本文档描述 `tools/add-missing-i18n-variables.js` 脚本的用法，该脚本帮助管理 Super Productivity 的国际化（i18n）文件。

## 概述

该脚本管理位于 `src/assets/i18n/` 的翻译文件。基础语言是英语（`en.json`），其他语言如 `de.json`（德语）、`tr.json`（土耳其语）等包含翻译。

脚本支持三种模式：

- **提取模式**：为特定语言创建包含缺失翻译的工作中（WIP）文件。
- **合并模式**：将翻译好的 WIP 文件合并回主语言文件。
- **传统模式**：向所有语言文件添加缺失的键（未指定模式时的默认行为）。

## 文件结构

- `en.json`：包含所有键的参考英语文件。
- `{lang}.json`：主翻译文件（例如 `de.json`、`tr.json`）。
- `{lang}-wip.json`：临时工作中文件，仅包含缺失的翻译。

## 用法

### 提取缺失翻译

为特定语言（例如土耳其语）提取缺失翻译：

```bash
node tools/add-missing-i18n-variables.js extract tr
```

这将创建 `tr-wip.json`，其中包含所有在 `en.json` 中存在但在 `tr.json` 中缺失或为空的键。

### 翻译 WIP 文件

编辑生成的 `{lang}-wip.json` 文件并为键提供翻译。

`tr-wip.json` 示例：

```json
{
  "APP": {
    "SKIP_SYNC_WAIT": "Skip waiting for sync"
  },
  "F": {
    "CALDAV": {
      "ISSUE_CONTENT": {
        "DESCRIPTION": "Description"
      }
    }
  }
}
```

### 合并翻译

翻译 WIP 文件后，将其合并回主语言文件：

```bash
node tools/add-missing-i18n-variables.js merge tr
```

这将：

- 将 `tr-wip.json` 中的翻译合并到 `tr.json`
- 保持与 `en.json` 相同的键顺序
- 验证所有键都存在
- 删除 `tr-wip.json` 文件

### 传统模式（更新所有文件）

一次性向所有语言文件添加缺失的键（保留现有翻译）：

```bash
node tools/add-missing-i18n-variables.js
```

这将更新所有 `{lang}.json` 文件，使其包含 `en.json` 中的新键，并将它们放在相同的顺序中。

## 工作流示例

1. 添加新功能，使用新键更新 `en.json`
2. 为你的语言运行提取：`node tools/add-missing-i18n-variables.js extract de`
3. 翻译 `de-wip.json` 中的键
4. 运行合并：`node tools/add-missing-i18n-variables.js merge de`
5. 提交包含更新后的 `de.json` 的拉取请求

## 注意

- 脚本保留键的顺序以匹配 `en.json`
- 翻译文件中的空字符串会触发英语后备显示
- WIP 文件是临时的，合并命令会将其删除
