# 设计：同步提供者插件

> **状态：已计划**

## 目标

让社区开发者能够以插件形式构建同步提供者（Google Drive、OneDrive、S3 等），利用现有插件系统的运行时加载和沙盒执行机制。

## 设计决策

- 插件在**与普通插件相同的沙盒**中运行（无提升权限）
- 插件处理**自身的认证 UI**（OAuth 流程、凭据表单）
- 凭据通过新的 **`persistDataLocal()` API** 存储（IndexedDB，永不同步）
- **应用管理加密**——插件仅传输不透明字节
- 内置提供者（Dropbox、WebDAV、LocalFile、SuperSync）**暂时保持内置**
- 插件同步提供者始终是**基于文件的**（由 `FileBasedSyncAdapterService` 包装）

## 架构

### 1. 新插件 API：`registerSyncProvider()`

添加到 `PluginAPI` 接口。插件在初始化时调用此方法：

```javascript
plugin.registerSyncProvider({
  id: 'google-drive',
  label: 'Google Drive',
  icon: 'cloud', // Material 图标名称或内联 SVG

  // 核心文件操作
  getFileRev: async (path, localRev) => {
    // 返回 { rev: string }，未找到时抛出异常
  },
  downloadFile: async (path) => {
    // 返回 { rev: string, dataStr: string }
  },
  uploadFile: async (path, dataStr, revToMatch, isForceOverwrite) => {
    // 返回 { rev: string }
  },
  removeFile: async (path) => {},

  // 状态
  isReady: async () => true, // 已配置且已认证时返回 true

  // 可选
  listFiles: async (path) => [], // 目录列表
  isUploadForcePossible: true, // 冲突时可强制覆盖
  maxConcurrentRequests: 4, // 并发上传/下载限制
});
```

每个插件只能注册一个同步提供者。再次调用 `registerSyncProvider()` 将替换之前注册的提供者。

### 2. 新插件 API：`persistDataLocal()` / `loadLocalData()`

通用本地存储，数据仅在本机保存。存储在 IndexedDB 中，永不参与同步。

```javascript
// 在本地存储凭据
await plugin.persistDataLocal(
  JSON.stringify({
    accessToken: '...',
    refreshToken: '...',
  }),
);

// 启动时加载
const data = await plugin.loadLocalData();
const creds = data ? JSON.parse(data) : null;
```

与 `persistDataSynced()` 具有相同的约束（1 MB 限制、速率限制），但数据保留在本地设备上。

### 3. PluginSyncProviderAdapter

位于 `src/app/plugins/` 下的新类，将插件回调包装为 `FileSyncProvider`：

```
src/app/plugins/plugin-sync-provider-adapter.ts
```

- 实现 `FileSyncProvider<SyncProviderId>`
- 通过 `PluginBridgeService` 将文件操作委托给插件回调
- `privateCfg` 使用无操作凭据存储（插件自行管理凭据）
- `isReady()` 委托给插件的 `isReady()` 回调

### 4. SyncProviderManager 变更

**文件**：`src/app/op-log/sync-providers/provider-manager.service.ts`

当前状态：在构造时填充静态的 `SYNC_PROVIDERS` 数组。

变更：

- 添加 `registerPluginProvider(adapter: PluginSyncProviderAdapter)` 方法
- 添加 `unregisterPluginProvider(providerId: string)` 方法
- `SYNC_PROVIDERS` 变为可变列表（或更优方案：维护独立的 `pluginProviders` 映射）
- `SyncProviderId` 枚举扩展为支持动态/字符串方式的插件 ID（例如 `plugin:google-drive`）
- `activeProviderId$` 及相关响应式对象会对插件提供者注册做出响应

### 5. 同步设置 UI 变更

**文件**：`src/app/features/config/form-cfgs/sync-form.const.ts`

当前状态：硬编码的提供者下拉选项。

变更：

- 提供者下拉菜单动态包含已注册的插件提供者
- 选择插件提供者后，不再显示硬编码表单字段，而是：
  - 显示"配置 [提供者名称]"按钮
  - 点击该按钮会触发插件的配置 UI（插件可使用 `plugin.openDialog()`、侧面板或 `plugin.showIndexHtmlAsView()`）
- 显示来自插件的 `isReady()` 结果的连接状态

### 6. 生命周期处理

**启动时已选择插件同步提供者：**

1. 应用启动，加载同步配置 → 选择的提供者为 `plugin:google-drive`
2. `SyncProviderManager` 看到未知提供者 ID → `isProviderReady$` 发出 `false`
3. 插件系统加载并激活 Google Drive 插件
4. 插件调用 `registerSyncProvider(...)` → 适配器向管理器注册
5. 管理器检测到匹配的提供者 → `isProviderReady$` 发出 `true`
6. 同步开始

