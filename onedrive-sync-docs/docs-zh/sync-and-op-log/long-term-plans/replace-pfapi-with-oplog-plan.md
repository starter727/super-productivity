# 计划：为所有 Provider 用 Operation Log Sync 替换 PFAPI

> **状态：已完成**（2026 年 1 月）
>
> 本计划已全部落地。整个 `src/app/pfapi/` 目录已删除。
> 所有同步 Provider 现已通过 `FileBasedSyncAdapter` 统一使用 operation log 系统。
>
> **当前实现：**
>
> - 同步 Provider：`src/app/op-log/sync-providers/`
> - 文件型适配器：`src/app/op-log/sync-providers/file-based/file-based-sync-adapter.service.ts`
> - 服务端迁移：`src/app/op-log/sync/server-migration.service.ts`

---

## 最初目标

通过移除 PFAPI 按模型逐个同步的实现，并对 **所有同步 Provider**（WebDAV、Dropbox、LocalFile）统一改用操作日志，来简化代码库。对现有用户需要迁移；旧 PFAPI 文件作为备份保留。

## 实际已实现内容

### 阶段 1：启用 Operation Log Sync（全部 Provider）- 已完成

所有 Provider 现在都使用 operation log 同步：

- WebDAV：`src/app/op-log/sync-providers/file-based/webdav/`
- Dropbox：`src/app/op-log/sync-providers/file-based/dropbox/`
- LocalFile：`src/app/op-log/sync-providers/file-based/local-file/`
- SuperSync：`src/app/op-log/sync-providers/super-sync/`

### 阶段 2：迁移逻辑 - 已完成

从旧 PFAPI 格式的迁移由 `ServerMigrationService` 处理：

- 检查远端是否存在 PFAPI 元数据文件
- 下载完整状态并创建 `SYNC_IMPORT` 操作
- 通过 operation log 上传初始快照

### 阶段 3：移除 PFAPI 代码 - 已完成

整个 `src/app/pfapi/` 目录已删除（约 83 个文件，2.0 MB）。

保留内容（并迁移到 op-log）：

- Provider 实现（WebDAV、Dropbox、LocalFile）
- 加密/压缩工具
- 认证流程

### 阶段 4：测试与清理 - 已完成

- 通过 E2E 测试覆盖多设备同步场景
- 完成迁移测试
- 验证大体量 operation log 处理
- 所有测试通过

## 最终架构

```
src/app/op-log/
├── sync-providers/
│   ├── super-sync/                 # 服务端同步
│   ├── file-based/                 # 文件型 Provider
│   │   ├── file-based-sync-adapter.service.ts
│   │   ├── webdav/
│   │   ├── dropbox/
│   │   └── local-file/
│   ├── provider-manager.service.ts
│   └── wrapped-provider.service.ts
├── sync/
│   ├── operation-log-sync.service.ts
│   └── server-migration.service.ts
└── ...
```

## 已做的关键决策

- 使用单文件同步格式（`sync-data.json`）：状态快照 + recent ops
- 采用基于 `syncVersion` 计数器的乐观锁
- 使用 piggybacking 机制处理并发同步
- 由服务迁移模块处理旧 PFAPI 数据迁移
