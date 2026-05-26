# OneDrive PR Review 经验教训总结

> PR #7523: feat(sync): add OneDrive sync provider with PKCE auth
> 审查周期: 2026/05/17 → 2026/05/26 (共 9 轮 review)
> 最终结果: squash merge 为 commit 9910d30fc

## 九轮 Review 总览

| 轮次 | 日期     | 发现的问题                                                           | 类别           |
| ---- | -------- | -------------------------------------------------------------------- | -------------- |
| R1   | 05/17    | JSON 类型过于宽松、敏感字段在日志中暴露                              | 数据安全、类型 |
| R2   | 05/18    | SyncLogger 误用、`/children` 端点分页缺失、未抛出 `NoRevAPIError`    | 协议正确性     |
| R3   | 05/19    | 首次上传需 `conflictBehavior=fail`、`_clearIfConfigMatches` 三重匹配 | 竞态安全       |
| R4   | 05/20    | `?? false` 在可选布尔值上会静默覆盖已有的 `true`                     | JS 语义        |
| R5   | 05/21    | 动态 `import()` 放在 `Promise.all` 中无条件加载了 OneDrive chunk     | 包体积         |
| R6   | 05/22    | `id_token` 日志泄露、手动粘贴授权码时缺少 OAuth state CSRF 校验      | 安全           |
| R7   | 05/23    | 切换 Azure AD 应用身份时需清除旧 token                               | 数据完整性     |
| R8   | 05/24    | Electron tsconfig 缺少 onedrive 路径别名                             | 构建           |
| R9   | 05/25-26 | 非阻塞优化：测试清理、类型导出、后续跟进项                           | 打磨           |

---

## 问题 #1: SyncLogger 类型误用

**现象:** `SyncLogger.log({...})` — 把对象当作第一个参数传入。

**根因:** `SyncLogger.log(message: string, meta?)` 要求第一个参数是字符串。传对象之所以能编译通过，是因为 logger 签名里有 `any`，但这破坏了结构化日志。

**修复:** 改用 `SyncLogger.normal('描述性标签', {...})` — `normal` 方法的第二个参数接受对象。

**教训:** 使用日志工具前先看方法签名。第一个参数永远是给人读的标签，结构化数据放第二个参数。

---

## 问题 #2: OneDrive `/children` 分页

**现象:** `listFiles()` 只返回第一页结果（Graph API 上限约 200 条）。

**根因:** Microsoft Graph API 通过 `@odata.nextLink` 字段分页返回 `/children` 结果。初始实现只取了一页。

**修复:** 用 while 循环追踪 `@odata.nextLink` 直到字段不存在。注意去除 nextLink 中的 Graph API base URL 前缀，因为 `_requestJson` 会自动补前缀。

```typescript
while (nextUrl) {
  const result: OneDriveListResponse =
    await this._requestJson<OneDriveListResponse>(nextUrl);
  const raw: string | undefined = result['@odata.nextLink'];
  nextUrl = raw?.startsWith(ONEDRIVE_PROTOCOL.graphApiBaseUrl)
    ? raw.slice(ONEDRIVE_PROTOCOL.graphApiBaseUrl.length)
    : raw;
}
```

**教训:** 接入任何 API 前先确认是否分页。Microsoft Graph API 统一用 `@odata.nextLink` 做分页 — 在确认不分页之前，默认它分页。

---

## 问题 #3: 上传缺少 NoRevAPIError

**现象:** OneDrive 上传响应缺少 eTag 时，代码静默地让 rev 变成 `undefined`。

**根因:** 其他 file-based provider（WebDAV、Dropbox）在上传响应不含版本标记时都抛出 `NoRevAPIError`。OneDrive 没有抛，破坏了调用方对 "rev 永远是 string" 的预期。

**修复:** 上传后 `!result.eTag` 时抛出 `NoRevAPIError`，与所有兄弟 provider 的行为保持一致。

**教训:** 参考兄弟实现时，要把所有实现都看一遍，特别是边界情况处理。`FileSyncProvider` 接口有隐含契约 — 所有上传要么返回 rev，要么抛 `NoRevAPIError`。

---

## 问题 #4: `?? false` 对可选布尔值的破坏

**现象:** `isCompressionEnabled: newSettings.isCompressionEnabled ?? false` 导致当 `isCompressionEnabled` 在全局配置中已是 `true` 但表单没包含这个字段时（因为它是隐藏字段），保存操作会把它覆盖成 `false`。

**根因:** JavaScript 中 `{...old, key: undefined}` **确实会**覆盖旧值。而 `{...old}`（不包含该 key）则保留旧值。`?? false` 模式强制每次保存都带上这个 key，把 `undefined` 变成 `false`。

**修复:** 用条件展开 — 当值是 undefined 时，整个 key 都不出现在对象中：

```typescript
...(newSettings.isCompressionEnabled !== undefined
  ? { isCompressionEnabled: newSettings.isCompressionEnabled }
  : {}),
```

**教训:**