**插件禁用/卸载：**

1. `PluginService` 调用清理 → `unregisterPluginProvider('plugin:google-drive')`
2. `SyncProviderManager` 移除该提供者 → `isProviderReady$` 发出 `false`
3. 同步停止
4. 设置 UI 显示警告："同步提供者 'Google Drive' 不可用——请启用该插件或选择其他提供者"

**加密：**

- 完全由应用通过 `FileBasedSyncAdapterService` 管理
- 加密密钥存储在应用级配置中（现有机制）
- 插件永远看不到解密后的数据，也从不处理密钥

## 需修改的文件

| 文件                                                          | 变更                                                                                 |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `packages/plugin-api/src/types.ts`                            | 在 API 类型中添加 `registerSyncProvider()` 和 `persistDataLocal()`/`loadLocalData()` |
| `src/app/plugins/plugin-api.ts`                               | 实现新的 API 方法                                                                    |
| `src/app/plugins/plugin-bridge.service.ts`                    | 为同步提供者注册和本地数据持久化添加桥接方法                                         |
| `src/app/plugins/plugin-cleanup.service.ts`                   | 在插件禁用/卸载时注销同步提供者                                                      |
| **新文件**：`src/app/plugins/plugin-sync-provider-adapter.ts` | 将插件回调包装为 `FileSyncProvider` 的适配器                                         |
| `src/app/op-log/sync-providers/provider-manager.service.ts`   | 添加 `registerPluginProvider()` / `unregisterPluginProvider()`，动态提供者列表       |
| `src/app/op-log/sync-providers/provider.const.ts`             | 支持动态插件提供者 ID 与枚举并存                                                     |
| `src/app/features/config/form-cfgs/sync-form.const.ts`        | 动态提供者下拉菜单，插件提供者的"配置"按钮                                           |
| `src/app/plugins/store/`                                      | 为本地插件数据持久化添加归约器/动作                                                   |
| `src/app/plugins/plugin-persistence.model.ts`                 | 添加 `PluginLocalData` 模型                                                          |

## 新文件

**`src/app/plugins/plugin-sync-provider-adapter.ts`**

轻量适配器，通过将操作委托给插件回调来实现 `FileSyncProvider`。约 50-80 行。

## 验证计划

1. **单元测试**：`PluginSyncProviderAdapter` 正确委托所有方法
2. **单元测试**：`SyncProviderManager` 处理动态注册/注销
3. **集成测试**：插件注册 → 出现在设置下拉菜单中 → 可被选中
4. **端到端测试**：构建一个将数据同步到本地模拟（mock）的测试同步提供者插件，验证完整同步周期正常工作
5. **边界情况测试**：启动时插件未加载、插件在活跃时被禁用、插件重新启用

## 示例插件

一个极简的 Google Drive 同步插件示例如下：

```javascript
// manifest.json
{
  "name": "Google Drive Sync",
  "id": "google-drive-sync",
  "version": "1.0.0",
  "manifestVersion": 1,
  "minSupVersion": "11.0.0",
  "description": "通过 Google Drive 同步",
  "hooks": [],
  "permissions": ["syncProvider", "localData"]
}

// plugin.js
const GDRIVE_API = 'https://www.googleapis.com/drive/v3';

let credentials = null;

async function init() {
  const data = await plugin.loadLocalData();
  credentials = data ? JSON.parse(data) : null;
}

plugin.registerSyncProvider({
  id: 'google-drive',
  label: 'Google Drive',
  icon: 'cloud',
  maxConcurrentRequests: 4,
  isUploadForcePossible: true,

  isReady: async () => {
    await init();
    return !!credentials?.accessToken;
  },

  downloadFile: async (path) => {
    // 使用 fetch() 调用 Google Drive API
    // 返回 { rev, dataStr }
  },

  uploadFile: async (path, dataStr, revToMatch, isForceOverwrite) => {
    // 上传到 Google Drive
    // 返回 { rev }
  },

  getFileRev: async (path, localRev) => {
    // 检查 Google Drive 上的文件元数据
    // 返回 { rev }
  },

  removeFile: async (path) => {
    // 从 Google Drive 删除文件
  },
});

// 通过菜单项提供认证 UI
plugin.registerMenuEntry({
  label: '配置 Google Drive 同步',
  icon: 'settings',
  onClick: async () => {
    // 显示认证对话框，存储凭据
    await plugin.persistDataLocal(JSON.stringify(credentials));
  },
});
```
