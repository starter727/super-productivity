# OneDrive Sync — Implementation Summary

## 1. 整体架构

### 1.1 OneDrive 在同步框架中的位置

Super Productivity 的同步系统分两层：

```
┌──────────────────────────────────────────────────┐
│                 SyncWrapperService                │  ← 统一入口，触发同步
├──────────────────────────────────────────────────┤
│  Operation Sync (SuperSync)  │  File Sync (网盘)  │
│  provider.supportsOpSync=true │  FileSyncProvider  │
│  实时差量同步                  │  sync-data.json    │
├──────────────────────────────┼──────────────────┤
│        SuperSync Server       │  Dropbox/WebDAV  │
│                               │  Nextcloud       │
│                               │  OneDrive ← NEW  │
└──────────────────────────────┴──────────────────┘
```

OneDrive 实现了 `FileSyncProvider` 接口（5 个方法），被分类为 `FILE_BASED_PROVIDER_IDS` 成员，天然继承所有现有基础设施：

- 操作捕获 → Operation Capture Meta-Reducer
- 冲突解决 → LWW + 向量时钟比较
- 加密 → AES-GCM 对称加密（可选）
- 备份/恢复 → 自动备份到本地

### 1.2 关键文件

```
src/app/
├── op-log/
│   ├── sync-providers/
│   │   ├── file-based/
│   │   │   └── onedrive/
│   │   │       ├── onedrive.ts          (668 行) ★ 核心
│   │   │       ├── onedrive.model.ts     (29 行)  类型
│   │   │       └── onedrive.spec.ts      (260 行) 测试
│   │   ├── provider.const.ts            +OneDrive 枚举
│   │   ├── provider.interface.ts         FileSyncProvider 接口
│   │   └── sync-providers.factory.ts    +OneDrive 工厂
│   └── sync/
│       ├── operation-sync.util.ts        FILE_BASED_PROVIDER_IDS
│       └── conflict-resolution.service.ts
├── imex/sync/
│   ├── sync-config.service.ts           配置管理
│   ├── sync.model.ts                    +OneDrive providerId
│   ├── onedrive-auth-mode.const.ts       官方 Client ID 加载
│   ├── oauth-callback-handler.service.ts OAuth 回调处理
│   └── dialog-get-and-enter-auth-code.component.ts 授权码输入
├── features/config/
│   ├── form-cfgs/sync-form.const.ts      OneDrive 表单配置
│   └── global-config.model.ts           SyncProviderId.OneDrive
└── pages/config-page/
    └── config-page.component.ts          syncStatus 信号
```

---

## 2. 数据流

### 2.1 同步完整流程

```
用户操作 (创建/更新/删除任务)
    │
    ▼
NgRx Action dispatch
    │
    ▼
Operation Capture Meta-Reducer  ← 拦截所有 action，生成 Operation
    │
    ▼
OperationLogService.appendToLog()  → 写入 IndexedDB (clientId + vectorClock)
    │
    ▼
SyncTriggerService 轮询 / 手动触发
    │
    ▼
FileSyncService.sync()
    ├── ① downloadFile("sync-data.json")  → 获取远程状态
    ├── ② 比较 syncVersion (乐观锁)
    ├── ③ ConflictResolutionService      → LWW 冲突解决
    ├── ④ OperationApplierService         → 应用远程变更
    └── ⑤ uploadFile("sync-data.json")    → 上传合并后状态
              │
              ▼
         Microsoft Graph API
    PUT /me/drive/special/approot:/Super Productivity/sync-data.json
```

### 2.2 sync-data.json 结构

```json
{
  "version": "1.0",
  "syncVersion": 42,
  "schemaVersion": 2,
  "vectorClock": { "client-a": 15, "client-b": 8 },
  "lastModified": 1701700000000,
  "clientId": "uuid-client-a",
  "state": {
    /* 完整 NgRx State */
  },
  "recentOps": [
    /* 最近 500 条 Operation */
  ],
  "archiveYoung": {
    /* 归档任务 */
  },
  "archiveOld": {
    /* 老归档 */
  },
  "oldestOpSyncVersion": 0
}
```

`syncVersion` 实现乐观锁 —— 每次上传前检查远程是否更新，防止并发覆盖。

---

## 3. PKCE OAuth 认证流程

### 3.1 为什么选 PKCE

- 客户端是 Electron/WebView，无法安全存储 client_secret
- PKCE 用 `code_verifier → code_challenge` 机制防止授权码拦截攻击
- 符合 Microsoft Identity Platform 最佳实践

