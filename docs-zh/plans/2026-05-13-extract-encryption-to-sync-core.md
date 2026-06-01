# 将加密原语提取到 `@sp/sync-core`（v2）

> **状态：✓ 已完成。** 通过 `049dbb5e53`（初始）合并了提取，然后进行了后续多人审阅轮次：
>
> - 将 WebCrypto/`@noble` 策略模式折叠为扁平的 `aesEncrypt`/`aesDecrypt` 辅助函数
> - 将原始 741 行模块拆分为 `packages/sync-core/src/encryption/` 下的五个聚焦文件
> - 将测试覆盖移至 `packages/sync-core/tests/encryption.spec.ts`（vitest，48 个测试）加上 `src/app/op-log/encryption/encryption.browser.spec.ts` 处的 Karma 冒烟 spec
> - 添加了 `setLegacyKdfWarningHandler` 作为补充 `decryptWithMigration` 的结构化 `wasLegacyKdf` 的侧通道诊断
> - 硬化了公共 barrel 以匹配原始计划的表面，并为 `sync-errors.identity.spec.ts` 中的 `WebCryptoNotAvailableError` 添加了 `instanceof` 回归守卫
> - 简化了 `OperationEncryptionService`（删除了 `_encrypt`/`_decrypt` 私有别名）并将 `mock-encryption.helper.ts` 替换为在弱化 Argon2 参数下的真实加密（`setArgon2ParamsForTesting({ memorySize: 8, iterations: 1 })`）
>
> 以下历史计划为上下文保留。

> **给 Claude：** 必选子技能：使用 superpowers:executing-plans 逐任务执行此计划。

**目标：** 仅将纯函数加密原语（`encryption.ts`，704 行）从 `src/app/op-log/encryption/` 移到 `@sp/sync-core`。将 `EncryptAndCompressHandler` 和 `compression-handler.ts`（应用特定的错误/前缀转换包装器）保留在 `src/` 中。将 `OperationEncryptionService` 作为 Angular DI 包装器保留在 `src/` 中。

**为什么现在做：**

1. 现有的 `@sp/sync-core` 已托管框架无关的同步代码；加密适合其既定目的（"Super Productivity 同步的框架无关核心类型和工具"）。
2. `super-sync-server` 在同一 monorepo 中，可能以后需要服务器端加密快照支持——在包中有 `encrypt/decrypt` 使那成为一个导入，而非一个端口。
3. 减少应用表面积（`src/` 减少约 700 行）并让包独立构建/类型检查。
4. 压缩已使用相同模式提取；加密是逻辑上的后续操作。

**架构：** `encryption.ts` 已经是纯函数（无 Angular、无 DI、无 Electron）。其仅有的应用耦合是：（a）一个 `Log.warn` 调用，（b）从 `op-log/core/errors/sync-errors.ts` 导入的 `WebCryptoNotAvailableError`。第一个被折叠到 `DecryptResult` 中（在结构上返回诊断信息）。第二个被移入包中并从 `sync-errors.ts` 重新导出，以便在两个应用侧检查点保持 `instanceof` 身份。

**技术栈：** TypeScript 严格模式、tsup（双 ESM+CJS）、Vitest（包）、Jasmine/Karma（应用 spec 保留在 `src/` 中）、`hash-wasm`（Argon2id）、`@noble/ciphers`（AES-GCM 回退）。

---

## 移动的 vs 保留的内容——修正范围

**移动到 `@sp/sync-core` 的内容：**

- `src/app/op-log/encryption/encryption.ts` → `packages/sync-core/src/encryption.ts`
- `WebCryptoNotAvailableError` 类从 `sync-errors.ts:409-` → `packages/sync-core/src/encryption.ts`（或同级文件）

**保留在 `src/` 中的内容（验证为应用耦合）：**

- `src/app/op-log/encryption/encrypt-and-compress-handler.service.ts` — 导入 `getSyncFilePrefix`/`extractSyncFileStateFromPrefix` 来自 `util/sync-file-prefix.ts`，抛出 `DecryptNoPasswordError` / `JsonParseError` / 应用特定的 `DecryptError`。不进行单独重新设计不可移植。
- `src/app/op-log/encryption/compression-handler.ts` — 包装器，注入 `createCompressError: (e) => new CompressError(e)` 和 `APP_COMPRESSION_LOG_MESSAGES`。删除会丢失 `CompressError`/`DecompressError` 类型和错误消息重写。不在范围。
- `src/app/op-log/sync/operation-encryption.service.ts` — Angular `@Injectable` 包装器，对 `SyncOperation` 进行原语类型化。保留；在任务 3 后从 `@sp/sync-core` 导入原语。

**Spec：** 保留在 `src/` 中并在 Karma 下对包运行。原因：Karma 使用真实 Chrome（完整的 Web Crypto），spec 大量 spy 在 `window.crypto.subtle` 上，将约 790 行 Jasmine 移植到 Vitest 纯粹是搅动。包获得一个公共 API 的小冒烟测试。

