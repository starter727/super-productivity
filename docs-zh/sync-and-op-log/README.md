# Operation Log 文档

**最后更新：** 2026 年 1 月

本目录包含 Super Productivity 的 Operation Log 系统架构文档。这是一套基于事件溯源（event-sourced）的持久化与同步层，覆盖所有同步 Provider（SuperSync、WebDAV、Dropbox、LocalFile）。

## 快速开始

| 如果你想...         | 阅读这里                                                                       |
| ------------------- | ------------------------------------------------------------------------------ |
| 了解整体架构        | [operation-log-architecture.md](./operation-log-architecture.md)               |
| 查看可视化图        | [diagrams/](./diagrams/)（按主题拆分）                                         |
| 学习设计规则        | [operation-rules.md](./operation-rules.md)                                     |
| 理解文件型同步      | [diagrams/04-file-based-sync.md](./diagrams/04-file-based-sync.md)             |
| 理解 SuperSync 加密 | [supersync-encryption-architecture.md](./supersync-encryption-architecture.md) |

## 文档总览

### 核心文档

| 文档                                                             | 说明                                                                                                   | 状态 |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | ---- |
| [operation-log-architecture.md](./operation-log-architecture.md) | 完整架构参考，覆盖 A-F：本地持久化、文件型同步、服务端同步、校验与修复、智能归档处理、多实体原子一致性 | 活跃 |
| [diagrams/](./diagrams/)                                         | 按主题拆分的 Mermaid 图（本地持久化、服务端同步、文件同步等）                                          | 活跃 |
| [operation-rules.md](./operation-rules.md)                       | Operation Log 存储与操作定义的设计规则                                                                 | 活跃 |

### 同步架构

| 文档                                                                           | 说明                                                           | 状态   |
| ------------------------------------------------------------------------------ | -------------------------------------------------------------- | ------ |
| [diagrams/04-file-based-sync.md](./diagrams/04-file-based-sync.md)             | 基于单个 sync-data.json 的文件同步（WebDAV/Dropbox/LocalFile） | 已实现 |
| [diagrams/02-server-sync.md](./diagrams/02-server-sync.md)                     | SuperSync 服务端同步架构                                       | 已实现 |
| [supersync-encryption-architecture.md](./supersync-encryption-architecture.md) | SuperSync 端到端加密（AES-256-GCM + Argon2id）                 | 已实现 |

### 历史 / 已完成计划

| 文档                                                                                   | 说明                                          | 状态              |
| -------------------------------------------------------------------------------------- | --------------------------------------------- | ----------------- |
| [replace-pfapi-with-oplog-plan.md](./long-term-plans/replace-pfapi-with-oplog-plan.md) | 用 Operation Log 替换 PFAPI 以统一同步        | 已完成（2026-01） |
| [e2e-encryption-plan.md](./long-term-plans/e2e-encryption-plan.md)                     | 早期 E2EE 设计（实现见 supersync-encryption） | 已实现（2025-12） |

## 架构一览

Operation Log 系统是所有 Provider 的**统一同步系统**：

```
                         User Action
                              │
                              ▼
                         NgRx Store
                   (Runtime Source of Truth)
                              │
          ┌───────────────────┼───────────────────┐
          ▼                   │                   ▼
    OpLogEffects              │             Other Effects
          │                   │
          ├──► SUP_OPS ◄──────┘
          │    (Local Persistence - IndexedDB)
          │
          └──► Sync Providers
               ├── SuperSync (operation-based, real-time)
               ├── WebDAV (file-based, single-file snapshot)
               ├── Dropbox (file-based, single-file snapshot)
               └── LocalFile (file-based, single-file snapshot)
```

### 同步 Provider 类型

| Provider 类型 | Provider                   | 工作方式                                         |
| ------------- | -------------------------- | ------------------------------------------------ |
| **服务端型**  | SuperSync                  | 通过 HTTP API 上传/下载单条操作                  |
| **文件型**    | WebDAV、Dropbox、LocalFile | 单个 `sync-data.json`，包含状态快照 + recent ops |

