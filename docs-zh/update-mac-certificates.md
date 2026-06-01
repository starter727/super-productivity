# 更新 macOS 证书供 electron-builder 使用

> **相关 macOS 文档：**
> - [build-and-publish-notes.md](./build-and-publish-notes.md) — 构建/发布工作流程（截图、iOS、Windows 签名）
> - [mac-app-store-code-signing-guide.md](./mac-app-store-code-signing-guide.md) — 代码签名设置和故障排除

需要 Mac 访问权限！以下说明刷新 GitHub Actions/macOS 运行器用于 Mac App Store（MAS）和直接下载（DMG）构建的所有资源。

## 证书

### 1. 清理旧材料

⚠️ 注意：删除旧证书也会删除它们的私钥。如果你没有备份私钥，在创建新证书之前生成新的 CSR。

- 在 <https://developer.apple.com/account/resources/certificates/list> 中，撤销即将过期的证书，防止意外再次下载。
- 从本地钥匙串中移除匹配的身份（`Keychain Access → My Certificates` — `open -a "Keychain Access"`），以免之后导出错误的私钥。

### 2. 创建新 CSR（一次性）

1. 打开 Keychain Access → Certificate Assistant → Request a Certificate From a Certificate Authority...
2. 输入与团队关联的 Apple ID 邮箱，选择"Saved to disk"，选择 `mac-dev-team.csr` 的保存位置。
3. 仅当需要为不同 Apple ID/团队创建 CSR 时才重复。

### 3. 生成所需证书

在开发者门户中使用步骤 2 的 CSR 创建以下证书：

- **Apple Development** — 用于本地开发/调试构建。
- **Apple Distribution**（Apple 重命名了"Mac App Distribution"）— 用于签名 MAS 应用。
- **Mac Installer Distribution** — 用于签名通过 Transporter 上传的 MAS .pkg。
- **Developer ID Application** — 用于签名经过公证的 DMG 构建。
- **Developer ID Installer** — 用于发布签名的安装程序 .pkg（当 `dist:mac:dl` 运行时，electron-builder 仍然需要）。

下载每个生成的 .cer 文件，记下 Apple 显示的确切标签，以便在 CI 日志中交叉检查。

### 4. 安装并导出为 PKCS#12

1. 双击每个下载的 .cer，使其进入登录钥匙串的"My Certificates"下。每个证书应该有一个显示三角形，揭示配对的私钥 — 如果三角形缺失，删除证书并重新生成，以便私钥正确附加。
2. 多选上述身份（如果只针对 MAS 或只针对 Developer ID，请相应调整），右键 → **Export Items...**，保存为 `all-certs.p12`，选择强密码（此密码变为 `MAC_CERTS_PASSWORD`）。确认重复的 macOS 密码提示。
   - 或者运行：
     ```bash
     security export -k ~/Library/Keychains/login.keychain-db \
       -t identities -f pkcs12 -P "$MAC_CERTS_PASSWORD" \
       -o all-certs.p12
     ```
3. 在进行下一步之前，验证你能在另一台 Mac 上重新导入 `all-certs.p12`。

### 5. 准备 CI secrets

1. Base64 编码导出的文件：`base64 -i all-certs.p12 -o all-certs.b64`。
2. 使用 `all-certs.b64` 的内容更新 GitHub Actions secret `MAC_CERTS`，使用上面选择的密码更新 `MAC_CERTS_PASSWORD`。
3. 在工作流中将这些 secrets 映射到 electron-builder 的期望值，例如：
   ```yaml
   CSC_LINK: ${{ secrets.MAC_CERTS }}
   CSC_KEY_PASSWORD: ${{ secrets.MAC_CERTS_PASSWORD }}
   CSC_IDENTITY_AUTO_DISCOVERY: true
   ```
   如果决定单独存储安装程序身份，使用 `CSC_INSTALLER_LINK`/`CSC_INSTALLER_KEY_PASSWORD`。

## Provisioning Profiles

> 重要：在**新证书存在后**创建/刷新配置文件，否则下载配置文件仍会拉取已撤销的证书。

1. 前往 <https://developer.apple.com/account/resources/profiles/list>。
2. 创建两个新配置文件：
   - **类型"Mac App Store"** → 选择 `Apple Distribution` 证书 → 选择 MAS App ID → 下载为 `mas.provisionprofile`。
   - **类型"Developer ID Application"** → 选择 `Developer ID Application` 证书 → 选择相同 App ID → 下载为 `dl.provisionprofile`。
3. 将文件移动到 `tools/mac-profiles/mas.provisionprofile` 和 `tools/mac-profiles/dl.provisionprofile`。
4. Base64 编码供 CI 使用：
   ```bash
   base64 -i tools/mac-profiles/dl.provisionprofile -o dmg-profile.b64
   base64 -i tools/mac-profiles/mas.provisionprofile -o mas-profile.b64
   ```
5. 使用编码字符串更新 GitHub secrets `DL_PROVISION_PROFILE`（dmg）和 `MAS_PROVISION_PROFILE`（store）。

## 本地构建 DMG

1. 在 <https://appleid.apple.com/account/manage> 创建或刷新应用专用密码。
2. 运行：
   ```bash
   APPLEID="you@example.com" \
   APPLEIDPASS="app-specific-password" \
   rm -Rf app-builds && npm run build && npm run dist:mac:dl
   ```
3. 该脚本使用新证书和配置文件签名、公证并 stapled 的 DMG。使用 `spctl --assess -vv --type install path/to/app` 验证。
