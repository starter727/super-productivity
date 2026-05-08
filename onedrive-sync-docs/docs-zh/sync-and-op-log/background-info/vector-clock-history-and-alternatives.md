# 向量时钟裁剪（Pruning）：文献综述与最佳实践

本研究于 2026 年 2 月整理，用于验证并解释 Super Productivity 同步系统中使用的向量时钟裁剪策略。

---

## 1. 核心问题

向量时钟大小会随参与客户端数量线性增长。在用户长期使用 10-20+ 设备的场景中，无上限时钟会浪费存储与带宽。裁剪可降低大小，但代价是 **假并发（false concurrency）**：被裁掉的条目可能让本来有因果先后关系的事件看起来并发。

**所有资料的共同结论：** 假并发是可接受的（会产生可处理冲突），而假排序（错误地判定某时钟大于另一个）会导致静默数据丢失。

---

## 2. 文献中的裁剪策略

### 2.1 Amazon Dynamo（2007）— 按大小裁剪

- **策略：** 当时钟超过阈值（约 10 条）时，丢弃最老条目（按墙钟时间戳）。
- **权衡：** 简单，但“最老”依赖时间戳，在多节点下可能不准确。
- **来源：** DeCandia 等，《Dynamo: Amazon's Highly Available Key-value Store》，SOSP 2007，4.4 节。

### 2.2 Riak（2.0 前）— 大小 + 时间混合裁剪

- **策略：** 使用四个可调参数：
  - `small_vclock` / `big_vclock` — 大小阈值
  - `young_vclock` / `old_vclock` — 年龄阈值
- **行为：**
  - 小于 `small_vclock` 不裁剪
  - 小于 `young_vclock` 不裁剪
  - 大于 `old_vclock` 激进裁剪
  - 大于 `big_vclock` 无视年龄直接裁剪
- **已知问题（Riak #613）：** 比较前裁剪导致 sibling 无限累积。修复与我们一致：先比较，后裁剪再存储。
- **来源：** Basho Riak 文档；GitHub issue basho/riak_kv#613。

### 2.3 Voldemort（LinkedIn）— 按活跃度裁剪

- **策略：** 移除已退役或不再活跃副本节点的条目。
- **动机：** 固定副本系统里，只需保留活跃副本条目。
- **不适用于 Super Productivity：** 这里的“副本”是用户设备，加入/离开不可预测。
- **来源：** Project Voldemort 文档与源码。

### 2.4 Causal Stability（CRDT）— 理论方案

- **策略：** 计算所有副本已知时钟的逐分量最小值（stable cut）。低于该阈值的事件被全部副本看见，可安全 GC。
- **前提：** 需要副本间周期性交换元数据来计算 stable cut。
- **权衡：** 无假并发（精确 GC），但需要全副本通信。
- **不适用于 Super Productivity：** 设备是间歇在线，要求所有客户端可达并不现实。
- **来源：** Almeida 等，《Scalable and Accurate Causality Tracking for Eventually Consistent Stores》，DISC 2014。

---

## 3. 可完全避免裁剪的替代方案

### 3.1 Dotted Version Vectors（Riak 2.0+）

- **概念：** 将时钟大小限制为 **副本数**（而非客户端数）。每条记录副本最新事件并用“dot”标识本次写入。
- **优点：** 时钟大小等于副本数，通常固定且较小（3-5）。
- **限制：** 需要固定且已知副本集合。每个用户设备都算副本时不直接适配。
- **来源：** Preguiça 等，《Dotted Version Vectors: Logical Clocks for Optimistic Replication》，arXiv:1011.5808。

### 3.2 Interval Tree Clocks

- **概念：** 用树结构动态适配参与者集合，支持 fork（新参与者）与 join（参与者退出），避免无界增长。
- **优点：** 能适配动态参与者集合，无需裁剪。
- **限制：** 实现复杂，生产落地较少。
- **来源：** Almeida 等，《Interval Tree Clocks: A Logical Clock for Dynamic Systems》，OPODIS 2008。

### 3.3 基于时间戳的 LWW（Cassandra）

- **概念：** 放弃向量时钟，直接用墙钟时间戳做冲突决策（新者胜）。
- **优点：** 元数据 O(1)，无时钟膨胀问题。
- **限制：** 时钟漂移会造成静默数据丢失；无法真正检测并发。
- **为何不选：** 用户设备时钟不可靠，个人效率应用不能接受静默丢数据。

---

## 4. 关键规则：先比较，再裁剪

这是最重要结论，且被多个来源验证：

> **绝不能在比较向量时钟之前先裁剪。**

### 原因

裁剪会丢信息。若时钟 A 为 `{X:1, Y:2, Z:3}`，你在与 `{X:1, Y:2, Z:3}` 比较前先去掉 Z，A 就会看起来“不知道 Z”，导致结果从 EQUAL 变成 CONCURRENT。

### 历史问题

