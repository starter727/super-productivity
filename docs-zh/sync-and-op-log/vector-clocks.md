# 向量时钟架构

## 1. 概览

向量时钟跟踪的是**因果关系（causality）**，即“这个客户端是否知道那条操作”，而不是会漂移的墙钟时间。它是 Super Productivity 同步系统中冲突检测与 SYNC_IMPORT 过滤的基础。

### 核心类型

```typescript
interface VectorClock {
  [clientId: string]: number;
}
```

每个条目将客户端 ID 映射到单调递增计数。`{A: 5, B: 3}` 表示“该状态包含 A 的前 5 条操作、B 的前 3 条操作”。

### 常量

| 常量                    | 值  | 作用                       |
| ----------------------- | --- | -------------------------- |
| `MAX_VECTOR_CLOCK_SIZE` | 20  | 裁剪后时钟允许的最大条目数 |

在 6 字符 client ID 情况下，20 条目时钟约 333 字节，带宽开销很小。个人用户通常很难达到 21+ 唯一 client ID（重装/换浏览器）触发裁剪。

---

## 2. 核心操作

三类操作（compare、merge、prune，即 `limitVectorClockSize`）在共享包中实现：`packages/shared-schema/src/vector-clock.ts`，客户端与服务端共用。两类操作（initialize、increment）仅客户端实现于 `src/app/core/util/vector-clock.ts`，并封装了空值处理与日志。

### Create

```typescript
initializeVectorClock(clientId) → { [clientId]: 0 }
```

### Increment

```typescript
incrementVectorClock(clock, clientId) → { ...clock, [clientId]: clock[clientId] + 1 }
```

接近 `MAX_SAFE_INTEGER` 会抛溢出错误。唯一恢复方式是做一次 `SYNC_IMPORT` 重置时钟。

### Compare

```typescript
compareVectorClocks(a, b) → EQUAL | LESS_THAN | GREATER_THAN | CONCURRENT
```

标准向量时钟比较。缺失键按 0 处理。

### Merge

```typescript
mergeVectorClocks(a, b) → { [key]: max(a[key], b[key]) for all keys in a ∪ b }
```

返回一个同时支配两侧输入的新时钟。

---

## 3. 向量时钟存放位置

### 每条 Operation 自带时钟

每个 `Operation` 都有 `vectorClock` 字段，记录其创建时的全局时钟状态，是因果追踪的主机制。

### 全局时钟存储

保存在 IndexedDB（`SUP_OPS` 数据库中的 `vector_clock` store）作为 `VectorClockEntry`：

```typescript
interface VectorClockEntry {
  clock: VectorClock; // 当前全局时钟
  lastUpdate: number; // 最后更新时间戳
}
```

全局时钟是客户端当前因果知识的**单一事实来源**。本地操作捕获时，通过 `appendWithVectorClockUpdate` 在同一 IndexedDB 事务里原子写入“操作 + 时钟更新”。远端合并路径（`mergeRemoteOpClocks`）则先读当前状态，再单独写回时钟。

### 快照时钟

`state_cache` 里也保存 `vectorClock`，表示 compaction 时刻的基线时钟。

### 实体前沿（Entity Frontier）

由 `VectorClockService.getEntityFrontier()` 按需计算（扫描快照之后的操作），用于细粒度冲突检测。

---

## 4. 向量时钟生命周期（常规操作）

### 步骤 1：创建本地操作

在 `operation-log.effects.ts`：

1. `VectorClockService.getCurrentVectorClock()` 从 `vector_clock` store 读取全局时钟
2. `incrementVectorClock(currentClock, clientId)` 得到客户端计数 +1 的新时钟
3. 用这个**完整且未裁剪**时钟创建操作
4. `appendWithVectorClockUpdate(op, 'local')` 在**单个原子事务**中写入操作并更新全局时钟

**关键不变量：常规操作携带完整（未裁剪）向量时钟。捕获阶段不做客户端裁剪。**

### 步骤 2：上传到服务端

在 `sync.service.ts`（`processOperation`）：

1. `ValidationService.validateOp()` 对时钟做 DoS 上限校验（2.5×MAX=50），但**不裁剪**
2. `detectConflict()` 用**未裁剪**时钟与目标实体当前时钟比较
3. 若接受：`limitVectorClockSize(clock, [clientId])` 再裁剪到 MAX，优先保留上传客户端 ID
4. 存储裁剪后时钟

