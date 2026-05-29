# 文件型同步流程图（Mermaid）

该图展示文件型 Provider（Dropbox、WebDAV、LocalFile）的同步决策树。SuperSync 对应流程见 [supersync-scenarios-flowchart.md](./supersync-scenarios-flowchart.md)。

两者共享同一套 op-log 基础设施（`OperationLogSyncService`、`RemoteOpsProcessingService`、冲突检测），差异主要在传输层/适配器层。

```mermaid
flowchart TD
    START([Sync Triggered]) --> DL[Download sync-data.json<br/>gap detection handled internally]

    %% ── SERVER MIGRATION (file-based specific) ──────────────────
    DL --> MIG_CHK{Server migration?<br/>gap + empty server}
    MIG_CHK -->|Yes| MIGRATION[Server migration:<br/>handleServerMigration<br/>creates SYNC_IMPORT]
    MIG_CHK -->|No| DECRYPT

    %% ── DECRYPTION (shared with SuperSync) ────────────────────────
    DECRYPT{Encrypted?}
    DECRYPT -->|Yes| DECRYPT_OK{Decryption succeeds?}
    DECRYPT -->|No| SNAPSHOT_CHK
    DECRYPT_OK -->|Yes| SNAPSHOT_CHK
    DECRYPT_OK -->|No password configured| NO_PWD_DLG[Enter Password dialog:<br/>Save & Sync / Force Overwrite / Cancel]
    DECRYPT_OK -->|Wrong password| WRONG_PWD_DLG[Decrypt Error dialog:<br/>Save & Sync / Use Local / Cancel]
    NO_PWD_DLG -->|Save & Sync| START
    NO_PWD_DLG -->|Force Overwrite| FORCE_UP[Force upload local state<br/>SYNC_IMPORT]
    WRONG_PWD_DLG -->|Save & Sync| START
    WRONG_PWD_DLG -->|Use Local| FORCE_UP

    %% ── SNAPSHOT vs INCREMENTAL BRANCH (file-based specific) ────
    SNAPSHOT_CHK{snapshotState<br/>received?<br/>seq 0 download only}
    SNAPSHOT_CHK -->|Yes| SS_OPS
    SNAPSHOT_CHK -->|No| HAS_OPS

    %% ── SNAPSHOT PATH (file-based specific) ─────────────────────
    SS_OPS{Has meaningful<br/>unsynced ops?}
    SS_OPS -->|Yes| SS_CONFLICT[SyncConflictDialog:<br/>USE_LOCAL / USE_REMOTE / CANCEL]
    SS_OPS -->|No| SS_FRESH{Fresh client?}
    SS_FRESH -->|Yes + meaningful<br/>store data| SS_CONFLICT
    SS_FRESH -->|Yes + no local data| SS_CONFIRM[Confirm dialog:<br/>Download remote?]
    SS_FRESH -->|Not fresh| HYDRATE
    SS_CONFLICT -->|Use Local| FORCE_UP
    SS_CONFLICT -->|Use Remote| FORCE_DL[Force download<br/>from seq 0]
    SS_CONFLICT -->|Cancel| CANCELLED([Sync Cancelled])
    SS_CONFIRM -->|OK| HYDRATE[Hydrate from<br/>snapshotState]
    SS_CONFIRM -->|Cancel| CANCELLED
    HYDRATE --> UPLOAD

    %% ── INCREMENTAL OPS PATH (shared logic) ────────────────────
    HAS_OPS{Remote ops found?}

    %% No remote ops
    HAS_OPS -->|No| EMPTY_SVR{Empty server<br/>+ fresh client<br/>+ has local data?}
    EMPTY_SVR -->|Yes| SILENT_MIG[Silent server migration<br/>creates SYNC_IMPORT]
    EMPTY_SVR -->|No| UPLOAD
    SILENT_MIG --> UPLOAD

    %% Has remote ops
    HAS_OPS -->|Yes| IS_FRESH{Fresh client?}
    IS_FRESH -->|No| IS_IMPORT
    IS_FRESH -->|Yes + has local data| CONFLICT_DLG[SyncConflictDialog:<br/>USE_LOCAL / USE_REMOTE / CANCEL]
    IS_FRESH -->|Yes + no local data| CONFIRM[Confirm dialog:<br/>Download remote?]
    CONFIRM -->|OK| APPLY
    CONFIRM -->|Cancel| CANCELLED
    CONFLICT_DLG -->|Use Local| FORCE_UP
    CONFLICT_DLG -->|Use Remote| FORCE_DL
    CONFLICT_DLG -->|Cancel| CANCELLED

    %% SYNC_IMPORT handling (shared logic)
    IS_IMPORT{Contains SYNC_IMPORT?}
    IS_IMPORT -->|No| CONFLICT_CHK
    IS_IMPORT -->|Yes| ENC_ONLY{Encryption-only change<br/>+ no pending ops?}
    ENC_ONLY -->|Yes| APPLY
    ENC_ONLY -->|No| IMPORT_HAS{Has pending ops<br/>or meaningful<br/>local data?}
    IMPORT_HAS -->|Yes| IMPORT_DLG[ImportConflictDialog:<br/>import reason shown,<br/>Use Server Data recommended]
    IMPORT_HAS -->|No| APPLY_IMPORT[Apply full state replacement]
    IMPORT_DLG -->|Use Server| FORCE_DL
    IMPORT_DLG -->|Use Local| FORCE_UP
    IMPORT_DLG -->|Cancel| CANCELLED

    %% Conflict detection (shared logic)
    CONFLICT_CHK{Vector clock conflict?} -->|CONCURRENT| LWW[Auto-resolve LWW<br/>later timestamp wins<br/>ties → remote wins<br/>archive ops always win]
    CONFLICT_CHK -->|No conflict| APPLY
    LWW --> APPLY[Apply ops to NgRx store]
    APPLY_IMPORT --> UPLOAD

    %% ── UPLOAD PHASE (file-based specific) ─────────────────────
    APPLY --> UPLOAD[Upload: merge state<br/>into sync-data.json]
    UPLOAD --> REV{Rev match<br/>on upload?}
    REV -->|OK| IN_SYNC([IN_SYNC ✓])
    REV -->|Mismatch| RETRY[Exponential backoff:<br/>re-download, rebuild,<br/>re-upload]
    RETRY --> RETRY_CHK{Max retries?}
    RETRY_CHK -->|Not exceeded| REV
    RETRY_CHK -->|Exceeded| ERROR

    FORCE_UP --> IN_SYNC
    FORCE_DL --> IN_SYNC
    MIGRATION --> IN_SYNC
    ERROR([ERROR])

    %% Styling
    classDef success fill:#2d6,stroke:#1a4,color:#fff
    classDef error fill:#d33,stroke:#a11,color:#fff
    classDef cancel fill:#888,stroke:#555,color:#fff
    classDef dialog fill:#48f,stroke:#26d,color:#fff
    classDef action fill:#e90,stroke:#b60,color:#fff,stroke-width:3px

    class IN_SYNC success
    class ERROR error
    class CANCELLED cancel
    class SS_CONFIRM,CONFIRM,SS_CONFLICT,CONFLICT_DLG,IMPORT_DLG,NO_PWD_DLG,WRONG_PWD_DLG dialog
    class APPLY,APPLY_IMPORT,FORCE_UP,FORCE_DL,MIGRATION,UPLOAD,SILENT_MIG,HYDRATE,RETRY action
```

