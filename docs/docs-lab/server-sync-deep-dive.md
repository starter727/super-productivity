# 服务器同步（Part C）深度分析

> 基于 [operation-log-architecture.md](../../docs/sync-and-op-log/operation-log-architecture.md) Part C 的详细技术分析。
> SuperSync 是唯一支持服务器同步的 provider，其他 provider（WebDAV/Dropbox/LocalFile/OneDrive）走文件型同步（Part B）。

---

## 1. 服务器同步 vs 文件型同步

| 维度              | 文件型同步 (Part B)                           | 服务器同步 (Part C)                                |
| ----------------- | --------------------------------------------- | -------------------------------------------------- |
| **同步单位**      | 整个 `sync-data.json` 文件                    | 单条操作（Operation）                              |
| **传输方式**      | 读写一个 JSON 文件                            | HTTP API（`/api/sync/ops` + `/api/sync/snapshot`） |
| **op-log 的角色** | 从 op-log 构建快照写入文件，op-log 本身不同步 | op-log **就是**同步的内容                          |
| **冲突检测**      | 文件级别（syncVersion 乐观锁 + ETag）         | 实体级别（向量时钟）                               |
| **冲突解决**      | 整个文件选一个版本                            | LWW 字段级自动解决                                 |
| **带宽**          | 每次传输完整状态（几 MB）                     | 只传输增量操作（几百字节）                         |
| **`syncedAt`**    | 不需要                                        | 必须（每条操作独立标记）                           |

文件型同步的 `sync-data.json` 里 95% 是完整状态（`state`），`recentOps` 只占 5% 用于冲突检测。服务器同步只传增量——设备 A 改了任务标题，上传一条 `UPD` 操作（几百字节），设备 B 下载应用，没有冗余传输。

只有 SuperSync 能做服务器同步，因为它需要服务端具备：存储单条操作、分配全局递增 `serverSeq`、按序号查询、向量时钟比较。WebDAV/Dropbox 没有这些能力。

---

## 2. 操作同步协议

### 2.1 接口

```typescript
interface OperationSyncCapable {
  supportsOperationSync: true;
  uploadOps(
    ops: SyncOperation[],
    clientId: string,
    lastKnownSeq: number,
  ): Promise<UploadResponse>;
  downloadOps(
    sinceSeq: number,
    clientId?: string,
    limit?: number,
  ): Promise<DownloadResponse>;
  getLastServerSeq(): Promise<number>;
  setLastServerSeq(seq: number): Promise<void>;
}
```

### 2.2 上传

```
读取所有未同步操作（syncedAt 为空）
    │
    ▼
按 25 条一批上传
    │
    ├── uploadOps(batch, clientId, lastKnownSeq)
    │
    ▼
处理响应
    ├── 标记已接受的操作为已同步（syncedAt）
    └── 处理搭便车的新操作（piggybacked ops）
```

**搭便车**：设备 A 上传时，服务器在响应里顺便返回设备 B 刚上传的操作，省一次 HTTP 往返。

### 2.3 下载

```
读取本地 lastServerSeq
    │
    ▼
循环（每批最多 500 条）
    ├── downloadOps(sinceSeq, limit=500)
    ├── UUID 去重（跳过已应用的操作）
    ├── 应用新操作
    ├── 更新 sinceSeq
    └── hasMore=true → 继续
    │
    ▼
更新本地 lastServerSeq
```

内存上限 `MAX_DOWNLOAD_OPS_IN_MEMORY = 50,000`。

---

## 3. 全状态操作的路由

`SYNC_IMPORT`、`BACKUP_IMPORT`、`REPAIR` 包含完整应用状态（10-30MB+），走专用的 `/api/sync/snapshot` 端点（30MB limit）。常规操作走 `/api/sync/ops`。

| OpType          | Snapshot Reason | 场景                   |
| --------------- | --------------- | ---------------------- |
| `SYNC_IMPORT`   | `initial`       | 首次同步或完整状态刷新 |
| `BACKUP_IMPORT` | `recovery`      | 从备份文件恢复         |
| `REPAIR`        | `recovery`      | 自动修复后的完整状态   |

---

## 4. 冲突检测

### 4.1 核心前提

**只有本地有未同步操作时才可能冲突。** 没有 pending ops → 远程操作直接应用，没有本地工作会丢失。

### 4.2 检测算法

