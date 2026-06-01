# 翻译指南

Super Productivity 使用 JSON 文件进行翻译，位于 `src/assets/i18n/`。

## 如何贡献

> **重要：** 添加或更改翻译键时，**只直接编辑 `en.json`**。其他语言文件通过 i18n 脚本工作流程管理，详见 [i18n-script-usage.md](i18n-script-usage.md)。手动编辑其他语言文件可能导致你的更改被覆盖。

1. 在 `src/assets/i18n/en.json` 中添加或更新翻译键
2. 运行 i18n 脚本将更改传播到其他语言（参见 [i18n-script-usage.md](i18n-script-usage.md)）
3. 提交拉取请求（pull request）

## 重要说明

### 后备语言（Fallback Language）

**英语（`en.json`）是后备语言。** 如果某个翻译缺失或为空，应用会自动显示英语文本。

### 空值是有意为之

当你看到空字符串（`""`）时，这是**有意的**——它触发了英语后备显示。除非你提供实际的翻译，否则不要将英语文本复制到空字段中。

```json
{
  "SOME_KEY": ""
}
```

以上内容将显示 `SOME_KEY` 的英语文本。

### 文件格式

- 嵌套 JSON 结构
- 键名使用大写蛇形命名法（SCREAMING_SNAKE_CASE）
- 保持结构完整——只更改字符串值

### 示例

```json
{
  "G": {
    "CANCEL": "Abbrechen",
    "SAVE": "Speichern"
  }
}
```

## 提示

- 使用 `en.json` 作为上下文参考
- 保持翻译简洁（UI 空间有限）
- 如果可能，在本地测试翻译（`ng serve`）

## 翻译管理脚本

关于管理缺失翻译和保持一致性，请使用 `tools/add-missing-i18n-variables.js` 脚本。详细说明见 [i18n-script-usage.md](i18n-script-usage.md)。
