# SuperSync 服务器分解实施方案（v2）

> **给 Claude：** 必选子技能：使用 superpowers:executing-plans 逐任务执行此计划。

**目标：** 将三个庞大的 SuperSync 服务器文件（`sync.service.ts` 2322 LOC、`sync.routes.ts` 1475 LOC、`services/snapshot.service.ts` 1215 LOC）拆分为内聚的、单一职责的模块，而不改变行为、HTTP/线路契约或数据库模式。

**架构：** `SyncService` / `SnapshotService` 保持为薄的编排**门面**，其公共 API 不变。繁重的内聚集群移入新的协作者。纯逻辑（操作重放、冲突比较）成为无 Prisma 的顶层模块，拥有自己的快速单元测试。淘汰折叠入现有的 `StorageQuotaService`（它与配额账户是一个关注点），而非新的同级。

**技术栈：** TypeScript（严格）、Fastify 5、Prisma 5.22、Vitest 3、Zod 4。单实例服务器，进程内缓存。

> **v2 变更日志（来自 v1 的多人审阅）：** 修复了任务 8 的方法列表（v1 命名了一个不存在的 `aggregateFullStateVectorClock`；约 430 LOC 的批处理管道内部未分配）并将其拆分为 8a/8b/8c。添加了强制的 `EncryptedOpsNotSupportedError` 重新导出（v1 会破坏 `sync.routes.ts` + 快照 spec）。修正了回归门控命令（v1 引用了**排除在** `npm test` 之外的 spec）。将淘汰折叠入 `StorageQuotaService`（v1 的"注入 SnapshotService"注意事项守卫了一个不存在的依赖）。将两个冲突文件合并为一个，四个路由辅助模块合并为两个；纯模块移至 `src/sync/` 顶层（非 `services/`）。添加了不可避免的、枚举的 spec spy 重新指向（v1 的"spec 100% 不变"前提被证明对于任务 6 和 7 是错误的）。

---

## 指导原则（每次任务前阅读）

1. **门面保留。** `SyncService` / `SnapshotService` 保持每个公共方法签名。除显式列出的两个 `import` 行（任务 4）外，没有路由文件被编辑——`syncRoutes` 注册体和所有回复形状不变。
2. **无行为/API/线路/数据库变更。** 纯粹的结构性移动，逐字复制。如果移动会改变行为，停止并标记。
3. **Spec 策略——诚实的版本。** 无_行为性_ spec 变更。但三个 spec 站点通过 `service as unknown as {...}` 转换访问私有成员，并且**必须在**其目标移动时重新指向（经过验证，非假设）：
   - `tests/sync.service.spec.ts:924-929`——`vi.spyOn(service as unknown as {...}, "_aggregatePriorVectorClock")` → 重新指向 `OperationUploadService` 实例（任务 7b）。
   - `tests/sync.service.spec.ts:2117-2122`——`service as unknown as { deleteOldSyncedOpsBatch; storageQuotaService }` → 在淘汰折叠入 `StorageQuotaService` 后，在 `service["storageQuotaService"]`（相同实例）上 spy/断言（任务 5）。
     这些是**仅有的**允许的 spec 编辑，以 `test:` 作用域提交，按任务列出。其他所有内容：spec 不变。
4. **回归门控是 `npm test` 实际运行的内容。** `vitest.config.ts` **排除**了 `tests/sync.routes.spec.ts`、`tests/snapshot-skip-optimization.spec.ts` 和所有 `tests/integration/**`。每个任务的基线只命名执行的 spec。集成 spec（需要实时 Postgres）通过 `npx vitest run --config vitest.integration.config.ts` 带外运行，是**合并前**门控（任务 8），非每个任务门控。无需"为时区运行两次"——那是仅客户端的特性，这里是错误的（服务器 `npm test` 不设置 `TZ`）。
5. **两阶段移动技术（对 4 个主要任务：2、4、6、7 是强制的）。** 阶段 A：在_原始_文件中，将集群的方法转换为自由函数/嵌套类并重新指向调用点；运行目标 spec——编译器 + spec 在跨文件边界之前捕获每个 `this` 捕获和签名错误。阶段 B：将现在自包含的块重定位到新文件，添加导入/导出，重新指向。在阶段 B 后提交（或对任务 7 在每个阶段后提交）。
6. **每个任务一个协作者，最小可行差异。** 逐字移动。不进行"趁我在这里"的重写（CLAUDE.md：保持在范围内）。
7. **任务按风险升序排列**，每个独立可发布 + 绿色。硬依赖显式说明。

