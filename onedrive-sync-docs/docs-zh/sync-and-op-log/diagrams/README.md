# 操作日志架构图（Operation Log Architecture Diagrams）

**最后更新：** 2026 年 1 月

本目录包含用于解释 Operation Log 同步架构的可视化图表。

## 图表索引

| 图表                                                             | 说明                                                             | 状态   |
| ---------------------------------------------------------------- | ---------------------------------------------------------------- | ------ |
| [01-local-persistence.md](./01-local-persistence.md)             | 本地 IndexedDB 持久化、启动恢复（hydration）、压缩（compaction） | 已实现 |
| [02-server-sync.md](./02-server-sync.md)                         | SuperSync 服务端 API、PostgreSQL、上传/下载流程                  | 已实现 |
| [03-conflict-resolution.md](./03-conflict-resolution.md)         | LWW 自动解决、SYNC_IMPORT 过滤、向量时钟                         | 已实现 |
| [04-file-based-sync.md](./04-file-based-sync.md)                 | WebDAV/Dropbox/LocalFile 通过单个 sync-data.json 同步            | 已实现 |
| [05-meta-reducers.md](./05-meta-reducers.md)                     | 多实体原子操作、状态一致性                                       | 已实现 |
| [06-archive-operations.md](./06-archive-operations.md)           | 归档副作用、双数据库架构                                         | 已实现 |
| [07-supersync-vs-file-based.md](./07-supersync-vs-file-based.md) | SuperSync 与文件同步 Provider 的对比                             | 已实现 |
| [08-sync-flow-explained.md](./08-sync-flow-explained.md)         | 同步如何工作的简明说明                                           | 已实现 |

## 快速导航

### 按主题

**入门：**

- 先看 [01-local-persistence.md](./01-local-persistence.md)，了解本地数据如何存储
- 再根据你使用的同步方式看 [04-file-based-sync.md](./04-file-based-sync.md) 或 [02-server-sync.md](./02-server-sync.md)

**理解冲突：**

- [03-conflict-resolution.md](./03-conflict-resolution.md) 解释并发修改如何被解决

**进阶主题：**

- [05-meta-reducers.md](./05-meta-reducers.md)：多实体原子操作
- [06-archive-operations.md](./06-archive-operations.md)：归档相关处理

**对比与总览：**

- [07-supersync-vs-file-based.md](./07-supersync-vs-file-based.md)：两种同步方案对比
- [08-sync-flow-explained.md](./08-sync-flow-explained.md)：同步流程逐步说明

### 按同步 Provider

| Provider  | 主要图表                                         |
| --------- | ------------------------------------------------ |
| SuperSync | [02-server-sync.md](./02-server-sync.md)         |
| WebDAV    | [04-file-based-sync.md](./04-file-based-sync.md) |
| Dropbox   | [04-file-based-sync.md](./04-file-based-sync.md) |
| LocalFile | [04-file-based-sync.md](./04-file-based-sync.md) |

## 相关文档

| 文档                                                                 | 说明             |
| -------------------------------------------------------------------- | ---------------- |
| [../operation-log-architecture.md](../operation-log-architecture.md) | 完整架构参考     |
| [../operation-rules.md](../operation-rules.md)                       | 设计规则与规范   |
| [../vector-clocks.md](../vector-clocks.md)                           | 向量时钟实现细节 |
| [../quick-reference.md](../quick-reference.md)                       | 常见模式速查     |

## 图表约定

所有图表均使用 Mermaid 语法，并遵循以下配色约定：

| 颜色             | 含义                         |
| ---------------- | ---------------------------- |
| 绿色 (`#e8f5e9`) | 成功路径、有效状态、本地操作 |
| 蓝色 (`#e3f2fd`) | 服务端/API 操作、远端操作    |
| 橙色 (`#fff3e0`) | 存储、文件操作、警告         |
| 红色 (`#ffebee`) | 错误、冲突、被过滤操作       |
| 紫色 (`#f3e5f5`) | 结果、输出、最终状态         |
