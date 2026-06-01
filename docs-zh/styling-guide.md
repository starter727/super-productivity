# 样式指南

## 规则

- **所有视觉样式必须使用 CSS 变量**，来自 `src/styles/_css-variables.scss`——永远不要硬编码颜色、间距、阴影、过渡或 z-index。
- **布局/定位可以使用纯 CSS**——flexbox、grid、display、position、dimensions。
- **在创建新的样式化元素之前，先检查 `src/app/ui/`**——已有 40 多个可复用组件。
- **组件 SCSS 应保持最小化**——共享样式应放在 `src/styles/components/` 中或作为 mixin（混入）。
- **Material 覆盖层组件**（菜单、对话框、工具提示）在组件作用域外渲染——在 `src/styles/components/` 中为其设置样式，并在组件中添加指向该位置的注释。

## 反模式

| 避免                                   | 改为                                                                    |
| ------------------------------------ | ------------------------------------------------------------------------- |
| 硬编码颜色（`#fff`、`red`）           | CSS 变量（`--text-color`、`--card-bg`、`--color-danger`）             |
| 硬编码间距（`16px`、`1rem`）         | 间距变量（`--s2`、`--s`、`--s-half`）                             |
| 硬编码阴影                       | 阴影变量（`--whiteframe-shadow-*dp`、`--md-sys-level*`）        |
| 硬编码过渡/时长      | 过渡变量（`--transition-standard`、`--transition-duration-*`） |
| 自定义 z-index 值                | Z-index 变量（`--z-main-header`、`--z-backdrop` 等）               |
| 不检查就创建新的样式化元素 | 先检查 `src/app/ui/` 中是否有现有的可复用组件                |
## 关键文件

| 文件                             | 用途                                                       |
| -------------------------------- | ------------------------------------------------------------- |
| `src/styles/_css-variables.scss` | 所有 CSS 自定义属性（设计令牌）                     |
| `src/styles/themes.scss`         | Material 主题设置 + 工具类                        |
| `src/styles/page.scss`           | 全局页面/主体样式                                       |
| `src/styles/util.scss`           | 工具类                                               |
| `src/styles/components/`         | 全局组件样式（Material 覆盖、共享模式） |
| `src/styles/mixins/`             | 可复用的 SCSS mixin                                          |
| `src/app/ui/`                    | 40 多个可复用的 Angular UI 组件                            |

## 间距变量（8px 网格）

| 变量      | 值 | 变量 | 值 |
| ------------- | ----- | -------- | ----- |
| `--s-quarter` | 2px   | `--s4`   | 32px  |
| `--s-half`    | 4px   | `--s5`   | 40px  |
| `--s`         | 8px   | `--s6`   | 48px  |
| `--s2`        | 16px  | `--s7`   | 56px  |
| `--s3`        | 24px  | `--s8`   | 64px  |

```scss
// 好
padding: var(--s2) var(--s3);
gap: var(--s-half);

// 不好
padding: 16px 24px;
gap: 4px;
```

## 颜色变量

| 用例           | 变量                                                                                          |
| ------------------ | -------------------------------------------------------------------------------------------------- |
| 文本               | `--text-color`、`--text-color-muted`、`--text-color-most-intense`                                  |
| 背景        | `--bg`、`--card-bg`、`--task-c-bg`、`--sub-task-c-bg`                                              |
| 语义           | `--color-success`（#4caf50）、`--color-warning`（#ff9800）、`--color-danger`（#f44336）               |
| Material 调色板   | `--palette-primary-500`、`--palette-accent-500`、`--palette-warn-500`（100-900）                    |
| 覆盖层           | `--c-dark-10` 到 `--c-dark-90`、`--c-light-05` 到 `--c-light-90`                         |
| 透明度系数 | `--border-alpha`（0.12）、`--overlay-alpha`（0.1）、`--muted-alpha`（0.6）、`--separator-alpha`（0.3） |

### 主题特定值

浅色主题设置：`--bg: #f8f8f7`、`--card-bg: #ffffff`、`--text-color: rgb(44, 44, 44)`
深色主题设置：`--bg: #131314`、`--card-bg: var(--dark3)`、`--text-color: rgb(230, 230, 230)`

深色阴影色：`--dark0`（rgb(0,0,0)）到 `--dark24`（rgb(56,56,56)）

### 组件中的主题特定覆盖

```scss
@include darkTheme() {
  /* 仅深色样式 */
}
@include lightTheme() {
  /* 仅浅色样式 */
}
```

Mixin 位于 `src/styles/mixins/_theming.scss`。

## 阴影与高度

- `--whiteframe-shadow-1dp` 到 `--whiteframe-shadow-24dp` —— 经典 Material 阴影
- `--md-sys-level1` 到 `--md-sys-level5` —— Material Design 3 风格

## 过渡与动画

| 类型       | 变量                                                                                                          |
| ---------- | ----------------------------------------------------------------------------------------------------------------- |
| 通用过渡 | `--transition-standard`、`--transition-fast`、`--transition-very-fast` |
| 时长      | `--transition-duration-s`（150ms）、`--transition-duration-m`（250ms）、`--transition-duration-l`（400ms） |
| 缓动      | `--ani-enter-timing`、`--ani-leave-timing`、`--ani-sharp-timing`                          |