### 命令

```bash
npm run checkFile <path>                                   # lint+format every .ts touched
cd packages/super-sync-server && npx vitest run <spec...>   # fast per-task iteration loop
cd packages/super-sync-server && npm test                   # full gate (vitest run); commit gate only
cd packages/super-sync-server && npx vitest run --config vitest.integration.config.ts  # needs live Postgres; pre-merge only
```

`pretest` 运行 `prisma generate`（幂等——每个会话运行一次，非每次编辑）。沙箱说明：如果 `prisma generate`/vitest 在只读 home 上失败，使用种子化的假 home 前缀

**合并前门控（非每个子步骤）：** 运行集成套件——`npx vitest run --config vitest.integration.config.ts`（需要实时 Postgres；如果环境不可用，显式说明并依赖特征化 spec + `sync-operations`/`time-tracking-operations`/`conflict-detection`/`sync-fixes` spec，注明覆盖减少）。

---

## 任务 8：最终验证和 barrel 文档

- 完整 `npm test` 绿色。如果 Postgres 可用：`npx vitest run --config vitest.integration.config.ts` 绿色（覆盖 `npm test` 排除的 `multi-client-sync` + `snapshot-skip-optimization` 集成 spec）。否则记录集成在此未运行，必须在合并前在 CI 中运行。
- `wc -l` 三个大文件。现实目标（v1 的不可实现）：`sync.routes.ts` ≤ 约 450、`snapshot.service.ts` ≤ 约 600、`sync.service.ts` ≤ 约 1100（`uploadOps` 事务壳 + 门面委托是不可缩减的编排核心——这是"将管道重定位到内聚单元"，而非"让 sync.service.ts 变小"；如此说明）。
- 所有任务中触及的每个文件上运行 `npm run checkFile`。
- 用每个新协作者一行扩展现有的 `src/sync/services/index.ts` 头部注释（无需新的文档文件——保持映射在代码旁边，与无主动文档规则一致）。
- 最终提交 `docs(sync): note new SuperSync server module boundaries in barrel`。

**不要**打开 PR 或合并——单独决策（当用户要求时使用 superpowers:finishing-a-development-branch）。

---

## 风险登记表

| 任务 | 风险 | 硬依赖 | 允许的 spec 编辑 |
| --- | --- | --- | --- |
| 0 提升类型 | 微不足道 | — | 无 |
| 1 操作重放（+ 重新导出） | 非常低 | — | 无 |
| 2 conflict.ts | 低 | 0 | 无 |
| 3 路由辅助函数 ×2 | 低 | — | 无 |
| 4 路由处理器 ×2 | 中 | 3 | 无（仅 2 个路由导入） |
| 5 淘汰 → StorageQuota | 中 | — | 1（`:2117` spy 重新指向） |
| 6 快照生成 | 中 | 1 | 无 |
| 7 操作上传（7a/b/c） | 高 | 0, 2 | 1（`:924` spy 重新指向） |
| 8 验证 + 文档 | 微不足道 | 全部 | — |

同步正确性不变量（事务原子性、向量时钟修剪顺序、SYNC_IMPORT/BACKUP_IMPORT/REPAIR 提前返回、重放确定性、无用户内容日志记录）通过逐字移动 + 门面规则保留——通过与 `CLAUDE.md` 规则 1/6/7/8/9 和 `docs/sync-and-op-log/vector-clocks.md` 的审阅确认。正确性风险最高的单一表面是任务 7；特征化 spec 是其主要守卫。

## 范围外（YAGNI）

删除门面；触及 `api.ts`/`passkey.ts`/`auth.ts`/`scripts/`；行为/性能/数据库/线路变更；重写测试（仅添加新的 spec + 2 个枚举的 spy 重新指向）；新的 `routes/` 目录或 `docs/` 成果。
