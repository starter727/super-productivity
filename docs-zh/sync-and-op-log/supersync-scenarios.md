# SuperSync 同步场景（SuperSync Synchronization Scenarios）

SuperSync 同步过程中可能出现的所有场景的完整规范，以及每种场景的预期行为。

---

## A. 正常同步

### A.1：标准增量同步（无冲突）✅

**触发条件：** 自动 1 分钟定时器或手动同步

**预期行为：**

1. 下载自 `lastServerSeq` 以来的新远程操作
2. 对每个操作进行模式迁移（Schema-migrate，接收端）
3. 过滤被任何 SYNC_IMPORT 无效化的操作（通过向量时钟比较）
4. 通过向量时钟与本地实体前沿（entity frontier）检测冲突
5. 无冲突 → 将操作应用到 NgRx 存储
6. 上传待处理的本地操作（如果启用加密则加密，每批 25 条）
7. 处理上传响应中的捎带操作（piggybacked ops）
8. 处理任何拒绝
9. 状态 → `IN_SYNC`

**用户所见：** 同步指示器短暂显示同步中，然后显示双勾。

### A.2：带捎带操作的同步 ✅

**触发条件：** 上传响应中包含来自其他客户端的操作

**预期行为：**

1. 上传本地操作
2. 服务器在响应中返回捎带操作
3. 捎带操作在**标记已拒绝操作之前**处理（关键顺序，确保正确的冲突检测）
4. 无冲突 → 直接应用
5. 有冲突 → LWW（最后写入者胜出，Last-Write-Wins）自动解决

**用户所见：** 无缝合并，无对话框。

### A.3：双方均无变更 ✅

**触发条件：** 同步触发但任何地方都没有新操作

**预期行为：**

1. 下载 → 0 条新操作
2. 上传 → 0 条待处理操作
3. 即使没有操作也更新 `lastServerSeq`（保持客户端与服务器同步）
4. 状态 → `IN_SYNC`

**用户所见：** 快速同步，双勾。

---

## B. 冲突场景

### B.1：并发修改 —— LWW 自动解决 ✅

**触发条件：** 两个客户端在同步间隔内编辑同一实体

**预期行为：**

1. 下载远程操作
2. 冲突检测：操作的 vectorClock 与本地实体前沿为 `CONCURRENT`（并发关系）
3. `ConflictResolutionService.autoResolveConflictsLWW()`：
   - 比较时间戳 → 较晚写入者胜出
   - 创建合并操作，包含胜出数据 + 合并后的向量时钟
4. 合并操作应用到存储，标记为待处理
5. 下次同步时，合并操作被上传
6. 其他客户端下载合并后的操作——不再有冲突（合并后的时钟支配双方）

**用户所见：** 无对话框。一个客户端的变更根据时间戳静默胜出。

### B.2：服务器拒绝操作 —— CONFLICT_CONCURRENT ✅

**触发条件：** 服务器已存在同一实体的冲突操作

**预期行为：**

1. 上传操作 → 服务器以 `CONFLICT_CONCURRENT` 拒绝
2. 先处理捎带操作（可能包含胜出的远程版本）
3. `RejectedOpsHandlerService`：
   - 触发下载以获取冲突操作
   - 如果找到新操作：冲突检测解决冲突
   - 如果没有新操作：创建合并操作，包含当前状态 + 合并后的向量时钟
4. 合并操作标记为待处理，下次同步时上传

**用户所见：** 同步正常完成（自动解决）。可能有短暂延迟。

### B.3：永久拒绝（VALIDATION_ERROR）✅

**触发条件：** 操作包含服务器无法接受的无效数据

**预期行为：**

1. 上传操作 → 服务器以 `VALIDATION_ERROR` 拒绝
2. 操作在 IndexedDB 中标记为已拒绝（不再重试）
3. `permanentRejectionCount > 0` → 状态设为 `ERROR`

**用户所见：** 错误指示器。操作已丢失（不再重试）。

### B.4：负载过大 ✅

**触发条件：** 单个操作或批量操作超过服务器大小限制

**预期行为：**

1. 服务器返回 413 或提及"Payload too large/complex"的错误
2. 显示 `alertDialog()`（最高可见性）
3. 状态 → `ERROR`
4. 返回 `HANDLED_ERROR`

**用户所见：** 弹出警告对话框说明问题。同步停止。

### B.5：无限冲突循环预防 ✅

**触发条件：** 同一实体因向量时钟裁剪产物而被重复拒绝

**预期行为：**

1. 对同一实体达到 `MAX_CONCURRENT_RESOLUTION_ATTEMPTS`（可配置）次重试后
2. 放弃：将操作标记为永久拒绝
3. 清除尝试计数器

**用户所见：** Snackbar 警告。操作被永久拒绝。

---

## C. 全新/新客户端场景

### C.1：全新客户端 —— 无本地数据

**触发条件：** 全新客户端（无操作历史，无有意义的存储数据）首次同步

**预期行为：**

1. `isWhollyFreshClient()` = true
2. `_hasMeaningfulStoreData()` = false
3. 显示原生 `confirmDialog()`："初始同步 —— 这似乎是全新安装。发现远程数据（X 项变更）。是否要下载并用其覆盖本地数据？"
4. 如果确认 → 下载并应用所有远程操作
5. 如果取消 → snackbar "同步已取消"，不应用数据

**用户所见：** 简单的确定/取消确认。✅

### C.2：全新客户端 —— 有本地数据（前操作日志时代）

**触发条件：** 客户端在 NgRx 中有任务/项目/标签，但无操作日志历史

**预期行为：**

