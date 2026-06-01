# PR 5 — Dropbox 提供程序切片（设计文档）

> 给执行此计划的 Claude：这是一个**供多人审阅的设计文档**，而非逐步实现计划。一旦以下设计选择获得批准，请重写为 TDD 计划或按照"建议的提交结构"部分进行提交执行。

**目标。** 将 Dropbox 提供程序（`dropbox.ts` + `dropbox-api.ts` + spec）及其支持的错误类和平台工具移入 `@sp/sync-providers`，通过一小套新的包端口实现。在应用侧保留一个薄层 shim，使 `sync-providers.factory.ts` 保持不变继续工作。

**状态。** PR 5 的前四个切片已发布（脚手架、信封类型、PKCE、原生 HTTP 重试）。这是第五个切片，按行数和依赖面积最大。参见 `docs/long-term-plans/sync-core-extraction-plan.md` §"剩余切片计划"第 1 项以了解上下文。

---

## 多人审阅共识（2026-05-12）

六个 Claude 审阅者（正确性、安全性、架构、替代方案、性能、简洁性）并行针对原始设计运行。Codex CLI 已尝试但在只读沙箱中失败；以下结果反映了仅 Claude 的共识。

### 审阅后修订的决策

- **决策 7（shim 形式）。** 将 `class Dropbox extends PackageDropbox` 替换为从 `sync-providers.factory.ts` 直接调用的**工厂函数** `createDropboxProvider(cfg)`。两位审阅者（替代方案 §5、简洁性 W2）强烈推荐此方案；一位（架构 C2）标记了 `extends` 形式中的真实类型不匹配缺陷（`id: typeof PROVIDER_ID_DROPBOX` 对比 `SyncProviderId.Dropbox`）。工厂形式完全移除了 shim 类，去除了两层 `as unknown as` 转换，并且代码库中已有的 `wrappedProvider` 先例使用组合模式。见下面的修订决策 7。

- **决策 3（`WebFetchProvider`）。** 将接口替换为可调用的工厂类型：

  ```ts
  export type WebFetchFactory = () => typeof fetch;
  ```

  强烈共识（架构、替代方案 W2、简洁性 C1）。相同的延迟解析语义，一半的表面面积，无需实现类。

- **决策 3（`ProviderPlatformInfo`）。** 暴露三个布尔值而非合并为一个。架构审阅者标记出未来的提供程序（WebDAV 原生插件、LocalFile SAF）需要区分"Capacitor 原生"和"Android WebView shim"。最终形式：

  ```ts
  export interface ProviderPlatformInfo {
    readonly isNativePlatform: boolean; // capacitor || androidWebView
    readonly isAndroidWebView: boolean;
    readonly isIosNative: boolean;
  }
  ```

- **决策 4（`DropboxFileMetadata`）。** **移动，而非重复。** Grep 确认只有一个消费者（`dropbox-api.ts:5`）。简洁性审阅者的审计（W1）验证了 `imex/sync/dropbox/dropbox.model.ts` 没有其他导入者。移动后删除它。

- **决策 6（`getTokensFromAuthCode` 无重试）。** 向 `ExecuteNativeRequestOptions` 添加 `maxRetries?: number`，并从 `getTokensFromAuthCode` 以 `maxRetries: 0` 调用重试辅助函数。消除了两条路径的不对称（替代方案 §4）。在 `packages/sync-providers/src/http/native-http-retry.ts` 中一行改动。

- **决策 6（超时）。** 显式保留 `NATIVE_REQUEST_READ_TIMEOUT = 120s`（数据调用）和 `NATIVE_AUTH_READ_TIMEOUT = 30s`（令牌刷新 + 授权码交换）。正确性审阅者 W1 发现设计的示例片段省略了 `readTimeout`，会静默地将授权超时增加四倍。

- **决策 8（spec 迁移）。** 三点补充：
  1. `TestableDropboxApi` 子类覆盖模式（第 16-29 行）在 `isNativePlatform` 移入注入的 `deps.platformInfo` 后**不再适用**。Specs 改为每个测试传递不同的 `platformInfo`。
  2. 第 615-635 行的"isNativePlatform getter"测试测试 getter 的存在性，应**删除**而非迁移。该字段只是注入的数据；测试其存在无意义。
  3. 向 `executeNativeRequestWithRetry` 测试调用注入 `delay: vi.fn().mockResolvedValue(undefined)`——否则未跳过的重试测试累积达 36 秒的实际墙钟时间（性能 S5）。

- **决策 8（PKCE 毒化缓存测试）。** Vitest 中对 `globalThis.crypto.subtle` 的 `Object.defineProperty` 依赖于环境。在 Vitest 的 `happy-dom` 环境中验证；如果失败，包现有的 `generatePKCECodes` 已接受 `crypto` 参数（根据 `packages/sync-providers/src/pkce.ts` 导出——确认），spec 应注入一个抛出 mock 替代。

- **建议的提交结构——将错误作为单独 PR 发布。**
  强烈共识（替代方案 §7）且文档接受的理由：错误类迁移是 `instanceof` 影响半径最大的更改，对每个剩余

`DROPBOX_APP_KEY`（在 `src/app/imex/sync/dropbox/dropbox.const.ts` 中）保留在应用侧。它通过 `cfg.appKey` 从工厂传入；包不需要知道应用特定的键。

