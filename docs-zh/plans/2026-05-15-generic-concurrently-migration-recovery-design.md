# 通用 CONCURRENTLY 迁移恢复——设计

日期：2026-05-15
状态：已验证，可实施

## 问题

一次生产部署在应用 `20260514000000_add_encrypted_ops_partial_index` 时失败：

```
Database error code: 25001
ERROR: DROP INDEX CONCURRENTLY cannot run inside a transaction block
ERROR: prisma migrate deploy failed (exit 1).
```

Prisma 5.22 将每次迁移包装在事务中；PostgreSQL 禁止在事务块内使用 `CREATE/DROP INDEX CONCURRENTLY`（P3018 / SQLSTATE 25001）。代码库已知此问题并有带外恢复路径——但它未能启用。

### 根本原因

恢复逻辑在两个地方**重复且名称硬编码**：

- 宿主 `scripts/deploy.sh`——约 310 行的 `is_*_transaction_block_failure` / `apply_*_outside_prisma` / `resolve_*` 函数梯子，硬编码了三个迁移名称。
- 镜像内 `scripts/migrate-deploy.sh`——具有相同三个硬编码名称的第二份副本。

`deploy.sh` 在**宿主上**运行，仅通过尽力的 `git pull --ff-only || echo "WARNING: ...continuing with current files"` 自我更新。生产宿主的 `deploy.sh` 早于 PR #7621，因此它只知道 `20260512000000`。它拉取了新镜像（确实包含新的 CONCURRENTLY 迁移），运行了 `prisma migrate deploy`，在 `20260514000000` 上遇到了 P3018，没有匹配其任何硬编码的恢复分支，然后退出了。

真正的缺陷是**宿主/镜像版本偏差加上名称硬编码**：每个新的 CONCURRENTLY 迁移都需要同步编辑宿主侧恢复逻辑，而过时的宿主脚本会静默降级。

## 目标

1. 消除宿主/镜像偏差：恢复逻辑**在镜像内部**发布，与同一构建中的 `prisma/migrations/` 版本锁定。
2. 名称无关：任何地方没有硬编码的迁移名称。新的 CONCURRENTLY 迁移无需更改部署工具。
3. 严格的安全门控：永不强制标记一个真正损坏的迁移为已应用。
4. 去重：一个恢复实现，三个调用点。

## 架构

`scripts/migrate-deploy.sh` 成为单一真相源（重用现有的文件名——已通过 `Dockerfile` `COPY` 到镜像中，已经是启动 `CMD` 目标；Dockerfile 不变）。

| 调用者 | 之前 | 之后 |
| --- | --- | --- |
| 宿主 `deploy.sh` | `npx prisma migrate deploy` + 约 310 行硬编码的宿主侧恢复 | `timeout "$MIGRATION_TIMEOUT" $MIGRATOR_RUN sh -ec "sh scripts/migrate-deploy.sh"` + 仅退出码处理 |
| 镜像启动（`RUN_MIGRATIONS_ON_STARTUP=true`） | 自己的硬编码副本 | 新的通用脚本（连接不变） |
| 手动操作 | 手动执行 deploy.sh 操作 | `docker compose run --rm supersync sh scripts/migrate-deploy.sh` |

因为 `scripts/` 和 `prisma/migrations/` 在同一 `Dockerfile` 构建中被复制到镜像中，恢复逻辑永远不会相对于它必须处理的迁移而过时。过时的宿主 `deploy.sh` 只需要知道如何**调用**镜像内脚本；恢复**内容**始终来自刚拉取的镜像。

已删除：从 `MIGRATE_LOG=""`（约第 176 行）到 if 梯子（约第 486 行）的整个 `deploy.sh` 块，以及旧的 `migrate-deploy.sh` 中的所有硬编码逻辑。净效果：约 440 行硬编码代码删除，约 120 行通用代码添加。

## 恢复算法（在 `migrate-deploy.sh` 中）

有界循环（最多 8 次尝试——在一次部署中覆盖多个连续的 CONCURRENTLY 迁移）：

```
attempt = 0
loop:
  log = $(npx prisma migrate deploy 2>&1); status = $?
  echo "$log"
  status == 0 -> exit 0
  attempt++ ; attempt > MAX -> fail loudly, exit status

  name = parse_failing_migration(log)
  name empty -> fail loudly + manual cmds, exit status

  is_txn_block = log has "P3018" AND "cannot run inside a transaction block"
  is_stuck     = log has "P3009"                       # prior failed migration
  not (is_txn_block OR is_stuck) -> fail loudly, exit status

  sql = prisma/migrations/<name>/migration.sql
  sql missing OR not grep -qi "INDEX[[:space:]]\+CONCURRENTLY" sql
      -> fail loudly, exit status                      # CONCURRENTLY guard

  name == last_recovered_name -> abort (re-failed), exit 1   # no infinite loop

  recover(name); last_recovered_name = name
  continue
```

