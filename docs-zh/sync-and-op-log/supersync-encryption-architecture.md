# SuperSync 端到端加密架构

## 概览

SuperSync 使用 **AES-256-GCM** 加密，配合 **Argon2id** 做密钥派生，实现端到端加密（E2EE）。服务端永远看不到明文，所有加解密都在客户端完成。

## 加密流程图

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              CLIENT A (Upload)                               │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  1. User Action                                                             │
│     ┌──────────────┐                                                        │
│     │ Add Task     │                                                        │
│     │ "Buy milk"   │                                                        │
│     └──────┬───────┘                                                        │
│            │                                                                │
│            ▼                                                                │
│  2. NgRx Action Dispatched                                                  │
│     ┌──────────────────────────────────────────────────────────────┐        │
│     │ { type: '[Task] Add Task',                                   │        │
│     │   task: { id: 'abc123', title: 'Buy milk', ... },            │        │
│     │   meta: { isPersistent: true, entityType: 'task', ... } }    │        │
│     └──────────────────────────┬───────────────────────────────────┘        │
│                                │                                            │
│                                ▼                                            │
│  3. Operation Capture (operation-capture.meta-reducer.ts)                   │
│     ┌──────────────────────────────────────────────────────────────┐        │
│     │ MultiEntityPayload {                                         │        │
│     │   actionPayload: { task: {...}, isAddToBottom: false, ... }, │        │
│     │   entityChanges: [{ entityType: 'task', entityId: 'abc123',  │        │
│     │                     changeType: 'create' }]                  │        │
│     │ }                                                            │        │
│     └──────────────────────────┬───────────────────────────────────┘        │
│                                │                                            │
│                                ▼                                            │
│  4. Encryption (operation-encryption.service.ts)                            │
│     ┌─────────────────────────────────────────────────────────────┐         │
│     │                                                             │         │
│     │  User Password: "mySecretPass123"                           │         │
│     │         │                                                   │         │
│     │         ▼                                                   │         │
│     │  ┌─────────────────┐                                        │         │
│     │  │   Argon2id      │  Key Derivation                        │         │
│     │  │   + Salt        │  (CPU/memory-hard)                     │         │
│     │  └────────┬────────┘                                        │         │
│     │           │                                                 │         │
│     │           ▼                                                 │         │
│     │  256-bit Encryption Key                                     │         │
│     │           │                                                 │         │
│     │           ▼                                                 │         │
│     │  ┌─────────────────┐                                        │         │
│     │  │   AES-256-GCM   │  Authenticated Encryption              │         │
│     │  │   + Random IV   │  (confidentiality + integrity)         │         │
│     │  └────────┬────────┘                                        │         │
│     │           │                                                 │         │
│     │           ▼                                                 │         │
│     │  Encrypted Payload (base64 string)                          │         │
│     │  "U2FsdGVkX1+abc123..."                                     │         │
│     │                                                             │         │
│     └─────────────────────────┬───────────────────────────────────┘         │
│                               │                                             │
│                               ▼                                             │
│  5. SyncOperation Ready for Upload                                          │
│     ┌──────────────────────────────────────────────────────────────┐        │
│     │ { id: 'op-xyz', clientId: 'client-A',                        │        │
│     │   actionType: '[Task] Add Task',                             │        │
│     │   payload: "U2FsdGVkX1+abc123...",  ← Encrypted!             │        │
│     │   isPayloadEncrypted: true,          ← Flag set              │        │
│     │   vectorClock: { 'client-A': 5 }, ... }                      │        │
│     └──────────────────────────────────────────────────────────────┘        │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
                                    │
                                    │ HTTPS
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                           SUPERSYNC SERVER                                   │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  Server stores encrypted payload AS-IS                                      │
│  ┌──────────────────────────────────────────────────────────────────┐       │
│  │  operations table:                                               │       │
│  │  ┌─────────┬────────────────────────────┬───────────────────┐    │       │
│  │  │ seq     │ payload                    │ is_encrypted      │    │       │
│  │  ├─────────┼────────────────────────────┼───────────────────┤    │       │
│  │  │ 42      │ "U2FsdGVkX1+abc123..."     │ true              │    │       │
│  │  └─────────┴────────────────────────────┴───────────────────┘    │       │
│  │                                                                  │       │
│  │  ⚠️  Server CANNOT read payload contents                         │       │
│  │  ⚠️  Server has NO access to encryption key                      │       │
│  └──────────────────────────────────────────────────────────────────┘       │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
                                    │
                                    │ HTTPS
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                            CLIENT B (Download)                               │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  1. Download Operations (operation-log-download.service.ts)                 │
│     ┌──────────────────────────────────────────────────────────────┐        │
│     │ Received: { payload: "U2FsdGVkX1+abc123...",                 │        │
│     │            isPayloadEncrypted: true, ... }                   │        │
│     └──────────────────────────┬───────────────────────────────────┘        │
│                                │                                            │
│                                ▼                                            │
│  2. Decryption (operation-encryption.service.ts)                            │
│     ┌─────────────────────────────────────────────────────────────┐         │
│     │                                                             │         │
│     │  User Password: "mySecretPass123"  (same as Client A)       │         │
│     │         │                                                   │         │
│     │         ▼                                                   │         │
│     │  ┌─────────────────┐                                        │         │
│     │  │   Argon2id      │  Same key derivation                   │         │
│     │  │   + Salt        │  → Same 256-bit key                    │         │
│     │  └────────┬────────┘                                        │         │
│     │           │                                                 │         │
│     │           ▼                                                 │         │
│     │  ┌─────────────────┐                                        │         │
│     │  │   AES-256-GCM   │  Decrypt + verify integrity            │         │
│     │  │   Decrypt       │                                        │         │
│     │  └────────┬────────┘                                        │         │
│     │           │                                                 │         │
│     │           ▼                                                 │         │
│     │  Original Payload (JSON)                                    │         │
│     │  { actionPayload: { task: {...} }, entityChanges: [...] }   │         │
│     │                                                             │         │
│     └─────────────────────────┬───────────────────────────────────┘         │
│                               │                                             │
│                               ▼                                             │
│  3. Convert to Action (operation-converter.util.ts)                         │
│     ┌──────────────────────────────────────────────────────────────┐        │
│     │ extractActionPayload() → { task: {...}, isAddToBottom, ... } │        │
│     └──────────────────────────┬───────────────────────────────────┘        │
│                                │                                            │
│                                ▼                                            │
│  4. Dispatch Action (operation-applier.service.ts)                          │
│     ┌──────────────────────────────────────────────────────────────┐        │
│     │ { type: '[Task] Add Task',                                   │        │
│     │   task: { id: 'abc123', title: 'Buy milk', ... },            │        │
│     │   meta: { isPersistent: true, isRemote: true, ... } }        │        │
│     └──────────────────────────┬───────────────────────────────────┘        │
│                                │                                            │
│                                ▼                                            │
│  5. State Updated                                                           │
│     ┌──────────────┐                                                        │
│     │ Task appears │                                                        │
│     │ "Buy milk"   │                                                        │
│     └──────────────┘                                                        │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

