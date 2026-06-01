# Mac App Store 代码签名指南

> **相关 macOS 文档：**
> - [build-and-publish-notes.md](./build-and-publish-notes.md) — 构建/发布工作流程（截图、iOS、Windows 签名）
> - [update-mac-certificates.md](./update-mac-certificates.md) — 年度证书更新

本文档说明 Super Productivity 的 Mac App Store（MAS）代码签名设置和故障排除。涵盖了证书/配置文件（provisioning profile）不匹配的完整解决方案。

## 概述

Mac App Store 构建要求以下三者之间精确匹配：

1. electron-builder 使用的**代码签名证书**
2. **配置文件中嵌入的证书**

任何不匹配都会导致 Apple 验证失败，出现类似以下错误：

```
Invalid Code Signing. The executable '...' must be signed with the certificate
that is contained in the provisioning profile.
```

## 根本问题（及解决方案）

### 问题原因

我们的钥匙串中有**两个分发证书**：

1. `Apple Distribution: Johannes Millan (363FAFK383)` — 指纹 `968086...`（现代）
2. `3rd Party Mac Developer Application: Johannes Millan (363FAFK383)` — 指纹 `3731BEC0...`（旧版）

**当两者都存在时，Electron-builder 总是优先选择"Apple Distribution"而非"3rd Party Mac Developer Application"**，无论环境变量或配置设置如何。

我们的配置文件包含旧版"3rd Party Mac Developer Application"证书，但 electron-builder 使用"Apple Distribution"签名 → **不匹配** → **验证失败**。

### 解决方案

**创建使用现代"Apple Distribution"证书的新配置文件**，以匹配 electron-builder 想要使用的证书。

## 逐步设置

### 1. 验证你的证书

检查钥匙串中有哪些证书：

```bash
security find-identity -v -p codesigning | grep -E "Apple Distribution|3rd Party"
```

你应该看到：

- `Apple Distribution: Johannes Millan (363FAFK383)` — 指纹 `968086...`
- `3rd Party Mac Developer Application: Johannes Millan (363FAFK383)` — 指纹 `3731BEC0...`

### 2. 创建新配置文件

前往 [Apple Developer Portal - Profiles](https://developer.apple.com/account/resources/profiles/list)：

1. 点击 **+** 创建新配置文件
2. 选择：**Distribution** → **Mac App Store Connect**
3. **关键**：在选择证书时，选择：

   - ✅ **"Johannes Millan (Distribution)"** — 显示"For use in Xcode 11 or later"
   - ❌ 不是 "Johannes Millan (Mac App Distribution)"

   **为什么这很重要：**

   - "Johannes Millan (Distribution)" = 现代"Apple Distribution"证书 → electron-builder 将使用它 ✅
   - "Johannes Millan (Mac App Distribution)" = 旧版"3rd Party Mac Developer Application" → 会导致不匹配 ❌

4. 选择 App ID：`com.super-productivity.app`
5. 下载为 `mas.provisionprofile`

### 3. 验证配置文件

检查配置文件中包含哪个证书：

```bash
python3 << 'EOF'
import plistlib
import subprocess
import hashlib
# ...（完整脚本参见英文原文）
EOF
```

### 4. 更新本地文件

```bash
cp ~/Downloads/mas.provisionprofile tools/mac-profiles/mas.provisionprofile
```

### 5. 更新 GitHub Actions Secret

```bash
base64 -i tools/mac-profiles/mas.provisionprofile -o /tmp/mas-profile.b64
cat /tmp/mas-profile.b64 | pbcopy
```

然后更新 GitHub Actions 密钥：

1. 前往：https://github.com/super-productivity/super-productivity/settings/secrets/actions
2. 找到 `mas_provision_profile`
3. 点击 **Update**
4. 粘贴 base64 编码的内容
5. 点击 **Save**

### 6. 本地测试

```bash
cp tools/mac-profiles/mas.provisionprofile embedded.provisionprofile
npm run dist:mac:mas:buildOnly 2>&1 | grep -E "signin|error|warn"
```

### 故障排除

**验证失败：签名证书与配置文件不匹配**

**解决方案：** 使用 electron-builder 正在使用的证书（通常是 Apple Distribution）创建新配置文件。

**构建上传成功，但在 App Store Connect 中无法选择**

常见原因：
1. **仍在处理中** — Apple 需要 5-30 分钟处理构建
2. **缺少出口合规** — 对于具有加密功能的应用需要
3. **版本/构建号已使用** — 检查 `package.json` 版本
4. **平台不匹配** — 确保从正确的平台标签页选择

## 证书类型参考

| Apple Portal 名称                       | Portal 描述                  | 内部名称                           | Electron-builder 偏好 | 用途              |
| --------------------------------------- | ---------------------------- | ----------------------------------- | --------------------- | ----------------- |
| "Johannes Millan (Distribution)"        | "For use in Xcode 11 or later" | Apple Distribution                | ✅ 首选               | MAS 构建（现代）  |
| "Johannes Millan (Mac App Distribution)"| 无特殊描述                   | 3rd Party Mac Developer Application | ❌ 旧版               | MAS 构建（旧版）  |
| "Developer ID Application"              | N/A                          | Developer ID Application            | N/A                   | 直接下载 DMG      |

## 年度证书更新

当证书过期时（每年），请按照以下步骤操作：

1. **在 Apple Developer Portal 创建新证书**
2. **使用新证书创建新配置文件**
3. **将所有证书导出为 PKCS#12**
4. **更新 GitHub Actions secrets**
5. **推送前本地测试**

## 快速诊断命令

```bash
# 检查可用证书
security find-identity -v -p codesigning

# 检查 electron-builder 将使用什么
npm run dist:mac:mas:buildOnly 2>&1 | grep "signing.*platform=mas"

# 检查配置文件证书
security cms -D -i tools/mac-profiles/mas.provisionprofile | \
  plutil -p - | grep -A 5 "DeveloperCertificates"

# 验证构建包
pkgutil --check-signature .tmp/app-builds/mas-universal/*.pkg
```

## 总结

✅ **成功的关键：** 确保你的配置文件使用 **"Apple Distribution"** 证书（现代"Distribution"类型），而不是旧版"3rd Party Mac Developer Application"证书，因为当两者都可用时，electron-builder 总是优先使用 Apple Distribution。

❌ **不起作用的做法：** 尝试通过环境变量或配置选项强制 electron-builder 使用旧版证书 — 它会忽略这些设置，仍然使用 Apple Distribution。
