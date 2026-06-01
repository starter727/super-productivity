# 将 SUP_OPS 折叠到单个连接——备选方案（方案 B）

**问题：** #7735——对 #7732 / #7712 / #7709 的后续跟进
**状态：** ❌ **已拒绝**——经 4 个智能体评估（2026-05-22），优先选择 [2026-05-22-supops-single-connection.md](./2026-05-22-supops-single-connection.md)（方案 A）。保留供记录。原因：（1）方案 B 使其他服务依赖 1,745 行的 OperationLogStoreService 来获取数据库句柄，违背此代码库的小叶子服务惯例（LockService 是方案 A 遵循的先例）；（2）mergeRemoteOpClocks 签名变更的影响范围大且易静默失败；（3）下面的步骤 2 基于一个**事实错误**——见行内 ⚡ 修正。方案 A 风险更低且架构更清晰。不要实现此方案。
**前置条件（硬门控）：** #7732 已合并到 master。尚未合并——详见方案 A。

## 核心思路

方案 A 通过**添加**一个新的叶子服务（SupOpsConnectionService）来打破 DI 循环，三个开启者都委托给该服务。

方案 B 通过**移除一条边**来打破循环。已验证的关键事实：

> OperationLogStoreService 注入**恰好一个依赖**——CLIENT_ID_PROVIDER（operation-log-store.service.ts:186）——并且在**恰好两个位置**使用它：mergeRemoteOpClocks() 中的 loadClientId()（:1417）和 unDestructiveStateReplacement() 中的 clearCache()（:1687）。

切断那一条边，OperationLogStoreService 就成为一个**无依赖的叶子**。一旦成为叶子，ClientIdService（以及可选的 ArchiveStoreService）可以直接依赖它，并**借用其现有的 SUP_OPS 连接**——无需新服务，无循环。OperationLogStoreService 已经拥有规范的连接：重试/退避开启器、unDbUpgrade 接线、OpLogDB schema 类型。方案 B 重用该拥有者，而不是提取一个新的。

## 为什么它是无循环的（已验证）

- OperationLogStoreService 唯一注入的依赖是 CLIENT_ID_PROVIDER。在步骤 1–3 之后，它不注入任何东西 → 它不能成为任何循环的一部分。
- CLIENT_ID_PROVIDER 有 **11 个消费者服务**（op-log 持久化、op-log 同步、验证、imex/sync）。只有 OperationLogStoreService 在（预期的）循环中。该令牌对另外 10 个服务**保持不变**；此方案不触及 CLIENT_ID_PROVIDER 抽象。
- #7735 描述的循环是*预期的*，而非当前的：在 #7732 之后 ClientIdService 不注入任何东西。循环只在*如果* ClientIdService 将数据库访问委托给 OperationLogStoreService 而后者仍注入 CLIENT_ID_PROVIDER 时才会出现。方案 B 先移除那条边，因此委托变得安全。

## 步骤

### 步骤 1——使 mergeRemoteOpClocks 将 clientId 作为参数

mergeRemoteOpClocks(ops) → mergeRemoteOpClocks(ops, currentClientId: string | null)。
方法体保留其现有的空值检查/"无法裁剪"警告；它只是读取参数而不是 wait this.clientIdProvider.loadClientId()。

调用者（约 5 个，都已注入 CLIENT_ID_PROVIDER）：
- operation-log-hydrator.service.ts——4 个调用点（:213、:239、:291、:315）。clientIdProvider 字段已存在（:57）。每次水化传递加载一次并传入。
- conflict-resolution.service.ts——1 个调用点（:432）。字段已存在（:100）；它已在 :614/:654 加载 clientId。

这可以说是*更好的设计*——mergeRemoteOpClocks 是一个纯 clock 操作；显式接受其输入比深入 DI 更好。

### 步骤 2——将 clearCache() 调用移至 unDestructiveStateReplacement 的调用者

