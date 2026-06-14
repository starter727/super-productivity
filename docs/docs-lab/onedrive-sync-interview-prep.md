# OneDrive 同步项目 — 面试准备文档

> 基于 PR [#7523](https://github.com/super-productivity/super-productivity/pull/7523)，经源码与 PR review 讨论核实。

---

## 一、项目概述（30 秒介绍版）

为开源效率工具 Super Productivity（GitHub 12k+ star）新增 **OneDrive 云端同步**能力。基于 Microsoft Graph API 实现跨设备任务数据同步，复用项目已有的 `FileSyncProvider` 接口，只需实现 5 个方法（getFileRev / downloadFile / uploadFile / removeFile / listFiles）即可接入完整的冲突解决、加密、备份恢复链路。PR 经历 8 轮 code review，21 个 commit，最终合入 master。

---

## 二、两个核心技术点详解

### 2.1 OAuth 2.0 PKCE 认证流程

#### 背景与问题

OneDrive 同步需要用户授权访问其 OneDrive 存储。传统 OAuth 授权码流程需要客户端密钥（client_secret），但桌面端/Electron 应用无法安全存储密钥——反编译即可获取。

#### 方案选择：PKCE

**PKCE（Proof Key for Code Exchange）** 是 OAuth 2.0 的扩展（RFC 7636），专门解决公开客户端的安全问题：

```
┌──────────┐                              ┌──────────────────┐
│  Client   │                              │ Microsoft Entra  │
└─────┬────┘                              └────────┬─────────┘
      │  1. 生成 code_verifier (随机 32 字节)       │
      │     code_challenge = SHA256(verifier)       │
      │                                             │
      │  2. 授权请求 + code_challenge + state ──────>│
      │                                             │
      │<── 3. 返回 authorization_code ──────────────│
      │                                             │
      │  4. 用 code + code_verifier 换 token ──────>│
      │     （服务端验证 SHA256(verifier) === challenge）│
      │<── 5. 返回 access_token + refresh_token ───│
```

**关键点：** code_verifier 从未在网络上传输（只传了它的 hash），即使授权码被截获，攻击者没有 verifier 也无法换 token。

#### 实际实现细节（源码核实）

**PKCE 生成**（`packages/sync-providers/src/pkce.ts`）：

- `generateCodeVerifier()`：32 字节随机数 → base64url 编码
- `generateCodeChallenge(verifier)`：先尝试 `crypto.subtle.digest('SHA-256')`，不可用时降级到 `hash-wasm` 库
- 降级策略的原因：部分 Electron 环境的 `crypto.subtle` 不可用

**CSRF 防护**（`src/app/imex/sync/oauth-state.util.ts`）：

- 授权前生成 32 字节随机 state，存入内存 Map（`OAUTH_STATES_MAP`）
- 回调时验证 state 存在且 provider 匹配，验证后立即删除（一次性使用）
- 10 分钟过期自动清理，防止 Map 无限增长

**Token 刷新并发控制**（`onedrive.ts:474-528`）——这是最难的部分，涉及三个互相纠缠的竞态问题。

**前置知识：两种 Token**

先搞清楚两个 token 的区别，后面所有竞态都围绕它们：

| Token           | 作用                                                                   | 生命周期                        | 存储位置                           |
| --------------- | ---------------------------------------------------------------------- | ------------------------------- | ---------------------------------- |
| `access_token`  | 携带在每次 API 请求的 `Authorization: Bearer` 头里，证明"我是这个用户" | 短（通常 1 小时），过期后不能用 | 内存 + 持久化存储                  |
| `refresh_token` | 只在 token 端点使用，用来换新的 access_token                           | 长（数月），可以反复使用        | 持久化存储（`OneDrivePrivateCfg`） |

```typescript
// onedrive.model.ts
export interface OneDrivePrivateCfg {
  clientId: string; // Azure AD 应用的 ID
  tenantId: string; // Azure AD 租户 ID
  accessToken?: string; // 短期令牌，每次 API 请求用
  refreshToken?: string; // 长期令牌，只用来换 accessToken
  tokenExpiresAt?: number; // accessToken 的过期时间戳
}
```

**流程：** access_token 过期 → 用 refresh_token 去 Microsoft 换一个新的 access_token → 存入配置 → 继续发请求。

**前置知识：同步流程和 maxConcurrentRequests**

先搞清楚实际的同步流程——单次同步周期内，操作是**顺序的**，不是并发的：

```
一次同步周期（顺序执行）：
  1. getFileRev()    → 检查远程文件版本（ETag）
  2. downloadFile()  → 下载最新 sync-data.json
  3. 处理冲突、合并操作日志
  4. uploadFile()    → 上传合并后的数据
```

而且 `LockService` 会阻止多个同步周期并发。所以正常情况下不会同时有多个请求。

那 `maxConcurrentRequests = 4` 是什么意思？它是 provider 的**能力声明**（"我能承受最多 4 个并发 API 调用"），不是同步引擎会主动发出 4 个并发请求。真正可能出现并发的边缘场景：

- `listFiles` 的分页循环（逐页请求，token 在翻页过程中过期）
- `_uploadWithMismatchFallback` 中 re-download 和原 upload 之间的时间窗口
- 用户快速触发了多次同步操作（LockService 可能还没来得及加锁）

**singleflight 的真正价值是防御性编程**——即使正常情况下只有 1 个请求触发刷新，singleflight 也没坏处；如果真的出现并发（边缘场景），它能正确去重。Dropbox 也用同样的模式。

**竞态 1：重复刷新（duplicate refresh）**

4 个请求同时 401，如果不做控制，每个都会发起一次 token 刷新：

```
时间线（无 singleflight）：
  请求A ──401──> 用 refresh_token_v1 去换 access_token ──────────────> 拿到 access_token_v2 ✓
  请求B ──401──> 用 refresh_token_v1 去换 access_token ──────────────> 拿到 access_token_v3 ✓
  请求C ──401──> 用 refresh_token_v1 去换 access_token ──────────────> 拿到 access_token_v4 ✓
  请求D ──401──> 用 refresh_token_v1 去换 access_token ──────────────> 拿到 access_token_v5 ✓
```

问题：

1. 4 次刷新请求，3 次浪费
2. 4 个请求各自拿到不同的 access_token，各自写入存储，后写入的覆盖先写入的
3. 请求A 用 access_token_v2 重试，但存储中已经是 access_token_v5 了（不影响功能，但很乱）

解决方案——singleflight 模式（`onedrive.ts:486-488`）：

```typescript
private _tokenRefreshInFlightPromise: Promise<string> | null = null;

private async _refreshAccessTokenIfNeeded(cfg: OneDrivePrivateCfg): Promise<string> {
  // 如果 token 还没过期，直接返回
  if (cfg.accessToken && Date.now() < cfg.tokenExpiresAt - 60_000) {
    return cfg.accessToken;
  }

  // ★ singleflight：如果已经有刷新在进行中，直接等它的结果
  if (this._tokenRefreshInFlightPromise) {
    return this._tokenRefreshInFlightPromise;
  }

  // ★ 第一个到达的请求负责发起刷新
  this._tokenRefreshInFlightPromise = (async () => {
    try {
      const tokenData = await this._requestOAuthToken(cfg, { ... });
      // ... 写入存储 ...
      return tokenData.access_token;
    } finally {
      this._tokenRefreshInFlightPromise = null;  // 无论成功失败都清除
    }
  })();

  return this._tokenRefreshInFlightPromise;
}
```

```
时间线（有 singleflight）：
  请求A ──401──> _refreshAccessTokenIfNeeded()
                 → token 过期了，_tokenRefreshInFlightPromise 是 null
                 → 自己发起刷新，设置 _tokenRefreshInFlightPromise = 自己的 Promise
                 → 用 refresh_token_v1 换 access_token ...

  请求B ──401──> _refreshAccessTokenIfNeeded()
                 → token 过期了，但 _tokenRefreshInFlightPromise 不是 null！
                 → 直接返回 A 的 Promise，等 A 刷新完拿到同一个 access_token_v2

  请求C ──401──> 同 B，等 A

  请求D ──401──> 同 B，等 A

  A 刷新完成 → 4 个请求都拿到 access_token_v2 → 各自用 v2 重试业务请求
```

**关于超时问题：** singleflight 没有内置超时。如果 Microsoft 的 token 端点挂了，`_requestOAuthToken` 会一直等 HTTP 响应。但这里依赖的是外层 `_request()` 使用的 `webFetch`（底层是 `fetch`），Electron 的 `fetch` 有连接超时。另外 `_requestOAuthToken` 本身会在收到非 200 响应时立即抛错（`HttpNotOkAPIError`），不会无限等待。所以实际上不会死锁，但确实没有显式的超时兜底——这是可以改进的点。

**竞态 2：凭据回退（credential regression）**

singleflight 解决了"重复刷新"，但还有一个更隐蔽的问题。注意上面的时间线里，4 个请求是在**等同一个 Promise**。但如果等待过程中，用户在 UI 上操作了呢？

```
时间线：
  t0  请求A 开始用 refresh_token_v1 刷新，_tokenRefreshInFlightPromise = Promise_A
  t1  请求B、C、D 都在等 Promise_A
  t2  用户在 UI 上点"断开连接"→ 重新用另一个 OneDrive 账号授权
      → 存储被更新为：refresh_token_v2, clientId_v2, tenantId_v2
  t3  请求A 的刷新完成，Microsoft 返回了 access_token_new + refresh_token_new_from_v1
      （注意：这是用旧的 refresh_token_v1 换来的）
  t4  请求A 把结果写入存储 → refresh_token_v2 被覆盖成 refresh_token_new_from_v1！
      clientId_v2 和 tenantId_v2 也被覆盖回旧值！
```

后果：用户以为自己切换了账号，但实际上又切回了旧账号，而且旧账号的 access_token 可能也已经失效了。

解决方案——写入前重新读取存储做三重校验（`onedrive.ts:498-511`）：

```typescript
this._tokenRefreshInFlightPromise = (async () => {
  try {
    const tokenData = await this._requestOAuthToken(cfg, { ... });

    // ★ 刷新完成后，重新读取存储中的"当前"凭据
    const currentCfg = await this.privateCfg.load();

    // ★ 对比：存储中的凭据还是不是发起刷新时的那个？
    if (
      !currentCfg?.refreshToken ||
      currentCfg.refreshToken !== cfg.refreshToken ||  // refresh_token 变了
      currentCfg.clientId !== cfg.clientId ||            // clientId 变了
      currentCfg.tenantId !== cfg.tenantId               // tenantId 变了
    ) {
      // 存储中的凭据已经不是发起刷新时的了 → 用户重新授权过
      // 本次刷新结果是"旧账号的"，不能写入，直接丢弃
      throw new Error('OneDrive: stale refresh discarded');
    }

    // 凭据没变，安全写入
    await this.privateCfg.setComplete({ ...currentCfg, ... });
    return tokenData.access_token;
  } finally {
    this._tokenRefreshInFlightPromise = null;
  }
})();
```

```
时间线（有三重校验）：
  t0  请求A 开始用 refresh_token_v1 刷新
  t2  用户切换账号，存储变为 refresh_token_v2
  t3  请求A 刷新完成，准备写入前重新读取存储
  t4  发现 currentCfg.refreshToken = v2 ≠ cfg.refreshToken = v1
      → 抛出 "stale refresh discarded"，不写入存储 ✓
      → 用户的新凭据（v2）安全保留
```

注意：这里故意抛 `Error` 而不是 `MissingRefreshTokenAPIError`。因为 `MissingRefreshTokenAPIError` 在 401 重试路径中会触发 `clearAuthCredentials()`——那又会把用户的新凭据清掉。

**竞态 3：清除时的 TOCTOU（\_clearIfConfigMatches）**

还有一个场景：不是用户切换账号，而是旧的 refresh_token 被 Microsoft 撤销了（比如用户在 Microsoft 账号设置里改了密码）。

```
时间线（无守卫）：
  t0  请求A 用 refresh_token_v1 去刷新 → Microsoft 返回 400 invalid_grant
      → 说明 refresh_token_v1 已被撤销，代码调用 clearAuthCredentials() 清除存储
  t1  用户在 UI 上重新走 PKCE 授权流程，拿到新的 refresh_token_v2 写入存储
  t2  请求B 的 401 重试也触发了刷新（用的还是发起时快照的 refresh_token_v1）
      → Microsoft 返回 400 invalid_grant
      → clearAuthCredentials() 把存储中的 refresh_token_v2 也清掉了！
```

这就是经典的 **TOCTOU（Time-of-Check to Time-of-Use）**：请求B 在 t0 检查时拿的是旧的凭据快照（v1），但在 t2 执行清除时存储中已经是新凭据（v2）了。

解决方案——`_clearIfConfigMatches`（`onedrive.ts:124-133`）：

```typescript
private async _clearIfConfigMatches(cfg: Partial<OneDrivePrivateCfg>): Promise<void> {
  // ★ 清除前重新读取存储，对比是不是同一批凭据
  const currentCfg = await this.privateCfg.load();
  if (
    currentCfg?.refreshToken === cfg.refreshToken &&  // 存储中的 = 请求时的
    currentCfg.clientId === cfg.clientId &&
    currentCfg.tenantId === cfg.tenantId
  ) {
    await this.clearAuthCredentials();
  }
  // 如果不一致，说明用户已重新授权，静默跳过
}
```

```
时间线（有守卫）：
  t0  请求A 的 clearIfConfigMatches({refreshToken: v1})
      → 存储中是 v1 == v1 → 清除 ✓（正确，v1 确实失效了）
  t1  用户重新授权，存储变为 refresh_token_v2
  t2  请求B 的 clearIfConfigMatches({refreshToken: v1})
      → 存储中是 v2 ≠ v1 → 跳过清除 ✓（保护了新凭据）
```

**三个竞态的关系总结：**

```
竞态 1（重复刷新）
  │  4 个请求同时 401，每个都去刷新 → 解决：singleflight
  │
  ├─→ 竞态 2（凭据回退）
  │    singleflight 的 Promise 等待期间，用户切换了账号
  │    → 刷新完成后写入旧凭据 → 解决：写入前重新读取 + 三重校验
  │
  └─→ 竞态 3（清除 TOCTOU）
       用户重新授权后，旧请求的错误处理清掉了新凭据
       → 解决：_clearIfConfigMatches 守卫
```

竞态 1 是入口问题，2 和 3 是在修 1 的过程中逐步暴露的。整个方案经历了 5 轮 review 才收敛。

#### 面试追问准备

| 问题                                                       | 回答                                                                                                                                                                                                                   |
| ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 为什么选 PKCE 而不是隐式授权？                             | 隐式授权 token 在 URL fragment 中暴露，且不支持 refresh_token；PKCE 更安全且能长期维持会话                                                                                                                             |
| state 参数是干什么的？                                     | CSRF 防护。攻击者诱导用户点击恶意链接完成授权，state 绑定了请求和回调，一次性使用，10 分钟过期                                                                                                                         |
| 单次同步不是顺序的吗，怎么会有并发？                       | 单次同步周期确实是顺序的（getFileRev → download → upload），但分页循环、upload 失败后的 re-download、用户快速触发多次同步等场景可能产生并发。maxConcurrentRequests=4 是 provider 的能力声明，singleflight 是防御性设计 |
| singleflight 有超时吗？                                    | 没有显式超时，依赖 HTTP 层的连接超时。如果 token 端点长时间无响应，所有等待的请求都会卡住。这是可以改进的点                                                                                                            |
| 竞态 2 为什么抛 Error 而不是 MissingRefreshTokenAPIError？ | 因为 401 重试路径对 MissingRefreshTokenAPIError 会调 clearAuthCredentials()，那又会把用户的新凭据清掉                                                                                                                  |
| \_clearIfConfigMatches 为什么要对比三个字段？              | 只对比 refreshToken 不够——用户可能换了 Azure AD 应用（clientId 变了）或租户（tenantId 变了），这三种变化都意味着"凭据已更新"                                                                                           |

---

### 2.2 基于文件的同步与冲突处理

#### 背景

Super Productivity 的同步架构是**操作日志（Operation Log）**模式：用户的每次操作（创建任务、完成任务、修改标题等）生成一条 Operation 记录，这些记录追加写入 `sync-data.json`，同步到云端。其他设备拉取后按序重放。

OneDrive 只需作为这个文件的存储后端——不需要理解操作日志的语义。

#### FileSyncProvider 接口

```typescript
interface FileSyncProvider {
  getFileRev(path): Promise<{ rev }>; // 获取文件版本标识
  downloadFile(path): Promise<{ rev; dataStr }>; // 下载文件
  uploadFile(path, data, rev, force): Promise<{ rev }>; // 上传文件（带版本校验）
  removeFile(path): Promise<void>; // 删除文件
  listFiles?(dirPath): Promise<string[]>; // 列出目录（用于操作日志分片）
}
```

OneDrive 实现了这个接口，复用了项目已有的冲突解决、加密、压缩逻辑。新增一个同步后端只需实现这 5 个方法。

#### ETag 乐观锁

Microsoft Graph API 为每个文件返回 `eTag`（类似版本号）。上传时通过 `If-Match` 头做条件写入：

```typescript
// onedrive.ts:219-220
if (!isForceOverwrite && revToMatch) {
  headers.set('If-Match', revToMatch); // 只有版本匹配才允许写入
}
```

如果文件已被其他设备修改，eTag 不匹配，Graph API 返回 412 Precondition Failed，代码抛出 `UploadRevToMatchMismatchAPIError`，同步引擎会重新拉取最新版本再重试。

**为什么用 ETag 而不是加锁？**

- OneDrive 是分布式存储，没有跨设备锁机制
- ETag 是 HTTP 标准的乐观并发控制，适合"读-改-写"模式
- 不阻塞其他设备的写入，冲突时才报错

#### 首次上传的 Create-Only 语义

这是 review 中发现的一个数据安全问题：

```typescript
// onedrive.ts:221-226
} else if (!isForceOverwrite && !revToMatch) {
  // revToMatch === null 表示首次上传
  // 用 conflictBehavior=fail 防止覆盖已有文件
  uploadPath += '?@microsoft.graph.conflictBehavior=fail';
}
```

**场景：** 两台设备同时初始化同步。设备 A 和设备 B 都认为 `sync-data.json` 不存在（`revToMatch === null`），都执行首次上传。如果不加 `conflictBehavior=fail`，后上传的会覆盖先上传的，导致数据丢失。

**review 过程中的曲折：** 最初用 `If-None-Match: *` 头，但 Microsoft Graph 的小文件上传端点不支持这个头。转而用 `@microsoft.graph.conflictBehavior=fail` 查询参数，这是 Graph API 文档中记录的正确方式。

#### 文件夹创建的冲突处理

```typescript
// onedrive.ts:399-407
await this._request({
  method: 'POST',
  path: createPath,
  body: JSON.stringify({
    name: segment,
    folder: {},
    '@microsoft.graph.conflictBehavior': 'fail', // 不是 'replace'！
  }),
});
```

review 中发现原始代码用的是 `conflictBehavior: 'replace'`——如果同名文件已存在，Graph API 会用空文件夹替换它（数据丢失）。改为 `'fail'`，遇到 409 `nameAlreadyExists` 时跳过继续。

#### Graph Host 白名单

```typescript
// onedrive.ts:60-66
const ONEDRIVE_GRAPH_HOSTS: ReadonlySet<string> = new Set([
  'graph.microsoft.com',
  'graph.microsoft.us',
  'dod-graph.microsoft.us',
  'microsoftgraph.chinacloudapi.cn',
  'graph.microsoft.de',
]);
```

`_request` 方法接受绝对 URL（用于 `@odata.nextLink` 分页），但请求携带用户的 Bearer token。如果不做 host 校验，被篡改的 nextLink 可以把 token 发送到攻击者控制的服务器。

#### 面试追问准备

| 问题                                      | 回答                                                                                                                                         |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| 乐观锁和悲观锁的区别？适用场景？          | 悲观锁先加锁再操作，适合冲突频繁的场景；乐观锁不加锁，提交时检测冲突，适合冲突少、读多写少的场景。文件同步冲突概率低，用 ETag 乐观锁更合适   |
| 如果两个设备同时修改了文件怎么办？        | ETag 不匹配 → 412 → 同步引擎拉取最新版本 → 重新合并操作日志 → 重试上传。操作日志的冲突解决是"同实体 LWW，不同实体都保留"                     |
| 为什么用 App Folder 而不是整个 OneDrive？ | 最小权限原则。`Files.ReadWrite.AppFolder` 只能访问应用自己的目录，用户其他文件不受影响，也避免了误操作风险                                   |
| 分页列表的上限怎么定的？                  | `ONEDRIVE_MAX_LIST_PAGES = 500`，每页约 200 条，上限 10 万个操作日志文件。正常用户的操作日志不会超过这个量级，这个上限是防止无限循环的安全阀 |

---

## 三、8 轮 Review 的关键发现（按类别）

### 安全类

| 问题                                                                         | 后果                        | 修复                                      |
| ---------------------------------------------------------------------------- | --------------------------- | ----------------------------------------- |
| Electron deep-link 日志中打印了完整的 OAuth callback URL（含 code 和 state） | 授权码泄露                  | 日志脱敏，只打印 path 不打印 query        |
| Token 端点错误响应中包含 code_verifier、code、refresh_token                  | 凭据泄露到日志              | `_redactSensitiveFields()` 对敏感字段标红 |
| `_parseOAuthCallback` 对非 OneDrive provider 缺少 state 校验                 | 任意进程可伪造 Dropbox 回调 | 所有 provider 都校验 state                |
| Web 构建使用 nativeclient redirect URI                                       | 浏览器端 OAuth 失败         | Electron 和 Web 使用不同 redirect URI     |

### 并发类

| 问题                                           | 后果                                         | 修复                                           |
| ---------------------------------------------- | -------------------------------------------- | ---------------------------------------------- |
| `_is401Retry` 是实例级布尔值                   | 4 个并发请求中只有第一个会重试，其余直接失败 | 改为函数参数 `isRetry`（per-call 状态）        |
| `clearAuthCredentials()` 与 in-flight 刷新竞态 | 刚刷新的 token 被清除                        | `_clearIfConfigMatches` 守卫                   |
| 刷新完成时直接写入，不检查凭据是否已变         | 旧凭据覆盖新凭据                             | 三重校验（refreshToken + clientId + tenantId） |

### 数据安全类

| 问题                                       | 后果                     | 修复                                     |
| ------------------------------------------ | ------------------------ | ---------------------------------------- |
| 文件夹创建用 `conflictBehavior: 'replace'` | 同名文件被替换为空文件夹 | 改为 `'fail'`，409 时跳过                |
| 首次上传无 create-only 语义                | 两设备同时初始化互相覆盖 | `@microsoft.graph.conflictBehavior=fail` |

---

## 四、面试场景模拟

### 场景 1："这个项目有什么难点？"

> 最大的难点是 **token 刷新的并发安全**。单次同步周期内操作是顺序的（getFileRev → download → upload），但实际中有多个并发源：分页循环、上传失败后的 re-download、用户快速触发多次同步。这些请求共享同一个 access_token，如果 token 过期，多个请求可能同时触发刷新——这看起来是一个问题，实际上是三个互相纠缠的竞态。
>
> **第一个**是重复刷新：多个请求同时 401，每个都去 Microsoft 换 token，后完成的覆盖先完成的。用 singleflight 解决——第一个请求发起刷新，其余复用它的 Promise。这是防御性设计，正常路径可能只触发一次刷新，但保证了并发场景的正确性。
>
> 但 singleflight 不够。**第二个**是凭据回退：singleflight 的等待期间，用户在 UI 上切换了同步账户，新凭据写入了存储。但旧的刷新请求完成后直接写入结果，把新凭据覆盖了。解决方法是刷新完成后重新读取存储，对比 refreshToken、clientId、tenantId，不一致就丢弃刷新结果。而且这里故意抛普通 Error 而不是 MissingRefreshTokenAPIError，因为后者会触发清除逻辑把新凭据也清掉。
>
> **第三个**是清除时的 TOCTOU：旧请求的 refresh_token 被 Microsoft 撤销了，刷新失败后要清除凭据。但清除时存储中可能已经是用户重新授权的新凭据了。所以清除前也要重新读取存储做对比，只有凭据一致才清除。
>
> 这三个问题经历了 5 轮 review 才收敛，因为每修一个都会暴露下一个竞态窗口。核心思路就是：任何"读取→异步操作→写回"的流程，写回前都要重新读取确认没变过。

### 场景 2："说说你解决的一个数据一致性问题"

> 两台设备同时初始化同步时，都认为文件不存在，都会执行首次上传。后上传的会覆盖先上传的，导致数据丢失。
>
> 我们需要的是 create-only 语义：只在文件不存在时创建，已存在就报错。
>
> 最初尝试用 HTTP 的 `If-None-Match: *` 头，但 Microsoft Graph 的小文件上传端点不支持这个头。查阅文档后发现可以用 `@microsoft.graph.conflictBehavior=fail` 查询参数，效果等价。
>
> 文件夹创建也有类似问题——原始代码用 `conflictBehavior: 'replace'`，如果同名文件已存在会被替换为空文件夹。改为 `'fail'` 后遇到 409 跳过即可。

### 场景 3："你对安全有什么理解？"

> 这个项目让我对安全有了实际认识。几个例子：
>
> 1. **凭据不能出现在日志里**。Electron 的 protocol handler 会打印完整 URL，但 OAuth callback URL 里有 code 和 state——授权码虽然短期有效，但仍然是凭据。我们做了日志脱敏，只打印 path。
> 2. **CSRF 防护**。OAuth 授权用 state 参数绑定请求和回调，服务端验证 state 存在且匹配后立即删除（一次性使用），10 分钟过期。
> 3. **Bearer token 的发送范围**。`_request` 方法接受绝对 URL（用于 Graph API 分页），但必须校验目标 host 在白名单内，防止被篡改的 nextLink 把 token 泄露到第三方服务器。
> 4. **最小权限**。用 `Files.ReadWrite.AppFolder` scope 而不是整个 OneDrive 的读写权限。

---

## 五、技术名词速查

| 名词                    | 一句话解释                                                                     |
| ----------------------- | ------------------------------------------------------------------------------ |
| PKCE                    | OAuth 扩展，用 code_verifier/code_challenge 替代 client_secret，适合公开客户端 |
| ETag                    | HTTP 资源的版本标识，用于条件请求（If-Match / If-None-Match）                  |
| Singleflight            | 同一时刻只有一个请求执行，其他请求复用其结果                                   |
| Bearer Token            | HTTP 认证方案，`Authorization: Bearer <token>`，持有即代表身份                 |
| Microsoft Graph         | Microsoft 365 统一 API，OneDrive 文件操作通过 `/me/drive/` 端点                |
| App Folder              | OneDrive 的应用隔离目录，scope 为 `Files.ReadWrite.AppFolder`                  |
| 412 Precondition Failed | 条件请求失败（ETag 不匹配），乐观锁冲突的信号                                  |
| 409 Conflict            | 资源冲突（如 `conflictBehavior=fail` 时文件已存在）                            |
| TOCTOU                  | Time-of-check to time-of-use，检查和使用之间的竞态窗口                         |
| PKCE code_verifier      | 43-128 字符的随机串，base64url 编码，只在换 token 时发送给服务端               |
