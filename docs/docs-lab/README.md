# Docs Lab

实验性文档、深度分析和技术研究。这些文档不在英文主文档树中，是中文团队的内部参考资料。

---

## 目录

### 操作日志架构

| 文档                                                             | 内容                                                                                                     |
| ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| [操作日志架构深度分析](./operation-log-architecture-q-and-a.md)  | 基于 operation-log-architecture.md 的深度分析：写入路径、读取路径、压缩、Gap 检测、向量时钟等            |
| [服务器同步深度分析](./server-sync-deep-dive.md)                 | Part C 详细分析：服务器同步 vs 文件型同步、操作同步协议、冲突检测/解决、SYNC_IMPORT 过滤、归档处理、E2EE |
| [被拒绝的备选方案深度分析](./rejected-alternatives-deep-dive.md) | 全局 LWW、Delta Sync、全量快照、CRDT、CR-SQLite、BaaS 六种方案被拒绝的完整技术理由                       |

### 前端状态管理

| 文档                                                                                              | 内容                                                                   |
| ------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| [NgRx + IndexedDB vs MySQL + Redis](./frontend-state-management/ngrx-indexeddb-vs-mysql-redis.md) | 前端单用户架构 vs 后端多用户架构的系统性对比，含不一致窗口四层防护分析 |

### OneDrive PKCE 同步

| 文档                                                                                     | 内容                                                                |
| ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| [OneDrive 实现总结](./onedrive-pkce-sync/onedrive-implementation-summary.md)             | 整体架构、数据流、PKCE 认证、Token 管理、并发控制、已知限制         |
| [OAuth PKCE 认证深入](./onedrive-pkce-sync/oauth-pkce-auth-deep-dive.md)                 | code_verifier/challenge、state CSRF、token 刷新、凭证清除、平台差异 |
| [FileSyncProvider 集成指南](./onedrive-pkce-sync/filesync-provider-integration-guide.md) | 新增文件同步 Provider 的逐步实现清单                                |
| [PR Review 经验教训](./onedrive-pkce-sync/review-lessons-learned.md)                     | OneDrive PR review 中发现的 39 个问题及修复                         |

---

## 与主文档的关系

- **英文源文档**：[`docs/sync-and-op-log/operation-log-architecture.md`](../docs/sync-and-op-log/operation-log-architecture.md)
- **中文翻译**：[`docs-zh/sync-and-op-log/`](../sync-and-op-log/)
- **本目录**：深度分析、Q&A、实现细节等补充材料