- JS 展开: `{...old, key: undefined}` ≠ 不包含该 key 的 `{...old}`。前者覆盖，后者保留。
- 配置持久化中，对可选布尔值用 `?? false` 几乎总是错的。
- 当表单不包含某个字段（隐藏、条件显示、在其他标签页），该字段会以 `undefined` 到达保存逻辑。保存逻辑必须区分"用户显式设为 false"和"表单里没这个字段"。

---

## 问题 #5: 动态 import() 放在 Promise.all 中

**现象:** Web 构建即使未配置 OneDrive 也会下载 OneDrive chunk。

**根因:** `Promise.all([import('./a'), import('./b')])` 会**立即**解析所有动态 import，不管外层的 `if` 是否执行。JS 运行时的模块解析发生在 parse 阶段，而不是 if 条件执行时。

**修复:** 把 `import()` 调用移到 `if (IS_ONEDRIVE_SUPPORTED)` 块内部，用延迟加载模式代替 `Promise.all`。

```typescript
// 错误写法 — 无条件加载 OneDrive chunk:
const modules = await Promise.all([
  import('./webdav'),
  IS_ONEDRIVE_SUPPORTED ? import('./onedrive') : Promise.resolve(null),
]);

// 正确写法 — 只在需要时加载:
const modules = await Promise.all([import('./webdav')]);
if (IS_ONEDRIVE_SUPPORTED) {
  const onedriveModule = await import('./onedrive');
  // ...使用
}
```

**教训:** `Promise.all` 中的动态 `import()` 即使被三元表达式包裹也会触发模块加载器。判断必须发生在 `import()` 调用**之前**，而不是作为三元表达式写在里面。

---

## 问题 #6: 切换 Azure AD 应用身份时旧 token 未清除

**现象:** 用户从一个 Azure AD 应用切换到另一个（不同的 clientId/tenantId）时，旧应用的 OAuth token 可能残留。

**根因:** `_persistOneDriveFormCfgBeforeAuth` 方法没有检测到用户在两次授权之间修改了 `useCustomApp`、`clientId` 或 `tenantId`。

**修复:** 三重匹配守卫 — 比较已有配置和新表单值之间的 `refreshToken`、`clientId` 和 `tenantId`（或 `useCustomApp`）。身份相关字段有变化时就清空 token。

```typescript
const identityChanged =
  existingCfg?.useCustomApp !== formOneDriveCfg.useCustomApp ||
  existingCfg?.clientId !== formOneDriveCfg.clientId ||
  existingCfg?.tenantId !== formOneDriveCfg.tenantId;

const mergedCfg: OneDrivePrivateCfg = {
  ...(existingCfg || {}),
  ...formOneDriveCfg,
  ...(identityChanged ? { accessToken: '', refreshToken: '', tokenExpiresAt: 0 } : {}),
};
```

**教训:** OAuth token 绑定到特定的应用注册身份。当用户切换身份（改 clientId、tenantId 或切换自建/官方应用），旧 token 必须清除。漏掉这个就会看到莫名其妙的 401 错误。

---

## 问题 #7: Electron tsconfig.json — 双份 paths 配置

**现象:** `npm run dist:win` 在 Electron TypeScript 编译时报 `Cannot find module '@sp/sync-providers/onedrive'`。

**根因:** 项目有**两份** tsconfig，各自维护独立的 `paths` 配置：

- `tsconfig.base.json` — Angular/web 构建使用
- `electron/tsconfig.electron.json` — Electron 主进程构建使用

两个文件都为 `@sp/sync-providers/*` 系列定义了 `paths` 映射。Electron 那份是独立的，因为它 target CommonJS/Node 而非 ESM/browser。当 OneDrive 的路径别名添加到 `tsconfig.base.json` 时，**没有同步添加到 `electron/tsconfig.electron.json`**。

我在 review 时检查了 `tsconfig.base.json` 和 `src/tsconfig.spec.json`，但没想到还有一份 Electron 专用的 tsconfig。

**修复:** 在 `electron/tsconfig.electron.json` 中添加 `"@sp/sync-providers/onedrive": ["packages/sync-providers/dist/onedrive.d.ts"]`。

**教训:**

- 新增包别名时，搜索**所有** tsconfig 文件中的已有别名，不要只看 base 那一份。
- `grep -r "sync-providers" **/tsconfig*.json` 五秒钟就能发现这个问题。
- Electron + Angular 混合项目普遍有这种 split-tsconfig 模式。两个都要检查。

---

## 问题 #8: 手动粘贴授权码缺少 OAuth state CSRF 校验

**现象:** "粘贴授权码"对话框接受任何 URL 或编码，没有校验 OAuth 的 `state` 参数。

**根因:** 对话框的 `_normalizeAuthCodeInput()` 解析了 URL 但没有验证 `state` 查询参数，而 state 是 OAuth 流程中的 CSRF 防护。

**修复:** 对 OneDrive 的完整 URL 粘贴，要求 `state` 必须存在且有效：

