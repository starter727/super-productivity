# 同步简化：文档整合 + 强制执行贡献者模型

**日期：** 2026-05-15
**状态：** 设计——经多人审阅修订（gemini + Claude 子代理；codex/copilot 在此环境中不可用）。下方融入了审阅中确认的三个阻塞问题。
**范围：** 仅第 1 层 + 第 2 层（见"范围"）。无生产 TypeScript 变更；保持行为不变。

## 上下文和核心发现

目标：降低同步架构的**维护负担**和**概念复杂性**——在脑海中需要记住的更少，上手更容易。

研究（四个并行深入分析，见"证据"）产生了一个反直觉的结论，塑造了此计划的整个形态：

> **同步代码并没有有意义地被过度工程化。团队已经做了困难的简化（删除了 PFAPI 约 83 个文件，移除了向量时钟防御层，将两个传输统一在一个 `OperationSyncCapable` 接口 + 共享的 `@sp/sync-core` 编排器后面）。三个先前的独立分析拒绝了每个更简单的模型（增量同步、LWW、CRDT），原因与一个困难的、不可协商的约束有关：在并发多设备编辑、离线优先、使用哑/E2EE 文件服务器的情况下，无静默数据丢失。**

每个候选领域的发现：

| 领域 | 结论 | 安全的代码缩减 | 风险 |
|---|---|---|---|
| 传输重复 | 已统一；`file-based-sync-adapter` 是*在哑存储上的必要服务器模拟*，非冗余 | 约 50-120 LOC，触及最脆弱的代码（快照水合；问题 #7339/#7330） | 高——**排除** |
| 验证/修复 | 大多是负载相关的；"4522 LOC"包括 471 个仅测试 LOC | 约 155-215 LOC（第 3 层，**推迟**） | 低 |
| 四个贡献者规则 | **真正的成果**——全部四条是一个不变量；代码库已 100% 符合 | 不适用（添加 lint） | 非常低 |
| 文档分散 | **最大的成果**——约 33 个文件/约 600 KB，一个可证明过时的文档虚假标记为"已完成" | 不适用（文档） | 近乎零 |

因此：代码的维护负担上限低且有风险。**概念复杂性**的痛苦有一个巨大、廉价、低风险的修复，位于**文档**和**分散/未强制执行的贡献者规则**中——这就是本计划的内容。

## 范围

**范围内（第 1 层 + 第 2 层）：**

1. 将 `docs/sync-and-op-log/` 从约 33 个文件整合为精简的授权集。
2. 添加一个新的 `contributor-sync-model.md`，捕获单一的同步不变量。
3. 向现有的 `eslint-local-rules/` 插件添加两个 ESLint 规则，以*强制执行*该模型而非依赖记忆。
4. 收紧 CLAUDE.md 同步规则 1-3、6，每条一行 + 链接到新文档。

**明确排除（不在此计划中）：**

- 第 3 层代码清理（死的 `DataRepairService`、typia 冗余守卫、`providerMode` 判别式）。单独跟踪；回报低，推迟。
- 对同步运行时的任何更改、操作日志核心、向量时钟、冲突解决、提供程序或 `super-sync-server`。
- 替换引擎或删除提供程序（在研究中较早被拒绝）。

## 第 1 层——文档整合

### 目标活动文档集（7 个文档）

| 文档 | 操作 |
|---|---|
| `README.md` | 重写为纯导航索引。删除历史/状态表（它们漂移；这种漂移是问题的一部分）。 |
| `operation-log-architecture.md` | 保持为**唯一的**权威架构文档。融入：（a）`quick-reference.md` 的独特速查表作为附录；（b）新的精简**"被拒绝的替代方案及原因"**部分，保存来自 `background-info/` 的负载相关理由（无静默数据丢失 / 离线 / 哑 E2EE 服务器约束；为什么增量同步、LWW、CRDT 被拒绝）。 |
| `contributor-sync-model.md` | **新。** 单一的贡献者心智模型（见第 1 层 §"新文档"）。 |
| `vector-clocks.md` | 保持原样（当前；被 CLAUDE.md 规则 8 引用）。 |
| `supersync-encryption-architecture.md` | 保持原样（当前；已实现）。 |
| `operation-rules.md` | 保持原样（简短、当前、与 lint 对齐）。 |
| `package-boundaries.md` | 保持原样（简短、当前、匹配强制执行的 eslint 边界）。 |
| `diagrams/`（目录） | 保持为规范的图表集。在必要时融入 3 个游离流程图的独特内容。 |

### 删除（硬删除；git 历史是存档）

无 `archive/` 文件夹。删除；如果幸存的文档需要理由，链接**删除它的 git 提交**（`see commit <hash> for historical <topic> design`）。

- `long-term-plans/hybrid-manifest-architecture.md`——**可证明过时且误导**：描述了一个多文件 `manifest.json` + `ops/` 方案，**零**代码引用（`OperationLogManifestService` 不存在；实时格式是单文件 `sync-data.json`），却自标签为"已完成"。最高优先级删除。
- `long-term-plans/replace-pfapi-with-oplog-plan.md`——2026 年 1 月完成；结果已被当前架构文档捕获。
- `long-term-plans/e2e-encryption-plan.md`——已被 `supersync-encryption-ar`

