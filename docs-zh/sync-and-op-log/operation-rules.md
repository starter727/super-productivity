# Operation Log：设计规则与指南

**最后更新：** 2025 年 12 月  
**相关文档：** [Operation Log Architecture](./operation-log-architecture.md)

本文定义了 Operation Log 存储与新 Operation 设计的核心规则。遵循这些规则可保证数据完整性、同步可靠性与系统性能。

## 1. 存储设计规则

### 1.1 仅追加持久化（Append-Only）

- **规则：** 存储中的 `ops` 表对活跃操作必须严格 **append-only**。
- **原因：** 历史保真是事件溯源与冲突解决的基础。
- **例外：** 仅 **Compaction Service** 可删除操作，且必须同时满足：
  1. 超过保留窗口。
  2. 已成功同步（`syncedAt` 已设置）。
  3. 已“烘焙进”安全快照。

### 1.2 历史不可变

- **规则：** 操作写入 `SUP_OPS` 后 **禁止修改**。
- **原因：** 修改历史会破坏（未来可实现的）加密链一致性，并让已接收该操作的同步端产生认知错位。
- **修正方式：** 若操作有误，追加新的“补偿操作”（如撤销或修正），而不是改旧记录。

### 1.3 单一事实来源

- **规则：** Operation Log（`SUP_OPS`）是应用状态的终极事实来源。
- **上下文：** `state_cache` 与运行时 NgRx store 都是日志投影。
- **含义：** 若运行态与日志回放冲突，以日志为准。

### 1.4 快照强制要求

- **规则：** 存储必须维护有效的 `state_cache`（快照）。
- **更新频率：** 基于可配置阈值：
  - **操作数阈值：** N 次操作后（默认 500，可配置）。
  - **时间阈值：** 变更后空闲 T 分钟。
  - **体积阈值：** tail ops 超过 S KB。
  - **事件阈值：** 重大事件后立即生成（大规模导入、同步完成）。
- **恢复要求：** 系统必须能通过 `Snapshot + Tail Ops` 全量重建状态。

## 2. Operation 设计规则

### 2.1 粒度与原子性

- **规则：** Operation 应尽量原子，且尽量聚焦 **单实体**。
- **好例子：** `UPDATE_TASK { id: "A", changes: { title: "New" } }`
- **坏例子：** `UPDATE_ALL_TASKS { [ ... entire tasks array ... ] }`
- **原因：** 细粒度可降低冲突概率；“大包状态倾倒”会在同步中放大冲突。
- **例外：** `SYNC_IMPORT` 与 `BACKUP_IMPORT` 可替换大块状态，但必须被当作特殊“重置事件”。

### 2.2 幂等性

- **规则：** 同一操作重复应用必须安全。
- **实现约束：**
  - 创建使用显式 ID（UUID v7）。若 `CREATE` 的 ID 已存在，必须 **忽略**（不合并、不更新）；需更新时应追加独立 `UPDATE`。
  - 对不存在实体执行 `DELETE` 应为 no-op。
  - 对不存在实体执行 `UPDATE` 应入队重试（见 3.4 依赖感知）。

### 2.3 可序列化 Payload

- **规则：** Operation payload 必须是 **纯 JSON**。
- **禁止：**
  - `Date` 对象（改用时间戳 number）。
  - 函数或类实例。
  - `undefined`（用 `null` 或省略字段）。
  - 循环引用。

### 2.4 因果追踪

- **规则：** 每条操作 **必须**携带 `vectorClock`。
- **目的：** 判断该操作与其他操作是并发还是因果先后。
- **责任方：** `OperationLogEffects`（或等价创建器）在创建时捕获时钟。

### 2.5 Schema 版本

- **规则：** 每条操作 **必须**携带 `schemaVersion`。
- **目的：** 让未来版本能迁移或正确解释旧操作。
- **默认值：** 创建时使用 `SchemaMigrationService` 的 `CURRENT_SCHEMA_VERSION`。

### 2.6 明确意图（OpType）

- **规则：** 使用明确 `OpType`（`CRT`、`UPD`、`DEL`、`MOV`），不要用泛化 `CHANGE`。
- **原因：** 明确类型可支持更智能冲突处理与更好的 UI 反馈（例如“任务被远端删除”vs“任务被移动”）。

## 3. 交互与安全规则

### 3.1 先校验再写入

- **规则：** payload 必须在写日志前完成校验。
- **检查点：** 边界层做结构校验（必填字段）；应用/回放时做深层语义校验。
- **失败处理：** 立即拒绝畸形操作，禁止污染日志。

### 3.2 回放鲁棒性

- **规则：** 回放机制（Hydrator）在遇到坏操作时 **不能崩溃**。
- **行为：** 若操作应用失败（如引用缺失父实体）：
  1. 记录 warning。
  2. 跳过操作（或入队重试）。
  3. 继续回放后续操作。
  4. 必要时在末尾触发 `REPAIR`。

### 3.3 同步隔离

- **规则：** `OperationLogStore` 不应包含任何 Provider 专属逻辑（Dropbox/WebDAV 等）。
- **职责分离：** Store 管持久化；Sync Services 管传输。
- **接口：** Store 提供通用方法：`getUnsynced()`、`markSynced()`、`markRejected()`。

### 3.4 依赖感知

- **规则：** 依赖实体创建（如 Subtask）必须确保被依赖对象（Parent Task）已存在。
- **处理：** 同步中若父实体缺失，子实体创建 op 应入 `DependencyQueue`，待父实体到达后再处理。
- **保护措施：**
  - **环检测：** 入队前验证依赖图无环；会形成环依赖的操作应拒绝。
  - **缓冲上限：** 队列必须有最大深度（默认 1000）和超时（默认 5 分钟）；超限应记录并丢弃。
  - **重试策略：** 每次应用完新批次操作后重试队列；重复失败采用指数退避。