迁移硬编码时长时，选择最接近的区间——对于 UI 过渡，最多 ~15% 的偏差是可以接受的。

## 焦点环

用于自定义交互元素的无障碍键盘焦点令牌。Material 组件保留自己的焦点处理方式；这些用于非 Material 按钮、卡片和自定义控件。

| 变量              | 值                        |
| --------------------- | ---------------------------- |
| `--focus-ring-width`  | 2px                          |
| `--focus-ring-offset` | 2px                          |
| `--focus-ring-color`  | `var(--palette-primary-500)` |

最快速的采用方式——添加 `util.scss` 中的 `.focus-ring` 工具类，它仅在 `:focus-visible` 时应用 `outline`（因此不会在鼠标点击时触发）。

```scss
// 按元素选择启用
.my-button:focus-visible {
  outline: var(--focus-ring-width) solid var(--focus-ring-color);
  outline-offset: var(--focus-ring-offset);
}
```

## Z-Index 层级

| 变量                | 值 | 用途                  |
| ----------------------- | ----- | ------------------------ |
| `--z-check-done`        | 11    | 任务完成复选框       |
| `--z-main-header`       | 12    | 主标题              |
| `--z-task-title-focus`  | 32    | 聚焦的任务标题       |
| `--z-mobile-bottom-nav` | 50    | 移动端底部导航 |
| `--z-side-nav`          | 60    | 侧边导航          |
| `--z-backdrop`          | 222   | 背景覆盖层         |
| `--z-add-task-bar`      | 999   | 添加任务栏             |
| `--z-search-bar`        | 999   | 搜索栏               |
| `--z-tour`              | 1001  | 导览覆盖层             |

## 布局变量

| 变量                | 值 | 备注              |
| ----------------------- | ----- | ------------------ |
| `--component-max-width` | 800px | iPad 上为 900-1000px |
| `--side-nav-width`      | 200px |                    |
| `--side-nav-width-l`    | 400px |                    |
| `--bar-height-large`    | 56px  |                    |
| `--bar-height`          | 48px  |                    |
| `--bar-height-small`    | 40px  |                    |

## 响应式断点

可作为 CSS 变量（`--layout-xxxs` 到 `--layout-xl`）和 SCSS mixin（位于 `src/styles/mixins/_media-queries.scss`）使用：

| 断点 | 值  |
| ---------- | ------ |
| `xxxs`     | 398px  |
| `xxs`      | 450px  |
| `xs`       | 600px  |
| `s`        | 800px  |
| `m`        | 1000px |
| `l`        | 1200px |
| `xl`       | 2000px |
## 工具类

定义在 `src/styles/util.scss` 和 `src/styles/themes.scss` 中：

- 布局：`.center-wrapper`、`.mw`（最大宽度容器）
- 响应式：`.hide-xs`、`.hide-xxs`、`.hide-gt-sm`
- 输入：`.show-only-on-touch-primary`、`.show-only-on-mouse-primary`
- 主题：`.show-dark-only`、`.show-light-only`
- 颜色：`.bg-primary`、`.bgc-accent`、`.color-primary`、`.bg-success`、`.bg-warning`、`.bg-danger`
- 效果：`.milk-glass`（背景模糊）

## 编写主题

主题文件位于 `src/assets/themes/*.css`，运行时加载。

### 侧边导航：永远不要在 `magic-side-nav` 宿主上应用创建包含块（CB）的属性

移动端抽屉（`.nav-sidenav`）及其覆盖层（`.nav-backdrop-mobile`）是 `magic-side-nav` 宿主的 `position: fixed` 子元素。在移动端，宿主收缩到 `width: 0`（`magic-side-nav.component.ts` 中的 `hostWidthSignal`）。

任何为固定定位后代创建新包含块的属性——`backdrop-filter`、`filter`、`transform`、`perspective`、`contain: paint|layout|strict` 或匹配的 `will-change`——都会将抽屉和覆盖层重新锚定到宽度为 0 的宿主。当用户点击菜单时，抽屉将永远不会显示。

将毛玻璃/模糊/色调效果应用到内部的 `.nav-sidenav` 上：

```css
/* 不好——导致移动端抽屉折叠 */
body.isDarkTheme magic-side-nav {
  background: var(--my-pane);
  backdrop-filter: blur(32px);
}

/* 好——宿主保持视觉惰性 */
body.isDarkTheme magic-side-nav .nav-sidenav {
  background: var(--my-pane);
  backdrop-filter: blur(32px);
}
```

不会创建包含块的属性——`background`、`border`、`box-shadow`、`margin`——在宿主上是安全的。参见 `velvet.css` 和 `liquid-glass.css` 获取完整的参考模式。

## 全局组件样式

位于 `src/styles/components/`，用于在组件作用域外渲染的元素：

- `_overwrite-material.scss` —— Material 组件自定义
- `_customizer-menu.scss`、`backdrop.scss`、`bottom-panel.scss`
- `markdown.scss`、`mentions.scss`、`table.scss`
- `fab-wrapper.scss`、`wrap-buttons.scss`、`multi-btn-wrapper.scss`
- `planner-shared.scss`、`formly-rows.scss`、`scrollbars.scss`