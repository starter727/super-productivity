# SuperSync 服务器性能改进

日期：2026-05-14
状态：提案——阶段按顺序排列，使独立低风险成果先行落地，同时大型上传批处理工作并行进行。

范围源自对 `packages/super-sync-server/` 的审计，涵盖：上传处理、快照生成/重放、配额账户、加密操作处理、认证和部署默认值。

> **修订说明（审阅后）：** 阶段 0b、1、2 和 4 在子代理审阅暴露了原始草案中的设计问题后进行了收紧。具体而言：新用户的被遗忘的 `userSyncState.upsert`、批内重复 `op.id` 处理、多实体（`entityIds[]`）操作支持、全状态操作聚合 VC 写入以及配额回填中的 `pg_column_size` 对比 `computeOpStorageBytes` 不匹配。参见每个阶段了解修订方法。

---

## 阶段 0 — 快速成果（每个一个 PR，大多低风险）

### 0a. 加密操作部分索引（发现 #4）

- **新迁移：** `prisma/migrations/<ts>_add_encrypted_ops_partial_index/migration.sql`
  ```sql
  DROP INDEX CONCURRENTLY IF EXISTS "operations_user_id_server_seq_encrypted_idx";
  CREATE INDEX CONCURRENTLY "operations_user_id_server_seq_encrypted_idx"
    ON "operations"("user_id", "server_seq")
    WHERE "is_payload_encrypted" = true;
  ```
- **原因：** `snapshot.service.ts:1083` 和 `:1114` 在 seq 范围内执行 `count(*) WHERE is_payload_encrypted=true`。今天它扫描范围并过滤。使用部分索引，常见情况（用户无加密操作）变为空索引探测。
- **保持原样：** 现有的 `operations_user_id_full_state_server_seq_idx` 已覆盖 `snapshot.service.ts:1103` 处 `findFirst` 的 `op_type IN (...)` 过滤器。（那个 `findFirst` 还过滤了 `isPayloadEncrypted: false`，这不在部分索引谓词中——目前是一个廉价的索引扫描 + 标志重新检查，而非单次探测。不值得添加第二个部分索引。）
- **验证（部署后在 staging 上执行，不是 CI 合并门控）：** `EXPLAIN ANALYZE` 针对类似生产的分发需要填充数据库状态。在迁移应用后在 staging 上运行，对一个持有 0-100 个加密行的用户使用 1M 个操作；迁移后运行 `ANALYZE operations` 并记录预期计划。同时重新检查过滤 `isPayloadEncrypted: false` 的最新全状态 `findFirst` 路径；现有的全状态部分索引不包括该谓词，因此许多加密全状态行仍可能强制扫描时重新检查。

### 0b. 快照重放大小检查节奏（发现 #2）

- **文件：** `packages/super-sync-server/src/sync/services/snapshot.service.ts:879-900`
- **更改：** 将 `i % 1000 === 0 → JSON.stringify(state)` 替换为基于增量的记账，对全状态操作进行例外处理：
  - 在对 `replayOpsToState` 的每次调用之前（每个重放批次从 `generateSnapshot` 调用一次），计算一次 `baseBytes = Buffer.byteLength(JSON.stringify(initialState), "utf8")`。跟踪 `estimatedBytes = baseBytes` 和 `accumulatedDelta = 0`。
  - 在循环期间，为每个操作向 `accumulatedDelta` 添加一个廉价上界增量 = `Buffer.byteLength(JSON.stringify(payload || ""), "utf8")`。高估是安全的；删除贡献 0。
  - **例外处理：当操作是 `SYNC_IMPORT`、`BACKUP_IMPORT` 或 `REPAIR` 时**，该操作会整体替换状态。上界计数器否则会在擦除后继续累积并产生错误的"状态太大"抛出。应用此类操作后，强制进行一次真实测量：`estimatedBytes = Buffer.byteLength(JSON.stringify(state), "utf8")`，重置 `accumulatedDelta = 0`。
  - 当 `estimatedBytes + accumulatedDelta > 0.8 * MAX_REPLAY_STATE_SIZE_BYTES` 时触发真实测量（并重置 `accumulatedDelta`）。如果真实值仍超过上限则抛出。
- **迁移拆分操作：** `:935-952` 的内层循环可以将一个操作扇出到多个；"每操作增量 = byteLength(payload)" 仍然正确上界了增长（扇出负载总和 ≤ 状态增长）。无需特殊处理。
- **删除密集型退化：** 删除对边界贡献 0，但每次强制真实测量重新读取（现在更小的）真实大小并重置 `accumulatedDelta`，因此边界不会保持固定——大量导入后的删除密集型流最多触发少量额外测量，且仅当导入的基础本身已经接近上限时。对于正常数据实际上不可达；有符号增量记账不值得增加的复杂性。
- **原因：** 预先存在的每操作循环每 1000 个操作对多 MB 状态进行字符串化，因此 10 万个操作的重放在 60 秒 RepeatableRead 事务内执行了约 90 次完整字符串化。此更改后，10 万个操作的重放每 1 万个操作重放批次执行约 1 次（约 10 次），加上每个接受的全状态操作一次；并且因为增量边界是经过验证的高估，主导情况——一个小的/增量式重放，其边界保持在上限以下——执行**零**次（在原始的

