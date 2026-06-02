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

#### 常量文件

- `my-provider.const.ts` — 定义常量和默认配置

示例：

```typescript
import { ConfigFormSection } from '../../../config/global-config.model';

export const MY_PROVIDER_INITIAL_POLL_DELAY = 5000;
export const MY_PROVIDER_POLL_INTERVAL = 5 * 60 * 1000;

export const DEFAULT_MY_PROVIDER_CFG: MyProviderCfg = {
  isEnabled: false,
  // 其他默认值
};

export const MY_PROVIDER_CONFIG_FORM_SECTION: ConfigFormSection = {
  // 表单配置
};
```

#### 工具文件

- `is-my-provider-enabled.util.ts` — 检查提供程序是否启用的辅助函数

示例：

```typescript
import { MyProviderCfg } from './my-provider.model';

export const isMyProviderEnabled = (cfg: MyProviderCfg): boolean => {
  return cfg && cfg.isEnabled && // 其他条件;
};
```

### 3. 实现 IssueServiceInterface

必须实现的关键接口方法包括：

```typescript
// 必需
isEnabled(cfg: IssueIntegrationCfg): boolean;
testConnection$(cfg: IssueIntegrationCfg): Observable<boolean>;
pollTimer$: Observable<number>;
issueLink$(issueId: string | number, issueProviderId: string): Observable<string>;
getById$(id: string | number, issueProviderId: string): Observable<IssueData | null>;
getAddTaskData(issueData: IssueDataReduced): Partial<Task> & { title: string };
searchIssues$(searchTerm: string, issueProviderId: string): Observable<SearchResultItem[]>;
getFreshDataForIssueTask(task: Task): Promise<{ taskChanges: Partial<Task>; issue: IssueData; issueTitle: string; } | null>;
getFreshDataForIssueTasks(tasks: Task[]): Promise<{ task: Task; taskChanges: Partial<Task>; issue: IssueData; }[]>;

// 可选
getMappedAttachments?(issueData: IssueData): TaskAttachment[];
getNewIssuesToAddToBacklog?(issueProviderId: string, allExistingIssueIds: number[] | string[]): Promise<IssueDataReduced[]>;
```

### 4. 更新核心文件

你需要更新多个核心文件来注册你的新集成：

#### 4.1 更新 `issue.model.ts`

将你的提供程序添加到 `BuiltInIssueProviderKey` 类型：

```typescript
export type BuiltInIssueProviderKey =
  | 'JIRA'
  | 'GITLAB'
  | 'CALDAV'
  | 'ICAL'
  | 'OPEN_PROJECT'
  | 'GITEA'
  | 'TRELLO'
  | 'REDMINE'
  | 'LINEAR'
  | 'CLICKUP'
  | 'AZURE_DEVOPS'
  | 'NEXTCLOUD_DECK'
  | 'MY_PROVIDER'; // 在此添加你的提供程序
```

将你的提供程序配置添加到 `IssueIntegrationCfg`：

```typescript
export type IssueIntegrationCfg =
  | JiraCfg
  | GithubCfg
  | GitlabCfg
  | CaldavCfg
  | CalendarProviderCfg
  | OpenProjectCfg
  | GiteaCfg
  | RedmineCfg
  | MyProviderCfg; // 在此添加你的提供程序
```

更新 `IssueIntegrationCfgs` 接口：

```typescript
export interface IssueIntegrationCfgs {
  JIRA?: JiraCfg;
  GITHUB?: GithubCfg;
  GITLAB?: GitlabCfg;
  CALDAV?: CaldavCfg;
  CALENDAR?: CalendarProviderCfg;
  OPEN_PROJECT?: OpenProjectCfg;
  GITEA?: GiteaCfg;
  REDMINE?: RedmineCfg;
  MY_PROVIDER?: MyProviderCfg; // 在此添加你的提供程序
}
```

更新 `IssueProvider` 类型：

```typescript
export type IssueProvider =
  | IssueProviderJira
  | IssueProviderGithub
  | IssueProviderGitlab
  | IssueProviderCaldav
  | IssueProviderCalendar
  | IssueProviderOpenProject
  | IssueProviderGitea
  | IssueProviderRedmine
  | IssueProviderMyProvider; // 在此添加你的提供程序
```

#### 4.2 更新 `issue.const.ts`

添加你的提供程序类型常量：

```typescript
export const MY_PROVIDER_TYPE: IssueProviderKey = 'MY_PROVIDER';
```

将你的提供程序添加到 `ISSUE_PROVIDER_TYPES`：

```typescript
export const ISSUE_PROVIDER_TYPES: BuiltInIssueProviderKey[] = [
  GITLAB_TYPE,
  JIRA_TYPE,
  CALDAV_TYPE,
  ICAL_TYPE,
  OPEN_PROJECT_TYPE,
  GITEA_TYPE,
  TRELLO_TYPE,
  REDMINE_TYPE,
  LINEAR_TYPE,
  CLICKUP_TYPE,
  AZURE_DEVOPS_TYPE,
  NEXTCLOUD_DECK_TYPE,
  MY_PROVIDER_TYPE, // 在此添加你的提供程序
];
```

更新 `DEFAULT_ISSUE_PROVIDER_CFGS` 和 `ISSUE_PROVIDER_FORM_CFGS_MAP`：

```typescript
export const DEFAULT_ISSUE_PROVIDER_CFGS: IssueIntegrationCfgs = {
  JIRA: DEFAULT_JIRA_CFG,
  GITHUB: DEFAULT_GITHUB_CFG,
  // ...其他提供程序
  MY_PROVIDER: DEFAULT_MY_PROVIDER_CFG, // 在此添加你的提供程序
};

export const ISSUE_PROVIDER_FORM_CFGS_MAP: Record<IssueProviderKey, ConfigFormSection> = {
  JIRA: JIRA_CONFIG_FORM_SECTION,
  GITHUB: GITHUB_CONFIG_FORM_SECTION,
  // ...其他提供程序
  MY_PROVIDER: MY_PROVIDER_CONFIG_FORM_SECTION, // 在此添加你的提供程序
};
```

### 5. 创建 UI 组件（可选）

根据你的集成需要，可能需要创建 UI 组件：

- `my-provider/my-provider-issue-content/` 目录中的问题显示和内容组件
- `my-provider/my-provider-issue-header/` 目录中的标题组件
- 如需要，配置组件

### 6. 在 Issue Service 中注册提供程序

`IssueService` 使用提供程序工厂模式。确保你的提供程序服务被正确注入和注册。

## 测试你的集成

1. 使用 `npm run startFrontend` 运行应用
2. 导航到设置页面
3. 添加你的提供程序类型的新集成
4. 测试连接和功能

## 提示与最佳实践

1. **研究现有集成**：使用 GitHub 或 GitLab 集成作为参考实现
2. **错误处理**：为 API 失败实现健壮的错误处理
3. **轮询**：实现轮询时考虑速率限制
4. **认证**：安全地处理认证令牌
5. **用户体验**：让配置和使用尽可能简单

## 故障排除

- 检查浏览器控制台是否有错误
- 验证 `IssueServiceInterface` 的实现是否正确
- 确保所有模型类型正确定义
- 验证在所有必需文件中正确注册

## 回馈社区

集成完成后，请考虑将其作为 Pull Request 提交回 Super Productivity 项目！
