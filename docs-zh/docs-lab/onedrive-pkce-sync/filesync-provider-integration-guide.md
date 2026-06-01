# 文件同步提供者集成指南

# FileSyncProvider Integration Guide

> 逐步指南：如何为 Super Productivity 新增文件同步 Provider（以 OneDrive 为例，覆盖接口、表单、认证、错误处理、测试）。

## 目录

1. [架构回顾：Provider 在同步框架中的位置](#1-架构回顾provider-在同步框架中的位置)
2. [接口合约](#2-接口合约)
3. [逐步实现清单](#3-逐步实现清单)
4. [兄弟实现对照表](#4-兄弟实现对照表)
5. [常见陷阱（来自 PR #7523 的 Review）](#5-常见陷阱来自-pr-7523-的-review)
6. [提交前自检清单](#6-提交前自检清单)

---

## 1. 架构回顾：Provider 在同步框架中的位置

```
                          SyncWrapperService (顶层编排)
                                  │
                          WrappedProviderService
                                  │
                   ┌──────────────┴──────────────────┐
                   │                                  │
            SuperSync                      FileBasedSyncAdapterService
        (原生 OperationSync)               (把 FileSyncProvider 包成 OperationSync)
                                                   │
                              ┌──────────────────────┼──────────────────────┐
                              │                      │                      │
                           Dropbox               OneDrive               WebDAV
                           (傻管道)               (傻管道)               (傻管道)
```

**核心原则：从共享层的视角看，Provider 是"读写一个字符串文件"的传输层。** 所有同步智能（冲突检测、向量时钟、操作回放、加密压缩）全在共享层。Provider 接口暴露 5 个方法（+ 可选认证流程），但实际实现量取决于后端复杂度——OneDrive 参考实现约 770 行，涵盖 OAuth PKCE、令牌管理、错误映射和并发控制。

---

## 2. 接口合约

### 2.1 SyncProviderBase（基础）

```typescript
// packages/sync-providers/src/provider-types.ts
interface SyncProviderBase<PID, TPrivateCfg> {
  id: PID; // 稳定的 provider 标识符
  isUploadForcePossible?: boolean; // 支持强制覆盖上传
  maxConcurrentRequests: number; // 最大并发 API 调用数
  privateCfg: SyncCredentialStorePort; // 凭证存储（token、密码等）

  isReady(): Promise<boolean>; // provider 是否已配置可用
  getAuthHelper?(): Promise<SyncProviderAuthHelper>; // OAuth 认证辅助
  setPrivateCfg(cfg: TPrivateCfg): Promise<void>; // 保存配置
  clearAuthCredentials?(): Promise<void>; // 清除凭证（仅 OAuth token 可安全删除）
}
```

### 2.2 FileSyncProvider（文件操作）

```typescript
interface FileSyncProvider<PID, TPrivateCfg> extends SyncProviderBase {
  isLimitedToSingleFileSync?: boolean;

  getFileRev(targetPath: string, localRev: string | null): Promise<{ rev: string }>;
  downloadFile(targetPath: string): Promise<{ rev: string; dataStr: string }>;
  uploadFile(
    targetPath: string,
    dataStr: string,
    revToMatch: string | null,
    isForceOverwrite?: boolean,
  ): Promise<{ rev: string }>;
  removeFile(targetPath: string): Promise<void>;
  listFiles?(targetPath: string): Promise<string[]>;
}
```

### 2.3 SyncProviderAuthHelper（OAuth）

```typescript
interface SyncProviderAuthHelper {
  authUrl?: string;
  codeVerifier?: string;
  verifyCodeChallenge?(codeChallenge: string): Promise<{
    accessToken: string;
    refreshToken: string;
    expiresAt: number;
  }>;
}
```

### 2.4 每个方法必须抛出的错误类型

| 场景                  | 应抛出的错误                       | 说明                                        |
| --------------------- | ---------------------------------- | ------------------------------------------- |
| 远程文件不存在        | `RemoteFileNotFoundAPIError`       | `getFileRev` / `downloadFile` 时文件不存在  |
| 上传响应缺少版本标记  | `NoRevAPIError`                    | `uploadFile` / `downloadFile` 后无 rev/ETag |
| Token 过期 / 认证失败 | `AuthFailSPError`                  | 401/403 且刷新后仍失败                      |
| ETag 冲突             | `UploadRevToMatchMismatchAPIError` | HTTP 409/412                                |
| 请求过多 / 限流       | `TooManyRequestsAPIError`          | HTTP 429                                    |
| 凭证缺失（刷新时）    | `MissingRefreshTokenAPIError`      | `clearAuthCredentials` 后触发               |

---

## 3. 逐步实现清单

### Step 1: 定义 Provider ID 和配置接口

```
文件: packages/sync-providers/src/file-based/<name>/<name>.model.ts
```

```typescript
// 私有配置 (token、密码等敏感字段)
export interface YourPrivateCfg {
  encryptKey?: string;
  accessToken?: string;
  refreshToken?: string;
  tokenExpiresAt?: number;
  // 你的特有字段...
}

// API 响应类型
export interface YourTokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
}
```

参考: `packages/sync-providers/src/file-based/onedrive/onedrive.model.ts`

### Step 2: 实现 FileSyncProvider 类

```
文件: packages/sync-providers/src/file-based/<name>/<name>.ts
```

模板：

```typescript
export const PROVIDER_ID_YOUR = 'YourProvider' as const;

export class YourProvider implements FileSyncProvider<
  typeof PROVIDER_ID_YOUR,
  YourPrivateCfg
> {
  readonly id = PROVIDER_ID_YOUR;
  readonly isUploadForcePossible = true;
  readonly maxConcurrentRequests = 4;
  readonly privateCfg: SyncCredentialStorePort;

  private _tokenRefreshInFlightPromise: Promise<string> | null = null;
  private readonly _deps: YourDeps;

  // 5 个 FileSyncProvider 方法
  async getFileRev(path: string, localRev: string | null): Promise<{ rev: string }> {
    // GET metadata → 返回 { rev: ETag }
    // 404 → throw RemoteFileNotFoundAPIError
    // 如 ETag 不存在 → rev 可为 ''（但要与 downloadFile 一致）
  }

  async downloadFile(path: string): Promise<{ rev: string; dataStr: string }> {
    // GET content → 从响应头取 ETag
    // 无 ETag → throw NoRevAPIError 或 rev: ''（选择一种并与 getFileRev 一致）
    // 404 → throw RemoteFileNotFoundAPIError
  }

  async uploadFile(
    path: string,
    dataStr: string,
    revToMatch: string | null,
    isForceOverwrite = false,
  ): Promise<{ rev: string }> {
    // PUT content
    // 有 revToMatch 且非强制覆盖 → If-Match: revToMatch
    // revToMatch 为空且非强制覆盖 → 首次创建，用创建语义（防止覆盖已存在文件）
    // isForceOverwrite → 无 If-Match 头，直接覆盖
    // 409/412 → throw UploadRevToMatchMismatchAPIError
    // 响应无 ETag → throw NoRevAPIError
  }

  async removeFile(path: string): Promise<void> {
    // DELETE
    // 404 → throw RemoteFileNotFoundAPIError
  }

  async listFiles?(dirPath: string): Promise<string[]> {
    // GET children → 返回文件名列表
    // 注意分页！（API 可能只返回第一页）
  }

  // OAuth (仅 OAuth provider 需要)
  async getAuthHelper(): Promise<SyncProviderAuthHelper> {
    // 生成 code_verifier, code_challenge, state
    // 构造 authUrl
    // 返回 { authUrl, codeVerifier, verifyCodeChallenge }
  }

  // Token 刷新 (仅 OAuth provider)
  private async _refreshAccessTokenIfNeeded(...): Promise<string> {
    // 检查过期 → 单飞锁 → POST /token → 更新存储
  }

  // 凭证清除 (实现 clearAuthCredentials)
  async clearAuthCredentials(): Promise<void> {
    // 清除 accessToken + refreshToken
    // 注意：先置空 _tokenRefreshInFlightPromise 再 await (防止死锁)
  }
}
```

参考: `packages/sync-providers/src/file-based/onedrive/onedrive.ts` (770 行)

### Step 3: 注册到 enum

文件: `src/app/op-log/sync-providers/provider.const.ts`

```typescript
export enum SyncProviderId {
  // 已有...
  'YourProvider' = 'YourProvider',
}

// 如果是 OAuth provider，加入这个 Set
export const OAUTH_SYNC_PROVIDERS: ReadonlySet<SyncProviderId> = new Set([
  SyncProviderId.Dropbox,
  SyncProviderId.OneDrive,
  SyncProviderId.YourProvider, // ← 新增
]);
```

### Step 4: 添加到工厂

文件: `src/app/op-log/sync-providers/sync-providers.factory.ts`

```typescript
// 在 _createProviders 中添加
if (IS_YOUR_PROVIDER_SUPPORTED) {
  const { createYourProvider } = await import('./file-based/your/your');
  providers.push(createYourProvider() as SyncProviderBase<SyncProviderId>);
}
```

**注意**: 动态 `import()` 必须在 `if` 条件内，**不能**放在 `Promise.all([...])` 中（见 5.3 陷阱）。会导致条件 feature gate 失效。

### Step 5: 配置表单

文件: `src/app/features/config/form-cfgs/sync-form.const.ts`

需要添加：

1. `syncProvider` 下拉选项（把新的 provider 加入 options 列表）
2. Provider 特有的 fieldGroup（用 `hideExpression` 控制只有选到该 provider 时才显示）
3. 如果是 OAuth provider，添加认证授权按钮/状态面板

参考 OneDrive 的 fieldGroup (第 360-418 行) 和认证面板 (第 421-435 行)。

### Step 6: tsconfig 路径别名

文件: `tsconfig.base.json` **和** `electron/tsconfig.electron.json`（两份都要改）

```json
"paths": {
  "@sp/sync-providers/your": ["packages/sync-providers/dist/your.d.ts"]
}
```

### Step 7: 添加翻译键

文件: `src/assets/i18n/en.json`

添加 provider 相关的 UI 字符串。注意：**不要添加不被代码引用的翻译键**（见 5.7 陷阱）。

### Step 8: 单元测试

文件: `packages/sync-providers/src/file-based/<name>/<name>.spec.ts`

至少覆盖：

- `getFileRev()` — 正常返回 / 文件不存在
- `downloadFile()` — 正常返回 / 缺少 rev
- `uploadFile()` — 正常上传 / 冲突 / 缺少 rev
- `removeFile()` — 正常删除 / 文件不存在
- `listFiles()` — 正常返回 / 空列表
- `getAuthHelper()` — PKCE 流程
- `_refreshAccessTokenIfNeeded()` — 刷新 / 单飞锁 / 并发

---

## 4. 兄弟实现对照表

新增 Provider 时，逐一对照已有实现，确保行为一致：

| 检查项                             | Dropbox                        | OneDrive                       | WebDAV | 你的 Provider  |
| ---------------------------------- | ------------------------------ | ------------------------------ | ------ | -------------- |
| **分页处理**                       | 内置                           | `@odata.nextLink` 循环 + 500 页上限 + 主权云绝对 URL + HTTPS 白名单 | —      | 检查 API       |
| **NoRevAPIError**                  | ✓ 上传缺少 rev → 抛出          | ✓ 上传缺少 eTag → 抛出         | ✓      | 必须           |
| **Token 单飞锁**                   | `_withTokenRefresh` 包装 fn    | `_tokenRefreshInFlightPromise` | N/A    | OAuth 必须     |
| **401 重试策略**                   | 刷新一次 + 重试                | 刷新一次 + 重试                | N/A    | 与兄弟一致     |
| **首次创建保护**                   | `revToMatch=null → getFileRev` | `conflictBehavior=fail`        | —      | 根据 API       |
| **getFileRev vs downloadFile rev** | —                              | 都返回 `''` 而不是抛异常       | —      | 二选一保持一致 |
| **日志脱敏（用户路径）**           | 只记录状态码                   | 只记录 `{status, code}`        | —      | 必须           |
| **OAuth code 日志**                | N/A (手动粘贴)                 | 不记录 code/state              | N/A    | 必须           |

---

## 5. 常见陷阱（来自 PR #7523 的 Review）

### 5.1 没有抛出 NoRevAPIError

**问题**: `uploadFile` 响应没检查 ETag 是否存在，返回 `{ rev: undefined }`。破坏接口契约！

**修复**: 显式检查 + 抛出：

```typescript
const result = await response.json();
if (!result.eTag) {
  throw new NoRevAPIError('Provider upload missing eTag');
}
return { rev: result.eTag };
```

---

### 5.2 列表 API 分页缺失

**问题**: API 默认只返回前 N 条，不处理 `nextLink` / `nextPageToken` 就丢数据。

**修复**: 循环直到无下一页：

```typescript
let nextUrl = '/api/list';
const allItems: string[] = [];
while (nextUrl) {
  const result = await this._requestJson(nextUrl);
  allItems.push(...result.items);
  nextUrl = result.nextLink; // 可能是完整 URL，注意 base URL 前缀
}
```

---

### 5.3 动态 import 放在 Promise.all 中

**问题**: JS 表达式求值顺序 —— `import()` 在数组构造阶段就被触发，feature gate 无效。

```typescript
// 错误:
const modules = await Promise.all([
  import('./dropbox'),
  IS_SUPPORTED ? import('./newprovider') : null,  // ← 条件无效！
]);

// 正确:
const modules = await Promise.all([...]);
if (IS_SUPPORTED) {
  const m = await import('./newprovider');
  modules.push(m);
}
```

---

### 5.4 clearAuthCredentials 竞态

**问题**: 并发 `clearAuthCredentials()` 和 in-flight token refresh 之间的 TOCTOU 窗口。

**修复要点**:

1. `_tokenRefreshInFlightPromise = null` 放在 `setComplete` await **之前**（防止自死锁）
2. refresh IIFE 在 `setComplete` 前重新验证 cfg 未变化（tri-guard）
3. `clearAuthCredentials` 的注释如实反映实际保证，不要过度承诺

---

### 5.5 缓存未响应配置变更

**问题**: `_ensuredFolderPath` 只在 404 时清除。用户改了 `syncFolderPath`，缓存还认为旧路径有效。

**修复**: key 用完整路径，或 config 变更时主动失效缓存。

---

### 5.6 getFileRev vs downloadFile rev 回退不一致

**问题**: `downloadFile` 在无 ETag 时返回 `rev: ''`；`getFileRev` 抛异常。

**必须二选一**: 要么都返回空（无 rev = 无版本追踪），要么都抛异常（无 rev = 无法操作）。不能一个静默一个抛。

---

### 5.7 添加了从未被渲染的翻译键

**问题**: `BTN_AUTHENTICATE`、`STATUS_CONFIGURED` 等翻译键被添加到了 `en.json`，但没有任何 Formly type 读取它们。用户看不到。

**检查**: `grep` 每个新增翻译键，确认在 HTML 或 TS 模板中有引用。

---

### 5.8 Token 刷新死锁风险

**问题**: `clearAuthCredentials()` 中 `await _tokenRefreshInFlightPromise` → 如果调用方就是 refresh IIFE 本身 → 死锁。

**修复**: `clearAuthCredentials()` 先 `_tokenRefreshInFlightPromise = null` 再 `await setComplete(...)`。

---

### 5.9 tsconfig 独立管理的 paths

**问题**: `tsconfig.base.json` 和 `electron/tsconfig.electron.json` 各自维护独立的 `paths`。只改了一个。

**检查**: `grep -r "sync-providers" **/tsconfig*.json`

---

### 5.10 OAuth 日志泄露

**问题**: 回调 URL（含 `code` 和 `state`）、token 端点的 `id_token`、用户输入的文件夹名被写入日志。

**修复**:

- 回调 URL 只记录前缀，不传详情
- 敏感字段列表包含所有 token 类型（`code`, `code_verifier`, `access_token`, `refresh_token`, `id_token`）
- API 错误日志只记录 `{status, code}`，不记录 `path`

---

### 5.11 实例级布尔值做并发控制（`_is401Retry` 竞态）

**问题**: 实例级 `_is401Retry` 标志与 `maxConcurrentRequests = 4` 竞态。请求 A 在重试中，请求 B 看到标志已设置，跳过刷新，直接清除凭证并抛 `AuthFailSPError`。瞬时 token 撤销会把用户踢出登录。

**修复**: 删除实例字段，改用 per-call 的 `isRetry` 参数传递重试状态。Token 刷新去重仍由 `_tokenRefreshInFlightPromise` 负责。

```typescript
// 错误:
private _is401Retry = false;
if (status === 401 && !this._is401Retry) {
  this._is401Retry = true;
  // refresh + retry...
}

// 正确:
private async _request(options: ApiRequestOptions, isRetry = false): Promise<Response> {
  if (status === 401 && !isRetry) {
    await this._refreshAccessTokenIfNeeded(...);
    return this._request(options, true);
  }
}
```

---

### 5.12 `throw` 和 `JSON.parse` 在同一个 `try` 块内

**问题**: `_requestOAuthToken` 中 `throw new MissingRefreshTokenAPIError()` 和 `JSON.parse(body)` 共享同一个 `try/catch`。catch 把正确类型的错误吞掉，调用方看到的是泛型 `HttpNotOkAPIError`。

**修复**: 只把 `JSON.parse` 放进 try。

```typescript
// 错误:
try {
  const parsed = JSON.parse(body);
  if (parsed.error === 'invalid_grant') {
    throw new MissingRefreshTokenAPIError(); // ← 被下面的 catch 吞掉!
  }
} catch (_parseErr) {
  throw new HttpNotOkAPIError(response, body);
}

// 正确:
let parsed: { error?: string } | null = null;
try {
  parsed = JSON.parse(body);
} catch {
  /* not JSON */
}
if (parsed?.error === 'invalid_grant') {
  throw new MissingRefreshTokenAPIError();
}
throw new HttpNotOkAPIError(response, body);
```

---

### 5.13 文件夹创建也用 `conflictBehavior: 'replace'`

**问题**: `_ensureSyncFolderExists` 对文件夹 POST 使用 `conflictBehavior: 'replace'`。如果父级有同名**文件**，Graph 会用文件夹替换它——造成数据丢失。与文件上传的 #5.6 同一类问题，但在不同 API 上。

**修复**: 用 `'fail'`，保留 409 swallow 处理"文件夹已存在"。

---

### 5.14 Provider 切换时表单配置被默认值覆盖

**问题**: `dialog-sync-cfg` 在切换 provider 时未加载 OneDrive 的已保存私有配置。切换回 OneDrive 时，表单显示默认值，随后 `_persistOneDriveFormCfgBeforeAuth()` 把默认值合并到已保存的配置上，覆盖用户之前的 clientId/folder 设置。

**修复**:

1. 在 provider 切换分支中设置 `oneDrive: privateCfg`（与其他 provider 对称）
2. 认证前检测身份变更（`useCustomApp`/`clientId`/`tenantId`），变更时清除旧 token 并强制重新授权

---

### 5.15 Feature gate 不统一（UI 隐藏但运行时注册）

**问题**: `sync-form.const.ts` 在 provider 下拉列表中隐藏了 provider，但 `sync-providers.factory.ts` 仍然无条件 `import()` 并注册它。持久化/导入的配置仍然可以激活不支持的 provider，且没有正常 UI 路径来修复。

**修复**: 集中化 `isProviderSupported` 检查，在 provider 注册和表单中同时使用同一个条件。

```typescript
// sync-providers.factory.ts
if (IS_PROVIDER_SUPPORTED) {
  const m = await import('./newprovider/newprovider');
  providers.push(m.createNewProvider());
}

// sync-form.const.ts
...(IS_PROVIDER_SUPPORTED ? [newProviderOption] : []),
```

---

### 5.16 Token 端点错误 body 在日志/错误对象中泄露

**问题**: `new HttpNotOkAPIError(response, body)` 把原始 body 向上传递。Microsoft 400 错误响应有时会 echo 请求参数（`code_verifier`、`code`、`refresh_token`）。错误传播路径也是数据泄露路径。

**修复**: 在构造错误对象前脱敏 body 中的 `code`、`code_verifier`、`refresh_token` 字段。

---

### 5.17 同一个方法用于多种场景时，错误处理未区分场景

**问题**: `_requestOAuthToken()` 同时用于授权码交换（`grant_type=authorization_code`）和 token 刷新（`grant_type=refresh_token`）。`invalid_grant` 在两种场景下含义不同：授权码无效 = 用户粘贴错了，应提示重试；refresh token 被撤销 = 凭证永久失效，应清除。统一清除会导致错误的重新授权码删除有效的现有凭证。

**修复**: `invalid_grant` 只在 `grant_type === 'refresh_token'` 时清除凭证。授权码交换的 `invalid_grant` 应作为普通认证错误向上传递。

---

## 6. 提交前自检清单

### 核心接口

- [ ] `getFileRev`: 404 → `RemoteFileNotFoundAPIError`
- [ ] `downloadFile`: 404 → `RemoteFileNotFoundAPIError`；缺 ETag → 行为与 `getFileRev` 一致
- [ ] `uploadFile`: 缺 ETag → `NoRevAPIError`；409/412 → `UploadRevToMatchMismatchAPIError`
- [ ] `removeFile`: 404 → `RemoteFileNotFoundAPIError`
- [ ] `listFiles`: 分页处理完整；404 → 返回 `[]`；非 404 错误（429/5xx/auth）→ 原样抛出
- [ ] 首次创建 vs 更新 → 创建用失败语义（`conflictBehavior=fail` 或等效）
- [ ] 文件夹创建也用 `conflictBehavior=fail`（防止同名文件被替换）
- [ ] 每个方法都抛正确的错误类型（不要只抛通用 `Error`）
- [ ] `throw` 和 `JSON.parse` 不在同一个 `try` 块内（防止错误类型被吞掉）

### 认证 (仅 OAuth provider)

- [ ] `clearAuthCredentials`: 先 `null` 再 `await` → 防止死锁
- [ ] Token 刷新: 单飞锁 + `finally` 保证重置
- [ ] `invalid_grant` → 只在 `grant_type=refresh_token` 时清除凭证（授权码交换时不清除）
- [ ] 401 重试策略 → 用 per-call `isRetry` 参数（不用实例级布尔标志）
- [ ] 401 重试 → 只对永久认证失败清除凭证，瞬时错误（429/5xx）向上抛出
- [ ] 回调 URL 日志 → 不记录 `code` / `state`（含 fragment `#` 参数）
- [ ] 敏感字段列表 → 覆盖所有 token 类型（含 `id_token`、`code_verifier`）
- [ ] Token 端点错误 body → 在构造 error 对象前脱敏
- [ ] OAuth state → 从独立 util 导入（不反向依赖 provider）
- [ ] Electron deep-link listener → 在 `ngOnDestroy` 中移除（与 Capacitor 对称）
- [ ] `OAuthCallbackData.provider` → 使用 `SyncProviderId` enum（不是小写字符串）

### 安全

- [ ] `grep -r "SENSITIVE_"` → 所有 token 字段已脱敏
- [ ] 日志中不含用户输入的路径/文件夹名
- [ ] 日志中不含 OAuth code/state/redirect URL
- [ ] `as any` / `as unknown as string` 有正当理由

### 表单

- [ ] provider 加入 `syncProvider` 下拉列表
- [ ] provider 特有字段用 `hideExpression` 只在该 provider 选中时显示
- [ ] 所有新增翻译键在代码中有引用
- [ ] 可选布尔值用条件展开，不用 `?? false`

### 构建

- [ ] `grep -r "sync-providers" **/tsconfig*.json` → base 和 electron 都有新别名
- [ ] 动态 `import()` 在 feature gate 条件内（不在 `Promise.all` 中）
- [ ] Feature gate 统一使用：provider 注册 + 表单下拉 + 运行时检查用同一个条件
- [ ] `npm test` 全量通过
- [ ] `tsc -p electron/tsconfig.electron.json --noEmit` 通过
- [ ] `npm run checkFile` × 每个修改的文件

### 测试

- [ ] 每个 FileSyncProvider 方法至少 1 个 test case
- [ ] Token 刷新并发去重测试
- [ ] `afterEach` → 恢复 `globalThis.fetch` 等全局 mock
- [ ] 缓存失效测试（如文件夹路径变更）

### 实测

- [ ] 完整 OAuth 流程（如果适用）
- [ ] Token 刷新（如果适用）
- [ ] 用不完整的表单保存 → 可选布尔值不被覆盖
- [ ] 同步端到端（下载 → 合并 → 上传）

---

## 相关资源

- [FileSyncProvider 接口定义](../../packages/sync-providers/src/provider-types.ts) — `FileSyncProvider` 接口
- [OneDrive 实现参考](../../packages/sync-providers/src/file-based/onedrive/onedrive.ts) — 完整的参考实现 (770 行)
- [Dropbox 实现参考](../../packages/sync-providers/src/file-based/dropbox/dropbox.ts) — 另一个 OAuth provider 参考
- [工厂注册](../../src/app/op-log/sync-providers/sync-providers.factory.ts) — 动态加载 provider
- [表单常量](../../src/app/features/config/form-cfgs/sync-form.const.ts) — 同步设置页表单配置
- [PKCE 实现](../../packages/sync-providers/src/pkce.ts) — code_verifier / code_challenge 生成
- [OAuth State 工具](../../src/app/imex/sync/oauth-state.util.ts) — CSRF 防护
- [OAuth PKCE 认证深入](./oauth-pkce-auth-deep-dive.md) — PKCE 全流程详解
- [同步架构详解](./sync-architecture-deep-dive.md) — 同步系统全流程
- [PR Review 经验教训](./review-lessons-learned.md) — 39 个 review 发现的问题
