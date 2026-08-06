# migrations/ — 云端数据库 schema 的唯一所有者

> change `cloud-schema-migration-executor`。执行器是 `scripts/migrate.ts`（`npm run migrate <status|up|verify|baseline>`）。
> 本目录之外的任何地方 MUST NOT 出现 `CREATE TABLE` / `ALTER TABLE` / `CREATE INDEX`。
> 过渡期由 `test/schema/runtime-ddl-allowlist.test.ts`（验收用例 `AC-SCHEMA-DDL-OWNER`）机械守着，清单只减不增。

## 1. 版本 id 与排序

- **版本 id = 文件名去 `.sql` 后缀**，例如 `0002_bot_chats`。它是账本 `schema_migrations` 的主键。
- **排序 = 复合序**：先比数字前缀的**数值**，前缀相同再比**完整文件名字典序**。MUST NOT 用纯字符串比较
  （`0009` 与 `0010` 字符串序恰好正确，但 `0002_bot_chats` 与 `0002_risk_control` 靠的就是第二级）。
- 序列**不要求稠密**：缺号不是错误，见下面的 `0012`。
- **这个顺序 MUST 在全新空库上真的跑得完**：任何一条迁移引用的表，都必须由排在它之前的迁移建出来。
  由 `test/schema/migration-order.test.ts` 机械守着（静态模拟，零数据库依赖）。

## 1.5 `0000` 基线建表：为什么它必须排在最前面

`0000_baseline_identity_and_corpus_tables.sql` 建的是 `accounts` / `client_users` / `client_environments` /
`concepts` / `anchors` / `curated_content` 那一批——它们**过去只由存储在启动期自建**，迁移目录从未创建过。

补写它们时如果按「排在已有最大号之后」的直觉给号，会得到一个自相矛盾的目录：
`0005` 给 `concepts` 加列、`0011`/`0021`/`0027`/`0036`/`0038`/`0039`/`0044`/`0056`/`0061` 给 `accounts` 加列、
`0040`/`0043` 动 `client_*`，全都排在建表之前。dev/ol 上看不出来（那些表早被存储建好了，走 `baseline` 记账、
根本不跑 `up`），但**全新空库上 `migrate up` 会在第 5 条就整批停住**，「迁移目录是完整事实源」这句话当场不成立。

两域合并进**一个** `0000` 文件、而不是两个，是因为复合序要求数字前缀唯一（§4），
而 `0001`–`0011` 之间没有空号可分配（`0012` 是登记在案的空洞，见 §3）。
`0067`（Facebook）与 `0068`（人设自动填充）不需要前置：没有任何历史迁移引用它们的表，
且 `0067` 对 `publish_log(0001)` 有外键，前置反而会坏。

## 2. 历史编号碰撞：冻结，不重排

四组文件共用同一个数字前缀。它们的相对顺序由复合序**确定且可复现**，已写进
`test/schema/migration-numbering.test.ts`，改文件名即测试失败。

| 前缀 | 先 | 后 | 是否互相依赖 |
| --- | --- | --- | --- |
| `0002` | `0002_bot_chats` | `0002_risk_control` | 否。前者只建 `bot_chats`，后者只建 `risk_state` / `risk_counters`，表集合不相交 |
| `0030` | `0030_content_schedule_group_comments` | `0030_panel_hardening_indexes` | 否。前者动 `account_content_schedule` 并建 `group_comment_attempts`；后者只在 `risk_counters` / `interaction_feed` / `llm_token_usage` 上建索引 |
| `0037` | `0037_facebook_comment_mode_templates` | `0037_session_join_group_budget` | 否。前者只动 `account_facebook_comment_config`，后者只动 `session_config_global` |
| `0038` | `0038_delegated_tasks` | `0038_first_post_onboarding` | 否。两者都只引用 `accounts`，互不引用对方的表 |

**MUST NOT 重命名任何历史迁移文件。** 重命名即改版本 id，会让账本主键与磁盘文件对不上，
并且要在两个已上线的库上同步改主键 —— 为一个纯表面问题引入一次真实的数据风险。

## 3. `0012` 是永不分配的历史空洞

`0012_*.sql` 从未存在过，也 **MUST NOT** 被新迁移占用。登记它是为了让后来者不必怀疑「是不是丢了一条」。
`test/schema/migration-numbering.test.ts` 断言该文件不存在。

## 4. 新增迁移的规矩

- **MUST NOT 复用已存在的数字前缀。** 四组历史碰撞是既成事实，不是可以效仿的先例。
- 文件头 **MUST** 有两段结构化声明（缺 `kind` 时执行器直接拒绝应用）：

  ```
  -- aidcp:kind=expand
  -- aidcp:objects=table:foo,column:foo.bar,index:idx_foo
  ```

- `-- aidcp:objects=` 可写多行，取并集。`verify` **只读这段声明**，MUST NOT 由 SQL 文本推断对象
  —— 推断不完整就是假阴性，而这里的假阴性等价于「验证通过」。