### 3.2 OAuth 流程

```
┌──────────┐     ┌─────────────┐     ┌──────────────┐
│   App    │     │   Browser   │     │   Microsoft   │
└────┬─────┘     └──────┬──────┘     └──────┬───────┘
     │                  │                    │
     │ 1. 构造 URL       │                    │
     │ state=random      │                    │
     │ code_challenge=   │                    │
     │   SHA256(verifier)│                    │
     │                  │                    │
     │ 2. 打开浏览器 ────►                    │
     │                  │ 3. GET /authorize  │
     │                  │   ?client_id=...&   │
     │                  │   redirect_uri=...& │
     │                  │   code_challenge=...│
     │                  │   &code_challenge_  │
     │                  │   method=S256       │
     │                  │───────────────────►│
     │                  │                    │ 4. 用户登录+授权
     │                  │ 5. 302 redirect     │
     │                  │◄───────────────────│
     │                  │                    │
     │ 6. 拦截回调 ◄─────┤                    │
     │    提取 code       │                    │
     │    校验 state       │                    │
     │                  │                    │
     │ 7. POST /token ──────────────────────►│
     │    grant_type=authorization_code       │
     │    code=xxx                            │
     │    code_verifier=xxx  ← 验证 PKCE      │
     │◄─────────────────────────────────────│
     │    { access_token, refresh_token }     │
     │                  │                    │
     │ 8. 存储 token     │                    │
     │    (内存，不落盘)  │                    │
```

### 3.3 平台差异

| 平台        | 回调方式                                        | 回退方案 |
| ----------- | ----------------------------------------------- | -------- |
| Electron    | 协议处理器 `superproductivity://oauth?code=...` | 手动粘贴 |
| Web         | 页面重定向                                      | 手动粘贴 |
| iOS/Android | 系统浏览器跳转 (⚠️ 未测)                        | 手动粘贴 |

### 3.4 OAuth State 安全

- 每次发起授权生成随机 `state` 值（`crypto.randomUUID()`）
- 回调时验证 state 匹配，防止 CSRF
- 过期 state 定时清理（`_pruneExpiredOAuthStates()`），不再用 setInterval 轮询

---

## 4. Token 管理

### 4.1 单飞锁（Concurrency Control）

```typescript
private _isRefreshingToken = false;

async _refreshAccessTokenIfNeeded(): Promise<void> {
  if (this._isRefreshingToken) {
    // 已有刷新在进行中，轮询等待而非重复请求
    while (this._isRefreshingToken) {
      await new Promise(r => setTimeout(r, 50));
    }
    return;
  }
  this._isRefreshingToken = true;
  try {
    // ... 实际刷新逻辑
  } finally {
    this._isRefreshingToken = false;
  }
}
```

防止并发刷新导致多把 refresh_token 同时失效。

### 4.2 Token 生命周期

- `access_token` 有效期约 1 小时
- `refresh_token` 有效期 90 天（默认）
- 每次 API 调用前检查 `expiresAt`，提前 5 分钟刷新
- Token 仅存在内存，应用重启后重新授权

---

## 5. 文件操作实现

### 5.1 FileSyncProvider 接口

| 方法                          | OneDrive 实现                                     |
| ----------------------------- | ------------------------------------------------- |
| `getFileRev(path)`            | `GET /drive/...:/path` → 返回 ETag                |
| `downloadFile(path)`          | `GET /drive/...:/path:/content` → `{ rev, data }` |
| `uploadFile(path, data, rev)` | `PUT /drive/...:/path:/content` + `If-Match: rev` |
| `removeFile(path)`            | `DELETE /drive/...:/path`                         |
| `listFiles(path)`             | `GET /drive/.../children`                         |

### 5.2 下载优化：单次 API 调用

```
GET /me/drive/special/approot:/Super Productivity/sync-data.json
Headers: Accept: application/json

← Headers: ETag: "abc123"
← Body: { ... sync-data.json content ... }

一次请求同时拿到 ETag + 数据体，无需先 HEAD 再 GET
```

### 5.3 上传冲突保护

```
PUT /me/drive/special/approot:/Super Productivity/sync-data.json:/content
Headers: If-Match: "expected-etag"

→ 412 Precondition Failed     ← 远程已被其他设备更新
   → 重新 downloadFile → 合并 → 重试 (最多 2 次)
→ 201 Created / 200 OK         ← 成功
```

### 5.4 同步文件夹

- 文件夹名：`Super Productivity`
- 位置：`/me/drive/special/approot`（OneDrive App Root）
- 首次同步时自动创建（`_ensureSyncFolderExists()`）

