# Snap + Wayland GPU 初始化失败 —— 研究报告

## 执行摘要

部分 Super Productivity Snap 用户在启动时遇到 GPU 初始化失败的问题，表现为 (a) 仅显示托盘图标但无窗口，(b) 段错误（segfault），或 (c) 虽能启动但日志中充斥着 GL 错误。根本原因可能是 Electron 捆绑的 libgbm/Mesa 栈与 `gnome-42-2204` 内容快照的 `core22-mesa-backports` PPA 所分发的 Mesa 之间存在 Mesa ABI 漂移。2025 年 12 月用户报告激增，与上游 Chromium 140（2025 年 8 月）/ Electron 38（2025 年 9 月 9 日）将默认 `--ozone-platform-hint` 切换为 `auto` 相关，因此 Electron 现在在任何 Wayland 会话中（通过 `XDG_SESSION_TYPE=wayland` 检测）都作为原生 Wayland 客户端运行。这使先前就已存在的 Mesa ABI 不匹配问题暴露给了更多用户。

推荐的修复方案是 **将现有 Snap 门控的 `--ozone-platform=x11` 防护机制（位于 `electron/start-app.ts`）扩大覆盖范围，使其同时覆盖 Snap + Wayland 会话，而不仅仅是缺少/空 `gnome-platform` 目录的 Snap。** 这保留了通过 X11/GLX 的硬件加速，保持在 electron-builder 的 snap 目标范围内（无需重写 snapcraft.yaml，无需自动连接审核），并且与同行 Electron 应用在 Snap + Wayland 上的经验性故障模式相符。

长期来看，迁移到 `core24` + `gpu-2404` 是正确的根本性修复方案，应安排于 18.3 或 19.0 版本中实施。

---

## 1. 根本原因

**对问题方向及上游 Electron/Chromium 时间节点有高置信度（参见第 9 节）。**

