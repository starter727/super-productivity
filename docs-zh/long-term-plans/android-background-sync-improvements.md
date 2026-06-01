# Android 后台同步改进

> **状态：已计划**

## 背景

当前实现（分支 claude/fix-android-reminder-sync-TdwQY）使用 Android WorkManager 每约 15 分钟轮询 SuperSync 服务器。当检测到任务在另一设备上被完成、删除或提醒被清除时，会取消过期的 Android 通知。这种方式可行但存在局限性。

本文档概述了两项改进：

1. **通过缓存同步状态实现快速应用启动**——利用后台工作进程的进度来加速应用打开时的初始同步
2. **通过 FCM 实现基于推送的通知取消**——消除 15 分钟的轮询间隔

---

## 阶段 1：通过缓存同步状态实现快速应用启动

### 问题

当用户在 Android 上打开应用时，同步层从头开始——它不知道后台工作进程已经看到了什么。工作进程一直在 SharedPreferences 中追踪 lastServerSeq，但应用启动时这些信息被浪费了。

### 方案

将工作进程的缓存状态暴露给 TypeScript 层，使应用能够跳过已处理的操作或使用序列号作为同步提示。

### 设计

#### 选项 A：序列号提示（最精简）

1. 在 AndroidInterface 中添加 getLastSyncSeq(): number
2. 应用初始化时，SyncService 调用 ndroidInterface.getLastSyncSeq() 获取工作进程最后处理的序列号
3. 同步层以此作为起点，只获取比此序列号更新的操作
4. 好处：将初始同步负载从潜在数千个操作减少到最多约 15 分钟的内容

**桥接层新增：**

`	ypescript
// android-interface.ts
getLastSyncSeq?(): number;
`

`kotlin
// JavaScriptInterface.kt
@JavascriptInterface
fun getLastSyncSeq(): Long {
    return credentialStore.getLastServerSeq()
}
`

**同步层集成点：** 在 SyncService 或 OperationApplierService 中确定初始 sinceSeq 的地方，优先检查 Android 提示。

#### 选项 B：缓存操作（更宏大）

1. 工作进程将获取到的操作写入本地缓存（SharedPreferences 或小型 SQLite 表），而不仅仅是追踪序列号
2. 应用启动时，TypeScript 层通过桥接层读取缓存操作，立即应用，然后实时同步任何更新的内容
3. 好处：应用状态在打开时几乎立即更新，甚至在网络调用之前

**权衡：**

- 原生端需要更多存储空间和复杂性
- 需要处理缓存失效（例如，用户切换账号时）
- 如果用户离线多天，操作数据可能很大

**建议：** 从选项 A 开始。它简单、低风险，已经覆盖了常见场景（用户在短暂休息后打开应用）。选项 B 可节省一次网络往返的延迟，在现代网络连接上影响不大。

### 实现步骤（选项 A）

1. 在 AndroidInterface 和 JavaScriptInterface 中添加 getLastSyncSeq()
2. 在同步初始化路径中，检查 IS_ANDROID_WEB_VIEW 并调用 getLastSyncSeq()
3. 如果返回的序列号大于 0，将其用作 sinceSeq 的起始点
4. 如果为 0 或不可用，则回退到正常同步路径

### 边界情况

- **账号切换**：lastServerSeq 以 aseUrl.hashCode() 为键，切换账号自动重置为 0
- **工作进程从未运行**：返回 0，同步正常进行——无回归
- **过期序列号**：如果序列号非常旧（工作进程被操作系统杀死），应用只是获取比平时更多的操作——仍然正确，只是更慢

---

## 阶段 2：通过 FCM 实现基于推送的取消

### 问题

WorkManager 的最小定期间隔为 15 分钟。用户可能在桌面上完成了一个任务，但如果在那个窗口期内触发，仍然会在手机上收到提醒。

### 方案

使用 Firebase Cloud Messaging（FCM）在发生提醒相关操作时从 SuperSync 服务器推送一个轻量级信号。Android 应用接收推送并立即取消过期通知。

