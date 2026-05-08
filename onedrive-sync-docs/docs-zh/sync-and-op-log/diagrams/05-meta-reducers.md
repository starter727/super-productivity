# 原子状态一致性（Meta-Reducer 模式）

**最后更新：** 2026 年 1 月  
**状态：** 已实现

本文展示 meta-reducer 如何在多实体变更中保证原子状态一致性，避免同步过程中的中间态不一致。

## 多实体操作的 Meta-Reducer 流程

```mermaid
flowchart TD
    subgraph UserAction["User Action (e.g., Delete Tag)"]
        Action[deleteTag action]
    end

    subgraph MetaReducers["Meta-Reducer Chain (Atomic)"]
        Capture["stateCaptureMetaReducer<br/>━━━━━━━━━━━━━━━<br/>Captures before-state"]
        TagMeta["tagSharedMetaReducer<br/>━━━━━━━━━━━━━━━<br/>• Remove tag from tasks<br/>• Delete orphaned tasks<br/>• Clean TaskRepeatCfgs<br/>• Clean TimeTracking"]
        OtherMeta["Other meta-reducers<br/>━━━━━━━━━━━━━━━<br/>Pass through"]
    end

    subgraph FeatureReducers["Feature Reducers"]
        TagReducer["tag.reducer<br/>━━━━━━━━━━━━━━━<br/>Delete tag entity"]
    end

    subgraph Effects["Effects Layer"]
        OpEffect["OperationLogEffects<br/>━━━━━━━━━━━━━━━<br/>• Compute state diff<br/>• Create single Operation<br/>• with entityChanges[]"]
    end

    subgraph Result["Single Atomic Operation"]
        Op["Operation {<br/>  opType: 'DEL',<br/>  entityType: 'TAG',<br/>  entityChanges: [<br/>    {TAG, delete},<br/>    {TASK, update}x3,<br/>    {TASK_REPEAT_CFG, delete}<br/>  ]<br/>}"]
    end

    Action --> Capture
    Capture --> TagMeta
    TagMeta --> OtherMeta
    OtherMeta --> FeatureReducers
    FeatureReducers --> OpEffect
    OpEffect --> Result

    style UserAction fill:#fff,stroke:#333,stroke-width:2px
    style MetaReducers fill:#e8f5e9,stroke:#2e7d32,stroke-width:2px
    style FeatureReducers fill:#e3f2fd,stroke:#1565c0,stroke-width:2px
    style Effects fill:#fff3e0,stroke:#ef6c00,stroke-width:2px
    style Result fill:#f3e5f5,stroke:#7b1fa2,stroke-width:2px
```

## 为什么用 Meta-Reducer 而不是 Effects

```mermaid
flowchart LR
    subgraph Problem["❌ Effects Pattern (Non-Atomic)"]
        direction TB
        A1[deleteTag action] --> E1[tag.reducer]
        E1 --> A2[effect: removeTagFromTasks]
        A2 --> E2[task.reducer]
        E2 --> A3[effect: cleanTaskRepeatCfgs]
        A3 --> E3[taskRepeatCfg.reducer]

        Note1["Each action = separate operation<br/>Sync may deliver partially<br/>→ Inconsistent state"]
    end

    subgraph Solution["✅ Meta-Reducer Pattern (Atomic)"]
        direction TB
        B1[deleteTag action] --> M1[tagSharedMetaReducer]
        M1 --> M2["All changes in one pass:<br/>• tasks updated<br/>• repeatCfgs cleaned<br/>• tag deleted"]
        M2 --> R1[Single reduced state]

        Note2["One action = one operation<br/>All changes sync together<br/>→ Consistent state"]
    end

    style Problem fill:#ffebee,stroke:#c62828,stroke-width:2px
    style Solution fill:#e8f5e9,stroke:#2e7d32,stroke-width:2px
```

## 状态变更检测

`StateChangeCaptureService` 通过比较前后状态计算实体变更：

```mermaid
flowchart TD
    subgraph Before["Before State (captured by meta-reducer)"]
        B1["tasks: {t1, t2, t3}"]
        B2["tags: {tag1, tag2}"]
        B3["taskRepeatCfgs: {cfg1}"]
    end

    subgraph After["After State (post-reducer)"]
        A1["tasks: {t1', t2', t3}"]
        A2["tags: {tag2}"]
        A3["taskRepeatCfgs: {}"]
    end

    subgraph Diff["State Diff Computation"]
        D1["Compare entity collections"]
        D2["Identify: created, updated, deleted"]
    end

    subgraph Changes["Entity Changes"]
        C1["TAG tag1: DELETED"]
        C2["TASK t1: UPDATED (tagId removed)"]
        C3["TASK t2: UPDATED (tagId removed)"]
        C4["TASK_REPEAT_CFG cfg1: DELETED"]
    end

    Before --> Diff
    After --> Diff
    Diff --> Changes

    style Before fill:#fff3e0,stroke:#ef6c00,stroke-width:2px
    style After fill:#e8f5e9,stroke:#2e7d32,stroke-width:2px
    style Diff fill:#e3f2fd,stroke:#1565c0,stroke-width:2px
    style Changes fill:#f3e5f5,stroke:#7b1fa2,stroke-width:2px
```

## 使用 Meta-Reducer 的多实体操作