```
对每个远程操作：
    │
    ├── 找到同实体的本地 pending ops
    │
    ├── 没有 pending → 不冲突，直接应用
    │
    ├── 有 pending → 构建本地前沿（已同步时钟 + pending 时钟并集）
    │
    └── 向量时钟比较
          ├── CONCURRENT → 冲突
          └── 其他（GREATER/LESS/EQUAL）→ 不冲突
```

冲突检测的关键是**未提交的变更**，不是历史状态。已同步的操作客户端之间已经协调过了，不构成冲突。

---

## 5. 冲突解决

### 5.1 核心机制：向量时钟 + LWW

整个同步系统的冲突机制就两个：

- **向量时钟** → 检测冲突（两个操作是不是同时改了同一个实体）
- **LWW** → 解决冲突（比时间戳，新的赢）

```
向量时钟检测到 CONCURRENT
    │
    ▼
比较本地和远程的最大时间戳
    │
    ├── 本地时间戳更大 → 本地赢
    │     ├── 拒绝双方旧操作（标记 rejectedAt）
    │     ├── 从 NgRx 当前状态创建新的 UPDATE 操作
    │     ├── 新操作的时间戳 = 本地操作的最大时间戳（不用 Date.now()）
    │     └── 新操作下次同步上传
    │
    └── 远程时间戳更大或相等 → 远程赢（包括平局）
          ├── 应用远程操作
          └── 拒绝本地 pending ops
```

**关键细节**：本地赢时新操作保留**本地操作的最大时间戳**，不用 `Date.now()`。否则在未来的冲突中本地总有不公平优势。

### 5.2 被拒绝的操作

留在日志里用于调试，`getUnsynced()` 排除它们，压缩时最终清理。用户会看到 snack："Sync conflicts auto-resolved: X local win(s), Y remote win(s)"。

### 5.3 归档胜出规则（Archive-Wins Rule）

唯一绕过 LWW 的例外：当 `moveToArchive` 与字段级更新冲突时，归档**永远赢**。

```
设备 A：归档任务 X（T1）
设备 B：改任务 X 标题（T2, T2 > T1）

普通 LWW → B 赢 → 任务 X 被"复活"回活跃状态
Archive-Wins → A 赢 → 任务 X 保持归档
```

归档代表明确的用户意图，不应被并发字段修改"复活"。

**两层防御**：

| 层级   | 位置                        | 做什么                                         |
| ------ | --------------------------- | ---------------------------------------------- |
| 第一层 | `ConflictResolutionService` | 冲突检测到归档操作 → 直接让归档赢              |
| 第二层 | `bulkOperationsMetaReducer` | 预扫描操作批次 → 跳过与归档同实体的 LWW Update |

处理 3+ 客户端场景：LWW Update 可能先于归档操作到达同一批次。

### 5.4 归档里的任务再被改

任务已归档后，多个客户端同时修改它的字段：

```
任务 X 已在 archive_young 表里

客户端 A：updateTask(X, {isDone: true})   T1
客户端 B：updateTask(X, {isDone: false})  T2, T2 > T1

两边都是 updateTask，都不是 moveToArchive
→ 走普通 LWW，不走 Archive-Wins
→ B 赢，修改应用到 archive_young 里的任务 X
```

`_handleUpdateTask` 会检查任务是否在归档里，在的话直接更新归档存储（不走 NgRx reducer）。

### 5.5 Superseded 操作处理

`moveToArchive` 被服务器因并发冲突拒绝时，不会丢弃，而是**用合并后的向量时钟重新创建**。原因：归档操作把实体从 NgRx 移除，`getCurrentEntityState()` 返回 `undefined`，不特殊处理的话归档任务会丢失。

### 5.6 LWW Update 的实体类型适配

| 存储模式    | 实体类型                        | 行为                                |
| ----------- | ------------------------------- | ----------------------------------- |
| Adapter     | TASK, PROJECT, TAG, NOTE 等     | `updateOne` / `addOne` 替换单个实体 |
| Singleton   | GLOBAL_CONFIG, TIME_TRACKING 等 | 整个 feature state 替换             |
| Unsupported | Map, array, virtual patterns    | 记录 warning，不支持                |

---

## 6. 依赖解析

操作之间可能有依赖（子任务依赖父任务）。有缺失硬依赖的操作排队重试，超过 `MAX_RETRY_ATTEMPTS`（3 次）后标记永久失败。

---

## 7. SYNC_IMPORT 过滤（Clean Slate 语义）

### 7.1 问题

