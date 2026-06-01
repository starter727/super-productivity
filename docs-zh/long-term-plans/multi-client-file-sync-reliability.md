# 使基于文件的同步在多个并发客户端下可靠

> **状态：已计划**

## 当前漏洞

单一文件方法（`sync-data.json`）在多个客户端同时同步时存在以下特定弱点：

### 1. 上传冲突时仅重试一次

`_uploadWithRetry()`（`file-based-sync-adapter.service.ts:474`）在版本不匹配时**仅重试一次**。当 3 个以上客户端以相近间隔同步时，这次重试也可能失败——第二次上传尝试没有后备方案。

### 2. 竞态窗口宽

上传周期为：下载 → 读取状态快照 → 合并操作 → 加密 → 压缩 → 上传。这可能耗时数秒（尤其是状态较大且包含归档文件时）。在此期间任何其他客户端上传都会引发冲突。

### 3. 每次上传完整状态

每次上传都包含**完整的应用状态**（第 452 行：`getStateSnapshot()`）、两个归档文件和最近 500 条操作。这使得文件庞大、上传缓慢，从而加宽了竞态窗口。

### 4. WebDAV 版本追踪粒度粗糙

WebDAV 使用 `lastmod`（秒级精度）作为版本号。同一秒内的两次上传无法区分。文件内部的 `syncVersion` 计数器可作补偿，但前提是两次尝试之间确实重新下载了文件。

### 5. LocalFile 没有原子 CAS

对于本地文件同步（Electron/Android），没有服务端的比较-交换操作。版本号是客户端计算的 MD5 哈希，但读取-修改-写入并非原子操作。

## 实际有多严重？

**对于 2 个客户端来说表现尚可**，因为：

- 捎带机制（piggybacking）在重试时合并并发上传
- 向量时钟 + LWW 正确解决实体级冲突
- 500 条操作的缓冲区足够容纳并发变更
- 同步间隔（如 5 分钟）通常提供了足够的间隔

**3 个以上客户端或同步间隔过短时变得脆弱**，因为单次重试不够，且文件庞大导致上传缓慢。

---

## 三个级别的改进

### 级别 1：加固单一文件方法（小改动）

**内容**：修复最明显的弱点，不改变存储模型。

**对 `file-based-sync-adapter.service.ts` 的修改：**

1. **带指数退避的重试循环**替代单次重试
   - 将 `_uploadWithRetry()` 替换为循环：最多尝试 3-5 次
   - 在重试之间添加随机退避（200ms、400ms、800ms + 抖动）
   - 每次重试重新下载、重新合并、重新上传
   - 约修改 30 行

2. **上传前加锁文件**（可选，适用于支持该功能的提供者）
   - 上传前写入包含客户端 ID + 时间戳的 `sync.lock` 文件
   - 其他客户端检查该锁，若锁仍在有效期内（< 30s）则跳过/等待
   - 上传后删除锁
   - 代码库已有先例：`migration.lock`
   - 约增加 50 行

3. **WebDAV：使用 ETag 头**代替 `lastmod` 作为版本号
   - 更精确的冲突检测
   - 需要检查 WebDAV 提供者的实现

**优点**：最小代码变更，向后兼容，无需迁移
**缺点**：仍有根本性限制——单一文件仍然是瓶颈
**可靠性提升**：对于 3-4 个客户端和合理的同步间隔（2 分钟以上）足够

---

### 级别 2：将操作与状态分离（中等改动）

**内容**：拆分为两个文件——**状态快照**（不频繁更新）和**操作日志**（每次同步更新）。这减少了争用，因为大多数同步周期只涉及操作文件。

**存储结构：**

```
sync-data.json          → 状态快照（每 N 次同步或按需更新）
sync-ops.jsonl          → 仅追加的操作日志（每次同步更新）
sync-meta.json          → 向量时钟 + syncVersion + 元数据
```

**工作原理：**

