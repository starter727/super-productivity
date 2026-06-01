# OAuth PKCE 认证深度解析

# OAuth PKCE 认证深入

> 以 OneDrive 为切入点，详解 Super Productivity 的 OAuth 2.0 PKCE 认证实现，涵盖 code_verifier 生成、state CSRF 防护、平台差异、token 生命周期管理及并发控制。

## 目录

1. [为什么是 PKCE](#1-为什么是-pkce)
2. [PKCE 算法详解](#2-pkce-算法详解)
3. [OAuth State CSRF 防护](#3-oauth-state-csrf-防护)
4. [授权码获取：三条路径](#4-授权码获取三条路径)
5. [Token 交换与存储](#5-token-交换与存储)
6. [Token 刷新与并发控制](#6-token-刷新与并发控制)
7. [凭证清除：时序安全](#7-凭证清除时序安全)
8. [平台差异全景](#8-平台差异全景)
9. [安全敏感字段脱敏](#9-安全敏感字段脱敏)
10. [PKCE 代码路径追踪](#10-pkce-代码路径追踪)
11. [Review 中暴露的安全问题](#11-review-中暴露的安全问题)
12. [常见问题排查](#12-常见问题排查)

---

## 1. 为什么是 PKCE

### 1.1 问题：Client Secret 无法安全存储

传统 OAuth 2.0 授权码流程需要 `client_secret` —— 但 Electron/WebView/Capacitor 应用无法安全存储：

- Electron：反编译 `app.asar` 即可提取
- Web：浏览器 DevTools → Sources 面板直接可见
- 移动端：APK/IPA 解包可提取

### 1.2 方案：PKCE (Proof Key for Code Exchange)

PKCE 用动态生成的 `code_verifier → code_challenge` 替代静态 `client_secret`：

```
攻击者能截获 code?
  → 是，但不知道 code_verifier
  → token 端点验证 SHA256(verifier) == challenge
  → 攻击者无法用截获的 code 换 token ✓

攻击者能伪造 code?
  → 是，但 token 端点仍会验证 verifier
  → 假 code 无法通过 PKCE 校验 ✓
```

Super Productivity 选择 PKCE 的原因：

- Electron 应用无法安全存储 client_secret
- PKCE 是 OAuth 2.1 推荐方式，Microsoft 强制要求本地应用使用
- 与 Microsoft Identity Platform 最佳实践一致

---

## 2. PKCE 算法详解

### 2.1 代码位置

`packages/sync-providers/src/pkce.ts` — 独立跨平台 PKCE 实现，编译为 ESM，可在 Node.js + Browser + Capacitor 上运行。

### 2.2 generateCodeVerifier()

```typescript
// pkce.ts:86-92
export const generateCodeVerifier = (
  options: GenerateCodeVerifierOptions = {},
): string => {
  const cryptoLike = options.crypto ?? getDefaultCrypto(); // globalThis.crypto
  const array = new Uint8Array(options.randomBytesLength ?? 32); // 32 bytes = 43 chars
  cryptoLike.getRandomValues(array);
  return base64UrlEncode(array);
};
```

**算法**：

1. `crypto.getRandomValues()` 生成 32 字节随机数
2. Base64URL 编码（`+ → -`, `/ → _`, 去掉尾 `=`）
3. 结果：43 字符的随机字符串，如 `"dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"`

### 2.3 generateCodeChallenge()

```typescript
// pkce.ts:95-108
export const generateCodeChallenge = async (
  verifier: string,
  options: GenerateCodeChallengeOptions = {},
): Promise<string> => {
  const TextEncoderLike = getTextEncoder();
  const data = new TextEncoderLike().encode(verifier);

  // 优先用 Web Crypto API (Browser/Node 21+)
  const cryptoLike = options.crypto ?? getOptionalDefaultCrypto();
  const subtle = cryptoLike?.subtle;

  const digest =
    subtle != null
      ? await subtle.digest('SHA-256', data)
      : // 降级：hash-wasm (纯 JS WASM SHA-256，支持旧环境)
        await (options.sha256Fallback ?? hashWasmSha256ArrayBuffer)(data);

  return base64UrlEncode(new Uint8Array(digest));
};
```

**算法**：

1. `TextEncoder` 将 verifier 字符串编码为 `Uint8Array`
2. SHA-256 哈希（优先 Web Crypto API `subtle.digest('SHA-256')`，降级 hash-wasm WASM）
3. Base64URL 编码结果
4. 结果：43 字符的 Base64URL 字符串

### 2.4 完整流程：从 verifier 到 Microsoft 验证

```
App 端:                                      Microsoft 端:

verifier = random 32 bytes
  → Base64URL(verifier) = "dBjft..."
                                      ┌──→ 存储 challenge（关联到 code）
challenge = SHA256(verifier)         │
  → Base64URL(challenge) = "E9Mel..."┘

授权 URL 带上:
  code_challenge=E9Mel...
  code_challenge_method=S256

用户登录授权后:

← Microsoft 返回 code (一次性，10 分钟有效)

POST /token:
  grant_type=authorization_code
  code=xxx
  code_verifier=dBjft...          → Microsoft 内部:
                                      SHA256(verifier) == 存储的 challenge?
                                        是 → 返回 access_token + refresh_token ✓
                                        否 → 400 invalid_grant ✗
```

### 2.5 SHA-256 降级策略

```
优先: Web Crypto API (crypto.subtle.digest)
  ├─ Browser ✓ (所有现代浏览器)
  ├─ Node.js 21+ ✓
  └─ 环境不支持 crypto.subtle → 降级

降级: hash-wasm (WASM-based SHA-256)
  ├─ 纯 JS 实现，无原生依赖
  ├─ 跨平台一致输出
  └─ Electron/旧 Node.js 环境下可用
```

---

## 3. OAuth State CSRF 防护

### 3.1 攻击场景

```
攻击者诱导用户点击:
  https://login.microsoftonline.com/.../authorize?
    client_id=LEGIT_APP&
    code=ATTACKER_CODE&     ← 攻击者的 code
    state=ANYTHING

用户粘贴这个 URL → 应用提取 code=ATTACKER_CODE
→ 用 ATTACKER_CODE 换 token → 绑定了攻击者的身份！
→ 用户的数据被同步到攻击者账户

PKCE 部分缓解 (code_verifier 不匹配 → token 交换失败)
但 OAuth 规范仍要求 state 作为额外防御层。
```

### 3.2 实现

`src/app/imex/sync/oauth-state.util.ts`:

```typescript
const OAUTH_STATES_MAP = new Map<string, { provider: string; expiresAt: number }>();
const TOKEN_STATE_VALIDITY_MS = 10 * 60 * 1000; // 10 分钟

// 发起授权时存储
export const addOAuthState = (provider: string, state: string): void => {
  _pruneExpiredOAuthStates();
  OAUTH_STATES_MAP.set(state, {
    provider,
    expiresAt: Date.now() + TOKEN_STATE_VALIDITY_MS,
  });
};

// 回调时验证 (一次性，验证后删除)
export const validateOAuthState = (provider: string, state: string | null): boolean => {
  _pruneExpiredOAuthStates();
  if (!state) return false;
  const stored = OAUTH_STATES_MAP.get(state);
  if (!stored || stored.provider !== provider) return false;
  OAUTH_STATES_MAP.delete(state); // 一次性使用
  return true;
};
```

### 3.3 State 生成

`onedrive.ts:125-127` — 用 `crypto.getRandomValues` 生成 32 字节随机 hex 字符串：

```typescript
const state = Array.from(crypto.getRandomValues(new Uint8Array(32)))
  .map((b) => b.toString(16).padStart(2, '0'))
  .join('');
this._deps.addOAuthState('onedrive', state);
```

### 3.4 两处验证点

| 验证点            | 文件                                                  | 触发场景                                        |
| ----------------- | ----------------------------------------------------- | ----------------------------------------------- |
| Electron 回调解析 | `oauth-callback-handler.service.ts:122`               | 协议处理器 `superproductivity://oauth-callback` |
| 手动粘贴对话框    | `dialog-get-and-enter-auth-code.component.ts:135-150` | 用户粘贴完整回调 URL                            |

**手动粘贴的特殊处理**：

- 完整 URL 粘贴 → 必须包含 state 参数并验证通过
- 纯 code 粘贴 → 不要求 state（无法验证），但 PKCE 提供保护

### 3.5 内存管理

- `OAUTH_STATES_MAP` 是模块级变量（非类实例），有界泄漏（10 分钟 TTL）
- 每次 `addOAuthState` / `validateOAuthState` 时触发 `_pruneExpiredOAuthStates()` 清理过期条目
- 不用 `setInterval` 轮询（避免后台持续运行）

---

## 4. 授权码获取：三条路径

### 4.1 路径总览

```
用户点击 "Authorize"
    │
    ▼
getAuthHelper() 生成:
  ├─ codeVerifier (内存)
  ├─ codeChallenge = SHA256(verifier)
  ├─ state = random 64 hex chars
  └─ authUrl = https://login.microsoftonline.com/{tenant}/oauth2/v2.0/authorize?
       client_id={clientId}&
       response_type=code&
       redirect_uri={redirectUri}&
       scope=offline_access Files.ReadWrite.AppFolder&
       code_challenge={challenge}&
       code_challenge_method=S256&
       state={state}
    │
    ▼
用户打开 authUrl (浏览器/系统浏览器)
    │
    ├── Electron 路径 ──────────────────────────────┐
    │   1. shell.openExternal(authUrl)               │
    │   2. 用户在浏览器登录 Microsoft                │
    │   3. Microsoft 302 →                            │
    │      superproductivity://oauth-callback/onedrive│
    │      ?code=xxx&state=yyy                        │
    │   4. Electron 主进程 IPC → 前端                 │
    │   5. 验证 state → 提取 code                     │
    │                                                 │
    ├── Web 路径 ───────────────────────────────────┤
    │   1. window.open(authUrl)                      │
    │   2. 用户在浏览器登录 Microsoft                 │
    │   3. Microsoft 302 →                            │
    │      https://login.microsoftonline.com/.../     │
    │      nativeclient?code=xxx                      │
    │   4. 用户手动复制 code 并粘贴                   │
    │                                                 │
    └── 手动粘贴路径 (全平台兜底) ──────────────────┘
        1. 用户手动复制完整回调 URL 或纯 code
        2. 粘贴到对话框
        3. _normalizeAuthCodeInput() 智能提取:
           ├─ URL 解析 (new URL) → searchParams.get('code')
           │  └─ OneDrive: 同时提取 state 并验证
           └─ 正则兜底: /(?:^|[?&#])code=([^&#]+)/i
    │
    ▼
_exchangeAuthCode(code, codeVerifier, cfg)
    POST /token → { access_token, refresh_token, expires_in }
```

### 4.2 Electron 回调监听

`oauth-callback-handler.service.ts:_setupElectronOAuthListener()`:

```
Electron 主进程:
  app.setAsDefaultProtocolClient('superproductivity')
  → 收到 superproductivity://oauth-callback/onedrive?code=xxx&state=yyy
  → ipcMain → IPC.OAUTH_CALLBACK → 前端

前端验证链:
  1. startsWith('superproductivity://oauth-callback')  ← scheme gate
  2. 不记录完整 URL 到日志 (避免 code/state 泄露)
  3. state 验证通过 → authCodeReceived$.next({ code, provider: 'onedrive' })
```

### 4.3 手动粘贴对话框

`dialog-get-and-enter-auth-code.component.ts:_normalizeAuthCodeInput()`:

```
输入: 用户粘贴的字符串

Step 1: try new URL(input)
  ├─ 是有效 URL → searchParams.get('code')
  │  └─ OneDrive? → searchParams.get('state') → validateOAuthState()
  │      ├─ 缺少 state → snack: "OAuth state missing"
  │      └─ state 无效 → snack: "OAuth state validation failed"
  └─ 不是 URL → 走正则

Step 2: 正则提取 /(?:^|[?&#])code=([^&#]+)/i
  └─ 匹配 → decodeURIComponent(codeMatch[1])
  └─ 不匹配 → 返回原始输入 (假设就是纯 code)
```

---

## 5. Token 交换与存储

### 5.1 Token 端点请求

`onedrive.ts:_requestOAuthToken()`:

```
POST https://login.microsoftonline.com/{tenant}/oauth2/v2.0/token
Content-Type: application/x-www-form-urlencoded

grant_type=authorization_code   (或 refresh_token)
&client_id={clientId}
&scope=offline_access Files.ReadWrite.AppFolder
&code={code}                    (仅 authorization_code)
&code_verifier={verifier}       (仅 authorization_code)
&redirect_uri={redirectUri}     (仅 authorization_code)
&refresh_token={refreshToken}   (仅 refresh_token)
```

### 5.2 Token 响应

```typescript
interface OneDriveTokenResponse {
  access_token: string; // JWT，约 1 小时有效
  refresh_token?: string; // 90 天有效 (Microsoft 默认)
  expires_in: number; // access_token 有效期 (秒)
  // id_token 也存在于响应中，但不存储 —— 只在 code 交换时出现
}
```

### 5.3 Token 存储

```
Token 存储路径:
  Electron: safeStorage.encryptString() → electron-store (加密文件)
  Web:     sessionStorage (仅会话期间，但 refresh_token 持久化)
  移动端:  Capacitor 加密存储

凭证结构 (OneDrivePrivateCfg):
  {
    useCustomApp: boolean,       // 使用自建还是官方 Azure AD 应用
    clientId: string,            // Azure AD 应用 ID
    tenantId: string,            // 'common' | 具体 tenant ID
    syncFolderPath: string,      // OneDrive 中的同步文件夹名
    accessToken: string,         // ← 加密存储
    refreshToken: string,        // ← 加密存储
    tokenExpiresAt: number,      // epoch ms
  }

关键: tokens 通过 Electron safeStorage / sessionStorage 加密持久化。
应用重启后无需重新授权 (除非 refresh_token 已过期)。
```

### 5.4 isReady() 判断

```typescript
async isReady(): Promise<boolean> {
  const cfg = await this.privateCfg.load();
  const resolvedClientId = this._resolveClientId(cfg || {});
  return !!(resolvedClientId && cfg?.accessToken && cfg?.refreshToken);
}
// 三个条件:
//   1. 有 clientId (官方或自建)
//   2. 有 accessToken
//   3. 有 refreshToken
// 缺一不可 → 视为未配置，触发授权流程
```

---

## 6. Token 刷新与并发控制

### 6.1 刷新触发

每次 API 调用前 (`_request()`) 检查 token 是否需要刷新：

```typescript
// 提前 60 秒刷新 (tokenRefreshSkewMs)，防止网络延迟导致过期请求
if (Date.now() < expiresAt - 60_000) {
  return cfg.accessToken; // ← 还没到刷新窗口，直接用
}
```

### 6.2 单飞锁模式

```
_refreshAccessTokenIfNeeded(cfg):
    │
    ├── token 未过期 → return cfg.accessToken
    │
    ├── !cfg.refreshToken → throw MissingRefreshTokenAPIError
    │    (这意味着 credentials 已被清除或从未配置)
    │
    ├── _tokenRefreshInFlightPromise 存在
    │    → await 它，不发起新刷新
    │    (所有并发请求共享同一个刷新操作)
    │
    └── 首次刷新者:
         _tokenRefreshInFlightPromise = (async () => {
           try:
             tokenData = POST /token (refresh_token grant)

             // ⚠️ 重新加载 cfg 并做安全检查 (IIFE tri-guard)
             currentCfg = await privateCfg.load()
             if (!currentCfg?.refreshToken
                 || currentCfg.refreshToken !== cfg.refreshToken
                 || currentCfg.clientId !== cfg.clientId
                 || currentCfg.tenantId !== cfg.tenantId):
               // 凭证在刷新期间被改变了 (可能是用户切换应用、断开连接)
               logger.warn('Credentials changed during refresh')
               throw new Error('stale refresh discarded')
             // 不抛 MissingRefreshTokenAPIError —
             // 会触发 401 重试路径的 clearAuthCredentials，清除新凭证

             updatedCfg = { ...currentCfg, accessToken, refreshToken, expiresAt }
             await privateCfg.setComplete(updatedCfg)
             return accessToken
           finally:
             _tokenRefreshInFlightPromise = null  // 总是重置锁
         })()

         并发请求 arrival:
           await _tokenRefreshInFlightPromise  ← 等待 #1 完成
           return  ← 直接返回，不重复刷新
```

### 6.3 为什么用 while 轮询而不是 Promise 缓存？

初始实现使用了 `while (_isRefreshingToken) { await sleep(50) }` 轮询模式。最终实现改为 Promise 缓存（`_tokenRefreshInFlightPromise`）——本质效果相同（并发请求等待同一个 Promise 完成），但后者避免了 sleep 延迟和不必要的轮询循环。

### 6.4 finally 清理

```typescript
finally {
  this._tokenRefreshInFlightPromise = null;
}
```

**为什么必须在 finally 中？** 如果刷新失败（网络错误、refresh_token 失效），没有 finally → 锁永远不会释放 → 所有后续请求永久阻塞。

**注意 (Review #2 Minor)**: `null` 在 `setComplete` 被 await 之前就赋值。如果 `setComplete` 拒绝，in-flight 引用已丢弃，下一个请求会对半清除状态启动新刷新。实践中影响低（in-flight token 本身也已失效）。

---

## 7. 凭证清除：时序安全

### 7.1 clearAuthCredentials() 设计

```typescript
async clearAuthCredentials(): Promise<void> {
  const cfg = await this.privateCfg.load();
  if (!cfg) return;

  // 不等 await 就清零 —— 防止 self-deadlock
  // (clearAuthCredentials 可能被 refresh IIFE 从内部调用于 invalid_grant 路径)
  this._tokenRefreshInFlightPromise = null;

  await this.privateCfg.setComplete({
    ...cfg,
    accessToken: '',
    refreshToken: '',
    tokenExpiresAt: 0,
  });
}
```

### 7.2 为什么先 null 再 await

```
时间线 (如果先 await 再 null):

  refresh IIFE 在 invalid_grant 分支:
    → clearAuthCredentials()
    → await 等待 _tokenRefreshInFlightPromise  ← 死锁!
      因为 _tokenRefreshInFlightPromise 就是 IIFE 本身!

时间线 (正确: 先 null 再 await):

  1. _tokenRefreshInFlightPromise = null  ← 释放锁
  2. await privateCfg.setComplete(clearedCfg)  ← 安全
```

### 7.3 竞态窗口 (Review #1 Critical + Review #2 跟进)

```
并发场景: 用户点击 Disconnect 的同时 refresh 正在进行中

时间线:
  ┌─────────────────────────────────────────────────────────┐
  │ In-flight refresh IIFE              │ clearAuthCredentials│
  ├─────────────────────────────────────┼─────────────────────┤
  │ await privateCfg.load()             │                     │
  │   → currentCfg 仍有 token 值        │                     │
  │                                     │ null inFlightPromise │
  │                                     │ setComplete({       │
  │                                     │   accessToken: '',  │
  │                                     │   refreshToken: '', │
  │                                     │   ...cfg            │
  │                                     │ })                  │
  │ setComplete({                       │                     │
  │   ...currentCfg, ← 闭包中的旧值!!   │                     │
  │   accessToken: NEW,  ← 覆盖了 ''    │                     │
  │   refreshToken: NEW  ← 覆盖了 ''    │                     │
  │ })                                  │                     │
  └─────────────────────────────────────┴─────────────────────┘

结果: clearAuthCredentials 的清除被静默撤销。
     用户在 UI 看到断开连接成功，但 token 仍然有效。

缓解: IIFE 内部的 tri-guard (currentCfg.refreshToken !== cfg.refreshToken)
     理论上保护，但存在微任务级 TOCTOU 窗口——
     在 tri-guard 检查通过和 setComplete 执行之间，
     clearAuthCredentials 的 setComplete 可能刚好穿插进来。

风险评级: 低。在下一个同步周期中，系统会检测到不一致并自我纠正。
```

### 7.4 \_clearIfConfigMatches 三重匹配

```typescript
private async _clearIfConfigMatches(cfg: Partial<OneDrivePrivateCfg>): Promise<void> {
  const currentCfg = await this.privateCfg.load();
  if (
    currentCfg?.refreshToken === cfg.refreshToken &&
    currentCfg?.clientId === cfg.clientId &&
    currentCfg?.tenantId === cfg.tenantId
  ) {
    await this.clearAuthCredentials();
  }
}
```

**为什么三重匹配**：防止误清除。如果用户在清除过程中切换了应用，旧凭证的清除不会影响新凭证。三个维度都必须匹配才执行清除。

---

## 8. 平台差异全景

> **重要**：OneDrive 同步在 Web/浏览器版本中**完全不可用**。`IS_ONEDRIVE_SUPPORTED = IS_ELECTRON || IS_NATIVE_PLATFORM` 守卫使得 OneDrive provider 在 Web 构建中不会被注册，配置表单中也不会出现该选项。以下内容仅适用于桌面（Electron）和移动端（Capacitor）。

| 平台        | OAuth Redirect URI                                             | State 校验       | 代码获取方式 | Token 存储         |
| ----------- | -------------------------------------------------------------- | ---------------- | ------------ | ------------------ |
| Electron    | `superproductivity://oauth-callback/onedrive`                  | ✓ 协议处理器回调 | IPC 自动接收 | `safeStorage` 加密 |
| iOS/Android | `https://login.microsoftonline.com/common/oauth2/nativeclient` | 仅手动粘贴时     | 手动粘贴     | Capacitor 加密存储 |

> Web 行已从上表中移除，因为 OneDrive 在 Web 上不可用。

### 8.1 Electron 特殊处理

```
Electron 协议注册:
  Windows: 注册表 HKEY_CLASSES_ROOT\superproductivity
  macOS:   Info.plist CFBundleURLSchemes
  Linux:   xdg-mime

Deeplink 重定向:
  superproductivity://oauth-callback/{provider}?code=xxx&state=yyy
  主进程: app.on('open-url') → IPC → 前端

安全措施:
  - IPC 载荷不包含完整 URL (code/state 在 URL 中)
  - 前端 scheme gate: startsWith('superproductivity://oauth-callback')
  - 拒绝时不记录完整 URL (只记录 scheme)
```

### 8.2 `IS_ONEDRIVE_SUPPORTED` 守卫

OneDrive 在 Web 上不可用（见上方 8.1 注）。这一限制由 `IS_ONEDRIVE_SUPPORTED = IS_ELECTRON || IS_NATIVE_PLATFORM` 控制，影响两个层面：

- **Provider 注册**（`sync-providers.factory.ts`）：Web 构建中 OneDrive 不会被实例化
- **UI 可见性**（`sync-form.const.ts`）：Web 上同步配置下拉不显示 OneDrive 选项

这在代码中并非事后补救——是一开始就设计好的约束，因为 OAuth PKCE 流程依赖 Electron 的协议处理器或移动端的 WebView 回调来安全接收授权码。

### 8.3 \_getRedirectUri()

```typescript
private _getRedirectUri(): string {
  if (!this._deps.isElectron) {
    return ONEDRIVE_PROTOCOL.redirectUri;   // 'https://login.microsoftonline.com/common/oauth2/nativeclient'
  }
  return ONEDRIVE_PROTOCOL.electronRedirectUri;  // 'superproductivity://oauth-callback/onedrive'
}
```

---

## 9. 安全敏感字段脱敏

### 9.1 Token 端点响应脱敏

`onedrive.ts:_redactSensitiveFields()`:

```typescript
const sensitiveKeys = [
  'code',
  'code_verifier',
  'refresh_token',
  'access_token',
  'id_token', // ← Review R6 发现遗漏后补充
];
```

**注意**: `id_token` 是 Microsoft 返回的第三个 token（除了 access_token 和 refresh_token），包含用户身份声明（姓名、邮箱、UPN、租户 ID 等 PII）。如果未被脱敏，会泄露用户个人信息。

### 9.2 OAuth 回调 URL 日志保护

```typescript
// 错误做法 (Review #1 发现):
SyncLog.log('Received OAuth callback URL', callbackUrl);
// callbackUrl = "superproductivity://oauth-callback/onedrive?code=SECRET&state=SECRET"

// 正确做法:
SyncLog.log('OAuthCallbackHandler: Received Electron OAuth callback URL');
// 不传第二个参数 — code 和 state 都不写入日志
```

### 9.3 日志中不包含

- OAuth `code` / `state` / `code_verifier`
- `access_token` / `refresh_token` / `id_token`
- 用户输入的文件夹路径 (仅记录状态码)
- 任何 Microsoft Graph API 响应中的用户数据

---

## 10. PKCE 代码路径追踪

### 10.1 文件关系

```
packages/sync-providers/src/
├── pkce.ts                          ← 独立的 PKCE 实现 (code_challenge / code_verifier)
├── file-based/onedrive/
│   ├── onedrive.ts                  ← OAuth 流程编排 (getAuthHelper / token exchange / refresh)
│   └── onedrive.model.ts            ← OneDrivePrivateCfg / OneDriveTokenResponse 类型
├── provider-types.ts                ← SyncProviderAuthHelper 接口
├── credential-store-port.ts         ← SyncCredentialStorePort 接口 (token 持久化)
└── errors.ts                        ← AuthFailSPError / MissingRefreshTokenAPIError 等

src/app/
├── imex/sync/
│   ├── oauth-state.util.ts          ← addOAuthState / validateOAuthState
│   ├── oauth-callback-handler.service.ts  ← Electron/原生 URL 监听器
│   └── dialog-get-and-enter-auth-code/    ← 手动粘贴组件
│       └── dialog-get-and-enter-auth-code.component.ts
└── op-log/sync-providers/
    └── file-based/onedrive/onedrive.ts    ← 工厂函数 (createOneDriveProvider)
```

### 10.2 端到端认证数据流

```
SyncProviderAuthHelper                       OneDrive._exchangeAuthCode
┌────────────────────┐                    ┌──────────────────────────┐
│ generateCodeVerifier│ ←── crypto.random│                          │
│ generateCodeChallenge│←── SHA256(verif)│                          │
│ state = random 64hex│ ←── crypto.random│                          │
│ addOAuthState(state)│                   │                          │
│                    │                    │                          │
│ authUrl 传递给 UI  │                    │                          │
│ 用户登录 Microsoft │                    │                          │
│ Microsoft 返回 code│                    │                          │
│                    │                    │                          │
│ verifyCodeChallenge│───────────────────→│ POST /token              │
│   (code)           │                    │ code + code_verifier     │
│                    │                    │ → OneDriveTokenResponse  │
│                    │                    │ → 存储到 credentialStore │
└────────────────────┘                    └──────────────────────────┘
```

---

## 11. Review 中暴露的安全问题

| 问题                                                                                      | 严重程度  | 状态                                |
| ----------------------------------------------------------------------------------------- | --------- | ----------------------------------- |
| `id_token` 未脱敏 (R6) — Microsoft 返回三个 token，只有两个在脱敏列表中                   | 阻塞      | ✅ 已修复                           |
| OAuth 回调 URL 通过 `SyncLog.log` 暴露 code + state (Review #1)                           | Important | ✅ 已修复 (移除第二个参数)          |
| `_normalizeAuthCodeInput` regex 接受任意含 `code=` 的输入 — PKCE 保护但不明显 (Review #1) | Minor     | ⚠️ 已加注释说明                     |
| `OAUTH_STATES_MAP` 模块级变量的内存泄漏 (Review #1)                                       | Minor     | ⚠️ 有界泄漏 (10min TTL)，实践中无害 |
| Web 中 OneDrive 不可用 — `IS_ONEDRIVE_SUPPORTED` 守卫阻止注册 (见 §8.1)                 | N/A       | 设计即如此                         |
| 用户输入的文件夹名出现在日志中 (Review #1)                                                | Minor     | ⚠️ 已改造 (只记录状态码)            |
| 切换 Azure AD 应用身份时旧 token 未清除 (R7)                                              | 阻塞      | ✅ 已修复 (三重身份匹配)            |

---

## 12. 常见问题排查

### 12.1 "invalid_grant" 错误

```
原因: refresh_token 已被撤销 (密码变更、登出、token 老化)
处理: 自动清除凭证 → 下次同步抛出 MissingRefreshTokenAPIError → UI 提示重新授权
恢复: 用户在同步设置中重新点击 Authorize
```

### 12.2 "AADSTS50011" 错误

```
原因: redirect URI 与应用注册类型不匹配
出现场景: 桌面/移动端使用的 redirect URI 与 Entra 应用注册类型不符
解决: 在 Azure AD 中注册 "Mobile and desktop applications" 类型的应用
```

### 12.3 "state validation failed" 错误

```
原因: OAuth state 不匹配 (CSRF 保护触发)
可能：
  1. 用户复制了错误的 URL
  2. state 已过期 (超过 10 分钟)
  3. 攻击者尝试 CSRF
解决: 重新点击 Authorize，在 10 分钟内完成授权
```

### 12.4 Token 刷新死锁

```
症状: 所有 API 调用挂起，不报错也不返回
原因: _tokenRefreshInFlightPromise 未被重置 (finally 未执行)
排查: 检查 refresh token 端点是否可达、refresh_token 是否有效
恢复: 重启应用 (工厂重新创建 OneDrive 实例 → 新 _tokenRefreshInFlightPromise = null)
```

---

## 相关资源

- [RFC 7636 - Proof Key for Code Exchange (PKCE)](https://datatracker.ietf.org/doc/html/rfc7636)
- [Microsoft Identity Platform - PKCE](https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-auth-code-flow)
- [OAuth 2.1 草案](https://datatracker.ietf.org/doc/draft-ietf-oauth-v2-1/)
- [OAuth 2.0 Threat Model - CSRF](https://datatracker.ietf.org/doc/html/rfc6819#section-3.6)
- [Super Productivity Sync Architecture](./sync-architecture-deep-dive.md)
- [OneDrive Implementation Summary](./onedrive-implementation-summary.md)
- [PR Review Lessons Learned](./review-lessons-learned.md)