### 3.5 删除与 Tombstone

> **状态（2025 年 12 月）：** Tombstone 方案已 **暂缓（DEFERRED）**。综合评估后，当前事件溯源架构在无显式 tombstone 情况下已具备足够保护。详见 `todo.md` 的 Item 1。

- **当前实现：** 删除通过事件日志中的 **DELETE 操作** 实现（不可变事件，而非物理删除）。
- **已具备替代保障：**
  - 向量时钟可检测并发 delete+update 冲突，并提供用户解决入口。
  - reducer 层标签清洗会过滤不存在的 taskIds。
  - 子任务级联删除会包含全部子节点。
  - 自动修复会清理孤儿引用并生成 REPAIR 操作。
- **何时重启讨论：**
  - 需要 undo/restore 功能时。
  - 合规要求必须记录“实体于时间 X 删除”时。
  - 跨版本同步（A.7.11）暴露现有防护未覆盖的边界场景时。

### 3.6 操作批处理

- **规则：** 常规操作应采用合理批量上传。
- **限制：**
  - **最大批大小：** 每批 25 条。
  - **最大负载：** 每批 1 MB，避免超时。
- **例外：** `SYNC_IMPORT` 与 `BACKUP_IMPORT` 可绕过上述限制，但必须显式标记为 bulk operation，并在完成后立即触发快照创建。

## 4. Effect 规则

### 4.1 副作用必须使用 LOCAL_ACTIONS

- **规则：** 所有产生副作用的 NgRx effect 必须用 `inject(LOCAL_ACTIONS)`，而非 `inject(Actions)`。
- **原因：** 远端同步操作不应触发副作用。snackbar、外部 API、声音等只在发起端执行一次。
- **例外：** 仅用于派发状态修改 action（无副作用）的 effect，可使用普通 `Actions`。

**示例：**

```typescript
@Injectable()
export class MyEffects {
  private _actions$ = inject(LOCAL_ACTIONS); // ✅ Correct for side effects

  showSnack$ = createEffect(
    () =>
      this._actions$.pipe(
        ofType(completeTask),
        tap(() => this.snackService.show('Task completed!')),
      ),
    { dispatch: false },
  );
}
```

### 4.2 避免“Selector 驱动且会派发 action”的 Effects

- **规则：** 优先 action-based effect（`this._actions$.pipe(ofType(...))`），避免 selector-based effect（`this._store$.select(...)`）。
- **原因：** selector-based effect 会在 store 任意变化时触发，包括 hydration 与 sync replay，绕过 `LOCAL_ACTIONS` 过滤。
- **折中方案：** 若必须用 selector-based 且会派发 action，需加 `HydrationStateService.isApplyingRemoteOps()` 防护。

### 4.3 归档副作用

- **规则：** 归档写入（IndexedDB）由 `ArchiveOperationHandler` 负责，不走普通 effects。
- **本地操作：** `ArchiveOperationHandlerEffects` 通过 `LOCAL_ACTIONS` 路由到 `ArchiveOperationHandler`。
- **远端操作：** `OperationApplierService` 在 dispatch 后直接调用 `ArchiveOperationHandler`。

## 5. 多实体操作规则

### 5.1 多实体变更用 Meta-Reducer 保证原子性

- **规则：** 当一个 action 会影响多个实体时，使用 **meta-reducer**，不要用 effects 串联。
- **原因：** meta-reducer 能在一次 reducer pass 内完成全部变更，形成单条同步操作，避免部分同步。
- **示例：** 删除标签并从任务中移除该标签，应在 `tagSharedMetaReducer` 实现，而不是 effect。

### 5.2 自动捕获多实体变更

- **规则：** `OperationCaptureService` 会自动捕获同一 action 的全部实体变更。
- **实现：** `operation-capture.meta-reducer` 调用 `OperationCaptureService.enqueue()` 传入 action。
- **结果：** 生成一条包含 `entityChanges[]` 的单 operation。

## 6. 配置常量

所有可配置值见 `operation-log.const.ts`：

| 常量                                | 值       | 说明                             |
| ----------------------------------- | -------- | -------------------------------- |
| `COMPACTION_TRIGGER`                | 500 ops  | 自动 compaction 触发阈值         |
| `COMPACTION_RETENTION_MS`           | 7 days   | 超过该时长且已同步的操作可删     |
| `EMERGENCY_COMPACTION_RETENTION_MS` | 1 day    | 配额超限时的更短保留             |
| `MAX_COMPACTION_FAILURES`           | 3        | 失败超过该值触发用户通知         |
| `MAX_DOWNLOAD_OPS_IN_MEMORY`        | 50,000   | 限制 API 下载时内存占用          |
| `REMOTE_OP_FILE_RETENTION_MS`       | 14 days  | 服务端操作文件保留时长           |
| `PENDING_OPERATION_EXPIRY_MS`       | 24 hours | 超过该时长的 pending op 会被拒绝 |

## 7. 速查清单

新增一个持久化 action 时：

- [ ] 给 action 加 `meta.isPersistent: true`
- [ ] 设置 `meta.entityType` 与 `meta.opType`
- [ ] 关联实体变更放在 meta-reducer（不是 effects）
- [ ] 有副作用的 effects 使用 `LOCAL_ACTIONS`
- [ ] 归档类操作走 `ArchiveOperationHandler`
- [ ] 若是多实体 action，加入 `ACTION_AFFECTED_ENTITIES`
