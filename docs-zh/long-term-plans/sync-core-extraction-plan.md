# `@sp/sync-core` 提取记录

> **状态：此提取分支已完成。** `@sp/sync-core` 和
> `@sp/sync-providers` 已就位，前端通过包边界和分层 provider 子路径导入，
> PR 6/PR 7 的边界加固和优化工作已完成。合并前的剩余工作仅为验证。

**成果：** 同步引擎已从 `src/app/op-log/` 中分离出来，成为一个可复用、
框架无关且**领域无关（domain-agnostic）** 的 `@sp/sync-core` 包，
以及一个包含捆绑 provider 实现的姊妹包 `@sp/sync-providers`。

## 当前架构

- `@sp/sync-core` 拥有通用同步引擎接口：操作/应用原语、向量时钟、全状态操作辅助工厂、
  实体键与同步文件前缀辅助函数、压缩/错误辅助函数、导入过滤决策、
  冲突解决辅助函数、上传/下载/重放/远程应用规划辅助函数、实体注册表合约、
  编排端口以及隐私感知的 `SyncLogger` 端口。
- `@sp/sync-providers` 拥有 provider 合约和捆绑实现：
  Dropbox、WebDAV + Nextcloud、SuperSync、LocalFile、基于文件的同步信封、
  provider 共享的错误、PKCE 辅助函数、重试辅助函数、平台/凭证/文件端口、
  provider 拥有的字符串常量，以及分层子路径导出。
- `src/app/op-log/` 拥有 Super Productivity 的接线代码：NgRx 适配器、应用对话框、
  IndexedDB 编排、实体注册表组合、`ActionType`、`EntityType`、`SyncImportReason`、
  `SyncProviderId`、修复数据形状、全状态传输格式、凭证存储实现、OAuth 路由、
  provider UI 配置、响应验证器和平台桥接。
- 包边界通过 ESLint、包清单、公共导出审计和源码 grep 进行强制检查。
  `@sp/sync-core` 无运行时依赖。
  `@sp/sync-providers` 仅可依赖 `@sp/sync-core` 的公共 API 以及 provider 运行时依赖。

## 剩余合并关卡

提取工作本身已完成。合并前的剩余工作仅为部分验证：

- 按需对 Dropbox、WebDAV、LocalFile 和 SuperSync 运行 Provider E2E 冒烟测试。
- 如果合并前改动了该相关部分，则对基于文件的 provider 进行新客户端引导检查。
- 仅当平台桥接属于合并验证环节的一部分时，进行 Electron/Android LocalFile 路径冒烟测试。

## 背景

同步前端代码位于 `src/app/op-log/`（旧的 `src/app/pfapi/` 是遗留代码，不在范围内）。
它已经按关注点组织（`core`、`sync`、`apply`、`capture`、`persistence`、`encryption`、
`validation`、`util`、`model`、`sync-providers`），但边界仅靠约定维护：
引擎可以访问 NgRx 状态，`core/entity-registry.ts` 硬编码了来自 15 个以上
feature reducer 的导入，provider 和引擎代码自由混合在一起。

最终形态是一个**三方分离结构**：

1. **同步逻辑/引擎** - 操作编排、向量时钟、冲突解决、持久化接口。
   框架无关且领域无关。
2. **配置** - 实体注册表、模型配置、应用特定的接线、操作类型枚举、
   实体类型联合类型、修复负载形状、provider 列表。
   位于应用中。
3. **Provider 实现** - SuperSync、Dropbox、WebDAV、LocalFile。
   可插拔，通过稳定接口与引擎通信。

## 领域规则

任何命名 Super Productivity 领域对象、枚举值或传输约定的内容都属于应用，
而非 `@sp/sync-core`。该库将 `actionType` 和 `entityType` 作为普通 `string`；
应用通过在库通用 `Operation` 基础上使用 `Omit` 加扩展来进行类型收窄。

永远属于应用的内容：

- **`ActionType` 枚举** - 宿主应用的操作目录，非库内容。
- **`ENTITY_TYPES` / `EntityType` 联合类型** - TASK、PROJECT、TAG、METRIC、BOARD
  等是 SP 的领域。库使用 `string`；应用进行类型收窄。
