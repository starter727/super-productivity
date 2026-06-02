# 主题契约

为 Super Productivity 编写自定义主题的公共契约。本文档具有权威性 — 验证器的警告通行证基于同一契约（`src/app/core/theme/theme-contract.const.ts`）。

## TL;DR

将至少包含以下四个声明的 CSS 文件放入 Settings → Theme → "Install theme"：

```css
body {
  --surface-1: #f8f8f7;
  --surface-2: #fff;
  --ink: rgb(44, 44, 44);
  --ink-on-channel: 0, 0, 0;
}
```

对于精美主题，也请声明**推荐**令牌（见下表）。主题是纯 CSS — 无脚本、无远程 URL、无捆绑资源。

## 主题化工作原理

CSS 变量架构有三层：

1. **原语** — surface 阶梯（`--surface-0` 到 `--surface-4`）、ink（`--ink`、`--ink-strong`、`--ink-muted`、`--ink-on-channel`）、`--separator`、`--divider`、`--scrim`、`--bg-overlay`、`--brand`、`--focus-ring`。这些是主题用来改变外观的旋钮。
2. **语义别名** — 高级令牌如 `--bg`、`--card-bg`、`--text-color`。大多数解析为一个原语，因此更改一个原语会自动波及数十个语义令牌。
3. **B 类令牌** — 真正的亮/暗拆分，其关系在模式之间确实不同（例如 `--close-btn-bg`、`--scrollbar-thumb`）。想要覆盖这些的主题必须同时声明亮色和暗色值。

每个主题都建立在基础之上。如果你的 CSS 没有声明某个令牌，则应用基础值。

## 必需令牌

| 令牌               | 控制内容                                      | 备注                                                                                                              |
| ------------------ | --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `--surface-1`      | 应用背景                                      | Surface 阶梯的基础。                                                                                              |
| `--surface-2`      | 卡片 / 任务 / 面板背景                        | 比 `--surface-1` 高一级。                                                                                         |
| `--ink`            | 正文文本颜色                                  | 大多数文本直接使用此令牌。                                                                                        |
| `--ink-on-channel` | RGB 三元组（无 `rgb()` 包装），用于覆盖层令牌 | 例如浅色 `0, 0, 0`，深色 `255, 255, 255`。用作 `rgba(var(--ink-on-channel), α)`，从单个声明生成模式正确的覆盖层。 |

## 推荐令牌

| 令牌           | 控制内容                                                |
| -------------- | ------------------------------------------------------- |
| `--surface-0`  | 比 `--surface-1` 略暗（用于工具栏上的 `--bg-darker`）。 |
| `--surface-3`  | 提升的表面（当前任务、拖放目标）。                      |
| `--surface-4`  | 最高表面（横幅、移动端底部面板）。                      |
| `--ink-strong` | 最大对比度文本（用于强调标签）。                        |
| `--ink-muted`  | 柔和文本（辅助标签、占位符）。                          |
| `--separator`  | 柔和分隔线颜色（行间）。                                |
| `--divider`    | 默认分隔线颜色（Material 使用）。                       |
| `--scrim`      | 背景 / 覆盖层遮罩颜色。                                 |

如果缺少其中任何一个，验证器会发出警告列出令牌名称，并在安装后弹出 snackbar。主题仍然会安装——警告仅作提示。

## 可选令牌

| 令牌                     | 控制内容                     | 默认值         |
| ------------------------ | ---------------------------- | -------------- |
| `--state-hover-alpha`    | 悬停覆盖层不透明度           | `0.06`         |
| `--state-focus-alpha`    | 聚焦覆盖层不透明度           | `0.10`         |
| `--state-pressed-alpha`  | 激活/按下覆盖层不透明度      | `0.14`         |
| `--state-selected-alpha` | 选中行覆盖层不透明度         | `0.10`         |
| `--state-disabled-alpha` | 禁用元素不透明度             | `0.40`         |
| `--focus-ring`           | 聚焦环颜色（默认 `--brand`） | `var(--brand)` |