## 关键组件

### 1. OperationEncryptionService

**位置：** `src/app/op-log/sync/operation-encryption.service.ts`

```typescript
// Encrypt before upload
async encryptOperation(op: SyncOperation, encryptKey: string): Promise<SyncOperation> {
  const payloadStr = JSON.stringify(op.payload);
  const encryptedPayload = await encrypt(payloadStr, encryptKey);
  return { ...op, payload: encryptedPayload, isPayloadEncrypted: true };
}

// Decrypt after download
async decryptOperation(op: SyncOperation, encryptKey: string): Promise<SyncOperation> {
  if (!op.isPayloadEncrypted) return op;
  const decryptedStr = await decrypt(op.payload, encryptKey);
  return { ...op, payload: JSON.parse(decryptedStr), isPayloadEncrypted: false };
}
```

### 2. 加密算法

**位置：** `src/app/pfapi/api/encryption/encryption.ts`

- **算法：** AES-256-GCM（Galois/Counter Mode）
- **密钥派生：** Argon2id（内存硬算法，抗 GPU 暴力破解）
- **Salt：** 每次加密随机 16 字节
- **IV：** 每次加密随机 12 字节
- **输出格式：** `salt || iv || ciphertext || authTag`（base64）

### 3. 上传集成

**位置：** `src/app/op-log/sync/operation-log-upload.service.ts`