- **上传操作**：将新操作追加到 `sync-ops.jsonl`。这比重写完整状态更小更快。
- **下载操作**：读取 `sync-ops.jsonl`，过滤出新操作。快速，因为只涉及操作而非完整状态。
- **快照更新**：定期（每第 10 次同步，或操作文件过大时）用当前状态重写 `sync-data.json` 并重置 `sync-ops.jsonl`。
- **冲突**：`sync-meta.json` 包含 `syncVersion` 计数器。仅在上传期间有争用，且文件很小（上传快 → 竞态窗口小）。

**关键洞察**：大多数同步周期根本不需要触及大的状态文件。操作文件很小。对文件的冲突很少发生且解决迅速。

**优点**：显著减少争用，上传更小，向后兼容的迁移路径
**缺点**：需要管理三个文件而非一个；仅追加的 JSONL 需要定期压缩；不支持追加操作的提供者（Dropbox）需要重新上传操作文件
**可靠性提升**：能良好处理 4-5 个以上并发客户端

**需要修改的文件：**

- `file-based-sync-adapter.service.ts` — 拆分上传/下载逻辑以处理多个文件
- `file-based-sync.types.ts` — 添加 `OperationLogEntry`、`SyncMeta` 接口
- 新文件：`sync-ops-file-adapter.ts` — 操作文件专用逻辑
- 约 200 行变更

---

### 级别 3：每客户端操作批次（大规模改动）

**内容**：每个客户端维护自己的操作批次文件，从根本上消除文件争用。没有共享的可变文件。

**存储结构：**

```
clients/
  ├── client-A/
  │   ├── manifest.json
  │   └── ops/
  │       ├── batch-001.jsonl
  │       ├── batch-002.jsonl
  │       └── ...
  ├── client-B/
  │   ├── manifest.json
  │   └── ops/
  │       ├── batch-001.jsonl
  │       └── ...
  └── snapshot.json    （可选：定期完整状态快照）
```

**工作原理：**

- **上传**：每个客户端写入自己的文件——无争用
- **下载**：读取其他客户端的 manifest，只下载新的批次文件
- **快照**：可选的快照文件，用于新客户端的引导或压缩
- **冲突**：通过向量时钟 + LWW 解决——只要文件能分别读写，就无文件争用

**优点**：无写入争用（最可靠的模型）；支持高频率同步；彻底解决冲突问题
**缺点**：最大变更量；所有提供者都需要 `listFiles()` 支持；需要压缩/垃圾回收策略；需要 300-400 行新代码
**可靠性提升**：处理任何数量的并发客户端

**需要修改的文件：**

- `file-based-sync-adapter.service.ts` — 大幅重写上传/下载/合并逻辑
- 新文件：`file-based-sync-level3.ts` — 新存储结构逻辑
- `file-based-sync.types.ts` — 添加 `ClientManifest`、`BatchFile` 类型
- `file-based-sync-adapter.service.spec.ts` — 新测试场景
- 约 300-400 行

---

## 级别 3 协调设计

### 我们需要 `listFiles()` 吗？

**是的，但仅用于对端发现**——并且可以通过清单方法最小化使用。

级别 3 需要 `listFiles()` 做两件事：

1. **发现对端**：列出 `clients/` 目录以查找其他客户端 ID
2. **查找批次文件**：列出 `clients/<peerId>/ops/` 以查找新的操作批次

我们可以通过**每客户端清单文件**完全消除第 2 项需求。每个客户端更新自己的 `manifest.json`，包含其批次文件列表。其他客户端通过确切路径（`clients/<peerId>/manifest.json`）读取清单——无需目录列表。

这样 `listFiles()` 就**仅用于对端发现**（列出 `clients/` 一次以查找新对端）。已知对端在本地缓存。

### 协调流程（最小化 `listFiles()`）

**首次同步/对端发现**（需要一次 `listFiles()`）：

