# Google Calendar 提供者——设计文档

> **状态：已计划**

## 概述

为 Super Productivity 添加一个 Google Calendar 提供者（`GOOGLE_CALENDAR`），通过 Google Calendar REST API 实现双向事件同步。认证采用混合方法：默认使用认证代理，同时提供用户自行提供 OAuth 凭据的选项。

## 决策

| 决策               | 选择                                                      | 理由                                                                          |
| ------------------ | --------------------------------------------------------- | ----------------------------------------------------------------------------- |
| 集成级别           | 双向事件同步（分阶段进行）                                | 完整价值需要写回状态变更                                                      |
| 认证方式           | 混合：默认认证代理 + 用户自提供选项                       | 对大多数用户提供最佳体验；自托管/注重隐私的用户可选择不使用代理               |
| API 层             | Google Calendar REST API v3                               | 文档更完善，比 Google 的 CalDAV 端点更可靠；避免 CalDAV 的 quirks            |
| 初始同步方向       | Google → SP 优先，状态同步回 Google                       | 减少首个版本的范围；暂不实现 SP → Google 的事件创建                           |
| 认证代理托管       | 实施时决定                                                | 代理是无状态的且足够轻薄，可在不同托管选项间迁移                              |
| 令牌存储           | 复用现有 `SyncCredentialStore`（IndexedDB `sup-sync`）    | 来自 Dropbox 同步的已验证模式                                                 |

---

## 为什么 OAuth 是必需的

Google Calendar API 要求 OAuth 2.0。没有替代方案——即使 Google 的 CalDAV 端点也需要 OAuth。这是该功能的核心复杂性所在。

### Google 特定的约束

1. **OOB 流程已弃用（2022 年）**——Dropbox 同步使用的"手动复制此代码"模式对 Google 无效。需要基于重定向的流程。
2. **各平台独立的 OAuth 客户端类型**——Google 为 web、桌面、Android 和 iOS 注册独立的 OAuth 客户端，各自具有不同的重定向机制。
3. **Calendar 作用域为"受限"（restricted）**——需要 Google 的完整应用验证流程（隐私政策、安全评估、演示视频）。未经验证的应用限制为 100 个用户，并显示警告画面。
4. **开源可见性**——任何嵌入源代码中的 `client_secret` 都是公开的。桌面/移动客户端被视为"公共客户端"（使用 PKCE，无需密钥），但 web 客户端传统上需要密钥。
5. **自托管的 web 实例**——不同的源（origin）使得单一注册的重定向 URI 对 web 而言不够用。

---

## 认证架构

### 混合方法

**默认模式（代理）：** 一个无状态的认证代理处理 OAuth 令牌交换，将 `client_secret` 保留在服务端。所有平台使用同一代理。日历数据从不经过代理——只有交换/刷新过程中的 OAuth 令牌。

**自定义模式：** 用户提供自己的 Google Cloud OAuth 凭据。应用直接与 Google 执行 PKCE 流程。适用于自托管实例和注重隐私的用户。

### 认证代理设计

代理有意保持最小化——无状态、无数据库、无会话、无用户账户。

**端点：**

```
POST /auth/google/token-exchange
  输入：{ code, code_verifier, redirect_uri, platform }
  操作：使用 client_secret 将授权码交换为令牌
  输出：{ access_token, refresh_token, expires_in }

POST /auth/google/token-refresh
  输入：{ refresh_token }
  操作：使用 client_secret 刷新访问令牌
  输出：{ access_token, expires_in }
```

**托管选项（待决定）：**

- 路由添加到现有 SuperSync 服务器
- 独立的无服务器函数（Cloudflare Workers、Vercel、AWS Lambda）
- 专用微服务

### 客户端认证流程

```
1. 客户端生成 PKCE code_verifier + code_challenge
2. 客户端打开 Google 授权画面 URL（携带 code_challenge）
3. Google 重定向到代理，附带授权码
4. 代理将授权码交换为令牌（使用 client_secret + code_verifier）
5. 代理将令牌重定向到应用：
   - Electron：自定义协议（super-productivity://oauth/google）
   - Web：重定向到应用源（origin）
   - Android/iOS：深度链接（com.super-productivity.app://oauth/google）
6. 客户端将令牌本地存储在 SyncCredentialStore 中
7. 客户端直接调用 Google Calendar API（代理不参与）
8. 收到 401 时：客户端调用代理的 /token-refresh 获取新的 access_token
```

### 各平台重定向处理

| 平台      | 代理模式                             | 自定义凭据模式                                                 |
| --------- | ------------------------------------ | -------------------------------------------------------------- |
| Electron  | 自定义协议（super-productivity://）  | 自定义协议（super-productivity://） + PKCE 流程                |
| Web       | 代理 URL → 重定向回应用源            | 用户提供的 OAuth 客户端（需要自托管 web 的多个重定向 URI）     |
| Android   | 深度链接（com.super-productivity.app://） | 深度链接 + PKCE 流程                                           |
| iOS       | 深度链接（com.super-productivity.app://） | 深度链接 + PKCE 流程                                           |

### 令牌存储

