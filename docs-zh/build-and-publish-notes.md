# 发布说明

> **相关 macOS 文档：**
> - [mac-app-store-code-signing-guide.md](./mac-app-store-code-signing-guide.md) — 代码签名设置和故障排除
> - [update-mac-certificates.md](./update-mac-certificates.md) — 年度证书更新

查找 AppDataForScreenshots.json

## Mac 商店截图

- 设置分辨率：1280\*800（使用分离的开发者工具检查尺寸）
- 按 Cmd+Shift+4
- 按空格键
- 按住 Alt 键并点击窗口
- 扫描结果，删除应用描述、应用图标、截图、预览、发布说明和二进制文件中所有对"demo"、"trial"、"beta"或"test"的引用

## Android 截图

- 打开 Web 版本
- 调整到所需大小
- 按 Ctrl + Shift + P
- 输入 screenshot

## iOS App Store

### GitHub Actions 工作流程

iOS 构建通过 `.github/workflows/build-ios.yml` 自动化。触发条件：

- 发布版本（包括测试期间的预发布）
- 手动工作流调度

### 必需的 GitHub Secrets

| Secret                        | 描述                                              |
| ----------------------------- | ------------------------------------------------- |
| `mac_certs`                   | Apple Distribution 证书（.p12，base64 编码）- 与 Mac 构建共享 |
| `mac_certs_password`          | 证书密码 - 与 Mac 构建共享                        |
| `IOS_PROVISION_PROFILE`       | iOS App Store 配置文件（provisioning profile，base64 编码） |
| `APPLE_ID`                    | 用于 App Store Connect 的 Apple ID                |
| `APPLE_APP_SPECIFIC_PASSWORD` | 应用专用密码                                      |
| `APPLE_TEAM_ID`               | Apple Developer Team ID                           |

### 创建配置文件

