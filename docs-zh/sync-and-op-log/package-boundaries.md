# 同步包边界

**状态：** 活跃  
**最后更新：** 2026 年 5 月 13 日

本文档记录了操作日志（Operation-Log）同步栈所使用的包拆分方案。目标是让可复用的同步逻辑与框架无关，同时将 Super Productivity 领域相关的胶水代码保留在应用层。

## 依赖方向

允许的依赖方向：

```text
src/app
  -> @sp/sync-providers
  -> @sp/sync-core

src/app
  -> @sp/sync-core

packages/shared-schema
  -> @sp/sync-core
```

规则：

- `@sp/sync-core` 不得导入 Angular、NgRx、`src/app`、`@sp/shared-schema`、`@sp/sync-providers` 或任何特定于 Provider 的代码。
- `@sp/sync-providers` 仅可导入 `@sp/sync-core` 的公开导出。不得深度导入 `@sp/sync-core/*`、Angular、NgRx、`src/app` 或 `@sp/shared-schema`。
- 应用层可以导入两个包，并负责 Angular 依赖注入（Dependency Injection）、NgRx、Electron/Capacitor 桥接、配置界面、OAuth 路由以及 Super Productivity 特有模型胶水代码。
- `packages/shared-schema` 依赖 `@sp/sync-core` 仅用于为通用的向量时钟（Vector Clock）算法提供兼容性重导出。

`packages/shared-schema -> @sp/sync-core` 的依赖边是刻意为之的兼容性耦合。向量时钟的比较/合并/裁剪算法已迁移到 `@sp/sync-core`，以便同步核心、客户端包装器和服务端/共享消费者使用同一套实现。`packages/shared-schema` 重新导出这些算法以保持旧有导入路径的兼容性，供消费者逐步迁移；请勿向 `@sp/shared-schema` 添加新的同步引擎逻辑，并在所有消费者不再需要该兼容边后将其移除。

## 所有权

`@sp/sync-core` 拥有可复用的同步引擎原语：

- 通用操作和 Apply 类型；
- 向量时钟的比较、合并和裁剪算法；
- 纯冲突解决、导入过滤、上传/下载、重放、压缩和前缀辅助函数；
- 结构化的实体注册表（Entity Registry）契约；
- 面向应用层的端口契约以及隐私感知的 `SyncLogger` 接口。

`@sp/sync-providers` 拥有内置的 Provider 实现和 Provider 中立的契约：

- Dropbox、WebDAV、Nextcloud、SuperSync 和 LocalFile Provider 类；
- 基于文件的同步信封（Envelope）类型和 Provider 响应契约；
- Provider 自有的文件信封常量，例如 `sync-data.json` 和文件同步版本键；
- 凭证、文件适配器、平台信息、Web 请求、原生 HTTP、存储和响应验证器端口；
- Provider 共享的错误类、PKCE 辅助函数、重试辅助函数和安全日志元数据辅助函数。

跨 Provider 的通用工具函数属于 `@sp/sync-providers`，前提是它们可被多个 Provider 实现复用，但不属于通用引擎。现有示例包括 Provider 共享的错误类、PKCE、重试谓词、原生 HTTP 重试和安全日志元数据辅助函数。

新的内置 Provider 应遵循 Dropbox/WebDAV/SuperSync/LocalFile 的模式：将 Provider 自有的协议逻辑和 Provider 中立的契约放在 `@sp/sync-providers` 中，然后在应用层的薄工厂（Factory）中组合应用层独有的凭据、平台桥接、验证器、OAuth 路由和配置界面。如果某个 Provider 是应用特定或插件提供的而非内置的，则应在应用层基于 Provider 契约实现，而不是扩大包的范围。

`src/app` 拥有宿主相关的配置和编排：

- `ActionType`、`ENTITY_TYPES`、`SyncProviderId`、Provider 列表以及存储前缀，例如 `REMOTE_FILE_CONTENT_PREFIX` 和 `PRIVATE_CFG_PREFIX`；
- 从功能 Reducer/选择器构建实体注册表；
- 包装后的全状态负载形状、导入原因、修复负载以及针对 `@sp/shared-schema` 的验证；
- Angular 服务、NgRx 分发/重放转换、本地 Action 过滤、水合窗口、归档副作用、Provider 工厂、OAuth 回调、配置对话框和平台桥接实现。