### 4c. 多实例关注点

- `helm/supersync/values.yaml:193` 上限为 `maxReplicas: 1`，因此进程内 LRU 是安全的。显式注释，以便未来的多实例部署不会意外引入 30 秒撤销延迟。

### 4d. 测试

- 单元测试：撤销并替换使缓存失效；过期令牌仍然命中数据库；tokenVersion 不匹配通过；用户删除使缓存失效；passkey 恢复使缓存失效。
- 基准测试：1000 个顺序 `verifyToken` 调用——预期在热缓存上 p50 延迟下降约 10 倍。

---

## 横切关注点

- **合并顺序：** 0a、0b、0c、0d 可以按任何顺序落地，与阶段 1 设计并行进行。阶段 2 依赖于阶段 1（相同的代码路径）。阶段 3 是有条件的。阶段 4 是独立的。
- **先添加遥测：** 在阶段 1 落地之前，向 `uploadOps` 添加 `(opsInBatch, txDurationMs, dbRoundtrips)` 的结构化日志，以便我们能够量化成果。现有审计日志处理每操作决策；添加单条批次汇总行。
- **回填标志数据库自检：** 仅限环境的 `SUPERSYNC_PAYLOAD_BYTES_BACKFILL_COMPLETE=true` 标志由操作员信任。为防止过早翻转，服务器在 `batchUpload === true` 时在启动时运行一个廉价的 `EXISTS (SELECT 1 FROM operations WHERE payload_bytes = 0 LIMIT 1)` 探测，如果任何未回填的行存在则拒绝启动。
- **回填窗口期间的对账守卫：** `calculateStorageUsage` 返回一个 `hasUnbackfilledRows` 标志（通过对相同单次扫描的 `BOOL_OR(payload_bytes = 0)` 计算）。当标志为 true 时，`updateStorageUsage` 跳过 `users.storage_used_bytes` 写入，因此带有 `octet_length` 回退的近似 SUM 永远不会替换在回填期间精确维护的递增计数器。强制对账标记跨跳过保留，以便下一次调用（回填完成后）正确对账。
- **ADR：** 参见 `ARCHITECTURE-DECISIONS.md` 决策 #4（"RepeatableRead 下的批处理上传"）；已合并。
- **文档：** 如果记录了每操作循环，更新 `docs/sync-and-op-log/operation-log-architecture-diagrams.md` §上传路径。
- **Prisma migrate dev：** 记录包含 `CREATE INDEX CONCURRENTLY` 的迁移的影子数据库解决方法；`migrate deploy` 可以在生产环境中运行解决方法，但 `migrate dev` 将迁移 SQL 包装在 `CONCURRENTLY` 被禁止的事务中。
- **服务器 seq 精度：** 任何跨越 JavaScript 边界的原始 `last_seq` 读取必须硬性失败（如果不是安全整数），而不是盲目调用 `Number(...)`。
- **测试模式：** 代码库使用带有手写 mock 的 `vi.mock("../src/db", ...)`，而非 Prisma `$on("query")` 拦截器。测试计数断言必须在 mock 表面上使用 `vi.spyOn`。
- **范围外：** WebSocket 扇出、清理作业优化、passkey 路径。审计中未标记任何一个。

---

## 预估影响（大致数量级）

| 阶段 | 受影响的热路径 | 预期成果 | 风险 |
| --- | --- | --- | --- |
| 0a | 快照快速路径验证 | 消除**加密操作计数**的 seq 范围扫描；全状态 `findFirst` 重新检查不变 | 非常低 |
| 0b | 快照重放 | 大型重放上完整字符串化减少约 5-10 倍；常见小型/增量式重放上零（无回归） | 低 |
| 0c | 配额对账 | 跳过 blob 加载（数 MB） | 非常低 |
| 0d | 所有路由（内存余量） | 阻止快照上限附近的 OOM | 低（操作更改） |
| 1 | 上传（每个客户端批次） | 25 操作批次上数据库往返减少约 5 倍；`user_sync_state` 行锁定更短；即使在有争用下也正向吞吐量 | 中-高 |
| 2 | 配额对账（慢路径） | 移除 `pg_column_size` 表扫描；SUM 和计数器之间一致 | 中（模式 + 回填） |
| 3 | 快照上传内存 | 如果流式处理在分析中胜出，峰值堆降低约 30-40% | 中 |
| 4 | 每个请求的认证 | 热缓存上 p50 延迟下降约 10 倍 | 低 |
