# 安全秘密存储方案

**状态：已计划**

本方案取代了旧的仅同步凭据安全存储草案，并整合了更广泛的独立设计。目标是构建适用于所有应用管理秘密的安全存储架构：同步凭据、同步加密口令、问题提供者令牌/密码、插件配置秘密、插件 OAuth 令牌以及原生后台同步凭据。

## 核心权衡

将秘密移出同步状态是一个有意为之的 UX 权衡。

默认情况下，秘密变为设备本地存储。第二个客户端可以同步非敏感的配置元数据，但无法从同步中接收到原始令牌/密码。用户需要在每台客户端上重新输入、重新认证或解锁一个独立的便携保险库（portable vault）。

与当前"所有内容通过同步到达"的问题提供者凭据体验相比，这是一种退化，但这是更安全的默认选择，因为同步状态、操作日志操作、备份和保留的服务器历史记录不适合存放原始秘密。

UX 缓解措施：

- 保持提供者元数据同步，以便设置表单预填除缺失秘密之外的所有字段。
- 显示清晰的每设备状态："凭据已保存在此设备"、"凭据在此设备上缺失"、"安全存储不可用"。
- 从每个受影响的集成界面提供直接重新认证/重新输入操作。
- 为未来增加可选的便携加密保险库，供明确希望所选集成秘密在设备间移动的用户使用。

## 能否避免这一权衡？

不能完全避免。任何避免每设备重新输入的设计都必须同步或传输秘密、秘密加密密钥或足够恢复秘密的材料。这可以是合理的产品选择，但它会改变信任模型。

可行的替代方案：

- **便携加密保险库（portable encrypted vault）：** 同步加密的秘密数据块，要求用户在新设备上使用保险库口令、恢复密钥或已注册的设备密钥来解锁。这在每个设备一次解锁后能提供良好的多设备体验，但增加了密码/恢复 UX，并使使用弱保险库口令的用户面临离线暴力破解风险。
- **设备到设备保险库传输（device-to-device vault transfer）：** 一台受信任的现有设备为新设备加密保险库密钥，例如通过二维码或配对流程。当旧设备可用时，这是一个强有力的折中方案，但在所有设备丢失后无法帮助全新安装。
- **服务器辅助或账户派生保险库密钥（server-assisted/account-derived vault key）：** 从 SuperSync 登录/账户材料派生或解包保险库密钥。这是最流畅的 UX，但要么使服务器成为秘密恢复信任边界的一部分，要么在密码重置时产生严重的恢复问题。
- **操作系统云钥匙串（OS cloud keychain）：** 依赖 iCloud Keychain、Google 密码管理器或类似的平台设施。在平台生态内可能提供良好的 UX，但跨 Electron/Web/Android/iOS 难以统一，且不受 Super Productivity 同步语义控制。

推荐默认方案：

- 对同步凭据和同步加密口令使用设备本地存储。
- 将便携加密保险库作为选定集成秘密的明确选择加入（opt-in）选项。
- 将设备到设备保险库传输视为后续的 UX 改进。

## 后 V1——低摩擦便携保险库变体

对于更便宜、维护成本更低且无需新密码提示的改进（针对已使用同步端到端加密的用户），可使用现有的同步 E2EE 解锁材料来包装便携保险库密钥。

此变体的意图故意低于独立的保险库口令：

- 不需要新服务器。
- 不需要新密码、恢复密钥或单独的保险库账户。
- 如果同步 E2EE 被禁用，则不提供额外保护。
- 不会创建比现有同步加密口令更强的安全边界。
- 不得静默地为使用弱同步 E2EE 或已禁用同步 E2EE 的用户启用便携式同步秘密。

推荐行为：

- 将同步提供者凭据和同步加密口令保留在操作系统支持的设备本地存储中。不要将唯一的同步解锁密钥存储在依赖于同步解锁的保险库中。
- 对于同步的问题提供者和插件秘密，仅在普通应用状态中存储 `SecretRef` 元数据。
- 将实际秘密值存储在使用随机 `vaultDek` 加密的同步便携保险库记录中。
- 使用从现有同步 E2EE 材料派生的保险库包装密钥来包装 `vaultDek`：
  - 如果输入是用户口令，则使用 Argon2id（带每保险库盐值、版本化参数和域分离）派生包装密钥。
  - 如果输入是现有的高熵同步密钥，则使用 HKDF-SHA-256（带保险库专用盐值和 `info` 字符串，如 `super-productivity-portable-vault-v1`）派生独立的包装密钥。
  - 永远不要直接将同步内容加密密钥用作保险库包装密钥。
