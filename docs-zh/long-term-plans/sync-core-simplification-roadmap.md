# Sync Core 简化路线图

> **状态：已规划**

**目标：** 在不破坏现有行为的前提下，降低同步栈的认知负荷和架构耦合度。

**主要关注点：** 客户端同步编排。

**为何现在做：** 同步实现功能丰富且经过充分测试，但编排层积累了较多边界情况。
最高价值的工作是在进行更广泛的协议或服务器重构之前，先简化控制流和边界。

---

## 目标架构

1. `SyncWrapperService` 仍然是应用/UI 边界。
2. 同步结果使用可辨识联合类型（Discriminated Unions）替代标志袋（Flag Bags）。
3. 全状态同步流程与增量操作同步分离。
4. Provider 能力显式化且范围更窄。

---

## 优先级

1. 用可辨识联合类型替换标志袋
2. 将全状态同步流程从增量同步中提取出来
3. 分解冲突解决模块
4. 简化 provider 能力/合约（仅在必要时）
5. 仅当协议漂移成为真正的维护问题时，考虑共享协议架构

---

## 第零阶段：安全护栏

**目的：** 在进行行为保持的重构之前建立稳定的基线。

**所需交付物：** 此阶段应产生具体的产物，而不仅仅是探索性笔记。

### 检查清单

- [ ] 确定以下模块的最小高信号单元/集成测试套件：
  - `src/app/imex/sync/sync-wrapper.service.ts`
  - `src/app/op-log/sync/operation-log-sync.service.ts`
  - `src/app/op-log/sync/remote-ops-processing.service.ts`
  - `src/app/op-log/sync/conflict-resolution.service.ts`
  - SuperSync 集成场景
  - 基于文件的同步集成场景
- [ ] 盘点以下模块中当前所有的同步结果形状和控制标志：
  - `src/app/op-log/core/types/sync-results.types.ts`
  - `src/app/op-log/sync/operation-log-download.service.ts`
  - `src/app/op-log/sync/operation-log-upload.service.ts`
  - `src/app/op-log/sync/operation-log-sync.service.ts`
  - `src/app/imex/sync/sync-wrapper.service.ts`
- [ ] 为目标边界编写简短的设计说明或架构决策记录（ADR）：
  - 全状态同步与增量同步分开处理
  - 结果类型使用可辨识联合类型，而非标志袋
- [ ] 制作一个 Markdown 表格，列出当前同步结果类型和编排交接中使用的所有标志/可选字段
- [ ] 草拟增量同步结果的第一版可辨识联合类型设计

### 退出标准

- [ ] 已商定当前同步结果和控制标志的列表
- [ ] 当前标志/可选结果字段的 Markdown 表格
- [ ] 草拟的可辨识联合类型设计已经评审并作为起点被接受
- [ ] 已商定重构阶段的执行顺序

---

## 第一阶段：用可辨识联合类型替换标志袋

**目的：** 减少分支复杂度，使控制流具备穷尽性和显式性。

**范围约束：** 此阶段仅适用于增量同步路径。全状态结果建模应在第二阶段提取这些流程时最终确定。

### 范围

- `src/app/op-log/core/types/sync-results.types.ts`
- `src/app/op-log/sync/operation-log-download.service.ts`
- `src/app/op-log/sync/operation-log-upload.service.ts`
- `src/app/op-log/sync/operation-log-sync.service.ts`
- `src/app/imex/sync/sync-wrapper.service.ts`

### 检查清单

- [ ] 为以下各项定义独立的结果类型：
  - 传输层下载结果
  - 传输层上传结果
  - 增量编排步骤结果
  - 增量同步会话结果
- [ ] 替换可选字段和组合状态标志，例如：
  - `cancelled`
  - `serverMigrationHandled`
  - `needsFullStateUpload`
  - `localWinOpsCreated`
  - `snapshotVectorClock`
  - `hasMorePiggyback`
- [ ] 将包装器/编排器的分支逻辑转换为基于 `kind` 的 `switch` 语句
- [ ] 移除存在多种解释可能性的布尔值模糊组合
- [ ] 在可行处添加穷尽性检查

### 建议的结果形状

- `DownloadTransportResult`
- `UploadTransportResult`
- `IncrementalSyncStepResult`
- `IncrementalSyncSessionResult`

### 退出标准

- [ ] 包装器和编排器代码基于带标签的结果进行分支，而非布尔值组合
- [ ] 结果类型直接编码互斥的状态

---

## 第二阶段：提取全状态同步流程

**目的：** 将 `SYNC_IMPORT` 及相关特殊情况从增量操作同步路径中移除。

### 范围

- `src/app/op-log/sync/operation-log-sync.service.ts`
- `src/app/op-log/sync/operation-log-download.service.ts`
- `src/app/op-log/sync/operation-log-upload.service.ts`
- `src/app/op-log/sync/server-migration.service.ts`
- `src/app/op-log/sync/sync-import-filter.service.ts`