1. `isWhollyFreshClient()` = true
2. `_hasMeaningfulStoreData()` = true（检查任务、非 INBOX 项目、非系统标签、笔记）
3. 抛出 `LocalDataConflictError`
4. 显示完整冲突对话框：USE_LOCAL / USE_REMOTE / CANCEL
5. USE_LOCAL → `forceUploadLocalState()`（创建 SYNC_IMPORT）
6. USE_REMOTE → `forceDownloadRemoteState()`（清除本地操作）

**用户所见：** 完整的冲突解决对话框。

### C.3：全新客户端 —— 有待处理操作且包含有意义的用户数据（仅文件型同步）

**触发条件：** 客户端有待处理操作包含任务/项目/标签/笔记的创建/更新操作，从文件型提供商接收快照时

**预期行为：**

1. 下载检测到远程快照（文件型同步路径）
2. 检查待处理操作中是否有有意义的用户数据：TASK/PROJECT/TAG/NOTE 的 CREATE/UPDATE 操作，或任何全状态操作（SYNC_IMPORT/BACKUP_IMPORT/REPAIR）
3. 如果存在有意义数据 → 抛出 `LocalDataConflictError` → 完整冲突对话框
4. 如果仅有配置/系统操作 → 继续执行，无对话框

**注意：** 此操作内容检查仅适用于文件型快照路径。对于 SuperSync（增量操作路径），新客户端检查使用 `_hasMeaningfulStoreData()`（基于存储的检查）。

**用户所见：** 仅当真实用户数据可能丢失时才显示冲突对话框。✅

---

## D. SYNC_IMPORT 场景

### D.1：远程传入 SYNC_IMPORT —— 无本地待处理操作 ✅

**触发条件：** 其他客户端上传了 SYNC_IMPORT（文件导入、启用加密等）

**预期行为：**

1. 下载批次中包含 SYNC_IMPORT/BACKUP_IMPORT/REPAIR
2. 检查本地待处理操作 → 无有意义的待处理变更（`_hasMeaningfulPendingOps()` = false）
3. **通过 `processRemoteOps()` 静默应用**——无对话框。已同步的存储数据在此不构成冲突；SYNC_IMPORT 是新的权威状态。
4. 有意不检查 `_hasMeaningfulStoreData()`：如果提示一个仅有已同步"数据"的旧客户端，用户可能选择 `USE_LOCAL` 并强制上传过时状态作为新的 SYNC_IMPORT，从而为所有人回滚远程导入。
5. 仅当存在实际会被丢弃的未同步待处理用户变更时，**才**显示对话框——参见 D.2。

**用户所见：** 无反应。数据无缝更新到新的权威状态。面向用户的警告已在源设备（`D_SERVER_MIGRATION_CONFIRM` / 加密流程）发生，而非此处。

### D.2：远程传入 SYNC_IMPORT —— 有本地待处理操作 ✅

**触发条件：** 其他客户端上传了 SYNC_IMPORT，而本客户端有未同步的本地操作

**预期行为：**

1. 下载批次中包含 SYNC_IMPORT
2. 检查本地待处理操作 → N > 0（无论是否有意义的数据，条件均满足）
3. **在处理之前显示冲突对话框**，设置 `scenario: 'INCOMING_IMPORT'` 和 `syncImportReason`
4. USE_LOCAL → `forceUploadLocalState()`（用本地数据覆盖远程）
5. USE_REMOTE → `forceDownloadRemoteState()`（清除本地操作，从 seq 0 下载）
6. CANCEL → 返回 `cancelled: true`，跳过上传阶段

**用户所见：** 冲突对话框说明检测到远程导入，本地变更面临风险。推荐"使用服务器数据"。

### D.3：远程操作被本地存储的 SYNC_IMPORT 过滤 ✅

**触发条件：** 本客户端创建了 SYNC_IMPORT（例如文件导入、启用加密）。之后，来自其他客户端的操作到达，且与导入为 `CONCURRENT` 关系。

**预期行为：**

1. `SyncImportFilterService` 根据存储的本地导入过滤传入的远程操作
2. 向量时钟比较：`CONCURRENT` 或 `LESS_THAN` → 被过滤
3. `isLocalUnsyncedImport` = true（导入源是'本地'）
4. **显示冲突对话框**，设置 `scenario: 'LOCAL_IMPORT_FILTERS_REMOTE'` 和存储导入的 `syncImportReason`
5. USE_LOCAL → `forceUploadLocalState()`
6. USE_REMOTE → `forceDownloadRemoteState()`

**用户所见：** 冲突对话框。防止来自其他客户端的静默数据丢失。

### D.4：远程操作被存储的远程 SYNC_IMPORT 过滤 ✅

**触发条件：** 先前下载的远程 SYNC_IMPORT 过滤后续的远程操作

**预期行为：**

1. `SyncImportFilterService` 根据存储的远程导入过滤传入的远程操作
2. `isLocalUnsyncedImport` = false（导入源是'远程'）
3. **静默过滤**——无对话框
4. 日志："N 条远程操作被远程 SYNC_IMPORT 静默过滤"

**用户所见：** 无反应。这是正确的——导入已从远程源接受。旧的并发操作被有意丢弃（干净状态语义）。

### D.5：SYNC_IMPORT 后的同客户端操作（裁剪产物）✅

**触发条件：** 来自创建了 SYNC_IMPORT 的同一客户端的操作因向量时钟裁剪而显示为 `CONCURRENT`

**预期行为：**

1. 向量时钟比较返回 `CONCURRENT`
2. 特殊检查：`op.clientId === import.clientId && op.vectorClock[op.clientId] > importClock[op.clientId]`
3. 保留该操作（一个客户端不能创建与其自身导入并发的操作）