动作创建器；消息指向 `root-store/meta/task-shared-meta-reducers/`。`warn`（像 `require-entity-registry`）因为启发式有误报；允许使用带理由注释的内联禁用。

每个规则获得一个同位置的 `.spec.js`（ESLint `RuleTester`），模仿 `require-hydration-guard.spec.js`，在 `eslint-local-rules/index.js` 中注册并添加到 `eslint.config.js`。`no-multi-entity-effect` spec 必须包含一个**正向"受祝福路径"用例**（通过 `task-shared-meta-reducers/` 元 reducer 路由的多实体变更），以便正确模式在测试中得到文档化。

**Spec 运行器（审阅 C3——必须修复）：** `npm test` 仅对 `*.spec.ts` 运行 Karma；它**不**运行 `.spec.js`。现有的 `require-hydration-guard.spec.js` 目前**没有运行器和 CI 步骤**（死覆盖）。添加一个 `"test:lint-rules"` npm 脚本（例如 `node --test "eslint-local-rules/**/*.spec.js"`）加上 CI 步骤，这也复活了现有的孤立 spec。这是除文档和规则外唯一的添加项，在第 2 层范围内。

无生产 TypeScript 变更。无运行时行为变更。

## CLAUDE.md 变更

- 规则 **1、2、3、6**（一个不变量的四个面）：每条收紧为一行简洁文本，仍然说明防护栏（保留在始终加载的上下文中），但将机制/原因通过链接移到 `contributor-sync-model.md`。
- 规则 **1** 的文档指针：`operation-log-architecture-diagrams.md §8` → `docs/sync-and-op-log/contributor-sync-model.md`。
- 规则 **4、5、7、8、9** 与此不变量无关 → 不变（规则 8 仍然指向 `vector-clocks.md`，该文件保留）。

## 执行顺序（以便链接在迁移中永不悬空）

1. 创建 `contributor-sync-model.md`。
2. 将 `background-info/` 理由（全新综合）+ `quick-reference.md` 表格 + 图表单体内容融入 `operation-log-architecture.md` / `diagrams/`——**排除**单体的过时 §5/§6 Hybrid Manifest 部分（C2）。
3. 修复所有交叉引用（上表）到最终目标——**包括外部 `docs/long-term-plans/server-side-entity-versioning.md:328`（C1）**。
4. 删除过时/被取代/融入的源文档。
5. 将 `README.md` 重写为最终 7 个文档 + `diagrams/` 的索引；将 `contributor-sync-model.md` 添加到 CLAUDE.md"每任务必读"并从 `CONTRIBUTING.md` 链接它（可见性——gemini 建议）。
6. 添加两个 ESLint 规则 + spec + `index.js`/`eslint.config.js` 注册 + `test:lint-rules` npm 脚本 + CI 步骤（C3）。
7. 收紧 CLAUDE.md 规则 1-3、6 + 重新指向规则 1。
8. 运行完整的验证清单；只有那时变更才算完成。

## 验证

- Markdown 链接检查**所有 `docs/`（包括 `docs/long-term-plans/`）和 CLAUDE.md** → 零悬空链接。（扫描**不能排除 `docs/long-term-plans/`**——那是 C1 外部引用的所在位置。）
- 在 `*.md *.ts *.js` 上运行 `grep -rn "hybrid-manifest\|quick-reference\|architecture-diagrams\|background-info\|supersync-scenarios\|file-based-sync-flowchart\|payload-optimization\|replace-pfapi\|e2e-encryption-plan"`（仅排除 `docs/sync-and-op-log/` 和 `docs/plans/`）→ 迁移后零命中。
- `npm run lint` 干净；`no-actions-in-effects` 在当前树上产生 **0** 个违规（证明它是纯回归守卫，非迁移）。
- `npm run test:lint-rules` 绿色（新运行器；也重新覆盖了先前孤立的 `require-hydration-guard.spec.js`）。
- **已收紧（审阅 R4）：** 在 `src/ packages/` 上运行 `git grep -E "HybridManifest|OperationLogManifestService"` → 零。（**不** grep 裸 `manifest.json`——它有数十个不相关的插件/i18n 命中并且会误报。）

## 风险

- **总体低**——文档 + 不可绕过的 lint + CLAUDE.md 文本。无生产代码路径变更；无同步行为变更。
- *删除时的知识丢失：* 通过将负载相关理由在**删除前**融入架构文档，加上 git 历史 + 提交哈希引用，缓解。
- *`no-multi-entity-effect` 误报：* 通过以 `warn` 发布并允许带理由的内联禁用缓解。
- *CLAUDE.md 过于简洁：* 防护栏句子保留在始终加载的上下文中；仅"原因"移至链接的文档。

## 证据（研究来源）

- 复杂度清单：操作日志约 28 K LOC；传输已统一在 `OperationSyncCapable` + `@sp/sync-core` 后面。
- 先前分析（`background-info/`）：由于无数据丢失/离线/哑 E2EE 服务器约束，选择操作日志而非增量同步/LWW/CRDT。
- 过时文档证据：代码中零 `HybridManifest`/`manifest.json` 引用；实时格式是 `sync-data.json`（`file-based-sync-adapter.service.ts`）。
- 贡献者规则统一：0 个 `inject(Actions)` 在任何 `*.effects.ts` 中；`require-hydration-guard` 已强制执行选择器边界。