---

## 6. 配置表单

### 6.1 OneDrive 设置项

```
┌─ Sync Provider ───────────────────────────┐
│ ○ None  ○ SuperSync  ○ Dropbox            │
│ ○ WebDAV  ○ LocalFile  ○ Nextcloud        │
│ ● OneDrive                                 │
├────────────────────────────────────────────┤
│ [OneDrive 配置]                             │
│                                            │
│ □ Use custom Azure AD app                  │
│   (不勾选则用官方 Client ID，如果可用)      │
│                                            │
│ Client ID:   [________________]            │
│ Client Secret: [________________]          │  ← 仅 custom app
│                                            │
│ [Authorize]  按钮 → 启动 OAuth 流程         │
│                                            │
│ ⚫ 已授权 / ⚪ 需要授权 / 🔒 已加密         │
└────────────────────────────────────────────┘
```

### 6.2 官方 Client ID 机制

- 从环境变量 `ONEDRIVE_CLIENT_ID` 加载
- 编译时注入 `onedrive-auth-mode.const.ts`
- `HAS_OFFICIAL_ONEDRIVE_CLIENT_ID = false` 时，所有用户必须用自己的 Azure AD 应用
- 勾选 "Use custom app" 后显示 Client ID 输入框

---

## 7. 错误处理

### 7.1 错误分类

| 错误类型   | HTTP 状态 | 处理策略                         |
| ---------- | --------- | -------------------------------- |
| Token 过期 | 401       | 刷新 token 后重试                |
| 权限不足   | 403       | 抛出 `MissingCredentialsSPError` |
| 文件未找到 | 404       | 首次同步，创建新文件             |
| 版本冲突   | 412       | 重新下载 → 合并 → 重试           |
| 限流       | 429       | `Retry-After` 头等待后重试       |
| 网络错误   | -         | 最多重试 2 次                    |

### 7.2 \_mapAndThrow()

将 Microsoft Graph 错误码映射为 app 内部错误类型：

- `InvalidAuthenticationToken` → token 过期
- `accessDenied` → 权限不足
- `quotaLimitReached` → 空间不足
- `itemNotFound` → 文件不存在

---

## 8. 测试覆盖

### 8.1 单元测试 (onedrive.spec.ts)

- 260 行，覆盖：
  - `getFileRev()` — ETag 获取
  - `downloadFile()` — 下载 + ETag 解析
  - `uploadFile()` — 上传 + 冲突重试
  - `removeFile()` — 删除
  - `listFiles()` — 列表
  - `_exchangeAuthCode()` — PKCE 换 token
  - `_refreshAccessTokenIfNeeded()` — 并发控制

### 8.2 手动集成测试

- ✅ Windows → Linux 桌面端同步
- ✅ OAuth PKCE 完整流程
- ✅ Token 刷新
- ❌ 移动端 (iOS/Android)
- ❌ 多设备并发编辑冲突

---

## 9. 设计决策

### 9.1 为什么复用 FileSyncProvider 而非新建接口

- WebDAV / Dropbox / Nextcloud 已经有成熟的 file-based sync 模式
- sync-data.json 模式简单可靠，经过多年验证
- 避免引入新的同步协议，降低维护成本

### 9.2 为什么 PKCE 而非 Client Secret

- Electron 应用无法安全存储 client_secret（可反编译）
- PKCE 是 OAuth 2.1 推荐方式
- Microsoft 要求 SPA/本地应用使用 PKCE

### 9.3 为什么 ETag 而非时间戳做乐观锁

- ETag 是 Microsoft 推荐方式
- 时间戳有精度和时钟偏差问题
- `If-Match` 头是标准 HTTP 乐观锁机制

---

## 10. 已知限制

1. **无官方 Client ID**：每个用户需自建 Azure AD 应用
2. **移动端未测**：iOS/Android WebView 的 OAuth 回调未验证
3. **Personal Account 限定**：仅支持 `consumers` 端点，不支持组织账户
4. **单文件同步**：所有数据在 1 个 JSON 文件中，大文件效率低
5. **无即时推送**：基于轮询的同步，不支持实时变更通知

---

## 11. 相关资源

- [Microsoft Graph API - Drive](https://learn.microsoft.com/en-us/graph/api/resources/drive)
- [Microsoft Identity - PKCE](https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-auth-code-flow)
- [OAuth 2.1 草案](https://datatracker.ietf.org/doc/draft-ietf-oauth-v2-1/)
- [Super Productivity Sync Architecture](../docs/sync-and-op-log/)