**用户所见：** 无反应。操作正常应用。

### D.6：捎带 SYNC_IMPORT —— 冲突对话框 ✅

**触发条件：** 上传响应中包含来自其他客户端的捎带 SYNC_IMPORT

**预期行为：**

1. 上传完成 → 服务器返回包含 SYNC_IMPORT 的捎带操作
2. 在 `processRemoteOps()` **之前**检查捎带操作中是否有 SYNC_IMPORT
3. 如果找到 AND `_hasMeaningfulPendingOps()` = true（未同步的 TASK/PROJECT/TAG/NOTE 的 C/U/D 或全状态操作）：
   - **显示冲突对话框**，设置 `scenario: 'INCOMING_IMPORT'` 和捎带操作的 `syncImportReason`
   - USE_LOCAL → `forceUploadLocalState()`（覆盖远程）
   - USE_REMOTE → `forceDownloadRemoteState()`（清除本地，从 seq 0 下载）
   - CANCEL → 返回 `cancelled: true`，调用者跳过上传后逻辑
4. 如果无有意义的待处理操作 → `processRemoteOps()` 静默应用（无对话框），无论 NgRx 存储中是否已有用户数据——该数据已同步，SYNC_IMPORT 是新的权威状态。

**镜像下载路径（D.1 / D.2）：** 门槛是未同步的待处理变更，而非存储内容。基于已同步存储数据提示会让旧客户端通过 USE_LOCAL 回滚远程导入。

**用户所见：** 无待处理变更时无反应——面向用户的警告已在源设备（`D_SERVER_MIGRATION_CONFIRM` / 加密流程）发生，参见 D.1。仅当实际未同步工作面临风险时才显示冲突对话框。

---

## E. 加密场景

### E.1：启用加密 ✅

**触发条件：** 用户在同步设置或初始设置提示中点击"启用加密"

**预期行为：**

1. 检查 WebCrypto 可用性（在 Android/非安全上下文中提前失败）
2. `runWithSyncBlocked()` 阻止并发同步
3. 删除所有服务器数据（`deleteAllData()`）
4. 更新本地配置：`isEncryptionEnabled=true, encryptKey=key`
5. 加密状态快照
6. 通过快照端点上传加密快照
7. 更新 `lastServerSeq`
8. 解除同步阻塞
9. 如果上传在删除后失败：**回滚配置**，显示包含恢复说明的错误

**用户所见：** 加密对话框 → "加密中..." → 成功 snackbar。锁图标出现。

**其他客户端：** 下次同步收到 `DecryptNoPasswordError` → 密码对话框。

### E.2：禁用加密 ✅

**触发条件：** 用户在同步设置中点击"禁用加密"

**预期行为：**

1. 需要确认对话框
2. `runWithSyncBlocked()`
3. 删除所有服务器数据
4. 上传未加密快照
5. 更新配置：`isEncryptionEnabled=false, encryptKey=undefined`
6. 清除包装器缓存

**用户所见：** 确认 → "禁用中..." → 成功 snackbar。锁图标消失。

**其他客户端：** 自动检测未加密数据 → 自动禁用本地加密 → snackbar 警告。

### E.3：更改加密密码

**触发条件：** 用户在"输入加密密码"对话框中输入新密码，带"使用本地数据"选项

**预期行为：**

1. `runWithSyncBlocked()`
2. 检查未同步操作（除非 `allowUnsyncedOps=true`，否则报错）
3. `CleanSlateService.createCleanSlate()`：
   - 生成新客户端 ID
   - 清除所有本地操作历史
   - 创建全新的 SYNC_IMPORT 操作
4. 更新配置：`encryptKey = newPassword`
5. 清除派生密钥缓存
6. 使用 `isCleanSlate=true` 上传 SYNC_IMPORT（服务器删除所有现有数据）

**用户所见：** 确认 → "更改密码中..." → 成功。

**其他客户端：** 旧密码解密失败 → 密码对话框。

### E.4：下载时密码错误/缺失

**触发条件：** 服务器有加密数据但客户端无密码/密码错误

**预期行为：**

1. 下载加密操作 → 解密失败
2. 抛出 `DecryptError` 或 `DecryptNoPasswordError`
3. 设置状态 → `ERROR`
4. 打开 `DialogEnterEncryptionPasswordComponent`：
   - **"保存并同步"**：保存密码 → 重试同步
   - **"使用本地数据"**：`changePassword(enteredPassword, {allowUnsyncedOps: true})` → 用本地加密数据覆盖服务器
   - **取消**：关闭对话框，状态保持 `UNKNOWN_OR_CHANGED`

**用户所见：** 错误图标 → 带有两个选项的密码对话框。

### E.5：加密状态不匹配（远程已禁用）

**触发条件：** 其他客户端禁用了加密；本客户端仍启用加密

**预期行为：**

1. 下载/上传响应：`serverHasOnlyUnencryptedData = true`
2. 本地配置设置了 `encryptKey`
3. 自动更新配置：`isEncryptionEnabled=false, encryptKey=undefined`
4. 显示 snackbar："另一台设备上已禁用加密"
5. 下次同步使用未加密模式

**用户所见：** 警告 snackbar。锁图标消失。

### E.6：每次成功 SuperSync 同步后提示加密（直至加密）

**触发条件：** SuperSync 活跃但未加密，同步成功完成

**预期行为：**

1. `sync()` 返回 `InSync` 后
2. 检查：提供商是 SuperSync 且未启用加密且未在显示对话框
3. 以 `initialSetup` 模式打开 `DialogEnableEncryptionComponent`，设置 `disableClose: true`
4. 用户必须设置密码 → `enableEncryption()` 流程（E.1）
5. 或者用户点击取消 → **同步被完全禁用**（`disableSuperSync()` 设置 `isEnabled: false`）
6. 对话框关闭 → 如果已设置加密，`sync()` 再次触发以重新同步加密