### 步骤 3：其他客户端下载

在 `operation-log-store.service.ts`（`mergeRemoteOpClocks`）：

1. 将每条下载操作的时钟合并到本地全局时钟
2. 对全量状态操作（SYNC_IMPORT/BACKUP_IMPORT/REPAIR），全局时钟会先**替换**为导入时钟，再合并其余操作（导入时钟未包含的旧条目可能丢失）
3. 非全量下载路径使用 merge，保留已有条目

### 关键洞察

常规操作在客户端**从不裁剪**。服务端在“比较之后、存储之前”裁剪。这一不对称设计是正确性的关键。

---

## 5. 裁剪（Pruning）

### 为什么需要裁剪

时钟会随客户端数量增长。为防止无限膨胀，限制到 `MAX_VECTOR_CLOCK_SIZE`（20）。

### `limitVectorClockSize` 算法

```
Input: clock, preserveClientIds[]
If entries ≤ MAX: return clock unchanged
Otherwise:
  1. Add entries from preserveClientIds first (capped at MAX)
  2. Fill remaining slots with highest-counter entries (sorted descending)
  3. Return clock with exactly MAX entries
```

实现于 `packages/shared-schema/src/vector-clock.ts`。客户端封装在 `src/app/core/util/vector-clock.ts`，会加日志并默认保留 `[currentClientId]`。

### 何时会裁剪（完整列表）

| 位置                                            | 时机                            | 保留策略      |
| ----------------------------------------------- | ------------------------------- | ------------- |
| **Server** `processOperation()`                 | 冲突检测通过后、存储前          | 上传客户端 ID |
| **Server** `getOpsSinceWithSeq()`               | 聚合快照时钟                    | 请求方客户端  |
| **Client** `SyncHydrationService`               | 冲突解决中创建 SYNC_IMPORT      | 当前客户端    |
| **Client** `ServerMigrationService`             | 迁移时创建 SYNC_IMPORT          | 当前客户端    |
| **Client** `RepairOperationService`             | 创建 REPAIR                     | 当前客户端    |
| **Client** `OperationLogSnapshotService`        | 保存快照到 state cache          | 当前客户端    |
| **Client** `OperationLogCompactionService`      | compaction（保存快照+删旧 ops） | 当前客户端    |
| **Client** `OperationLogHydratorService`        | 启动恢复快照                    | 当前客户端    |
| **Client** 常规操作捕获                         | **从不**                        | N/A           |
| **Client** `SupersededOperationResolverService` | **从不**（冲突解算）            | N/A           |

### 裁剪触发其实很少

MAX=20 下，通常需要 21+ 唯一 client ID 才触发。即便触发，常见最坏结果也只是多一次服务端往返（假 CONCURRENT → 客户端解算再上传 → GREATER_THAN → 接受）。

---

## 6. 冲突检测与解决（服务端上传）

### 服务端流程

1. 查找同实体最新操作（按 `entityType + entityId`，`serverSeq desc`）
2. 用**完整未裁剪**的 incoming clock 与 existing clock 比较
3. 结果：
   - `GREATER_THAN` → **接受**
   - `EQUAL` + 同 client → **接受**（同操作重试）
   - `EQUAL` + 不同 client → **拒绝**（可疑复用）
   - `CONCURRENT` → **拒绝**（真实冲突）
   - `LESS_THAN` → **拒绝**（已过时）
4. 若接受：先裁剪再存储

### 客户端解算流程

服务端拒绝后：

1. 客户端收到 `existingClock`
2. `SupersededOperationResolverService.resolveSupersededLocalOps()`：
   - 合并全局时钟 + superseded ops 时钟 + snapshot 时钟 + 强制下载附加时钟
   - 调用 `mergeAndIncrementClocks()` —— **不做客户端裁剪**
   - 生成新的 LWW Update op（携带合并后时钟）
3. 再上传 → 服务端比较完整合并时钟（可能 >MAX）→ `GREATER_THAN` → 接受
4. 服务端在存储前裁剪

### 关键不变量：服务端必须“先比较，后裁剪”

若服务端比较前裁剪，当实体时钟已满 MAX 且客户端 ID 不在其中时，客户端将无法构造支配时钟。

**安全阀：** `RejectedOpsHandlerService` 按实体统计解算重试，超过 `MAX_CONCURRENT_RESOLUTION_ATTEMPTS`（3 次）后永久拒绝。