`packages/shared-schema` 拥有 Super Productivity 的模式契约和验证器，这些内容在应用层和服务端之间共享。在此边界中，它应保持与 SP 的耦合，并且不应成为 `@sp/sync-core` 或 `@sp/sync-providers` 的依赖。

## 公开导出

包的消费者应仅从包的 Barrel 文件导入：

```ts
import { compareVectorClocks } from '@sp/sync-core';
import { Dropbox, PROVIDER_ID_DROPBOX } from '@sp/sync-providers/dropbox';
```

请勿从包的内部路径导入，例如 `@sp/sync-core/src/*`、`@sp/sync-providers/src/*` 或 `dist/*`。如果宿主需要某个符号，请将其有意识地提升到包的 Barrel 中，并检查它不属于应用层。

根路径 `@sp/sync-providers` 的 Barrel 已被移除；消费者**必须**从专注的子路径 Barrel 导入：`@sp/sync-providers/dropbox`、`/webdav`、`/super-sync`、`/local-file`、`/http`、`/errors`、`/file-based`、`/pkce`、`/platform`、`/provider-types`、`/credential-store` 和 `/log`。Provider 类、Provider 自有的字符串常量以及共享的隐私边界日志辅助函数在此处导出，但应用层的枚举（如 `SyncProviderId`）不在此列。内部辅助函数（如 WebDAV 的 API/适配器类）保持不导出，除非有第二个宿主需要它们。

`@sp/sync-core` 仍为现有消费者导出已弃用的全状态操作兼容性默认值和宿主定义的 `OpType.SyncImport` / `BackupImport` / `Repair` 字符串。新的可复用宿主应通过 `createFullStateOpTypeHelpers()` 提供自己的全状态操作字符串。

## 隐私边界

包的日志记录必须仅使用 `SyncLogger` 和安全的结构化元数据。`SyncLogger` 是一个隐私感知的端口（Port）形状；它不会对任意元数据进行清洗。调用点负责传入已经过脱敏处理的值，目前通过代码审查加上专项测试来确保合规。

以下内容是可接受的：ID、计数、Action 字符串、实体类型、Provider ID 和错误名称/错误码。URL 元数据仅在调用方剥离了查询字符串、片段、凭据、令牌、原始响应体以及用户提供的路径段（如文件名、电子邮件地址、分享 ID 或文件夹名称）后才可接受。应优先使用粗略的路径模板、Provider 操作名称、仅宿主可见的值或 Provider 自有的相对路径分类，而不是原始 URL 路径。

完整的实体、操作负载、任务标题、笔记文本、原始 Provider 响应、凭据、标头和加密材料不得出现在可导出的日志中。针对不安全的直接日志记录的 lint 规则仍作为可能的后续改进；在此之前，新的可迁移/Provider 代码应使用 `SyncLogger`，测试应断言隐私敏感路径的正确处理。

## 测试

ESLint 的包边界覆盖规则适用于 `packages/sync-core/**` 和 `packages/sync-providers/**` 下的所有 TypeScript 文件，包括测试文件。测试可以通过相对路径导入自身包内的内部代码，以实现白盒测试覆盖。`@sp/sync-providers` 的测试可以导入 `@sp/sync-core` 的公开导出，但不应导入 `@sp/sync-core` 的内部代码或 sync-core 的测试辅助函数。

## 验证

在跨这些边界移动代码之前，请运行：

```bash
npm run lint
npm run sync-core:build
npm run sync-providers:build
npm run packages:test
```

如需快速检查边界合规性，可使用：

```bash
rg -n "from ['\"](@angular|@ngrx|@sp/shared-schema|src/app|@sp/sync-core/src|@sp/sync-core/)|import\(['\"](@angular|@ngrx|@sp/shared-schema|src/app|@sp/sync-core/src|@sp/sync-core/)" packages/sync-core/src packages/sync-providers/src
```