**用户所见：** 每次同步后显示加密对话框，直至启用加密。唯一的退出方式是禁用同步。没有"跳过"选项——SuperSync 的加密实际上是强制性的。

### E.7：加密操作阻止并发同步

**触发条件：** 密码更改/启用/禁用过程中触发了同步

**预期行为：**

1. `_isEncryptionOperationInProgress` = true
2. `sync()` 检查标志 → 立即返回 `HANDLED_ERROR`
3. 日志："同步受阻：加密操作进行中"
4. 加密操作完成后 → 标志清除 → 下次同步正常进行

**用户所见：** 同步静默跳过。自动恢复。

### E.8：文件导入保留加密状态

**触发条件：** 加密启用时用户从文件导入数据

**预期行为：**

1. `loadAllData` reducer 将 `isEncryptionEnabled` 保留为本地设置（不会被导入配置覆盖）
2. `ImportEncryptionHandlerService`：如果导入会禁用加密 → 跳过
3. 导入后加密保持启用状态

**用户所见：** 数据已导入，加密状态不变。

---

## F. 服务器迁移

### F.1：客户端重新连接到新/空服务器

**触发条件：** `lastServerSeq === 0` 且服务器为空且客户端先前已同步过操作

**预期行为：**

1. 在上传过程中通过 `ServerMigrationService.checkAndHandleMigration()` 检测
2. 再次确认服务器仍为空
3. 创建 SYNC_IMPORT，包含完整的当前状态 + 所有本地操作的合并向量时钟
4. 将 SYNC_IMPORT 作为快照上传
5. 其他客户端在下次同步时下载 SYNC_IMPORT

**用户所见：** 上传耗时稍长（完整状态）。无对话框。

### F.2：迁移中止 —— 服务器不再为空

**触发条件：** 在下载检查与上传检查之间，另一个客户端上传了数据

**预期行为：**

1. 检查发现服务器不再为空（`latestSeq !== 0`）
2. 中止迁移（不创建 SYNC_IMPORT）
3. 继续正常上传待处理操作

**用户所见：** 正常同步。无需迁移。

---

## G. 错误/边缘情况

### G.1：网络超时

**预期行为：** Snackbar 警告。操作保持待处理。下次同步重试。

浏览器/Electron SuperSync 请求会在显示警告之前重试瞬时获取失败（例如切换 Wi-Fi 时的网络变更）。

### G.2：CORS 错误

**预期行为：** 包含详细错误信息的 Snackbar（持续 12 秒）。状态 `HANDLED_ERROR`。

### G.3：认证失败

**预期行为：**

1. 清除过期的凭据
2. Snackbar 带有"CONFIGURE"操作按钮
3. 用户通过对话框重新输入凭据

### G.4：瞬时服务器错误（INTERNAL_ERROR）

**预期行为：** 操作保持待处理（不标记为已拒绝）。下次同步静默重试。

### G.5：重复操作

**预期行为：** 服务器拒绝为重复 → 客户端将操作标记为已同步。不显示错误。

### G.6：存储配额超出

**预期行为：** 警告对话框（最高可见性）。操作保持待处理。需要管理员介入。

### G.7：版本不匹配（模式过新）

**预期行为：** 日志警告（"远程模型版本比本地更新 —— 可能需要更新应用"）。返回 `HANDLED_ERROR`。不向用户显示警告。用户需要更新应用。

### G.8：操作迁移失败

**预期行为：** 失败的操作被跳过。每个会话显示一次 snackbar。其他操作正常应用。

### G.9：并发同步尝试

**预期行为：** 第二次尝试立即返回。日志记录"同步已在进行中"。

### G.10：同步期间应用关闭

**预期行为：** 待处理操作保存在 IndexedDB 中。下次打开应用时恢复同步。

---

## H. 多客户端交互场景

### H.1：客户端 A 启用加密，客户端 B 有待处理操作

**预期流程：**

1. 客户端 A：`enableEncryption()` → 删除服务器，上传加密的 SYNC_IMPORT
2. 客户端 B 同步：下载 SYNC_IMPORT
3. 客户端 B 有本地待处理操作 → **显示冲突对话框**
4. USE_LOCAL：强制上传本地状态（使用客户端 B 拥有的密码加密）
5. USE_REMOTE：`forceDownloadRemoteState()` → 重置到 seq 0，重新下载加密数据 → 如果客户端 B 没有密码，失败并返回 `DecryptNoPasswordError` → 密码对话框 → 用户输入密码 → 重新同步
6. CANCEL：跳过同步，状态保持 `UNKNOWN_OR_CHANGED`

**先前的问题：** 客户端 B 的操作被静默丢弃 → 死锁。

### H.2：客户端 A 更改密码，客户端 B 使用旧密码

**预期流程：**

1. 客户端 A：`changePassword()` → 干净状态，用新密码加密的新 SYNC_IMPORT
2. 客户端 B 同步：解密失败（旧密码）
3. 显示密码对话框
4. 用户输入新密码 → 恢复同步
5. 如果用户不知道新密码 → "使用本地数据"选项覆盖服务器

### H.3：客户端 A 导入文件，客户端 B 有变更

**预期流程：**

1. 客户端 A：文件导入 → 创建本地 SYNC_IMPORT（未同步）
2. 客户端 A 同步：上传 SYNC_IMPORT
3. 客户端 B 同步：下载 SYNC_IMPORT
4. 客户端 B 有待处理操作 → 冲突对话框
5. 客户端 B 选择 USE_LOCAL 或 USE_REMOTE

