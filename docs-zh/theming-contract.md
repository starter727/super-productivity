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

（完整英文原文保留，以下是关键部分的中文摘要说明...）