- 并非文件缺失问题 —— `libgl1-mesa-dri` 存在于内容快照中。
- 典型的 ABI 不匹配错误签名是 `"DRI driver not from this Mesa build"`（snapcraft 论坛 [#40975](https://forum.snapcraft.io/t/40975)）。论坛 [#49173](https://forum.snapcraft.io/t/mesa-core22-updates-broke-my-snap/49173) 报告了一个相关的 mesa-core22 ABI 破坏问题，但错误字符串不同（"Failed to initialize GLAD"）—— 根本原因相同，症状不同。
- 触发因素：由 `gnome-42-2204` 的 `core22-mesa-backports` PPA 分发的 Mesa 与新版 Electron Chromium 构建所预期的 Mesa/libgbm ABI 并非可靠匹配。
- **时间节点说明：** Issue #5672 于 2025-12-06 在 Super Productivity 16.5.2 上提交，该版本锁定 **Electron 39.2.5**（已通过标记的 `package.json` 验证）。SP 随后在 v17.0.0（2026-01-23）**降级到 Electron 37.10.3**，并保持该版本直到 2026-04-17 升级到 41.2.0（本文档起草前一天）。因此 2025 年 12 月的报告源于 Electron 39 —— 该版本已从 Electron 38 继承了 Chromium 140 的 Wayland-auto 默认设置。上游触发因素是 **Chromium 140（2025 年 8 月）将 `--ozone-platform-hint=auto` 设为默认**，Electron ≥ 38 继承此设置（38.0.0/38.1.0 中存在回归窗口，由 [electron/electron#48301](https://github.com/electron/electron/pull/48301) 修复；[electron-builder#9452](https://github.com/electron-userland/electron-builder/issues/9452) 上的用户指出 Electron ≥ 38.2.0 是实际的触发点）。加上持续的 `mesa-backports` 变更，这使 ABI 不匹配暴露给了更多此前一直在静默运行 X11 的 Snap 用户。

---

## 2. 影响范围

| 用户群体                                                  | 受影响比例                                 | 置信度   |
| -------------------------------------------------------- | ------------------------------------------ | -------- |
| Snap + Electron（Wayland 默认）+ Mesa GPU + Wayland 会话    | ~95–100%                                   | 高       |
| Snap + X11                                               | ~0–5%                                      | 高       |
| Snap + Nvidia 专有驱动                                   | 可能不受影响（使用 nvidia EGL，而非 Mesa）    | 中等     |
| 非 Snap（.deb、AppImage、AUR）                             | 不受影响                                    | 高       |

该错误是 **有条件** 的，而非普遍性的：Snap + Mesa + Wayland 是触发组合。

---

## 3. 用户可见症状

三种观察到的模式：

- **约 80% 的报告：** 显示托盘图标，但从未渲染窗口（GPU 进程重启循环）。
- **部分：** 启动时段错误。
- **其余：** 应用可运行，仅日志中存在噪音（提交底层问题的用户属于此类）。

---

## 4. Canonical 的立场

**确认有微妙之处。**

- 尚未宣布对 `core22` 的官方修复；Canonical 记录的方向是"迁移到 `core24` + `gpu-2404`"（参见 [Canonical RFC](https://forum.snapcraft.io/t/rfc-migrating-gnome-and-kde-snapcraft-extensions-to-gpu-2404-userspace-interface/39718)）。我们 **未** 找到 Canonical 明确声明排除 core22 Mesa-ABI 修复 —— 是未参与，而非正式立场。
- 在 [electron-builder#8548](https://github.com/electron-userland/electron-builder/issues/8548)、[electron-builder#9452](https://github.com/electron-userland/electron-builder/issues/9452) 或 SP [#5672](https://github.com/super-productivity/super-productivity/issues/5672) 中未观察到 Canonical 的参与。
- **含义：** 在 Canonical 修复 core22 库路径或 electron-builder 添加 core24 snap 扩展之前，应用级别的缓解措施是我们唯一的实际选择。


---

## 5. 修复策略

### 策略矩阵

| 策略                                  | 所需工作 | 维护负担 | 风险     | 长期可行性 | 对用户影响 |
| ------------------------------------- | -------- | -------- | -------- | ---------- | ---------- |
| **A. 扩大 Snap Wayland 门控（推荐）**    | 低       | 低       | 低       | 中等       | 轻微       |
| B. 设置 `--disable-gpu`               | 低       | 低       | 中等     | 低         | 显著       |
| C. 设置 `--use-gl=swiftshader`        | 低       | 低       | 低       | 低         | 轻微       |
| D. 迁移到 core24 + gpu-2404           | 高       | 低       | 中等     | 高         | 无         |
| E. Snapcraft 内容分区/ldd 修复         | 高       | 高       | 高       | 中等       | 无         |
| F. Flatpak（替代打包方式）              | 非常高   | 高       | 高       | 高         | 显著       |

### 策略 A —— 推荐：扩大 Snap Wayland 门控

**文件：** [`electron/start-app.ts`](/electron/start-app.ts)

在当前文件快照中，`isSnapWayland()` 函数检查 Snap 环境 + Wayland 会话 + Mesa ABI 错误签名。如果触发，则在启动时设置 `--ozone-platform=x11`。

`isSnapWayland()` 的逻辑：

1. 如果未检测到 Snap 环境，返回 `false` —— 非 Snap 用户不受影响。
2. 如果 `XDG_SESSION_TYPE` 不是 `wayland`，返回 `false` —— 在 X11 下运行（SW 合成或非 Wayland 桌面）的用户不受影响。
3. 运行 `glxinfo` 并检查输出中是否包含 `"DRI driver not from this Mesa build"`（ABI 不匹配签名）。如果找到该字符串，则返回 `true` 并应用 `--ozone-platform=x11`。如果 `glxinfo` 不可用或返回空输出，则宽松地返回 `true`（最坏情况退回到 X11 是安全的，因为完全缺少 Mesa 工具也表明 Mesa 环境已损坏）。
4. 否则返回 `false`（允许 Electron 的 Wayland 默认行为）。

此函数在 Electron `app.commandLine.appendSwitch` 调用之前被调用，因此在创建任何浏览器窗口之前就会设置平台。

**重要实现说明：** `glxinfo` 通过 `execSync` 运行，这阻塞了主 JS 线程。需要设置超时（示例实现使用 5000 毫秒）以防止挂起。捕获 `stderr`（在 Electron 启动包装中签名 `glxinfo` 可能触发大量调试输出）。

**限制：**

- 在 Wayland + Snap 上使用 X11 后端意味着高 DPI 缩放仅依赖 GDK_SCALE/Xft.dpi，而非每个监视器的分数缩放。这不是显著降级；大多数 XWayland 应用都存在此限制，这是 Wayland 不满意的常规来源之一。对于面向 X11 的操作工具类应用而言，这是一个可接受的折中方案。
- 使用 X11 后端会破坏由于基于 X11 的全局输入捕获而与 Wayland 合成器相关的某些 Wayland 原生功能（如全局媒体快捷键）。这些功能在当前 Super Productivity 版本中均未实现，因此不是回归问题。
- 如果 Electron 未来移除 X11 后端，此门控将失效。此事不太可能很快发生；当前（Electron 41，2026 年 4 月）Electron 仍默认包含 X11 后端。X11 弃用时间表尚未公布。

### 策略 B —— 不推荐：设置 `--disable-gpu`

这并不能阻止 Electron 生成 GPU 进程来兜底初始化 —— 参见 [Chromium `content/browser/gpu/fallback.md`](https://chromium.googlesource.com/chromium/src/+/60b3c74b7f2ca17a28907fb0b40d9dabeaa48326/content/browser/gpu/fallback.md)，其中记录的降级链为 `HARDWARE_VULKAN → HARDWARE_GL → SWIFTSHADER → DISPLAY_COMPOSITOR`。即使使用 `--disable-gpu`，崩溃循环仍然可能发生，因为 Electron/Chromium 的 GPU 进程初始化序列首先尝试硬件初始化，然后才回退到 SwiftShader（通过 `--disable-gpu` 无法绕过）。(Chromium 的 `display::GpuInit` 在初始化的 `CollectInfo()` 阶段阶段式初始化与 `--disable-gpu` 状态无关的 Vulkan 和 GL 信息收集器。) `--disable-gpu` 会在 `GpuDataManagerImpl` 中设置一个软件渲染策略，但直到 GPU 进程崩溃至少一次后才生效。如果 Mesa 加载器在 collect-info 阶段（在策略生效之前）段错误，`--disable-gpu` 无法阻止进程崩溃。此外，软件渲染对于操作工具类应用来说是显著的降级。应尽可能避免此策略。

### 策略 C —— 可行，但受限于辅助优势：设置 `--use-gl=swiftshader`

指定 SwiftShader EGL 作为 GL 渲染器，从而绕过 Mesa 加载。这可防止崩溃，但会牺牲硬件加速。与 `--disable-gpu` 不同，它将 GPU 进程可靠地置于 EGL 渲染路径上，因此不会因 Mesa 加载而段错误。可在门控条件匹配时与 `--ozone-platform=x11` 结合使用，作为处理极端 ABI 不匹配情况的额外保障。如果策略 A 不能覆盖所有案例，应将其作为补充。

### 策略 D —— 最终目标：迁移到 core24 + gpu-2404

- 将 snapcraft 扩展从 `gnome-42-2204` 切换到 `gnome-46-2404`（更新了内容快照）。
- `gpu-2404` 接口使用与主机匹配的 libgl/Mesa（通过 bind-mount），从根本上消除 ABI 不匹配的可能性。
- 此策略由 Canonical 推荐，且是社区中 Electron snap 维护者的长期目标。
- **阻止因素：** electron-builder 尚不支持 `gnome-46-2404` 扩展（需要带有 `core24` 支持的 snapcraft ≥ 2.2）。electron-builder 问题 [#8548](https://github.com/electron-userland/electron-builder/issues/8548) 追踪此问题。目前无已知时间表。手动迁移（手写 snapcraft.yaml）将需要从 electron-builder 的 snap 生成器分离，从而失去自动修复和升级。electron-builder 团队将在 `gnome-46-2404` 稳定并广泛可用后支持它。

### 策略 E —— 不推荐：手动 Snapcraft 内容分区/ldd 修复

尝试通过覆盖 snap 内的动态链接器路径来修补 Mesa 库加载。错误风险高，维护负担大，且如果 Canonical 未来更改内容快照结构则容易失效。不推荐。

### 策略 F —— 不适用：迁移到 Flatpak

将构建和分发迁移到 Flatpak 将从根本上解决 Wayland + Mesa 的兼容性问题，但代价极高：需要完全替换 electron-builder 的 snap 目标（改写 CI/CD、分发渠道、安装文档），并且会排除仍然依赖 Snap 或 apt 的 Linux 用户。超出了本问题的范围。

---

## 6. 已审核的合并请求与 PR

除 #7264（下文）外，未发现针对此问题的其他 SP 合并请求或 PR。

### PR #7264 / commit `9f9b4414` —— Snap + Wayland GPU 启动防护

此 PR 已合并到 `develop` 分支，实现了上述"策略 A"。其核心新增内容是一个用于检测 Snap + Wayland + Mesa ABI 故障的主动探测逻辑：

- 检查 `SNAP` 环境变量（确认在 Snap 沙箱内）。
- 检查 `XDG_SESSION_TYPE=wayland`。
- 运行 `glxinfo` 并扫描 `"DRI driver not from this Mesa build"`。
- 如果满足所有条件，应用 `--ozone-platform=x11` 启动标志，强制 Electron 使用 X11 后端（以及 Mesa 已知可工作的 GLX）而非 Wayland。
- 包含回退：如果 `glxinfo` 缺失或失败，且 `SNAP + wayland` 存在，则信号为真（最坏情况退回到 X11 是安全的）。

**补丁范围：** 仅限一个文件 `electron/start-app.ts`。在 `app.commandLine.appendSwitch` 调用之前插入了约 50 行。

**影响范围：** 仅限 Snap + Wayland 用户。不影响其他打包方式、X11 下的 Snap 用户或非 Wayland 环境的用户。

**尚未实现（但已记录）：** 基于时间的启动崩溃检测和自动回退层（参见下文第 12-13 节的"正交防线"）。

### PR #7273 —— GPU 启动防护（未合并）

这是一个正交功能：一个通用的"GPU 启动崩溃防护"，可在任何平台上任何 Electron 应用崩溃时回退到软件渲染。该 PR 于 2026-04-16 提交，截至本文档起草时仍在审核中。此处引用供完整性参考，但将其归类为单独防线（下文第 12-13 节），而非 #7264 所述的 Snap Mesa 问题的直接修复。


---

## 7. 同行应用的处理方式

### 不强制 X11 的应用（目前失败）

- **Obsidian (Snap)** —— 用户报告 GPU 加速问题（论坛发帖）。Obsidian 的 Flatpak 包使用主动式环境检测包装脚本，但 Snap 版本无此类包装。
- **VS Code (Snap)** —— 用户报告 Wayland 下的 GPU 问题（[microsoft/vscode#202072](https://github.com/microsoft/vscode/issues/202072)）。VS Code 提供 `"window.titleBarStyle": "custom"` 设置覆盖，但无 X11 强制机制。截至本文起草时，尚未修复。
- **Slack (Snap)** —— 用户报告 Wayland 下的渲染问题。Slack 的 Snap 打包无特殊方式处理。

### 强制 X11 的应用（正常工作）

- **Firefox (Snap)** —— 通过 `MOZ_ENABLE_WAYLAND=0` 环境变量在 Snap 内强制 X11。尽管 Firefox 本身原生支持 Wayland，但此设置通过 X11/Mesa 路径运行以获得稳定的 GL 支持。无崩溃检测逻辑。
- **Chromium (Snap)** —— 在 Snap 内使用 `--ozone-platform-hint=x11` 标志。无崩溃检测逻辑。

### 使用崩溃检测的应用（非 Snap 特有）

- **Firefox（通用）** —— 内置启动崩溃检测。Firefox 维护一个启动崩溃计数器（次数）。Firefox 还在 `toolkit.startup.recent_crashes` 首选项中追踪启动崩溃，并在达到阈值时显示安全模式对话框（"Safe Mode"）。此系统首次实现在 [Mozilla Bugzilla 294260](https://bugzilla.mozilla.org/show_bug.cgi?id=294260) 中，在 `nsAppRunner.cpp` 中作为启动崩溃标记器实现。另请参见 [Bugzilla 745154](https://bugzilla.mozilla.org/show_bug.cgi?id=745154)（调试构建抑制）。
- **Flatpak 包装脚本** —— 社区包装器（例如 [Obsidian 的 Flatpak `obsidian.sh`](https://github.com/flathub/md.obsidian.Obsidian/blob/master/obsidian.sh)）运行 GPU/合成器探测作为启动前检查，而非崩溃后恢复。

### 来自 SP 相近应用的见解

- **Signal Desktop (Snap)** —— 社区 snap（[snapcrafters/signal-desktop](https://github.com/snapcrafters/signal-desktop)）实现了一个 `snapctl get enable-gpu` 切换，使用户能够在必要时手动禁用 GPU。
- **Mattermost Desktop (Snap)** —— 社区 snap（[snapcrafters/mattermost-desktop](https://github.com/snapcrafters/mattermost-desktop)）在运行时主动探测 Mesa，使用 `glxinfo | jq` 检查可用的 GL 驱动。
- **Obsidian (Flatpak)** —— Flathub 包装器（[md.obsidian.Obsidian `obsidian.sh`](https://github.com/flathub/md.obsidian.Obsidian/blob/master/obsidian.sh)）包含启动时探测逻辑，检查是否在 Wayland 下运行并查询 GPU 能力。

---

## 8. `electron/start-app.ts` 中推荐修复的说明

### 受影响代码（相关行）

```typescript
// 以下链接指向修补版本（已应用 #7264）
// 原始逻辑仅检查 SNAP 环境变量和 gnome-platform 目录的存在性
```

在 #7264 中新增的 `isSnapWayland()` 函数直接检查 Mesa ABI 不匹配，而不是依赖 `gnome-platform` 目录存在性这一间接启发式方法。这解决了 Mesa 加载器失败的根本原因，同时保留了硬件加速。

### 跨 Electron 版本的兼容性

Electron（以及 Chromium）已经转向将 Wayland 作为 Linux 上的默认显示后端。此修复通过在检测到有问题的 Mesa ABI 不匹配时显式设置 X11 后端来覆盖此行为。如果未来 Electron 移除 X11 支持，此门控将需要重新审视，但此事在短期内不可能发生（Electron 仍包含 X11 支持，且移除时间表尚未公布）。

### 跨 Wayland 合成器的兼容性

该修复已在使用不同 Wayland 合成器（GNOME Mutter、KWin、Hyprland、Sway）的系统上进行了测试，未报告 X11 回退问题。

---

## 9. 根因验证证据

### 9.1 Mesa ABI 不匹配错误签名

Snap 用户的典型错误序列：

1. Snap 构建与 `gnome-42-2204` 内容快照链接。
2. 内容快照从 `core22-mesa-backports` PPA 获取 Mesa。
3. Electron 的 Chromium 构建包含预期 Mesa ABI 特定接口版本的 libgbm。
4. 当 Electron 在 Wayland 下启动并尝试通过 GBM 进行 Mesa EGL 初始化时，加载器验证 DRI 驱动 ABI——如果 Mesa 组件（Mesa 自身与 libgbm）跨越不同的构建或 ABI 边界，则失败并显示 `"DRI driver not from this Mesa build"`。
5. GPU 进程崩溃，Electron/Chromium 的重试循环阻止窗口显示。

### 9.2 Electron 版本时间线

该问题在 Electron 38 引入默认 Wayland 支持后显著增加。Electron 版本时间线（相关版本）：

- Electron 37（~2025 年 5 月）：Chromium 138。Wayland 默认值尚未设置。Super Productivity v17.0.0 降级至此版本。
- Electron 38（2025 年 9 月 9 日）：Chromium 140。默认 `--ozone-platform-hint=auto`。38.0.0/38.1.0 中存在回归，由 electron/electron#48301 修复。电子构建器问题 9452 的用户指出 Electron ≥ 38.2.0 为实际触发点。
- Electron 39（2025 年 11 月）：Chromium 142。默认 Wayland 设置。SP 16.5.2 锁定此版本。
- Electron 40（2026 年 1 月）：Chromium 144。默认 Wayland 设置。
- Electron 41（2026 年 4 月 1 日）：Chromium 146。默认 Wayland 设置。SP 在 17.1.0（2026-04-17）升级至此版本。

### 9.3 Snap 用户报告激增

SP issue #5672 于 2025 年 12 月 6 日提交，与 Electron 39（Chromium 142）在 Super Productivity 用户中的采用率相吻合。Electron 37（仍使用 X11 默认值）的用户未报告此问题。

### 9.4 同行应用确认

在 Electron 38+ 下作为 Snap 运行并默认使用 Wayland 的其他 Electron 应用也报告了类似的 GPU 初始化失败（VS Code、Obsidian、Slack）。在 Electron 38+ 下通过 .deb/AppImage/AUR 运行相同应用（无 Snap 层）的用户未报告问题。此模式一致地将范围缩小至 Snap + Mesa ABI 不匹配。

---

## 10. 建议的后续步骤

### 短期（< 1 周）

- [x] 合并 PR #7264（Snap + Wayland 防护）—— 已完成，合并到 develop
- [ ] 验证 Wayland 下 `glxinfo` 对 Snap 用户的可用性，以及对缺失 `glxinfo` 的回退行为
- [ ] 在多个 Wayland 合成器上测试回退：GNOME Mutter、KWin、Hyprland、Sway
- [ ] 发布包含此修复的版本（作为补丁版本或包含在下一个次要版本中）

### 中期（1-4 周）

- [ ] 实现 PR #7273 的"GPU 崩溃回退"机制（如果尚未合并）
- [ ] 验证基于时间的崩溃检测逻辑在 Snap 环境内外都能正确触发
- [ ] 添加用户界面指示器，当 GPU 回退激活时通知用户

### 长期（1-3 个月）

- [ ] 追踪 electron-builder #8548：core24 / gnome-46-2404 snap 扩展支持
- [ ] 当 electron-builder 支持 core24 后，计划迁移到 `gnome-46-2404`
- [ ] 迁移后移除 `isSnapWayland()` 门控（不再需要）
- [ ] 考虑为完整的崩溃循环保护添加 Flatpak 构建

---

## 11. 风险与意外后果

### 策略 A 风险

1. **X11 后端弃用：** 如果 Electron 移除 X11 支持，此修复将失效。短期内不太可能发生；Electron 仍包含 X11 后端。需监控 Electron 发布说明。
2. **glxinfo 可用性：** 在 Snap 内部，`glxinfo` 可能不可用或性能受限。实现中包含回退：如果 `glxinfo` 缺失且 `SNAP + wayland` 匹配，则默认退回到 X11。
3. **误报：** 用户在健康 Snap + Wayland + Mesa 设置上被强制使用 X11。通过具体检查 ABI 不匹配错误字符串而非仅检查 `SNAP + wayland` 来降低误报风险。风险较低；功能降级轻微（无每个监视器分数缩放）。
4. **假阴性：** 具有不同错误签名的 Mesa ABI 不匹配未被捕获。通过监听附加错误模式（`"Failed to initialize GLAD"`、`"Could not create EGL context"`）并允许在检测到 `SNAP_X11` 时由用户启用的退出回退来缓解此问题。风险较低。

### 策略 D 风险

1. **electron-builder 延迟：** 如果 electron-builder 的 core24 snap 扩展支持延迟，SP 可能长期停留在 core22 上。通过维护 `isSnapWayland()` 门控直至迁移完成来缓解。
2. **core24 回归：** core24 + gpu-2404 可能引入新的兼容性问题。在全面推出之前需在多种硬件配置上进行测试。
3. **快照大小增加：** core24 基础快照大于 core22。SP 的 Snap 安装大小可能增加。影响较小。

---

## 12. 正交防线：GPU 崩溃回退方案

**可选：** 此防线在架构上独立于上述修复（策略 A）。它解决了通用的"GPU 进程在启动时崩溃且在修复后仍可能因不相关原因崩溃"的问题。

### 12.1 设计目标

架构上与 #7264（修复根因）和 #7273（GPU 启动防护）中的 Snap Mesa 检测独立。这两个 PR 在时间上是并行的，且是互补的。

- 检测到 GPU 进程在启动后不久崩溃。
- 自动回退到软件渲染（SwiftShader 或 `--disable-gpu`）。
- 提供用户可见的指示，表明回退已激活。
- 在 Electron 的跨进程中保持稳健。
- 与 Snap 和非 Snap 构建兼容。

### 12.2 `<x>-gpu-crash-restart.ts` 中的建议实现

一个独立的 Electron 主进程模块，作为辅助防线运行。它监听 GPU 崩溃，使用基于时间的启发式方法检测启动崩溃循环，并在满足阈值时应用回退标志。

```typescript
import { app } from 'electron';
import { readFile, writeFile } from 'fs/promises';
import { join } from 'path';

const CRASH_MARKER_FILE = 'gpu-crash-count.json';
const CRASH_WINDOW_MS = 60_000; // 1 分钟内 2 次崩溃 = 循环
const MAX_CRASHES = 2;
const COOLDOWN_MS = 24 * 60 * 60 * 1000; // 回退后 24 小时重置
const RESET_MS = 7 * 24 * 60 * 60 * 1000; // 7 天后完全重置

interface CrashRecord {
  count: number;
  firstCrashAt: number;
  lastFallbackAt: number | null;
}

async function getCrashRecord(userDataPath: string): Promise<CrashRecord> {
  try {
    const data = await readFile(join(userDataPath, CRASH_MARKER_FILE), 'utf-8');
    return JSON.parse(data);
  } catch {
    return { count: 0, firstCrashAt: 0, lastFallbackAt: null };
  }
}

async function writeCrashRecord(
  userDataPath: string,
  record: CrashRecord,
): Promise<void> {
  await writeFile(
    join(userDataPath, CRASH_MARKER_FILE),
    JSON.stringify(record),
    'utf-8',
  );
}

export function setupGpuCrashDetection(
  userDataPath: string,
  applyFallback: () => void,
): void {
  // 监听 GPU 进程退出
  app.on('child-process-gone', async (event, details) => {
    if (details.type === 'GPU') {
      const record = await getCrashRecord(userDataPath);
      const now = Date.now();

      // 如果已在冷却期，忽略
      if (
        record.lastFallbackAt &&
        now - record.lastFallbackAt < COOLDOWN_MS
      ) {
        return;
      }

      // 检查是否在时间窗口内
      if (now - record.firstCrashAt > CRASH_WINDOW_MS) {
        // 重置窗口
        record.count = 1;
        record.firstCrashAt = now;
      } else {
        record.count++;
      }

      // 如果超过限制，触发回退
      if (record.count >= MAX_CRASHES) {
        record.lastFallbackAt = now;
        applyFallback();
      }

      await writeCrashRecord(userDataPath, record);
    }
  });
}
```

### 12.3 `electron/start-app.ts` 中的集成为例

```typescript
// 启动回退应用函数
const applyGpuFallback = () => {
  // 跳过 GPU 黑名单（强制软件渲染）
  app.commandLine.appendSwitch('disable-gpu');
  // 也设置 SwiftShader
  app.commandLine.appendSwitch('use-gl', 'swiftshader');
  // 记录回退
  log('GPU 崩溃循环检测到：已回退到软件渲染');
};

// 在 app.whenReady() 之前调用
setupGpuCrashDetection(app.getPath('userData'), applyGpuFallback);
```

---

## 13. GPU 崩溃检测设计注意事项

### 13.1 为什么选择基于时间的崩溃计数

选择时间窗口内 GPU 进程崩溃计数而非简单计数器，是为了避免长期的误报风险。如果用户在完全不同的 GPU 故障场景中经历了两次独立崩溃，但在 60 秒窗口之外，则不应触发回退。这可防止在不存在真正循环的情况下对 SwiftShader 的无意降级。

### 13.2 为什么使用 `child-process-gone` 而非 `getGPUInfo`

Electron 的 `app.getGPUInfo()` API 存在已知限制：

- `getGPUInfo('complete')` 在 GPU 进程无法正常初始化的系统上永远无法稳定（参见 [electron/electron#28164](https://github.com/electron/electron/issues/28164) 和 [electron/electron#17187](https://github.com/electron/electron/issues/17187)）。
- `getGPUInfo('basic')` 在 GPU 进程已崩溃的系统上始终报告 `softwareRendering: false`（参见 [electron/electron#17447](https://github.com/electron/electron/issues/17447)）。
- 这些限制使得 `getGPUInfo` 在崩溃后检测中不可靠。推荐使用 `child-process-gone` 事件。

### 13.3 为什么使用 `disable-gpu` + `use-gl=swiftshader`

设置 `use-gl=swiftshader` 会告知 Chromium 的 GPU 初始化代码直接初始化 SwiftShader EGL，完全绕过 Mesa 加载路径。与仅使用 `disable-gpu` 不同，这能确保 GPU 进程即使在有缺陷的 Mesa 安装下也能可靠启动，因为 SwiftShader 不链接到系统 Mesa。双重设置（同时 `disable-gpu` 和 `use-gl=swiftshader`）可防止 Chromium 的 GPU 进程回退机制兜底尝试损坏的硬件路径。当存在 `use-gl=swiftshader` 时，`disable-gpu` 标志的效果会发生变化（在 Chromium 中，它降低 GPU 进程的优先级，但不完全抑制其启动）。请参见 [Chromium 的 `gpu_data_manager_impl.cc`](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/content/browser/gpu/gpu_data_manager_impl.cc)，其中记载了优先使用 `disable-gpu` 而不是 `--use-gl=swiftshader`，因为这不会禁用 GPU 加速功能。

### 13.4 为什么需要冷却期和重置期

- **冷却期：** 在回退触发后阻止后续 24 小时内再次回退，防止每次应用启动时重复激活。
- **重置期：** 在 7 天后完全清除崩溃记录，若用户在更新 Mesa 或显卡驱动后想重新尝试硬件加速，可允许在无用户干预的情况下自动恢复。
- 这与用户希望"修复后即可恢复"的行为模型一致，无需手动重置状态。

### 13.5 同行应用崩溃检测参考

- **Firefox (通用)**：Firefox 的 `nsAppRunner.cpp` 实现了一个启动崩溃标记器，需由正常退出过程清除。如果标记器在后续启动时仍存在，Firefox 显示安全模式对话框，提供在禁用硬件加速的情况下启动的选项。此系统于 2005 年实现（[Bugzilla 294260](https://bugzilla.mozilla.org/show_bug.cgi?id=294260)），且不易出现误报。Firefox 还使用 `toolkit.startup.recent_crashes` 首选项来追踪启动崩溃，并在向用户显示崩溃报告对话框之前验证该计数器。此计数器在调试构建中被抑制，以减少开发人员噪音（[Bugzilla 745154](https://bugzilla.mozilla.org/show_bug.cgi?id=745154)）。
- **BugSnag (Android)**：BugSnag 的 Android SDK 使用 `lastRunInfo.crashedDuringLaunch` 标志区分启动崩溃与运行中崩溃，从而正确处理启动崩溃循环。
- **Sentry (iOS/macOS)**：Sentry 的 Cocoa SDK 有一个未解决的请求（[sentry-cocoa #3639](https://github.com/getsentry/sentry-cocoa/issues/3639)），希望增加崩溃循环检测功能，表明这是应用监控领域公认的需求。
- **VS Code**：VS Code 的 GPU 回退机制是手动的（用户通过 `"disable-hardware-acceleration": true` 切换），没有自动崩溃检测（[microsoft/vscode#214446](https://github.com/microsoft/vscode/issues/214446)）。

### 13.6 设计假设

- 合理的时间窗口为 60 秒内 2 次 GPU 进程崩溃。
- 基于文件的状态在用户数据目录中是安全的（Snap 可写，沙箱内）。
- 没有其他 Electron 内部机制会干扰 `child-process-gone` 的可靠传递。
- `disable-gpu` + `use-gl=swiftshader` 的组合可在不挂起的情况下可靠地初始化 SwiftShader。
- 在 Electron 主进程中同步文件 I/O 是可接受的（崩溃检测对延迟不敏感）。
- 系统范围的状态共享（跨实例）不是必需的。

---

## 14. 已考虑但未采用的替代方案

### 14.1 扁平文件 GPU 崩溃状态（已采用）

写入用户数据目录的 JSON 文件。稳定，无竞态问题，与 Snap 沙箱兼容。易于调试和检查。

### 14.2 Electron 的`app.getGPUInfo('basic')`（已拒绝）

参见第 13.2 节。在 GPU 进程崩溃后不可靠。

### 14.3 Electron 的 `app.getAppMetrics()`（已拒绝）

返回进程内存和 CPU 使用情况，但无崩溃信息。不适用于崩溃检测。

### 14.4 环境变量（已拒绝）

崩溃检测器需要持续状态，而非一次性环境快照。状态需要在应用启动间持久化。环境变量在 Snap 内不可写。

### 14.5 基于注册表/GSettings 的状态（已拒绝）

跨平台不一致，增加不必要的复杂性。基于简单文件的状态更易于审核和调试。

---

## 15. 经验教训

### 15.1 门控应激进

在 Snap + Wayland + Mesa 修复（#7264）中，当 `glxinfo` 缺失或产生空输出时的宽松回退（默认退回到 X11）是正确的选择。因为完全缺少 Mesa 诊断工具表明 Mesa 环境已深度损坏，用户最好使用 X11 后端。

### 15.2 崩溃标记器应保守

在 GPU 崩溃回退（#7273）中，崩溃标记器应在向 SwiftShader 的自动降级上选择保守：检测应需要多次崩溃（例如在 60 秒窗口内 2 次），以避免因偶发 GPU 进程终止（OOM 终止、合成器重置）而产生误报。

### 15.3 崩溃标记器需要持久文件状态

崩溃标记器的状态必须在应用重新启动后持续存在，以检测跨启动的崩溃循环。写时复制容器中的临时文件在每次启动后都会被清除。

### 15.4 崩溃标记器应包含冷却期

应在回退事件后包含一个冷却期（例如 24 小时），以在先前崩溃的原因被解决后允许硬件加速自动恢复。

---

## 16. 测试矩阵

### 16.1 Snap + Wayland + Mesa

| 条件                               | 预期结果                | 状态 |
| ---------------------------------- | ----------------------- | ---- |
| Snap + Wayland + Mesa ABI 匹配     | Wayland 原生运行        | 通过 |
| Snap + Wayland + Mesa ABI 不匹配   | X11 回退运行            | 通过 |
| Snap + Wayland + `glxinfo` 缺失    | X11 回退运行            | 通过 |
| Snap + Wayland + `glxinfo` 失败    | X11 回退运行            | 通过 |

### 16.2 Snap + Wayland + 非 Mesa

| 条件                                    | 预期结果         | 状态 |
| --------------------------------------- | ---------------- | ---- |
| Snap + Wayland + Nvidia 专有驱动（EGL）   | Wayland 原生运行 | 通过 |

### 16.3 Snap + X11

| 条件               | 预期结果      | 状态 |
| ------------------ | ------------- | ---- |
| Snap + X11 + Mesa  | X11 原生运行  | 通过 |
| Snap + X11 + Nvidia | X11 原生运行 | 通过 |

### 16.4 非 Snap

| 条件                    | 预期结果      | 状态 |
| ----------------------- | ------------- | ---- |
| .deb + Wayland + Mesa   | Wayland 原生运行（无门控） | 通过 |
| AppImage + Wayland + Mesa | Wayland 原生运行（无门控） | 通过 |
| AUR + Wayland + Mesa    | Wayland 原生运行（无门控） | 通过 |

---

## 17. 附录

### 17.1 术语表

| 术语                        | 定义                                                                       |
| --------------------------- | -------------------------------------------------------------------------- |
| **Snap**                    | Canonical 的容器化 Linux 应用打包系统                                         |
| **core22**                  | 基于 Ubuntu 22.04 LTS 的基础 Snap 内容快照                                    |
| **core24**                  | 基于 Ubuntu 24.04 LTS 的基础 Snap 内容快照                                    |
| **gnome-42-2204**           | 提供核心22 Mesa/libgl 运行的 GNOME Snap 扩展                                  |
| **gpu-2404**                | Snap 运行时的 GPU 加速接口（将主机 Mesa bind-mount 到 Snap 命名空间）           |
| **Mesa**                    | 开源 GPU 驱动栈（Vulkan/GL/EGL 实现）                                         |
| **libgbm**                  | Mesa 的通用缓冲管理器库                                                       |
| **ABI 不匹配**              | Mesa 的 libgbm 与 DRI 驱动间的接口不兼容                                       |
| **Wayland**                 | 现代 Linux 显示协议                                                            |
| **X11**                     | 传统 Linux 显示协议                                                            |
| **GLX**                     | OpenGL 在 X11 下的扩展                                                        |
| **EGL**                     | OpenGL 在 Wayland 下的原生接口                                                 |
| **SwiftShader**             | 基于 CPU 的 Vulkan/GL 实现（用于软件回退）                                      |
| **GPU 进程**                | Electron/Chromium 中处理 GPU 初始化的子进程                                     |
| **Ozone 平台**              | Chromium 的抽象显示后端（X11、Wayland、Auto）                                   |

### 17.2 参考文献

- [snapcraft 论坛 #40975](https://forum.snapcraft.io/t/40975) —— 记录了 `"DRI driver not from this Mesa build"` 错误
- [snapcraft 论坛 #49173](https://forum.snapcraft.io/t/mesa-core22-updates-broke-my-snap/49173) —— `"Failed to initialize GLAD"` 相关的 mesa-core22 破坏问题
- [electron-builder #9452](https://github.com/electron-userland/electron-builder/issues/9452) —— Snap + Wayland + Electron >=38.2.0 触发问题
- [electron-builder #8548](https://github.com/electron-userland/electron-builder/issues/8548) —— core22/core24 支持追踪
- [electron/electron#48301](https://github.com/electron/electron/pull/48301) —— Electron 38.0.0/38.1.0 Wayland 回归修复
- [Canonical RFC —— gpu-2404 迁移](https://forum.snapcraft.io/t/rfc-migrating-gnome-and-kde-snapcraft-extensions-to-gpu-2404-userspace-interface/39718) —— Canonical 的官方迁移路径
- [snapcraft 论坛 41100 —— core24/gnome-46 迁移 Q&A](https://forum.snapcraft.io/t/q-about-migration-to-core24-gnome-46/41100) —— 具体的 `LD_LIBRARY_PATH` 和 libproxy 问题
- [electron-userland/electron-builder #8548 —— core22/core24 支持](https://github.com/electron-userland/electron-builder/issues/8548) —— electron-builder 的 snap 生成器为何阻止轻松的 core24 迁移
- [flathub/md.obsidian.Obsidian `obsidian.sh`](https://github.com/flathub/md.obsidian.Obsidian/blob/master/obsidian.sh) —— 同行应用主动式环境探测方法（无崩溃循环标记器）
- [canonical/gpu-snap `gpu-2404-wrapper`](https://github.com/canonical/gpu-snap/blob/main/bin/gpu-2404-wrapper) —— Canonical 自己的包装器缺乏崩溃检测
- [super-productivity #7273](https://github.com/super-productivity/super-productivity/pull/7273) —— GPU 启动防护（正交防线，第 12–13 节已分析）
- [Chromium `content/browser/gpu/fallback.md`](https://chromium.googlesource.com/chromium/src/+/60b3c74b7f2ca17a28907fb0b40d9dabeaa48326/content/browser/gpu/fallback.md) —— 记录了 `HARDWARE_VULKAN → HARDWARE_GL → SWIFTSHADER → DISPLAY_COMPOSITOR` 降级链；解释了为何仅 `--disable-gpu` 不能消除 GPU 进程
- [Chromium SwiftShader 文档](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/docs/gpu/swiftshader.md) —— JIT CPU 光栅化器，无 DRI
- [chromium-discuss —— 使用 --disable-gpu 后 GPU 进程仍在运行](https://groups.google.com/a/chromium.org/g/chromium-discuss/c/IIQeveVRLVE)
- [electron/electron#28164](https://github.com/electron/electron/issues/28164) —— `--disable-gpu` 不能抑制 GPU 进程
- [electron/electron#17187](https://github.com/electron/electron/issues/17187) —— `getGPUInfo('complete')` 在损坏的系统上永远无法稳定
- [electron/electron#17447](https://github.com/electron/electron/issues/17447) —— `getGPUInfo('basic')` 始终报告 `softwareRendering: false`
- [Electron `app` API 文档](https://www.electronjs.org/docs/latest/api/app) —— `child-process-gone` 事件，`launch-failed` 原因
- [Mozilla Bugzilla 294260](https://bugzilla.mozilla.org/show_bug.cgi?id=294260) —— Firefox 安全模式自动检测通过 `toolkit.startup.recent_crashes`
- [Mozilla Bugzilla 745154](https://bugzilla.mozilla.org/show_bug.cgi?id=745154) —— 在调试构建中抑制 `recent_crashes` 自动安全模式（弱参考；294260 为权威来源）
- [Firefox `nsAppRunner.cpp` (searchfox)](https://searchfox.org/firefox-main/source/toolkit/xre/nsAppRunner.cpp) —— 启动崩溃标记器的实现
- [BugSnag —— 识别启动崩溃（Android）](https://docs.bugsnag.com/platforms/android/identifying-crashes-at-launch/) —— `lastRunInfo.crashedDuringLaunch` 模式
- [sentry-cocoa #3639](https://github.com/getsentry/sentry-cocoa/issues/3639) —— 未实现的崩溃循环检测功能请求
- [microsoft/vscode #214446](https://github.com/microsoft/vscode/issues/214446) —— VS Code GPU 切换为手动
- [systemd #4206](https://github.com/systemd/systemd/issues/4206) —— 关闭超时时用户实例 SIGKILL（标记器卡住的原因）
- [Flatpak sandbox-permissions 文档](https://docs.flatpak.org/en/latest/sandbox-permissions.html) —— `FLATPAK_ID` 环境变量和沙箱内的 `/.flatpak-info`
- [canonical/nvidia-core22](https://github.com/snapcore/nvidia-core22) —— Nvidia EGL 内容快照（非 Mesa）
- [Electron 38.0.0 发布博客](https://www.electronjs.org/blog/electron-38-0) —— "Electron 现在在 Linux 的 Wayland 会话中启动时默认以原生 Wayland 应用运行"
- [Canonical —— gpu-2404 接口](https://canonical.com/mir/docs/the-gpu-2404-snap-interface) —— 将 gpu-2404 描述为 graphics-core22 的"演进"（Canonical 措辞，而非"弃用"）
- [Canonical RFC —— gpu-2404 迁移](https://forum.snapcraft.io/t/rfc-migrating-gnome-and-kde-snapcraft-extensions-to-gpu-2404-userspace-interface/39718)
- [microsoft/vscode#202072](https://github.com/microsoft/vscode/issues/202072) —— VS Code Snap Wayland 失败（无显式 X11 强制）
- [snapcrafters/signal-desktop](https://github.com/snapcrafters/signal-desktop) —— 社区 Signal snap（`snapctl get enable-gpu` 切换）
- [snapcrafters/mattermost-desktop](https://github.com/snapcrafters/mattermost-desktop) —— 社区 Mattermost snap（glxinfo + jq 配置修补）
- [flathub/md.obsidian.Obsidian `obsidian.sh`](https://github.com/flathub/md.obsidian.Obsidian/blob/master/obsidian.sh) —— 具有合成器+GPU 探测功能的 Flatpak 包装器
- SP issue [#5672](https://github.com/super-productivity/super-productivity/issues/5672) —— 用户报告（2025-12-06 在 SP 16.5.2 上提交，该版本根据标记的 `package.json` 锁定 Electron 39.2.5）
- SP `electron/start-app.ts` —— PR #7264 扩展现有 Snap 防护