| Action              | 影响实体                                                 | Meta-Reducer               |
| ------------------- | -------------------------------------------------------- | -------------------------- |
| `deleteTag`         | Tag, Tasks（移除 tagId）, TaskRepeatCfgs, TimeTracking   | `tagSharedMetaReducer`     |
| `deleteTags`        | Tags, Tasks, TaskRepeatCfgs, TimeTracking                | `tagSharedMetaReducer`     |
| `deleteProject`     | Project, Tasks（级联删除）, TaskRepeatCfgs, TimeTracking | `projectSharedMetaReducer` |
| `convertToMainTask` | Parent task, Child task, Sub-tasks                       | `taskSharedMetaReducer`    |
| `moveTaskUp/Down`   | 多个任务（重排）                                         | `taskSharedMetaReducer`    |

## 带 Entity Changes 的 Operation 结构

```mermaid
classDiagram
    class Operation {
        +string id
        +string clientId
        +OpType opType
        +EntityType entityType
        +string entityId
        +VectorClock vectorClock
        +number timestamp
        +EntityChange[] entityChanges
    }

    class EntityChange {
        +EntityType entityType
        +string entityId
        +ChangeType changeType
        +unknown beforeState
        +unknown afterState
    }

    class ChangeType {
        <<enumeration>>
        CREATED
        UPDATED
        DELETED
    }

    Operation --> EntityChange : contains 0..*
    EntityChange --> ChangeType : has
```

## 同步回放：全有或全无

远端操作应用时，所有 entity changes 会被原子回放：

```mermaid
sequenceDiagram
    participant Remote as Remote Op
    participant Applier as OperationApplierService
    participant Store as NgRx Store
    participant State as Final State

    Remote->>Applier: Operation with entityChanges[]

    loop For each entityChange
        Applier->>Applier: Convert to action
        Applier->>Store: dispatch(action)
    end

    Note over Store: All changes applied<br/>in single reducer pass

    Store->>State: Consistent state

    Note over State: Either ALL changes applied<br/>or NONE (transaction semantics)
```

## LWW Update Meta-Reducer：实体类型处理

`lwwUpdateMetaReducer` 用于处理 LWW 胜出后创建的 Update action。它区分三类实体存储模式：

```mermaid
flowchart TD
    subgraph Input["LWW Update Action"]
        Action["[TASK] LWW Update<br/>entityType + entityId + winningData"]
    end

    subgraph Lookup["Entity Registry Lookup"]
        Registry["Look up entity storage pattern<br/>in entity registry"]
    end

    subgraph Patterns["Storage Pattern Handling"]
        Adapter["ADAPTER ENTITIES<br/>━━━━━━━━━━━━━━━<br/>TASK, PROJECT, TAG, NOTE,<br/>TASK_REPEAT_CFG, ISSUE_PROVIDER,<br/>SIMPLE_COUNTER, BOARD, METRIC,<br/>REMINDER, PLUGIN_USER_DATA,<br/>PLUGIN_METADATA<br/>━━━━━━━━━━━━━━━<br/>adapter.updateOne() or addOne()<br/>+ relationship syncing"]

        Singleton["SINGLETON ENTITIES<br/>━━━━━━━━━━━━━━━<br/>GLOBAL_CONFIG,<br/>TIME_TRACKING,<br/>MENU_TREE,<br/>WORK_CONTEXT<br/>━━━━━━━━━━━━━━━<br/>Entire feature state replaced<br/>with winning data"]

        Unsupported["UNSUPPORTED<br/>━━━━━━━━━━━━━━━<br/>Map, array, virtual<br/>━━━━━━━━━━━━━━━<br/>Warning logged,<br/>no action taken"]
    end

    Input --> Lookup
    Lookup --> Patterns

    style Adapter fill:#e8f5e9,stroke:#2e7d32,stroke-width:2px
    style Singleton fill:#e3f2fd,stroke:#1565c0,stroke-width:2px
    style Unsupported fill:#fff3e0,stroke:#ef6c00,stroke-width:2px
```

### Adapter 实体细节

对于 adapter-backed 实体，meta-reducer 处理两种情况：

| 条件                  | 行为                                      | 原因                                                 |
| --------------------- | ----------------------------------------- | ---------------------------------------------------- |
| 实体在 store 中存在   | `adapter.updateOne()`：用胜出数据替换实体 | 常规冲突解决                                         |
| 实体在 store 中不存在 | `adapter.addOne()`：重建实体              | 处理 DELETE vs UPDATE 竞态（本地删了但远端更新胜出） |

### Task 关系同步

LWW 更新 task 后，meta-reducer 会同步相关引用：

| 变更字段    | 同步关系                                                   |
| ----------- | ---------------------------------------------------------- |
| `projectId` | 更新 `project.taskIds`（新旧项目成员关系）                 |
| `tagIds`    | 对新增/移除标签同步 `tag.taskIds`                          |
| `dueDay`    | 更新 `TODAY_TAG.taskIds`（虚拟标签，成员由 `dueDay` 决定） |
| `parentId`  | 更新新旧父任务的 `parent.subTaskIds`                       |

**关键文件：** `src/app/root-store/meta/task-shared-meta-reducers/lww-update.meta-reducer.ts`

## 关键文件

| 文件                                                                           | 作用                                          |
| ------------------------------------------------------------------------------ | --------------------------------------------- |
| `src/app/root-store/meta/task-shared-meta-reducers/`                           | 任务相关多实体变更                            |
| `src/app/root-store/meta/task-shared-meta-reducers/tag-shared.reducer.ts`      | 标签删除与关联清理                            |
| `src/app/root-store/meta/task-shared-meta-reducers/project-shared.reducer.ts`  | 项目删除与关联清理                            |
| `src/app/root-store/meta/task-shared-meta-reducers/lww-update.meta-reducer.ts` | LWW Update 处理（adapter/singleton/关系同步） |
