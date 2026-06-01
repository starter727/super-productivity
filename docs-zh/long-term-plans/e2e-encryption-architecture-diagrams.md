# 端到端加密架构图

> **状态：已存档——仅作参考**
>
> 加密方案的对比分析。基于密码的加密方案已在 2025 年 12 月被选择并实现。

本文档提供了对比性的可视化架构图，比较当前基于密码的加密、提议的设备密钥方案以及推荐的改进方案。

---

## 1. 当前基于密码的加密（现有实现）

`mermaid
graph TD
    subgraph "客户端设备"
        A[用户输入密码] --> B[Argon2id KDF<br/>64MB, 3 次迭代]
        B --> C[派生的 AES-256 密钥<br/>不存储，按需计算]
        D[操作已创建] --> E[OperationEncryptionService]
        C --> E
        E --> F[使用 AES-GCM 加密<br/>每个操作随机 IV]
        F --> G[加密操作<br/>isPayloadEncrypted: true]
    end

    subgraph "网络"
        G -->|HTTPS| H[上传到服务器]
    end

    subgraph "SuperSync 服务器"
        H --> I[存储加密 Blob<br/>无法解密]
        I --> J[操作数据库<br/>Prisma + PostgreSQL]
    end

    subgraph "其他设备"
        J -->|HTTPS| K[下载加密操作]
        K --> L[用户输入相同密码]
        L --> M[Argon2id KDF<br/>相同参数]
        M --> N[派生相同 AES-256 密钥]
        N --> O[OperationEncryptionService]
        K --> O
        O --> P[解密操作]
        P --> Q[应用于本地状态]
    end

    style C fill:#90EE90
    style N fill:#90EE90
    style I fill:#FFB6C1
    style J fill:#FFB6C1

    classDef secure fill:#90EE90,stroke:#006400,stroke-width:2px
    classDef untrusted fill:#FFB6C1,stroke:#8B0000,stroke-width:2px
`

**关键特性：**

- ✓ 相同密码在所有设备上派生相同密钥
- ✓ 密钥从不存储，始终从密码计算
- ✓ 在 IndexedDB 删除后仍可存活（可通过密码重新派生）
- ✓ 服务器对密钥或明文一无所知
- ⚠️ 每台设备都需要输入密码

---

## 2. 提议的设备密钥方案（来自草案计划）

`mermaid
graph TD
    subgraph "主设备"
        A1[首次设置] --> B1[生成随机 256 位密钥<br/>WebCrypto API]
        B1 --> C1{用户选择：<br/>恢复密码？}
        C1 -->|是| D1[用户输入密码]
        C1 -->|否 - 跳过| E1[⚠️ 无恢复<br/>数据丢失风险]
        D1 --> F1[Argon2id KDF]
        F1 --> G1[用 KEK 加密密钥]
        G1 --> H1[上传加密密钥<br/>到服务器]
        B1 --> I1[将密钥存储在 IndexedDB 中<br/>⚠️ iOS 7 天后删除]
        I1 --> J1[加密操作]
    end

    subgraph "服务器问题"
        H1 --> K1{密钥冲突？<br/>❓ 未被检测}
        K1 -->|设备 A 上传| L1[存储 KeyA]
        K1 -->|设备 B 上传| M1[KeyB 覆盖<br/>💥 数据丢失]
    end

    subgraph "新设备 - QR 配对"
        N1[从主设备扫描 QR] --> O1{❓ 安全漏洞：<br/>MITM 保护？}
        O1 --> P1[接收主密钥<br/>⚠️ 易被拦截]
        P1 --> Q1[存储在 IndexedDB 中<br/>⚠️ iOS 7 天驱逐]
    end

    subgraph "新设备 - 恢复密码"
        R1[用户输入密码] --> S1[下载加密密钥]
        S1 --> T1[用 KEK 解密]
        T1 --> U1[存储在 IndexedDB 中<br/>⚠️ iOS 7 天驱逐]
    end

    subgraph "iOS Safari - 7 天后"
        I1 -.7 天.-> V1[💥 IndexedDB 自动删除]
        Q1 -.7 天.-> V1
        U1 -.7 天.-> V1
        V1 --> W1[所有数据丢失<br/>如果没有恢复密码]
    end

    style M1 fill:#FF6B6B
    style V1 fill:#FF6B6B
    style W1 fill:#FF6B6B
    style O1 fill:#FFD93D
    style K1 fill:#FFD93D

    classDef critical fill:#FF6B6B,stroke:#8B0000,stroke-width:3px
    classDef warning fill:#FFD93D,stroke:#FF8C00,stroke-width:2px
`

