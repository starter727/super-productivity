# Apple (iOS & macOS) 发布自动化

推送最终版本标签（`vX.Y.Z`）会构建、签名、上传**并提交** iOS 和 macOS App Store 构建以供审核，设置为 Apple 批准后自动发布。唯一未自动化的步骤是 Apple 的人工审核。

## 流水线

| 目标                                   | 工作流程                                                      | 输出                           |
| -------------------------------------- | ------------------------------------------------------------- | ------------------------------ |
| iOS App Store                          | `.github/workflows/build-ios.yml`                             | `.ipa` → App Store Connect     |
| Mac App Store                          | `.github/workflows/build-publish-to-mac-store-on-release.yml` | MAS `.pkg` → App Store Connect |
| Mac 直接下载（公证 DMG/zip，自动更新） | `.github/workflows/build.yml`（`mac-bin`）                    | GitHub Release 资源            |

推送标签时，每个工作流构建并签名构件，然后运行 fastlane lane（`fastlane/Fastfile`，`ios release` / `mac release`），执行以下操作：

1. 将构件上传到 App Store Connect。Apple 的二进制验证在上传期间内联运行（这替代了之前独立的 `altool --validate-app` 步骤）。
2. 仅推送"What's New"发布说明（从 `build/release-notes.md` 由 `tools/prepare-appstore-release-notes.js` 派生）。lane 将 `metadata_path` 指向仅包含 `<locale>/release_notes.txt` 的目录；deliver 仅读取该文件并跳过所有其他字段（无远程回读），因此手动在 App Store Connect 中维护的描述、关键词、截图等保持不变。（特意**未设置** `skip_metadata`——设置后 deliver 将完全不上传任何说明。）
3. 等待 App Store Connect 完成构建处理。
4. 提交版本以供审核，**批准后自动发布**。

`build/release-notes.md` 是在发布时重新生成的已提交快照（参见 `tools/release-notes.js`）。如果推送标签时该文件未针对新版本刷新，过时的说明会静默上传——确保 release-notes 提交在打标签之前落地。

### 提交 vs. 仅上传

`SUBMIT_FOR_REVIEW` 每次运行按 `startsWith(github.ref, 'refs/tags/v') && !contains(github.ref, '-')` 计算：

- **最终标签**（`vX.Y.Z`，无连字符）→ 上传**并**提交审核。
- **预发布标签**（任何包含 `-` 的标签，例如 `v18.0.0-rc.0`、`v17.0.0-RC.13`、`-beta.1`、`-alpha.0`）或**手动 `workflow_dispatch`** → 仅上传（构建进入 App Store Connect / TestFlight，无商店提交）。

> 门控基于 `-` 的存在，而非将 `RC`/`beta`/`alpha` 列入拒绝列表，因为 GitHub Actions 的 `contains()` 区分大小写，而此仓库的 RC 标签主要是**小写** `-rc.N`。仓库历史中的每个预发布标签都包含 `-`；最终标签都不包含。

## 必需的 Secrets

认证使用 **App Store Connect API 密钥**（复用公证 secrets），在 CI 中比 Apple ID + 应用专用密码更健壮：

| Secret                  | 用途              | 说明                                                                      |
| ----------------------- | ----------------- | ------------------------------------------------------------------------- |
| `mac_api_key`           | `ASC_KEY_CONTENT` | `.p8` 密钥文件内容（原始 PEM，包含 `-----BEGIN/END PRIVATE KEY-----` 行） |
| `mac_api_key_id`        | `ASC_KEY_ID`      | API 密钥 ID                                                               |
| `mac_api_key_issuer_id` | `ASC_ISSUER_ID`   | API 颁发者 ID                                                             |

> **重要：** API 密钥必须属于具有 **App Manager** 角色（或更高）的用户。仅具有 **Developer** 角色的密钥可以上传/公证，但**无法创建版本或提交审核**。如果提交因权限错误而失败，请使用 App Manager 角色创建新密钥并更新上述三个 secrets。

## 注意事项

- **Apple 审核是唯一的人工关卡** — 由人工执行（约 1-2 天），可能会被拒绝。提交之前的全部流程都是自动化的。
- **`automatic_release: true`** 在 Apple 批准后立即将版本发布给 100% 的用户（无需手动点击"Release this version"，无分阶段发布）。如果你希望人工执行上线或分阶段发布，在 `fastlane/Fastfile` 中设置 `automatic_release: false`（和/或 iOS 的 `phased_release: true`）。
- **构建号是单次使用的。** 如果 lane 在二进制文件上传后、提交完成前失败（网络中断、App-Manager-role 错误、出口合规暂停），仅重新运行将不起作用——App Store Connect 会拒绝重复的构建号。恢复方法是在 App Store Connect 中手动完成提交，或者递增构建号并重新打标签。
- **"What's New"区域设置：** 仅生成 `en-US` 说明。如果 App Store 列表有其他活跃区域设置，Apple 可能在提交时要求提供这些区域的"What's New"文本。根据需要添加更多 `release_notes.txt` 文件（或扩展 `tools/prepare-appstore-release-notes.js`）。
- **出口合规：** 如果 `ios/App/App/Info.plist` 未设置 `ITSAppUsesNonExemptEncryption`，App Store Connect 将暂停提交以询问加密问题。设置一次即可保持提交完全自动化。
- **永远不要在这些 lane 中启用 fastlane verbose 模式**（`--verbose` / `FASTLANE_VERBOSE`）——verbose 输出可能转储 deliver options 哈希，其中包含 API 密钥材料。
