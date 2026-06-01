# 基于位置的提醒 — 设计文档

> **状态：已计划（头脑风暴）**

## 概述

为 Super Productivity 增加基于位置的提醒功能。用户可以将已保存的位置附加到任务上，并在到达该地点时收到通知。这主要是一个移动端功能（通过 Capacitor 支持 Android/iOS），在桌面/Web 端被动显示位置信息。
## 决策

| 决策                  | 选择                                                | 理由                                                                                       |
| --------------------- | --------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| 主要平台              | 移动端（Android/iOS）                               | 地理围栏（geofencing）需要 GPS + 后台位置权限。桌面/Web 显示位置信息但不触发。             |
| 触发类型              | 仅到达（v1）                                        | 最简单的方案。离开触发可后续添加。                                                         |
| 位置管理              | 已保存位置实体（entity）                            | 用户会重复访问相同地点。遵循现有的标签（Tag）实体模式。                                    |
| 位置选择器（v1）      | "使用当前位置" + 标签                                | v1 无需地图。地图选择器是 v2 的增强功能。                                                   |
| 地理围栏方案          | 自定义原生 Capacitor 插件                           | `@capacitor/geolocation` 仅支持单次读取，不支持地理围栏。需要原生的 `GeofencingClient`（Android）/ `CLLocationManager`（iOS）。 |
| 同步                  | 默认同步                                            | 位置数据与其他实体同等对待。每台设备在同步后自行管理本地地理围栏。                         |
| 功能开关              | `AppFeaturesConfig` 中的 `isLocationRemindersEnabled` | 选择加入（opt-in），默认关闭。                                                              |

---

## 1. 数据模型

### 1.1 SavedLocation 实体

新文件：`src/app/features/saved-location/saved-location.model.ts`

```typescript
import { EntityState } from '@ngrx/entity';

export interface SavedLocationCopy {
  id: string;
  title: string; // "办公室"、"杂货店"、"健身房"
  lat: number; // 纬度
  lng: number; // 经度
  radius: number; // 地理围栏半径，单位米（默认 200）
  icon?: string | null; // Material 图标名称，如 'home'、'work'、'shopping_cart'
  created: number; // 创建时间戳
  modified?: number; // 最后更新时间戳
}

export type SavedLocation = Readonly<SavedLocationCopy>;
export type SavedLocationState = EntityState<SavedLocation>;
```

### 1.2 任务模型变更

文件：`src/app/features/tasks/task.model.ts` — 在 `TaskCopy` 中添加：

```typescript
/** SavedLocation 的 ID。设置后，该任务将激活地理围栏提醒。 */
locationReminderId?: string | null;
```

### 1.3 配置变更

文件：`src/app/features/config/global-config.model.ts` — 在 `AppFeaturesConfig` 中添加：

```typescript
isLocationRemindersEnabled: boolean; // 默认 false
```

文件：`src/app/features/config/default-global-config.const.ts` — 设置默认值：

```typescript
isLocationRemindersEnabled: false,
```

### 1.4 平台能力

文件：`src/app/core/platform/platform-capabilities.model.ts` — 添加：

```typescript
/** 平台是否支持原生地理围栏（后台位置监控）。 */
readonly geofencing: boolean;
```

| 平台                               | `geofencing` |
| ---------------------------------- | ------------ |
| Android（`ANDROID_CAPABILITIES`）   | `true`       |
| iOS（`IOS_CAPABILITIES`）           | `true`       |
| Electron（`ELECTRON_CAPABILITIES`） | `false`      |
| Web（`WEB_CAPABILITIES`）           | `false`      |

---

## 2. 同步与持久化注册

新实体所需的所有注册步骤，遵循现有模式：

### 2.1 实体类型

文件：`packages/shared-schema/src/entity-types.ts`

在 `ENTITY_TYPES` 数组中添加 `'SAVED_LOCATION'`。

### 2.2 动作类型枚举

文件：`src/app/op-log/core/action-types.enum.ts`

```typescript
// SavedLocation 动作
SAVED_LOCATION_ADD = '[SavedLocation] Add SavedLocation',
SAVED_LOCATION_UPDATE = '[SavedLocation] Update SavedLocation',
SAVED_LOCATION_DELETE = '[SavedLocation] Delete SavedLocation',
```

这些字符串值一旦部署就**不可变**——它们用于 IndexedDB 和同步的编码/解码操作。

### 2.3 实体注册

文件：`src/app/op-log/core/entity-registry.ts`

添加 `SAVED_LOCATION` 的实体配置。