**关键问题：**

- 🔴 **阻碍 #1：** 不可导出密钥的矛盾（无法导出以进行备份）
- 🔴 **阻碍 #2：** QR 配对无 MITM 保护
- 🔴 **阻碍 #3：** iOS Safari 7 天后删除 IndexedDB
- 🔴 **阻碍 #4：** 密钥冲突导致静默数据丢失

---

## 3. 推荐的改进架构（三阶段计划）

### 阶段 1：安全加固（1 周）

`mermaid
graph TD
    A[用户输入密码<br/>≥2 个字符] --> B{zxcvbn<br/>强度检查}
    B -->|弱| C[❓ 拒绝密码<br/>建议改进]
    B -->|强| D[Argon2id KDF<br/>✓ 256MB, 4 次迭代<br/>📋 OWASP 2024]
    D --> E[派生的 AES-256 密钥<br/>暴力破解强度提升 5 倍]
    E --> F[加密操作]

    subgraph "XSS 保护 - 新增"
        G[内容安全策略] --> H[script-src 'self'<br/>子资源完整性]
        H --> I[✓ 防止代码注入]
    end

    style D fill:#90EE90
    style E fill:#90EE90
    style I fill:#90EE90

    classDef improved fill:#90EE90,stroke:#006400,stroke-width:2px
`

## 威胁模型

`mermaid
graph TD
    subgraph "已保护的威胁 ✓"
        T1[服务器数据库泄露] --> P1[✓ AES-256-GCM 加密<br/>服务器有密文但无密钥]
        T2[备份文件泄露] --> P2[✓ 相同保护<br/>数据有密钥保护]
        T3[暴力破解攻击] --> P3[✓ Argon2id 内存硬 KDF<br/>256MB, 4 次迭代]
        T4[XSS 注入] --> P4[✓ CSP + SRI 头<br/>阶段 1]
        T5[iOS 数据驱逐] --> P5[✓ 原生密钥链存储<br/>阶段 2]
    end

    subgraph "未保护的威胁 ⚠️"
        T6[弱密码] --> N1[⚠️ 用户选择密码<br/>由强度计缓解]
        T7[设备被盗] --> N2[⚠️ 解锁时密钥在内存中<br/>由自动锁缓解]
        T8[浏览器内存漏洞] --> N3[⚠️ Spectre/Meltdown<br/>超出范围]
        T9[恶意扩展] --> N4[⚠️ 可访问解密 API<br/>用户责任]
    end

    style P1 fill:#90EE90
    style P2 fill:#90EE90
    style P3 fill:#90EE90
    style P4 fill:#90EE90
    style P5 fill:#90EE90
    style N1 fill:#FFD93D
    style N2 fill:#FFD93D
    style N3 fill:#FFD93D
    style N4 fill:#FFD93D

    classDef protected fill:#90EE90,stroke:#006400,stroke-width:2px
    classDef limited fill:#FFD93D,stroke:#FF8C00,stroke-width:2px
`

---

## 8. 决策树：选择哪种方案