- 缺少 state → 拒绝并弹出错误提示
- state 无效（与 `validateOAuthState()` 存储的值不匹配）→ 拒绝并弹出错误提示
- 纯编码粘贴（非 URL）→ 不受影响，走正则兜底逻辑（PKCE verifier 在 token 交换时做二次校验）

**教训:** OAuth 中每个提供安全性的参数都必须在接收时校验。`state` 参数防止 CSRF — 跳过校验就等于放弃了这层防护。但不要阻止纯编码粘贴（用户只复制编码而非完整重定向 URL 的常见场景），因为 token 交换时的 PKCE 校验提供了第二道防线。

---

## 问题 #9: 首次创建上传需 `conflictBehavior=fail`

**现象:** 两台设备同时初始化同步时，可能静默覆盖彼此的第一个 `sync-data.json`。

**根因:** 初始上传使用 `isForceOverwrite=false`（允许冲突解决），但首次创建上传意味着文件不应该已存在 — 如果已存在则说明另一台设备抢先了。

**修复:** 首次上传（rev 为空时）使用 `conflictBehavior=fail`。如果文件已存在，显式失败并在下次同步周期重新下载。

```typescript
const uploadResult = await this._adapter.uploadFile(
  targetPath,
  dataStr,
  '', // 空 rev = 首次上传
  false, // isForceOverwrite
  'fail', // conflictBehavior — 文件已存在则失败
);
```

**教训:** "创建"和"更新"是不同的操作。创建时如果资源已存在却成功覆盖，这就是静默覆盖 bug。始终区分首次写入和后续更新。

---

## 问题 #10: `id_token` 日志暴露

**现象:** Microsoft token 端点除了 `access_token` 和 `refresh_token` 外还返回 `id_token`（JWT）。`id_token` 包含用户身份信息。

**根因:** 敏感字段脱敏列表包含 `access_token` 和 `refresh_token`，但没有 `id_token`。

**修复:** 把 `'id_token'` 加入 `SENSITIVE_KEYS` 日志脱敏数组。

**教训:** 接入 OAuth provider 时，检查 token 响应中的**所有**字段。`id_token` 是签名的 JWT，含有 PII（姓名、邮箱、UPN）。日志中必须脱敏。

---

## 做得好的地方

尽管经历了 9 轮 review，整体架构从一开始就是正确的：

- **PKCE OAuth 流程**选择和实现都是对的
- **FileSyncProvider 接口**集成干净 — OneDrive 遵循了已有模式
- **双层乐观锁**（syncVersion + ETag）设计正确
- **Token 并发控制**（single-flight refresh）实现正确
- **单元测试**（260 行）在 review 重构期间提供了回归保护

---

## 流程反思：为什么这些问题没在一开始被发现

1. **检查了 tsconfig.base.json 但遗漏了 electron/tsconfig.electron.json** — 新增路径别名时应 grep **所有** tsconfig 文件。

2. **以为 `npm run checkFile` 通过就等于构建没问题** — `checkFile` 只跑 prettier + eslint 单文件检查，不跑 Electron 的 TypeScript 编译。

3. **push 之前没有跑 `npm run dist`** — 生产构建能立即发现 Electron tsconfig 问题。但 `dist` 跑一次约 10 分钟还需要网络，成本确实高。

4. **以为 reviewer 没提某个区域就等于没问题** — 多轮 review 后有些问题存活下来，因为作者和 reviewer 都没有每轮重读完整 diff。最后一轮 push 前如果有一份 checklist 逐文件重新审查，tsconfig 问题就能被抓住。

---

## 未来新增 Sync Provider 的提交前自检清单

提交新增 sync provider 的 PR 之前：

- [ ] `grep -r "sync-providers" **/tsconfig*.json` — 确保所有 tsconfig 文件都有新别名
- [ ] `grep -r "PROP_MAP_TO_FORM" src/` — 确认 provider 到表单的映射
- [ ] `grep -r "PROVIDER_FIELD_DEFAULTS" src/` — 确认新 provider 的字段默认值
- [ ] 逐一对比兄弟 provider 的边界处理（NoRevAPIError、分页、token 刷新）
- [ ] `grep -r "SENSITIVE_" src/` — 确保 token 响应中所有字段都已脱敏
- [ ] 每个修改的文件都跑一次 `npm run checkFile`
- [ ] 跑 `npm test`（全部单测）
- [ ] 如果改了 Electron 相关文件，跑 `tsc -p electron/tsconfig.electron.json --noEmit`
- [ ] 如果改了 `tsconfig*.json`，确认 base 和 electron 两份配置已同步
- [ ] 确认动态 import 都在 feature gate 后面（不在 `Promise.all` 里用三元表达式）
- [ ] 实测：用只有部分字段的表单保存配置 → 验证不会出现 falsy 值覆盖已有 truthy 配置

---

## Reviewer 后续

PR 合并后 reviewer 开了两个 issue：

- **#7797** — 跟踪 4 个打磨项
- **#7800** — 实现这些打磨项的 PR

这些是非阻塞改进，不需要阻碍合并。
