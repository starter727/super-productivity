# 将同步 clientId 从 pf 迁移到 SUP_OPS

**问题：** #7732——对 PR #7712 / 问题 #7709 的后续跟进
**状态：** 草案计划——经过三轮多智能体审查后修订
**前置条件：** #7712 已合并（2026-05-22）✓

## 目标

将同步 clientId 从遗留的 pf IndexedDB 数据库移入 SUP_OPS，以便 clientId 写入加入 OperationLogStoreService.runDestructiveStateReplacement() 中的原子多存储事务。完成后，手动实现的两阶段提交 ClientIdService.withRotation()（及其 CAS 保护和回滚失败日志）将被删除。

## 设计决策（及原因）

三轮审查汇聚到以下决策。其中两个逆转了早期草案的错误——此处保留为明确决策，以免被"再次改进"成 bug。

1. **无永久 pf 镜像。** 降级经过此 schema 版本号提升会将 SUP_OPS 以低于存储版本的版本打开 → VersionError → 无论 clientId 在哪里，操作日志/同步子系统都会失效。镜像无法挽救这种局面。pf 成为**只读、一次性迁移源。**

2. **自恢复读取，无独立迁移服务。** pf → SUP_OPS 的复制在 clientId 解析器中内联完成，由第一次读取惰性触发。这消除了初始化顺序的失败模式——clientId 在很早阶段就被读取且是**不可重新生成的**，因此自门控读取比调用顺序纪律加排序测试更安全。

3. **getOrGenerateClientId() 绝不能因读取_失败_而生成。** *（逆转了早期草案。）* 早期草案使 loadClientId() "永不抛出"，并使 getOrGenerateClientId() 在其返回 
ull 时生成。这会将瞬时的 IndexedDB 小故障转化为一个全新的 clientId，从而使设备的真正、承载历史记录的 id 成为孤儿——正是此问题旨在防止的不可重新生成的损失。因此解析器**传递 IndexedDB 读取错误**；生成_仅_在读取成功并确认任何地方都不存在 id 时发生。这与当前行为一致（当前 getOrGenerateClientId 在数据库打开失败时抛出，而不是生成）。

4. **OperationLogMigrationService 的起源操作（genesis-op）clientId 解析保持不变。** *（逆转了早期草案。）* 早期草案将其通过 getOrGenerateClientId() 路由。这是不安全的：遗留的起源操作构建为 { clientId, vectorClock: meta.vectorClock || { [clientId]: 1 } }，且 meta.vectorClock 的键是_遗留 PFAPI_ 标识——pf 的 CLIENT_ID 键。迁移必须保持从 CLIENT_ID 解析起源 clientId，以便操作的 clientId 与其自己的 ectorClock 键匹配。因此 persistClientId **保留**（不删除），并且现在还初始化新的 SUP_OPS 存储。

5. **ClientIdService 在此 PR 中_不_移动。** 移动到 op-log/util/ 是纯重命名，涉及约 12 个导入位置，零行为收益（core → op-log 的耦合已通过 client-id.provider.ts 存在）。按照"最小化变更/保持范围"的原则，这是单独的后续工作。ClientIdService 保留在 core/util/ 中，并从 op-log/persistence/ 导入 SUP_OPS schema 常量（分层异味（layering smell），但没有 lint 规则禁止，且 provider 已经跨越了该边界）。

净效果：与当前的 withRotation 机制相比大致行数中性，但在_概念_复杂性上明显胜出——跨数据库的两阶段提交被替换为单个事务内 put 加一次性幂等复制。

## 涉及的文件