### 核心部分

| 部分              | 目标                     | 说明                                              |
| ----------------- | ------------------------ | ------------------------------------------------- |
| **A. 本地持久化** | 快速写入、崩溃恢复       | 操作写入 IndexedDB（`SUP_OPS`），通过快照加速恢复 |
| **B. 文件型同步** | WebDAV/Dropbox/LocalFile | 单文件同步，包含状态快照与内嵌操作缓冲            |
| **C. 服务端同步** | 基于操作的同步           | 通过 SuperSync 服务上传/下载单条操作              |
| **D. 校验与修复** | 数据完整性               | Checkpoint 校验 + 自动修复 + REPAIR 操作          |

补充架构模式：

| 模式                  | 目标                                     |
| --------------------- | ---------------------------------------- |
| **E. 智能归档处理**   | 归档通过“指令”同步，而非同步归档数据本体 |
| **F. 原子状态一致性** | 通过 meta-reducer 保证多实体变更原子化   |

## 关键概念

### 事件溯源

Operation Log 将数据库视为**事件时间线**，而非可变状态容器：

- **Source of Truth**：日志才是真相；当前状态由日志回放得到
- **不可变性**：操作只追加，不修改
- **快照**：周期性快照加速恢复（snapshot + tail ops）

### 向量时钟

向量时钟用于冲突检测中的因果追踪：

- 每个客户端在向量时钟中有自己的计数器
- 比较结果：`EQUAL`、`LESS_THAN`、`GREATER_THAN`、`CONCURRENT`
- `CONCURRENT` 表示真实并发冲突，需要处理

### LOCAL_ACTIONS Token

带副作用的 effect（snackbar、外部 API、UI）必须注入 `LOCAL_ACTIONS`，而不是 `Actions`：

```typescript
private _actions$ = inject(LOCAL_ACTIONS); // Excludes remote operations
```

这样可避免远端同步操作触发重复副作用。

## 关键路径

### 同步 Provider

```
src/app/op-log/sync-providers/
├── super-sync/                     # SuperSync server provider
├── file-based/                     # File-based providers
│   ├── file-based-sync-adapter.service.ts  # Unified adapter for file providers
│   ├── file-based-sync.types.ts    # FileBasedSyncData types
│   ├── webdav/                     # WebDAV provider
│   ├── dropbox/                    # Dropbox provider
│   └── local-file/                 # Local file sync provider
├── provider-manager.service.ts     # Provider activation/management
├── wrapped-provider.service.ts     # Provider wrapper with encryption
└── credential-store.service.ts     # OAuth/credential storage
```

### 核心 Operation Log

```
src/app/op-log/
├── core/                           # Core types and operations
├── persistence/                    # IndexedDB storage
├── sync/                           # Sync orchestration
└── validation/                     # Data validation and repair
```

## 相关文档

| 位置                                                             | 内容                 |
| ---------------------------------------------------------------- | -------------------- |
| [vector-clocks.md](./vector-clocks.md)                           | 向量时钟实现细节     |
| [packages/super-sync-server/](../../packages/super-sync-server/) | SuperSync 服务端实现 |
| [background-info/](./background-info/)                           | 研究资料与最佳实践   |

## 实现状态

| 组件                 | 状态                                 |
| -------------------- | ------------------------------------ |
| 本地持久化（Part A） | 已完成                               |
| 文件型同步（Part B） | 已完成（WebDAV、Dropbox、LocalFile） |
| 服务端同步（Part C） | 已完成（SuperSync）                  |
| 校验与修复（Part D） | 已完成                               |
| 端到端加密           | 已完成（AES-256-GCM + Argon2id）     |
| PFAPI 移除           | 已完成（2026-01）                    |
| 跨版本同步（A.7.11） | 已文档化（尚未实现）                 |
| Schema 迁移          | 基础设施就绪（尚未定义迁移脚本）     |

详见 [operation-log-architecture.md#implementation-status](./operation-log-architecture.md#implementation-status)。
