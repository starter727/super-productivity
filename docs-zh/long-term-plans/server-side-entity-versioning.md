# 方案：服务端实体版本管理（乐观并发控制，Optimistic Concurrency Control）

> **状态：已规划**
>
> 消除向量时钟裁剪作为同步冲突来源的长期架构变更。

---

## 问题

向量时钟（Vector Clock）随着参与客户端的数量线性增长。裁剪到 `MAX_VECTOR_CLOCK_SIZE=20` 会丢失因果信息，不过在 MAX=20 的情况下，这需要 21 个或更多唯一客户端 ID——对于一个个人效率应用来说极为罕见。一个同客户端检查（same-client check）处理了裁剪导致导入客户端自身操作产生虚假并发（false concurrency）的边界情况，但根本问题仍然存在：

根本问题在于：向量时钟是为无节点具有权威性的点对点（peer-to-peer）系统设计的。Super Productivity 拥有一个中心服务器——服务器可以权威地定义顺序，这使得在线冲突检测不再需要向量时钟。

## 行业先例

每个拥有中心服务器的生产级系统都收敛到了这一模式：

| 系统                  | 机制                                        | 详情                                          |
| --------------------- | ------------------------------------------- | --------------------------------------------- |
| **DynamoDB**（现代）  | Multi-Paxos，每分区单领导者                  | 完全放弃了最初 Dynamo 的向量时钟              |
| **Figma**             | 服务器排序的属性级 LWW（Last-Writer-Wins）    | 服务器接收顺序定义了全序关系                  |
| **Linear**            | 单调递增的 `syncId` 计数器                  | 每笔交易一个整数                              |
| **EventStoreDB**      | 每个流的 `expectedVersion`                   | 版本不匹配则拒绝追加                          |
| **CouchDB**           | 每个文档的 `_rev`                            | 服务器在接受时分配新的修订号                  |
| **Cosmos DB**         | 每个项目的 `_etag`                           | 通过 `If-Match` 头部进行条件更新              |

这一模式就是**乐观并发控制（Optimistic Concurrency Control，OCC）**：服务器为每个实体追踪一个权威版本号，客户端在写入时附带期望的版本号，服务器拒绝过时的写入。

## 方案

为每个实体添加**服务器分配的单调递增版本号**。将其作为主要的冲突检测机制。保留向量时钟作为用于离线因果推理的次要元数据，以及作为迁移回退方案。

### 为何这能解决裁剪问题

- 冲突检测使用单个整数比较（`expectedVersion === currentVersion`），而非向量时钟比较
- 主要冲突检测路径无需裁剪
- 向量时钟成为信息性元数据，而非正确性的关键依赖
- 同步循环不可能发生：被拒绝的操作会获取当前版本，使用正确版本重试后成功

## 变更

### 第一阶段：服务器架构与版本追踪

**文件：** `packages/super-sync-server/prisma/schema.prisma`

```prisma
model EntityVersion {
  id         String   @id @default(uuid())
  userId     String
  entityType String
  entityId   String
  version    Int      @default(0)   // 单调递增
  updatedAt  DateTime @updatedAt

  @@unique([userId, entityType, entityId])
  @@index([userId, entityType, entityId])
}
```

**文件：** `packages/super-sync-server/src/sync/sync.service.ts`

在处理上传操作时：

```typescript
async processOperation(userId: string, op: Operation): Promise<UploadResult> {
  const entityKey = { userId, entityType: op.entityType, entityId: op.entityId };

  // 获取或创建实体版本
  const entity = await this.getOrCreateEntityVersion(entityKey);

  if (op.entityVersion !== undefined) {
    // 新版客户端：使用实体版本管理
    if (op.entityVersion !== entity.version) {
      return {
        status: 'CONFLICT',
        reason: op.entityVersion < entity.version
          ? 'CONFLICT_SUPERSEDED'
          : 'CONFLICT_VERSION_MISMATCH',
        currentVersion: entity.version,
        existingClock: entity.clock,  // 仍为向后兼容而提供
      };
    }
  } else {
    // 旧版客户端：回退到向量时钟比较
    const conflict = await this.detectConflictByVectorClock(entityKey, op.vectorClock);
    if (conflict.hasConflict) {
      return {
        status: 'CONFLICT',
        reason: conflict.reason,
        currentVersion: entity.version,  // 即使对旧版客户端也包含版本号
        existingClock: conflict.existingClock,
      };
    }
  }

  // 接受：增加实体版本号，分配服务器序列号
  const newVersion = entity.version + 1;
  await this.updateEntityVersion(entityKey, newVersion);

  const seq = await this.allocateSequence(userId);
  await this.storeOperation(op, seq, userId);

  return { status: 'OK', serverSeq: seq, entityVersion: newVersion };
}
```