### H.4：两个客户端同时导入/强制上传

**预期流程：**

1. 客户端 A 先上传 SYNC_IMPORT → 服务器接受
2. 客户端 B 上传 SYNC_IMPORT → 服务器拒绝（或以更高序列接受）
3. 解决方式取决于服务器行为：
   - 如果被拒绝：客户端 B 下载 A 的导入，冲突对话框
   - 如果被接受：服务器级别的最后写入者胜出

### H.5：三个客户端，正常并发编辑

**预期流程：**

1. 每个客户端编辑不同实体 → 无冲突，全部干净合并
2. 每个客户端编辑同一实体 → LWW 自动解决，最后时间戳胜出
3. 向量时钟确保所有客户端的因果顺序

---

## I. 设置与提供商切换场景

### I.1：首次 SuperSync 设置 —— 全新用户（无现有数据）

**触发条件：** 用户首次打开同步设置，选择 SuperSync，输入访问令牌

**预期行为：**

1. `DialogSyncInitialCfgComponent` 打开
2. `_isInitialSetup = true` → 表单中隐藏加密按钮/警告（已单独处理）
3. 用户填写 SuperSync 访问令牌
4. `save()` → 剥离 `_isInitialSetup` 标志 → 保存配置 → 如果需要则认证
5. 检查：已选择 SuperSync 且未启用加密 → **探测服务器** 通过 `downloadOps(0, undefined, 1)`
6. 服务器为空（`latestSeq === 0` 或无操作）→ 以 `initialSetup: true` 打开 `DialogEnableEncryptionComponent`
7. 用户设置密码 → `enableEncryption()`：
   - 检查 WebCrypto → 删除服务器（空服务器，无操作）→ 更新配置 → 加密快照 → 上传
8. 或者用户点击取消 → `disableSuperSync()` 完全禁用同步（不存在"跳过"选项）
9. 对话框关闭 → `sync()` 触发（如果同步仍启用）
10. `isWhollyFreshClient()` = true → 从空服务器无需下载
11. 状态 → `IN_SYNC`

**用户所见：** 设置对话框 → 创建密码提示 → 完成。全新开始。

### I.2：首次 SuperSync 设置 —— 用户有现有本地数据（前同步时代）✅

**触发条件：** 用户一直离线使用 Super Productivity，然后首次设置 SuperSync

**预期行为：**

1. 与 I.1 相同的设置流程（配置 + 加密提示）
2. `sync()` 触发 → 从服务器下载
3. 服务器为空（`latestServerSeq === 0`）且 `newOps.length === 0`
4. 前操作日志检测：`isWhollyFreshClient()` = true 且 `_hasMeaningfulStoreData()` = true
5. `downloadRemoteOps()` 调用 `serverMigrationService.handleServerMigration()` 从本地状态创建 SYNC_IMPORT
6. 返回 `serverMigrationHandled: true` → 继续执行上传阶段
7. SYNC_IMPORT 上传到服务器 → 其他客户端可以下载
8. 状态 → `IN_SYNC`

**用户所见：** 上传耗时稍长（完整状态 SYNC_IMPORT）。无对话框。

**安全性：** `handleServerMigration()` 内部会再次确认服务器仍为空，且在本地状态为空时跳过，因此对竞态和误报是安全的。

### I.3：首次 SuperSync 设置 —— 服务器已有数据（第二客户端）

**触发条件：** 用户已在客户端 A 上使用 SuperSync，现在设置客户端 B

**预期行为：**

1. 客户端 B：设置对话框 → `save()` → **探测服务器** 通过 `downloadOps(0, undefined, 1)`
2. **如果服务器有加密数据**（`isPayloadEncrypted === true`）：
   - 打开 `DialogEnterEncryptionPasswordComponent`（输入现有密码）
   - 用户输入密码 → `updateEncryptionPassword()` 设置 `isEncryptionEnabled = true`
   - 无双重提示 —— 从一开始就显示正确的对话框
3. **如果服务器有未加密数据**（或探测失败）：
   - 打开 `DialogEnableEncryptionComponent`（创建新密码），与 I.1 相同
4. `sync()` 触发 → 下载远程操作
5. 两个路径取决于服务器发送快照还是增量操作：
   - **快照路径（文件型）：** `isWhollyFreshClient()` = true → 显示 `confirmDialog`，count=1（"发现远程数据（1 项变更）"）
   - **增量操作路径（SuperSync）：** `isWhollyFreshClient()` = true → 显示 `confirmDialog`，实际操作计数（"发现远程数据（N 项变更）"）
6. `_hasMeaningfulStoreData()` = false（全新客户端）→ 简单确认，非冲突对话框
7. 如果确认 → 应用所有远程操作 → 上传阶段（无需上传）→ `IN_SYNC`
8. 如果取消 → snackbar "同步已取消"

**用户所见：** 设置 → 正确的密码提示（输入或创建）→ 确认对话框 → 数据出现。

### I.4：首次 SuperSync 设置 —— 服务器有数据且客户端有本地数据

**触发条件：** 客户端 B 有离线数据，客户端 A 已同步到 SuperSync

**预期行为：**

1. 客户端 B：设置 → 服务器探测 → 正确的加密提示（输入或创建）→ `sync()`
2. 下载远程操作 → `isWhollyFreshClient()` = true（空操作日志）
3. `_hasMeaningfulStoreData()` = true（有任务/项目/标签）
4. 抛出 `LocalDataConflictError` → 完整冲突对话框：USE_LOCAL / USE_REMOTE / CANCEL
5. USE_LOCAL → `forceUploadLocalState()` → 创建 SYNC_IMPORT，覆盖服务器
6. USE_REMOTE → `forceDownloadRemoteState()` → 清除本地，下载所有内容
7. CANCEL → 同步取消，数据不变

