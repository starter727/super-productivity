# PR 7 — SuperSync 切片（设计文档）

> 给执行此计划的 Claude：这是一个**供多人审阅的设计文档**，而非逐步实现计划。一旦以下设计选择获得批准，请重写为 TDD 计划或按照"建议的提交结构"部分进行提交执行。

**目标。** 将 SuperSync 提供程序（`super-sync.ts`、`super-sync.model.ts` 及其同位置 spec）移入 `@sp/sync-providers`，通过为 Dropbox + WebDAV 引入的端口加上一个新存储端口和一个新响应验证器端口。保留一个薄层应用侧工厂 shim，使 `sync-providers.factory.ts` 保持不变继续工作。四个以 SuperSync 命名的应用服务（`super-sync-status.service`、`super-sync-websocket.service`、`super-sync-restore.service`、`supersync-encryption-toggle.service`）保留在应用侧，因为它们依赖于不属于包中的 Angular/NgRx 连接。

**状态。** PR 5 已发布切片 1-6（脚手架、信封类型、PKCE、原生 HTTP 重试、错误类 + Dropbox 主体、WebDAV + Nextcloud）。这是长期计划中的切片 7，倒数第二个提供程序提升。LocalFile 作为切片 8 保留。参见 `docs/long-term-plans/sync-core-extraction-plan.md` §"剩余切片计划"第 1 项以了解上下文。

---

## 多人审阅共识（2026-05-12）

六个 Claude 审阅者（正确性、安全性/隐私、架构、替代方案、性能、简洁性）并行针对原始设计运行。Codex 和 Gemini 未为此切片运行（WebDAV 切片先例已经建立了多人审阅协议形式，且 Claude 视角在开放问题上强烈趋同）。共识记录如下；少数立场明确标注。

### 审阅后修订的决策

- **开放问题 1（`WebFetchFactory` 采纳）— 采纳。** 简洁性、替代方案和架构都同意：与 Dropbox/WebDAV 免费一致性，构建时相同的 iOS 后期修补风险，三行连接成本。已关闭。
- **开放问题 2（`RestorePointType` 收窄）— 保持包泛型；应用 shim 收窄。** 替代方案 + 简洁性都认为，将窄联合类型引入包会重新引入边界禁止的领域耦合。镜像了当前处理 `OperationSyncCapable<"superSyncOps">` 的方式。
- **开放问题 3（`KeyValueStoragePort` 对比窄 `SuperSyncStorage`）— 选择窄型（选项 A）。** 架构和替代方案都反对泛型选项。窄端口胜出的三个原因：（1）`lastServerSeq` 是提供程序状态，而非传输状态——泛型端口广告了包不使用的通用性；（2）前缀 + `parseInt` 间接在端口泛型时变得与宿主耦合；（3）LocalFile（切片 8）是 `FileSyncProvider` 形态，没有 `lastServerSeq` 等效物，所以"复用"参数是推测性的。架构的进一步"吸收到 `SuperSyncPrivateCfg`"替代方案比此切片应尝试的更侵入——标注为后续操作。
- **开放问题 4（`isTransientNetworkError` 策略）— 以意图锚定名称提升，而非 `isTransientErrorMessage`。** 架构标记了命名异味：提升后包有 `isTransientNetworkError(e: unknown)`（原生代码感知）和提升的辅助函数。基于输入形状区分的名称会混淆。选择一个锚定在意图上的名称——例如 `isRetryableUploadError`（实际语义表面——"此上传结果错误是否应触发重试？"）。正确性另外标记了 barrel 导出冲突风险——显式解决：barrel 以不同名称导出两者；应用的 `sync-error-utils.ts` 以别名形式重新导出提升的辅助函数回到其当前名称，使 `operation-log-upload.service.ts` 不变。
- **开放问题 5（spec 迁移——单体 vs 拆分）— 单体，推迟拆分。** 三位审阅者（架构、性能、简洁性）确认；一位（替代方案）倾向于先拆分再移动的三路提交。架构的推理占主导：将比 WebDAV 大 1.8 倍的 Jasmine→Vitest 迁移与结构拆分混合会消耗审阅注意力。三路拆分（核心/操作/获取）记录为后续提交形式，使推迟的工作具体化。替代方案的异议记录在 §"记录在案的异议"下面。
- **开放问题 6（压缩——直接导入 vs 端口）— 直接 `@sp/sync-core` 导入。** 性能验证了这些路径在观察上等价；架构和简洁性确认；正确性的 grep 证明下游不存在 `instanceof CompressError` 捕获。替代方案的异议（将 `CompressError`/`DecompressError` 移入 `@sp/sync-core` 以严格保持行为）记录在 §"记录在案的异议"中。
- **开放问题 7（隐私 A1——固定状态 vs 擦除）— EXTRACTED-REASON 形式，非二进制状态。** 安全性建议。

`SuperSyncProvider & OperationSyncCapable<"superSyncOps"> & RestoreCapable<RestorePointType>` 使现有消费者（`snapshot-upload.service.ts:77-95`、`super-sync-restore.service.ts:118`）保持类型检查。删除 spec 中的 `TestableSuperSyncProvider` 子类。