- **`SyncImportReason` 联合类型** - SP 特定的导入流程。
- **`RepairSummary`、`RepairPayload`** - SP 的修复输出形状。
- **`WrappedFullStatePayload` + `extractFullStateFromPayload` +
  `assertValidFullStatePayload`** - `appDataComplete` 包装器和
  `['task','project','tag','globalConfig']` 键存在性检查属于 SP 的传输格式。
- **`SyncProviderId`、`OAUTH_SYNC_PROVIDERS`、`REMOTE_FILE_CONTENT_PREFIX`、
  `PRIVATE_CFG_PREFIX`** - SP 的捆绑 provider 和 SP 风格的存储前缀。
- **`@sp/shared-schema`** - 该包当前与 SP 耦合，因此
  `@sp/sync-core` 不能依赖它。

当库需要宿主特定的枚举值时，它暴露一个工厂或配置对象，由应用在组合时提供值。
当前的 LWW 辅助工厂是遵循的模型。

## PR #7546 评审建议

这些调整指导了薄切片之后的提取工作：

1. **提前实施边界强制检查。** 在下一个 PR 而非最后添加 ESLint/包边界检查。
   一旦 `packages/sync-core/` 和 `packages/sync-providers/` 具有结构化的公共 API，
   对其添加 `import/no-restricted-paths` 规则就是低成本的。
2. **记录提取作为重构，而非新架构。** 规范中的 API 表面和用户行为应保持不变。
   设计变更留到后续再议。这使得评审者可以重点关注代码移动和边界，而不必
   同时评估工作方式的变化。
3. **保持同步引擎完全领域无关。** `sync-core` 不应引入与 SP 域对象的耦合。
   任何提及 `entityTypes`（复数，指应用特定枚举）的行为都会创建条件耦合。
   应用应整合这些值；库通过最小接口进行参数化。
4. **保持 provider 包自包含。** 如果提取后仍存在应用导入 provider 内部模块的情况，
   那些应用端接口就是泄漏的抽象。provider 的公共表面应封装其复杂性。

### 已实施的边界

作为采纳上述评审反馈的一部分，实施了以下边界强制措施：

- `packages/sync-core/` 中`src/` 下没有从 `..`（父目录）或 `@sp/` 包的导入。
  唯一的导入是 Deno 标准库和 Node 内置模块（`crypto`、`timers` 等 + 它们的
  `node:` 前缀形式）。
- `packages/sync-providers/` 中的 `src/` 仅从其自身的包、`@sp/sync-core`
  （公共 API）以及 provider 运行时依赖项导入。
- `src/`（应用）既不会从 `@sp/sync-core` 或 `@sp/sync-providers` 的深层路径导入，
  也不会通过相对路径引用 `packages/sync-core/` 或 `packages/sync-providers/`。
  应用按包名导入，对于 provider 则使用 `@sp/sync-providers/dropbox`、
  `@sp/sync-providers/webdav` 等分层子路径。
- `src/app/op-log/sync-providers/` 中的 Provider 骨架被移除；provider 实例化
  现在完全通过包名和 DI 令牌进行。
- 强制边界检查现在通过持续集成（CI）中的 ESLint `import/no-restricted-paths` 规则
  强制执行。
- 公共导出审计未发现任何应用拥有的 provider 枚举、provider 列表、存储前缀、
  OAuth 路由、UI 配置、shared-schema 验证器或 sync-core 深层导入出现在包公共 API 中。
  已知的例外是已废弃的 `@sp/sync-core` 全状态操作兼容性导出，以及为现有消费者保留的
  宿主定义的 `OpType.SyncImport` / `BackupImport` / `Repair` 字符串。

### 验证

- `npm ci` 完成，包括 sync-core、sync-providers、shared-schema 和 plugin-api 的
  构建时准备步骤。
- `npx eslint "packages/sync-core/**/*.ts" "packages/sync-providers/**/*.ts"`
  通过。
- `npm run lint` 通过。
- 两个包的边界 grep 均未返回禁止的源导入。
- `npm run sync-core:build` 通过。
- `npm run sync-providers:build` 通过。
- 于 2026 年 5 月 13 日本地运行：`npm run packages:test` 通过，sync-core 156 项测试，
  sync-providers 302 项测试。
