# PR 5 — WebDAV + Nextcloud 切片（设计文档）

> 给执行此计划的 Claude：这是一个**供多人审阅的设计文档**，而非逐步实现计划。一旦以下设计选择获得批准，请重写为 TDD 计划或按照"建议的提交结构"部分进行提交执行。

**目标。** 将 WebDAV + Nextcloud 提供程序（`webdav-base-provider.ts` + `webdav-api.ts` + `webdav-xml-parser.ts` + `webdav-http-adapter.ts` + `webdav.ts` + `nextcloud.ts` + 它们的常量/模型/spec）移入 `@sp/sync-providers`，通过为 Dropbox 引入的端口加上一个用于 Capacitor 注册的 WebDAV HTTP 插件的新端口。保留薄层应用侧工厂 shim，使 `sync-providers.factory.ts` 保持不变继续工作。

**状态。** PR 5 已发布切片 1-5（脚手架、信封类型、PKCE、原生 HTTP 重试、错误类 + Dropbox 主体）。这是提交顺序中的切片 6 / 按剩余切片计划顺序的"下一个切片"。参见 `docs/long-term-plans/sync-core-extraction-plan.md` §"剩余切片计划"第 1 项以了解上下文。

---

## 多人审阅共识（2026-05-12）

四个 Claude 审阅者（安全性/隐私、架构、替代方案、简洁性）并行针对原始设计运行。Codex 和 Copilot 已尝试但因环境原因失败（Codex 被沙箱阻止，Copilot 被 `--deny-tool` 标志的自动模式分类器阻止）。Gemini 最终在工作区沙箱重试和配额节流后完成；其报告在以下每个决策上与 Claude 共识基本一致，末尾的"Gemini 异议"小节中有两项异议。

### Gemini 异议（未采纳）

- **开放问题 1。** Gemini 建议**保留**专用的 `WebDavNativeHttpExecutor` 端口"以与 `NativeHttpExecutor` 命名一致"。被驳回：架构和简洁性审阅者通过代码阅读验证了现有端口已经端到端支持 WebDAV 用例（任意 `method` 字符串、`responseType: 'text'`、`maxRetries: 0`）。命名一致性对抗实际端口重复的理由很弱。
- **开放问题 6。** Gemini 建议添加 **2 次尝试 / 1s+2s 重试策略，带有显式的 `423 Locked` 处理**。被驳回：替代方案和简洁性审阅者都标记了这在移动切片中是行为变化。当前适配器今天有零重试；保持这一点直到经验数据证明需要，保持切片范围作为重构。在开放问题 1 的端口复用决策下，每个调用点的 `maxRetries` 将来如果需要可以轻松添加。

### 审阅后修订的决策

- **开放问题 1（`WebDavNativeHttpExecutor` 端口）— 删除新端口。复用 `NativeHttpExecutor`。** 三位审阅者中的两位（架构、简洁性）验证了现有端口已支持 WebDAV 用例：`NativeHttpRequestConfig` 接受 `method: string`（所以 `PROPFIND` / `MKCOL` / `MOVE` 可以工作），已有 `responseType?: 'text' | 'json'`（所以 XML 保持原始），且 `executeNativeRequestWithRetry` 暴露了带有显式 `0` 支持的 `maxRetries?: number`。自动 JSON 解析的"担忧"是 `CapacitorHttp.request` 的属性，而非端口——端口只是 `(config) => Promise<NativeHttpResponse>`。应用注入了一个不同的**适配器**（连接到 `WebDavHttp` Capacitor 插件而非 `CapacitorHttp`）用于**相同的**端口。替代方案审阅者持异议（更倾向于独立的端口以严格类型化 `data: string`），但架构论证指出响应契约 `data: unknown` 已覆盖字符串，加上 YAGNI 论证胜出。提交 2 缩减为"连接应用侧 `APP_WEBDAV_NATIVE_HTTP: NativeHttpExecutor` 工厂"——无新类型，仅新的适配器连接。

- **开放问题 4（内联 `registerPlugin` 清理）— 在此切片中删除。** 架构审阅者验证了一个真正的正确性问题：`webdav-http-adapter.ts:31` 内联注册 `WebDavHttp`，**没有** `web:` 回退，而 `capacitor-webdav-http/index.ts:4-6` **有** `web: () => import('./web')` 回退。Capacitor 的 `registerPlugin` 按名称是幂等的，所以两者今天都能工作，但带 Web 回退的规范注册才是应该保留的。无论如何，删除内联注册是将适配器移入包的一部分。已解决，未推迟。