1. 前往 [Apple Developer Portal → Profiles](https://developer.apple.com/account/resources/profiles/list)
2. 点击 **+** → **App Store Connect**（在 Distribution 下）
3. 选择 App ID：`com.super-productivity.app`
4. 选择你的 **Apple Distribution** 证书
5. 下载 `.mobileprovision` 文件
6. Base64 编码：`base64 -i profile.mobileprovision | pbcopy`
7. 添加到 GitHub Secrets 作为 `IOS_PROVISION_PROFILE`

### iOS 截图

所需尺寸（最低需要 6.9"，其他可选）：
| 设备 | 尺寸（像素） |
|------|-------------|
| 6.9" iPhone（Pro Max） | 1320 x 2868 |
| 6.5" iPhone（11 Pro Max） | 1284 x 2778 |
| 5.5" iPhone（8 Plus） | 1242 x 2208 |
| 12.9" iPad Pro | 2048 x 2732 |

截取方法：

- 在所需设备尺寸的 iOS 模拟器中运行应用
- 按 Cmd+S 保存截图
- 可选：使用 [AppMockUp](https://app-mockup.com) 等工具添加设备边框

### App Store Connect 设置

1. 前往 [App Store Connect](https://appstoreconnect.apple.com) → My Apps → **+** → New App
2. 选择 **iOS** 平台
3. Bundle ID：`com.super-productivity.app`
4. 填写应用名称、SKU 等
5. 通过工作流上传的构建出现在 **TestFlight** 标签页下

## Windows 代码签名

### GitHub Actions 工作流程

Windows 可执行文件（NSIS 安装程序和便携式 .exe 文件）在 `.github/workflows/build.yml`（windows-bin 作业）的构建过程中使用 SignPath 自动签名。仅对发布版本（以 'v' 开头的标签）进行签名。

### 必需的 GitHub Secrets

| Secret                     | 描述                                                         |
| -------------------------- | ------------------------------------------------------------ |
| `SIGNPATH_API_TOKEN`       | 具有签名权限的 SignPath API 令牌                             |
| `SIGNPATH_ORGANIZATION_ID` | 你的 SignPath 组织 ID（在仪表盘 URL 或组织设置中找到）       |
| `SIGNPATH_PROJECT_SLUG`    | 你的 SignPath 项目 slug（例如"super-productivity"）          |

### 必需的工作流配置更新

在 `.github/workflows/build.yml`（windows-bin 作业）中，用实际 SignPath 配置更新以下占位符值：

```yaml
signing-policy-slug: 'release-signing' # TODO: 替换为实际 SignPath 策略 slug
artifact-configuration-slug: 'windows-exe' # TODO: 替换为实际 SignPath 工件配置 slug
```

### SignPath 设置（一次性配置）

#### 1. 在 SignPath 中创建/验证项目

1. 登录 [SignPath.io](https://app.signpath.io)
2. 创建新项目或使用现有项目
3. 记下**项目 slug**（在项目 URL 中可见）
4. 将代码签名证书上传到项目

#### 2. 创建签名策略

1. 在 SignPath 项目中，前往 **Signing Policies**
2. 点击 **Add Signing Policy**
3. 配置：
   - **名称**：`release-signing`（或你偏好的名称）
   - **证书**：选择你上传的代码签名证书
   - **审批**：根据需要配置：
     - 生产版本自动批准（推荐）
     - 测试版本手动批准（可选）
4. 记下**签名策略 slug**

#### 3. 创建工件配置

1. 在 SignPath 项目中，前往 **Artifact Configurations**
2. 点击 **Add Artifact Configuration**
3. 配置：
   - **名称**：`windows-exe`（或你偏好的名称）
   - **工件类型**：Portable Executable（PE）
   - **深度签名**：启用（推荐用于包含嵌套可执行文件的安装程序）
4. 记下**工件配置 slug**

#### 4. 生成 API 令牌

1. 在 SignPath 中，前往 **Organization Settings** → **API Tokens**
2. 点击 **Create Token**
3. 配置：
   - **名称**："GitHub Actions CI/CD"
   - **权限**：启用"Submit signing requests"
4. **立即复制令牌** — 之后不会再次显示
5. 添加到 GitHub Secrets 作为 `SIGNPATH_API_TOKEN`

#### 5. 添加 GitHub Secrets

在 GitHub 仓库中（Settings → Secrets and variables → Actions），添加：

1. **SIGNPATH_API_TOKEN**：步骤 4 中的 API 令牌
2. **SIGNPATH_ORGANIZATION_ID**：在 SignPath 仪表盘 URL 或组织设置中找到
3. **SIGNPATH_PROJECT_SLUG**：步骤 1 中的项目 slug

#### 6. 更新工作流配置

在 `.github/workflows/build.yml` 中，更新占位符值：

1. 将 `'release-signing'` 替换为步骤 2 中的实际签名策略 slug
2. 将 `'windows-exe'` 替换为步骤 3 中的实际工件配置 slug

### 验证签名可执行文件

发布构建完成后：

1. **下载** GitHub Releases 中的可执行文件
2. **在 Windows 上使用 PowerShell 验证签名**：

```powershell
Get-AuthenticodeSignature ".\Super-Productivity-Setup-x64.exe" | Format-List
```

3. **检查输出**是否显示：
   - `Status`："Valid"
   - `SignerCertificate`：你的证书详情
   - `TimeStamperCertificate`：时间戳机构

4. **测试安装**：Windows 应显示你的发布者名称，并且在证书获得信誉后不会显示 SmartScreen 警告

### 故障排除

- **签名超时**：默认超时时间为 600 秒（10 分钟）。如有需要，在工作流 YAML 中增加
- **无效证书**：验证证书已上传到 SignPath，且策略配置正确
- **API 令牌过期**：在 SignPath 组织设置中生成新令牌
- **构建签名失败**：检查 SignPath 仪表盘中的签名请求状态和错误信息
