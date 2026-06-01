# 计划：将 Electron 从 37.10.3 升级至 40.8.3

> **状态：已计划**
> **最后更新：2026-03-23**（综合研究评审）

## 背景

Super Productivity 在 Linux 上以 AppImage、deb、snap、rpm 形式分发，并在 Flathub 上有一个社区维护的 Flatpak 包。此前两次升级尝试（2025 年 10 月尝试 Electron 38，2025 年 12 月尝试 Electron 39）均因 **Snap 在 Wayland 上崩溃**而失败并回滚。

**Electron 37 已停止维护**（自 2026 年 1 月 13 日起）。这次升级是安全性和支持生命周期的必要举措，而不仅是功能需求。

**Snap 崩溃的根本原因：** Electron 38+ 将 `--ozone-platform` 默认设置为 `auto`（原生 Wayland）。electron-builder 的 snap 模板硬编码了过时的 `gnome-3-28-1804` 运行时，缺少现代 GNOME 模式（`font-antialiasing`）和 Mesa 驱动，导致崩溃。相关追踪见 [electron-builder#9452](https://github.com/electron-userland/electron-builder/issues/9452)（仍未关闭，无上游修复）。问题 [#8548](https://github.com/electron-userland/electron-builder/issues/8548)（core22/core24 支持）已于 2026 年 3 月 19 日**以"未计划"关闭**。

**macOS Tahoe 说明：** 问题 [#5712](https://github.com/super-productivity/super-productivity/issues/5712) 请求此次升级以修复 macOS Tahoe 上的卡慢问题。然而，特定的 GPU 修复（Electron PR #48376，`_cornerMask` 覆写）已反向移植到 **Electron 37.6.0**——我们当前使用的 37.10.3 已包含此修复。2026 年 3 月持续报告的冻结问题是 **macOS Tahoe 系统级内存管理问题**，影响所有应用（Safari、Firefox、Chrome、VS Code on E39），并非 Electron 特有的问题。升级仍然出于停止维护/安全原因而必要，但不应宣传为修复 macOS Tahoe 冻结问题的方案。

**策略：** Snap 采用双管齐下的方法：(1) 通过插件覆写（plug override）升级 gnome 运行时（Tidal HiFi 模式），(2) 在代码中保留防御性的 X11 覆写。对于 Flatpak：向 Flathub 清单提交独立的 PR。

---

## 研究总结（2026 年 3 月）

### 生态系统快照

| 应用                   | Electron    | Snap 策略                                          | Flatpak 运行时                          | Wayland         |
| ---------------------- | ----------- | -------------------------------------------------- | --------------------------------------- | --------------- |
| VS Code                | **39.8.3**  | Classic，通过包装器强制 X11                         | N/A                                     | Snap 中为 X11   |
| Obsidian               | **39.7.0**  | N/A                                                | **25.08**，包装器控制 Wayland           | Flatpak 中自动  |
| Bitwarden              | **39.2.6**  | Strict/core22，allowNativeWayland=true             | N/A                                     | Snap 中有问题   |
| Element                | **41.0.2**  | N/A                                                | **25.08**                               | Flatpak 中自动  |
| Signal                 | N/A         | core24 + gnome 扩展（自定义 snapcraft.yaml）       | **25.08**                               | 自动            |
| Joplin                 | **38.x**    | core24 + gnome 扩展（自定义 snapcraft.yaml）       | **25.08**                               | 已启用          |
| Tidal HiFi             | **40.7.0**  | **core22 + gnome-42-2204 插件覆写**                | N/A                                     | 已启用          |
| Teams-for-Linux        | **39.8.2**  | core22，通过 executableArgs 强制 X11                | N/A                                     | Snap 中为 X11   |
| **Super Productivity** | **37.10.3** | core22，allowNativeWayland=true，gnome-3-28-1804    | **24.08**                               | 强制禁用        |

### 关键发现

- **生态系统共识是 Electron 39.x。** 40.8.3 是合理的向前看目标版本。
- **Tidal HiFi 解决了 snap 运行时问题**，方法是在 electron-builder.yaml 中将 `gnome-3-28-1804` 插件覆写指向 `gnome-42-2204`。该方案已在生产环境中验证，可在 core22 上使用 strict 限制模式（strict confinement）正常工作。
- **Signal 和 Joplin 使用自定义 snapcraft.yaml 文件**并带有 `gnome` 扩展——更具前瞻性，但需要更改构建管道。
- **SP 的 Flathub 清单落后于同行：** 运行时 24.08（对比 25.08），1 行包装脚本（对比 Obsidian 的 85 行），通过 `--unset-env=XDG_SESSION_TYPE` 强制禁用 Wayland。
- **计划中的 `protocol.handle` 迁移代码存在致命的无限递归 bug**（现已修复）。
- **Node.js 22→24 的跳升**对 SP 代码库是安全的。唯一真正的风险：OpenSSL 3.5 将最小 RSA 密钥大小提高到 2048 位（影响使用旧服务器证书的用户）。

### 过往尝试

1. **Electron 38（2025 年 10 月）：** 25+ 次提交尝试了各种 Mesa 驱动、环境变量、snap 中的 plugs 配置。全部失败。回滚（提交 `6486b41bd9`）。
2. **Electron 39（2025 年 12 月）：** 通过 `app.commandLine.appendSwitch('ozone-platform', 'x11')` 全局强制所有 Linux 使用 X11。次日回滚（提交 `6e60bde789`）——在 Wayland 上仍然崩溃。
## Plan Overview

| Item                          | Details                                                                 |
| ----------------------------- | ----------------------------------------------------------------------- |
| **Target version**            | Electron 40.8.3                                                         |
| **Chromium**                  | 136                                                                     |
| **Node.js**                   | 24 (up from 22)                                                         |
| **V8**                        | 13.6                                                                    |
| **Target electron-builder**   | 26.0.0 (latest)                                                         |
| **Target electron-updater**   | 7.2.0                                                                   |
| **Key migration risk**        | Snap crashing on Wayland；macOS Tahoe 系统级冻结（非 Electron 特有）    |
| **Key Snap fix**              | gnome-3-28-1804 → gnome-42-2204 插件覆写                                |
| **Key Flatpak fix**           | 运行时 24.08 → 25.08；重新启用 Wayland                                   |

### 所需的 Breaking Changes 修复

| # | Breaking Change                    | 影响范围                        | 修复策略                                      |
| - | ---------------------------------- | ------------------------------- | --------------------------------------------- |
| 1 | `webUtils.getPathForFile`（替代 `file.path`） | Electron 专用 IPC 处理程序      | 在 IPC 处理程序中将 `file` 对象转换为路径     |
| 2 | `protocol.handle`（替代 `protocol.registerFileProtocol`） | 自定义协议处理程序（super-productivity://） | 迁移至 `protocol.handle`；修复了无限递归 bug |
| 3 | `app.getPath('userData')` 现在返回真实路径（无 `~`） | 配置文件路径                    | 检查是否有路径比较逻辑依赖短格式 `~`          |
| 4 | `SafeStorage` 加密变更            | 加密的存储值                    | 解密后重新加密；自动迁移                      |
| 5 | `nativeTheme.themeColorSource`（替代 `nativeTheme.shouldUseDarkColors`） | 主题检测                        | 搜索使用 `.shouldUseDarkColors` 的代码        |

---

## 逐步升级流程

### 步骤 1：更新 package.json

```json
{
  "devDependencies": {
    "electron": "^40.8.3",
    "electron-builder": "^26.0.0",
    "electron-updater": "^7.2.0"
  }
}
```

然后运行：

```bash
npm install
```

### 步骤 2：处理 Breaking Changes

**1. `webUtils.getPathForFile`（替代 `file.path`）**

*哪里使用：* Electron 特定的 IPC 处理程序通过 `file.path` 访问文件。
*修复：* 使用 `webUtils.getPathForFile(file)` 替代 `file.path`。
*验证：* `rg "file\.path" src/` ——在带有 `File` 类型参数的处理程序中应无匹配项。
*Electron 38+ 文档：* `webUtils.getPathForFile` 在 Electron 38 中引入。

**2. `protocol.handle`（替代 `protocol.registerFileProtocol`）**

*哪里使用：* `src/app/core/electron/electron.service.ts` ——为 `super-productivity://` 注册。
*修复：*

```typescript
// 之前
protocol.registerFileProtocol('super-productivity', (request, callback) => {
  callback({ path: request.url.replace('super-productivity://', '') });
});

// 之后
protocol.handle('super-productivity', (request) => {
  const filePath = request.url.replace('super-productivity://', '');
  return net.fetch('file://' + filePath);
});
```

*验证：* 检查 `rg "registerFileProtocol"` ——应无匹配项。

**3. `app.getPath('userData')` 返回真实路径**

*哪里可能有问题：* 如果代码将 `.replace('~', homedir)` 或其他规范化逻辑应用于此路径。
*修复：* `rg "getPath.*userData"` ——检查调用者是否依赖于 Unix 风格的 `~` 简写。
*验证：* 路径应已解析为 `/home/user/.config/super-productivity/` 等格式。

**4. `SafeStorage` 加密变更**

*影响：* 已存储的加密值需要重新加密。我们目前的 Electron 37 加密值在 40 中可能无法正确解密。
*我们是否使用 SafeStorage：* `rg "safeStorage"` 和 `rg "safeStorage"`。
*修复：* 创建自动迁移——尝试用旧密钥解密，如失败则重新加密。在 `app.getPath('userData')` 中存储一个"已迁移"标记。

**5. `nativeTheme.themeColorSource`**

*哪里使用：* `rg "shouldUseDarkColors"` ——在主题服务或 Electron 主进程中。
*修复：* 使用新 API，保留向后兼容的 getter 封装器。

### 步骤 3：更新 Snap 配置（关键路径）

**文件：** `electron-builder.yml`

*添加 gnome-42-2204 插件覆写：*

```yaml
snap:
  plugs:
    - gnome-3-28-1804  # electron-builder 默认
    - gnome-42-2204    # 覆写以获得现代运行时 + Mesa
  environment:
    # 防御性 X11 覆写——如果 Wayland 失败则回退
    DISABLE_WAYLAND: "1"
```

或者（使用显式插件映射，更符合 Tidal HiFi 模式）：

```yaml
snap:
  plugs:
    - default: gnome-3-28-1804
    - gnome-42-2204:gnome-42-2204
```

*验证：* 在构建后运行 `snap connections superproductivity` 以检查 `gnome-42-2204` 是否已连接。

**如果 auto-connect 失败：** 在 [forum.snapcraft.io/c/store-requests](https://forum.snapcraft.io/c/store-requests) 提交 auto-connect 授权请求。

### 步骤 4：更新主进程代码

**文件：** `src/app/core/electron/electron.service.ts`

### 步骤 5：更新 Flatpak 配置

**文件：** 外部 Flathub 仓库（此处为文档记录）

1. 将运行时从 `org.gnome.Platform//24.08` 改为 `//25.08`
2. 删除 Wayland 禁用代码（移除 `--unset-env=XDG_SESSION_TYPE`）
3. 更新 Flatpak 包装脚本以通过包装器标志控制 Wayland（参考 Obsidian 模式）
4. 测试并提交 PR

### 步骤 6：更新 electron-updater

`electron-updater` 7.2.0 与 Electron 40 兼容。如果当前是 6.x，则将其更新。注意任何与发布工件命名或 `latest.yml` / `latest-mac.yml` 生成相关的配置变更。

### 步骤 7：构建与测试

1. 在所有 electron-builder 目标上运行 `npm run dist`：deb、AppImage、snap、rpm、macOS（Intel + Apple Silicon）、Windows（NSIS）
2. 验证 snap 构建——关键路径：
   - 构建后运行 `snap connections superproductivity`
   - 在 Wayland 会话上测试——应用启动无崩溃
   - 在 X11 会话上测试——应用正常启动
7. 验证 GPU 缓存清理：在升级后首次启动时检查日志中是否有"Cleared GPUCache"消息
8. 验证空闲检测：确认日志显示正确的方法（X11 上为 powerMonitor，GNOME Wayland 上为 gdbus）
9. **macOS Tahoe 浸入测试：** 在 macOS 26.x 上运行 30 分钟以上并积极使用。验证无 GPU 延迟。（注意：系统级冻结是 Apple 的 bug，非我们造成。）
10. **TLS 连接测试：** 测试 Jira、WebDAV 和同步服务器连接，验证无 OpenSSL 回归问题。

---

## 发布计划

### 1. GitHub Pre-release / Beta 标签

推送标记为 pre-release 的 GitHub 发布（例如 `v18.0.0-beta.1`）。这样可提供直接的 `.deb`、`.AppImage`、`.snap`、`.flatpak` 工件，不影响稳定渠道。

### 2. Snap Beta 渠道

```bash
snapcraft upload --release=beta super-productivity_*.snap
```

**上传后的关键检查：**

```bash
# 在干净系统上安装并验证自动连接
snap install super-productivity --channel=beta
snap connections superproductivity
# 查找：gnome-3-28-1804  gnome-42-2204:gnome-42-2204  -
```

如果自动连接失败，在 [forum.snapcraft.io/c/store-requests](https://forum.snapcraft.io/c/store-requests) 提交请求。

### 3. Flathub 清单更新

向 Flathub 仓库提交 PR，升级运行时至 25.08 并重新启用 Wayland（步骤 9）。此项独立于 Electron 升级，可并行进行。

### 4. 行动号召

- **GitHub Issue**——更新 #5712，说明变更内容，澄清 macOS Tahoe 的情况
- **特别请求 Snap 用户在 Wayland 上测试**——这是风险最高的场景
- **请求 macOS Tahoe 用户测试**——以确认没有新的回归问题（即使原始 bug 已修复）

---

## 未来考虑

### 自定义 snapcraft.yaml（长期）

gnome-42-2204 插件覆写是一种务实的变通方案。长期解决方案是在 core24 上使用带有 `extensions: [gnome]` 的**自定义 snapcraft.yaml**，参照 Signal Desktop 和 Joplin。这将提供：

- 自动的 gnome-46-2404 运行时 + mesa-2404 GPU 驱动
- 正确的 `desktop-launch` 命令链
- 不依赖 electron-builder 已停止维护的 snap 模板

这将涉及使用 electron-builder 的 `--dir` 目标并用自定义 snapcraft.yaml 包装输出。当 core24 经过充分测试或 electron-builder 的模板成为更大负担时，值得实施。

### Electron 41+

Electron 41（2026 年 3 月 10 日发布）带来了改进的 Wayland 支持：无边框窗口阴影、扩展的调整大小边界、所有配置下的 CSD。一旦 40.8.3 经过验证，升级到 41.x 将是一个更小、风险更低的变更。

---

## 参考资料

- [electron-builder#9452：Electron 38+ 在 Wayland 上 Snap 崩溃](https://github.com/electron-userland/electron-builder/issues/9452)
- [electron-builder#8548：core22/core24 支持（已关闭，未计划）](https://github.com/electron-userland/electron-builder/issues/8548)
- [Tidal HiFi gnome-42-2204 插件覆写](https://github.com/Mastermindzh/tidal-hifi/blob/master/build/electron-builder.base.yml)
- [Signal Desktop snapcraft.yaml（core24 + gnome 扩展）](https://github.com/snapcrafters/signal-desktop/blob/master/snap/snapcraft.yaml)
- [gnome-42-2204 全局自动连接授权](https://forum.snapcraft.io/t/autoconnect-request-for-gnome-42-2204/30290)
- [VS Code snap electron-launch 包装器](https://github.com/microsoft/vscode/blob/main/resources/linux/snap/electron-launch)
- [Obsidian Flatpak 包装器（黄金标准）](https://github.com/flathub/md.obsidian.Obsidian/blob/master/obsidian.sh)
- [Element Desktop Flatpak 包装器](https://github.com/flathub/im.riot.Riot/blob/master/element.sh)
- [Signal Desktop Flatpak 清单](https://github.com/flathub/org.signal.Signal)
- [Super Productivity Flathub 清单](https://github.com/flathub/com.super_productivity.SuperProductivity)
- [Electron 40 发布说明](https://www.electronjs.org/blog/electron-40-0)
- [Electron 41 发布说明](https://www.electronjs.org/blog/electron-41-0)
- [Electron 破坏性变更](https://www.electronjs.org/docs/latest/breaking-changes)
- [Electron 停止维护日期](https://endoflife.date/electron)
- [Node.js 22→24 迁移指南](https://nodejs.org/en/blog/migrations/v22-to-v24)
- [macOS Tahoe cornerMask 修复（Electron PR #48376）](https://github.com/electron/electron/pull/48376)
- [macOS Tahoe 系统级内存问题（MacRumors）](https://forums.macrumors.com/threads/macos-tahoe-windowserver-memory-pressure-over-long-uptimes-anyone-else-seeing-this.2476977/)
- [ShameElectron 追踪器](https://avarayr.github.io/shamelectron/)
- [Snapcraft GNOME 扩展文档](https://documentation.ubuntu.com/snapcraft/stable/reference/extensions/gnome-extension/)
- [Flatpak Electron 文档](https://docs.flatpak.org/en/latest/electron.html)