**用户所见：** 完整的冲突解决对话框。关键——防止静默数据丢失。

### I.5：重新启用已禁用的 SuperSync

**触发条件：** 用户先前有 SuperSync，禁用了同步，然后使用相同的 SuperSync 账户重新启用

**预期行为：**

1. 打开同步设置 → 重新启用 SuperSync
2. 提供商特定配置仍在存储中（凭据保留）
3. `lastServerSeq` 仍在 localStorage 中（基于账户哈希键）
4. 本地操作日志保留（提供商无关）
5. `sync()` 触发 → 下载自存储的 `lastServerSeq` 以来的操作
6. 如果自禁用以来服务器数据未变：快速同步，无新操作
7. 如果其他客户端在禁用期间推送了操作：正常下载并合并
8. 上传离线期间创建的任何本地操作
9. 状态 → `IN_SYNC`

**用户所见：** 无缝恢复。所有本地变更同步上去。

**边缘情况：** 如果在禁用期间服务器被重置/迁移，`lastServerSeq` 可能超前于服务器的实际数据。服务器从可用序列返回操作；客户端进行调整。

### I.6：切换 SuperSync 账户（不同令牌/服务器）

**触发条件：** 用户更改 SuperSync 访问令牌或基础 URL

**预期行为：**

1. 保存新配置 → 新的 `accessToken` 和/或 `baseUrl`
2. `lastServerSeq` 键变更（`baseUrl|accessToken` 的哈希），每次同步调用时动态计算
3. 新账户从 `lastServerSeq = 0` 开始 → 从新服务器下载所有内容
4. 本地操作日志**保留**（提供商无关）
5. **重要提示：** `syncedAt` 是全局字段，而非每个提供商/账户。先前同步到旧账户的操作仍保持已同步标记，不会单独重新上传。
6. 首次同步到新服务器：
   - 下载：从新服务器获取所有操作（如有）
   - 如果新服务器为空且 `hasSyncedOps() = true`：服务器迁移创建包含完整当前状态的 SYNC_IMPORT → 完整数据传输到新服务器
   - 如果新服务器有数据：下载并合并远程操作。仅有本地未同步的操作会上传（已同步到旧账户的操作被跳过）。数据完整性取决于下载的远程操作。
   - 客户端不"新"（已有快照 + 操作）→ 不执行新客户端检查

**用户所见：** 短暂的重新同步。如果服务器为空，数据通过 SYNC_IMPORT 传输到新服务器。

**关键细节：**

- 加密状态基于每个提供商配置。切换账户可能改变加密状态。
- 切换到空服务器工作良好（服务器迁移覆盖完整状态）。
- 切换到具有不同数据的非空服务器：旧账户的操作不会重新上传，仅有 SYNC_IMPORT 级别传输或新操作。

---

### 提供商切换场景

### I.7：从文件型同步（WebDAV/Dropbox/LocalFile）切换到 SuperSync

**触发条件：** 用户当前通过 WebDAV 同步，在设置中切换到 SuperSync

**预期行为：**

1. 配置更新：`syncProvider = SuperSync`，凭据已保存
2. 加密提示（SuperSync 特有，探测服务器以确定创建或输入密码对话框）
3. 操作日志保留——所有操作保留在 IndexedDB 中
4. 向量时钟保留——因果关系追踪继续
5. 客户端 ID 保留——相同设备标识符
6. SuperSync 的 `lastServerSeq` = 0（从未同步到此 SuperSync 服务器）
7. 首次 SuperSync 同步：
   - 下载：空服务器 → 无远程操作
   - 服务器迁移：`hasSyncedOps()` = true（同步到 WebDAV 的操作已设置 `syncedAt`）→ 创建包含完整当前状态的 SYNC_IMPORT
   - 将 SYNC_IMPORT 上传到 SuperSync 服务器——**这是完整数据传输的方式，因为单个操作不会重新上传**（它们被全局标记为已同步）
8. 文件型同步提供商的数据保留在旧服务器上（WebDAV/Dropbox/本地）——不会被删除

**用户所见：** 设置 → 加密提示 → 同步。数据通过 SYNC_IMPORT 迁移到 SuperSync 服务器。

**切换时保留的内容：**

- 所有任务、项目、标签、笔记（通过 SYNC_IMPORT 完整状态）
- 向量时钟
- 客户端 ID

**不保留的内容：**

- 单个操作的同步状态（同步到 WebDAV 的操作保持已同步标记，服务器迁移改为通过 SYNC_IMPORT 处理数据传输）
- `lastServerSeq`（为新提供商重置）
- 文件型同步的锁文件/修订映射（与 SuperSync 无关）
- 加密密钥（SuperSync 在 privateCfg 中有自己的加密配置）

### I.8：从 SuperSync 切换到文件型同步（WebDAV/Dropbox/LocalFile）

**触发条件：** 用户当前通过 SuperSync 同步，在设置中切换到 WebDAV

**预期行为：**

1. 配置更新：`syncProvider = WebDAV`，凭据已保存
2. 操作日志保留
3. 向量时钟同步到 `pf.META_MODEL`（旧版同步的桥梁——`_syncVectorClockToPfapi()`）
4. 文件型同步在首次同步时写入完整状态快照到文件
5. SuperSync 服务器数据保留（不删除）——用户可以切换回来
6. SuperSync 的 `lastServerSeq` 保存在 localStorage 中，供将来重新切换使用

