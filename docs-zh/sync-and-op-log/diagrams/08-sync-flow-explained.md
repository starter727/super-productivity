# 同步流程解释

**最后更新：** 2026 年 1 月  
**状态：** 已实现

本文用更直观的方式解释同步是如何工作的。

## 全景图

当你在一台设备上修改数据，这些变更需要传播到其他设备：

```
┌─────────────────────────────────────────────────────────────────────┐
│                        YOUR CHANGE                                   │
│                                                                      │
│   Phone                    Cloud                    Desktop          │
│   ┌─────┐                 ┌─────┐                  ┌─────┐          │
│   │ You │  ──UPLOAD──►    │     │   ──DOWNLOAD──►  │     │          │
│   │edit │                 │sync │                  │sees │          │
│   │task │                 │data │                  │edit │          │
│   └─────┘                 └─────┘                  └─────┘          │
│                                                                      │
└─────────────────────────────────────────────────────────────────────┘
```

## 逐步看：编辑任务时发生了什么

### 第 1 步：你做出修改

```
┌─────────────────────────────────────────────────────────────────────┐
│                                                                      │
│   You click "Mark task as done"                                      │
│                                                                      │
│   ┌──────────────────────────────────────┐                          │
│   │          Your Device                  │                          │
│   │                                       │                          │
│   │   Task: "Buy milk"                    │                          │
│   │   Status: Not Done  ──►  Done ✓       │                          │
│   │                                       │                          │
│   └──────────────────────────────────────┘                          │
│                                                                      │
└─────────────────────────────────────────────────────────────────────┘
```

### 第 2 步：创建一条 Operation

应用不会同步整个任务，而是同步“改了什么”：

```
┌─────────────────────────────────────────────────────────────────────┐
│                                                                      │
│   Operation Created:                                                 │
│   ┌──────────────────────────────────────┐                          │
│   │                                       │                          │
│   │   Type:     UPDATE                    │                          │
│   │   Entity:   TASK                      │                          │
│   │   ID:       task-abc-123              │                          │
│   │   Change:   isDone = true             │                          │
│   │   When:     2026-01-08 14:30:00       │                          │
│   │   Who:      your-device-id            │                          │
│   │                                       │                          │
│   └──────────────────────────────────────┘                          │
│                                                                      │
│   This gets saved locally in IndexedDB                              │
│                                                                      │
└─────────────────────────────────────────────────────────────────────┘
```

### 第 3 步：上传到云端

当同步触发（自动或手动）时：

```
┌─────────────────────────────────────────────────────────────────────┐
│                                                                      │
│   Your Device                              Cloud                     │
│   ┌────────────┐                          ┌────────────┐            │
│   │            │                          │            │            │
│   │ Operations │ ────── UPLOAD ────────►  │   Stored   │            │
│   │ to sync:   │                          │            │            │
│   │ • task ✓   │                          │ • task ✓   │            │
│   │            │                          │            │            │
│   └────────────┘                          └────────────┘            │
│                                                                      │
└─────────────────────────────────────────────────────────────────────┘
```

### 第 4 步：其他设备下载

其他设备会定期检查新操作：

```
┌─────────────────────────────────────────────────────────────────────┐
│                                                                      │
│   Cloud                                    Other Device              │
│   ┌────────────┐                          ┌────────────┐            │
│   │            │                          │            │            │
│   │   Stored   │ ────── DOWNLOAD ──────►  │  Applies   │            │
│   │            │                          │  changes   │            │
│   │ • task ✓   │                          │ • task ✓   │            │
│   │            │                          │            │            │
│   └────────────┘                          └────────────┘            │
│                                                                      │
│   Now both devices show the task as done!                           │
│                                                                      │
└─────────────────────────────────────────────────────────────────────┘
```

## 冲突场景怎么办？

当两台设备离线同时改同一条数据：

```
┌─────────────────────────────────────────────────────────────────────┐
│                                                                      │
│   Phone (offline)                    Desktop (offline)               │
│   ┌────────────────┐                ┌────────────────┐              │
│   │                │                │                │              │
│   │ Task: Buy milk │                │ Task: Buy milk │              │
│   │                │                │                │              │
│   │ You rename to: │                │ You mark as:   │              │
│   │ "Buy oat milk" │                │ "Done ✓"       │              │
│   │                │                │                │              │
│   │ Time: 2:30 PM  │                │ Time: 2:35 PM  │              │
│   │                │                │                │              │
│   └────────────────┘                └────────────────┘              │
│                                                                      │
│   Both go online... CONFLICT!                                        │
│                                                                      │
└─────────────────────────────────────────────────────────────────────┘
```

### 解决方式：Last Write Wins

后发生（时间戳更大）的变更胜出：

