# Mac App Store 代码签名指南

> **相关 macOS 文档：**
>
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

result = subprocess.run(['security', 'cms', '-D', '-i', 'tools/mac-profiles/mas.provisionprofile'],
                      capture_output=True)
plist_data = plistlib.loads(result.stdout)

cert_data = plist_data['DeveloperCertificates'][0]
fingerprint = hashlib.sha1(cert_data).hexdigest().upper()

with open('/tmp/cert.der', 'wb') as f:
    f.write(cert_data)

result = subprocess.run(['openssl', 'x509', '-in', '/tmp/cert.der', '-inform', 'DER',
                        '-noout', '-subject'],
                       capture_output=True, text=True)

print("配置文件中的证书：")
print(result.stdout)
print(f"指纹: {fingerprint}")
print(f"\n期望: 968086560EC4643B4192E7755CBF7D6E009334F4 (Apple Distribution)")
EOF
```

**期望输出：**

```
配置文件中的证书：
subject=UID=363FAFK383, CN=Apple Distribution: Johannes Millan (363FAFK383), ...
指纹: 968086560EC4643B4192E7755CBF7D6E009334F4
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
npm run dist:mac:mas:buildOnly 2>&1 | grep -E "signing.*platform=mas"
```

**期望输出：**

```
• signing file=.tmp/app-builds/mas-universal/Super Productivity.app
  platform=mas type=distribution
  identityName=Apple Distribution: Johannes Millan (363FAFK383)
  identityHash=968086560EC4643B4192E7755CBF7D6E009334F4
  provisioningProfile=embedded.provisionprofile
```

✅ **identityHash 应为 `968086...`**（Apple Distribution）

### 7. 验证构建包

```bash
# 检查包签名
pkgutil --check-signature .tmp/app-builds/mas-universal/superProductivity-universal.pkg
```

应显示：`Status: signed by a developer certificate issued by Apple`

## 配置文件

### build/electron-builder.mas.yaml

```yaml
mas:
  type: distribution # 重要：显式设置类型
  appId: com.super-productivity.app
  category: public.app-category.productivity
  icon: build/icon-mac.icns
  gatekeeperAssess: false
  darkModeSupport: true
  hardenedRuntime: false
  entitlements: build/entitlements.mas.plist
  entitlementsInherit: build/entitlements.mas.inherit.plist
  provisioningProfile: embedded.provisionprofile
```

**不要添加：**

- ❌ `identity: '...'` — 会导致错误且不起作用
- ❌ `notarize: true` — 仅用于 Developer ID 构建，不用于 MAS

### GitHub Actions 工作流

```yaml
- name: Build Electron app
  run: npm run dist:mac:mas:buildOnly
```

**不要添加：**

- ❌ `CSC_NAME` 环境变量 — 现代证书会导致错误
- ❌ `CSC_FINGERPRINT` 环境变量 — electron-builder 会忽略

## 证书类型参考

| Apple Portal 名称                        | Portal 描述                    | 内部名称                            | Electron-builder 偏好 | 用途             |
| ---------------------------------------- | ------------------------------ | ----------------------------------- | --------------------- | ---------------- |
| "Johannes Millan (Distribution)"         | "For use in Xcode 11 or later" | Apple Distribution                  | ✅ 首选               | MAS 构建（现代） |
| "Johannes Millan (Mac App Distribution)" | 无特殊描述                     | 3rd Party Mac Developer Application | ❌ 旧版               | MAS 构建（旧版） |
| "Developer ID Application"               | N/A                            | Developer ID Application            | N/A                   | 直接下载 DMG     |

## 年度证书更新

当证书过期时（每年），请按照以下步骤操作：

1. **在 Apple Developer Portal 创建新证书**
2. **使用新证书创建新配置文件**
3. **将所有证书导出为 PKCS#12**
4. **更新 GitHub Actions secrets**
5. **推送前本地测试**

## 故障排除

### 错误："Please remove prefix '3rd Party Mac Developer Application:' from the specified name"

**原因：** 你设置了 `CSC_NAME` 或 `identity` 带有完整的证书类型前缀。

**解决方案：** 完全移除 `CSC_NAME` 环境变量或 `identity` 配置字段。让 electron-builder 自动发现证书。

### 错误："Invalid Code Signing. The executable '...' must be signed with the certificate that is contained in the provisioning profile"

**原因：** electron-builder 使用的证书与配置文件中的证书不匹配。

**诊断：**

```bash
# 1. 检查 electron-builder 正在使用哪个证书
npm run dist:mac:mas:buildOnly 2>&1 | grep "signing.*platform=mas"

# 2. 检查配置文件中有哪个证书
python3 << 'EOF'
import plistlib, subprocess, hashlib
result = subprocess.run(['security', 'cms', '-D', '-i', 'tools/mac-profiles/mas.provisionprofile'], capture_output=True)
plist_data = plistlib.loads(result.stdout)
cert_data = plist_data['DeveloperCertificates'][0]
print(f"配置文件证书指纹: {hashlib.sha1(cert_data).hexdigest().upper()}")
EOF

# 3. 比较指纹 — 必须匹配！
```

**解决方案：** 使用 electron-builder 正在使用的证书（通常是 Apple Distribution）创建新配置文件。

### 构建上传成功，但在 App Store Connect 中无法选择

常见原因：

1. **仍在处理中** — Apple 需要 5-30 分钟处理构建，等待并定期刷新页面
2. **缺少出口合规** — 具有加密功能的应用需要。前往 App Store Connect → Your App → TestFlight，点击构建，回答出口合规问题
3. **版本/构建号已使用** — 检查 `package.json` 版本是否匹配构建的应用，如需要递增版本：`npm version patch`
4. **平台不匹配** — 确保从正确的平台标签页选择（macOS）

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

# 检查应用版本/构建号
plutil -p ".tmp/app-builds/mas-universal/Super Productivity.app/Contents/Info.plist" | \
  grep -E "CFBundleVersion|CFBundleShortVersionString"
```

## 相关文档

- [Apple Developer Portal](https://developer.apple.com/account/resources/certificates/list)
- [Electron Builder MAS 配置](https://www.electron.build/configuration/mas)
- [Apple 代码签名指南](https://developer.apple.com/support/code-signing/)
- 内部文档：`docs/update-mac-certificates.md` — 详细证书管理指南

## 总结

✅ **成功的关键：** 确保你的配置文件使用 **"Apple Distribution"** 证书（现代"Distribution"类型），而不是旧版"3rd Party Mac Developer Application"证书，因为当两者都可用时，electron-builder 总是优先使用 Apple Distribution。

❌ **不起作用的做法：** 尝试通过环境变量或配置选项强制 electron-builder 使用旧版证书 — 它会忽略这些设置，仍然使用 Apple Distribution。
