# OneDrive Sync — Implementation Summary

## 1. 整体架构

### 1.1 OneDrive 在同步框架中的位置

Super Productivity 的同步系统分两层，通过适配器模式桥接：

```
┌────────────────────────────────────────────────────────┐
│                   SyncWrapperService                    │  ← 统一入口
├────────────────────────────────────────────────────────┤
│           SyncTriggerService                           │  ← 多源触发
│  (鼠标/空闲/Electron/在线/可见性/定时器)                 │
├────────────────────────────────────────────────────────┤
│              WrappedProviderService                     │  ← 适配桥接
│  ┌──────────────────────────────────────────────────┐  │
│  │  OperationSyncCapable  ←  统一操作同步接口        │  │
│  │  ├─ SuperSync (原生)                              │  │
│  │  └─ FileBasedSyncAdapterService  ← 适配层        │  │
│  │       ├─ FileSyncProvider (Dropbox/WebDAV)        │  │
│  │       ├─ FileSyncProvider (Nextcloud)             │  │
│  │       ├─ FileSyncProvider (LocalFile)             │  │
│  │       └─ FileSyncProvider (OneDrive) ← NEW        │  │
│  └──────────────────────────────────────────────────┘  │
└────────────────────────────────────────────────────────┘
```

`OneDrive` 类实现了 `FileSyncProvider` 接口（5 个方法，其中 `listFiles` 为可选），被 `FileBasedSyncAdapterService.createAdapter()` 包装为 `OperationSyncCapable`，从而参与统一的 op-log 同步系统。作为 `FILE_BASED_PROVIDER_IDS` 成员，天然继承所有现有基础设施：

- 操作捕获 → Operation Capture Meta-Reducer (16 个 meta-reducer, 8 阶段)
- 冲突解决 → LWW + 向量时钟比较（entity-level）
- 加密 → AES-GCM 对称加密（可选）
- 备份/恢复 → 自动备份到本地

### 1.2 关键文件

```
src/app/
├── op-log/
│   ├── sync-providers/
│   │   ├── file-based/
│   │   │   ├── file-based-sync-adapter.service.ts  (1017 行) 适配层核心
│   │   │   ├── file-based-sync.types.ts             FileBasedSyncData 类型
│   │   │   └── onedrive/
│   │   │       ├── onedrive.ts          (668 行) ★ 核心 (class OneDrive)
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

**触发机制** (SyncTriggerService) 多源 merge，经过 debounce(100ms) + auditTime(syncInterval):

| 触发源          | 事件                                            | 说明                                                          |
| --------------- | ----------------------------------------------- | ------------------------------------------------------------- |
| 鼠标/触摸       | `mousemove` after idle / `touchstart` / `focus` | 用户恢复活动（鼠标 idle 后 1min 节流，触摸/focus 15min 节流） |
| 空闲            | `isIdle$` → true                                | 用户离开时触发一次                                            |
| Electron 恢复   | `ipcResume$`                                    | 从睡眠唤醒                                                    |
| Electron 休眠前 | `ipcSuspend$`                                   | 睡前最后一次同步                                              |
| 恢复在线        | `isOnline$` → true                              | 网络恢复                                                      |
| 页面隐藏        | `visibilitychange` → hidden                     | 切标签页/关闭前                                               |
| 定时器          | `timer(syncInterval)`                           | 仅 file-based provider，检测外部文件变更                      |
| Android         | `onResume$`, `onPause$`, 后台定时器             | 移动端专用                                                    |

**同步执行流程** (SyncWrapperService.\_sync()):

```
用户操作 (创建/更新/删除任务)
    │
    ▼
NgRx Action dispatch
    │
    ▼
Operation Capture Meta-Reducer (16 个 meta-reducer, 8 阶段)
    │
    ▼
OperationLogService.appendToLog() → 写入 IndexedDB (clientId + vectorClock)
    │
    ▼
SyncTriggerService (多源触发，见上表) / 手动触发
    │
    ▼