**添加到 `@sp/sync-core` 的公共 API：**

- `encrypt`、`decrypt`、`encryptBatch`、`decryptBatch`
- `generateKey`、`deriveKeyFromPassword`、`encryptWithDerivedKey`、`decryptWithDerivedKey`
- `decryptWithMigration`
- `getCryptoStrategy`、`isCryptoSubtleAvailable`
- `clearSessionKeyCache`、`getSessionKeyCacheStats`
- `getArgon2Params`、`setArgon2ParamsForTesting`（受保护——在生产中抛出）
- `base642ab`、`ab2base64`
- `WebCryptoNotAvailableError`
- 类型：`DerivedKeyInfo`、`DecryptResult`（扩展了 `wasLegacyKdf?: boolean`）、`CryptoStrategy`

**从计划中删除的内容对比 v1（审阅驱动）：**

- `EncryptionDecryptError` + `createDecryptError` 注入钩子——`encryption.ts` 抛出零个

**步骤 6：手动验证两个 `instanceof` 站点**

```bash
grep -nE "instanceof (DecryptError|WebCryptoNotAvailableError)" src/app/imex/sync/sync-wrapper.service.ts
```

预期：两行仍然存在，未更改。通过以下方式确认 UX：

- 运行应用，强制解密失败（错误密码），验证密码提示对话框出现。
- （如果可行）在没有 `crypto.subtle` 的上下文中运行，验证 WebCrypto 不可用的 snackbar 出现。

如果这些手动检查不可行，至少确保 `npm run test:file src/app/imex/sync/sync-wrapper.service.spec.ts` 通过——spec 很可能覆盖了两个分支。

**步骤 7：无提交——仅验证。**

---

## 风险登记表

- **生产包中 `hash-wasm` / `@noble/ciphers` 重复。** 缓解措施：任务 2 步骤 2 使用来自根目录的工作区安装，而非 `cd packages/sync-core && npm install`。任务 5 步骤 4 显式比较包体积并运行 `npm ls`。
- **`sync-wrapper.service.ts:728` 处的 `instanceof DecryptError`。** `DecryptError` 由 `encrypt-and-compress-handler.service.ts`（保留在 `src/` 中）抛出，而非 `encryption.ts`。无需更改——被审阅验证标记为非风险。
- **`sync-wrapper.service.ts:754` 和 `create-sha-1-hash.ts:1` 处的 `instanceof WebCryptoNotAvailableError`。** 缓解措施：任务 1 将应用类替换为包类的重新导出，因此身份是单一的。`sync-exports.ts:39` 同样处理。
- **跨双 ESM/CJS 解析的模块级状态。** 会话密钥缓存和 `_argon2Params` 是模块作用域的；如果消费者混合使用 `import` 和 `require`，两个实例会共存。缓解措施：Angular 应用仅使用 ESM；冒烟测试（任务 2 步骤 7）通过已发布的入口往返；包体积差异（任务 5 步骤 4）会暴露出双重解析。
- **`setArgon2ParamsForTesting` 可从生产代码调用。** 在任务 2 步骤 5 中通过 `NODE_ENV === "production"` 守卫缓解。
- **包构建后 Karma 无法解析 `@sp/sync-core`。** 验证 `tsconfig.spec.json` `paths` 包含 `@sp/sync-core` → `packages/sync-core/dist`。如果缺失，在任务 3 步骤 3 之前添加。
- **`decryptWithMigration` 日志丢失。** 一个 `Log.warn` 变为 `DecryptResult.wasLegacyKdf` 标志。任务 3 步骤 2 在应用边界连接警告；如果警告对支持/调试是负载相关的，边界日志会保留它。

---

## 明确排除的范围

- 移动 `EncryptAndCompressHandler`——硬导入 `getSyncFilePrefix`、`extractSyncFileStateFromPrefix`、`DecryptNoPasswordError`、`JsonParseError`、`DecryptError`。需要带有前缀辅助函数注入设计的单独计划。
- 删除 `compression-handler.ts`——不是重复；它用应用特定的错误翻译（`createCompressError: (e) => new CompressError(e)`）和 `APP_COMPRESSION_LOG_MESSAGES` 包装包的压缩。移除它会静默地破坏调用者的错误类型。
- 将 `OperationEncryptionService` 内联到其 3 个消费者中（架构和简洁性审阅者的建议）——单独重构；会简化但提取不需要。
- `encryption.spec.ts` 的 Vitest 移植——推迟到包获得第二个受益于独立测试执行的消费者。
- 对 `@sp/sync-core/vector-clock` 去重 `src/app/core/util/vector-clock.ts`——单独计划，已标注。
- 提取 `LockService`——单独计划；独立价值低。
