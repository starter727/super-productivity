# 评审经验教训

# OneDrive PR Review 经验教训总结

> PR #7523: feat(sync): add OneDrive sync provider with PKCE auth
> 审查周期: 2026/05/08 → 2026/05/26 (共 7 轮 PR conversation comment + 2 轮正式 review = 9+ 轮审查)
> 最终结果: squash merge 为 commit 9910d30fc
> Reviewer: johannesjo
> 本文档记录了 39 个 review 发现的问题 (#1–#20 来自最终正式 review, #21–#39 来自中间轮次的 conversation comment)

---

## 目录

1. [九轮 Review 总览](#九轮-review-总览)
2. [时序与并发控制（贯穿多轮的核心主题）](#时序与并发控制贯穿多轮的核心主题)
3. [逐问题详解](#逐问题详解)
   - [问题 #1: SyncLogger 类型误用](#问题-1-synclogger-类型误用)
   - [问题 #2: OneDrive /children 分页缺失](#问题-2-onedrive-children-分页缺失)
   - [问题 #3: 上传缺少 NoRevAPIError](#问题-3-上传缺少-norevapierror)
   - [问题 #4: ?? false 对可选布尔值的破坏](#问题-4--false-对可选布尔值的破坏)
   - [问题 #5: 动态 import() 放在 Promise.all 中](#问题-5-动态-import-放在-promiseall-中)
   - [问题 #6: 切换 Azure AD 应用身份时旧 token 未清除](#问题-6-切换-azure-ad-应用身份时旧-token-未清除)
   - [问题 #7: Electron tsconfig 双份 paths 配置](#问题-7-electron-tsconfig-双份-paths-配置)
   - [问题 #8: 手动粘贴授权码缺少 OAuth state CSRF 校验](#问题-8-手动粘贴授权码缺少-oauth-state-csrf-校验)
   - [问题 #9: 首次创建上传需 conflictBehavior=fail](#问题-9-首次创建上传需-conflictbehaviorfail)
   - [问题 #10: id_token 日志暴露](#问题-10-idtoken-日志暴露)
   - [问题 #11: Refresh-token 端点错误不清除凭证](#问题-11-refresh-token-端点错误不清除凭证)
   - [问题 #12: clearAuthCredentials() 与 in-flight refresh 竞态](#问题-12-clearauthcredentials-与-in-flight-refresh-竞态)
   - [问题 #13: OAuth 授权码通过 SyncLog 泄露](#问题-13-oauth-授权码通过-synclog-泄露)
   - [问题 #14: validateOneDriveOAuthState 循环依赖](#问题-14-validateonedriveoauthstate-循环依赖)
   - [问题 #15: Web 构建的 nativeclient 重定向 URI 问题](#问题-15-web-构建的-nativeclient-重定向-uri-问题)
   - [问题 #16: Token 错误重试策略与 Dropbox 不对称](#问题-16-token-错误重试策略与-dropbox-不对称)
   - [问题 #17: 死亡的 oneDriveAuth 属性和未使用的翻译键](#问题-17-死亡的-oneDriveauth-属性和未使用的翻译键)
   - [问题 #18: \_cfgOrError(requireAuth) 参数从未使用](#问题-18-_cfgorerrorrequireauth-参数从未使用)
   - [问题 #19: 文件夹缓存未随 syncFolderPath 变化失效](#问题-19-文件夹缓存未随-syncfolderpath-变化失效)
   - [问题 #20: clearAuthCredentials() 注释过度承诺](#问题-20-clearauthcredentials-注释过度承诺)
4. [中间轮次 Review 的额外发现 (C1–C6, 问题 #21–#39)](#中间轮次-review-的额外发现-c1c6)
5. [流程反思：为什么这些问题没在一开始被发现](#流程反思为什么这些问题没在一开始被发现)
6. [做得好的地方](#做得好的地方)
7. [未来新增 Sync Provider 的提交前自检清单](#未来新增-sync-provider-的提交前自检清单)
8. [Reviewer 后续](#reviewer-后续)

---

## 九轮 Review 总览

| 轮次 | 日期     | 发现的问题                                                                       | 严重程度         | 类别           |
| ---- | -------- | -------------------------------------------------------------------------------- | ---------------- | -------------- |
| R1   | 05/08    | Refresh-token 端点错误不清除凭证、clearAuthCredentials 与 in-flight refresh 竞态 | 阻塞（Critical） | 时序安全、认证 |
| R2   | 05/08+   | SyncLogger 误用、`/children` 端点分页缺失、未抛出 `NoRevAPIError`                | 阻塞             | 协议正确性     |
| R3   | 05/19    | 首次上传需 `conflictBehavior=fail`、`_clearIfConfigMatches` 三重匹配             | 阻塞             | 竞态安全       |
| R4   | 05/20    | `?? false` 在可选布尔值上会静默覆盖已有的 `true`                                 | 阻塞             | JS 语义        |
| R5   | 05/21    | 动态 `import()` 放在 `Promise.all` 中无条件加载了 OneDrive chunk                 | 阻塞             | 包体积         |
| R6   | 05/22    | `id_token` 日志泄露、手动粘贴授权码时缺少 OAuth state CSRF 校验                  | 阻塞+非阻塞      | 安全           |
| R7   | 05/23    | 切换 Azure AD 应用身份时需清除旧 token                                           | 阻塞             | 数据完整性     |
| R8   | 05/24    | Electron tsconfig 缺少 onedrive 路径别名                                         | 阻塞             | 构建           |
| R9   | 05/25-26 | 非阻塞优化：测试清理、类型导出、后续跟进项                                       | 非阻塞           | 打磨           |
| R10  | 05/21\*  | Review #2 跟进：clearAuthCredentials 注释过度承诺、测试名不匹配断言              | 非阻塞           | 打磨           |

\* R10 是 reviewer 对 `b11ebd58..82fb5a1e` delta 的第二轮正式 review。

上表中 R1–R9 来自 PR 过程中逐轮修复的迭代，R10 来自第二轮正式 review。这些轮次中标注为「阻塞」的问题在 merge 前均已修复；部分非阻塞项作为后续跟进（见下方 [遗留项](#未在-pr-中处理的遗留项)）。此外，在 R1 和 R10（两轮正式 review）之间，还有 6 轮 PR conversation comment（C1–C6, 2026/05/20–05/23），每轮 reviewer 在 recheck 最新 commit 时提出了额外的发现。这些中间轮次的问题（#21–#39）在后续提交中被逐一修复，详见下方"中间轮次 Review 的额外发现"章节。

---

## 时序与并发控制（贯穿多轮的核心主题）

Reviewer 在多个轮次中反复审查了并发场景下的正确性。以下是 PR 涉及的并发控制面及发现的问题：

### 并发控制全景图

```
┌─────────────────────────────────────────────────────────────┐
│                    并发控制层次                               │
├─────────────────────────────────────────────────────────────┤
│ 1. Token 刷新层    → 单飞锁 (_isRefreshingToken)            │
│ 2. 文件传输层      → ETag + If-Match (HTTP 412)             │
│ 3. 内容同步层      → syncVersion 乐观锁                      │
│ 4. 首次创建层      → conflictBehavior=fail                   │
│ 5. 配置保存层      → _lastSettings 去重 + 条件展开           │
│ 6. 凭证管理层      → 三重身份匹配 + 原子清除                  │
│ 7. 同步周期层      → _isSyncing 全局锁                       │
└─────────────────────────────────────────────────────────────┘
```

### Reviewer 审查的核心时序场景

**场景 A: 双设备同时首次同步（问题 #9）**

```
时间轴 →

设备 A                     OneDrive                 设备 B
  │                          │                       │
  │── GET sync-data.json ──→│                       │
  │←── 404 Not Found ──────│                       │
  │                          │←── GET sync-data.json │
  │                          │──→ 404 Not Found      │
  │                          │                       │
  │── PUT sync-data.json ──→│                       │
  │   (创建文件, rev='')     │                       │
  │←── 201 Created ────────│                       │
  │                          │←── PUT sync-data.json │
  │                          │    (创建文件, rev='')  │  ← BUG 点
  │                          │──→ 成功覆盖!           │
  │                          │                       │
  │  设备 A 的数据被静默丢失  │                       │
```

**修复后（conflictBehavior=fail）**:

```
  │                          │←── PUT (rev='', conflict=fail)
  │                          │──→ 409/412 Conflict    │  ← 文件已存在
  │                          │                       │
  │                          │  设备 B 感知冲突        │
  │                          │  下次同步周期重新下载    │
```

**Reviewer 意见**: "创建"和"更新"是不同语义的操作。创建时如果资源已存在，必须显式失败而非静默覆盖。`conflictBehavior=fail` 告诉 OneDrive API: 我期望这是一个新文件，如果已经存在就不要覆盖。

---

**场景 B: 表单保存引发的配置覆盖（问题 #4）**

```
时间轴 →

用户操作                    Formly                    NgRx Store
  │                          │                         │
  │  打开同步设置页           │                         │
  │                          │── modelChange #1 ──────→│
  │                          │   (表单初始化)            │  sync.isCompressionEnabled = true
  │                          │                         │  (用户之前的设置)
  │                          │                         │
  │  切换 provider            │                         │
  │  到 OneDrive              │── modelChange #2 ──────→│
  │                          │   isCompressionEnabled   │
  │                          │   不在当前表单中          │  ← 隐藏字段，值为 undefined
  │                          │   传 undefined            │
  │                          │                         │
  │                          │   updateSettingsFromForm │
  │                          │   globalConfig = {       │
  │                          │     isCompressionEnabled │
  │                          │       : undefined        │  ← 来自表单
  │                          │       ?? false           │  ← = false!
  │                          │   }                      │
  │                          │                         │
  │                          │   NgRx reducer:          │
  │                          │   {...oldSection,        │
  │                          │    ...normalizedCfg}     │  ← key 存在，覆盖!
  │                          │                         │
  │                          │                         │  sync.isCompressionEnabled
  │                          │                         │  被覆盖为 false ❌
```

**根因链条**:

1. Formly 的 `modelChange` 在切换表单页时触发多次
2. 当前不可见的字段（隐藏的、在另一标签页的）值为 `undefined`
3. `?? false` 把 `undefined` 变成 `false`
4. NgRx reducer 的 `{...oldState, ...newState}` 中，key 存在就覆盖，不管值是不是 `undefined`

**修复**: 条件展开 —— 当值是 `undefined` 时，整个 key 不出现在对象中：

```typescript
...(val !== undefined ? { key: val } : {})
```

**Reviewer 意见**: 这是整个 PR 中讨论最多的问题。最初用了 `?? false` 作为"修正"，但 reviewer 指出这更危险 —— 它让每次保存都变成破坏性的。正确的做法是区分"用户没设置"（key 不出现在对象中）和"用户设为 false"（key 出现且值为 false）。

---

**场景 C: Token 刷新的并发控制（初始实现正确，reviewer 验证通过）**

```
时间轴 →

两个并发的 API 调用:

API Call #1                              API Call #2
  │                                        │
  │ 检查 token 过期                         │ 检查 token 过期
  │ expiresAt < now + 5min → 需要刷新       │ expiresAt < now + 5min → 需要刷新
  │                                        │
  │ _refreshAccessTokenIfNeeded()          │ _refreshAccessTokenIfNeeded()
  │ _isRefreshingToken = true              │ if (_isRefreshingToken) {
  │                                        │   // 等待 #1 完成
  │ POST /token (refresh_token_1)          │   while (_isRefreshingToken) {
  │ ← 200 OK (access_token_2,             │     await sleep(50);
  │           refresh_token_2)              │   }
  │ 更新 token 到内存                       │   return;  ← 直接返回，不重复刷新
  │ _isRefreshingToken = false             │ }
  │                                        │
  │ 继续执行 API Call #1                    │ 继续执行 API Call #2
  │ (使用新 token)                          │ (使用 Call #1 刷新的 token)
```

**关键设计点**:

- `_isRefreshingToken` 布尔标志 + while 轮询（50ms间隔）
- 不依赖 Promise 缓存（token 值会变，不能用简单的 memo）
- `finally` 块确保标志位一定被重置（即使刷新失败）

**Reviewer 意见**: 单飞锁模式是正确的，但要注意边界 —— 如果刷新失败（网络错误、refresh_token 过期），标志位必须在 `finally` 中清除，否则所有后续请求永久阻塞。

---

**场景 D: 凭证清除的时序安全（问题 #6）**

```
时间轴 →

用户切换 Azure AD 应用:

操作                                    配置状态
  │
  │ 1. 用户打开设置，当前 OneDrive 配置:     privateCfg = {
  │    useCustomApp: true                     useCustomApp: true,
  │    clientId: "app-old-uuid"               clientId: "app-old-uuid",
  │    accessToken: "tok_old"                 accessToken: "tok_old",
  │    refreshToken: "ref_old"                refreshToken: "ref_old"
  │                                         }
  │
  │ 2. 用户改为新 app 的 clientId            formValues = {
  │    clientId: "app-new-uuid"               clientId: "app-new-uuid",  ← 变了
  │                                         }
  │
  │ 3. 用户点击 Authorize
  │    → _persistOneDriveFormCfgBeforeAuth()
  │
  │    旧逻辑（BUG）:
  │    mergedCfg = { ...existingCfg, ...formCfg }
  │    // accessToken: "tok_old" 还在!     ← 旧 token 残留
  │    // 授权后会覆盖，但万一用户取消授权，
  │    // 旧 token 就被错误保留
  │
  │    新逻辑（修复）:
  │    identityChanged =
  │      old.useCustomApp !== new.useCustomApp ||
  │      old.clientId !== new.clientId ||
  │      old.tenantId !== new.tenantId
  │
  │    if identityChanged:
  │      mergedCfg.accessToken = ''         ← 清除
  │      mergedCfg.refreshToken = ''        ← 清除
  │      mergedCfg.tokenExpiresAt = 0       ← 清除
```

**Reviewer 意见**: 身份检测必须基于三个维度（useCustomApp、clientId、tenantId），缺一不可。只比较一个字段（比如只比较 clientId）不够 —— 用户可能从官方应用切换到自建应用，此时 useCustomApp 变了但 clientId 可能为空。

---

## 逐问题详解

### 问题 #1: SyncLogger 类型误用

**发现轮次**: R2

**错误代码**:

```typescript
// onedrive.ts - 原始实现
logger.log({ method: 'GET', url: '/me/drive/...' } as unknown as string);
```

**Reviewer 指出的问题**: `SyncLogger.log(message: string, meta?)` 的第一个参数必须是字符串。用 `as unknown as string` 强制类型转换虽然能编译，但破坏了结构化日志 —— 对象被 `toString()` 成 `[object Object]`，日志中无法搜索和过滤。

**修复**:

```typescript
logger.normal('OneDrive.request', {
  method: 'GET',
  url: '/me/drive/...',
});
```

**教训**:

- 日志工具的第一个参数永远是给人读的标签，结构化数据放第二个参数
- `as unknown as string` 这种双重类型断言是危险信号 —— 它绕过了类型系统的保护
- 所有 provider（WebDAV、Dropbox 等）都用 `logger.normal(label, meta)` 模式，新 provider 应该一致

---

### 问题 #2: OneDrive `/children` 分页缺失

**发现轮次**: R2

**错误代码**:

```typescript
// onedrive.ts - 原始 listFiles
async listFiles(): Promise<string[]> {
  const result = await this._requestJson<OneDriveListResponse>(
    `/me/drive/special/approot:/${this.syncFolderPath}:/children`
  );
  return (result.value || []).map(item => item.name);
}
```

**Reviewer 指出的问题**: Microsoft Graph API 的 `/children` 端点默认只返回前 200 条。sync-data.json 只有一个文件所以测不出来，但 `listFiles()` 是通用接口，将来可能用于列出多个同步文件。如果用户有超过 200 个文件，只会拿到第一页。

**修复**:

```typescript
async listFiles(): Promise<string[]> {
  const names: string[] = [];
  let nextUrl: string | undefined =
    `/me/drive/special/approot:/${this.syncFolderPath}:/children`;

  while (nextUrl) {
    const result = await this._requestJson<OneDriveListResponse>(nextUrl);
    if (result.value) {
      names.push(...result.value.map(item => item.name));
    }
    const raw: string | undefined = result['@odata.nextLink'];
    // _requestJson 会自动补 graphApiBaseUrl 前缀，所以要剥掉
    nextUrl = raw?.startsWith(ONEDRIVE_PROTOCOL.graphApiBaseUrl)
      ? raw.slice(ONEDRIVE_PROTOCOL.graphApiBaseUrl.length)
      : raw;
  }
  return names;
}
```

**教训**:

- 接入任何 REST API 前先确认分页策略
- Microsoft Graph API 统一用 `@odata.nextLink` 做分页 —— 默认假设它分页
- `_requestJson` 会自动补 base URL 前缀，处理 `@odata.nextLink` 时要注意剥掉，否则 URL 变成 `https://graph.microsoft.com/v1.0/https://graph.microsoft.com/v1.0/...`

---

### 问题 #3: 上传缺少 NoRevAPIError

**发现轮次**: R2

**错误代码**:

```typescript
// 上传后解析响应
const result = await response.json();
return { rev: result.eTag }; // 如果 eTag 不存在，rev = undefined
```

**Reviewer 指出的问题**: `FileSyncProvider` 接口的上传方法签名为 `uploadFile(...): Promise<{ rev: string }>` —— rev 必须是 string。其他所有 provider（WebDAV、Dropbox、LocalFile）在上传响应缺少版本标记时都抛出 `NoRevAPIError`。OneDrive 不抛，破坏了接口契约，让调用方的类型安全形同虚设。

**为什么 OneDrive 可能不返回 eTag**: 某些 OneDrive 租户配置或 API 版本下，PUT 响应头可能不包含 ETag。这在 Microsoft Graph API 的文档中没有明确保证。

**修复**:

```typescript
const result = (await response.json()) as { eTag?: string };
if (!result.eTag) {
  throw new NoRevAPIError('OneDrive upload response missing eTag');
}
return { rev: result.eTag };
```

**教训**: 实现已有接口的新 provider 时，必须逐一检查兄弟实现的边界处理，确保行为一致。

---

### 问题 #4: `?? false` 对可选布尔值的破坏

**发现轮次**: R4（PR 最讨论最多的问题）

**演化过程**:

```
原始代码      → 解构赋默认值（有 bug，但类型不安全）
OneDrive PR   → 显式字面量赋值（仍然有 bug）
第 6 轮 review → 加了 ?? false（更危险！）
第 9 轮 review → 条件展开（最终正确方案）
```

**第 6 轮的"修正"（错的）**:

```typescript
let globalConfig: SyncPublicConfig = {
  isEnabled: newSettings.isEnabled ?? false,
  syncProvider: newSettings.syncProvider ?? null,
  syncInterval: newSettings.syncInterval ?? 300000,
  isEncryptionEnabled: newSettings.isEncryptionEnabled ?? false, // ← BUG
  isCompressionEnabled: newSettings.isCompressionEnabled ?? false, // ← BUG
};
```

**为什么 `?? false` 比原始代码更危险**:

原始代码（解构赋默认值）至少某些情况下 key 不存在于对象中。`?? false` 强制 key 永远存在且值为 false（当表单没提供时），导致每次通过 `updateSettingsFromForm` 保存时都覆盖为 false。

**NgRx reducer 中发生什么**:

```typescript
// global-config.reducer.ts (简化)
function configReducer(state, action) {
  const sectionKey = action.sectionKey; // 'sync'
  const normalizedSectionCfg = action.payload; // { isCompressionEnabled: false, ... }

  return {
    ...state,
    [sectionKey]: {
      ...state[sectionKey], // { isCompressionEnabled: true, ... }
      ...normalizedSectionCfg, // { isCompressionEnabled: false, ... }
      // ↑ key 存在 → 覆盖为 false!
    },
  };
}
```

**最终正确方案（第 9 轮）**:

```typescript
let globalConfig: SyncPublicConfig = {
  isEnabled: newSettings.isEnabled ?? false,
  syncProvider: newSettings.syncProvider ?? null,
  syncInterval: newSettings.syncInterval ?? 300000,
  // 条件展开：undefined 时整个 key 不出现在对象中
  ...(newSettings.isEncryptionEnabled !== undefined
    ? { isEncryptionEnabled: newSettings.isEncryptionEnabled }
    : {}),
  ...(newSettings.isCompressionEnabled !== undefined
    ? { isCompressionEnabled: newSettings.isCompressionEnabled }
    : {}),
  ...(newSettings.isManualSyncOnly !== undefined
    ? { isManualSyncOnly: newSettings.isManualSyncOnly }
    : {}),
};
```

**Reviewer 的核心观点**: JS 对象展开中，`{...old, key: undefined}` ≠ 不包含 key 的 `{...old}`。前者覆盖，后者保留。对于可选布尔值配置，正确的语义是"我没设这个字段 = 保持原样"，而不是"我没设 = 关掉"。

**教训**:

- `?? false` 在配置持久化中几乎永远不对
- 表单的隐藏字段会以 `undefined` 到达保存逻辑
- 保存逻辑必须区分三种状态：用户设为 true、用户设为 false、用户没碰这个字段
- TypeScript 的 `SyncPublicConfig` 用 `Omit` 排除 provider 特定字段，在编译时保证了类型安全，但运行时的 JS 展开语义需要单独理解

---

### 问题 #5: 动态 import() 放在 Promise.all 中

**发现轮次**: R5

**错误代码**:

```typescript
// sync-providers.factory.ts
const modules = await Promise.all([
  import('./dropbox/dropbox'),
  import('./webdav/webdav'),
  import('./local-file/local-file'),
  import('./nextcloud/nextcloud'),
  IS_ONEDRIVE_SUPPORTED ? import('./onedrive/onedrive') : Promise.resolve(null),
]);
```

**Reviewer 指出的问题**: `Promise.all([...])` 中的 `import()` 调用在**数组构造阶段**就被求值，不是等到条件判断时。JS 引擎在解析 `import()` 表达式时就触发模块加载，不管三元表达式的结果是什么。所以 Web 构建（IS_ONEDRIVE_SUPPORTED = false）也会下载 OneDrive 的 ~100KB chunk。

**技术细节**: 这与 `Promise.all` 本身的执行机制无关 —— 问题出在 JavaScript 的表达式求值顺序。数组字面量 `[a, b, c]` 中的所有元素表达式都在数组创建时求值。`IS_ONEDRIVE_SUPPORTED ? import('./onedrive') : Promise.resolve(null)` 中，`import('./onedrive')` 是一个表达式，它的求值会触发动态模块加载。

**修复**:

```typescript
const modules = await Promise.all([
  import('./dropbox/dropbox'),
  import('./webdav/webdav'),
  import('./local-file/local-file'),
  import('./nextcloud/nextcloud'),
]);

// OneDrive 的 import 必须在条件分支内部
if (IS_ONEDRIVE_SUPPORTED) {
  const onedriveModule = await import('./onedrive/onedrive');
  modules.push(onedriveModule);
}
```

**教训**:

- 动态 `import()` 是表达式，不是语句 —— 它出现在哪里就在哪里求值
- 条件加载必须让 `import()` 调用本身在条件分支内，不能在 `Promise.all` 中用三元表达式
- 可以用 webpack bundle analyzer 验证 chunk 是否正确分离

---

### 问题 #6: 切换 Azure AD 应用身份时旧 token 未清除

**发现轮次**: R3 + R7

**场景**: 用户可能拥有多个 Azure AD 应用注册（测试用 vs 生产用，或者切换自建/官方应用）。当用户在 OneDrive 配置中修改 `useCustomApp`、`clientId` 或 `tenantId` 后重新授权时，旧应用的 token 如果不清除，会导致：

1. 用旧 token 调用新应用的 API → 401/403 错误
2. Token 刷新时会用旧 refresh_token 换新应用的 token → 失败

**错误代码（R3 前）**:

```typescript
// dialog-sync-cfg.component.ts
private async _persistOneDriveFormCfgBeforeAuth(): Promise<void> {
  const existingCfg = await this._providerManager.getProviderConfig(
    SyncProviderId.OneDrive
  );
  const formOneDriveCfg = this.form.get('oneDrive')?.value;

  // 直接合并，不检测身份变化
  const mergedCfg = {
    ...(existingCfg || {}),
    ...formOneDriveCfg,
  };
  await this._providerManager.setProviderConfig(
    SyncProviderId.OneDrive,
    mergedCfg
  );
}
```

**中间修复（R3 - 部分解决）**: 添加了 `_clearIfConfigMatches` —— 当 credential store 中的 token 与当前 provider 配置的 clientId/tenantId 不匹配时清除。但这个方法只解决了一半问题 —— 清除发生在 credential store 层，而不是 provider config 层。

**最终修复（R7）**: 在 `_persistOneDriveFormCfgBeforeAuth` 中直接做身份变更检测：

```typescript
const identityChanged =
  existingCfg?.useCustomApp !== formOneDriveCfg.useCustomApp ||
  existingCfg?.clientId !== formOneDriveCfg.clientId ||
  existingCfg?.tenantId !== formOneDriveCfg.tenantId;

const mergedCfg: OneDrivePrivateCfg = {
  ...(existingCfg || {}),
  ...formOneDriveCfg,
  // 身份变了 → 清除旧 token，强制重新授权
  ...(identityChanged ? { accessToken: '', refreshToken: '', tokenExpiresAt: 0 } : {}),
};
```

**为什么三重匹配**: 只比较 clientId 不够 —— 用户可能从官方应用（无 clientId）切换到自建应用（有 clientId）。必须同时检查 useCustomApp（用官方的还是自建的）、clientId（自建应用的 ID）、tenantId（单租户 vs 多租户）。

**教训**:

- OAuth token 绑定到 `(useCustomapp, clientId, tenantId)` 三元组
- 改变身份时必须原子性地清除旧 token + 设置新身份
- 清除逻辑在多处存在（credential store 层 + provider config 层），要保证一致性
- `as OneDrivePrivateCfg` 类型断言确保合并后的对象符合 OneDrive 私有配置接口

---

### 问题 #7: Electron tsconfig 双份 paths 配置

**发现轮次**: R8（push 后的生产构建中才发现）

**现象**: `npm run dist:win` 在 Electron TypeScript 编译时报：

```
error TS2307: Cannot find module '@sp/sync-providers/onedrive' or its corresponding type declarations.
```

**根因**: 项目有两份 tsconfig，各自独立维护 `paths` 别名映射：

| tsconfig 文件                     | 用途                | target | module   |
| --------------------------------- | ------------------- | ------ | -------- |
| `tsconfig.base.json`              | Angular/web 构建    | ESNext | ESNext   |
| `electron/tsconfig.electron.json` | Electron 主进程构建 | ES2022 | CommonJS |

两个文件都需要为 `@sp/sync-providers/*` 系列的每个包定义 `paths` 别名。当 OneDrive 的别名被添加到 `tsconfig.base.json` 后，**没有同步添加到 `electron/tsconfig.electron.json`**。

**为什么有两个独立的 paths 配置**: Electron 主进程运行在 Node.js 环境，目标为 CommonJS。Angular/web 构建运行在浏览器环境，目标为 ESM。TypeScript 的 `paths` 配置不能跨 `extends` 自动合并，因为两边的 `baseUrl` 和模块解析策略不同。

**我在 review 时的遗漏**: 我只检查了 `tsconfig.base.json` 和 `src/tsconfig.spec.json`，完全不知道 `electron/tsconfig.electron.json` 也维护了一份独立的 `paths`。

**修复**:

```json
// electron/tsconfig.electron.json
"paths": {
  // ... 已有的别名 ...
  "@sp/sync-providers/onedrive": ["packages/sync-providers/dist/onedrive.d.ts"]
}
```

**补救方法**: `grep -r "sync-providers" **/tsconfig*.json` 能在 5 秒内发现所有需要更新的文件。

**教训**:

- Electron + Angular 混合项目普遍有 split-tsconfig 模式
- 新增包别名时，搜索所有 tsconfig 文件，不要只看 base 那一份
- `npm run checkFile` 只跑 prettier + eslint，不跑 TypeScript 编译
- 只要改了 tsconfig，就应该跑一次生产构建（至少 `tsc -p electron/tsconfig.electron.json --noEmit`）
- CI 应该跑 Electron 编译 —— 当前的 CI 只跑 web 构建

---

### 问题 #8: 手动粘贴授权码缺少 OAuth state CSRF 校验

**发现轮次**: R6

**场景**: 用户在浏览器完成 Microsoft 授权后，会被重定向到 `redirect_uri?code=xxx&state=yyy`。如果用户在 Electron 中手动复制整个 URL 粘贴到对话框，必须校验 `state` 参数。

**为什么需要 state 校验**: OAuth state 参数防止 CSRF 攻击。攻击者可以诱导用户粘贴一个攻击者构造的授权码（`code=attacker_code`）。没有 state 校验的话，应用会用攻击者的 code 去换 token。虽然 PKCE 的 code_verifier 实际上会阻止这种攻击（攻击者不知道 verifier），但 OAuth 规范要求 state 作为额外的防御层。

**修复**:

```typescript
// dialog-get-and-enter-auth-code.component.ts
private _normalizeAuthCodeInput(token?: string): string | undefined {
  const trimmed = token?.trim();
  if (!trimmed) return undefined;

  try {
    const parsedUrl = new URL(trimmed);
    const codeFromUrl = parsedUrl.searchParams.get('code') ?? undefined;

    // OneDrive 完整 URL 粘贴 → 必须校验 state
    if (this.data.providerName.toLowerCase() === 'onedrive') {
      const stateFromUrl = parsedUrl.searchParams.get('state');
      if (!stateFromUrl) {
        // 缺少 state → 拒绝
        this._snackService.open({
          type: 'ERROR',
          msg: 'OAuth state missing from callback URL. Please try again.',
        });
        return undefined;
      }
      if (!validateOAuthState('onedrive', stateFromUrl)) {
        // state 无效 → 拒绝
        this._snackService.open({
          type: 'ERROR',
          msg: 'OAuth state validation failed. Please try again.',
        });
        return undefined;
      }
    }
    if (codeFromUrl) return codeFromUrl;
  } catch {
    // 不是 URL → 走 regex 兜底
  }

  // 纯编码粘贴：尝试从字符串中提取 code=
  const codeMatch = trimmed.match(/(?:^|[?&#])code=([^&#]+)/i);
  return codeMatch?.[1] ?? trimmed;
}
```

**为什么纯编码粘贴不需要 state 校验**: 如果用户只粘贴授权码本身（不是完整 URL），我们无法校验 state —— 因为 state 不在粘贴的内容里。但 PKCE 的 code_verifier 会在 token 交换时提供额外的安全核对：攻击者的 code 无法通过 PKCE 校验。所以这种情况是安全的。

**教训**:

- OAuth 安全参数必须逐一在接收时校验
- 完整 URL 粘贴（含有 state）和纯编码粘贴（不含 state）是不同的输入模式
- PKCE 提供 token 交换阶段的保护，state 提供授权码接收阶段的 CSRF 保护 —— 两者互补而非替代

---

### 问题 #9: 首次创建上传需 `conflictBehavior=fail`

**发现轮次**: R3

详见上方"时序与并发控制 → 场景 A"的完整时序图。

**Reviewer 的核心观点**: `uploadFile(path, data, rev, isForceOverwrite, conflictBehavior)` 的默认行为是 `conflictBehavior=replace`（冲突时覆盖）。对于已经有 rev 的更新操作，这是正确的（因为 rev 不匹配的 412 已经被处理了）。但对于 rev 为空字符串的首次创建，`replace` 意味着"不管文件存不存在，都写我的"——这在多设备同时初始化同步时会导致数据丢失。

**修复**: 当 rev 为空（首次上传）时，FileBasedSyncAdapterService 传入 `conflictBehavior=fail`：

```typescript
const isFirstUpload = !revToMatch;
await this._provider.uploadFile(
  targetPath,
  dataStr,
  revToMatch,
  isForceOverwrite,
  isFirstUpload ? 'fail' : 'replace',
);
```

**教训**:

- "创建"和"更新"是不同的操作，不能混用
- 创建语义 = "我期望文件不存在，如果存在就报错"
- 更新语义 = "我在已有数据基础上修改，如果不匹配就重试合并"

---

### 问题 #10: `id_token` 日志暴露

**发现轮次**: R6

**场景**: Microsoft Identity Platform 的 token 端点返回三个 token：`access_token`、`refresh_token`、`id_token`。其中 `id_token` 是签名的 JWT，包含用户身份声明（姓名、邮箱、UPN、租户 ID 等 PII）。

**错误代码**:

```typescript
const SENSITIVE_KEYS = [
  'accessToken',
  'refreshToken',
  'password',
  'encryptKey',
  'loginName',
  'userName',
];
// id_token 不在列表中!
```

**修复**: 添加 `'id_token'` 到敏感字段列表：

```typescript
const SENSITIVE_FIELDS = [
  'password',
  'encryptKey',
  'accessToken',
  'refreshToken',
  'loginName',
  'userName',
  'id_token', // ← 新增
];
```

**教训**: 接入 OAuth provider 时，检查 token 端点的所有返回字段。Microsoft 返回三个 token，每一个都需要脱敏。

---

### 问题 #11: Refresh-token 端点错误不清除凭证

**发现轮次**: R1（Review #1, 2026/05/08）— **Critical**

**Reviewer 指出的问题**: `_requestOAuthToken` 在任何非 OK 响应时抛出通用 `HttpNotOkAPIError`。当 Microsoft 返回 `400 invalid_grant`（refresh token 被撤销——用户改了密码、在其他设备登出、或 token 超出滑动窗口过期），这个错误冒泡为通用 HTTP 错误，**坏掉的 refresh_token 永远不会被清除**。后续同步会反复使用同一个失效的 token，无限循环失败，唯一的恢复方式是手动清除凭证。

**修复**: 检测 token 端点返回的 `400/401` + `error: "invalid_grant"`，调用 `clearAuthCredentials()` 让用户重新授权。

**教训**:

- Token 刷新端点的错误和 API 调用端点的错误是不同的语义——前者意味着凭证本身失效，必须清除
- 接入 OAuth 时必须区分"临时网络错误"（可重试）和"凭证永久失效"（必须重新授权）
- 好的错误恢复设计是：让系统自动回到用户可以操作的状态（重新授权），而非卡死在无法恢复的错误状态

---

### 问题 #12: clearAuthCredentials() 与 in-flight refresh 竞态

**发现轮次**: R1（Review #1, 2026/05/08）— **Critical**

**Reviewer 指出的问题**: `_refreshAccessTokenIfNeeded` 通过闭包捕获 `cfg`，成功后执行 `setComplete({ ...cfg, accessToken: NEW, refreshToken: tokenData.refresh_token || cfg.refreshToken })`。如果一个并发请求遇到 401 并调用 `clearAuthCredentials()`，而此时 refresh 正在进行中，clear 的效果会在 refresh 完成时被覆盖——因为闭包中的 `cfg` 还是旧的。净效果：一个本应强制重新授权的 401 错误，静默地保留了旧但仍然有效的 token。

**修复选项**: (a) 在 `setComplete` 前重新加载 cfg 并验证 refreshToken；(b) 让 `clearAuthCredentials()` 递增一个 generation sentinel，refresh 完成后检查 sentinel 是否变化。

**在后续 review 中的跟进** (Review #2, 2026/05/21): Reviewer 进一步指出，修复后的注释过度承诺——声称"IIFE 的 `currentCfg.refreshToken` guard 阻止了 stale writes"，但这只在 `invalid_grant` 路径上成立。对于外部的并发 `clearAuthCredentials()`（例如用户在同步过程中点击 Disconnect），仍然存在微任务级别的 TOCTOU 窗口。风险低，但注释应如实反映实际保证。

**教训**:

- 闭包捕获的值在异步操作完成时可能已过时——这是 JS 并发编程的经典陷阱
- "清除"操作和"刷新"操作之间存在天然竞态，需要用 generation 计数或 re-read-verify 模式解决
- 代码注释必须准确描述实际保证，不要过度承诺

---

### 问题 #13: OAuth 授权码通过 SyncLog 泄露

**发现轮次**: R1（Review #1, 2026/05/08）— **Important**

**Reviewer 指出的问题**: `oauth-callback-handler.service.ts` 中的 `SyncLog.log('OAuthCallbackHandler: Received Electron OAuth callback URL', callbackUrl)` 把完整的回调 URL 写入日志——包括 OAuth `code` 和 `state` 参数。根据 CLAUDE.md 规则 9，日志历史可导出，永远不应包含密钥。

**修复**: 只记录 `callbackUrl.split('?')[0]` 或去掉第二个参数。

**教训**:

- OAuth 回调 URL 中的 `code` 和 `state` 是临时凭证，和 access_token 一样需要保护
- 日志脱敏不能只关注 token 字段，还要关注 URL 参数、Header 等其他携带凭证的位置
- Reviewer 原话："Either redact (`callbackUrl.split('?')[0]`) or drop the second arg."

---

### 问题 #14: validateOneDriveOAuthState 循环依赖

**发现轮次**: R1（Review #1, 2026/05/08）— **Important**

**Reviewer 指出的问题**: `oauth-callback-handler.service.ts` 从 `op-log/sync-providers/file-based/onedrive/onedrive` 导入 `validateOneDriveOAuthState`，而 OneDrive provider 在概念上是 OAuth handler 的下游。这创建了循环依赖，且让 handler 必须知道具体 provider 的细节。

**修复建议**: 把 OAuth state map + validate 函数移到独立的 `oauth-state.util.ts`，以 provider 为 key。这样 handler 不需要知道具体 provider，未来的 OAuth provider 也能复用。

**教训**:

- 通用组件（OAuth 回调处理器）不应依赖具体实现（OneDrive provider）
- `import` 方向应该是：具体实现 → 通用接口，不能反过来
- 新增 provider 时检查是否有功能需要抽成共享工具

---

### 问题 #15: Web 构建的 nativeclient 重定向 URI 问题

**发现轮次**: R1（Review #1, 2026/05/08）— **Important**

**Reviewer 指出的问题**: `onedrive.ts` 中 `ONEDRIVE_PROTOCOL.redirectUri = 'https://login.microsoftonline.com/common/oauth2/nativeclient'`。在浏览器构建（`!IS_ELECTRON && !isNativePlatform`）中，这个 redirect URI 会被发送到 Microsoft Entra。但 Entra 通常会对"Web"或"SPA"类型的应用注册拒绝 `nativeclient`（AADSTS50011 错误）。

**修复建议**: 验证浏览器构建是否能真正工作，或者在文档中说明 Web 用户必须注册 "Mobile and desktop applications" 类型的 Entra 应用。

**教训**:

- OAuth redirect URI 必须与 Entra 应用注册类型匹配
- 同一个 redirect URI 在桌面（Electron）和浏览器（Web）中可能有不同的行为
- 移动端和 Web 端的 OAuth 流程需要在真机上测试，不能只靠 Electron 环境验证

---

### 问题 #16: Token 错误重试策略与 Dropbox 不对称

**发现轮次**: R1（Review #1, 2026/05/08）— **Important**

**Reviewer 指出的问题**: OneDrive 遇到 401 时直接清除凭证并抛出异常。而 Dropbox provider 会先刷新 token 并重试一次。时钟偏差或瞬时 token 撤销会让 OneDrive 用户更频繁地遇到需要重新授权的情况。

**修复建议**: 在 401 后先尝试刷新 token 并重试一次（和 Dropbox 一致），只有重试也失败时才清除凭证。

**教训**:

- 新 provider 的错误处理策略应与已有 provider 保持一致——用户不应因为选了不同 provider 而有不同的错误体验
- Token 过期的 401 可能是暂时的（时钟偏差），应先尝试自动恢复，再降级到用户手动操作

---

### 问题 #17: 死亡的 oneDriveAuth 属性和未使用的翻译键

**发现轮次**: R1（Review #1, 2026/05/08）— **Important**

**Reviewer 指出的问题**: `sync-form.const.ts` 中 `props: { oneDriveAuth: true } as any` 设置在面板上，但没有任何代码读取它。实际的认证流程通过 `dialog-sync-cfg.configuredAuthForSyncProviderIfNecessary()` 运行。结果是 `BTN_AUTHENTICATE`、`BTN_REAUTHENTICATE`、`STATUS_CONFIGURED`、`STATUS_NOT_CONFIGURED`、`AUTH_SUCCESS`、`REAUTH_SUCCESS` 这些翻译键被添加到 `en.json` 但永远不会显示。

**修复建议**: 要么创建自定义 Formly type 来渲染认证状态和按钮（使用这些翻译键），要么删除死亡属性和未使用的翻译。

**教训**:

- `as any` 类型断言通常是代码异味——它绕过了类型系统对 props 的验证
- 新增翻译键时应该验证它们在 UI 中确实被渲染
- `grep` 搜索 key 的使用情况应该成为提交前检查项

---

### 问题 #18: \_cfgOrError(requireAuth) 参数从未使用

**发现轮次**: R1（Review #1, 2026/05/08）— **Minor**

**Reviewer 指出的问题**: `onedrive.ts:378` 的 `_cfgOrError(requireAuth)` 参数，所有调用点都使用默认值 `false`。要么删除这个参数，要么让 `_request` 传 `true`，让缺少 refresh_token 的情况在 cfg-check 阶段就报错（而非在后续 fetch 中间才失败）。

**教训**: 未使用的参数增加了理解成本——读者会花时间想"这个参数什么时候是 true？"

---

### 问题 #19: 文件夹缓存未随 syncFolderPath 变化失效

**发现轮次**: R1（Review #1, 2026/05/08）— **Important**

**Reviewer 指出的问题**: `_ensuredFolderPath` 只在遇到 404 时置空。如果用户在设置中修改了 `syncFolderPath`（应用不关闭），缓存仍然认为旧路径已创建，上传到新路径时会跳过文件夹创建步骤。

**修复建议**: 以解析后的路径为 key 缓存，在 cfg 变更时重新检查；或在 cfg 更新路径中主动失效缓存。

**教训**:

- 缓存的失效条件必须覆盖所有导致缓存不正确的场景，不只是"使用中发现的失败"
- 运行时可变的配置项（如文件夹路径）需要和缓存建立关联

---

### 问题 #20: clearAuthCredentials() 注释过度承诺

**发现轮次**: Review #2（2026/05/21）— **Important**

**Reviewer 指出的问题**: `onedrive.ts:86-101` 的注释声称"IIFE 的 `currentCfg.refreshToken` guard 已经阻止了 stale writes"。但这只在 `invalid_grant` 路径上成立（IIFE 在 `setComplete` 之前就抛异常了）。对于外部并发的 `clearAuthCredentials()`（比如用户同步中点击 Disconnect），在 IIFE 的 `await this.privateCfg.load()` 和 `await this.privateCfg.setComplete(updatedCfg)` 之间仍有微任务级 TOCTOU 窗口。`clearAuthCredentials()` 的 `setComplete` 如果恰好落在这个窗口内，IIFE 就会用新 token 覆盖已清除的 cfg。

**修复建议**: (a) 引入 generation sentinel 让 `clearAuthCredentials` 递增，IIFE 在 `setComplete` 前检查；(b) 在 `setComplete` 前重新加载并验证 `refreshToken`；至少软化解注释。

**教训**:

- 代码注释描述并发保证时，必须考虑所有并发调用方——不只是"自身触发的"路径
- "微任务级 TOCTOU"在 JavaScript 的单线程+异步模型中真实存在——两个 async 函数的 `await` 点之间就是窗口
- 与其写"保证不会 X"不如写"目标是不 X，但在 Y 场景下仍有 Z 风险"

---

### 其他 Reviewer 提到的非阻塞项

以下问题 reviewer 标注为 **Minor** 或后续打磨项：

- **日志中的文件/文件夹路径**: `SyncLog.warn(`[OneDrive] Request failed status=… path=${options.path}`, …)` 和 Graph error `message` 可能包含用户输入的文件夹名。项目规则 9："never log user content." 应只记录 `{ status, code }`。
- **`_normalizeAuthCodeInput` 正则**: `/(?:^|[?&#])code=([^&#]+)/i` 接受任何含 `code=` 的粘贴文本。PKCE 使攻击者提供的 code 不可用（不匹配 verifier），但值得加注释说明纵深防御理由。
- **State map 内存**: `OAUTH_STATES_MAP` 是模块作用域变量，只在 `getAuthHelper()` / `validateOneDriveOAuthState()` 时清理。有界泄漏（10 分钟 TTL），实践中影响微小。
- **测试隔离**: `(globalThis as any).fetch = fetchSpy` 在 `beforeEach` 中设置，但 `afterEach` 未恢复。应使用 `try/finally` 或 `afterEach`。模块级 `OAUTH_STATES_MAP` 也会在测试间泄漏。
- **测试覆盖缺口**: state validation（CSRF）、`_normalizeAuthCodeInput` URL 解析、并发 `_refreshAccessTokenIfNeeded` 去重、412 → `UploadRevToMatchMismatchAPIError` 未覆盖。现有 9 个测试覆盖 happy path，但遗漏了更有趣的失败模式。
- **`_resolveClientId` 迁移逻辑**: 三分支优先级（custom-true / custom-false / undefined-legacy）正确但微妙，值得加 spec 锁定行为。
- **`getFileRev` vs `downloadFile` rev 回退不一致**: `downloadFile` 在无 ETag 时返回 `rev: ''`；`getFileRev` 在无 ETag 时抛 `RemoteFileNotFoundAPIError`。如果"无 rev = 文件未知"则都应抛；如果"无 rev = 无版本追踪"则都应返回空。应统一。
- **Dialog provider filter**: `data.providerName.toLowerCase()` 依赖 `provider.id` 是稳定字符串。用 enum 替代更健壮。
- **`'props.required'` 表达式**: 在官方/自建应用模式间切换时，`clientId` 字段的 `required` 标志异步更新。实际可能没问题，但值得手动测试快速切换。
- **Style nit**: `...{ ['@microsoft.graph.conflictBehavior']: 'replace' }` — 应直接用引号属性键。
- **Electron scheme gate 不一致**: `oauth-callback-handler.service.ts:94` 用 `startsWith('superproductivity://')`，而 native listener 用更严格的 `startsWith('superproductivity://oauth-callback')`。应统一。
- **Rejection log 缺上下文**: `oauth-callback-handler.service.ts:95-97` 的拒绝警告没有细节。包含 scheme（如 `callbackUrl.split(':')[0]`）有助于调试且不泄露密钥（scheme 不是用户内容）。
- **Redundant per-test stub**: `onedrive.spec.ts:352` 的 `setComplete.and.resolveTo()` 在新增 `beforeEach` 默认值（line 57）后已多余。
- **Unconditional null before setComplete**: `onedrive.ts:94` 在 `setComplete` 被等待前就把 `_tokenRefreshInFlightPromise = null`。如果 `setComplete` 拒绝，in-flight 引用已丢弃，下一个请求会对半清除状态启动新的刷新。

---

### 中间轮次 Review 的额外发现 (C1–C6)

以下问题来自 7 轮 PR conversation comment 中的前 6 轮（C1–C6），在最终 C7 正式 review 前被提出并修复。这些问题未被现有 #1–#20 覆盖，但包含重要的并发、安全、架构教训。

---

#### 问题 #21: `_is401Retry` 实例布尔值与 `maxConcurrentRequests=4` 竞态

**来源**: C1 Critical #1

**问题**: `_is401Retry` 是实例级布尔标志。当 2+ 个并发请求同时遇到 401：请求 A 设标志为 true 并重试；请求 B 看到标志为 true，跳过刷新，直接走到 `clearAuthCredentials() + throw AuthFailSPError`。任何影响 2+ 个 in-flight 请求的瞬时 token 撤销或时钟偏差都会导致用户被踢出登录。

**修复**: 删除实例字段，改用 per-call 参数 `isRetry: boolean`。`_tokenRefreshInFlightPromise` 已经对实际刷新做了去重，两个同时重试只产生一次网络调用。

**教训**: 实例级布尔值作为"模式标志"在并发场景下几乎永远不对——每个调用需要自己的状态。

---

#### 问题 #22: `_requestOAuthToken` 吞掉了自己刚抛出的 `MissingRefreshTokenAPIError`

**来源**: C1 Critical #2 + C2 详细跟进

**问题**: `throw new MissingRefreshTokenAPIError()` 和 `JSON.parse(body)` 在同一个 `try` 块内。同一个 `catch (_parseErr)` 吞掉了这个 throw，调用方看到的是泛型 `HttpNotOkAPIError` 而非正确的错误类型。依赖于错误类型做分支的刷新路径行为异常。

**修复**: 只把 `JSON.parse` 包在 try 里，`clearAuthCredentials()` 和 `throw new MissingRefreshTokenAPIError()` 放在 try 外面。

**Reviewer 在 C2 中的进一步指出**: 即使是修复后的 `instanceof` 路由方案也有问题——`clearAuthCredentials()` 的 await（storage I/O）在 try 内，如果它 reject，错误被错误地重写为 `HttpNotOkAPIError`。正确的模式（与 `_parseGraphError`、dropbox-api、super-sync 一致）是：只把 `JSON.parse` 放进 try，其他逻辑都在外面。

**教训**: `try` 块内只放可能抛出的最小代码——不要让业务逻辑和错误处理混在同一个 try 里。

---

#### 问题 #23: Electron deep-link 回调对非 OneDrive provider 没有 state 绑定

**来源**: C1 Critical #3

**问题**: `_parseOAuthCallback` 只在 `providerRaw === 'onedrive'` 时才校验 state。任何本地进程都可以发送 `superproductivity://oauth-callback/dropbox?code=ATTACKER_CODE` 并被 Dropbox 对话框接受。这个 PR 虽然只加了 OneDrive，但扩大了 deep-link 的攻击面。

**修复**: 对所有走 deep-link 的 provider 都要求并校验 state。没有待处理的认证流程时应拒绝回调。

**教训**: 新增一个 provider 的安全措施不应只保护自己的 provider——共享基础设施的安全水位应该对所有 provider 统一。

---

#### 问题 #24: `_ensureSyncFolderExists` 对文件夹 POST 使用 `conflictBehavior: 'replace'`

**来源**: C1 Critical #4

**问题**: 如果父级已有一个同名**文件**（而非文件夹），Graph 会用文件夹替换它——数据丢失。现有的 409 → `nameAlreadyExists` catch 只覆盖文件夹已存在的情况。

**修复**: 用 `'fail'`，保留 409 的 swallow。

**教训**: `conflictBehavior` 的语义不仅在文件上传时需要区分，在资源创建（文件夹）时同样适用。

---

#### 问题 #25: `_parseOAuthCallback` 将未知 provider 默认为 `'dropbox'`

**来源**: C1 Important #6

**问题**: 格式错误的回调被永久路由到 Dropbox 对话框。应返回 `'unknown'` 并拒绝，或上报解析错误。

**教训**: "默认回退到某个值"在路由/分发逻辑中很危险——它把可检测的错误变成了静默的错误路由。

---

#### 问题 #26: `dialog-sync-cfg` 中重复的认证前保存块

**来源**: C1 Important #7

**问题**: 两份完全相同的 12 行 `_persistOneDriveFormCfgBeforeAuth` 调用块（含 `as any` + `eslint-disable`），被复制粘贴在两处。应提取为方法，或者将这个职责作为泛型 pre-auth flush hook 移入 `configuredAuthForSyncProviderIfNecessary`，让未来的 provider 不需要重复这个模式。

**教训**: 复制粘贴不仅是代码异味——它意味着一个通用职责（认证前持久化配置）没有被抽象到正确的层级。

---

#### 问题 #27: `_request` 在 401 重试时重复加载 cfg，绕过刷新去重

**来源**: C1 Important #8

**问题**: 401 重试路径重新调用 `_cfgOrError()` 加载 cfg，并使用 `{...cfg, tokenExpiresAt: 0}` 强制刷新，而不是复用外层已有的 cfg 并走 `_tokenRefreshInFlightPromise` 去重路径。

**修复**: 复用外层的 cfg，将强制刷新路由通过 `_tokenRefreshInFlightPromise`。

**教训**: 同一个数据（cfg）在同一个调用链中被多次加载，不仅是性能浪费，更会导致不同加载点之间的 TOCTOU 不一致。

---

#### 问题 #28: `_ensureSyncFolderExists` 每次缓存未命中做 N 次串行 POST

**来源**: C1 Important #9

**问题**: 常见情况（文件夹已存在）下，每个路径段都触发一次 POST，命中 N×409 后才确认存在。加一个 `GET /me/drive/special/approot:/<fullPath>:` 探测——只有 404 时才回退到逐段创建。将 N 次往返折叠为 1 次。

**教训**: "先探测再创建"比"逐段尝试创建"更高效——尤其在常见情况是"已存在"时。

---

#### 问题 #29: Token 端点错误 body 可能包含 `code_verifier` / `code` / `refresh_token`

**来源**: C1 Important #11

**问题**: `new HttpNotOkAPIError(response, body)` 把原始 body 向上传递。Microsoft 400 错误响应有时会 echo 请求参数。在构造错误对象前应脱敏 `code`、`code_verifier`、`refresh_token`。

**教训**: 错误传播路径也是数据泄露路径——不仅正常日志要脱敏，异常路径同样需要。

---

#### 问题 #30: `OAuthCallbackData.provider` 字符串联合类型与 `SyncProviderId` enum 不一致

**来源**: C1 Important #14

**问题**: `OAuthCallbackData` 使用小写字符串联合类型，consumer 端用 `.toLowerCase()` 桥接。应统一使用 `SyncProviderId` enum，在解析边界一次规范化。

**教训**: 同一个概念（provider 标识）在代码库中有两个类型定义是分叉的根源——应只有一处权威定义。

---

#### 问题 #31: Electron IPC listener 从未被移除

**来源**: C1 Important #15

**问题**: Capacitor 的 handler 在 `ngOnDestroy` 中被移除；Electron 的 handler 没有。虽然是 singleton 所以影响有限，但仍是脆弱的设计。应与 Capacitor 的清理对称。

**教训**: 注册 listener 时必须同时规划其清理路径——不对称的注册/清理是内存泄漏和意外行为的温床。

---

#### 问题 #32: 错误的重新授权码会清除有效的现有凭证

**来源**: C3 #2

**问题**: `_requestOAuthToken()` 对于每个 `invalid_grant` 都清除凭证——但这个方法同时用于授权码交换和 token 刷新。用户在重新授权时粘贴了一个错误/过期的授权码，不应删除现有的 refresh_token。凭证清除应限定在 `grantType === 'refresh_token'` 场景。

**教训**: 同一个方法用于多种场景时，错误处理必须区分场景——"授权码无效"和"refresh token 被撤销"的恢复策略完全不同。

---

#### 问题 #33: Provider 切换可能用默认值覆盖已保存的 OneDrive 表单配置

**来源**: C3 #7 + C4 #6

**问题**: `dialog-sync-cfg` 在切换 provider 时为多个 provider 加载私有配置，但跳过了 OneDrive。切换回 OneDrive 时，表单显示的是陈旧/默认的 clientId/tenantId/path 值。随后的 `_persistOneDriveFormCfgBeforeAuth()` 会把这些默认值合并到已保存的私有配置上，覆盖用户之前的设置，同时保留旧 token。

**修复**: 在 provider 切换分支中为 OneDrive 设置 `oneDrive: privateCfg`；认证前检测身份变更时清除 token 并强制重新授权。

**教训**: 表单的"加载已保存配置"和"保存表单到配置"必须对称——如果加载时跳过了某个 provider，保存时就会用默认值覆盖。

---

#### 问题 #34: Graph 401 重试在瞬时刷新错误时清除凭证

**来源**: C4 #4

**问题**: 401 重试路径捕获了强制刷新后的**所有**失败（包括瞬时 token 端点 429/5xx），然后清除凭证。一个暂时的网络问题不应导致用户被登出。只应对永久性认证失败（`invalid_grant`、refresh token 缺失/被撤销）清除凭证，瞬时失败应原样向上抛出。

**教训**: 错误处理需要区分"可重试的瞬时故障"和"不可恢复的永久故障"——把两者混在一起会降低系统韧性。

---

#### 问题 #35: 保存 `syncProvider: null` 将其重写为 WebDAV

**来源**: C4 #5

**问题**: `newSettings.syncProvider ?? SyncProviderId.WebDAV` 把 `null`（有效的禁用/无 provider 状态）变成 `WebDAV`。保存禁用同步的配置后，下次读取会显示 provider 为 WebDAV。

**修复**: 保留 `null`——`??` 只在 `undefined` 时回退，但 `null` 是有意设置的"无 provider"值。

**教训**: `null` 和 `undefined` 在配置中有不同的语义——`??` 只在左操作数为 `null` 或 `undefined` 时回退，所以当 `null` 是合法值时不能用 `??`。

---

#### 问题 #36: 重复的 Formly 控件定义

**来源**: C4 #7

**问题**: `syncInterval` 和 `isManualSyncOnly` 在 sync-form.const.ts 中为非 SuperSync provider 定义了两次。相同 key 的控件加上 `resetOnHide` 可能互相冲突。

**修复**: 只保留一处定义。

**教训**: 复制粘贴表单控件定义会导致两个定义在隐藏/显示切换时互相覆盖。

---

#### 问题 #37: `listFiles()` 不再对缺失文件夹返回 `[]`

**来源**: C5 #2

**问题**: 修复 `listFiles()` 后，代码检查 `RemoteFileNotFoundAPIError`，但 `_requestJson()` 对 Graph 404 抛出的是 `HttpNotOkAPIError`。404→`RemoteFileNotFoundAPIError` 的转换在 `_mapAndThrow()` 中，但 `listFiles()` 从不调用它。缺失的 OneDrive 文件夹现在逃逸为原始 HTTP 错误，而非返回空列表。

**教训**: 错误类型的转换映射必须覆盖所有调用路径——在一个地方加了转换不代表所有调用方都能受益。

---

#### 问题 #38: 文件夹存在性探测吞掉非 404 失败

**来源**: C6 #4

**问题**: 文件夹探测的 catch 捕获了所有失败并回退到创建逻辑。429、5xx 或认证错误不应被转换为额外的创建尝试或误导性的后续错误。只应对 Graph 404 回退，其他错误原样抛出。

**教训**: `catch` 的范围应尽可能窄——只捕获你真正能处理的那一种错误。

---

#### 问题 #39: OneDrive 在 Web 上被隐藏但仍被注册

**来源**: C6 #6

**问题**: `sync-form.const.ts` 在 Web 的 provider 下拉列表中隐藏了 OneDrive，但 `sync-providers.factory.ts` 仍然无条件 import 并注册它。一个持久化/导入的 `syncProvider: OneDrive` 配置仍然可以在 Web 上激活不支持的浏览器认证，且没有正常的 UI 路径来修复它。

**修复**: 集中化 `isOneDriveSupported` 检查，在 provider 注册和表单中同时使用。

**教训**: Feature gate 必须统一应用——UI 隐藏和运行时注册要用同一个条件判断。

---

## 流程反思：为什么这些问题没在一开始被发现

### 1. 检查了 tsconfig.base.json 但遗漏了 electron/tsconfig.electron.json

这是最大的遗漏。`tsconfig.base.json` 和 `electron/tsconfig.electron.json` 各自维护独立的 `paths` 配置，我完全不知道第二个的存在。补救方法很简单：`grep -r "sync-providers" **/tsconfig*.json`。

### 2. 以为 `npm run checkFile` 通过就等于构建没问题

`checkFile` 只跑 prettier + eslint 单文件检查。它不跑：

- TypeScript 编译（`tsc --noEmit`）
- Electron 主进程编译
- 生产构建（webpack/rollup）
- 单元测试

### 3. push 之前没有跑 `npm run dist`

生产构建能暴露出 tsconfig 别名缺失。但 `dist` 跑一次约 10 分钟，还需要网络。作为折中，至少应该跑 `tsc -p electron/tsconfig.electron.json --noEmit` 和 `npm test`。

### 4. 多轮 review 后的 diff 疲劳

9 轮 review 后，某些文件被反复修改。没有人（包括 reviewer）在最后一轮重新通读全部 diff。导致 tsconfig 别名这种"只改了一次、不在 review 焦点区域"的问题存活到最后。

### 5. 兄弟实现没有作为检查清单

WebDAV/Dropbox/Nextcloud 的实现中已经处理了 NoRevAPIError、单飞锁、分页等边界情况。但我没有逐一对照这些实现来审查 OneDrive 代码，导致漏掉了几个模式。

---

## 做得好的地方

尽管经历了 9+ 轮 review，整体架构从一开始就是正确的。以下设计得到了 reviewer 的明确肯定：

- **PKCE OAuth 流程**: 选择正确（Electron 无法安全存储 client_secret），实现正确（code_verifier → SHA256 → code_challenge）。Reviewer 原话："PKCE + state parameter for CSRF on the auto-callback path is correctly implemented."
- **FileSyncProvider 接口集成**: OneDrive 遵循了已有 provider 的接口契约。Reviewer 原话："reuse of `FileSyncProvider` is clean, the App Folder scope is a good security default."
- **双层乐观锁**: syncVersion（内容层）+ ETag（传输层）的设计被 reviewer 认可。
- **Token 单飞锁**: `_isRefreshingToken` 并发控制被 reviewer 验证通过。Reviewer 原话："Token refresh deduplication via `_tokenRefreshInFlightPromise` and folder-ensure caching are thoughtful."
- **App Folder scope**: `Files.ReadWrite.AppFolder` 作为最小权限默认值被 reviewer 评为正确选择。
- **Manual-paste fallback**: 手动粘贴授权码作为全平台回退方案。Reviewer 原话："Manual-paste fallback works on every platform, which is important for the 'no official client ID yet' period."
- **Error mapping**: `_mapAndThrow` 将 Graph 状态码映射到项目内部错误类型。Reviewer 原话："bridges Graph status codes to the project's error taxonomy cleanly."
- **单元测试（260 行）**: 在 review 重构期间提供了回归安全网。
- **SyncPublicConfig 类型**: `Omit<SyncConfig, 'encryptKey' | 'webDav' | ... | 'oneDrive'>` 在编译时就防止了 credential 泄露到全局配置。
- **PROVIDER_FIELD_DEFAULTS**: 确保 API 调用不会因为 undefined 值而失败。

---

## 未来新增 Sync Provider 的提交前自检清单

- [ ] `grep -r "sync-providers" **/tsconfig*.json` — 所有 tsconfig 文件都有新别名
- [ ] `grep -r "PROP_MAP_TO_FORM" src/` — provider 到表单的映射正确
- [ ] `grep -r "PROVIDER_FIELD_DEFAULTS" src/` — 所有字段有默认值
- [ ] 逐一对比兄弟 provider 实现的边界处理：
  - [ ] `NoRevAPIError` — 上传响应没有 rev 时抛出
  - [ ] 分页 — 列表接口是否分页
  - [ ] 单飞锁 — token 刷新有并发控制
  - [ ] 首次创建 vs 更新 — `conflictBehavior` 正确区分
  - [ ] Token 错误重试策略 — 是否与兄弟 provider 一致
  - [ ] `getFileRev` vs `downloadFile` rev 回退行为一致
- [ ] `grep -r "SENSITIVE_" src/` — token 响应所有字段已脱敏（包括 `id_token`）
- [ ] 日志中不包含 OAuth code/state/redirect URL 等临时凭证
- [ ] 日志中不包含用户输入的文件/文件夹路径
- [ ] 动态 import 在 feature gate 后面（不在 `Promise.all` 中用三元）
- [ ] OAuth state map + validate 函数不创建循环依赖（应放在独立 util 中）
- [ ] OAuth redirect URI 与目标平台的应用注册类型匹配
- [ ] 缓存失效条件覆盖运行时可变配置（如 syncFolderPath）
- [ ] `as any` 类型断言有正当理由（或不存在）
- [ ] 新增翻译键在 UI 中确实被渲染
- [ ] `npm run checkFile` × 每个修改的文件
- [ ] `npm test` — 全量单测通过
- [ ] `tsc -p electron/tsconfig.electron.json --noEmit` — Electron 编译通过
- [ ] 改过 `tsconfig*.json` → 确认 base 和 electron 两份配置同步
- [ ] 实测：用不完整的表单保存 → 验证可选布尔值不被覆盖
- [ ] 测试覆盖：CSRF state validation、并发 token refresh 去重、HTTP 412 映射
- [ ] 测试隔离：`globalThis.fetch` 恢复、模块级状态清理

---

## Reviewer 后续

PR 合并后 reviewer 开了两个 issue：

- **#7797** — 跟踪 4 个打磨项（非阻塞）
- **#7800** — 实现这些打磨项的 PR（已于 2026/05/26 合并，提交 `923d946fa`）

这些是非阻塞改进，已全部落地。

### 未在 PR 中处理的遗留项

以下问题在 review 中提出但未在 PR merge 前解决，应作为后续跟进：

1. **日志路径脱敏** — `SyncLog.warn` 中的 `path=${options.path}` 包含用户输入的文件夹名
2. **Web 构建 nativeclient redirect URI** — 需要在真实浏览器构建中验证或文档化
3. **死亡 `oneDriveAuth: true` 属性** — 以及关联的未使用翻译键
4. **Token 错误重试对称性** — OneDrive 遇到 401 应和 Dropbox 一样先重试一次
5. **`getFileRev` vs `downloadFile` 不一致** — 无 ETag 时的行为应统一
6. **`_cfgOrError(requireAuth)` 死参数** — 移除或使用
7. **Folder cache 与 syncFolderPath 变更联动**
8. **clearAuthCredentials 注释准确化**