`mermaid
graph TD
    A{需要 E2E 加密？} -->|否| B[使用现有未加密同步]
    A -->|是| C{已经实现？}

    C -->|是 - 基于密码| D{安全性顾虑？}
    C -->|否 - 从头开始| E{用例类型？}

    D -->|Argon2id 参数弱| F[✓ 实施阶段 1<br/>升级参数、CSP<br/>1 周]
    D -->|iOS 数据丢失风险| G[✓ 实施阶段 2<br/>原生密钥链<br/>2 周]
    D -->|需要云恢复| H[✓ 实施阶段 3<br/>云备份<br/>3 周]
    D -->|都很好| I[保持当前系统]

    E -->|消息应用<br/>临时数据| J[考虑设备密钥<br/>WhatsApp 模型]
    E -->|生产力/密码管理器<br/>长期数据| K[✓ 使用基于密码<br/>1Password/Bitwarden 模型]
    E -->|仅文件同步| L[考虑每文件密钥<br/>Dropbox 模型]

    J --> M{能否修复 4 个阻碍？}
    M -->|能 - 3 周| N[可以继续使用设备密钥]
    M -->|否| K

    K --> F

    style F fill:#90EE90
    style G fill:#90EE90
    style H fill:#90EE90
    style K fill:#90EE90
    style M fill:#FF6B6B

    classDef recommended fill:#90EE90,stroke:#006400,stroke-width:2px
    classDef blocker fill:#FF6B6B,stroke:#8B0000,stroke-width:2px
`

---

## 9. 代码架构：当前 vs 提议

`mermaid
graph TB
    subgraph "当前实现（200 行）"
        A1[encryption.ts<br/>183 行] --> B1[AES-256-GCM<br/>Argon2id KDF]
        C1[operation-encryption.service.ts<br/>103 行] --> A1
        D1[credential-store.service.ts<br/>289 行] --> E1[IndexedDB<br/>密码存储]
    end

    subgraph "设备密钥计划（2000+ 行）"
        A2[DeviceKeyService<br/>~300 行 新增] --> B2[WebCrypto 密钥生成<br/>IndexedDB 存储]
        C2[CloudKeyBackupService<br/>~250 行 新增] --> D2[上传加密密钥<br/>用于 KEK 的 Argon2id]
        E2[QRPairingService<br/>~400 行 新增] --> F2[ECDH 协议<br/>视觉验证]
        G2[ConflictResolutionService<br/>~200 行 新增] --> H2[检测冲突<br/>用户解决 UI]
        I2[平台特定存储<br/>~300 行 新增] --> J2[iOS 密钥链<br/>Electron safeStorage]
        K2[5 个新对话框<br/>~500 行] --> L2[恢复设置<br/>QR 配对<br/>冲突解决]
    end

    subgraph "推荐计划（300 行）"
        A3[encryption.ts<br/>+5 行] --> B3[升级 Argon2id<br/>256MB, 4 次迭代]
        C3[secure-storage.service.ts<br/>~150 行 新增] --> D3[平台密钥链<br/>Capacitor/Electron]
        E3[encrypted-backup.service.ts<br/>~200 行 新增] --> F3[云备份<br/>可选的阶段 3]
    end

    style A1 fill:#90EE90
    style C1 fill:#90EE90
    style A2 fill:#FFB6C1
    style C2 fill:#FFB6C1
    style E2 fill:#FFB6C1
    style G2 fill:#FFB6C1
    style A3 fill:#90EE90
    style C3 fill:#ADD8E6
    style E3 fill:#ADD8E6

    classDef exists fill:#90EE90,stroke:#006400,stroke-width:2px
    classDef complex fill:#FFB6C1,stroke:#8B0000,stroke-width:2px
    classDef simple fill:#ADD8E6,stroke:#4682B4,stroke-width:2px
`

---

## 总结

### 当前系统 ✓

- **状态：** 可用，可投产
- **复杂度：** 低（200 行）
- **安全性：** 强（AES-256-GCM + Argon2id）
- **差距：** Argon2id 参数弱，无 iOS 弹性，无 CSP

### 设备密钥提案 ❓

- **状态：** 4 个关键阻碍
- **复杂度：** 高（2000+ 行）
- **安全性：** 强（修复阻碍后）
- **问题：** 15 周，高风险，解决不存在的问题

### 推荐计划 ✓

- **状态：** 增量改进
- **复杂度：** 中等（300 行）
- **安全性：** 最强（OWASP 2024 + 平台特性）
- **时间线：** 3-6 周，低风险

**最终建议：** 对现有基于密码的加密实施三阶段改进计划。不要追求设备生成的密钥。