## 错误处理（SyncWrapperService）

同步期间抛出的错误由 `SyncWrapperService._sync()` 捕获。文件型 Provider 会暴露一些 SuperSync 不会出现的错误类型：

```mermaid
flowchart LR
    ERR([Error thrown<br/>during sync]) --> TYPE{Error type?}

    TYPE -->|DecryptNoPasswordError| PWD_DLG[Enter Password dialog]
    TYPE -->|DecryptError| DEC_DLG[Decrypt Error dialog]
    TYPE -->|LocalDataConflictError| CONF_DLG[SyncConflictDialog]
    TYPE -->|RevMismatchForModelError<br/>NoRemoteModelFile| INC_DLG["Incomplete sync" dialog:<br/>Force Upload / Force Download]
    TYPE -->|SyncInvalidTimeValuesError| TIME_DLG["Incoherent timestamps" dialog:<br/>Force Upload / Force Download]
    TYPE -->|LockPresentError| LOCK[Snackbar + Force Overwrite action]
    TYPE -->|PotentialCorsError| CORS[CORS error snackbar]
    TYPE -->|AuthFail / MissingCredentials| AUTH[Auth error snackbar<br/>+ Configure action]
    TYPE -->|WebCryptoNotAvailable| CRYPTO[WebCrypto snackbar]
    TYPE -->|Timeout| TIMEOUT[Timeout error snackbar]
    TYPE -->|Permission error| PERM[Permission error snackbar]
    TYPE -->|Other| GENERIC[Generic error snackbar]

    classDef dialog fill:#48f,stroke:#26d,color:#fff
    classDef snack fill:#f90,stroke:#b60,color:#fff

    class PWD_DLG,DEC_DLG,CONF_DLG,INC_DLG,TIME_DLG dialog
    class LOCK,CORS,AUTH,CRYPTO,TIMEOUT,PERM,GENERIC snack
```

