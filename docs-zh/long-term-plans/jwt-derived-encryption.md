# JWT 派生加密（JWT-Derived Encryption）用于 SuperSync

> **状态：已归档 – 已被取代**
>
> JWT 派生密钥不适合使用，原因是令牌刷新会导致加密密钥失效。已改用基于密码的加密——请参阅 `../sync-and-op-log/supersync-encryption-architecture.md`。

## 目标

为不愿输入密码的懒用户提供自动化的"静态加密（encryption at rest）"。此举可在保持零用户体验摩擦的同时，防范数据库泄露。

**安全模型（Security Model）：**
| 威胁 | 是否受保护？ |
|--------|------------|
| 数据库转储/泄露 | 是 |
| 备份文件被盗 | 是 |
| 服务器运维人员 | 否（可使用 `JWT_SECRET` 解密） |

---

## 关键问题：JWT 不稳定性

**所有 5 位评审均将此标记为阻塞项。**

该计划提议使用 `SHA-256(jwt)` 作为加密密钥。然而：

1. JWT 可以被刷新（新签名 = 新密钥）
2. 重新登录会产生不同的 JWT
3. 令牌过期会使密钥失效

**结果：** 用户在令牌刷新后，已加密数据将永久不可读。

### 解决方案：首次启用时存储派生密钥（Derived Key）

不在每次使用时从当前 JWT 派生密钥，而是：

```typescript
// 首次启用自动加密时：
const derivedKey = await crypto.subtle.digest('SHA-256', encoder.encode(jwt));
const keyAsBase64 = btoa(String.fromCharCode(...new Uint8Array(derivedKey)));

// 存储此派生密钥，而非 JWT
await provider.setConfig({
  isAutoEncryptionEnabled: true,
  autoEncryptionKey: keyAsBase64, // 跨令牌刷新保持稳定
});

// 后续操作中使用存储的密钥
```

这确保了：

- 密钥在令牌刷新间保持稳定
- 多设备可用（所有设备从初始 JWT 获得相同的派生密钥）
- 重新登录时不会丢失数据

---

## 实施计划

### 第一阶段：模型与配置（1 天）

**文件：**

- `packages/sync-providers/src/super-sync/super-sync.model.ts`
- `src/app/features/config/global-config.model.ts`

**变更：**

```typescript
// super-sync.model.ts
export interface SuperSyncPrivateCfg extends SyncProviderPrivateCfgBase {
  // ... 现有字段 ...

  /** 自动加密是否启用（JWT 派生，非密码短语） */
  isAutoEncryptionEnabled?: boolean;

  /** 存储的派生密钥（base64）。首次启用时设置一次，跨会话保持稳定 */
  autoEncryptionKey?: string;
}
```

### 第二阶段：加密函数（0.5 天）

**文件：** `packages/sync-core/src/encryption.ts`

**新增：**

```typescript
/**
 * 用于高熵输入（JWT 派生密钥）的快速密钥派生。
 * 由于 JWT 已有 256 位以上的熵，故跳过 Argon2id。
 */
export const deriveKeyFromHighEntropy = async (
  keyMaterial: string,
): Promise<DerivedKeyInfo> => {
  const encoder = new TextEncoder();
  const data = encoder.encode(keyMaterial);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);

  // 使用固定盐值，因为密钥材料已是高熵
  const salt = new Uint8Array(SALT_LENGTH).fill(0);

  const key = await crypto.subtle.importKey(
    'raw',
    hashBuffer,
    { name: ALGORITHM },
    false,
    ['encrypt', 'decrypt'],
  );

  return { key, salt };
};
```

**与现有函数的集成：**

- 现有的 `encrypt(data, password)` 和 `decrypt(data, password)` 使用 Argon2id
- 新增 `encryptWithDerivedKey(data, derivedKeyInfo)` 用于预派生密钥
- `operation-encryption.service.ts` 需要新增一个用于自动加密的代码路径

### 第三阶段：SuperSync Provider（1 天）

**文件：** `src/app/op-log/sync-providers/super-sync/super-sync.ts`

**修改 `getEncryptKey()`：**

```typescript
async getEncryptKey(): Promise<string | undefined> {
  const cfg = await this.privateCfg.load();
  if (!cfg) return undefined;

  // 现有密码短语加密优先
  if (cfg.isEncryptionEnabled && cfg.encryptKey) {
    return cfg.encryptKey;
  }

  // 自动加密使用存储的派生密钥
  if (cfg.isAutoEncryptionEnabled && cfg.autoEncryptionKey) {
    return cfg.autoEncryptionKey;
  }

  return undefined;
}
```

### 第四阶段：启用/禁用服务（1 天）

**新文件：** `src/app/imex/sync/auto-encryption-enable.service.ts`

**流程：**

1. 从当前 JWT 派生密钥：`SHA-256(accessToken)`
2. 将派生密钥作为 `autoEncryptionKey` 存储到配置中
3. 设置 `isAutoEncryptionEnabled: true`
4. 删除所有服务器数据（加密与未加密数据不能混存）
5. 使用加密上传当前状态

**复用现有模式来自：**

- `encryption-enable.service.ts`（第 16–80 行）
- `encryption-disable.service.ts`

### 第五阶段：UI 集成（1 天）

**文件：** `src/app/features/config/form-cfgs/sync-form.const.ts`

**在 SuperSync 高级设置中新增开关：**

```typescript
{
  key: 'isAutoEncryptionEnabled',
  type: 'checkbox',
  hideExpression: (model: any) => model.isEncryptionEnabled, // 密码短语启用时隐藏此项
  templateOptions: {
    label: T.F.SYNC.FORM.SUPER_SYNC.AUTO_ENCRYPTION,
    description: T.F.SYNC.FORM.SUPER_SYNC.AUTO_ENCRYPTION_DESC,
  },
}
```

