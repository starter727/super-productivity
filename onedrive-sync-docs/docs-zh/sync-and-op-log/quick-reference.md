# Operation Log 与同步：速查手册

本文按模块给出 Operation Log 与 Sync 系统的可视化速记。详细实现请参阅：

- [operation-log-architecture.md](./operation-log-architecture.md)
- [operation-log-architecture-diagrams.md](./operation-log-architecture-diagrams.md)

---

## 区域 1：写路径（Write Path）

写路径负责把用户动作捕获为操作并持久化到 IndexedDB。

核心步骤：

1. 用户操作触发 NgRx action
2. reducer 先做乐观更新
3. `operationCaptureMetaReducer` 捕获可持久化 action
4. `OperationCaptureService.enqueue()` 入 FIFO 队列
5. `OperationLogEffects.persistOperation$` 持久化
6. 使用 Web Locks API 做跨标签页协调
7. `incrementVectorClock(clock, clientId)`
8. `validateOperationPayload()`（检查点 A）
9. 写入 `SUP_OPS.ops`
10. 触发即时上传

关键文件：

- `operation-capture.meta-reducer.ts`
- `operation-capture.service.ts`
- `operation-log.effects.ts`
- `operation-log-store.service.ts`

---

## 区域 2：读路径（Hydration）

启动时由“快照 + tail operations”恢复状态。

核心步骤：

1. 应用启动
2. 并行恢复（远端残留、旧向量时钟迁移、备份检查）
3. 加载 `SUP_OPS.state_cache`
4. 必要时执行 schema migration
5. 状态校验（检查点 B）
6. 恢复向量时钟
7. `loadAllData(snapshot.state)`
8. `getOpsAfterSeq(lastAppliedOpSeq)` 加载尾部操作
9. tail 操作迁移
10. `bulkApplyOperations()`
11. 状态校验（检查点 C）
12. 必要时保存新快照
13. 延迟校验（5s）

关键文件：

- `operation-log-hydrator.service.ts`
- `schema-migration.service.ts`
- `bulk-hydration.meta-reducer.ts`

---

## 区域 3：服务端同步（SuperSync）

完整同步循环分三段：上传、下载、应用远端操作。

上传：

1. flush pending writes
2. 锁内执行 server migration 检查
3. 按批上传（通常 25）
4. 处理 piggybacked ops 与 rejected 列表

下载：

1. `GET /ops?sinceSeq=X`
2. gap 检测，必要时重置为 seq=0
3. 过滤已应用操作
4. 若开启加密则先解密
5. 按页拉取直到 `hasMore=false`

应用远端操作：

1. schema migration
2. 过滤被 SYNC_IMPORT 失效的操作
3. full-state 操作直应用
4. 向量时钟冲突检测
5. LWW 自动解决
6. 经 `operationApplier` 应用到 NgRx
7. 合并时钟
8. 检查点 D 校验

关键文件：

- `operation-log-sync.service.ts`
- `operation-log-upload.service.ts`
- `operation-log-download.service.ts`

---

## 区域 4：冲突检测

冲突检测使用向量时钟判断因果关系。

比较结果与动作：

| 比较结果       | 含义     | 本地有待上传同实体操作 | 动作                 |
| -------------- | -------- | ---------------------- | -------------------- |
| `EQUAL`        | 同一操作 | N/A                    | 跳过（重复）         |
| `GREATER_THAN` | 本地更新 | N/A                    | 跳过（远端已过时）   |
| `LESS_THAN`    | 远端更新 | 否                     | 应用远端             |
| `LESS_THAN`    | 远端更新 | 是                     | 应用远端（远端支配） |
| `CONCURRENT`   | 并发更新 | 否                     | 应用远端             |
| `CONCURRENT`   | 并发更新 | 是                     | 真实冲突             |

关键文件：

- `vector-clock.service.ts`
- `conflict-resolution.service.ts`
- `src/app/sync/util/vector-clock.ts`

---

## 区域 5：冲突解决（LWW）

LWW 自动解决并发冲突：

1. 取本地冲突集与远端冲突集的最大时间戳
2. `local_max > remote_max`：本地胜
3. 否则远端胜（平局远端胜，确保收敛）

本地胜时：

1. 以当前 NgRx 实体状态创建新的 UPDATE op
2. 时钟采用“合并后 + increment”
3. 原 superseded 本地操作标 rejected
4. 下轮上传该新 op

远端胜时：

1. 应用远端
2. 标记本地相关待上传操作 rejected

关键不变量：

- `moveToArchive` 归档胜过字段级更新
- 新 op 应保留原始 timestamp 语义
- 需合并所有已知时钟
- 同实体待上传 superseded op 必须全部拒绝

关键文件：

- `conflict-resolution.service.ts`
- `superseded-operation-resolver.service.ts`

---

## 区域 6：SYNC_IMPORT 过滤

导入类操作使用 Clean Slate 语义：恢复点之后（或同历史）可保留；未知导入的操作应丢弃。

流程：

1. 在当前批次 + 本地历史中找最新 full-state import
2. 对每条操作比较向量时钟
3. `GREATER_THAN` / `EQUAL` 保留
4. `LESS_THAN` / `CONCURRENT` 丢弃

为什么不用 UUIDv7 时间戳：

- UUIDv7：受设备时钟漂移影响
- 向量时钟：表达因果，能回答“创建时是否知道这次导入”

关键文件：

- `sync-import-filter.service.ts`

---

## 区域 7：归档处理

归档数据不进 NgRx 主状态，而是直接写 IndexedDB。