SyncWrapperService.sync() → _sync()
    ├── WrappedProviderService.getOperationSyncCapable(provider)
    │   └── FileBasedSyncAdapterService.createAdapter(OneDrive, ...)
    │       → 返回 OperationSyncCapable (支持 downloadOps / uploadOps)
    │
    ├── ① OperationLogSyncService.downloadRemoteOps()
    │   └── adapter.downloadOps(sinceSeq, ...)
    │       └── _downloadOps() → provider.downloadFile("sync-data.json")
    │           → 解析 → 缓存 → gap检测 → 过滤已应用 ops → 应用远程变更
    │
    ├── ② OperationLogSyncService.uploadPendingOps()
    │   └── adapter.uploadOps(localOps, ...)
    │       └── _uploadOps() → 构建合并数据 → provider.uploadFile(...)
    │           └── _uploadWithMismatchFallback()
    │               ├── rev 不匹配 → 重新下载
    │               ├── rev 变化 → 合并后重试 (最多 2 次)
    │               └── rev 未变 → 强制覆盖上传
    │
    └── ③ LWW 重上传 (最多 3 次)
        └── 本地胜出的 LWW 操作 → uploadPendingOps() → 循环直到无剩余
              │
              ▼
         Microsoft Graph API
    PUT /me/drive/special/approot:/Super Productivity/sync-data.json:/content
    Headers: If-Match: "expected-etag"
```

### 2.2 sync-data.json 结构

参考 `FileBasedSyncData` 接口 (`file-based-sync.types.ts`):

```typescript
interface FileBasedSyncData {
  version: 2; // 文件格式版本号 (字面量 2)
  syncVersion: number; // 基于内容的乐观锁计数器
  schemaVersion: number; // 应用数据 schema 版本
  vectorClock: VectorClock; // 所有操作后的因果时钟
  lastModified: number; // 最后成功同步时间戳 (epoch ms)
  clientId: string; // 最后修改此文件的客户端 ID
  state: unknown; // 完整应用状态快照 (AppDataComplete)
  archiveYoung?: ArchiveModel; // ≤21 天归档 (数据仍可能修改)
  archiveOld?: ArchiveModel; // >21 天归档 (惰性数据)
  recentOps: SyncFileCompactOp[]; // 最近 500 条压缩操作 (用于冲突检测)
  oldestOpSyncVersion?: number; // recentOps 中最老操作的 sv，用于 partial-trimming gap 检测
}
```

实际 JSON 示例:

```json
{
  "version": 2,
  "syncVersion": 42,
  "schemaVersion": 2,
  "vectorClock": { "client-a": 15, "client-b": 8 },
  "lastModified": 1701700000000,
  "clientId": "uuid-client-a",
  "state": {
    /* 完整 NgRx State - AppDataComplete */
  },
  "recentOps": [
    /* 最近 500 条 SyncFileCompactOp (CompactOperation & { sv?: number }) */
  ],
  "archiveYoung": {
    /* 归档任务 */
  },
  "archiveOld": {
    /* 老归档 */
  },
  "oldestOpSyncVersion": 35
}
```

`syncVersion` 实现基于内容的乐观锁 —— 每次上传前检查远程计数器是否匹配预期值，不依赖服务端 ETag。同时利用 provider 的 ETag/rev 做传输层辅助校验（`If-Match` 头），双重保护防止并发覆盖。

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
- 过期 state 按需清理（`_pruneExpiredOAuthStates()` 在添加/验证 state 时触发，不再用 setInterval 轮询）

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
- Token 通过 Electron `safeStorage` / Web `sessionStorage` 加密持久化，应用重启后无需重新授权（除非 refresh_token 已过期）

---

## 5. 文件操作实现

### 5.1 FileSyncProvider 接口

| 方法           | 签名                                                   | OneDrive 实现                                                    |
| -------------- | ------------------------------------------------------ | ---------------------------------------------------------------- |
| `getFileRev`   | `(targetPath, localRev)`                               | `GET /drive/...:/path` → 返回 ETag                               |
| `downloadFile` | `(targetPath)` → `{ rev, dataStr }`                    | `GET /drive/...:/path:/content` → 从 Header 取 ETag，Body 取数据 |
| `uploadFile`   | `(targetPath, dataStr, revToMatch, isForceOverwrite?)` | `PUT /drive/...:/path:/content` + `If-Match: rev`                |
| `removeFile`   | `(targetPath)`                                         | `DELETE /drive/...:/path`                                        |
| `listFiles?`   | `(targetPath)` → `string[]`                            | `GET /drive/.../children`（可选方法）                            |

### 5.2 下载优化：单次 API 调用 + 同步周期缓存

```
GET /me/drive/special/approot:/Super Productivity/sync-data.json
Headers: Accept: application/json

