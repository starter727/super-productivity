# Operation Log：架构图总览

**最后更新：** 2025 年 12 月 17 日  
**状态：** 所有核心图均与当前实现一致

本文用于总览 Operation Log 系统图。实现细节请结合 [operation-log-architecture.md](./operation-log-architecture.md) 阅读。

---

## 1. 本地持久化与启动恢复（已实现）

该部分展示用户操作如何流入系统、如何写入 IndexedDB（`SUP_OPS`）、如何在启动时恢复（hydration）。

说明：原图与详解已拆分并翻译在以下文档中：

- [diagrams/01-local-persistence.md](./diagrams/01-local-persistence.md)

关键结论：

1. 写路径为 append-only op log + 快照缓存。
2. 启动恢复走 snapshot + tail ops 回放。
3. 归档数据走独立存储和独立处理器，不通过普通 effect 重放。

---

## 2. 服务端同步主架构（已实现）

该部分展示客户端同步循环、服务端 API、冲突检测、以及 PostgreSQL 持久化。

说明：完整图与表格已拆分并翻译在：

- [diagrams/02-server-sync.md](./diagrams/02-server-sync.md)

关键结论：

1. 客户端先下载后上传。
2. 冲突由向量时钟检测，LWW 自动解决。
3. 服务端在比较后分配序列并写入操作日志。

---

## 2b. Full-State 操作走 Snapshot 端点（已实现）

`SYNC_IMPORT`、`BACKUP_IMPORT`、`REPAIR` 可能超过普通 `/api/sync/ops` 体积限制，因此走 `/api/sync/snapshot`。

关键点：

1. Full-state 操作按 reason 映射（`initial` / `recovery`）。
2. 可选 E2E 加密后上传。
3. 服务端会生成可审计的合成操作记录。

关联图：

- [diagrams/02-server-sync.md](./diagrams/02-server-sync.md)

---

## 2c. SYNC_IMPORT 的 Clean Slate 过滤（已实现）

当收到 `SYNC_IMPORT`/`BACKUP_IMPORT`，系统把它视为“恢复到某个时间点”的显式动作：所有“不知道这次导入”的操作都应丢弃。

比较规则（向量时钟）：

- `GREATER_THAN` / `EQUAL`：保留
- `LESS_THAN` / `CONCURRENT`：丢弃

要点：

1. 采用向量时钟而不是 UUIDv7 时间戳，避免墙钟漂移误判。
2. 会同时检查当前批次与本地历史中的最新 import。

关联文档：

- [diagrams/03-conflict-resolution.md](./diagrams/03-conflict-resolution.md)
- [vector-clocks.md](./vector-clocks.md)

---

## 2d. LWW 自动冲突解决（已实现）

并发冲突（`CONCURRENT`）出现时自动走 LWW：

1. 比较双方向量时钟中的最大时间戳。
2. 时间戳更晚者胜；平局 remote 胜（保证收敛）。
3. 本地胜时会创建新的 UPDATE op 回传，确保其它客户端最终一致。

关联图与细节：

- [diagrams/03-conflict-resolution.md](./diagrams/03-conflict-resolution.md)

---

## 2e. Snapshot Skip 下载优化（已实现）

当服务端有可用快照且客户端 `sinceSeq` 落在快照之前时，服务端可直接跳过快照前操作，减少传输与回放成本。

关键点：

1. 响应会返回 `latestSnapshotSeq`。
2. 客户端据此更新后续增量下载边界。

关联图：

- [diagrams/02-server-sync.md](./diagrams/02-server-sync.md)

---

## 3. 多实体原子一致性（已实现）

一条动作影响多个实体时，使用 meta-reducer 在单个 reducer pass 内完成，生成一条含 `entityChanges[]` 的操作，避免“部分同步”。

关联图：

- [diagrams/05-meta-reducers.md](./diagrams/05-meta-reducers.md)

---

## 4. 文件型同步架构（已实现）

WebDAV/Dropbox/LocalFile 通过单个 `sync-data.json` 进行同步，文件中包含：

1. 全量状态快照
2. recent ops
3. 向量时钟与版本元数据

关联图：

- [diagrams/04-file-based-sync.md](./diagrams/04-file-based-sync.md)
- [file-based-sync-flowchart.md](./file-based-sync-flowchart.md)

---

## 5. SuperSync 与文件型 Provider 对比（已实现）

两者共享同一 Operation Log 核心，但在传输与版本治理上不同：

1. SuperSync：服务端序列号与 gap 返回。
2. File-based：客户端 `syncVersion` + ETag/rev 竞争与重试。

关联图：

- [diagrams/07-supersync-vs-file-based.md](./diagrams/07-supersync-vs-file-based.md)

---

## 6. 归档操作与副作用（已实现）

归档数据不在 NgRx 主状态中，采用独立存储与专用处理器：

1. 本地操作通过 `LOCAL_ACTIONS` 路由
2. 远端操作由 `OperationApplierService` 显式调用处理器
3. 双层防护避免归档任务“复活”

关联图：

- [diagrams/06-archive-operations.md](./diagrams/06-archive-operations.md)

---

## 7. 简化流程图入口

如果希望先看不带实现细节的流程：

- [diagrams/08-sync-flow-explained.md](./diagrams/08-sync-flow-explained.md)

---

## 快速导航

1. 先看 [README.md](./README.md)
2. 再看 [operation-rules.md](./operation-rules.md)
3. 然后按主题进入 `diagrams` 子目录

---

## 实现状态小结

- 本地持久化：完成
- 服务端同步：完成（同 schema 版本）
- 文件型同步：完成
- 冲突解决与导入过滤：完成
- 归档处理：完成

如需更深实现细节，可直接跳到：

- [operation-log-architecture.md](./operation-log-architecture.md)
- [quick-reference.md](./quick-reference.md)