- 只声明 `table` / `column` / `index` 三类。**约束名不机械登记**：PG 对列级 `CHECK` / `UNIQUE`
  会自动生成名字，逐条登记只会制造噪声而不是事实。确需守住的具名约束由 SQL 合同测试
  （范式见 `test/interactions/migration-contract.test.ts`）承担。
- **收缩迁移删掉一个「更早迁移声明过」的对象时，MUST 用 `-- aidcp:retires=` 把它说出来**
  （语法与 `objects` 同形，多行取并集）：

  ```
  -- aidcp:kind=contract
  -- aidcp:retires=constraint:foo_target_check,index:idx_foo_target
  ```

  理由是这一条：对象声明是**全目录取并集**的，而旧文件的头改不得（校验和一经落账，
  改动即 `migration_checksum_mismatch` 整批拒绝）。那条旧声明因此永远留在磁盘上，
  `verify` 会把被删对象算成**缺失**——而缺失清单是 `baseline` 唯一的准入闸，
  新建属主库会被一条假缺失永久拒之门外，且按「缺失就补跑迁移」补多少次都不会变空。
  判定按复合序取最晚一次表态：同一对象被更晚的迁移重新声明，则重新计入期望集。
  `retires` 写错名字不会报错、只会白减一个，故仓内用例断言每条 `retires` 都命中过一条真实声明。
  带 `retires` 的文件属人判声明，`generate-migration-headers.ts --rewrite` 一律跳过它们。
- 历史 60 个文件的头声明由一次性工具 `scripts/generate-migration-headers.ts` 生成后签入。
  该工具按复合序模拟整条序列、维护「当前活着的对象」集合，被后续文件 `DROP` / `RENAME` 掉的对象
  不会留在任何头声明里（否则 `verify` 必然报一堆假缺失）。**它是一次性 bootstrap，不是运行时推断**。
  - 默认只补**缺头**的文件。`--rewrite` 连已有头一并重生成——**对象归属依赖复合序**，
    一旦有文件改名或插到序列前面，旧头就停在旧归属上。已有的 `kind` 是人工结论，重生成时保留、不一致时报出。
  - 重生成命令：`npx tsx scripts/generate-migration-headers.ts --rewrite --write`。
  - **它会改文件校验和**。账本一旦落账，改校验和就是 `migration_checksum_mismatch`（整批拒绝），
    所以 `--rewrite` MUST 只在这批迁移进真库账本**之前**用。

## 5. 只扩张不收缩（共库期硬约束）

dev 与 ol 今天**共用同一个数据库**。因此：

- **expand** = 新增表 / 新增列 / 新增索引 / 新增 `NOT VALID` 约束 / 数据回填 / 新增触发器 /
  放宽既有 `CHECK`（先 `DROP CONSTRAINT` 再 `ADD` 一个更宽的）。
  判定标准只有一条：**旧版本代码在这条迁移之后仍能正常读写**。
- **contract** = `DROP TABLE` / `DROP COLUMN` / `RENAME TO` / `RENAME COLUMN` /
  `ALTER COLUMN … TYPE`（类型收窄）/ `SET NOT NULL` / `DROP INDEX` / 约束 `VALIDATE` 之后的收紧。
  判定标准：**旧版本代码在这条迁移之后会坏**。

规矩：

- 共库期执行器**默认拒绝**应用 `kind=contract`，只在显式 `npm run migrate up --allow-contract` 时应用，
  并把授权者写进账本的 `applied_by`。
- **收缩 MUST 是独立 change、独立部署、可单独回滚，MUST NOT 与 expand 同批交付。**
- **重命名 MUST NOT 用 `ALTER … RENAME`。** MUST 改写为：新增目标列（expand）→ 双写 → 影子读对账 →
  切读 → 停旧写 → 一次独立的 contract 删旧列。六步模板见 `docs/table-ownership-migration.md`。
- 本纪律是 `aidcp/docs/deployment-environments.md`「冻结破坏性 / 不兼容 dev schema 迁移」在迁移期的**延伸**，
  不是新增护栏。
- `test/schema/expand-only.test.ts` 扫描全部 `kind=expand` 文件，命中禁用语句即失败并提示改标 contract。

**历史文件里已有 contract**（`0036` / `0041` / `0045` / `0046` / `0052` / `0069`）。它们早已在两个库上生效，
账本靠 `baseline` 记账、不会重跑。**在全新空库上按序拉起时需要 `--allow-contract`**，这是既成历史，不是新开的口子。

## 6. 账本与执行器

账本表 `schema_migrations` 由 `0064_schema_migrations_ledger.sql` 定义（执行器在读账本前会先原样执行该文件做 bootstrap）。

- `npm run migrate status` — 只读。列出已应用 / 待应用 / 异常 / 账本有磁盘无。
- `npm run migrate up [--allow-contract] [--by=<operator>]` — 整批 advisory lock 互斥（拿不到锁**立即退出**，
  不等待、不强行继续）；逐条单事务，事务内先执行 SQL 再写账本；任一条失败即停止整批、非 0 退出码，
  已成功的条目保留在账本里。