1. **Riak #613：** 比较前裁剪导致 sibling 爆炸，对象累积数百 sibling 且无法收敛。
2. **Super Productivity（2026-02）：** 服务端比较前裁剪在 MAX=10 时触发无限拒绝循环。客户端 K 合并全时钟 + 自己 ID（11 条），服务端裁成 10 条，因非共享键返回 CONCURRENT，服务端拒绝，客户端重合并后再次被拒，循环不止。修复：MAX 提升至 20，并改为比较后裁剪。

### 正确流程（两者一致）

```
1. 接收客户端完整时钟
2. 用完整（未裁剪）时钟与存储时钟比较
3. 若接受：先裁剪，再存储
4. 若拒绝：返回拒绝结果与存储时钟，供客户端侧解决
```

---

## 5. 裁剪感知比较（Pruning-Aware Comparison）

当双方都已裁剪时，标准比较可能失真，因为缺失键既可能表示“从未见过该客户端”，也可能表示“被裁掉了”。常见有两类：

### 5.1 保守策略（Super Productivity 当前方案）

当双方时钟都达到 MAX 时：

- 仅比较共享键
- 若较小一侧存在非共享键，返回 CONCURRENT
- 理由：非共享键可能代表未知因果历史

### 5.2 Riak 旧策略（2.0 前）

- 缺失键按 0 处理（标准比较）
- 接受由此产生的假并发，表现为 sibling
- 在读取侧通过应用级合并 sibling

### 权衡

Super Productivity 的保守策略会产生更多冲突，但不会产生假排序。Riak 方案冲突更少，但要求更强 sibling 合并机制。

---

## 6. 对 Super Productivity 设计的验证

当前项目采用了简单的 2+1 层方案：

| 层                  | 当前机制                                 | 先例                        |
| ------------------- | ---------------------------------------- | --------------------------- |
| 1. 服务端比较后裁剪 | 用完整时钟比较，通过后再裁剪入库         | Dynamo、Riak（#613 修复后） |
| 2. 同客户端校验     | 针对 import 客户端自身操作做单调计数校验 | 项目特有，且数学上总是正确  |

### 文献支持点

- 固定 MAX 的大小裁剪是主流（Dynamo、Riak）
- 比较后裁剪是硬约束（Riak #613、Dynamo 经验）
- 裁剪导致假并发是“安全方向”（各来源一致）
- 优先修根因（MAX 太小）而非叠防御层，是标准工程实践

### 项目创新点

- 同客户端校验：利用单调计数器在 import 后精确判定（不受 MAX 影响，始终数学正确）

### 为什么 MAX=20 让系统大幅简化

原先的 4 层防御（保护 client ID、裁剪感知比较、`isLikelyPruningArtifact`、同客户端校验）是为绕过根因：MAX=10 太小，裁剪频繁且与 SYNC_IMPORT 交互不佳。提交 `d70f18a94d` 将 MAX 从 10 提升到 30，后调整为 20（20 项时钟约 333 字节，开销很小），并移除了“治标”防御层。MAX=20 下，至少要 21+ 唯一客户端才会触发裁剪，对个人效率应用极罕见。`isLikelyPruningArtifact` 因存在误判且在 MAX=20 下价值有限也被移除。仅保留同客户端校验作为安全网，因为它始终是数学正确的。

---

## 7. 潜在后续改进

### 7.1 Dotted Version Vectors（若服务端走权威化）

若架构演进为服务端主协调（而非中继），可将时钟大小绑定到服务端活跃 vnode 数，而非客户端设备数。

### 7.2 客户端注册 + 有界 ID

为客户端分配小范围有界数字 ID（如 0-15）。客户端退役后回收 ID。可在不裁剪前提下限制时钟大小，但需配套注册/退役协议。

### 7.3 周期性 Stable-Cut GC

若客户端定期上报其已知时钟，服务端可计算 stable cut，并通知客户端可安全 GC 的条目。可消除裁剪引发的假并发，但需要全量通信。

---

## 8. 参考来源

1. DeCandia, G. et al. (2007). "Dynamo: Amazon's Highly Available Key-value Store." SOSP '07.
2. Almeida, P. S. et al. (2008). "Interval Tree Clocks: A Logical Clock for Dynamic Systems." OPODIS '08.
3. Preguiça, N. et al. (2010). "Dotted Version Vectors: Logical Clocks for Optimistic Replication." arXiv:1011.5808.
4. Almeida, P. S. et al. (2014). "Scalable and Accurate Causality Tracking for Eventually Consistent Stores." DISC '14.
5. Basho Riak 文档 — Vector Clocks、Dotted Version Vectors.
6. Basho/riak_kv GitHub issue #613 — 比较前裁剪导致 sibling 爆炸。
7. Project Voldemort 文档 — 版本控制与冲突解决。
8. Apache Cassandra 文档 — 时间戳与冲突解决。