- **开放问题 5（CORS 启发式）— 在此切片中收紧。** 两位审阅者（安全性、简洁性）标记出现有的启发式（`webdav-http-adapter.ts:180-219`）既向日志泄露原始错误（隐私回归——Firefox 的"尝试获取资源时出现 NetworkError`<url>`"泄露了完整 URL），又过于宽泛（"Failed to fetch"匹配所有离线状态，不仅仅是 CORS）。合并方法：将启发式压缩为约 3 行检查（`error instanceof TypeError &&

为原始响应负载字段添加结构化记录器构造函数，镜像 Dropbox `AuthFailSPError` 修复。

将隐私清理发现添加到切片的 PR 描述中，以便多人审阅拥有与 Dropbox 切片相同的清单材料。

---

## 建议的提交结构

三个提交：

1. **`refactor(sync-providers): promote shared log helpers`** — 将 `errorMeta(e, extra)` 和 `urlPathOnly(url)` 从 `dropbox-api.ts` 移到 `packages/sync-providers/src/log/error-meta.ts`。从包 barrel 重新导出；更新 Dropbox 导入。无行为变化。
2. **`refactor(sync-providers): add WebDavNativeHttpExecutor port`** — 在 `packages/sync-providers/src/http/webdav-native-http.ts` 中引入端口类型。添加应用侧 `APP_WEBDAV_NATIVE_HTTP` 工厂，连接到现有的 `capacitor-webdav-http/` 插件注册。尚未移动提供程序；此提交独立存在，以便端口表面获得自己的审阅焦点。
3. **`refactor(sync-providers): move WebDAV provider into package`** — 批量移动。上面列出的文件。将 specs 转换为 Vitest。将 `SyncProviderId.WebDAV` / `.Nextcloud` 替换为包常量。将 `md5HashSync` 切换到 `hash-wasm`。内联应用隐私清理发现。将 `WebdavBaseProvider` 直接的 `WebDavHttpAdapter` 实例化替换为构造函数注入的依赖项。应用侧 `webdav.ts` / `nextcloud.ts` 缩小为从 `sync-providers.factory.ts` 调用的 `createWebdavProvider(deps)` / `createNextcloudProvider(deps)` 工厂函数。删除移动的适配器中的内联 `registerPlugin`（子文件夹注册是规范的）。

每个提交独立绿色发布：每次提交后运行包测试 + lint。第三个提交是大的（约 12 个源文件、约 5 个 spec 文件、约 1500 LOC）；如果审阅反馈需要更精细的二分，进一步拆分。

---

## 待多人审阅的开放问题

1. **端口命名。** `WebDavNativeHttpExecutor` 与 `NativeHttpExecutor` 一致但冗长。替代方案：`WebDavHttpTransport`、`WebDavRequestExecutor`。架构审阅者选择。
2. **`md5HashSync` 策略。** 通过 `hash-wasm` 的异步（上面的选项 1）对比通过注入端口的同步（选项 2）。性能审阅者权衡——对 1-2 MB 同步文件每次上传哈希约 10 次可能很重要。
3. **Nextcloud 泛型参数。** 保留 `as unknown as` 转换还是将包泛型扩展为联合类型。简洁性审阅者决定。
4. **内联 `registerPlugin` 清理。** 在此切片中删除还是推迟到后续操作。替代方案审阅者标记范围蔓延。
5. **CORS 检测启发式。** `webdav-http-adapter.ts:180-219` 使用对 `error.message` 的字符串匹配启发式。"模棱两可的网络错误"日志路径也泄露了原始错误。切片是否应收紧此（仅使用结构化元数据）还是推迟？安全性审阅者标记。
6. **`WebDavHttpAdapter` 重试策略。** 目前无重试。切片是否应添加 Dropbox 使用的相同的 2 次尝试 / 1s+2s 策略，还是保留"无重试"行为？性能 + 替代方案审阅者决定。
7. **原生路由 spec 的测试基础设施。** Dropbox 切片通过使用注入的执行器 mock 在 Vitest 下取消跳过了 33 个原生 spec。WebDAV 的 spec 目前使用 `TestableWebDavHttpAdapter` 子类覆盖模式（类似于 Dropbox 切片 5 之前）。计划删除它并注入 `platformInfo` + `nativeHttp` mock 替代——确认 spec 数量差异。
8. **Spec 迁移范围。** `webdav-api.spec.ts` 有 853 行。在移动过程中拆分成几个小文件，还是保持单一以最小化审阅差异？简洁性审阅者决定。

---

## 验证门控

合并前：

- `npm run sync-providers:test` — 包 spec 绿色
- `npm run sync-providers:build` — 包构建，预期包体积增长（约 +15-20 KB ESM）
- `npm run lint` — 边界 lint 干净
- 目标应用 spec：`webdav-base-provider.spec.ts`、`webdav-api.spec.ts`、`webdav-http-adapter.spec.ts`、`webdav-xml-parser.spec.ts`、`sync-wrapper.spec.ts`、`file-based-sync-adapter.spec.ts`、身份 spec
- 完整 `npm test`
- 完整 E2E
- 手动往返测试：针对真实 Nextcloud 的 WebDAV、基于哈希的条件上传（使用 `If-Match` rev 的 PUT）、412 冲突路径、401 重新认证路径、404 新客户端引导

---

## 此切片不涉及的范围

- SuperSync 提供程序移动（切片 7）
- LocalFile 提供程序移动（切片 8）
- `local-file-sync-base.ts` 中的 `md5HashPromise` 消费者迁移——在 LocalFile 切片前不涉及
- 按包 barrel 拆分（`@sp/sync-providers/dropbox`、`/webdav` 等）——推迟到 PR 7 打磨；单一 barrel 在包体积方面仍然没问题
- 删除旧的 `SyncProviderId.WebDAV` / `.Nextcloud` 枚举值——应用保留枚举用于 OAuth 路由和配置 UI 分发；包仅添加字符串常量作为补充