`parse_failing_migration` 按优先级顺序匹配 Prisma 自己的输出：`Migration name: <name>`（P3018 块），否则为反引号名称在 `Applying migration \`<name>\`` 中，否则为 P3009 句子中的反引号名称（`The \`<name>\` migration started at ... failed`）。所有三个字符串都逐字出现在观察到的生产日志中。

`recover(name)`：

1. `npx prisma migrate resolve --rolled-back <name>`——容忍非零退出码并给出警告（"not in a failed state; continuing"），匹配今天的行为。
2. 将 `migration.sql` 拆分为语句；通过 `printf "%s\n" "$stmt" | npx prisma db execute --schema prisma/schema.prisma --stdin` 执行**每条**语句。
3. 如果**任何**语句失败：停止，**不**执行 `resolve --applied`，打印确切剩余的 manual 命令，以非零退出。
4. 仅当**每条**语句都成功时：`npx prisma migrate resolve --applied <name>`。

因此 `--applied` 从不是"强制"——它仅在迁移自身的 SQL 可验证地运行后才被断言。真正的错误、非 CONCURRENTLY 迁移和意外错误都会落到带有 manual 的显式失败中。

## 语句分割器

`prisma db execute --file` 会为多语句文件重新触发隐式事务错误（PostgreSQL 将多语句简单查询视为一个事务），因此语句被分割并通过每个 `--stdin` 调用执行一条。一个 `awk` 流程：

- 删除整行注释（`^[[:space:]]*--`）
- 累积行，当一行以 `;` 结尾时发出语句
- 修剪空白；跳过空语句

### 约束（在脚本头部和迁移文档中记录）

带外恢复仅支持 CONCURRENTLY **索引**迁移。语句不得在字符串字面量内嵌入 `;`；注释必须是整行 `--`。所有四个现有的 CONCURRENTLY 迁移满足此要求。可以接受，因为 CONCURRENTLY 守卫已将爆炸半径限制为索引迁移。

### 编写规则（记录的要求）

CONCURRENTLY 迁移必须编写为：

```sql
DROP INDEX CONCURRENTLY IF EXISTS "x";
CREATE INDEX CONCURRENTLY "x" ON ...;
```

首先 `DROP ... IF EXISTS` 使重新运行幂等，并清除中断的并发构建留下的无效索引。这将已经隐式的模式（在现有迁移的自身注释中说明）提升为明确规则。

## 宿主 `deploy.sh`（未更改的关注点）

保留：Caddy 验证、`git pull`、镜像拉取/构建、Postgres compose-up、`DATABASE_URL` 宿主导写、数据库连接检查、`timeout` 包装器（挂起的并发构建仍然以退出码 124 大声失败）、`RUN_MIGRATIONS_ON_STARTUP=false` 用于 compose 更新、容器启动、健康检查。仅迁移块缩减为对镜像内脚本的单个定时调用。

## 失败/逃避通道

在任何退出时（真正错误、守卫遗漏、语句失败、重新失败），脚本打印精确的手动序列——`migrate resolve --rolled-back <name>`、来自该迁移 SQL 的每语句 `db execute` 行、`migrate resolve --applied <name>`——因此操作员始终有可复制粘贴的恢复方案。

## 测试

1. **快速，无需数据库**——`parse_failing_migration` 和 SQL 分割器的 shell 夹具测试，针对：样本 Prisma P3018 日志、样本 P3009 日志和四个真实的 `migration.sql` 文件。锁定两个繁琐的文本例程。
2. **集成（docker Postgres）**——使用现有的 SuperSync compose 框架：
   - 正向测试：一个合成的 CONCURRENTLY 索引迁移→脚本从事务内失败中恢复，`_prisma_migrations` 行标记为 `applied`，索引存在。
   - 卡住状态：预种子一个失败的（`P3009`）CONCURRENTLY 行（真实事件形态）→脚本恢复。
   - 逆向测试：一个故意损坏的**非 CONCURRENTLY** 迁移→脚本**不**将其标记为已应用并以非零退出。

## 范围外

- 更改 Prisma 的事务行为或升级 Prisma。
- 推广到索引 CONCURRENTLY 迁移之外（守卫有意收窄）。
- 宿主 `deploy.sh` 自我更新机制（尽力 `git pull` 保留；此设计使其过时与迁移正确性无关）。