---

## Lint / 边界检查

根据 `eslint.config.js:168-225` 中针对 `packages/sync-providers/**` 的规则确认：

- ✓ 禁止的导入：`@angular/*`、`@ngrx/*`、`src/app/**`、`@sp/shared-schema`、`@sp/sync-core/*`（子路径）、动态导入。
- ✓ 允许的：`@sp/sync-core`（仅根级）、`hash-wasm`、测试中的 vitest。

移动的文件不得导入 `@capacitor/core`、`SyncProviderId`、`provider.const.ts`、`Log` / `SyncLog`、`IS_ANDROID_WEB_VIEW`、`IS_IOS_NATIVE` 或任何来自 `src/app/` 的内容。

---

## 建议的提交结构

四个提交，匹配切片 4 的结构：

1. `refactor(sync-providers): move provider error classes`
   - 新建 `packages/sync-providers/src/errors/`
   - 新建 `packages/sync-providers/tests/errors.spec.ts`（隐私断言）
   - 在 `src/app/op-log/core/errors/sync-errors.ts` 中重新导出的 shim
   - **验证门控：** 完整的 `npm test` 必须保持绿色。此提交风险最大，因为移动的类在众多调用点中被捕获。如果 spec 中断，几乎可以肯定是 `instanceof` 解析到了错误的构造函数（lint 会暴露重复导入）。

2. `refactor(sync-providers): add platform info and web fetch ports`
   - 新建 `packages/sync-providers/src/platform/`
   - 新建 `src/app/op-log/sync-providers/platform/`
   - 更新包的 barrel 导出。

3. `refactor(sync-providers): move dropbox utilities`
   - `tryCatchInlineAsync` 和 `DropboxFileMetadata` 移动。
   - 应用侧 `try-catch-inline.ts` 删除（导入切换后不再使用）。

4. `refactor(sync-providers): move dropbox provider`
   - `dropbox.ts`、`dropbox-api.ts`、三个 spec 转换为 Vitest。
   - 应用侧 shim 通过工厂连线。
   - 取消跳过的原生平台测试。

**回退计划。** 如果提交 1 造成破坏，将其作为独立 PR（"仅移动提供程序错误类"）发布，并在 Dropbox 实现 PR 之前验证无回归。每个下游切片（WebDAV、SuperSync、LocalFile）都从错误移动中受益，无论 Dropbox 如何。

---

## 验证清单

每次提交后：

- 每个修改过的 `.ts` 运行 `npm run checkFile <path>`。
- `cd packages/sync-providers && npm test`——Vitest 保持绿色。
- 从根目录运行 `npm test`——每个移动错误的消费者仍正常工作。
- `npm run lint`——边界规则保持。
- `npm run sync-providers:build`——tsup 干净地输出 ESM + CJS + DTS。

最终提交后：

- `npm run test:file src/app/op-log/sync-providers/sync-providers.factory.spec.ts` 以及任何相关的 shim spec。
- 在开发构建中手动测试 Dropbox 同步往返。单元测试是主要门控，但 OAuth 刷新 + 带 revToMatch 的上传在单元级别难以完全覆盖——合并在前至少各演练一次。

---

## 待多人审阅的开放问题

1. **选项 A 对比 B 关于 `AdditionalLogErrorBase`。** 是否有审阅者发现放弃构造时日志记录会在可测量程度上削弱诊断能力？
2. **`DropboxFileMetadata` 移动对比重复。** 我是应该删除应用侧的 `imex/sync/dropbox/dropbox.model.ts`，还是保留它作为过渡别名？（见决策 4。）
3. **`isNativePlatform` 语义。** 该端口保留 `Capacitor.isNativePlatform() || IS_ANDROID_WEB_VIEW`。在端口中将 `isNativePlatform` 从 `isAndroidWebView` 拆分出来是否值得，还是保持耦合并在 PR-5 后清理？
4. **日志记录器审计范围。** 我列出了 `dropbox-api.ts` 中需要清理的三种日志调用模式。是否有审阅者希望强制执行其他隐私模式（例如，从记录的 URL 中剥离查询字符串、对路径组件进行哈希处理）？
5. **`DropboxDeps` 粒度。** 我将整个 deps 对象传递给 `DropboxApi`。替代方案：提取一个只包含 `DropboxApi` 使用的字段的 `DropboxApiDeps` 接口。更多的表面但更清晰的耦合。对于一个只有 Dropbox 类实例化的类来说值得吗？
6. **`getTokensFromAuthCode` 的"无重试"注释是否应扩展为文档/类型级别的信号？** 这是一个刻意设计的行为不对称，很容易被意外破坏。

---

## 风险和时间估计

**风险：** 高。按表面积计算是 PR-5 最大的切片。仅错误移动就触及 `imex/sync/`、基于文件的同步适配器、WebDAV 适配器（捕获了错误，未移动提供程序代码）以及许多 spec。

**时间估计：**

- 错误移动顺利：约 4-6 小时专注工作。
- 错误移动触发 spec 变动（例如，构造时日志记录断言）：+2-4 小时。
- 多人审阅反馈周期：+1-3 小时纳入。

总预期：**1-1.5 个工作日**，包括审阅。