这些是 **alpha 标量**（或单一颜色），不是 rgba 颜色。基础层将它们与 `--ink-on-channel` 组合生成实际的覆盖层颜色，因此将 `--state-hover-alpha` 调整为 `0.10` 的主题会自动在浅色和深色模式下获得更强的悬停效果。

## 特殊令牌

### `--ink-on-channel`

这是基石原语。它是一个 **RGB 三元组**——不是 `rgb()` 值，不是十六进制字面量——因此可以嵌入 `rgba(var(--ink-on-channel), 0.06)` 从单个声明生成模式正确的覆盖层。

```css
body {
  --ink-on-channel: 0, 0, 0; /* 浅色模式 → 黑色覆盖层 */
}
body.isDarkTheme {
  --ink-on-channel: 255, 255, 255; /* 深色模式 → 白色覆盖层 */
}
```

### `--state-*-alpha` 和 Velvet 旧版桥接

Velvet（内置强调色主题）历史上直接声明了 `--hover-bg-opacity`、`--focus-bg-opacity`、`--pressed-bg-opacity` 和 `--disabled-opacity`。基础层现在使用 velvet 名称作为 `var()` 回退来声明规范名称：

```css
:where(body, body.isDarkTheme) {
  --state-hover-alpha: var(--hover-bg-opacity, 0.06);
  --state-focus-alpha: var(--focus-bg-opacity, 0.1);
  --state-pressed-alpha: var(--pressed-bg-opacity, 0.14);
  --state-selected-alpha: var(--selected-bg-opacity, 0.1);
  --state-disabled-alpha: var(--disabled-opacity, 0.4);
}
```

如果你的主题已使用 velvet 旧版名称，它们继续有效——无需重命名。新主题应优先使用 `--state-*-alpha` 名称。

## 选择器契约

此部分至关重要。在为"我的主题在浅色模式下正常但在深色模式下不正常"调试之前，请阅读此部分。

| 层级                                         | 所在位置                                   | 特异性                                |
| -------------------------------------------- | ------------------------------------------ | ------------------------------------- |
| 原语（如 `--surface-1`、`--ink-on-channel`） | `body`（浅色）、`body.isDarkTheme`（深色） | (0,0,1) 和 (0,1,1)                    |
| 语义别名（如 `--bg`、`--card-bg`）           | `:where(body, body.isDarkTheme)`           | (0,0,0) — `:where()` 是零特异性包装器 |
| B 类令牌（按模式）                           | `body`（浅色）、`body.isDarkTheme`（深色） | (0,0,1) 和 (0,1,1)                    |

**覆盖原语的主题必须使用 `body` 和/或 `body.isDarkTheme` 选择器。** 如果你仅在 `:root`（特异性 0,1,0）声明 `--surface-1`：

- 浅色模式 → 胜过基础 `body`（0,1,0 > 0,0,1）✓
- 深色模式 → 输给基础 `body.isDarkTheme`（0,1,0 < 0,1,1）✗

这就是模式不一致的主题。始终在 `body`（浅色）和 `body.isDarkTheme`（深色）下声明原语。

**覆盖语义别名的主题**可以使用任何非零特异性选择器（`body`、`body.isDarkTheme`、`:root`）。别名位于 `:where(...)`（特异性 0,0,0），因此任何选择器都能胜过它们。

验证器的警告通行证在 v1 中是**仅检测存在性**：它不解析选择器。仅在 `:root` 声明 `--surface-1` 的主题即使模式不一致也会通过验证。选择器感知警告是后续跟踪的功能。

## 复刻说明