1. `listFiles('clients/')` → 发现对端目录
2. 在本地存储已知对端 ID（localStorage）
3. 读取每个对端的 `manifest.json` → 获取批次文件列表 + 向量时钟
4. 通过确切路径下载批次文件 → 应用操作
5. 如果是引导阶段：读取任一对端的 `snapshot.json` 获取初始状态

**正常同步周期**（不需要 `listFiles()`）：

1. **上传**：写入新的批次文件 → 更新自己的 `manifest.json`
2. **下载**：对每个已知对端，读取 `manifest.json` → 下载新的批次文件
3. **定期发现**：偶尔（每 N 个周期）执行 `listFiles('clients/')` 以查找新对端

### 能否完全避免 `listFiles()`？

**考虑的替代方案：**

1. **用户配置的对端**：用户手动输入设备 ID。对 2-3 台设备可行但用户体验差。
2. **每客户端注册文件**：每个客户端写入 `register/<myId>.json`。仍然需要列出 `register/` 来查找对端。
3. **共享注册表文件**：一个 `peers.json` 列出所有对端。这就产生了我们试图避免的共享可变文件问题。

**结论**：`listFiles()` 是最干净的解决方案。缺失的实现微不足道：

- **Electron**：添加 `ipcMain.handle(IPC_FILE_SYNC_LIST_FILES, ...)` 配合 `fs.readdirSync()`——约 10 行
- **Android SAF**：在 Capacitor 插件中调用 `DocumentFile.listFiles()`——SAF 的原生能力

实现 `listFiles()` 比设计一个避免它的发现机制简单得多。

### 目录创建需求

级别 3 需要 `clients/<id>/ops/` 目录存在：

- **WebDAV**：通过 MKCOL 在上传时自动创建父目录（已实现）
- **Dropbox**：`create_folder_v2` API（Dropbox API 中已可用）
- **Electron**：`fs.mkdirSync(path, { recursive: true })`——添加到 IPC 处理器
- **Android SAF**：`DocumentFile.createDirectory()`——添加到 Capacitor 插件

### 各提供者的级别 3 前提条件

| 前提条件                      | WebDAV       | Dropbox                  | Electron                          | Android                        |
| ----------------------------- | ------------ | ------------------------ | --------------------------------- | ------------------------------ |
| `listFiles()`                 | 已存在       | 已存在                   | **需要 IPC 处理器**（约 10 行）   | **需要实现**                   |
| 目录创建                      | 自动(MKCOL)  | 需要 `createDir()` 调用  | 需要 `mkdirSync()` 调用           | 需要 `createDirectory()` 调用  |
| 上传到子目录                  | 可用         | 可用                     | 可用                              | 可用                           |
| 从子目录下载                  | 可用         | 可用                     | 可用                              | 可用                           |

---

## 额外发现

### 已解决：捎带机制已移除（提交 6ec885cce2）

捎带机制已从基于文件的同步适配器中移除。远程操作现在仅通过下一个同步周期中的 `downloadOps()` 发现，从而消除了陈旧的捎带错误并简化了上传路径。

### 未使用的校验和字段

`FileBasedSyncData` 已包含一个未使用的 `checksum?: string` 字段（`file-based-sync.types.ts` 第 83 行）。可在任何改进级别中用于完整性验证。

### 已在生产环境确认

最近的提交 `87d884ed17`（"fix(sync): prevent recurring task duplication across clients"）确认多客户端同步问题是用户实际遇到的问题，而非纯理论问题。

### Electron LocalFile 同样缺少 `listFiles()`

IPC 事件 `FILE_SYNC_LIST_FILES` 已在 `ipc-events.const.ts:46` 定义并在 `preload.ts:47-48` 暴露，但 Electron 主进程中**没有 `ipcMain.handle()` 实现**。因此 `listFiles()` 在 Android SAF 和 Electron LocalFile 上都缺失。

### 各提供者的目录创建行为不同

- **WebDAV**：通过 MKCOL 在上传时自动创建父目录（`webdav-api.ts` 第 314-345 行）
- **Dropbox 和 LocalFile**：不自动创建目录——如果父目录不存在，上传会失败