- `npm run migrate verify` — 实测对账：声明对象 vs 数据库目录里的实际对象，
  输出「缺失对象」与「多余对象」两张清单。表与列走 `pg_catalog`（`src/schema/pg-catalog.ts`，
  与运行时探测同一份查询），**不走 `information_schema`**：后者只显示当前角色有权限的对象，
  权限不全时会把「有表但没权限」刷成一串假缺失，而缺失清单是 `baseline` 唯一的准入闸。
- `npm run migrate baseline` — 先内部跑一次 `verify`；**缺失清单非空即拒绝写入**并逐条打印缺什么、来自哪个版本。
  清单为空才把全部迁移以 `baseline=true` 写入账本；对已有账本行幂等跳过、绝不覆盖。

三条不可协商的拒绝语义：

| 情形 | 行为 |
| --- | --- |
| 已入账本但磁盘内容变了 | `migration_checksum_mismatch` → 整批拒绝，一条 SQL 都不执行；MUST NOT 重跑，MUST NOT 用新校验和覆盖账本 |
| 版本序低于账本最大已应用版本却不在账本里 | `migration_out_of_order` → 整批拒绝；MUST NOT 补跑（允许补跑等于承认存在两条不同历史的库） |
| 缺 `-- aidcp:kind=` 头 | `migration_kind_missing` → 拒绝应用 |

`applied_from_target` 列**只作审计**：记「哪个目标的运维动作施加了这条迁移」。
它 MUST NOT 进主键 / 唯一约束、MUST NOT 参与任何查询谓词。
CLAUDE.md §2 的 `execution_target` 隔离规则约束的是**行级持久任务数据**；schema 是库的属性，
dev 与 ol 共用同一个数据库就只能有**一条**版本序列。照抄 target 隔离范式给账本分区，
会让同一张表被两套序列分别建，且两边都认为自己是对的。

## 7. 启动期契约门

`src/schema/schema-contract.ts` 声明 `REQUIRED_SCHEMA_VERSION` 与 `KNOWN_MAX_SCHEMA_VERSION`，
`src/schema/schema-gate.ts` 在**任何存储 `init()` 之前**读账本最高版本比对，三分支：

- 低于 `REQUIRED` → `schema_behind_code`，列出缺失版本，处置是补跑迁移；
- 高于 `KNOWN_MAX` → `schema_ahead_of_code`（典型是**回滚到旧代码**），列出超前版本；
- 其余 → 通过，日志打出账本最高版本 id。

`AIDCP_SCHEMA_GATE=warn|enforce`，默认 `warn`（判定照做、结论照打，暂不拒绝启动）。
`AIDCP_ALLOW_SCHEMA_AHEAD` **必须填具体版本 id**；布尔值、空串、通配值一律视为未放行，且不提供永久放行形态。

新增迁移后 **MUST** 把 `KNOWN_MAX_SCHEMA_VERSION` 抬到新的最大版本
（`test/schema/schema-contract.test.ts` 断言它与本目录一致，忘记抬即测试失败）。

新增一条**存储真正依赖**的迁移后，还 MUST 把 `REQUIRED_SCHEMA_VERSION` 一起抬；
否则契约门会放过一个「迁移没跑、存储又不再自建」的必然启动失败。当前值 `0070_baseline_self_heal_columns`
（第 5 节之后，全部存储的探测要求都靠 `0000` 与 `0067`–`0070` 这批补齐迁移满足）。

## 8. 存储不再自建表

33 个存储的 `init()` 已从「跑一遍幂等建表语句」改为「探测 + 三态判定」
（`src/schema/schema-capability.ts`，范式照抄 `src/interactions/schema-capability.ts`）：

- `ready`：要求的表 / 列 / 索引都在 → 正常工作；
- `degraded`：表在、缺列或缺索引 → 报 `schema_incomplete_<能力>_run_<版本 id>`，该能力 fail-closed；
- `missing`：表不在 → 报 `schema_missing_<能力>_run_<版本 id>`，该能力 fail-closed。**绝不建表**。

「要求」不是手写清单，而是由**存储自己那段 DDL 常量**解析出来的（`src/schema/ddl-objects.ts`）。
那段常量今天有三个身份：探测要求的来源、补齐迁移的抽取来源、过渡期旋钮打开时被执行的 DDL。
手写第二份列清单必然漂移，漂了之后用例会开始验一个不存在的形状。

**部署顺序因此变成硬约束**：先 `npm run migrate status`（只读）→ 有 pending 就人工审阅后 `migrate up` → 再重启服务。
带着未应用的迁移重启，表现为该能力在启动日志里 fail-closed 并报出缺失对象，不再是「悄悄把表建出来继续跑」。

过渡期回滚旋钮 `AIDCP_SCHEMA_SELF_CREATE=true` 恢复自建行为并在启动日志打显式过渡态警告，默认 `false`。
全部批次在 dev 稳定后随任务 5.11 删除该旋钮与存储侧 DDL 常量；那时
`test/schema/runtime-ddl-allowlist.json` 的条目才真正变少（今天常量还在，清单只是被冻住不许变多）。