### 第二阶段：通信协议变更

**文件：** `packages/shared-schema/src/operation.types.ts`

```typescript
// 向 operation 添加可选字段（向后兼容）
export interface Operation {
  // ... 现有字段 ...

  /** 实体版本（entityVersion）：由服务端分配，用于乐观并发控制。旧版客户端使用 undefined。 */
  entityVersion?: number;
}

// 更新响应类型
export type UploadResult =
  | { status: 'OK'; serverSeq: number; entityVersion: number }
  | {
      status: 'CONFLICT';
      reason: 'CONFLICT_VERSION_MISMATCH' | 'CONFLICT_SUPERSEDED';
      currentVersion: number;
      existingClock?: VectorClock; // 向后兼容
    };
// 移除了 'CONFLICT_SYNC_LOOP' —— 在 OCC 下不可能发生
```

**文件：** `packages/super-sync-server/src/sync/sync.service.ts`
**文件：** `packages/super-sync-server/src/sync/sync.gateway.ts`

### 第三阶段：客户端追踪实体版本

**文件：** `src/app/op-log/core/types/sync-results.types.ts`

```typescript
export interface DownloadMetaEntry {
  entityType: string;
  entityId: string;
  /** 服务端在最新下载时报告的实体版本号 */
  entityVersion?: number;
}
```

**文件：** `src/app/op-log/sync/operation-log-download.service.ts`

```typescript
// 在处理操作时，从下载响应中提取 entityVersion
// 并将其传递给操作应用流
```

**文件：** `src/app/op-log/sync/operation-log-apply.service.ts`

```typescript
// 当应用操作时，如果下载结果中包含 entityVersion，将其存储在本地实体版本映射中
// 源：下载响应中的 entityVersion
// 存储：简单的 <entityKey → version> 映射（仅限内存），与 op.id → op 存储方式无关
```

### 第四阶段：客户端在上传中包含实体版本

**文件：** `src/app/op-log/sync/operation-log-upload.service.ts`

```typescript
// 构造上传 payload 时：
const entityVersion = this.getEntityVersion(op.entityType, op.entityId);
const uploadOp = {
  ...op,
  entityVersion, // undefined（若未知）——与向量时钟回退兼容
};
```

### 第五阶段：被拒绝操作的替代操作（Replacement Ops）

当服务器因版本不匹配拒绝上传时，客户端应：

1. 记录服务器的 `currentVersion`
2. 为该实体标记本地状态为"已过期"
3. 发起一次增量下载，获取该实体的最新操作
4. 在当前版本之上重放替代操作（reconciliation op）
5. 使用 `entityVersion: currentVersion + 1` 上传

**文件：** `src/app/op-log/sync/conflict-resolution.service.ts`

```typescript
// 处理 OCC 拒绝
if (result.status === 'CONFLICT') {
  if (result.reason === 'CONFLICT_SUPERSEDED') {
    // 版本已过期，需要合并
  } else if (result.reason === 'CONFLICT_VERSION_MISMATCH') {
    // 版本不匹配，需要重新获取
  }

  await this.downloadLatestOpsForEntity(result.entityKey);
  // 合并或重新创建操作
  // 使用 result.currentVersion + 1 上传
}
```

---

## 迁移策略

### 向后兼容性

服务器必须同时支持新旧客户端协议。如何做到：

1. 如果上传中缺少 `entityVersion`：回退到向量时钟比较
2. 如果上传结果中缺少 `entityVersion`：仅使用向量时钟继续

### 回填实体版本

新实体从版本 0 开始。现有实体需要回填：