### 2.4 模型配置

文件：`src/app/op-log/model/model-config.ts`

在 `AllModelConfig` 中添加，并添加到 `MODEL_CONFIGS` 数组。

---

## 3. 状态管理

### 3.1 根状态

文件：`src/app/root-store/root-state.ts`

```typescript
savedLocation: SavedLocationState;
```

### 3.2 功能存储注册

文件：`src/app/root-store/feature-stores.module.ts`

使用 `savedLocationReducer` 注册 `savedLocation` 存储。

### 3.3 级联删除

文件：`src/app/root-store/meta/task-shared-meta-reducers/saved-location-shared.reducer.ts`

新的共享元归约器（meta-reducer），处理：删除位置时，清除所有引用该位置的任务上的 `locationReminderId`。

在 `src/app/root-store/meta/meta-reducer-registry.ts` 中注册为第 5 阶段。

---

## 4. 配置 UI

### 4.1 设置页面

新文件：`src/app/features/saved-location/saved-location-settings/*`

包含：

- 已保存位置列表，附编辑/删除操作
- "添加位置"按钮（打开位置选择器对话框）
- 每行显示：标题、坐标、半径

### 4.2 位置选择器对话框

新文件：`src/app/features/saved-location/location-picker-dialog/*`

v1 界面：

- "使用当前位置"按钮
- 位置标签文本输入
- 半径滑块（50m–1000m，默认 200m）

---

## 5. 地理围栏注册

### 5.1 GeofenceService

新文件：`src/app/features/saved-location/geofence.service.ts`

职责：

- 维护活跃位置 → 任务映射
- 在 Capacitor 原生插件中注册/注销地理围栏
- 监听围栏进入事件 → 转发至提醒服务
- 在平台不支持时无操作

### 5.2 原生 Capacitor 插件

Android：`android/.../GeofencePlugin.kt`

- 使用 `GeofencingClient` 添加/移除圆形围栏
- `GeofenceBroadcastReceiver.kt` 处理围栏进入事件 → 将事件发送回 JS

iOS：`ios/App/App/GeofencePlugin.swift`

- 使用 `CLLocationManager` + `CLCircularRegion`
- AppDelegate 中的位置权限处理

### 5.3 生命周期

| 事件                                | 行为                                  |
| ----------------------------------- | ------------------------------------- |
| 任务附加位置                        | 注册地理围栏                          |
| 任务标记完成                        | 注销地理围栏                          |
| 任务取消附加位置                    | 注销地理围栏                          |
| 用户删除位置                        | 注销该位置的所有地理围栏              |
| 应用进入后台                        | 保持地理围栏活跃（原生）              |
| 应用进入前台                        | 同步地理围栏状态                      |

---

## 6. 提醒集成

### 6.1 提醒服务变更

文件：`src/app/features/reminder/reminder.service.ts`

添加：

```typescript
/** 位置提醒 Subject：当接收到地理围栏进入事件时触发。 */
public locationReminders$ = new Subject<{
  locationId: string;
  taskId: string;
}>();
```

### 6.2 提醒对话框集成

文件：`src/app/features/reminder/reminder.module.ts`

- 将位置提醒合并到现有的提醒对话框流程中
- 位置提醒显示："[位置名称] 附近有任务：[任务标题]"
- 与常规时间提醒共用相同的提醒关闭机制

---

## 7. 权限

### 7.1 Android

文件：`android/app/src/main/AndroidManifest.xml`

```xml
<uses-permission android:name="android.permission.ACCESS_FINE_LOCATION" />
<uses-permission android:name="android.permission.ACCESS_BACKGROUND_LOCATION" />
```

### 7.2 iOS

`Info.plist` 条目：

- `NSLocationWhenInUseUsageDescription`
- `NSLocationAlwaysAndWhenInUseUsageDescription`

---

## 8. 文件结构

```
src/app/features/saved-location/
├── saved-location.model.ts
├── saved-location.const.ts
├── saved-location.service.ts
├── geofence.service.ts
├── store/
│   ├── saved-location.actions.ts
│   ├── saved-location.reducer.ts
│   └── saved-location.selectors.ts
├── saved-location-settings/
│   ├── saved-location-settings.component.ts
│   ├── saved-location-settings.component.html
│   └── saved-location-settings.component.scss
└── location-picker-dialog/
    ├── location-picker-dialog.component.ts
    ├── location-picker-dialog.component.html
    └── location-picker-dialog.component.scss

android/.../
├── GeofencePlugin.kt              # 原生 Android 地理围栏
└── GeofenceBroadcastReceiver.kt   # 处理围栏进入事件

ios/App/App/
└── GeofencePlugin.swift           # 原生 iOS 地理围栏
```

