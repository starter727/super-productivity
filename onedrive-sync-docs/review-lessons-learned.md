# OneDrive PR Review 经验教训总结

> PR #7523: feat(sync): add OneDrive sync provider with PKCE auth
> 审查周期: 2026/05/17 → 2026/05/26 (共 9 轮 review)
> 最终结果: squash merge 为 commit 9910d30fc
> Reviewer: johannesjo

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
4. [流程反思：为什么这些问题没在一开始被发现](#流程反思为什么这些问题没在一开始被发现)
5. [做得好的地方](#做得好的地方)
6. [未来新增 Sync Provider 的提交前自检清单](#未来新增-sync-provider-的提交前自检清单)
7. [Reviewer 后续](#reviewer-后续)

---

## 九轮 Review 总览

| 轮次 | 日期     | 发现的问题                                                           | 严重程度    | 类别           |
| ---- | -------- | -------------------------------------------------------------------- | ----------- | -------------- |
| R1   | 05/17    | JSON 类型过于宽松、敏感字段在日志中暴露                              | 阻塞        | 数据安全、类型 |
| R2   | 05/18    | SyncLogger 误用、`/children` 端点分页缺失、未抛出 `NoRevAPIError`    | 阻塞        | 协议正确性     |
| R3   | 05/19    | 首次上传需 `conflictBehavior=fail`、`_clearIfConfigMatches` 三重匹配 | 阻塞        | 竞态安全       |
| R4   | 05/20    | `?? false` 在可选布尔值上会静默覆盖已有的 `true`                     | 阻塞        | JS 语义        |
| R5   | 05/21    | 动态 `import()` 放在 `Promise.all` 中无条件加载了 OneDrive chunk     | 阻塞        | 包体积         |
| R6   | 05/22    | `id_token` 日志泄露、手动粘贴授权码时缺少 OAuth state CSRF 校验      | 阻塞+非阻塞 | 安全           |
| R7   | 05/23    | 切换 Azure AD 应用身份时需清除旧 token                               | 阻塞        | 数据完整性     |
| R8   | 05/24    | Electron tsconfig 缺少 onedrive 路径别名                             | 阻塞        | 构建           |
| R9   | 05/25-26 | 非阻塞优化：测试清理、类型导出、后续跟进项                           | 非阻塞      | 打磨           |

每轮 review 的具体讨论和 reviewer 的意见详见下方逐问题详解。

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

尽管经历了 9 轮 review，整体架构从一开始就是正确的：

- **PKCE OAuth 流程**: 选择正确（Electron 无法安全存储 client_secret），实现正确（code_verifier → SHA256 → code_challenge）
- **FileSyncProvider 接口集成**: OneDrive 遵循了已有 provider 的接口契约
- **双层乐观锁**: syncVersion（内容层）+ ETag（传输层）的设计被 reviewer 认可
- **Token 单飞锁**: `_isRefreshingToken` 并发控制被 reviewer 验证通过
- **单元测试（260 行）**: 在 review 重构期间提供了回归安全网
- **SyncPublicConfig 类型**: `Omit<SyncConfig, 'encryptKey' | 'webDav' | ... | 'oneDrive'>` 在编译时就防止了 credential 泄露到全局配置
- **PROVIDER_FIELD_DEFAULTS**: 确保 API 调用不会因为 undefined 值而失败

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
- [ ] `grep -r "SENSITIVE_" src/` — token 响应所有字段已脱敏
- [ ] 动态 import 在 feature gate 后面（不在 `Promise.all` 中用三元）
- [ ] `npm run checkFile` × 每个修改的文件
- [ ] `npm test` — 全量单测通过
- [ ] `tsc -p electron/tsconfig.electron.json --noEmit` — Electron 编译通过
- [ ] 改过 `tsconfig*.json` → 确认 base 和 electron 两份配置同步
- [ ] 实测：用不完整的表单保存 → 验证可选布尔值不被覆盖

---

## Reviewer 后续

PR 合并后 reviewer 开了两个 issue：

- **#7797** — 跟踪 4 个打磨项（非阻塞）
- **#7800** — 实现这些打磨项的 PR（截至本文撰写时仍在 OPEN）

这些是非阻塞改进，不影响功能正确性。