1. 选择最接近的内置主题作为起点：`src/assets/themes/{arc,catppuccin-mocha,cybr,dark-base,dracula,everforest,glass,lines,nord-polar-night,nord-snow-storm,rainbow,velvet,zen}.css`。
2. 复制到新文件。将 `.css` 重命名为你想要的名称——选择器使用文件名 slug 作为主题 ID。
3. 编辑 `body` 和 `body.isDarkTheme` 下的原语声明。从 `--surface-1`、`--surface-2`、`--ink`、`--ink-on-channel` 开始。其余保持默认。
4. 将文件放入 Settings → Theme → "Install theme…"。文件存储在 IndexedDB 中；不会离开你的设备。

## 示例

### 最小六行主题

```css
body {
  --surface-1: #fef9f3;
  --surface-2: #ffffff;
  --ink: #2c1810;
  --ink-on-channel: 44, 24, 16;
}
```

### 调整状态 alpha 值

```css
body {
  --surface-1: #f8f8f7;
  --surface-2: #fff;
  --ink: rgb(44, 44, 44);
  --ink-on-channel: 0, 0, 0;
  /* 更柔和的悬停，更明显的按下 */
  --state-hover-alpha: 0.04;
  --state-pressed-alpha: 0.18;
}
```

### 浅色 + 深色组合

```css
body {
  --surface-1: #fef9f3;
  --surface-2: #fff;
  --ink: #2c1810;
  --ink-on-channel: 0, 0, 0;
  --separator: #e0d6c8;
  --divider: rgba(0, 0, 0, 0.12);
}
body.isDarkTheme {
  --surface-1: #1a1410;
  --surface-2: #2c1810;
  --ink: rgb(245, 230, 215);
  --ink-on-channel: 255, 255, 255;
  --separator: rgba(255, 255, 255, 0.1);
  --divider: rgba(255, 255, 255, 0.12);
}
```

## 验证规则

验证器（`src/app/core/theme/validate-theme-css.util.ts`）在安装时运行。安装时生成的警告与主题记录一起持久化在 IndexedDB 中，并从存储的快照重新显示——主题在冷加载时不会重新验证。如果契约在版本之间发生变化，现有主题的警告反映的是安装时的契约，直到用户重新上传。

**硬拒绝（主题无法安装）：**

- `url(...)` 参数解析为远程 URL（`http:`、`https:`、`//host/...`、`data:` URI、无协议绝对路径或任何其他协议）
- 相对 `url(...)` 路径（v1 中不支持捆绑资源）
- `src(...)` 参数（CSS Fonts L4 形式）—— 规则与 `url(...)` 相同
- `@import "https://..."` 和 `@import url(...)` 使用绝对 URL
- `image-set("https://...")` 和裸 `image-set(http://... 1x)` —— 规则相同
- 文件大于 500 KB
- 未终止的 `/* 注释`（格式错误的 CSS）

**软警告（主题安装，显示 snackbar）：**

- 缺少任何必需或推荐令牌——snackbar 列出令牌名称。可选令牌不会产生警告（它们始终从基础层继承）。

验证器处理关键字的 `\xx` 转义尝试（`u\72l(`、`\55RL(`、`s\72\63(`、`--surf\61ce-1` 等）以及字符串字面量或 `url-token` 内部的 `/* */` 注入——参见 `validate-theme-css.util.spec.ts` 获取完整的攻击面测试列表。

## 旧版迁移说明

如果你已经有一个在令牌模型重构之前可以正常工作的主题：无需任何操作。13 个内置主题不会被编辑，验证器的警告通行证是非阻塞的。如果你的主题使用了 velvet 旧版名称（`--hover-bg-opacity`、`--focus-bg-opacity`、`--pressed-bg-opacity`、`--disabled-opacity`），它们通过基础层中的 `var()` 回退桥接继续有效。

如果你想让契约警告静默，在 `body` 下声明四个必需令牌（`--surface-1`、`--surface-2`、`--ink`、`--ink-on-channel`）（如果你的主题有深色模式，还要在 `body.isDarkTheme` 下声明）。推荐令牌是锦上添花但非必需。