```typescript
// Check if encryption is enabled
const privateCfg = await syncProvider.privateCfg.load();
const isEncryptionEnabled = privateCfg?.isEncryptionEnabled && !!privateCfg?.encryptKey;

// Encrypt if enabled
if (isEncryptionEnabled && encryptKey) {
  syncOps = await this.encryptionService.encryptOperations(syncOps, encryptKey);
}
```

### 4. 下载集成

**位置：** `src/app/op-log/sync/operation-log-download.service.ts`

```typescript
// Decrypt if encrypted
const hasEncryptedOps = ops.some((op) => op.isPayloadEncrypted);
if (hasEncryptedOps && encryptKey) {
  ops = await this.encryptionService.decryptOperations(ops, encryptKey);
}
```

## 配置存储

加密密码存储在**私有配置**（不参与同步）：

```
privateCfg: {
  isEncryptionEnabled: true,
  encryptKey: "user's password"  // Stored locally, never sent to server
}
```

## 安全属性

| 属性           | 保证                            |
| -------------- | ------------------------------- |
| **机密性**     | 服务端无法读取操作 payload 明文 |
| **完整性**     | GCM auth tag 可检测篡改         |
| **密钥安全**   | Argon2id 提高暴力破解成本       |
| **前向安全性** | 每条操作使用随机 IV             |
| **错误密码**   | 解密失败，操作会被拒绝          |

## 初始配置：密码对话框选择

在 SuperSync 初始配置时，应用会在弹窗前先**探测服务端**来决定显示哪个对话框：

```
DialogSyncInitialCfgComponent.save()
    │
    ▼
Save config + auth
    │
    ▼
Probe server: downloadOps(0, undefined, 1)
    │
    ├─── Server has encrypted ops ──► DialogEnterEncryptionPasswordComponent
    │    (isPayloadEncrypted=true)      (enter existing password)
    │
    ├─── Server empty or ───────────► DialogEnableEncryptionComponent
    │    unencrypted ops                (create new password)
    │
    └─── Probe fails ───────────────► DialogEnableEncryptionComponent
         (network/auth error)           (fallback; sync error handling
                                         catches mismatches later)
```

这样可避免第二台客户端接入时的“双弹窗困惑”：若不探测，会先弹“创建密码”，随后同步失败再弹“输入已有密码”。

**兜底机制：** 若探测结论因竞态等原因不准确，`sync-wrapper.service.ts` 中既有的 `_handleMissingPasswordDialog()` 与 `_promptSuperSyncEncryptionIfNeeded()` 会在后续同步中兜底。

## 错误密码处理

```
Client C (wrong password) tries to sync:
    │
    ▼
Download encrypted ops
    │
    ▼
Attempt decryption with wrong key
    │
    ▼
┌─────────────────────────────┐
│  DecryptError thrown        │
│  "Failed to decrypt payload"│
└─────────────────────────────┘
    │
    ▼
Operation NOT applied to state
Sync error shown in UI
```

## 快照加密

全量状态操作（backup import、repair）通过 snapshot 端点上传，但加密机制相同：

```typescript
// In operation-log-upload.service.ts
if (encryptKey) {
  state = await this.encryptionService.encryptPayload(state, encryptKey);
}
await syncProvider.uploadSnapshot(
  state,
  clientId,
  reason,
  vectorClock,
  schemaVersion,
  isPayloadEncrypted,
);
```