← Headers: ETag: "abc123"
← Body: { ... sync-data.json content ... }

一次请求同时拿到 ETag + 数据体，无需先 HEAD 再 GET。

`FileBasedSyncAdapterService` 在同步周期内缓存下载结果（TTL 30s），避免 `_uploadOps` 和 `_downloadOps` 各下载一次导致重复 API 调用。

### 5.3 上传冲突保护

双层乐观锁机制：
1. **内容层**：`FileBasedSyncAdapterService._uploadOps()` 比较 `syncVersion` 计数器（当前值 vs 预期值），`_buildMergedSyncData()` 递增 `syncVersion`
2. **传输层**：OneDrive 使用 ETag + `If-Match` 头

```

PUT /me/drive/special/approot:/Super Productivity/sync-data.json:/content
Headers: If-Match: "expected-etag"

→ 412 Precondition Failed ← 远程已被其他设备更新
→ 重新 downloadFile → 比较 ETag/rev
├── ETag 变了 → 真正的并发上传，抛出异常，下次同步周期重新合并
└── ETag 未变 → 服务端 ETag 时间戳不一致，强制覆盖上传 (isForceOverwrite=true)
→ 201 Created / 200 OK ← 成功

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
│ ○ None ○ SuperSync ○ Dropbox │
│ ○ WebDAV ○ LocalFile ○ Nextcloud │
│ ● OneDrive │
├────────────────────────────────────────────┤
│ [OneDrive 配置] │
│ │
│ □ Use custom Azure AD app │
│ (不勾选则用官方 Client ID，如果可用) │
│ │
│ Client ID: [________________] │
│ Tenant ID: [common] │
│ Sync Folder Path: [Super Productivity] │
│ │
│ [Authorize] 按钮 → 启动 PKCE OAuth 流程 │
│ │
│ ⚫ 已授权 / ⚪ 需要授权 / 🔒 已加密 │
└────────────────────────────────────────────┘

````

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
| Token 过期 | 401       | 清除 credential → 抛出 `AuthFailSPError`，需用户重新授权 |
| 权限不足   | 403       | 清除 credential（`InvalidAuthenticationToken`）→ 抛出 `AuthFailSPError` |
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

## 8. 并发控制机制

OneDrive 同步在一个多层并发保护下运行。以下机制是经过 9 轮 code review 逐一验证的核心安全网。

### 8.1 并发控制全景

```
┌─────────────────────────────────────────────────┐
│ 1. Token 刷新层    → 单飞锁                      │
│ 2. 文件传输层      → ETag + If-Match (HTTP 412)  │
│ 3. 内容同步层      → syncVersion 乐观锁           │
│ 4. 首次创建层      → conflictBehavior=fail        │
│ 5. 配置保存层      → _lastSettings 去重 + 条件展开 │
│ 6. 凭证管理层      → 三重身份匹配                  │
│ 7. 同步周期层      → _isSyncing 全局锁            │
└─────────────────────────────────────────────────┘
```

### 8.2 Token 单飞锁

防止并发 API 调用同时刷新 token（第二个调用会用已失效的 refresh_token）。

```typescript
private _isRefreshingToken = false;