每个提交独立绿色发布：每次提交后运行包测试 + lint。

---

## 验证门控

合并前：

- `npm run sync-providers:test` — 包 spec 绿色（性能审阅者预计 Jasmine 迁移后新增约 60-70 个 Vitest spec）。
- `npm run sync-providers:build` — 包构建。性能估计：CJS 约 95-100 KB（在原 110 KB 预估内；SuperSync 的私有辅助函数压缩良好）。分层 barrel 拆分保持为文档化的推迟项。
- `npm run lint` — 边界 lint 干净。
- 目标应用 spec：
  `super-sync-status.service.spec.ts`、`super-sync-websocket.service.spec.ts`、`super-sync-restore.service.spec.ts`、`supersync-encryption-toggle.service.spec.ts`、`response-validators.spec.ts`、`sync-wrapper.service.spec.ts`、`operation-log-upload.service.spec.ts`（验证辅助函数重新导出 shim 路径）、`encryption-password-change.service.spec.ts`、`op-log/testing/integration/service-logic.integration.spec.ts`（两者均被正确性审阅者标记为间接测试 SuperSync 行为）。
- 完整 `npm test`（两个时区变体，遵循 WebDAV 切片协议）。
- 完整 E2E（Playwright + SuperSync docker-compose，根据 `e2e/CLAUDE.md`）。
- 手动 SuperSync 往返测试：
  - 快照上传（初始、恢复、迁移原因）。
  - 操作上传（压缩负载、原生 vs Web 路径）。
  - 操作下载（分页，带 `excludeClient`，带 `limit`）。
  - 恢复点获取。
  - `getStateAtSeq` 快照恢复。
  - 加密切换流程（当 `isEncryptionEnabled` 时，`getEncryptKey` 返回密钥；禁用时返回 `undefined`）。
  - 认证失败路径（401/403 → `AuthFailSPError`）。
  - 服务器 URL 切换（账户迁移使缓存的 `lastServerSeq` 键失效——验证 `setPrivateCfg` 上的 `_cachedServerSeqKey` 重置）。
  - 通过 WebView 的 Android 原生平台路径（二进制体损坏——验证 base64 gzip 路径仍然工作）。
  - iOS 原生（CapacitorHttp `_fetchApiCompressedNative` 路径）。
- WebSocket 重连冒烟测试（此切片不涉及，但验证 `getWebSocketParams` 仍返回正确的 `{ baseUrl, accessToken }` 结构）。

---

## 此切片不涉及的范围

- LocalFile 提供程序移动（切片 8）。
- WebSocket 服务移动（`super-sync-websocket.service.ts` 保留在应用侧——与 NgRx 耦合且与提供程序边界无关）。
- 状态服务移动（`super-sync-status.service.ts` 保留在应用侧）。
- 恢复服务移动（`super-sync-restore.service.ts` 保留在应用侧——UI 编排）。
- 加密切换服务移动（`supersync-encryption-toggle.service.ts` 保留在应用侧）。
- 按包 barrel 拆分（`@sp/sync-providers/super-sync` 等）——推迟到 PR 7 打磨。
- `local-file-sync-base.ts:178` 中的 `md5HashPromise` 消费者迁移——LocalFile 切片。
- 删除旧的 `SyncProviderId.SuperSync` 枚举值——应用保留枚举用于 OAuth 路由和配置 UI 分发；包添加字符串常量作为补充。
- `compression-handler.ts` 的应用侧 shim（仍然包装 `EncryptAndCompressHandlerService`；仅 SuperSync 的调用点移至直接的 `@sp/sync-core` 导入）。
- 性能审阅者从 WebDAV 切片提出的 `getElementsByTagNameNS("*", name)` 单次遍历 childNodes 扫描建议——与 SuperSync 无关；为单独的性能优化跟踪。

---

## 切片风险

- **Spec 迁移范围。** 1553 行 Jasmine → Vitest 是本 PR 系列中最大的单次转换。缓解措施：逐 spec 一对一移植，每次转换 `describe` 块后运行包测试，转换期间无语义更改。
- **原生压缩体路径。** 三个 CapacitorHttp 调用点（`super-sync.ts:127, 229, 533`）通过 `executeNativeRequestWithRetry` 路由以规避 Android WebView 的二进制体损坏和 iOS WebKit 的响应体错误。`NativeHttpExecutor` 的 `data: string` 参数是 base64-gzip 负载；验证响应结构（Capacitor 在某些平台上返回 base64 编码的二进制；验证器期望 JSON 解码的对象）由端口适配器正确解码。
- **WebSocket 集成边界。** `SuperSyncWebSocketService` 在应用侧并读取 `getWebSocketParams()`。目前该方法返回纯 `{ baseUrl, accessToken } | null`（无 `SuperSyncProvider` 类型泄漏）——根据共识块将其固定为 JSDoc 不变量。WebSocket 服务保留在应用侧，直到切片 8 打磨时（如果届时需要）。