---

## 9. 所有需改动的文件

### 新文件

| 文件                                                                                   | 用途                   |
| -------------------------------------------------------------------------------------- | ---------------------- |
| `src/app/features/saved-location/saved-location.model.ts`                              | 实体接口               |
| `src/app/features/saved-location/saved-location.const.ts`                              | 默认值                 |
| `src/app/features/saved-location/saved-location.service.ts`                            | 服务                   |
| `src/app/features/saved-location/geofence.service.ts`                                  | Capacitor 桥接层       |
| `src/app/features/saved-location/store/saved-location.actions.ts`                      | 动作                   |
| `src/app/features/saved-location/store/saved-location.reducer.ts`                      | 归约器 + 适配器        |
| `src/app/features/saved-location/store/saved-location.selectors.ts`                    | 选择器                 |
| `src/app/features/saved-location/saved-location-settings/*`                            | 设置 UI                |
| `src/app/features/saved-location/location-picker-dialog/*`                             | 选择器对话框           |
| `src/app/root-store/meta/task-shared-meta-reducers/saved-location-shared.reducer.ts`   | 级联删除               |
| `android/.../GeofencePlugin.kt`                                                        | Android 原生地理围栏   |
| `android/.../GeofenceBroadcastReceiver.kt`                                             | Android 围栏事件处理器 |
| `ios/App/App/GeofencePlugin.swift`                                                     | iOS 原生地理围栏       |

### 修改的文件

| 文件                                                       | 变更                                 |
| ---------------------------------------------------------- | ------------------------------------ |
| `packages/shared-schema/src/entity-types.ts`               | 添加 `'SAVED_LOCATION'`              |
| `src/app/op-log/core/action-types.enum.ts`                 | 添加 `SAVED_LOCATION_ADD/UPDATE/DELETE` |
| `src/app/op-log/core/entity-registry.ts`                   | 添加 `SAVED_LOCATION` 配置           |
| `src/app/op-log/model/model-config.ts`                     | 添加到 `AllModelConfig` + `MODEL_CONFIGS` |
| `src/app/root-store/root-state.ts`                         | 添加到 `RootState`                   |
| `src/app/root-store/feature-stores.module.ts`              | 注册功能存储                         |
| `src/app/root-store/meta/meta-reducer-registry.ts`         | 在第 5 阶段注册级联删除              |
| `src/app/features/tasks/task.model.ts`                     | 添加 `locationReminderId` 字段       |
| `src/app/features/config/global-config.model.ts`           | 添加 `isLocationRemindersEnabled`    |
| `src/app/features/config/default-global-config.const.ts`   | 设置默认值为 `false`                 |
| `src/app/core/platform/platform-capabilities.model.ts`     | 添加 `geofencing` 能力               |
| `src/app/features/reminder/reminder.service.ts`            | 添加 `locationReminders$` Subject    |
| `src/app/features/reminder/reminder.module.ts`             | 将位置提醒合并到对话框流程           |
| `android/app/src/main/AndroidManifest.xml`                 | 添加位置权限                         |
| `android/.../CapacitorMainActivity.kt`                     | 注册 `GeofencePlugin`                |

---

## 10. 未来增强（超出当前范围）

- 使用 OpenStreetMap 瓦片的地图选择器
- 地址搜索/地理编码（Nominatim）
- 离开触发（"提醒我离开办公室时"）
- 时间 + 位置组合（"在商店时，但仅限于下午 5 点后"）
- 项目默认位置
- 基于位置的任务视图（"显示我当前位置的任务"）
- 基于 WiFi 的触发（GPS 替代方案，适用于室内）
- 蓝牙信标触发

---

## 11. 验证计划

1. **单元测试：** SavedLocation 归约器、选择器、服务、级联删除元归约器
2. **手动移动端测试：**
   - 从"使用当前位置"创建位置
   - 分配给任务，验证地理围栏注册
   - 进出地理围栏区域，验证通知触发
   - 完成任务，验证地理围栏注销
   - 删除位置，验证任务上的 `locationReminderId` 被清除
3. **桌面/Web：** 验证任务上显示位置标签，不尝试地理围栏
4. **同步：** 在设备 A 上创建位置，验证其在设备 B 上出现
5. **代码规范/格式化：** `npm run lint`、`npm run prettier`、`npm test`