从 unDestructiveStateReplacement()（:1687）删除 	his.clientIdProvider.clearCache()。它的 2 个调用者——ackup.service.ts:228 和 clean-slate.service.ts:132——在 wait 返回后立即自行调用 clientIdService.clearCache()。

> ⚡ **事实错误（被评估发现）。** 此步骤最初声称"两个服务都已导入 ClientIdService。"这是**错误的**——ackup.service.ts 和 clean-slate.service.ts 仅导入纯工具函数 generateClientId，而非 ClientIdService，并且两者都带有注释说明缓存清除发生在 unDestructiveStateReplacement 的事务_内部_。因此步骤 2 必须**添加**一个新的 ClientIdService 注入到另外两个服务，并**移动**一个正确性保证（绑定到已提交 	x.done 的缓存清除）到无法看到 	x.done 的调用者。这扩大了影响范围并分散了一个不变量——方案 B 被拒绝的核心原因之一。

### 步骤 3——从 OperationLogStoreService 删除 CLIENT_ID_PROVIDER 字段 + 导入

OperationLogStoreService 现在不注入任何东西 → 一个可验证的叶子。

### 步骤 4——在 OperationLogStoreService 上暴露连接

添加一个狭窄的公共表面。两个选项：

**选项 A（窄类型方法）：**

`	s
class OperationLogStoreService {
  /** 返回对 SUP_OPS 连接的引用，仅用于执行事务。调用者拥有生命周期。 */
  supOpsDb(): Promise<IDBPDatabase<OpLogDB>> { return this._ensureInit(); }
}
`

ClientIdService 调用 	his.opsStore.supOpsDb() 来获取句柄。这限制了从 ClientIdService 对 OperationLogStoreService 的可见 API 表面——仅为数据库句柄。

**选项 B（操作委托）：**

`	s
class OperationLogStoreService {
  async supOpsPut(storeName: string, value: unknown, key?: IDBValidKey): Promise<void> {
    const db = await this._ensureInit();
    await db.put(storeName, value, key);
  }
}
`

更安全（不暴露原始 IDBPDatabase 句柄），但为每个操作添加样板。对于仅具有 get/put 的 ClientIdService，选项 B 是约 8 行的委托——值得。

### 步骤 5——将 ClientIdService 重写为注入 OperationLogStoreService

`	s
class ClientIdService {
  private opsStore = inject(OperationLogStoreService);
  // 删除：private pfDb = null; 保持不变。
  // 删除：_openSupOpsDb()。
  // 现有 _resolve() 流程：
  //   1. 缓存命中 → 返回
  //   2. 委托给 this.opsStore.supOpsDb() → .get(CLIENT_ID)
  //   3. 回退 pf → 复制转发
  //   4. 生成 → 委托给 this.opsStore.supOpsDb() → .put(CLIENT_ID)
}
`

### 步骤 6——将 ersionchange 处理器添加到 OperationLogStoreService

OperationLogStoreService 现在拥有连接；添加一个 ersionchange 处理器（镜像 ClientIdService 今天已有的）。由于它现在是连接拥有者，这是应用程序为 op-log/clientId 连接所需的单一处理器。

> **首先**以其自己的小型 PR 发布步骤 6，与方案 A 的第一阶段完全一致——潜在的 v6→v7 升级挂起修复不应等待此重构。ArchiveStoreService 也在第一篇 PR 中获得一个。

### 步骤 7——（可选）合并 ArchiveStoreService

ArchiveStoreService 不注入 CLIENT_ID_PROVIDER，因此 ArchiveStoreService → OperationLogStoreService 今天就是无循环的。要达到*整个进程共享一个连接*，ArchiveStoreService 注入 OperationLogStoreService 并放弃自己的开启器；_withRetryOnClose（iOS #6643）保留，重定向到失效钩子。没有步骤 7，最终状态是两个连接（op-log+clientId 共享，存档独立）。

### 步骤 8——（可选）移动 ClientIdService

ClientIdService 仍然从 op-log/ 导入 OperationLogStoreService，因此 core → op-log 的反转持续存在（与今天相同，未恶化）。要消除它，将 ClientIdService 移动到 op-log/util/ 并添加 ESLint 
o-restricted-imports 防护——与方案 A 的第三阶段相同，同样可选/可分离。