### 新模块

- [ ] `src/app/op-log/sync/full-state-sync.service.ts`
- [ ] `src/app/op-log/sync/full-state-sync.types.ts`

### 检查清单

- [ ] 将全状态职责移至专门的服务之后：
  - `SYNC_IMPORT`
  - `BACKUP_IMPORT`
  - `REPAIR`
  - 服务器迁移引导
  - provider 切换引导
  - 加密/重置场景的清空状态流程
- [ ] 集中处理用于全状态冲突决策的"有意义的本地数据"检查
- [ ] 集中处理全状态冲突准备和解决所需的输入数据
- [ ] 将增量同步维持在其核心范围：
  - 下载操作
  - 处理操作
  - 上传操作
  - 重试本地胜利操作（local-win ops）
- [ ] 保持新客户端、迁移和基于文件引导场景的现有行为不变

### 退出标准

- [ ] `OperationLogSyncService` 不再拥有大部分全状态分支逻辑
- [ ] 全状态行为实现在一个专门的服务边界之后

---

## 第三阶段：分解冲突解决模块

**目的：** 减小冲突解决层的体积和策略密度。

**风险：** 本路线图中风险最高的阶段。`ConflictResolutionService` 与实体注册表、
向量时钟工具、存储选择器和操作应用流程紧密耦合。此阶段在实施开始之前
可能需要自己的子方案。

### 范围

- `src/app/op-log/sync/conflict-resolution.service.ts`
- `src/app/op-log/sync/remote-ops-processing.service.ts`

### 新模块

- [ ] `src/app/op-log/sync/conflict-strategies/`

### 检查清单

- [ ] 将实体特定的 LWW 合并逻辑提取到独立的策略模块中
- [ ] 主冲突解决服务保留以下职责：
  - 编排
  - 重试
  - 持久化更新
  - 批量应用协调

### 退出标准

- [ ] `ConflictResolutionService` 主要是一个协调者
- [ ] 实体特定的合并行为被隔离，更易于测试
- [ ] 如果依赖提取比预期更复杂，存在一个专门的子方案

---

## 第四阶段：简化 Provider 能力

**目的：** 在完成更高价值的重构后，重新考虑 provider 合约的简化。

**状态：** 可选重新考虑阶段，并非承诺的重构。仅在第一至第三阶段显示当前
provider 合约确实增加了复杂度时才推进。

### 范围

- `src/app/op-log/sync-providers/provider.interface.ts`
- `src/app/op-log/sync-providers/file-based/file-based-sync-adapter.service.ts`
- `src/app/op-log/sync-providers/wrapped-provider.service.ts`

### 检查清单

- [ ] 审查 `OperationSyncCapable` 是否应拆分为更小的能力，例如：
  - 操作传输
  - 快照传输
  - 远程重置能力
  - 序列游标存储
- [ ] 避免在抽象增加复杂度而非清晰度时，强制基于文件的同步模仿基于服务器的同步
- [ ] 在缩窄合约的同时保持基于文件支持的行为完全一致
- [ ] 在第二阶段之后重新评估包装/适配边界是否可以简化

### 退出标准

- [ ] Provider 合约更准确地反映实际职责
- [ ] 基于文件的同步在类型层面上与 SuperSync 风格语义的耦合降低

---

## 延期工作

### 共享的客户端/服务器架构

有用，但优先级低于客户端编排清理。

- [ ] 仅在响应/请求漂移导致实际 bug 或反复出现维护问题时重新审视

### 服务器分解

以后有用，但当前不是主要瓶颈。

- [ ] 仅在服务器复杂度或部署需求发生实质性变化时重新审视

---

## 推荐执行顺序

1. 第零阶段
2. 第一阶段
3. 评审检查点
4. 第二阶段
5. 第三阶段
6. 重新考虑第四阶段是否值得做

---

## 评审检查点

### 检查点 A：第一阶段之后

- [ ] 确认结果类型更易于推理
- [ ] 确认没有留下模糊的结果组合

### 检查点 B：第二阶段之后

- [ ] 确认增量同步路径明显更简单
- [ ] 确认全状态流程被集中，更易于审计

---

## 验证策略

- [ ] 每个阶段之后运行受影响服务的聚焦单元测试
- [ ] 第一阶段和第二阶段之后运行 op-log 同步集成测试
- [ ] 第二阶段之后运行有针对性的 SuperSync 和基于文件的 E2E 场景：
  - 新客户端
  - provider 切换
  - 同步导入
  - 加密变更
  - 冲突解决

---

## 首次实施切片

如果需要立即开始工作，从**第一阶段**开始。

理由：

- 它带来的认知负荷降低最大（标志袋 → 穷尽式 switch 语句）
- 它自然地暴露出控制流在哪些地方与结果解释纠缠在一起
- 它为全状态提取（第二阶段）的清晰设计提供了便利