async _refreshAccessTokenIfNeeded(): Promise<void> {
  if (this._isRefreshingToken) {
    while (this._isRefreshingToken) {
      await new Promise(r => setTimeout(r, 50));
    }
    return;
  }
  this._isRefreshingToken = true;
  try {
    // ... 调用 POST /token，更新内存中的 token
  } finally {
    this._isRefreshingToken = false;
  }
}
```

### 8.3 上传冲突处理（双层乐观锁）

**第一层 — 内容层 syncVersion**: `FileBasedSyncAdapterService._uploadOps()` 比较本地预期 syncVersion 和远端实际 syncVersion。不匹配则拒绝。

**第二层 — 传输层 ETag**: OneDrive 使用 HTTP `If-Match` 头。412 响应表示远端已被其他设备更新。

412 后的处理 (`_uploadWithMismatchFallback`):
1. 重新下载最新的 sync-data.json
2. 比较 ETag：变了 → 合并后重试（最多 2 次）；没变 → 服务端时钟偏差，强制覆盖
3. 重试仍失败 → 抛出异常，下次同步周期再处理

### 8.4 首次创建保护 (`conflictBehavior=fail`)

双设备同时初始化同步时，两者的第一次上传都期望文件不存在。使用 `conflictBehavior=fail` 让第二个上传失败：

```
设备 A PUT (rev='', conflict=fail) → 201 Created
设备 B PUT (rev='', conflict=fail) → 409 Conflict → 下次同步周期重新下载
```

这是 reviewer 在 R3 轮发现的关键问题。"创建"和"更新"语义不同——创建时文件已存在说明另一台设备抢先了，必须显式感知冲突，而非静默覆盖。

### 8.5 配置保存去重 + 条件展开

Formly 对一次用户操作可能触发多次 `modelChange`。`updateSettingsFromForm()` 用 `_lastSettings` 的 JSON 比较过滤重复。配合条件展开（防止 `?? false` 覆盖已有的 true 值，详见 [review 经验教训](./review-lessons-learned.md#问题-4--false-对可选布尔值的破坏)），确保每次保存不会把未设置的字段变成 false。

### 8.6 凭证身份变更检测

OAuth token 绑定到 `(useCustomApp, clientId, tenantId)` 三元组。切换 Azure AD 应用时需原子性清除旧 token（详见 [review 经验教训](./review-lessons-learned.md#问题-6-切换-azure-ad-应用身份时旧-token-未清除)）。

---

## 9. 测试覆盖

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

## 10. 设计决策

### 10.1 为什么复用 FileSyncProvider 和适配器模式而非新建接口

- `FileBasedSyncAdapterService.createAdapter()` 将任意 `FileSyncProvider` 包装为 `OperationSyncCapable`，使文件存储提供者能参与统一的 op-log 同步系统
- WebDAV / Dropbox / Nextcloud 已经有成熟的 file-based sync 模式
- `FileBasedSyncData` (sync-data.json) 模式简单可靠，经过多年验证
- 避免引入新的同步协议，降低维护成本
- `WrappedProviderService` 作统一桥接：SuperSync 原生支持 op sync，file-based 通过 adapter 适配

### 10.2 为什么 PKCE 而非 Client Secret

- Electron 应用无法安全存储 client_secret（可反编译）
- PKCE 是 OAuth 2.1 推荐方式
- Microsoft 要求 SPA/本地应用使用 PKCE

### 10.3 为什么双重乐观锁（syncVersion + ETag）

- **内容层**：`syncVersion` 计数器内嵌在 `FileBasedSyncData` 中，不依赖服务端特性，跨所有 file-based provider 统一工作
- **传输层**：ETag + `If-Match` 头提供即时版本不匹配检测（HTTP 412），避免无效上传消耗带宽
- 时间戳有精度和时钟偏差问题，不适合做乐观锁
- 双重机制互补：syncVersion 处理跨 provider 一致性，ETag 处理传输层并发

---

## 11. 已知限制

1. **无官方 Client ID**：每个用户需自建 Azure AD 应用
2. **移动端未测**：iOS/Android WebView 的 OAuth 回调未验证
3. **单文件同步**：所有数据在 1 个 JSON 文件中，大文件效率低
4. **无即时推送**：基于多源触发的勤同步（非 WebSocket push），非 file-based provider 场景无定时器轮询

---

## 12. 相关资源

- [Microsoft Graph API - Drive](https://learn.microsoft.com/en-us/graph/api/resources/drive)
- [Microsoft Identity - PKCE](https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-auth-code-flow)
- [OAuth 2.1 草案](https://datatracker.ietf.org/doc/draft-ietf-oauth-v2-1/)
- [Super Productivity Sync Architecture](../docs/sync-and-op-log/)
- [PR Review Lessons Learned](./review-lessons-learned.md) — 9 轮 review 中踩过的坑和总结```
````