**用户所见：** 配置 WebDAV → 同步。数据上传到 WebDAV。

**重要提示：** 文件型提供商在每次同步前使用 `_syncVectorClockToPfapi()` 将向量时钟从操作日志存储（SUP_OPS）桥接到旧版持久化层（pf.META_MODEL）。SuperSync 不需要此桥梁。

### I.9：从 SuperSync（加密）切换到文件型同步

**触发条件：** 用户有带加密的 SuperSync，切换到 WebDAV

**预期行为：**

1. 配置更新：`syncProvider = WebDAV`
2. SuperSync 加密状态（`isEncryptionEnabled`、`encryptKey`）存储在 SuperSync 的 privateCfg 中——**不与 WebDAV 共享**
3. WebDAV 在其 privateCfg 中有自己的 `encryptKey`（初始为空）
4. 如果需要，用户必须单独为 WebDAV 配置加密（通过表单字段，而非对话框）
5. 上传到 WebDAV 的数据**未加密**，除非设置了 WebDAV 加密密钥

**用户所见：** 切换提供商 → 数据未加密同步到 WebDAV。

**关键区别：** SuperSync 通过专用对话框和 `isEncryptionEnabled` 标志管理加密。文件型提供商通过表单的 `encryptKey` 字段管理加密。它们是独立的。

### I.10：从文件型同步（加密）切换到 SuperSync

**触发条件：** 用户有设置了加密密钥的 WebDAV，切换到 SuperSync

**预期行为：**

1. 配置更新：`syncProvider = SuperSync`
2. WebDAV 的 `encryptKey` 保留在 WebDAV 的 privateCfg 中
3. SuperSync 以 `isEncryptionEnabled = false` 开始（除非之前已配置）
4. 设置过程中的加密提示（探测服务器——根据服务器状态创建或输入密码）
5. 用户为 SuperSync 设置新密码（可以与 WebDAV 密码不同）
6. 旧 WebDAV 文件保留在 WebDAV 服务器上，仍为加密状态

**用户所见：** 切换 → 同步 → 加密提示 → 设置密码。

### I.11：快速提供商切换（来回切换）

**触发条件：** 用户快速切换 SuperSync → WebDAV → SuperSync

**预期行为：**

1. 每次切换保留操作日志、向量时钟、客户端 ID
2. 每个提供商有独立的 `lastServerSeq` / 修订追踪
3. SuperSync 的每个账户 `lastServerSeq` 键在切换往返中幸存（存储在 localStorage 中）
4. 返回 SuperSync 时：
   - 从存储的 `lastServerSeq` 恢复
   - 下载离开期间其他客户端推送的任何操作
   - 仅 WebDAV 同步期间创建且未同步到 WebDAV 的操作会上传
5. 数据完整性在完整状态层面得以保持

**用户所见：** 无缝过渡。数据完整。

**重要细微差别：** `syncedAt` 是全局的——在离开期间同步到 WebDAV 的操作被标记为已同步，不会单独重新上传到 SuperSync。但这通常是可以的，因为：

- SuperSync 在切换前已有数据（之前已同步到那里）
- WebDAV 期间创建但尚未同步到 WebDAV 的任何新操作会上传到 SuperSync
- 如果在离开期间 SuperSync 数据丢失，服务器迁移（SYNC_IMPORT）会从完整状态重新创建

### I.12：完全禁用同步，然后用不同提供商重新启用

**触发条件：** 用户禁用同步，离线创建数据，然后用新提供商启用

**预期行为：**

1. 禁用：配置 `isEnabled = false`，不触发同步
2. 用户离线创建任务/项目 → 操作记录到 IndexedDB
3. 用新提供商（例如 SuperSync）重新启用
4. 如果新服务器为空：服务器迁移 → 从本地状态创建 SYNC_IMPORT
5. 如果新服务器有数据：取决于 `isWhollyFreshClient()`：
   - 如果操作日志非空（之前同步过）：不是新客户端 → 正常同步，上传待处理操作
   - 如果操作日志为空（从未同步过）：应用新客户端检查（I.3 或 I.4）

**用户所见：** 启用同步 → 数据上传到新提供商。

---

### 带加密的设置 —— 详细流程

### I.13：初始设置 → 用户设置加密密码

**触发条件：** 首次 SuperSync 设置，用户在加密对话框中输入密码

**预期行为：**

1. `DialogSyncInitialCfgComponent.save()` 完成配置保存
2. **探测服务器** 通过 `downloadOps(0, undefined, 1)` 检查是否存在加密数据
3. **如果服务器为空或包含未加密数据：**
   - 以 `initialSetup: true` 打开 `DialogEnableEncryptionComponent`（创建新密码）
   - 用户输入密码 → 组件调用 `enableEncryption(password)`
   - `enableEncryption()` 在 `runWithSyncBlocked()` 中执行：
     - 检查 WebCrypto 可用
     - 收集快照数据
     - 删除服务器数据（空服务器 → 无操作）
     - 更新配置：`isEncryptionEnabled=true, encryptKey=password`
     - 加密快照 → 上传
   - 对话框以 `{ success: true }` 关闭
4. **如果服务器有加密数据**（第二个客户端加入）：
   - 打开 `DialogEnterEncryptionPasswordComponent`（输入现有密码）
   - 用户输入密码 → `saveAndSync()` 调用 `updateEncryptionPassword()`，设置 `isEncryptionEnabled = true`
   - 对话框关闭
5. `save()` 继续 → `this._matDialogRef.close()` → `sync()`
6. `sync()` 完成 → `_promptSuperSyncEncryptionIfNeeded()`：
   - 检查加密 → 已启用 → 不再提示