## 所涉及文件汇总

### 涉及的文件

| 文件                                                              | 变更                                 |
| ----------------------------------------------------------------- | ------------------------------------ |
| `packages/sync-core/src/encryption.ts`                            | 新增 `deriveKeyFromHighEntropy`      |
| `packages/sync-providers/src/super-sync/super-sync.model.ts`      | 新增配置字段                        |
| `src/app/op-log/sync-providers/super-sync/super-sync.ts`          | 修改 `getEncryptKey()`               |
| `src/app/op-log/sync/operation-encryption.service.ts`             | 支持预派生密钥                       |
| `src/app/features/config/form-cfgs/sync-form.const.ts`            | 新增 UI 开关                         |
| `src/app/features/config/global-config.model.ts`                  | 向 `SuperSyncConfig` 添加 `isAutoEncryptionEnabled` |
| `src/app/imex/sync/auto-encryption-enable.service.ts`             | 新建：启用流程                       |
| `src/app/imex/sync/auto-encryption-disable.service.ts`            | 新建：禁用流程                       |
| `src/assets/i18n/en.json`                                         | 添加翻译键                           |
| `src/app/t.const.ts`                                              | 添加翻译常量                         |

---

## 边界情况与错误处理

### 1. 解密失败（例如密钥不匹配）

**当前行为：** 显示密码对话框（对自动加密不适用）

**需要变更：** 检测自动加密模式并显示适当的错误信息：

```
"无法解密同步数据。您的加密密钥可能无效。
选项：
[重新启用自动加密] - 使用新密钥上传本地数据
[取消]"
```

**文件：** `src/app/imex/sync/dialog-handle-decrypt-error/dialog-handle-decrypt-error.component.ts`

### 2. 在加密模式之间切换

| 从        | 到        | 操作                           |
| --------- | --------- | ------------------------------ |
| 无        | 自动      | 删除服务器数据，以加密上传     |
| 自动      | 无        | 删除服务器数据，以未加密上传   |
| 自动      | 密码短语  | 删除服务器数据，以密码短语上传 |
| 密码短语  | 自动      | 删除服务器数据，以自动密钥上传 |

所有情况都需要清空状态（代码库中已有此模式）。

### 3. 多设备首次同步

当新设备首次使用自动加密同步时：

1. 下载已加密的操作
2. 从 JWT 派生密钥：`SHA-256(accessToken)`
3. 尝试解密
4. 若成功：在本地存储派生密钥
5. 若失败：显示错误（不同账号？）

---

## 所需测试

### 单元测试（Unit Tests）

**`encryption.ts`：**

```typescript
describe('deriveKeyFromHighEntropy', () => {
  it('应能根据相同输入派生出一致的密钥');
  it('应能根据不同输入派生出不同的密钥');
  it('执行速度应较快（小于 10ms）');
});
```

**`super-sync.ts`：**

```typescript
describe('getEncryptKey 自动加密模式', () => {
  it('应在 isAutoEncryptionEnabled 启用时返回 autoEncryptionKey');
  it('应优先使用密码短语而非自动加密');
  it('应在两者均未启用时返回 undefined');
});
```

### 集成测试（Integration Tests）

```typescript
describe('自动加密流程', () => {
  it('应在上传时加密操作');
  it('应在下载时解密操作');
  it('应能在令牌刷新后正常工作（密钥稳定）');
});
```

### E2E 测试（E2E Tests）

```typescript
describe('SuperSync 自动加密', () => {
  it('应能通过设置启用自动加密');
  it('应能将加密数据同步到服务器');
  it('应能在同一账号的第二台设备上解密');
});
```

---

## 验证清单

1. [ ] 在设备 A 上启用自动加密
2. [ ] 创建任务，验证其同步正常
3. [ ] 检查服务器数据库 —— 负载为加密后的二进制块
4. [ ] 在设备 A 上刷新 JWT 令牌
5. [ ] 验证同步仍然正常（密钥稳定）
6. [ ] 使用同一账号登录设备 B
7. [ ] 验证数据同步并能正确解密
8. [ ] 在设备 A 上禁用自动加密
9. [ ] 验证服务器数据现为未加密状态
10. [ ] 验证设备 B 检测到变更并更新

---

## 安全考量

### 本方案防范的内容

- 数据库转储（无密钥时加密二进制块毫无用处）
- 备份文件泄露
- 通过 SQL 注入读取数据

### 本方案不防范的内容

- 拥有 JWT_SECRET 访问权限的服务器运维人员
- HTTPS 被攻破时的中间人攻击（Man-in-the-middle）
- 客户端令牌窃取

### 为何这一方案是可接受的

- 目标用户是不愿使用密码短语的"懒用户"
- "静态加密"相较于无加密已是实质性的安全改进
- 需要真正端到端加密（E2E）的用户仍可使用密码短语加密
- 安全模型诚实且已文档化

---

## 未来探索：设备绑定密钥（Device-Bound Key）

对于希望无需密码短语即实现真正端到端加密的用户，可探索以下方案：

1. **存储在 IndexedDB 中的随机密钥**
   - 风险：浏览器数据清除后会丢失
   - 需要：导出/导入流程

2. **Electron 钥匙串集成（Electron keychain integration）**
   - 更持久的存储
   - 平台特定的实现

3. **Passkey PRF 扩展**
   - 零用户体验摩擦的真正端到端加密
   - 浏览器支持有限（2025 年）

这些内容不在初始实施范围内，但值得进一步探索。