- 完整应用单元测试在下方 PR 7 验证中通过；选定的同步 E2E 测试仍作为合并级别的验证，
  按需执行。

---

## 可选的优化工作（Provider 迁移后）

状态：此分支已实施。

在 PR 5 provider 迁移过程中浮现的一些非阻塞性清理工作。这些工作不改变
行为或边界；它们在消费者迁移后消除重复、收紧测试并淘汰已废弃的别名。

### 已实施的状态

- PKCE 已是包所有：应用 OAuth 代码从 `@sp/sync-providers/pkce` 导入
  `generateCodeVerifier` 和 `generateCodeChallenge`，应用本地的
  `pkce.util` 桩/规范/辅助代码已被移除。
- `generatePKCECodes()` 中已死的 `_length` 参数已被移除，Dropbox 调用点
  现在使用零参数辅助函数。
- 包 PKCE 测试现在断言默认 32 随机字节产生的确切 43 字符验证器长度。
- 已废弃的 `SyncProviderServiceInterface` 别名已被移除。文件 provider 引用
  现在使用 `FileSyncProvider`，通用/支持操作的 provider 引用现在使用
  `SyncProviderBase` 加 `OperationSyncCapable`（按需）。
- `packages/sync-providers/**` 的 ESLint 边界覆盖规则不再重复
  已被 `**/...` 形式覆盖的相对 sync-core/shared-schema 模式深度。
- WebDAV XML 解析现在使用命名空间无关的 `childNodes`/`localName` 扫描，
  而非重复的 `getElementsByTagNameNS()` 子树遍历。包规范涵盖了混合前缀解析
  以及直接 WebDAV 子元素相对于嵌套扩展字段的优先级。
- 新增了 `@sp/sync-providers/*` 的分层包导出，前端应用导入现在使用
  聚焦的子路径，而非根 provider 桶文件（barrel）。未使用的应用端
  SuperSync 模型和 LocalFile 文件适配器重新导出桩已被移除。

### 验证

- `npm run packages:test` 通过，sync-core 156 项测试，sync-providers 303 项测试。
- `npm run sync-core:build` 通过。
- `npm run sync-providers:build` 通过。
- `npm test` 通过，包括完整的 Karma 运行和洛杉矶时区运行。
- `npm run lint` 通过。
- 源码 grep `pkce.util` 和 `SyncProviderServiceInterface` 在 `src` 和
  `packages` 下均返回零结果。

---

## 已完成的时间线

| PR   | 范围                                                  | 风险        | 备注                     |
| ---- | ----------------------------------------------------- | ----------- | ------------------------ |
| **1**  | 搭建 `@sp/sync-core`，含通用原语和桩                     | 低          | 已完成                   |
| **2**  | 边界 lint、注册表类型、隐私感知日志端口                      | 中          | 已完成                   |
| **3a** | 向量时钟所有权及包测试框架                                  | 中          | 已完成                   |
| **3b** | 纯算法核心                                              | 中          | 已完成                   |
| **4a** | 仅移植合约                                              | 中          | 已完成                   |
| **4b** | 将小型编排单元移至端口之后                                | 高          | 已完成                   |
| **4c** | 重新审视 `OperationApplierService` 提取                    | 高          | 缩窄了重放协调器的范围   |
| **5**  | 将 provider 迁移到 `@sp/sync-providers`                   | 中高        | 已完成                   |
| **6**  | 最终边界加固与架构说明                                    | 低          | 已完成                   |
| **7**  | 可选的优化工作与分层 provider 导出                          | 低          | 已完成                   |

在最终 PR 之后，`@sp/sync-core` 成为领域无关的同步引擎和抽象层，
`@sp/sync-providers` 包含捆绑的 provider 实现，
`src/app/op-log/` 包含 SP 特定的接线代码：NgRx 适配器、对话框端口、
实体注册表组合、`ActionType`、`EntityType`、`SyncImportReason`、
`SyncProviderId`、修复数据形状和全状态传输格式。