```
┌─────────────────────────────────────────────────────────────────────┐
│                                                                      │
│   Phone (2:30 PM)         vs          Desktop (2:35 PM)             │
│   "Buy oat milk"                      "Done ✓"                       │
│                                                                      │
│                         ⬇                                            │
│                                                                      │
│                   Desktop wins (later)                               │
│                                                                      │
│                         ⬇                                            │
│                                                                      │
│   Result on ALL devices:                                             │
│   ┌────────────────────────────────────┐                            │
│   │                                     │                            │
│   │   Task: "Buy milk" (name unchanged) │                            │
│   │   Status: Done ✓                    │                            │
│   │                                     │                            │
│   └────────────────────────────────────┘                            │
│                                                                      │
│   Note: Phone's rename was lost, but both devices are consistent    │
│                                                                      │
└─────────────────────────────────────────────────────────────────────┘
```

## SuperSync 与文件同步的区别

### SuperSync（服务端模式）

```
┌─────────────────────────────────────────────────────────────────────┐
│                                                                      │
│   Your Device              Server              Other Device          │
│   ┌────────┐              ┌────────┐           ┌────────┐           │
│   │        │              │        │           │        │           │
│   │ Upload │ ──op #5───►  │ Stores │ ◄──asks── │ "What's │          │
│   │ op #5  │              │ op #5  │   new?    │  new?"  │          │
│   │        │              │        │ ──op #5─► │        │           │
│   └────────┘              └────────┘           └────────┘           │
│                                                                      │
│   Server keeps ALL operations                                        │
│   Devices only download what they're missing                        │
│   Very efficient bandwidth                                           │
│                                                                      │
└─────────────────────────────────────────────────────────────────────┘
```

### 文件同步（Dropbox/WebDAV）

```
┌─────────────────────────────────────────────────────────────────────┐
│                                                                      │
│   Your Device              Cloud File          Other Device          │
│   ┌────────┐              ┌────────┐           ┌────────┐           │
│   │        │              │        │           │        │           │
│   │Download│ ◄──────────  │ sync-  │ ──────►   │Download│           │
│   │ whole  │              │ data.  │           │ whole  │           │
│   │ file   │              │ json   │           │ file   │           │
│   │        │ ──────────►  │        │ ◄──────   │        │           │
│   │Upload  │              │(state +│           │Upload  │           │
│   │ whole  │              │ ops)   │           │ whole  │           │
│   │ file   │              │        │           │ file   │           │
│   └────────┘              └────────┘           └────────┘           │
│                                                                      │
│   File contains EVERYTHING:                                          │
│   - Current state (all your data)                                    │
│   - Recent operations (last 200)                                     │
│   - Vector clock (for conflict detection)                           │
│                                                                      │
│   Less efficient, but works with any storage                        │
│                                                                      │
└─────────────────────────────────────────────────────────────────────┘
```

## 完整同步周期

```
┌─────────────────────────────────────────────────────────────────────┐
│                                                                      │
│   1. TRIGGER                                                         │
│      ├── Timer (every few minutes)                                   │
│      ├── App starts                                                  │
│      └── Manual sync button                                          │
│                                                                      │
│              ▼                                                       │
│                                                                      │
│   2. DOWNLOAD FIRST                                                  │
│      ├── Get operations from cloud                                   │
│      ├── Check for conflicts                                         │
│      ├── Apply changes to local state                               │
│      └── Update "last synced" marker                                │
│                                                                      │
│              ▼                                                       │
│                                                                      │
│   3. UPLOAD LOCAL CHANGES                                            │
│      ├── Gather pending operations                                   │
│      ├── Send to cloud                                               │
│      └── Mark as synced                                              │
│                                                                      │
│              ▼                                                       │
│                                                                      │
│   4. DONE                                                            │
│      └── All devices now have same data                             │
│                                                                      │
└─────────────────────────────────────────────────────────────────────┘
```

## 同步哪些内容？

| 会同步                  | 不会同步     |
| ----------------------- | ------------ |
| Tasks                   | 本地 UI 偏好 |
| Projects                | 窗口位置     |
| Tags                    | 缓存数据     |
| Notes                   | 临时状态     |
| Time tracking           |              |
| Repeat configs          |              |
| Issue provider settings |              |

## 术语速查

| 术语             | 含义                                     |
| ---------------- | ---------------------------------------- |
| **Operation**    | 一次变更记录（create / update / delete） |
| **Vector Clock** | 跟踪各设备变更因果关系                   |
| **LWW**          | Last Write Wins（时间戳晚者胜）          |
| **Piggybacking** | 你上传时顺带拿到别的设备的新变更         |
| **syncVersion**  | 文件每次更新都会递增的计数器             |

## 关键文件

| 文件                                                    | 作用         |
| ------------------------------------------------------- | ------------ |
| `src/app/op-log/sync/operation-log-sync.service.ts`     | 同步主编排   |
| `src/app/op-log/sync/operation-log-download.service.ts` | 下载操作     |
| `src/app/op-log/sync/operation-log-upload.service.ts`   | 上传操作     |
| `src/app/op-log/sync/conflict-resolution.service.ts`    | LWW 冲突解决 |
