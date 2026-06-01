# SUP_OPS ersionchange 处理器——#7735（缩小范围）

<!-- 文件名在重定范围之前命名：此计划不再涉及单个共享连接——该合并已被放弃（见最后一部分）。 -->

**问题：** #7735——作为 #7732 / #7712 / #7709 的后续跟进提出。
**状态：** 活跃计划。从 #7735 原始连接合并提案重新定范围（已放弃——见最后一部分），并在多轮智能体审查中修订，修正了早期草案中的几个事实错误。
**前置条件：** 无。此修复**独立于 #7732**，可以直接提交到 master，在 #7732 之前或之后（见"基准独立性"）。

## 目标

在两个缺乏此处理器的 SUP_OPS 连接上注册 IndexedDB ersionchange 处理器——OperationLogStoreService 和 ArchiveStoreService——以便下次 schema 版本号提升不会因缺乏处理器的连接而停滞。这是 #7735 中唯一真正的正确性修复。

它移除了**一个已知的潜在挂起**。它是必要的但本身不足以保证完全防挂升级——见"限制"。

## 潜在缺陷

当连接或标签以更高的 DB_VERSION（schema 版本号提升）打开 SUP_OPS 时，IndexedDB 在每个其他打开的连接上调度一个 ersionchange 事件。升级仅在这些连接关闭后继续；任何**保持打开的连接都会阻止升级**——正在升级的 openDB 停留在 locked 状态。没有 ersionchange 处理器的连接从不自行关闭，因此它会停滞升级，直到用户手动关闭该标签。

SUP_OPS 连接及其 ersionchange 处理器状态：

| 连接所有者 | 当前的 ersionchange 处理器 |
| --- | --- |
| OperationLogStoreService（init()） | ❌**无**——在此修复 |
| ArchiveStoreService（_init()） | ❌**无**——在此修复 |
| ClientIdService（_openSupOpsDb()） | ✅有——仅 #7732 后存在 |

此修复必须在任何 DB_VERSION 增加之前完成。

### 基准独立性

OperationLogStoreService 和 ArchiveStoreService 打开 SUP_OPS 并注册一个 close（但无 ersionchange）处理器——在 #7732 **前后方式相同**——修复是相同的两行添加。在 #7732 之前有两个 SUP_OPS 连接（都无处理器）；#7732 添加第三个（ClientIdService，自带 ersionchange 处理器）。因此此修复不依赖于 #7732，可以先完成。在 #7732 之后的 ClientIdService 处理器是一个*一致性参考*，而非依赖。

## 修复

在每个服务现有的 close 监听器旁边添加一个标准的关闭并置空（close-and-null）的 ersionchange 监听器。（#7732 后，ClientIdService._openSupOpsDb() 有一个相同的——保持三个一致。）

### OperationLogStoreService.init()

`	s
async init(): Promise<void> {
  const db = await this._openDbWithRetry();
  db.addEventListener('close', () => {
    Log.warn(
      '[OpLogStore] IndexedDB connection closed by browser. Will re-open on next access.',
    );
    this._db = undefined;
    this._initPromise = undefined;
  });
  // 较新的标签正在升级 SUP_OPS（未来 schema 版本号提升）。
  // 立即关闭，以便此连接不阻塞升级；
  // 下次 op-log 访问通过 _ensureInit() 透明地重新打开。
  db.addEventListener('versionchange', () => {
    db.close();
    this._db = undefined;
    this._initPromise = undefined;
  });
  this._db = db;
}
`

### ArchiveStoreService._init()

在其现有 close 监听器旁边添加相同的内容（字段 _db / _initPromise；日志标签 [ArchiveStore]）。

### 行为说明

- **正常操作中无行为变化。** 处理器仅在 ersionchange 时动作——即 schema 版本号提升——今天根本没有定义行为（升级只是挂起）。此修复将挂起转变为优雅的关闭并重新打开；其他一切不变。
- **db.close() 是优雅的——它不中止进行中的事务。** 根据 IndexedDB 规范，脚本化的 close()（orced 标志为 false）设置一个*关闭待定*标志，让连接上已在运行的每个事务**运行完成**，然后才关闭——它不会引发 AbortError。因此，在事务中途到达的 ersionchange（例如在 unDestructiveStateReplacement 期间）让该事务正常提交；升级的标签只需等待它。处理器运行后的新工作通过 _ensureInit() 进行并打开一个新连接（处理器将 _db 置空）。orced 标志的中止路径（AbortError）适用于浏览器强制关闭 / deleteDatabase，不适用于此处理器。
- 脚本化的 db.close() 也**不会**触发 close 事件，因此 ersionchange 处理器必须自行将 _db / _initPromise 置空——与 ClientIdService 的处理器的做法完全相同。
- 处理器闭合了 db 并无条件地将 	his._db 置空。过期的 ersionchange 不能破坏一个*较新的*连接：因为处理器捕获了 db 引用（本地变量），之后设置 	his._db = undefined。如果已经有一个较新的连接在 	his._db 中，则此置空是虚假的——下一个 _ensureInit() 打开另一个连接，但旧的 db 是已关闭的，容错。为完全避免竞态，在置空前添加一个守卫（if (this._db === db) this._db = undefined）。但由于两步进程（fire → close → _initPromise 链），实际中的竞态可能性极低。