| 文件 | 变更 |
| --- | --- |
| src/app/op-log/persistence/db-keys.const.ts | DB_VERSION 5→6；添加 STORE_NAMES.CLIENT_ID |
| src/app/op-log/persistence/db-upgrade.ts | 版本 6 分支：创建 client_id 存储 |
| src/app/op-log/persistence/operation-log-store.service.ts | OpLogDB schema 条目；unDestructiveStateReplacement 中的 client_id put + 提交后 clearCache()；_clearAllDataForTesting |
| src/app/core/util/generate-client-id.ts | **新建**——纯函数 generateClientId() + isValidClientIdFormat() |
| src/app/core/util/client-id.service.ts | 重写：_openSupOpsDb()、_resolve()、getOrGenerateClientId()、persistClientId()；删除 withRotation、generateNewClientId、_pfDb 字段 |
| src/app/core/util/client-id.provider.ts | CLIENT_ID_PROVIDER 保持——删除 withRotation/generateNewClientId 的导出 |
| src/app/core/util/client-id.service.spec.ts | 重写——数据安全矩阵 |
| src/app/core/util/client-id.service.integration.spec.ts | **新建**——_resolve() 在真实 IndexedDB + 错误注入上的测试 |
| clean-slate-interrupt.integration.spec.ts | 扩展：SUP_OPS.client_id 在中断后保持不变 |
| 其余引用 withRotation 的 spec 文件 | 删除 mock/期望 |
| src/app/imex/sync/sync-hydration.service.ts | generateNewClientId → getOrGenerateClientId |
| src/app/imex/sync/clean-slate.service.ts | withRotation → getOrGenerateClientId + persistClientId |
| src/app/imex/backup/backup.service.ts | withRotation → getOrGenerateClientId + persistClientId |
| src/app/op-log/migration/operation-log-migration.service.ts | generateNewClientId → getOrGenerateClientId（但 persistClientId 保留） |

## 关键代码形状

### ClientIdService

`	s
class ClientIdService {
  private _cachedClientId: string | null = null;
  private _supOpsDb: IDBPDatabase | null = null;
  private _pfDb: IDBPDatabase | null = null;  // 只读，一次性

  // 新的公开表面
  async getOrGenerateClientId(): Promise<string> {
    const id = await this._resolve();
    if (id) return id;
    // 仅在读取成功且确认不存在后生成
    return this._persistGenerated();
  }

  async persistClientId(id: string): Promise<void> {
    if (!isValidClientIdFormat(id)) throw new Error(...);
    (await this._supOpsDb()).put(STORES.CLIENT_ID, id, KEY);
    this._cachedClientId = id;
  }

  clearCache(): void {
    this._cachedClientId = null;
  }

  private async _resolve(): Promise<string | null> {
    // 1. 检查缓存
    if (this._cachedClientId) return this._cachedClientId;
    // 2. 尝试 SUP_OPS
    const supOpsId = await this._loadFromSupOps();
    if (supOpsId) { this._cachedClientId = supOpsId; return supOpsId; }
    // 3. 回退到 pf（一次性复制转发）
    const pfId = await this._loadFromPf();
    if (pfId) {
      await this._copyToSupOps(pfId);  // 幂等
      this._cachedClientId = pfId;
      return pfId;
    }
    return null;
  }

  // _resolve 私有实现：抛出 IndexedDB 错误，从不生成
  private async _loadFromSupOps(): Promise<string | null> { ... }
  private async _loadFromPf(): Promise<string | null> { ... }
  private async _copyToSupOps(id: string): Promise<void> { ... }
  private async _persistGenerated(): Promise<string> { ... }
}
`

### OperationLogStoreService

`	s
class OperationLogStoreService {
  async runDestructiveStateReplacement(...): Promise<void> {
    const tx = this._db.transaction([STORES.OP, STORES.META, STORES.CLIENT_ID, ...], 'readwrite');
    // ...现有 ops/meta 写入...
    tx.objectStore(STORES.CLIENT_ID).put(clientId, KEY);
    await tx.done;
    this._clientIdService.clearCache();   // 缓存现在在事务提交后清除
  }
}
`

## 测试策略：数据安全矩阵

client-id.service.spec.ts 必须覆盖 _resolve() 的每个分支，使用第一性原理（first-principles）的 fake pf/SUP_OPS 数据库。矩阵：

| 条件 | 预期结果 |
| --- | --- |
| SUP_OPS 有有效 id | loadClientId() → 该 id；不读取 pf，不生成 |
| SUP_OPS 空，pf 有有效 id | loadClientId() → 复制转发的 pf id；SUP_OPS 现在有该 id |
| 两者都空 | loadClientId() → 
ull；getOrGenerateClientId() 生成并持久化到 SUP_OPS |
| SUP_OPS 读取抛出 | loadClientId() 抛出；getOrGenerateClientId() 抛出，不生成 |
| pf 读取抛出（SUP_OPS 空） | 同上——loadClientId() → 
ull；getOrGenerateClientId() 抛出，不生成 |
| **迁移复制转发写入失败（配额不足）** | loadClientId() 和 getOrGenerateClientId() 返回 pf id；不抛出，不生成 |
| persistClientId | 无条件写入 SUP_OPS；设置缓存；拒绝无效格式 |
| generateClientId / isValidClientIdFormat 工具 | 纯函数；正确格式/校验 |