---

## 7. SYNC_IMPORT / BACKUP_IMPORT / REPAIR

### 核心规则：Clean Slate 语义

导入是“把所有客户端恢复到某一状态点”的显式用户动作。对导入不知情的操作必须丢弃：

| 比较结果       | 含义                   | 动作     |
| -------------- | ---------------------- | -------- |
| `GREATER_THAN` | 该 op 在看到导入后创建 | **保留** |
| `EQUAL`        | 与导入处于同一因果历史 | **保留** |
| `CONCURRENT`   | 创建时不知道导入       | **丢弃** |
| `LESS_THAN`    | 被导入状态支配         | **丢弃** |

即使来自未知客户端，`CONCURRENT` 也要丢弃，以保证“恢复到某个时间点”语义。

### 导入时钟如何构造

| 来源                        | 方法                     | 构造方式                                                                        |
| --------------------------- | ------------------------ | ------------------------------------------------------------------------------- |
| `BACKUP_IMPORT`（干净重建） | `BackupService`          | 新鲜时钟 `{newClientId: 1}`，小而稳定                                           |
| 服务端迁移                  | `ServerMigrationService` | 合并本地所有 op 时钟 + 全局时钟 → increment → 裁剪                              |
| 同步恢复（冲突解决）        | `SyncHydrationService`   | 合并 local clock + state cache clock + remote snapshot clock → increment → 裁剪 |
| 自动修复                    | `RepairOperationService` | 读取全局时钟 → increment → 裁剪                                                 |

### 全量状态操作跳过服务端冲突检测

在 `detectConflict()` 中，`SYNC_IMPORT`、`BACKUP_IMPORT`、`REPAIR` 直接返回 `{ hasConflict: false }`。因为它们是整体状态替换，不针对单实体。

### `SyncImportFilterService` 算法

实现位于 `src/app/op-log/sync/sync-import-filter.service.ts`：

1. 先找“最新全量状态操作”：同时检查当前批次与本地存储（`getLatestFullStateOpEntry()`），按 UUIDv7 新旧取最新
2. 对批次内每个非全量操作：
   - 比较 `op.vectorClock` 与导入时钟
   - `GREATER_THAN`/`EQUAL` → **保留**
   - `CONCURRENT` 且与导入同 client 且计数更高 → **保留**（同客户端检查）
   - 其他情况 → **过滤**

### 同客户端检查（Same-Client Check）

若 op 与导入来自同一客户端，且计数更高，则必然是导入后操作。客户端不可能与自己的导入并发（计数单调递增）。该检查正确且成本低（约 15 行逻辑）。

---

## 8. 关键场景（逐步追踪）

### 场景 1：双客户端同步（无冲突）

```
Initial state: Client A and B both know about each other
  A's global clock: {A: 3, B: 2}
  B's global clock: {A: 3, B: 2}

Step 1: A creates a task
  A increments: {A: 4, B: 2}
  Op carries clock: {A: 4, B: 2}
  A's global clock updated to: {A: 4, B: 2}

Step 2: A uploads
  Server compares op clock {A: 4, B: 2} vs latest entity clock (none) → no conflict
  Server stores op (no pruning needed, 2 entries < MAX)

Step 3: B downloads
  B receives op with clock {A: 4, B: 2}
  B merges into global clock: max({A: 3, B: 2}, {A: 4, B: 2}) = {A: 4, B: 2}

Step 4: B creates a task
  B increments: {A: 4, B: 3}
  B's global clock updated to: {A: 4, B: 3}
```

### 场景 2：并发修改（冲突解算）

```
Starting state: Both clients synced
  A's clock: {A: 3, B: 2}    B's clock: {A: 3, B: 2}

Step 1: Both modify the same task offline
  A creates op: {A: 4, B: 2}
  B creates op: {A: 3, B: 3}

Step 2: A uploads first → server accepts (no prior op for this entity)
  Server stores: {A: 4, B: 2}

Step 3: B uploads
  Server compares: {A: 3, B: 3} vs {A: 4, B: 2}
  A=3 < 4 (b greater), B=3 > 2 (a greater) → CONCURRENT → reject
  Server returns existingClock: {A: 4, B: 2}

Step 4: B resolves
  SupersededOperationResolverService merges:
    globalClock={A: 3, B: 3} + existingClock={A: 4, B: 2} + opClock={A: 3, B: 3}
    merged = {A: 4, B: 3}, incremented = {A: 4, B: 4}
  Creates new LWW Update op with clock {A: 4, B: 4}
  NO client-side pruning

Step 5: B re-uploads
  Server compares: {A: 4, B: 4} vs {A: 4, B: 2} → GREATER_THAN → accept
  Server stores (pruned if needed, but only 2 entries here)
```