- 在本地存储一个由操作系统保护的 `vaultDek` 包装副本，以便在解锁后同一设备上无需重新输入。
## 秘密注册表

所有应用秘密在中央**秘密注册表（Secret Registry）**中声明。注册表定义：

- **秘密槽（slot）**：每个秘密由其 `ownerType`、`ownerId` 和 `field` 标识。
- **模式（schema）**：`password`（掩码）或 `token`（始终隐藏）。
- **标签（label）**：用户友好的秘密名称，用于占位符和提示。

注册表在以下场景中用作真相来源（source of truth）：

- 构建表单时：注册表中的秘密字段自动呈现为密码/token 输入，并应用相应的掩码规则。
- 秘密检索时：令牌重定向和 API 服务调用 `secret-service` 而非直接访问配置。
- 序列化时：注册表指导代码在写入同步、快照、备份、日志或隐私导出之前，对已知的秘密字段进行**编辑（redaction）**。

这是对 `SECRET_FIELD_KEYS` 常量的形式化和扩展，同时增加了类型安全性和对 `pluginConfig` 上下文的感知。

注册表条目的示例结构：

```typescript
interface SecretRegistryEntry {
  ownerType: 'issueProvider' | 'pluginConfig';
  ownerId: string;           // 问题提供者 ID 或插件 ID
  field: string;             // 配置中的键名
  schema: 'password' | 'token';
  label: string;
}
```

### 注册表结构

**文件**：`src/app/core/secret-storage/secret-registry.ts`

```typescript
export interface SecretRegistryEntry {
  ownerType: 'issueProvider' | 'pluginConfig';
  ownerId: string;
  field: string;
  schema: 'password' | 'token';
  label: string; // 例如 "GitHub Token"、"Jira Password"
}

// 按 ownerType 分组的扁平映射以加速查找
export type SecretRegistry = {
  [ownerType: string]: {
    [ownerId: string]: SecretRegistryEntry[];
  };
};
```

问题提供者注册表在源码中静态定义。

插件配置注册表在插件注册时动态构建，使用 `PluginConfigSchema` 中的 `schema: 'password'` 字段。

### 注册表配置

#### 内置问题提供者

在源码中声明。条目的 `field` 值必须与提供者配置模型中的属性名匹配。

```typescript
// 为每个问题提供者（GitHub、Jira、GitLab、Gitea、OpenProject、Redmine、CalDAV）声明
{
  ownerType: 'issueProvider',
  ownerId: 'GITHUB',
  field: 'authToken',
  schema: 'token',
  label: 'GitHub Token',
}
```

#### 插件配置

每个插件提供一个 `PluginConfigSchema`，其中字段可标注 `schema: 'password'`。插件系统在初始化时为其注册表条目。

```typescript
// 插件配置模式中的示例字段
{
  key: 'apiToken',
  type: 'string',
  schema: 'password',   // ← 触发器：此字段被注册为秘密
  label: 'API Token',
}
```

插件秘密覆盖了 `persistDataSynced()` 和 `persistDataLocal()` 的秘密编辑。当插件持久化数据时，运行时会编辑所有匹配注册表条目的字段。

## 设备本地秘密存储抽象

秘密存储在设备本地，永不参与同步。秘密被持久化到由平台原生安全存储支持的位置：

| 平台         | 机制                                                                                                                            |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| Electron     | `safeStorage` API，回退到 `basic-text`（加密后写入磁盘）                                                                        |
| Web 浏览器   | IndexedDB（加密派生密钥作为 OS 密钥链后备，会话密钥作为最坏情况回退）                                                           |
| Android      | `EncryptedSharedPreferences`（使用 Android KeyStore 主密钥加密）                                                                 |
| iOS          | Keychain Services                                                                                                               |

### 抽象：LocalSecretStore

新的服务层，提供对本地安全秘密存储的统一读写接口。

**文件**：`src/app/core/secret-storage/local-secret-store.service.ts`

```typescript
@Injectable({ providedIn: 'root' })
export class LocalSecretStore {
  // 按槽（slot）写入一个秘密
  async set(ownerType: string, ownerId: string, field: string, secret: string): Promise<void>;

  // 按槽读取秘密，如果不存在则返回 null
  async get(ownerType: string, ownerId: string, field: string): Promise<string | null>;

  // 按槽移除秘密
  async remove(ownerType: string, ownerId: string, field: string): Promise<void>;

  // 检查槽是否存在
  async has(ownerType: string, ownerId: string, field: string): Promise<boolean>;

  // 获取指定所有者的所有已填充槽的列表
  async getOwnedSlots(ownerType: string, ownerId: string): Promise<string[]>;
}
```