**用户所见：** 设置 → 正确的密码对话框（创建或输入）→ 加密同步开始。

### I.14：初始设置 → 用户取消加密对话框

**触发条件：** 首次 SuperSync 设置，用户不想设置密码

**预期行为：**

1. 配置已保存，加密对话框以 `initialSetup: true` 和 `disableClose: true` 打开
2. 用户唯一的选择是：
   - **设置密码** → 加密启用，对话框以 `{ success: true }` 关闭
   - **取消** → 调用 `disableSuperSync()`，设置 `sync.isEnabled = false`，对话框以 `{ success: false }` 关闭
3. 没有"跳过"或"继续不加密"按钮——计划中描述过添加带"我了解"复选框的选项，但当前实现只提供取消（完全禁用同步）
4. 取消后：`save()` 继续 → `this._matDialogRef.close()` → `sync()` 触发但同步已禁用 → 静默失败

**当前行为：** 不加密的 SuperSync 实际上是不可能的。取消完全禁用同步。`_promptSuperSyncEncryptionIfNeeded()` 的后同步钩子强化了这一点——如果 SuperSync 以某种方式在未加密状态下运行，它会在每次成功同步后重新打开相同的对话框，并设置 `disableClose: true`。

**用户所见：** 加密对话框。必须设置密码或取消（禁用同步）。

### I.15：初始设置 → 加密失败（WebCrypto 不可用）

**触发条件：** Android/非安全上下文，用户尝试设置加密密码

**预期行为：**

1. 调用 `enableEncryption()` → `isCryptoSubtleAvailable()` 返回 false
2. 抛出 `WebCryptoNotAvailableError` → 被对话框的 try/catch 捕获
3. 对话框显示错误 snackbar："启用加密失败：..."
4. 对话框保持打开——用户可以重试或点击取消（完全禁用同步）
5. 此对话框中无法以未加密方式继续使用 SuperSync

**用户所见：** 错误消息。必须重试或取消（禁用同步）。

**注意：** 这实际上意味着 SuperSync 在没有 WebCrypto 的平台上无法使用（例如具有非安全上下文的 Android Capacitor）。如果加密以某种方式被绕过，`_promptSuperSyncEncryptionIfNeeded()` 的后同步钩子也会捕获到这一点。

### I.16：为现有 SuperSync 配置重新打开设置对话框

**触发条件：** 用户已有 SuperSync 配置，打开同步设置进行修改

**预期行为：**

1. `DialogSyncInitialCfgComponent` 打开，`isWasEnabled = true`
2. `_isInitialSetup = true` 仍然设置（此对话框中始终设置）
3. 加载现有提供商配置：访问令牌、加密状态从 privateCfg 填充
4. 如果已加密：模型中的 `isEncryptionEnabled = true` → 加密按钮被隐藏（hideExpression）
5. 保存时：加密检查 → 已启用 → 跳过加密对话框
6. 正常配置保存 → 同步

**用户所见：** 设置显示现有值。无加密提示（已设置）。

**边缘情况：** 如果用户在对话框内（使用提供商下拉菜单）从 SuperSync 切换到 WebDAV 再切换回来，`ngAfterViewInit` 监听器会重新加载提供商特定配置，包括加密状态。

---

## 关键不变性（Key Invariants）

1. **无静默数据丢失：** 每个可能丢失用户数据的场景都必须显示对话框
2. **干净状态语义：** SYNC_IMPORT 替换所有状态；并发操作被丢弃
3. **向量时钟用于因果关系：** 绝不使用墙上时钟时间进行冲突决策
4. **加密是原子性的：** 服务器绝不会有混合加密/未加密数据
5. **先下载后上传：** 始终先获取远程状态以尽早检测冲突
6. **Effect 使用 LOCAL_ACTIONS：** NgRx effect 绝不因远程同步操作而触发
7. **`lastServerSeq` 单调递增：** 客户端绝不再次下载相同操作
8. **待处理操作在崩溃中幸存：** IndexedDB 是未同步操作的真相来源
9. **操作日志与提供商无关：** 切换提供商保留所有操作、向量时钟和客户端 ID
10. **每个账户的 `lastServerSeq`：** SuperSync 根据 `hash(baseUrl|accessToken)` 追踪序列号，而非全局
11. **加密是按提供商的：** SuperSync 和文件型提供商在其 privateCfg 中有独立的加密配置
12. **`_isInitialSetup` 是临时的：** 在设置对话框中设置，配置保存前剥离，永不持久化

---

## 已知问题/未解决问题

1. **`syncedAt` 是每操作而非每提供商（I.6、I.7、I.11）：** 操作有单一的 `syncedAt` 时间戳，而非按提供商追踪。切换提供商时，先前同步到旧提供商的操作保持已同步标记，不会单独重新上传。在连接到空服务器时，服务器迁移会创建包含完整状态的 SYNC_IMPORT 来缓解此问题，但切换到具有不同数据的非空服务器可能导致状态不完整。

2. **加密状态跨提供商泄露（I.9）：** 从加密的 SuperSync 切换到 WebDAV 时，全局 `isEncryptionEnabled` 可能仍为 `true`（由 `SyncConfigService.updateSettingsFromForm()` 为 SuperSync 设置）。文件型提供商从 `!!encryptKey` 派生加密状态，因此不应导致问题，但全局配置可能显示误导性状态。

3. **SuperSync 没有"跳过加密"选项（I.14）：** 加密对话框的取消按钮完全禁用同步——无法在不加密的情况下使用 SuperSync。这是设计使然（加密实际上是强制性的），但可能让想先不加密测试的用户感到意外。