```
客户端 A 离线创建 Op1、Op2
客户端 B 做了 SYNC_IMPORT（从备份恢复），上传到服务器
客户端 A 上线，上传 Op1、Op2，下载 SYNC_IMPORT
→ Op1、Op2 引用的实体可能已被 import 清空
```

### 7.2 解决：向量时钟过滤

**所有不知道 import 发生过的操作都被丢弃。** 用向量时钟（不用时间戳），因为追踪的是因果关系，不是挂钟时间。

```
SYNC_IMPORT 时钟：{A: 10, B: 5}

操作 {A: 11, B: 5} → GREATER_THAN → 保留（看到了 import）
操作 {B: 3}        → LESS_THAN    → 丢弃（被 import 支配）
操作 {C: 1}        → CONCURRENT   → 丢弃（不知道 import）
```

---

## 8. 归档数据的同步机制

### 8.1 归档绕过操作日志

归档数据**不走 ops 表**，直接通过 `ArchiveDbAdapter` 写入 `archive_young` / `archive_old`。原因：体量大（几万条）、频率低、不需要操作级粒度。

### 8.2 move-to-archive 走日志

"归档"这个**动作**是一条操作日志（`TASK_SHARED_MOVE_TO_ARCHIVE`），走正常写入路径。归档后的数据存在独立表里。

```
用户归档任务 X
    ├── ① ops 表记录 MOV 操作
    ├── ② archive_young 表写入任务数据
    └── ③ NgRx store 移除任务
```

### 8.3 同步时归档怎么流动

- **SYNC_IMPORT**：完整状态包含 `archiveYoung` + `archiveOld`，归档数据随 import 到达
- **新客户端引导**：服务器找到最新 SYNC_IMPORT（快照跳过优化），里面包含完整归档数据

### 8.4 空归档安全守卫

SYNC_IMPORT 到达时如果归档字段为空但本地有归档数据，系统**保留本地归档**（不覆盖为空）。BACKUP_IMPORT 是用户主动操作，会弹确认对话框。

---

## 9. 端到端加密

```
上传：payload → Argon2id 派生密钥 → AES-256-GCM 加密 → 上传密文
服务器：只看到密文，仍可做序列号分配和转发
下载：密文 → 解密 → 得到 payload
```

加密是 payload 级别。向量时钟、操作类型、实体 ID 等元数据**不加密**，服务器可做排序和路由，但**不能**做字段级合并。

| 维度       | 文件型同步 E2EE        | 服务器同步 E2EE                   |
| ---------- | ---------------------- | --------------------------------- |
| 加密粒度   | 整个文件               | 单条操作 payload                  |
| 服务器可见 | 文件名、大小、修改时间 | 操作元数据（类型、实体 ID、时钟） |

---

## 10. 服务端安全

| 措施                                | 做什么         |
| ----------------------------------- | -------------- |
| 结构化审计日志 + 错误码             | 不泄露内部信息 |
| 请求 ID 去重                        | 幂等上传       |
| 事务隔离                            | 下载操作隔离性 |
| 实体类型白名单 + 输入校验           | 防注入         |
| 向量时钟清理                        | 防恶意膨胀     |
| 速率限制 + size 校验                | 防滥用         |
| JWT 密钥 ≥ 32 字符                  | 最小安全基线   |
| 数据库索引 `(user_id, received_at)` | 加速清理查询   |

---

## 11. 已知限制

| 限制                     | 影响                                                | 状态           |
| ------------------------ | --------------------------------------------------- | -------------- |
| 跨版本同步               | 不同 schema 版本的客户端需要 A.7.11（冲突感知迁移） | 未实现         |
| 内存上限 50,000 ops      | 极端离线场景可能需要多次同步周期                    | 设计如此       |
| 新客户端引导依赖快照缓存 | 服务器需要缓存 SYNC_IMPORT 快照                     | 依赖服务端实现 |

---

## 相关文档

- [Operation Log Architecture](../../docs/sync-and-op-log/operation-log-architecture.md) — 英文源文档
- [操作日志架构深度分析](./operation-log-architecture-q-and-a.md) — Part A/B 深度分析
- [被拒绝的备选方案深度分析](./rejected-alternatives-deep-dive.md) — 为什么选操作日志
- [NgRx + IndexedDB vs MySQL + Redis](./frontend-state-management/ngrx-indexeddb-vs-mysql-redis.md) — 前端状态管理对比
- [SuperSync 加密架构](../../docs/sync-and-op-log/supersync-encryption-architecture.md) — E2EE 详细设计