## 涉及的文件

operation-log-store.service.ts、operation-log-hydrator.service.ts、conflict-resolution.service.ts、ackup.service.ts、clean-slate.service.ts、client-id.service.ts，以及它们的 spec 和引用 mergeRemoteOpClocks 的 op-log 集成辅助工具。可选步骤 7：rchive-store.service.ts。可选步骤 8：约 16 个导入位置 + eslint.config.js + 文档。**无新文件。**

## 预估规模

| 范围 | Diff 改动量 |
| --- | --- |
| 步骤 1–5（核心：切断边，共享连接） | 约 300–350 |
| + 步骤 7（合并存档） | + 约 80 |
| + 步骤 8（移动 + ESLint） | + 约 80 |
| **完整方案 B** | **约 450–500** |
| （完整方案 A，供比较） | 约 750–1,100 |

方案 B 更小，主要因为它不添加服务且不添加新的 spec 文件，并且连接机制是*原地重用*而不是移动。

## 验收标准

- OperationLogStoreService 不注入任何东西——一个可验证的叶子（可搜索：类中无 inject(）。
- ClientIdService 不再打开 SUP_OPS；它通过 OperationLogStoreService 路由。
- mergeRemoteOpClocks 和 unDestructiveStateReplacement 不再引用 CLIENT_ID_PROVIDER；clearCache 责任在两个破坏性调用者处并由测试覆盖。
- op-log/clientId 连接注册 close + ersionchange 处理器。
- client-id.service.spec.ts 数据安全矩阵在测试替身重写后通过（私有接缝移到 OperationLogStoreService）。
- unDestructiveStateReplacement 原子性不变；添加并发回归测试。
- 步骤 7：整个进程共享一个 SUP_OPS 连接。
- 完整的单元套件（两种时区变体）+ 操作日志集成规范绿色通过。

## 风险与缓解措施

| 风险 | 缓解措施 |
| --- | --- |
| 如果未来的 OperationLogStoreService 获得触及 ClientIdService 的注入依赖，可能产生循环 | "不注入任何东西"是强制性的验收标准；存储服务*应该*是叶子 |
| clearCache 现在位于 2 个调用者位置——未来的破坏性流程中可能忘记一个 | 今天只有 2 个调用点；用测试覆盖两者；考虑 ESLint/审查注释。（方案 A 保持集中——这是 A 的一个真正优点。） |
| ClientIdService / ArchiveStoreService 依赖整个 1,745 行的 OperationLogStoreService 来获取数据库句柄 | 步骤 4b：只暴露狭窄的类型方法，而非原始句柄——DI 依赖在类上，但*使用的*表面很小 |
| mergeRemoteOpClocks 签名变更波及 spec 和集成辅助工具 | 约 5 个调用点 + 辅助工具；机械性的，已枚举 |
| OperationLogStoreService 成为连接"房东"（双重责任）| 这是 A-vs-B 的核心权衡——见下文 |

## 与方案 A 的核心权衡

- **方案 A** 添加一个专用的 SupOpsConnectionService（单一职责：它*只*拥有连接）。分离更清晰；多一个服务/文件；更大的 diff；保留 CLIENT_ID_PROVIDER 在 OperationLogStoreService 上。
- **方案 B** 移除一个依赖边，使 OperationLogStoreService 本身能成为连接拥有者。活动部件更少；无新文件；更小的 diff；使 OperationLogStoreService 成为真正的叶子并使 mergeRemoteOpClocks 显式化——但 OperationLogStoreService 同时承担连接拥有权*和*操作存储，而其他服务依赖它来获取数据库句柄。

KISS 偏向 B；单一职责纯粹性偏向 A。两者都正确；两者都是在一个必须完成的修复（ersionchange 处理器）之上的可选清理。

## 范围外

与方案 A 相同：遗留的 pf 读取器保持不变；无新的 schema 版本号。
