# Super Productivity 插件开发指南

本文档是 Super Productivity 插件系统的完整说明，涵盖创建 Super Productivity 插件所需了解的所有内容。

本文档可能并非始终完全最新。最新的 TypeScript 接口请见：
[types.ts](../packages/plugin-api/src/types.ts)

个人认为，学习编写插件的最佳方式是查看示例插件：

- [yesterday-tasks-plugin（昨日任务插件）](../packages/plugin-dev/yesterday-tasks-plugin)
- [procrastination-buster（拖延症克星）](../packages/plugin-dev/procrastination-buster)
- [api-test-plugin（API 测试插件）](../packages/plugin-dev/api-test-plugin)

如果你希望构建复杂的用户界面，有适用于 solidjs 的模板：
[boilerplate-solid-js](../packages/plugin-dev/boilerplate-solid-js)

---

## 目录

- [快速开始](#快速开始)
- [插件清单](#插件清单)
- [插件类型](#插件类型)
- [可用 API 方法](#可用-api-方法)
- [最佳实践](#最佳实践)
- [安全考虑](#安全考虑)
- [测试你的插件](#测试你的插件)

## 快速开始

### 1. 基本插件结构

```
my-plugin/
├── manifest.json      # 插件元数据（必需）
├── plugin.js          # 宿主端插件代码（仅使用 iframe 时可选）
├── index.html         # UI 界面（省略 plugin.js 时必需；需要在 manifest 中设置 iFrame:true）
└── icon.svg           # 插件图标（可选）
```

需要宿主端在插件加载时进行初始化的插件（如快捷键、头部按钮、后台行为或宿主端 API 处理器）必需提供 `plugin.js`。仅包含 UI 界面的 iframe 插件可以在 manifest 中设置 `iFrame: true`，仅需提供 `manifest.json` 和 `index.html`。

### 2. 最小示例

**manifest.json：**

```json
{
  "id": "hello-world",
  "name": "Hello World Plugin",
  "version": "1.0.0",
  "description": "我的第一个 Super Productivity 插件",
  "manifestVersion": 1,
  "minSupVersion": "14.0.0"
}
```

**plugin.js：**

```javascript
console.log('Hello World 插件已加载！');

// 显示一条通知
PluginAPI.showSnack({
  msg: '来自我的插件的问候！',
  type: 'SUCCESS',
});

// 演示一个简单的计数器
await PluginAPI.setCounter('hello-count', 0);
PluginAPI.registerHeaderButton({
  label: '你好（计数：0）',
  icon: 'waving_hand',
  onClick: async () => {
    const newCount = await PluginAPI.incrementCounter('hello-count');
    PluginAPI.showSnack({
      msg: `按钮已点击！计数：${newCount}`,
      type: 'INFO',
    });
  },
});
```

## 插件清单

所有插件都必须包含 `manifest.json` 文件，该文件定义了插件的元数据和配置。

### 清单字段

| 字段               | 类型     | 必需   | 说明                                              |
| ----------------- | -------- | ------ | ------------------------------------------------- |
| `id`              | string   | 是     | 插件的唯一标识符（使用 kebab-case 命名方式）          |
| `name`            | string   | 是     | 向用户显示的名称                                    |
| `version`         | string   | 是     | 语义化版本（如 "1.0.0"）                            |
| `description`     | string   | 是     | 插件功能的简要说明                                  |
| `manifestVersion` | number   | 是     | 当前必须为 `1`                                     |
| `minSupVersion`   | string   | 是     | 所需的最低 Super Productivity 版本                  |
| `author`          | string   |        | 插件作者名称                                       |
| `homepage`        | string   |        | 插件网站或仓库 URL                                 |
| `icon`            | string   |        | 图标文件路径（推荐 SVG）                             |
| `iFrame`          | boolean  |        | 插件是否使用 iframe 界面（默认：false）               |
| `sidePanel`       | boolean  |        | 是否在侧面板中显示插件（默认：false），需要 `iFrame:true` |
| `permissions`     | string[] |        | 插件所需的权限（如 ["nodeExecution"]）               |
| `hooks`           | string[] |        | 要监听的应用事件                                    |
| `uiKit`           | boolean  |        | 为 iframe 插件启用 UI Kit CSS 重置（默认：true）。设为 `false` 以使用自定义样式     |
| `theme`           | string   |        | 插件主题偏好（"light"、"dark" 或 "auto"，默认：用户设置） |

### 示例 manifest.json

```json
{
  "id": "my-awesome-plugin",
  "name": "我的超棒插件",
  "version": "1.2.0",
  "description": "一个真正超棒的 Super Productivity 插件",
  "manifestVersion": 1,
  "minSupVersion": "14.0.0",
  "author": "你的名字",
  "homepage": "https://github.com/yourname/my-awesome-plugin",
  "icon": "icon.svg",
  "permissions": ["projects:read", "tasks:read", "tasks:write"],
  "hooks": ["task:created", "task:done"]
}
```

## 插件类型

### 1. 内联脚本插件（默认）

**默认方式：** 插件代码直接注入到应用窗口。适用于：

- 需要宿主端 API 方法（`registerHeaderButton`、`registerShortcut` 等）
- 需要在后台运行
- 需要监听应用事件（hooks 钩子）

### 2. iframe 插件

**使用方式：** 在 manifest 中设置 `"iFrame": true`

适用于：

- 拥有自己 UI 界面的插件
- 需要 CSS 隔离的视觉元素
- 复杂的数据展示

**注意事项：**

- 所有资源必须内联在 `index.html` 中
- `css` 和 js 必须放入 HTML 文件
- 无外部依赖（所有内容内联）
- 有限的 API 访问（参见安全考虑章节）

### 3. 侧面板插件

**使用方式：** 同时设置 `"iFrame": true` 和 `"sidePanel": true`

- 插件显示在侧面板中
- 适合始终可见的工具
- 遵循 iframe 插件的所有限制

## 可用 API 方法

"宿主端"代码（`plugin.js` 而非 iframe）中提供以下 API 方法。

| 方法                        | 说明                                                    | 宿主端 | iframe |
| --------------------------- | ------------------------------------------------------- | ------ | ------ |
| `showSnack({msg, type})`    | 显示一个 snack 通知（INFO、SUCCESS、WARNING、DANGER）    | 是     | 是     |
| `setCounter(key, val)`      | 设置持久化计数器值                                       | 是     | 是     |
| `getCounter(key)`           | 获取计数器值                                             | 是     | 是     |
| `incrementCounter(key)`     | 递增计数器并返回新值                                      | 是     | 是     |
| `setProgress(val)`          | 在标题中设置进度指示器（0-1）                            | 是     | 否     |
| `registerHeaderButton({})`  | 向工具栏添加一个按钮                                      | 是     | 否     |
| `registerMenuEntry({})`     | 向"扩展"菜单添加条目                                      | 是     | 否     |
| `registerSidePanelButton()` | 向侧面板添加一个按钮                                      | 是     | 否     |
| `registerShortcut({})`      | 注册键盘快捷键                                            | 是     | 否     |
| `registerHook(event, fn)`   | 监听应用事件                                              | 是     | 否     |
| `getTasks()`                | 获取所有任务，包括已归档任务                               | 是     | 是     |
| `getCurrentTask()`          | 获取当前正在进行的任务                                    | 是     | 是     |
| `getTodayTasks()`           | 获取今天的任务                                            | 是     | 是     |
| `getBacklogTasks()`         | 获取待办箱中的任务                                        | 是     | 是     |
| `addTask(task)`             | 添加新任务                                                | 是     | 是     |
| `updateTask(id, changes)`   | 更新现有任务                                              | 是     | 是     |
| `addOrUpdateTasks(tasks)`   | 批量添加或更新任务                                        | 是     | 是     |
| `getProjects()`             | 获取所有项目                                              | 是     | 是     |
| `execNodeScript(script)`    | 执行 Node.js 脚本（需要 `nodeExecution` 权限）            | 是     | 否     |
| `fetch(url, options)`       | 使用 Node.js HTTP 栈（而非 Electron 代理感知栈）发起 HTTP 请求。需要 `nodeExecution` 权限 | 是     | 否     |
| `getConfig()`               | 获取插件配置                                              | 是     | 是     |
| `setConfig(config)`         | 设置插件配置                                              | 是     | 是     |
| `openFileDialog(options)`   | 打开文件选择对话框                                        | 是     | 是     |
| `readFile(path)`            | 以 base64 字符串形式读取文件内容                           | 是     | 是     |
| `writeFile(path, content)`  | 将内容写入文件（需要 `nodeExecution` 权限）               | 是     | 否     |
| `setInterval(fn, ms)`       | 在宿主端设置定时器（安全——即使标签页未激活也会触发）       | 是     | 是     |

### API 使用示例

```javascript
// 显示一条通知
PluginAPI.showSnack({
  msg: '任务已更新！',
  type: 'SUCCESS',
});

// 获取并记录任务数据
const tasks = await PluginAPI.getTasks();
console.log('当前任务：', tasks);

// 添加一个新任务
await PluginAPI.addTask({
  title: '来自插件的新任务',
  projectId: 'some-project-id',
});

// 注册一个快捷键
PluginAPI.registerShortcut({
  label: '打招呼',
  key: 'h',
  // 可选修饰键：ctrlKey、shiftKey、altKey、metaKey
  ctrlKey: true,
  // 不传递 key 以捕获所有快捷键
  // 多个快捷键：key: ['h', 'j']
  // 自定义作用域：scope: 'MY_PLUGIN'（默认 'GLOBAL'）
  // 描述：description: '显示一个友好的问候'
  // 角色：role: 'ADD'（在无障碍树中为按钮分配角色）
  // 传递回调，或传递 action: 'IGNORE' 以抑制宿主端快捷键
  // 更多详情请参阅快捷方式模型
  fn: () => {
    PluginAPI.showSnack({ msg: '你好！', type: 'INFO' });
  },
});
```

### 参数详情及完整示例

#### showSnack

```javascript
PluginAPI.showSnack({
  msg: '操作成功！',
  type: 'SUCCESS', // 'SUCCESS' | 'WARNING' | 'DANGER' | 'INFO' | 'CUSTOM'
  // 可选的 toast 消息
  isToast: true,
  // 自定义类型使用 Emoji/图标
  svgIco: 'check_circle',
  // 可选的执行操作
  actionStr: '撤销',
  actionFn: async () => {
    // 处理撤销逻辑
  },
});
```

#### registerHeaderButton

```javascript
PluginAPI.registerHeaderButton({
  label: '我的操作',
  icon: 'rocket_launch', // 使用 Material Icons 名称
  onClick: async () => {
    // 处理按钮点击
    PluginAPI.showSnack({ msg: '按钮被点击了！', type: 'INFO' });
  },
});
```

#### registerShortcut

```javascript
PluginAPI.registerShortcut({
  label: '显示 Hello World',
  key: 'h',
  ctrlKey: true,
  shiftKey: true,
  fn: () => {
    PluginAPI.showSnack({
      msg: 'Hello World！',
      type: 'INFO',
    });
  },
});
```

#### registerHook

```javascript
// 当前可用的钩子：
// - 'currentTaskChanged'
// - 'taskCreated'
// - 'taskUpdated'
// - 'taskRemoved'
// - 'taskDone'
// - 'taskUnDone'
// - 'globalTaskProgress'

PluginAPI.registerHook('currentTaskChanged', (task) => {
  if (task) {
    console.log('当前任务已更改：', task.title);
  }
});

PluginAPI.registerHook('taskCreated', (task) => {
  console.log('新任务已创建：', task.title);
});
```

#### 插件后端（execNodeScript 和 fetch）

**注意：** 启动时 Node 桥接尚未就绪。如果你的插件在加载时立即调用 `execNodeScript` 或 `fetch`，请使用 `plugin.onReady()`（参见下面的最佳实践章节）。

```javascript
// 使用 Node.js 后端执行脚本
const result = await PluginAPI.execNodeScript(`
  const fs = require('fs');
  const files = fs.readdirSync('.');
  return files;
`);
console.log('文件列表：', result);

// 使用 Node.js HTTP 栈发起 HTTP 请求（不经过 Electron 代理配置）
const response = await PluginAPI.fetch('https://api.example.com/data');
const data = await response.json();
```

## 最佳实践

### 1. 使用确定性 ID

确保定期任务和重复元素使用确定性 ID 以防止同步冲突。

```javascript
// 好——基于日期计算的确定性 ID
const taskId = `myplugin_${projectId}_${dateString}`;

// 避免——非确定性 ID
const taskId = Math.random().toString();
```

### 2. 优雅处理错误

```javascript
try {
  const tasks = await PluginAPI.getTasks();
  // 处理任务数据
} catch (error) {
  PluginAPI.showSnack({
    msg: `获取任务失败：${error.message}`,
    type: 'WARNING',
  });
}
```

### 3. 使用 plugin.onReady() 处理 Node.js 启动竞态条件

如果你的插件需要在启动时使用 `execNodeScript` 或 `fetch`，使用 `plugin.onReady()`：

```javascript
// 等待 Node 桥接就绪后再执行
plugin.onReady(async () => {
  // 此时 Node 后端已就绪
  const result = await PluginAPI.execNodeScript(`return process.version;`);
  console.log('Node 版本：', result);

  // 也适用于 fetch
  const response = await PluginAPI.fetch('https://api.example.com/health');
  const data = await response.json();
  console.log('API 健康状态：', data);
});
```

`plugin.onReady(fn)` 在 `plugin.js` 完全评估完毕 **且** 应用确认 Node.js IPC 桥接已响应后触发（带自动重试）。如果重试后桥接仍不可用，插件管理界面会显示错误，且 `onReady` 不会触发。

你也可以将 `onReady` 用于任何其他应在插件脚本完成钩子和注册设置后运行的启动工作——不仅限于 `nodeExecution`。

**Iframe 插件：** `plugin.onReady()` 在 iframe 插件中也可用，但它会在 `plugin.js` 评估完成后的下一个微任务触发——不进行 IPC 桥接 ping 检查。实践中这没有问题，因为 iframe 插件在用户导航时渲染（远在宿主启动之后，此时桥接已经可用）。如果你的 iframe 插件在 `onReady` 中需要桥接，它将是可用的；冷启动竞态条件仅影响宿主端插件代码。

### 4. 不要滥用日志

应尽量少用 `console.log`。

### 5. Iframe 插件：所有内容内联

1. **所有内容内联**：CSS 和 JavaScript 必须在 HTML 文件中

```html
<!-- 好：所有内容内联 -->
<!DOCTYPE html>
<html>
  <head>
    <style>
      /* 所有样式写在这里 */
    </style>
  </head>
  <body>
    <div id="app"></div>
    <script>
      // 所有 JavaScript 写在这里
    </script>
  </body>
</html>
```

## 安全考虑

### 沙箱机制

- JavaScript 插件在隔离的 VM 上下文中运行
- Iframe 插件在受限的沙箱化 iframe 中运行
- 除非通过 API，否则无法访问文件系统

### API 限制

在 iframe 上下文中，以下方法 **不** 可用：

- `registerHeaderButton()`
- `registerMenuEntry()`
- `registerSidePanelButton()`
- `registerShortcut()`
- `registerHook()`
- `execNodeScript()`

### 内容安全策略

- iframe 中禁止外部脚本/样式
- 仅允许同源资源
- 内联脚本必须在 HTML 文件内部

## 测试你的插件

### 1. 本地开发

1. 使用"从文件夹加载插件"来测试你的插件
2. 打开开发者工具（F12 或 Ctrl+Shift+i）查看控制台日志
3. 以 API 测试插件为参考

### 2. 调试技巧

```javascript
// 添加调试日志
const DEBUG = true;

function log(...args) {
  if (DEBUG) {
    console.log('[MyPlugin]', ...args);
  }
}

// 测试 API 方法
async function testAPI() {
  log('正在测试 getTasks...');
  const tasks = await PluginAPI.getTasks();
  log('任务：', tasks);

  log('正在测试 showSnack...');
  PluginAPI.showSnack({
    msg: 'API 测试成功！',
    type: 'SUCCESS',
  });
}
```

### 3. 常见问题

**插件未加载：**

- 检查 manifest.json 语法
- 验证 minSupVersion 兼容性
- 在控制台中查找错误

**API 方法失败：**

- 检查该方法在当前上下文中是否可用
- 验证 manifest 中的权限设置
- 如果在启动或冷启动时 `executeNodeScript` 失败，将你的初始化代码包装在 `plugin.onReady(async () => { ... })` 中——这能确保在代码运行前 Node.js 桥接已就绪

**Iframe 未显示：**

- 检查所有资源是否已内联
- 验证无外部依赖
- 在控制台中查找 CSP 违规

## 资源

- **插件 API 类型**：[@super-productivity/plugin-api](https://www.npmjs.com/package/@super-productivity/plugin-api)
- **插件模板**：[boilerplate-solid-js](../packages/plugin-dev/boilerplate-solid-js)
- **示例插件**：[plugin-dev](../packages/plugin-dev)
- **社区插件**：
  - [counter-tester-plugin](https://github.com/Mustache-Games/counter-tester-plugin) —— 作者 [Mustache Dev](https://github.com/Mustache-Games)
  - [sp-reporter](https://github.com/dougcooper/sp-reporter) —— 作者 [dougcooper](https://github.com/dougcooper)

## 贡献

如果你创建了一个有用的插件，可以考虑：

1. 在 Reddit 或 GitHub discussions 上发布相关内容
2. 提交 PR 将其添加到社区插件列表（即将推出）

祝你插件开发愉快！🚀

## 额外：氛围编程（Vibe Coding）你的插件

### 小贴士

- 不要在真实数据上测试！请使用测试实例！（如果你不知道如何获取，可以使用 https://test-app.super-productivity.com/）
- 尽可能具体
- 概述你的插件应使用哪些 API
- 测试错误（`Ctrl+Shift+i` 打开控制台），反复迭代直到工作。不要指望一次就能成功。
- 阅读代码！不要盲目信任。

### 示例

```md
你能帮我写一个 Super Productivity 插件吗？每次我点击头部按钮时播放一个蜂鸣声（你需要通过 PluginAPI.registerHeaderButton 添加一个头部按钮）。

文档在此：https://github.com/super-productivity/super-productivity/blob/master/docs/plugin-development.md

不要使用指南中未列出的任何 PluginAPI 方法。

请将输出提供为可供下载的扁平 zip 文件。
```