本地操作：

1. 先写 archive
2. 再 dispatch `moveToArchive`
3. 操作日志只记录动作，不携带归档大对象

远端操作：

1. 先通过 reducer 更新主状态
2. 再由 `ArchiveOperationHandler` 写归档

架构收益：

- 减少同步 payload
- 通过确定性重放保证一致结果

关键文件：

- `archive-operation-handler.service.ts`
- `archive-operation-handler.effects.ts`
- `operation-applier.service.ts`

---

## 区域 8：Meta-Reducer 链

Meta-reducer 保证多实体变更单次原子提交。

关键顺序规则：

1. `operationCaptureMetaReducer` 必须第 0 位
2. `bulkOperationsMetaReducer` 必须第 1 位
3. `actionLoggerReducer` 必须最后

为什么不用 effects 实现多实体级联：

- effects 多次 dispatch 会产生多条操作，可能部分同步
- meta-reducer 单 pass 产出单条操作，保证原子性

典型例子：删除 tag 时同步移除任务上的 tag 引用与 planner 引用。

关键文件：

- `meta-reducer-registry.ts`
- `tag-shared.reducer.ts`
- `project-shared.reducer.ts`
- `planner-shared.reducer.ts`

---

## 区域 9：Compaction

Compaction 防止 op log 无限增长。

触发条件：

- 达到 `COMPACTION_THRESHOLD`（500）
- 或存储配额紧急清理

核心步骤（在 `OPERATION_LOG` 锁内）：

1. 读当前 NgRx state
2. 读当前向量时钟
3. 快照前立即读取 `lastSeq`
4. 提取 `snapshotEntityKeys`
5. 写入 `state_cache`
6. 重置计数
7. 删除旧操作（仅已同步、在保留窗口外、且 `seq<=lastSeq`）

关键常量：

| 常量                                | 值    | 说明           |
| ----------------------------------- | ----- | -------------- |
| `COMPACTION_THRESHOLD`              | 500   | 触发阈值       |
| `COMPACTION_RETENTION_MS`           | 7 天  | 保留已同步操作 |
| `EMERGENCY_COMPACTION_RETENTION_MS` | 1 天  | 紧急清理窗口   |
| `COMPACTION_TIMEOUT_MS`             | 25 秒 | 锁超时前中止   |

关键文件：

- `operation-log-compaction.service.ts`
- `operation-log.effects.ts`
- `operation-log.const.ts`

---

## 区域 10：批量应用（Bulk Application）

`bulkApplyOperations` 把大量操作压成一次 store 更新，显著减少开销。

对比：

- 非批量：N 次 dispatch + N 次 effect 评估
- 批量：1 次 dispatch，内部循环应用 N 条操作

性能收益：常见约 10x~50x。

为什么普通 effect 不会大量触发：

1. action-based effect 仅看到 `bulkApplyOperations`
2. selector-based effect 由 `HydrationStateService.isApplyingRemoteOps()` 抑制

关键文件：

- `bulk-hydration.meta-reducer.ts`
- `bulk-hydration.action.ts`
- `operation-converter.util.ts`
- `operation-applier.service.ts`

---

## 区域 11：端到端加密（E2E）

服务端只存密文 blob，不可见 payload 明文。

参数：

| 参数        | 值          |
| ----------- | ----------- |
| 算法        | AES-256-GCM |
| 密钥派生    | Argon2id    |
| Salt        | 16 字节随机 |
| IV          | 12 字节随机 |
| Argon2 内存 | 64 MB       |
| Argon2 迭代 | 3           |

密文结构：`Salt(16B) || IV(12B) || Ciphertext+AuthTag`，再 base64 编码传输。

关键文件：

- `operation-encryption.service.ts`
- `sync/encryption/encryption.ts`
- `operation-log-upload.service.ts`
- `operation-log-download.service.ts`

关联文档：

- [supersync-encryption-architecture.md](./supersync-encryption-architecture.md)

---

## 区域 12：统一文件型同步

所有 provider（WebDAV / Dropbox / LocalFile / SuperSync）统一到同一同步抽象（`OperationSyncable`）。

文件型（WebDAV/Dropbox/LocalFile）远端模型：

- `/superProductivity/sync-data.json`
- `/superProductivity/sync-data.json.bak`

`snyc-data.json` 含：

1. 全量状态快照
2. recent ops（200）
3. 向量时钟
4. 归档数据

对比：

| 维度     | 文件型                | SuperSync    |
| -------- | --------------------- | ------------ |
| 粒度     | 单操作                | 单操作       |
| 冲突单元 | 单实体                | 单实体       |
| 解决方式 | 自动（LWW）           | 自动（LWW）  |
| 存储     | 单个 `sync-data.json` | PostgreSQL   |
| 历史深度 | 最近 200 条           | 全量操作日志 |

关键文件：

- `op-log/sync-providers/file-based/file-based-sync-adapter.service.ts`
- `op-log/sync-providers/file-based/file-based-sync.types.ts`
- `op-log/sync-providers/super-sync/super-sync.ts`
- `op-log/sync/operation-log-sync.service.ts`
- `op-log/persistence/pfapi-migration.service.ts`

---

## 文件结构速查

```text
src/app/op-log/
├── core/           # 类型、常量、错误定义
├── capture/        # 写路径：Action -> Operation
├── apply/          # 读路径：Operation -> State
├── store/          # IndexedDB 持久化
├── sync/           # SuperSync 同步
├── validation/     # 状态/操作校验
├── util/           # 通用工具
└── testing/        # 集成与性能测试
```
