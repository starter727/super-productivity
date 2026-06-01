# 支持旧版 Android WebView

## 当前的防护措施

- 该应用当前通过 src/index.html 中的 UA（用户代理）检查，阻止报告 Chrome <110 的 WebView。这避免了运行时崩溃，但这种方法脆弱，因为 UA 格式会变化，且当缺失的功能仅是一个可通过 polyfill（兼容性填充）解决的 API 时，该防护措施仍会隐藏应用。
- 在 Angular 启动之前，使用能力探针（例如检查 Promise、Intl、模块支持），可以让处于临界状态的引擎尝试启动，同时在缺少必要功能时仍然显示升级提示。

## 旧版构建的成本

- Angular CLI 20 在工作区级别将项目配置为 	arget: "ES2022" 和 module: "preserve"，这意味着新构建默认采用现代语法。[^1]
- 官方 CLI 工具已完全移除了差分加载（differential loading）——不再有生成面向旧版浏览器的 ES5 包的选项，因为 Angular 不再支持需要 ES5 的引擎。[^2]
- Chrome 在 61 版本才原生支持模块，因此早于该版本的 WebView 无法解析我们今天发布的 <script type="module"> 输出。[^3]
- 降级编译需要并行工具链（Babel/SWC 转换、旧版 HTML 入口、SystemJS 或类似方案），以及大量现代 API 的 polyfill（Promise.allSettled、Intl、Clipboard）。维护成本和包体积将为所有用户增加。

## 平台现状

- Android 5.0（Chromium M37）是第一个将 WebView 层解耦，使其可通过 Google Play 更新的版本。[^4] 运行更旧操作系统版本的设备将永久停留在出厂时的 WebView；任何应用端的更改都无法使其现代化。
- 即使在 Android 5–7 的设备上，预装的 WebView 版本也往往落后于安全和功能更新，因此我们将需要在 Android 生态系统已不再测试的引擎上进行持续的 QA（质量保障）。

## 实际的替代方案

1. **冻结的旧版 APK**：托管一个已知可用的、仍以 ES5 为目标的升级前构建版本，明确标记为不受支持，并在兼容性警告中添加链接以供数据访问。
2. **原生防护屏幕**：将兼容性警告移入 Capacitor/Electron 引导过程，使用户在 Angular 启动前就能看到操作说明（更新 WebView、侧载旧版构建、导出数据）。
3. **数据逃生通道**：推广导出和同步选项，使使用受限设备的用户能够将数据迁移到新硬件，而不是等待应用端的修复。

这条路径让主应用专注于官方支持的 Baseline（基线）浏览器，同时为使用受限 WebView 的用户提供合理的选择。

[^1]: Angular CLI 工作区模板默认设置了 	arget: "ES2022" 和 module: "preserve"，突显了现代基线要求。来源：[ngular/angular-cli, packages/schematics/angular/workspace/files/tsconfig.json.template](https://raw.githubusercontent.com/angular/angular-cli/main/packages/schematics/angular/workspace/files/tsconfig.json.template)。

[^2]: Angular CLI 变更日志条目："差分加载支持已被移除——现已没有 Angular 官方支持的浏览器需要 ES5 代码。"来源：[ngular/angular-cli, CHANGELOG.md](https://raw.githubusercontent.com/angular/angular-cli/main/CHANGELOG.md#L6926)。

[^3]: MDN 浏览器兼容性数据将 Chrome/Chrome Android 61 列为首批支持 <script type="module"> 的版本。来源：[mdn/browser-compat-data, html/elements/script.json](https://raw.githubusercontent.com/mdn/browser-compat-data/main/html/elements/script.json)。

[^4]: Android 5.0 发布说明引入了可通过 Google Play 更新的 WebView 层。来源：[Android Developers——Android 5.0 行为变更](https://developer.android.com/about/versions/lollipop#webview)。