### 此修复不做的事情

- 它无助于仍在运行修复前代码的**旧标签**——该连接没有 ersionchange 处理器，仍然阻塞升级。完全防挂的版本号提升发布还需要一个 locked 路径的 UX 方案；那属于 schema 版本号提升 PR，不属于这里。
- 一个 openDB({ blocked }) 诊断回调（在此服务自己的打开被其他标签阻塞时记录日志）**推迟**——它是诊断功能，不是修复；保持此 PR 最小化。

## 验收标准

- OperationLogStoreService 和 ArchiveStoreService 各自注册一个 ersionchange 处理器，该处理器调用 db.close() 并清除 _db / _initPromise。
- 每个服务的单元测试——包括新创建的 rchive-store.service.spec.ts——证明 dispatch-ersionchange → 关闭（连接不可用）→ 透明重新打开的契约，加上一个 close 处理器回归测试。
- 测试不改变任何 SUP_OPS DB 版本；完整的单元套件（两种时区变体）保持绿色通过。
- 
pm run checkFile 在每个修改或创建的 .ts 文件上干净通过。

## 预估值

2 个文件中约 10–12 行生产代码；operation-log-store.service.spec.ts 添加约 35–45 行测试代码，加上新的 rchive-store.service.spec.ts（包括 TestBed 样板约 60–80 行——也为 ArchiveStoreService 提供了首次测试覆盖）。一个小的、低风险的 PR。

## 提交信息

ix(sync): add versionchange handlers to SUP_OPS connections

## 问题处置

此 PR 关闭 #7735，其原始文本提出了更大的合并方案。因此该决策不会被埋没：两个计划文档（2026-05-22-supops-single-connection.md 和已拒绝的备选方案 -alt.md）**放入此 PR**，PR 描述加上 Closes #7735 注释必须明确说明连接合并方案已评估并有意放弃，链接到本文档。不提交单独的跟踪问题——合并是"不计划"，而非"推迟"。

---

## 连接合并：不计划

#7735 原本提议将三个 SUP_OPS 连接合并为一个共享连接，打破 DI 循环，并将 ClientIdService 移出 core/。经过两轮多智能体审查后，**该范围被放弃。** 理由：

- **无行为收益。** #7735 自己也承认了这一点。DI 循环是*预期的*，而非实际的——在 #7732 之后 ClientIdService 不注入任何东西，因此今天没有循环。三个同源连接能正确序列化它们的事务；这是文档化的、可工作的状态，而非缺陷。
- **糟糕的 LOC 权衡。** 合并不是一个删除并简化的重构——它*添加*一个服务文件和几百行净新代码（主要是新的测试内容）并编辑约 16 个文件，零行为变化，位于应用程序最安全关键的路径上（op-log + clientId + 破坏性替换）。
- 其下唯一真正的收益——在两个服务间去重 _openDbWithRetry——约 50 行，不足以证明其余部分的合理性。

如果未来的 SUP_OPS schema 迁移使单一连接真正有价值，则**与那次迁移捆绑进行**（当您已经在有新鲜测试的代码中时，连接提取的边际成本很小）并使用下面的参考设计。不要独立进行。

### 参考设计——提取 SupOpsConnectionService（不计划；仅用于未来迁移）

如果合并方案确实被重新启用的首选方法（在多智能体评估中以 5–1 击败了备选方案）：

- 提取一个**无依赖的叶子** SupOpsConnectionService（在 op-log/persistence/ 中），拥有 SUP_OPS 连接生命周期：openDB + unDbUpgrade + 重试/退避（_openDbWithRetry）+ close/ersionchange 处理器 + 进行中承诺去重。它必须 inject() 无内容——这就是使其循环安全的原因。此代码库中的先例：LockService。
- OperationLogStoreService、ArchiveStoreService、ClientIdService 委托给它。保持每个服务现有的 _ensureInit() / db-getter 形状为薄委托，以便约 50 + 约 56 个内部调用点不受影响。
- 保持 CLIENT_ID_PROVIDER 完全不变（它有 11 个消费者，与连接问题无关）。
- 可选地将 ClientIdService 移动到 op-log/util/ + 添加 ESLint 
o-restricted-imports 规则禁止 core → op-log（此部分与 schema 迁移无关，即使在那时也将是单独可选的）。

**已被拒绝**的备选方案——通过切断 CLIENT_ID_PROVIDER 边使 OperationLogStoreService 本身成为连接拥有者——已文档化，并附有多智能体评估的理由，见 [2026-05-22-supops-single-connection-alt.md](./2026-05-22-supops-single-connection-alt.md)。完整的原始分阶段合并分解保留在此文件的 git 历史中（重定范围前的修订版）。
