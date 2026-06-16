# 文件同步 Gap 检测漏洞分析

## 问题背景

文件同步（Dropbox/WebDAV）使用 `syncVersion`（全局版本号）做增量同步。每次上传 +1，客户端记录自己上次下载到的版本号（`sinceSeq`），下次下载时只拉取新版本的 ops。

Gap 检测的目的是：发现文件被"重置"（另一个客户端重新初始化、上传快照覆盖、ops 被裁剪等）时，触发全量导入而不是增量同步。

## 当前的三种 Gap 触发条件

代码位置：`file-based-sync-adapter.service.ts:628-661`

```ts
// 条件 1：syncVersion 倒退
const versionWasReset = previousExpectedVersion > 0 && syncData.syncVersion < previousExpectedVersion;

// 条件 2：快照替换（recentOps 为空，但有 state）
const snapshotReplacement = sinceSeq > 0 && syncData.recentOps.length === 0 && !!syncData.state && ...;

// 条件 3：ops 被裁剪
const partialTrimGap = sinceSeq > 0 && syncData.oldestOpSyncVersion > sinceSeq && syncData.recentOps.length >= MAX_RECENT_OPS;
```

## 未覆盖的场景

### 场景描述

```
初始状态：
  文件 syncVersion=5
  客户端 A 记录 sinceSeq=5

时间线：
  客户端 F 重新初始化文件 → syncVersion=1
  客户端 F 创建 op1 → syncVersion=2
  客户端 D 创建 op2 → syncVersion=3
  客户端 E 创建 op3 → syncVersion=4
  客户端 D 创建 op4 → syncVersion=5
  客户端 E 创建 op5 → syncVersion=6

客户端 A 下载：
  文件 syncVersion=6，客户端 A 的 sinceSeq=5
  → versionWasReset: 6 ≥ 5 → 不触发 ❌
  → snapshotReplacement: recentOps 不为空 → 不触发 ❌
  → partialTrimGap: 取决于缓冲是否满 → 可能触发也可能不触发
```

### 后果

1. Gap 检测未触发 → 走增量下载
2. 下载到新世界的 ops（op5 等）
3. 这些 ops 的向量时钟（如 `{F:1, D:2}`）和客户端 A 的时钟（`{A:5, B:3}`）没有交集
4. 向量时钟比较结果：CONCURRENT
5. LWW 自动解决（不是弹对话框）→ 静默接受或拒绝
6. **用户完全无感知，但数据可能被静默覆盖或丢失**

### 为什么是静默的

LWW（Last-Write-Wins）是比较时间戳的自动机制：

- 时间戳更新的一方赢
- 时间戳相同 → 远程赢
- 不弹对话框，不通知用户

所以即使 gap 检测失败导致走错了路径，用户也看不到任何提示。数据丢失是静默的。

## 正常新客户端加入不会触发此问题

```
正常场景：
  客户端 C 是全新设备，从未同步过
  C 先下载文件 → 拿到 {A:5, B:3}
  C 创建 op → 时钟变成 {A:5, B:3, C:1}
  C 上传 → 文件时钟 {A:5, B:3, C:1}
  A 下载 → 时钟有交集 {A, B} → 正常增量同步

重新初始化场景：
  客户端 F 重新初始化 → 文件时钟清空 → {F:1}
  其他客户端推 → {F:1, D:2, E:3}
  A 下载 → 时钟无交集 → 但 gap 检测没拦住
```

关键区别：正常新客户端会**先下载继承现有时钟**，然后才上传。重新初始化是**清空时钟从头开始**。

## 可能的修复方向

### 方案 1：向量时钟交集检查

在 gap 检测阶段加入向量时钟兼容性检查：

```ts
// 伪代码
const fileClock = syncData.vectorClock;
const localClock = await this.vectorClockService.getCurrentVectorClock();
const hasIntersection = Object.keys(fileClock).some((k) => k in localClock);

const clockIncompatible = sinceSeq > 0 && !hasIntersection;
const needsGapDetection =
  versionWasReset || snapshotReplacement || partialTrimGap || clockIncompatible;
```

**优点**：直接检测"时钟断层"，语义清晰
**缺点**：需要保存或获取本地时钟；极端情况下（pruning 导致交集为空）可能误报

### 方案 2：syncVersion 跳跃检测

检查 syncVersion 的跳跃幅度是否合理：

```ts
// 伪代码
const versionJump = syncData.syncVersion - previousExpectedVersion;
const opsReceived = syncData.recentOps.filter(
  (op) => op.sv > previousExpectedVersion,
).length;
const suspiciousJump = versionJump > opsReceived + 1; // 跳跃幅度远大于收到的 ops 数量
```

**优点**：不需要额外状态
**缺点**：阈值不好定；如果刚好有刚好够多的 ops 就检测不到

### 方案 3：组合检测

结合 syncVersion、向量时钟、clientId 多个信号：

```ts
const versionJumped = syncData.syncVersion > previousExpectedVersion + 1;
const clockChanged = !hasIntersection(syncData.vectorClock, localClock);
const clientIdChanged = syncData.clientId !== lastSeenClientId;

// 三个信号中任意两个同时出现 → 触发 gap
const needsGapDetection = ... || (versionJumped && clockChanged) || (clockChanged && clientIdChanged);
```

**优点**：多信号组合减少误报
**缺点**：逻辑更复杂

## 相关代码位置

| 文件                                                                          | 作用                                           |
| ----------------------------------------------------------------------------- | ---------------------------------------------- |
| `src/app/op-log/sync-providers/file-based/file-based-sync-adapter.service.ts` | Gap 检测逻辑（`_downloadOps` 方法）            |
| `src/app/op-log/sync/remote-ops-processing.service.ts`                        | 冲突检测（`detectConflicts` 方法）             |
| `src/app/op-log/sync/conflict-resolution.service.ts`                          | LWW 自动解决（`autoResolveConflictsLWW` 方法） |
| `docs/sync-and-op-log/vector-clocks.md`                                       | 向量时钟架构文档                               |
| `docs/sync-and-op-log/file-based-sync-flowchart.md`                           | 文件同步流程图                                 |

## 与 #8308 的关系

这是两个独立的问题：

| 问题                 | 位置                          | 后果                                           |
| -------------------- | ----------------------------- | ---------------------------------------------- |
| #8308 快照竞态       | `OperationLogSnapshotService` | 本地 seq 和 state 不一致，下次 hydration 丢 op |
| Gap 检测漏洞（本文） | `FileBasedSyncAdapterService` | 文件被重置后走增量同步，LWW 静默丢数据         |

两个都需要修，互不依赖。#8308 已有 PR #8439。

## 验证方法

要验证这个 gap 是否真实存在，可以：

1. 在两台设备上同步
2. 设备 A 创建一些任务并同步（syncVersion 推到比如 10）
3. 设备 B 断网
4. 设备 A 做一次 force upload（模拟重新初始化）
5. 设备 B 在断网期间创建一些任务
6. 设备 B 恢复网络并同步
7. 检查设备 B 的任务是否完整——如果 gap 检测没拦住，部分任务可能被 LWW 静默覆盖