### 场景 3：小时钟 SYNC_IMPORT（Clean Slate）

```
Step 1: Client A does BACKUP_IMPORT (full data restore)
  Creates SYNC_IMPORT op with clock: {A: 1}
  Uploads to server

Step 2: Client B has been working offline
  If B never saw A's state: B's clock: {B: 5}
  Compare: {B: 5} vs {A: 1} → CONCURRENT → filtered ✓

  If B had previously synced with A: B's clock: {A: 3, B: 5}
  Compare: {A: 3, B: 5} vs {A: 1} → GREATER_THAN → kept ✓
  (B's ops were created with knowledge beyond the import point)
```

---

## 9. 不变量（Invariants）

以下规则必须成立，系统才正确：

1. **常规 op 携带完整未裁剪时钟。** `operation-log.effects.ts` 不裁剪。
2. **服务端在比较后、存储前裁剪。** `processOperation()` 在 `detectConflict()` 成功后调用 `limitVectorClockSize()`。
3. **客户端冲突解算不裁剪。** `SupersededOperationResolverService` 发送完整合并时钟，服务端接受后再裁剪。
4. **客户端与服务端比较语义一致。** 都从 `@sp/shared-schema` 引入 `compareVectorClocks`。
5. **全量状态 op 在服务端跳过冲突检测。** `detectConflict()` 对 SYNC_IMPORT/BACKUP_IMPORT/REPAIR 直接 `hasConflict: false`。
6. **相对 SYNC_IMPORT，CONCURRENT op 要过滤（默认丢弃）。** 除非被识别为同客户端后续 op。Clean slate 语义是显式且正确行为。
7. **远端 SYNC_IMPORT 到来时，全局时钟采用“替换基线再合并”。** `mergeRemoteOpClocks()` 先以导入时钟为基线，再合并其余操作，避免时钟膨胀。
8. **DoS 上限不是裁剪。** `sanitizeVectorClock()` 对 >2.5×MAX（50）条目直接拒绝，不会替你裁到 MAX。

---

## 10. 关键文件索引

| 概念                                       | 文件                                                                         |
| ------------------------------------------ | ---------------------------------------------------------------------------- |
| 核心算法（compare/merge/prune）            | `packages/shared-schema/src/vector-clock.ts`                                 |
| 客户端封装（空值处理、日志、校验）         | `src/app/core/util/vector-clock.ts`                                          |
| 全局时钟管理、实体前沿                     | `src/app/op-log/sync/vector-clock.service.ts`                                |
| 操作捕获（不裁剪、原子时钟更新）           | `src/app/op-log/capture/operation-log.effects.ts`                            |
| 时钟持久化                                 | `src/app/op-log/persistence/operation-log-store.service.ts`                  |
| 导入过滤 + 同客户端检查                    | `src/app/op-log/sync/sync-import-filter.service.ts`                          |
| 冲突解算（不裁剪，合并时钟）               | `src/app/op-log/sync/superseded-operation-resolver.service.ts`               |
| 冲突解决（LWW、`mergeAndIncrementClocks`） | `src/app/op-log/sync/conflict-resolution.service.ts`                         |
| 创建 SYNC_IMPORT（同步恢复）               | `src/app/op-log/persistence/sync-hydration.service.ts`                       |
| 创建 SYNC_IMPORT（服务迁移）               | `src/app/op-log/sync/server-migration.service.ts`                            |
| 创建 REPAIR                                | `src/app/op-log/validation/repair-operation.service.ts`                      |
| 服务端：冲突检测 + 比较后裁剪              | `packages/super-sync-server/src/sync/sync.service.ts`                        |
| 服务端：DoS 上限（sanitize，不裁剪）       | `packages/super-sync-server/src/sync/services/validation.service.ts`         |
| 服务端：下载优化中的快照时钟裁剪           | `packages/super-sync-server/src/sync/services/operation-download.service.ts` |