**图例：**

- 🟢 绿色 = 成功状态
- 🔴 红色 = 错误状态
- 🔵 蓝色 = 面向用户的对话框
- 🟠 橙色 = 关键动作（状态变更、上传、下载）
- ⚫ 灰色 = 取消/禁用

## 与 SuperSync 的主要差异

| 维度               | File-Based（Dropbox/WebDAV/LocalFile）                                                                                  | SuperSync                             |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------- | ------------------------------------- |
| **传输方式**       | 下载/上传单个 `sync-data.json` 文件                                                                                     | 分页 API（服务端 op log）             |
| **快照路径**       | seq=0 下载会带完整 `snapshotState`，且有独立冲突分支                                                                    | 无快照概念，全部增量 ops              |
| **Gap 检测**       | 适配器检测 syncVersion 重置/快照替换/部分裁剪 → 从 seq=0 重拉                                                           | 服务端内部处理 gap                    |
| **服务端迁移**     | 空服务器 gap → `needsFullStateUpload` → `handleServerMigration()`                                                       | 同概念，不同触发机制                  |
| **上传重试**       | 基于 rev（ETag）匹配 + 指数退避抖动                                                                                     | 服务端拒绝码（`CONFLICT_CONCURRENT`） |
| **Piggybacking**   | 不适用（无服务端 piggyback）；并发变更在重试重下载时发现                                                                | 上传响应直接返回 piggybacked ops      |
| **同步后加密提示** | 不适用                                                                                                                  | 会提示设置密码或关闭同步              |
| **文件型特有错误** | `RevMismatchForModelError`、`NoRemoteModelFile`、`SyncInvalidTimeValuesError`、`LockPresentError`、`PotentialCorsError` | 不适用                                |

## 备注

- `Enter Password` 与 `Decrypt Error` 分别对应 `DecryptNoPasswordError` 和 `DecryptError`，是两个不同组件，选项也不同。
- `Encryption-only change` 旁路：当 incoming `SYNC_IMPORT` 的 `syncImportReason === 'PASSWORD_CHANGED'` 且没有有意义 pending ops 时，跳过冲突对话框（数据相同，仅加密状态变化）。
- LWW 平局规则：时间戳相同则 remote 胜。`moveToArchive` 无论时间戳都优先胜出。
- Gap 检测触发：
  1. syncVersion 重置（其他客户端上传快照导致计数器重置）
  2. 快照替换（`recentOps` 为空但有 `state` 且 `clientId` 变化）
  3. 部分裁剪（`oldestOpSyncVersion > sinceSeq` 且缓冲区已满）
- 上传重试公式：`base × 2^(attempt-1) + random(0..50%)`，最大重试次数由 `FILE_BASED_SYNC_CONSTANTS.MAX_UPLOAD_RETRIES` 控制。

## 关键源码文件

| 文件                                                                          | 角色                                          |
| ----------------------------------------------------------------------------- | --------------------------------------------- |
| `src/app/imex/sync/sync-wrapper.service.ts`                                   | 顶层编排 + 错误处理                           |
| `src/app/op-log/sync/operation-log-sync.service.ts`                           | 下载/上传编排、新客户端检测、SYNC_IMPORT 处理 |
| `src/app/op-log/sync/operation-log-download.service.ts`                       | 下载与内部 gap 检测                           |
| `src/app/op-log/sync-providers/file-based/file-based-sync-adapter.service.ts` | 文件适配器（rev 匹配、gap 检测、快照上传）    |
