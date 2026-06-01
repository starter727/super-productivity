# 环境配置设置

本项目对环境配置采用混合方法：

- **基础配置**（生产/预发布标志）在静态 TypeScript 文件中
- **密钥和动态值**从 `.env` 文件中加载并转换为 TypeScript 常量

## 概述

### 静态环境文件

- `src/environments/environment.ts` — 开发配置
- `src/environments/environment.prod.ts` — 生产配置
- `src/environments/environment.stage.ts` — 预发布配置

这些文件包含基础配置，如 `production`、`stage` 和 `version` 标志。

### 动态环境变量

- `.env` — 所有环境的环境变量
- `src/app/config/env.generated.ts` — 自动生成的 TypeScript 常量（已加入 gitignore）

`.env` 文件包含不应提交到版本控制中的密钥和环境特定值。

## 设置说明

1. **创建你的 .env 文件**

   ```bash
   cp .env.example .env
   ```

2. **添加你的环境变量**

   ```bash
   # .env
   GOOGLE_DRIVE_TOKEN=your-token-here
   DROPBOX_API_KEY=your-api-key-here
   ```

3. **在代码中访问环境变量**

   ```typescript
   // 从生成的常量导入（类型安全!）
   import { ENV } from './app/config/env.generated';

   // 直接访问
   const googleToken = ENV.GOOGLE_DRIVE_TOKEN;

   // 或使用工具函数（具有类型安全性）
   import { getEnv, getEnvOrDefault } from './app/util/env';

   const googleToken = getEnv('GOOGLE_DRIVE_TOKEN');
   const dropboxKey = getEnvOrDefault('DROPBOX_API_KEY', 'default-key');
   ```

## 运行应用

npm 脚本在运行前会自动从 `.env` 生成 TypeScript 常量：

```bash
# 开发
npm run startFrontend

# 生产配置
npm run startFrontend:prod

# 预发布配置
npm run startFrontend:stage
```

注意：所有命令使用同一个 `.env` 文件。环境之间的区别由 Angular 配置（production/stage 标志）控制。

## 构建命令

构建命令也会在构建前生成常量：

```bash
# 生产构建
npm run buildFrontend:prod:es6

# 预发布构建
npm run buildFrontend:stage:es6
```

## 工作原理

1. **load-env.js** 读取 `.env` 文件并生成 `src/app/config/env.generated.ts`
2. **TypeScript 常量** 被导入并在整个应用中使���（无需 process.env!）
3. **类型安全** — 工具函数使用 `keyof typeof ENV` 实现自动补全和类型检查
4. **Git 忽略** — 生成的文件从不提交，确保密钥安全

## 安全说明

- 切勿将 `.env` 文件提交到版本控制
- 生成的 `env.generated.ts` 自动被 gitignore 忽略
- 密钥在构建时编译到打包文件中（不作为环境变量暴露）
- 只在 `.env.example` 中添加非敏感值

## 添加新的环境变量

1. 添加到 `.env`：

   ```bash
   NEW_API_KEY=your-api-key-here
   ```

2. 当你运行任何构建/服务命令时，TypeScript 类型会自动生成

3. 在代码中使用，具有完整的类型安全：

   ```typescript
   import { ENV } from './app/config/env.generated';
   const apiKey = ENV.NEW_API_KEY;

   // 或使用工具函数
   import { getEnv } from './app/util/env';
   const apiKey = getEnv('NEW_API_KEY'); // TypeScript 知道所有可用的键!
   ```

## 这种方法的优势

- 鉁?**类型安全**：具有自动补全的完整 TypeScript 支持
- 鉁?**无运行时依赖**：常量编译到打包文件中
- 鉁?**随处可用**：无需 process.env 或特殊 webpack 配置
- 鉁?**简单**：只需导入并使用常量
- 鉁?**安全**：密钥保留在 `.env` 中，永远不会进入版本控制