### 前提条件

- SuperSync 服务器必须支持新操作上的 webhook/推送触发器
- FCM 项目设置和设备令牌注册
- 服务器端逻辑，用于确定哪些操作是"提醒相关"的

### 设计

#### 服务器端

1. 客户端向 SuperSync 服务器注册其 FCM 令牌（新 API 端点）
2. 当服务器收到匹配提醒相关操作码（HRX、HX、HD、HCR、HU（带提醒变更））的操作时，向该账号的所有已注册令牌发送**纯数据** FCM 消息
3. FCM 负载最小化：{ "type": "reminder_change", "seq": 12345 }

#### 客户端

1. FirebaseMessagingService 接收数据消息
2. 从 SharedPreferences 读取当前的 lastServerSeq
3. 如果传入的序列号更新，则使用现有的 SuperSyncBackgroundProvider 获取从 lastServerSeq 到新序列号的操作
4. 使用 SyncReminderWorker 中的现有逻辑解析并取消通知
5. 更新 lastServerSeq

#### 混合方案

保留 15 分钟的 WorkManager 轮询作为回退。FCM 送达是尽力而为——操作系统（Doze 模式、电池优化）可能会延迟或丢弃消息。即使 FCM 失败，工作进程也能确保最终一致性。

`
FCM 推送（即时，尽力而为）
         ↓
  取消通知
         ↓
WorkManager 轮询（15 分钟，保证送达）
         ↓
  取消任何剩余的过期通知
`

### 实现步骤

1. 将 Firebase SDK 添加到 Android 项目
2. 创建继承 FirebaseMessagingService 的 SyncFirebaseMessagingService
3. 将 FCM 令牌注册端点添加到 SuperSync 服务器
4. 添加针对提醒相关操作的服务器端推送逻辑
5. 将 FCM 令牌桥接到 TypeScript 层，以便在 SuperSync 认证期间发送
6. 保留现有 WorkManager 轮询作为回退

### 注意事项

- **隐私**：FCM 消息经过 Google 的服务器。负载应仅包含序列号，绝不包含任务内容。
- **电池**：纯数据 FCM 消息影响小。结合现有的 WorkManager 轮询，几乎不增加电池消耗。
- **服务器成本**：每个注册设备每个提醒相关操作推送一次。对于大多数用户来说，每天只有几次。
- **多设备**：每台设备注册自己的 FCM 令牌。服务器向账号的所有令牌推送。

---

## 阶段 3：扩展到其他同步提供者

### Dropbox / WebDAV

BackgroundSyncProvider 接口已经支持。Dropbox 的实现将：

1. 通过 Dropbox API 下载 sync-data.json（约 100KB+）
2. 与本地缓存副本进行差异比较，检测任务完成/删除
3. 返回要取消的 taskId 集合

这比 SuperSync 基于操作的 API 更重，但在约 15 分钟的轮询间隔下是可行的。WebDAV 类似。

**关键区别**：Dropbox/WebDAV 提供者需要本地缓存先前状态以计算差异，增加了存储开销。SuperSync 基于序列号的分页完全避免了这一点。

### 实现将增加：

- 实现 BackgroundSyncProvider 的 DropboxBackgroundProvider
- 实现 BackgroundSyncProvider 的 WebDavBackgroundProvider
- Dropbox OAuth 令牌和 WebDAV 凭据的凭据桥接
- SyncReminderWorker 中基于存储的提供者 ID 的提供者选择逻辑

---

## 优先级和顺序

| 阶段                     | 工作量                              | 影响                        | 建议             |
| ------------------------ | ----------------------------------- | --------------------------- | ---------------- |
| 阶段 1（序列号提示）     | 小（约 1 天）                       | 中等——更快的应用启动         | 优先执行         |
| 阶段 2（FCM 推送）       | 大（约 1 周，需要服务器变更）       | 高——即时取消                 | 服务器支持后执行 |
| 阶段 3（其他提供者）     | 每个提供者中等                      | 中等——更广的覆盖范围         | 按需执行         |