```typescript
// 服务器迁移：为所有至少有一条操作的现有实体分配版本 1
await prisma.entityVersion.createMany({
  data: existingEntities.map((e) => ({
    userId: e.userId,
    entityType: e.entityType,
    entityId: e.entityId,
    version: 1,
  })),
  skipDuplicates: true,
});
```

迁移后首次同步时，客户端将收到 `entityVersion: 1`，并在后续上传中使用它。

## 向量时钟如何处理

向量时钟**不会被移除**。它们保留两个用途：

1. **离线因果推理**：当客户端离线并积累了多条操作时，向量时钟有助于在无需服务器介入的情况下判断哪些操作具有因果关系
2. **旧版客户端的回退方案**：服务器继续接受来自未更新客户端的仅含向量时钟的操作

随着时间的推移，随着所有客户端的更新，服务器上的向量时钟比较将成为死代码路径，可在未来的大版本中移除。

向量时钟裁剪仍然保留以节省带宽，但裁剪错误不再会导致同步循环，因为主要冲突检测使用的是实体版本。

## 风险

| 风险                                                 | 严重程度 | 缓解措施                                                                        |
| ---------------------------------------------------- | -------- | ------------------------------------------------------------------------------- |
| 实体版本表随实体数量增长                             | 低       | 每个用户每个实体一行；受限于用户数据量                                          |
| 客户端丢失实体版本（存储被清除）                     | 低       | 回退到向量时钟比较；服务器在下一次交互时返回版本号                              |
| 版本检查与更新之间的竞态条件                         | 中       | 使用 `REPEATABLE_READ` 隔离级别的数据库事务（已用于当前冲突检测）               |
| 两个客户端同时上传同一实体版本                       | 中       | 只有一个会成功（原子递增）；另一个使用新版本重试                                |
| 离线客户端持有过期实体版本                           | 低       | 服务器拒绝；客户端下载最新版本，使用当前版本创建替代操作                        |
| 服务器上的架构迁移                                   | 中       | 追加变更（新表、新可选字段）；对现有数据无破坏性变更                            |

## 验证

### 单元测试（Unit Tests）

- 服务器：OCC 版本匹配/不匹配时的接受与拒绝
- 服务器：`entityVersion` 缺失时回退到向量时钟比较
- 客户端：经上传/下载/拒绝循环的实体版本追踪
- 客户端：替代操作包含来自拒绝的正确实体版本

### 集成测试（Integration Tests）

- 使用实体版本管理的完整同步周期：创建、上传、第二台设备下载、修改、上传
- 冲突场景：两个客户端上传同一实体版本，一个成功，另一个重试
- 混合客户端：旧版客户端（仅向量时钟）和新版客户端（实体版本）修改同一实体
- 离线场景：客户端在离线状态下积累操作，重新连接，通过实体版本解决冲突

### E2E 测试（E2E Tests）

- 同步循环回归测试：确保使用实体版本管理后，原始 bug 中的同步循环场景不再可能发生

## 与其他方案的关系

- **基于：** 服务端裁剪感知比较（Server-Side Prune-Aware Comparison）（方案文档已在 `985e839747` 中删除；使用 `git show 669f2d7874:docs/long-term-plans/server-side-prune-aware-comparison.md` 查看）——两者可按任意顺序实施；裁剪感知比较改进了向量时钟回退路径
- **相关：** 当前客户端修复（提交 `f9be1c8500`）作为向量时钟回退路径的纵深防御（defense-in-depth）仍保留
- **相关：** [SuperSync 加密架构](../sync-and-op-log/supersync-encryption-architecture.md)——实体版本不是敏感数据，无需加密

## 实施顺序

1. **服务器：添加 `EntityVersion` 表及迁移**（无需客户端变更）
2. **服务器：在接受操作时追踪实体版本**（与现有向量时钟逻辑并行）
3. **服务器：在上传结果和下载负载中返回 `entityVersion`**
4. **客户端：从服务器响应中存储并追踪实体版本**
5. **客户端：在上传的操作中包含 `entityVersion`**
6. **客户端：在替代操作中使用来自拒绝响应的 `currentVersion`**
7. **回填迁移现有实体**
8. **集成测试与 E2E 测试**

每一步均可独立部署且向后兼容。