三个**粗体**行是数据安全核心——它们证明瞬时的 IndexedDB 故障不能产生新的 clientId。它们必须使用可以强制抛出的 fake IDB，而不仅仅是空的 IDB。

### 破坏性流程原子性

clean-slate-interrupt.integration.spec.ts 必须**扩展**：用有效格式的 id 初始化 SUP_OPS.client_id，运行现有的 opsStore.add 抛出中断，并断言中断后 SUP_OPS.client_id 保持不变（这是 withRotation 曾经手工提供的属性）。使用 'cPrior' 等短 id 的现有 fixture 必须切换到有效格式 id（B_xxxx / 长度 ≥ 10），否则新的格式校验会将它们视为不存在。

### 需要更新的其他 spec 文件

搜索 withRotation、generateNewClientId、persistClientId。已知集合：

- **withRotation 已移除：** clean-slate.service.spec.ts、ackup.service.spec.ts、clean-slate-interrupt.integration.spec.ts、operation-log.effects.spec.ts——删除 withRotation 的 mock/期望；ClientIdService 的 spy 表面变为 getOrGenerateClientId（无需手动处理缓存——unDestructiveStateReplacement 拥有 clearCache）。
- **generateNewClientId 已移除：** client-id.provider.spec.ts、sync-hydration.service.spec.ts、legacy-data-migration.integration.spec.ts——从 jasmine.createSpyObj 数组中移除；client-id.provider.spec.ts:15 的断言删除。
- **operation-log-migration.service.spec.ts：** persistClientId **保留**，因此其 :418/:434 的测试基本保持不变；只需将 generateNewClientId spy/callFake（包括 :374-379 的手动逻辑）替换为 getOrGenerateClientId。

### 测试清理

_clearAllDataForTesting() 清除 SUP_OPS.client_id 但不清除 ClientIdService._cachedClientId（独立的服务/连接）。那些清除数据然后期望新 id 的 spec 还必须调用 clientIdService.clearCache()。大多数 _clearAllDataForTesting() 的调用者在测试过程中从未创建 clientId，因此影响范围很小——但重构/重写的 spec 和调用者 spec 必须接受审计。

## 风险与缓解措施

1. **不可重新生成的 clientId（主要风险）。** pf 从不被删除或写入。_resolve() 只进行_复制_；失败的复制仍然返回有效的 pf id。getOrGenerateClientId() 仅**在**读取成功并确认各处都不存在时才生成——瞬时失败会抛出，从不生成。最坏情况是冗余复制。
2. **不支持降级。** 降级经过 v6 → VersionError → 无论 clientId 如何，操作日志死亡。每次先前的 schema 版本号提升都是如此；没有退化，也没有假装支持。没有 pf 镜像。
3. **初始化顺序。** 已消除——_resolve() 在首次读取时自我恢复。
4. **多标签。** _putClientIdIfAbsent 的单事务 CAS 汇聚并发的同源运行。混合版本标签无法序列化，但 v6 之后的旧应用的操作日志已产生 VersionError——不可用，不是数据丢失路径。
5. **Schema 升级协调。** 新的 ClientIdService 连接获得一个 ersionchange 处理器。OperationLogStoreService/ArchiveStoreService 上预先存在的 ersionchange 处理器缺失**不在范围内**——添加它们只对未来的（v6→v7）升级有帮助，而非此升级，并且留作后续工作以保持此 PR 的 diff 最小化。
6. **遗留起源操作连续性。** OperationLogMigrationService 的 clientId 解析不变（决策 4）；起源操作继续使用 CLIENT_ID，与 meta.vectorClock 的键匹配。

## 范围外 / 后续工作

前三项一起在 **#7735** 中跟踪：

- 将 ClientIdService 移到 op-log/util/（纯重命名，约 12 个导入位置）——独立 PR。
- 为 OperationLogStoreService / ArchiveStoreService 添加 ersionchange 处理器。
- 打破 OperationLogStoreService → CLIENT_ID_PROVIDER 的 DI 循环，以合并到单个共享的 SUP_OPS 连接。

尚未跟踪：

- 收紧 isValidClientIdFormat（遗留的 length >= 10 分支几乎接受任何字符串）——预先存在，不属于此 PR。
- 删除 pf 数据库——它保留为只读回退。

## 排序

#7712 已合并。作为单个 PR 提交：schema 版本号提升、服务重写和调用者重写相互依赖，无法安全拆分。
