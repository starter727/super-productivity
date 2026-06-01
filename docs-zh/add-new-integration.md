# 向 Super Productivity 添加新的集成

本指南说明如何向 Super Productivity 添加新的问题跟踪器集成。

## 概述

Super Productivity 支持多个问题跟踪器集成（在代码库中称为"Issue Provider"），包括 Jira、GitLab、Gitea、Redmine、Open Project、CalDAV、Calendar（iCal）、Trello、ClickUp、Linear、Azure DevOps 和 Nextcloud Deck。GitHub 已迁移为基于插件的提供程序。添加新的集成需要实现特定的接口（interface）和服务，以与外部服务通信。

## 集成架构

每个集成遵循一致的模式：

1. **接口**：所有集成实现 `IssueServiceInterface`，该接口定义了与外部��务通信所需的方法。
2. **提供程序特定模型**：每个集成定义自己的数据结构。
3. **API 服务**：每个集成有一个 API 服务来处理 HTTP 请求。
4. **公共接口服务**：每个集成有一个实现 `IssueServiceInterface` 的服务。
5. **配置**：每个集成定义其配置选项。

## 逐步指南

### 1. 创建提供程序目录结构

在 `src/app/features/issue/providers/` 下为你的集成创建一个新目录，例如 `my-provider/`。

### 2. 创建必需文件

基于现有集成，你需要创建：

#### 模型文件

- `my-provider.model.ts` — 定义提供程序的配置和数据结构
- `my-provider-issue.model.ts` — 定义问题特定的数据结构

GitHub 示例：

```typescript
// github.model.ts
import { BaseIssueProviderCfg } from '../../issue.model';

export interface GithubCfg extends BaseIssueProviderCfg {
  repo: string;
  token?: string;
}
```

#### 服务文件

- `my-provider-api.service.ts` — 处理 API 通信
- `my-provider-common-interfaces.service.ts` — 实现 `IssueServiceInterface`

API 服务结构示例：

```typescript
@Injectable({
  providedIn: 'root',
})
export class MyProviderApiService {
  // HTTP 通信方法
  getById$(issueId: string, cfg: MyProviderCfg): Observable<MyProviderIssue> {
    // 实现
  }

  searchIssues$(searchTerm: string, cfg: MyProviderCfg): Observable<MyProviderIssue[]> {
    // 实现
  }
}
```

公共接口服务结构示例：

```typescript
@Injectable({
  providedIn: 'root',
})
export class MyProviderCommonInterfacesService implements IssueServiceInterface {
  // 实现 IssueServiceInterface 的所有必需方法

  isEnabled(cfg: MyProviderCfg): boolean {
    // 实现
  }

  // 其他必需方法...
}
```

（完整英文原文中的代码块保持不变）