复用现有的 `SyncCredentialStore`（由 Dropbox 同步使用）。Google Calendar 令牌作为 `SyncCredential` 存储，`type: 'GOOGLE_CALENDAR'`。此模式已通过 Dropbox 同步验证——数据加密存储在 IndexedDB 中。

**新增服务（认证代理中）：**

```typescript
// packages/sync-providers/src/google-calendar/
  google-oauth.service.ts       # 平台特定的 OAuth 流程 + PKCE 流程
  oauth-proxy.service.ts        # 通过认证代理路由令牌交换
  oauth-credential.store.ts     # 扩展/复用 SyncCredentialStore
```

---

## 提供者结构

在 `src/app/features/issue/providers/google-calendar/` 下新建提供者：

```
google-calendar/
  google-calendar.model.ts          # GoogleCalendarCfg，事件类型映射
  google-calendar.const.ts          # 作用域、API URL、默认值
  google-calendar-api.service.ts    # REST API 调用（事件 CRUD、日历列表）
  google-calendar.service.ts        # 扩展 BaseIssueProviderService
  google-calendar-sync-adapter.ts   # 双向同步逻辑
  google-calendar-cfg/              # 设置 UI 组件
```

### 配置模型

```typescript
interface GoogleCalendarCfg extends BaseIssueProviderCfg {
  calendarIds: string[];
  authMode: 'proxy' | 'custom';
  customClientId?: string;
  customClientSecret?: string;
  syncDirection: 'read-only' | 'two-way';
  checkUpdatesEvery: number;
}
```

---

## 数据映射

### Google → Super Productivity

| Google Calendar 事件         | Super Productivity                        |
| ---------------------------- | ----------------------------------------- |
| `summary`（摘要）            | 任务标题                                  |
| `description`（描述）        | 任务笔记                                  |
| `start` / `end`              | `CalendarIntegrationEvent` 开始/时长      |
| `status`（confirmed/cancelled） | 任务完成状态                            |
| `updated`（更新时间）        | 用于同步的最后修改时间戳                  |

### Super Productivity → Google（第 2 阶段+）

| Super Productivity   | Google Calendar 事件                    |
| -------------------- | --------------------------------------- |
| 任务标记为已完成     | 事件状态 → cancelled（或可配置）        |
| 标题已变更           | `summary` 更新                          |
| 笔记已变更           | `description` 更新                      |

### 不同步的内容

- 子任务（Google Calendar 中无对应概念）
- 时间跟踪数据
- 标签、优先级、预估时间——SP 特有的概念

---

## 同步策略

遵循 `CaldavSyncAdapterService` 已建立的模式：

1. **基于轮询**，间隔可配置（默认：5 分钟）
2. **增量同步**，使用 Google 的 `syncToken`——仅返回上次同步以来变更的事件，效率远高于完全重新获取
3. **冲突解决**，基于 `updated` 时间戳（最后写入者获胜，以服务端为准）
4. **同步状态**按提供者实例存储在配置中

---

## 实施阶段

### 第 1 阶段：认证 + 只读导入

- 支持 PKCE + 代理的 Google OAuth 服务
- 各平台特定重定向处理（Electron、Web、Capacitor）
- 从 Google Calendar API 获取事件
- 以 `CalendarIntegrationEvent` 形式展示（如现有 ICAL 提供者）
- 用于连接 Google 账户、选择日历的设置 UI

### 第 2 阶段：状态同步回 Google

- 当 SP 任务完成时将事件标记为已完成/已取消
- 使用 `syncToken` 进行增量同步
- 通过 `updated` 时间戳进行冲突检测
- 处理 API 速率限制、权限撤销等错误

### 第 3 阶段：完整双向同步（未来）

- 从 SP 任务创建 Google Calendar 事件
- 双向字段同步（标题、描述、时间）
- 考虑：SP 的时间跟踪是否应更新事件时长？

---

## 未解决的问题

1. **Google 应用验证时间线**——受限作用域验证可能需要数周/数月。应该提前申请还是先用未经验证的应用（100 用户限制）？
2. **多个 Google 账号**——用户是否应该能够连接多个 Google 账号？提供者模型支持多个实例，但 OAuth 流程需要处理账号切换。
3. **重复事件**——Google Calendar 有自己的重复模型。重复事件如何映射到 SP 任务？每次发生对应一个任务，还是整个系列对应一个任务？
4. **事件删除**——当 Google 事件被删除时，对应的 SP 任务应该被删除、归档还是仅作标记？
5. **代理速率限制**——代理需要速率限制以防止滥用。合理的限制是多少？

---

## 参考资料

- [Google Calendar API v3 文档](https://developers.google.com/calendar/api/v3/reference)
- [Google OAuth 2.0 移动/桌面端](https://developers.google.com/identity/protocols/oauth2/native-app)
- [Google 应用验证要求](https://support.google.com/cloud/answer/9110914)
- 现有 CalDAV 双向同步：`src/app/features/issue/providers/caldav/caldav-sync-adapter.service.ts`
- 现有 Dropbox OAuth：`src/app/op-log/sync-providers/file-based/dropbox/dropbox.ts`
- 现有凭据存储：`src/app/op-log/sync-providers/credential-store.service.ts`
- 通用日历同步分析：`docs/long-term-plans/calendar-two-way-sync-technical-analysis.md`