### 秘密引用：SecretRef

在普通（可同步）应用状态中，实际秘密值会被**秘密引用（SecretRef）**替换。

```typescript
interface SecretRef {
  type: 'secret-ref';
  ownerType: string; // 'issueProvider' 或 'pluginConfig'
  ownerId: string;   // 提供者或插件 ID
  field: string;     // 字段名
}
```

当配置被持久化到同步/操作日志/快照时，任何匹配已知秘密注册表条目的字段都会被 `SecretRef` 替换。这确保：

- 同步流、操作日志重放和备份文件**永远不会包含原始秘密值**。
- 同一设备的其他网页视图（例如通过 `localStorage` 或 IndexedDB 共享状态）无法在进程中读取秘密。
- 来自不同源或不同设备的插件无法解析其他 `SecretRef` 槽。

## 持久化路径

每个暴露秘密的操作都必须经过秘密存储。

### 当前路径：直接配置访问

```
config (sync) → service (直接使用 token) → API 调用
```

### 新路径：间接秘密检索

```
config (sync, 包含 SecretRef)
  ↓
Service → SecretService.resolve(config)
  ↓
SecretService → LocalSecretStore.get(ownerType, ownerId, field)
  ↓
LocalSecretStore → 平台安全存储
  ↓
原始秘密 → 返回给 Service
  ↓
Service → API 调用（使用原始秘密）
```

`SecretService` 提供便捷方法：

```typescript
@Injectable({ providedIn: 'root' })
export class SecretService {
  // 解析配置对象中的所有秘密字段，返回一个可以安全使用的配置副本
  async resolveForIssueProvider<T>(cfg: IssueProviderCfg): Promise<T>;

  // 解析单个秘密值
  async resolveSecret(ownerType: string, ownerId: string, field: string): Promise<string | null>;

  // 在 IssueProviderService 等初始化时调用，确保秘密可用
  async ensureSecret(ownerType: string, ownerId: string, field: string, secret: string): Promise<void>;
}
```

## 表单集成

问题提供者设置表单在 v1a 中从直接值切换为秘密引用。

### 当前表单行为

```typescript
// 当前：config 包含原始秘密
{
  authToken: 'ghp_abc123...',
}
```

### v1a 表单行为

```typescript
// v1a：同步配置包含 SecretRef
{
  authToken: { type: 'secret-ref', ownerType: 'issueProvider', ownerId: 'GITHUB', field: 'authToken' },
}
```

表单字段逻辑：

| 场景                       | 表单显示                                           | 用户操作               |
| -------------------------- | -------------------------------------------------- | ---------------------- |
| `SecretRef` + 本地秘密存在 | 字段显示为**已设置**（掩码占位符）                 | 可替换或清除           |
| `SecretRef` + 本地秘密缺失 | 字段显示**在此设备上缺失**（空白，标注设备名称）   | 可输入新的秘密         |
| 原始字符串值（迁移）       | 字段显示为**已设置**（掩码占位符）                 | 可替换或清除           |
| `null` / `undefined`       | 字段显示为空白（无秘密）                           | 可输入新的秘密         |

### 表单提交逻辑

```typescript
// 当用户提交表单时：
if (fieldIsUnchangedOrSentinel) {
  // 保持现有的 SecretRef（如有）
} else if (userClearedField) {
  // 从本地存储中删除秘密，将字段设为 null
  await localSecretStore.remove(ownerType, ownerId, field);
  configField = null;
} else if (userEnteredNewValue) {
  // 保存到本地存储，字段设为 SecretRef
  await localSecretStore.set(ownerType, ownerId, field, newValue);
  configField = { type: 'secret-ref', ownerType, ownerId, field };
}
```

### 掩码占位符

当字段包含 `SecretRef` 且本地密码存在时，表单显示一个**已知且已设置的值**的指示，使用一个独特的掩码令牌（例如 `__SECRET_SET__<hash>`）以避免与真实值混淆。向电源用户显示最后一个令牌字符，以帮助区分多个秘密。

### 缺失秘密的处理

当 `SecretRef` 存在但本地秘密缺失时（例如新设备、已清除浏览器数据）：

1. 表单显示："[秘密名称] 在此设备上缺失"
2. 支持操作："重新输入"、"重新认证"（如适用）
3. 当秘密被重新输入后，会创建一个新的本地秘密条目
4. 由于 SecretRef 已存在，可同步配置保持不变
