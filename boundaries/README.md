# boundaries/ —— 云端拆仓边界的机械执行机构

这里的清单文件是两族门禁的输入。门禁本体在 `test/acceptance/module-boundary.test.ts`（`AC-BOUND-01..06`）
与 `test/acceptance/table-ownership.test.ts`（`AC-OWN-01..05`），由既有的 `npm run test:acceptance`
与控制仓 `scripts/land-change` 在每次集成前执行。零新依赖、不依赖 CI。
锁归属另成一族（`AC-LOCK-*`），输入也放在本目录：见下表的 `row-lock-exemptions.json`。

规范位置在控制仓 `docs/cloud-service-decomposition-proposal.md`：
族名与族内编号见 §12「两族门禁」；文件归属判据见 §4.7；表属主判据见 §5.1；协议归属裁决见 §10.9。
**这些文件 MUST NOT 另立判据**——认为某条判错了，走控制仓 change 改定稿，再回写这里。

## 文件

| 文件 | 是什么 | 谁改 |
| --- | --- | --- |
| `ownership-rules.json` | §4.7 的机械转写：目录规则 + 逐文件例外 + `composition` 白名单 + seed 窗口开关 | 人工，改前先改 §4.7 |
| `adjudicated-files.json` | seed 当天已存在于「逐文件切分目录」里的文件名册 ＝**「已裁决」的唯一依据** | 人工，**只减不增** |
| `module-ownership.json` | 上表展开出的**文件级**全量归属清单（**纯生成物，不作准入依据**） | 生成器 |
| `table-ownership.json` | 表名 → 属主层的全量映射，逐条写明 §5.1 依据 | 人工 |
| `exception-tables.json` | §5.1 具名的设计内永久例外表；**不占豁免条目、不参与棘轮计数** | 人工，须控制仓 change 批准 |
| `dynamic-sql-resolutions.json` | 动态拼接 SQL 的逐处具名解析；未登记的动态 SQL 一律判失败 | 人工 |
| `kernel-non-members.json` | kernel 花名册 + 「被多边共导但 MUST NOT 进 kernel」的文件与原因 | 人工，改前先改 §4.7 |
| `import-exemptions.json` | 跨边界 import 的棘轮式豁免清单 | 只减不增（见下） |
| `table-write-exemptions.json` | 跨层表写入的棘轮式豁免清单 | 只减不增（见下） |
| `row-lock-exemptions.json` | **行锁**（`FOR UPDATE` / `FOR SHARE`）跨属主的棘轮式豁免清单 + 「借调调用方连接」的加锁点花名册 | 只减不增；**不由 `boundaries:refresh` 维护，纯人工** |

## 唯一的重跑入口

```sh
npm run boundaries:refresh    # 事实侧全量重算并写回清单（默认棘轮：只减不增）
npm run boundaries:census     # 只打印对账口径，一个文件都不写
npm run test:acceptance       # 两族门禁必须全绿
```

**什么时候必须跑 `boundaries:refresh`：**

| 触发 | 为什么 |
| --- | --- |
| 主干合进了新的 change（新增 / 删除源文件、新增表、新增或消除跨边界依赖） | 清单是对**当天源码**的快照，不重算就与事实脱节 |
| 本分支 rebase 到新的 `master` 之后 | 同上，且门禁会当场红 |
| 消除了一条跨边界依赖 / 跨层写入 | 它负责删条目并同步下调 `frozenTotal`（漏删 → `AC-BOUND-05` / `AC-OWN-04` 红） |
| change `cloud-schema-migration-executor` 落地后 | 它会新增 `src/schema/**` 若干文件、并把运行时 DDL 从各 store 里删干净，两族事实同时大幅变化 |

**它自动做什么、坚决不做什么**（这条分界线是本目录的核心设计）：

- **自动重算的是事实**：当前有哪些源文件、哪些跨边界 import、哪些表写入点、表全集是哪些。
- **绝不自动生成的是人判**：某个新文件属于哪一层、某张新表的属主是谁。判据在定稿 §4.7 / §5.1，脚本无权代判。
  遇到下面三种情形一律**报错并列出待裁决清单**，MUST NOT 塞一个默认值放过：
  1. 新增源文件落在 §4.7「逐文件切分」的目录里（`ownership-rules.json` 的目录规则标 `newFile: "adjudicate"`），
     或压根没有目录规则覆盖它 → 先在 `fileOverrides` 里逐个裁定，`basis` 必须指到定稿的具体章节；
  2. 新增表没有属主登记，或登记表里有已经不再被建的孤儿表 → 先按 §5.1 裁定 / 清理 `table-ownership.json`；
  3. 出现豁免清单里没有的新违规 → 默认判失败（见下「棘轮怎么工作」）。

> `newFile` 的取值只有两种：`inherit`（§4.7 里该目录整行只有一个归属层，如 `src/risk/` 19/19 automation，
> 新文件的归属**已经被 §4.7 判过了**）与 `adjudicate`（§4.7 把该目录逐文件切开，如 `src/publish-agent/`
> 7 api / 54 content / 6 automation，§4.7 **没有**判过「这个目录下任意新文件属于哪一层」）。
> 字段缺省按 `adjudicate` 处理。三条机械回归在 `module-boundary.test.ts` 的「归属生成器保真自检」。

> **「已裁决」的依据是 `adjudicated-files.json`，不是生成物。** 逐文件切分目录里的**既有**文件靠这份
> 人工名册继续走目录默认值。2026-07-23 审计坐实过一条洗白路径：早期版本把生成物
> `module-ownership.json` 自己回喂当「已裁决集」，于是判据退化成「是否已经在生成物里」——
> 手工往生成物加一条「新文件 + 目录默认层」就能让 `AC-BOUND-01` 全绿，`refresh` 随后把它永久写实。
> 现在名册是独立人工文件，**MUST NOT 增长**：此后这类目录的新文件一律进 `fileOverrides`
> 并写明 §4.7 判据；源文件删除时由 `refresh` 同步剔除（只减不增）。

新文件若引入了新的跨边界 import 或跨层写表，`refresh` 会失败并把条目逐条打印出来。
**处置的第一顺位是查归属是否填错**（多数「新违规」其实是新文件的层没按 §4.7 判对），
第二顺位是修掉这条依赖；定稿 §12 写死「seed 之后发现的既存违规 MUST 当场修复，MUST NOT 通过追加豁免条目放行」。

## 棘轮怎么工作

两份豁免清单的头部有四个数加一段说明：

- `seedTotal` / `seedUnplanned`：seed 当天的条目数与「未挂消除 change」的条目数，**不可变**，是棘轮上界；
- `frozenTotal`：当前允许的上界，随削减一起下调；
- `raises[]`：**唯一**的上调通道，每个元素必须齐备 `amount` / `approvedByChange` / `eliminateBy` 三字段，
  缺任一即门禁失败（定稿 §12「例外通道（唯一）」）；
- `seedBasis`：seed 基线**为什么是这个数**的唯一在仓记录（`--seed-note=` 写入）。两族门禁各有一条断言
  要求它非空——早期版本的 `refresh` 在默认（最常跑的）路径上重建清单对象时漏搬了这个字段，
  会把它静默删掉，typecheck 与全部用例都抓不到。

**一条条目 = 一个违规。** import 侧的违规单位是一条 `(from, to)` 边；表侧是一个
`{表, 文件, 操作}` 三元组——**不是** `(表, 文件)` 对。表侧早期把同一对上的多个操作压成 `ops[]` 数组，
棘轮的键因此少了「操作」这一维：已豁免的对上新增一个 `ALTER TABLE` / `CREATE TABLE` 时条目数不变，
`refresh` 会自己把数组拓宽写回文件并**退出 0**，`AC-OWN-03`「无未豁免的跨层 DDL」随后恒绿
（2026-07-23 审计坐实，机械回归见 `table-ownership.test.ts` 的「棘轮键保真自检」）。
门禁匹配用的键与棘轮用的键**必须是同一个键**。

削减一条违规时 `npm run boundaries:refresh` 会替你删条目并同步下调 `frozenTotal`，
**必须在同一个提交里**一起提交；只删代码不删条目 → `AC-BOUND-05` / `AC-OWN-04` 失败
（不留空位给未来的新违规回填）。

出现清单里没有的新违规时，`refresh` 默认**直接失败**。放行只有两条显式通道：

```sh
# ① 定稿 §12「例外通道（唯一）」：具名上调，三字段齐备才算数。可重复。
npm run boundaries:refresh -- --raise=<控制仓 change 名>:<数量>:<YYYY-MM-DD>

# ② 只在 seed 窗口内合法：门禁 change cloud-service-boundary-gates 尚未归档、棘轮尚未开始计数。
npm run boundaries:refresh -- --reseed --seed-note="为什么要重新 seed" --i-am-reseeding-the-ratchet
```

`--reseed` 会按当天实测重置 `seedTotal` / `seedUnplanned` / `frozenTotal`。它是**把整个棘轮拆掉**的开关，
所以四道机械门缺一不可，任一不满足即 `exit 1`（不再只靠这段文字约束）：

1. `ownership-rules.json` 的 `seedWindow.open` MUST 为 `true`。**归档 `cloud-service-boundary-gates` 时把它改成 `false`**
   —— 此后 `--reseed` 一律拒绝；
2. MUST 给 `--seed-note=<为什么>`，它会写进 `seedBasis`；
3. 清单已经 seed 过（`seedTotal > 0` 或已有 `seedBasis`）时，MUST 再加 `--i-am-reseeding-the-ratchet`；
4. `raises[]` 非空时**直接拒绝**——那里面是已批准上调及其消除时限的唯一记录，MUST 先人工处置再重新 seed。

两种模式都保留人工写过的 `reason` / `eliminatedBy` / `note`，也都原样带走 `seedBasis`，
不会把已登记的消除计划刷掉——所以新增条目的理由与消除动作**必须人工补写一次**，之后一直跟着走。

## 对账口径（与 change `cloud-schema-migration-executor` 统一）

```sh
npm run boundaries:census
```

2026-07-23 实测（门禁分支 rebase 到 `origin/master` 之后，即主干已含
`risk-state-cross-process-integrity` / `config-mirror-cross-process-invalidation` /
`publish-approval-signal-to-database` 三个 change）：

- 源文件 338，归属条目 338，未归属 0（层分布 api 101 / content 80 / automation 151 / kernel 4 / composition 2）；
- 需豁免的跨边界 import 274 条，无豁免通道的 0 条；一端是 `content` 的 112 条（阶段 3 准入取值，本轮未变）；
- 表全集 distinct 并集 89 张（`src` 自建 64 张 ∪ `migrations` 建 65 张）；
- `src` 内 `CREATE TABLE`：文本命中 83 处 / 去注释后生效 64 处 / 分布在 37 个源文件；
- 跨层写入 12 处（豁免条目 **12 条**，DDL 侧 0 条）——三个 change 新增的 5 张表属主与写入方同层，本轮不产生新违规。
  条目数从 10 变 12 是 2026-07-23 的**粒度**修正（`ops[]` 数组拆成逐个三元组），豁免的实际面一条未变；
- SQL 写入点 245 处（含动态拼接登记解析出的条目）。

上一次口径（`aidcp-cloud@313eba2`，主干合入那三个 change **之前**）：源文件 323 / import 257 条 /
表 84 张 / 写入点 231 处 / 跨层写入 12 处。差额来源逐项写在 `import-exemptions.json` 新增 17 条的
`reason` 字段里。

## 门禁看不见什么（MUST NOT 因全绿就判定无违规）

定稿 §12 门禁定义第 3 条点名两类天然失明的形态，MUST 靠人工盘点补位：

1. **写点全在属主一侧、但由另一边界的文件在调用路径上驱动**。SQL 字面量扫描只看写入语句写在哪个文件里，
   看不见「谁调用了它」，因此这类跨边界写入**门禁恒为绿**。今天已坐实两处（均为定稿 §12「阶段 1 退出判据」
   点名 MUST 有明确结论的五处之一）：
   - `client_environments`：写点全在 `src/client-auth/client-user-store.ts`（`api`），
     但由 `src/server.ts` 的 `registerEnvironments` 在自动化握手路径上调用；
   - **跨域保留清理（已消除，change `retention-local-purge` / 2026-07-23）**：原先 `src/panel/retention-sweeper.ts`（`api`）
     在保留清理路径上跨域调用三个属主侧 store 的 purge 方法删数据，是本条第一类失明形态的实例。
     定稿 §5.1 第 9 项要求「阶段 1 拆成各服务自调本地 purge」，本 change 已落实：sweeper 已删除，
     三张表的日频 purge 改由各属主 store 在自己 `init()` 里的定时器**自驱**（`risk_counters` → `src/risk/pg-risk-store.ts`、
     `interaction_feed` → `src/cache/interaction-feed-store.ts`、`llm_token_usage` → `src/metrics/token-usage-store.ts`），
     阈值 / 周期 / 删的数据逐位不变。驱动方与写点自此同属一层，跨边界形态不再存在（保留此条仅作退出判据的追溯记录）。
   - **配置镜像版本递增（已消除，change `block3-l3-config-mirror-bump-decouple` / 2026-07-25）**：
     原先 §5.1 判归 `automation` 的四类限频配置 store（`src/config/{quota,pacing,session,resume}-config-store.ts`）
     在自己的写事务里调 `MirrorVersionStore.bumpInTx` 递增 `config_mirror_version`（属主 `api`）。
     `UPDATE` / `INSERT` 语句全在 `src/config/mirror-version-store.ts`（`api`）一侧，`AC-OWN-02` 恒绿——
     这是本条第一类失明形态里**危害最大的一种**：不只是「跨边界写」，还是**跨库事务**，
     物理拆库当天会静默丢失原子性（配置已落库、版本没进，无错误、无日志）。
     现已改成：automation 库内「配置写 + `event_outbox` 行」同事务 → 生产方进程内中继 →
     api 库内「`config_mirror_bump_inbox` 去重 + 推版本」同事务。四条 `automation -> api` import 边
     随之消除（`import-exemptions.json` 条目 100 → 96）。
     **失明本身也补上了机械闸**：`MirrorVersionStore.bumpInTx` 现在断言 `CONFIG_MIRRORS[key].owner === 'api'`，
     非 api 属主的 mirrorKey 走这条路径当场抛错——门禁的 SQL 扫描看不见方法调用，但这条运行时断言看得见，
     再有人把某个 automation 属主的配置接回同事务 bump，第一次写入就会失败而不是一路绿灯合进主干。
     对称地 `applyRelayedBumpInTx` 只接受非 api 属主的 key，堵住反向错接线；两条断言由
     `test/config/mirror-invalidation.test.ts` 按 `CONFIG_MIRRORS` 穷举验证（新增镜像自动纳入）。
2. 文件系统信号与 PostgreSQL advisory lock 通道（§14 红线 24）。
   - **锁通道自 2026-07-25 起不再全盲**：advisory lock 的归属由 `test/acceptance/advisory-lock-ownership.test.ts`
     的 `AC-LOCK-01/02` 扫，**行锁**（`FOR UPDATE` / `FOR SHARE`）由 `test/acceptance/row-lock-ownership.test.ts`
     的 `AC-LOCK-03/04/05` 扫，清单在 `row-lock-exemptions.json`。补这一刀的理由与 advisory lock 同源：
     两侧连到不同库时，两边各自加锁都会成功、互斥消失、且不产生任何错误——失效方向是**无声的**。
   - **行锁族仍然看不见的**：一条行锁究竟跑在**谁的事务**里。文件自己不建池、不 `connect()` 时，
     锁跑在调用方传进来的句柄上，而调用方常由组合根按结构类型注入（连 import 边都没有）。
     `AC-LOCK-04` 的处置不是猜，而是**要求这类文件被逐个登记**：新出现一个未登记的借调式加锁点即失败，
     由人写清它跑在谁的事务里。今天登记 2 个（`src/db/environment-row-lock.ts`、
     `src/interactions/offboard-write-adapter.ts`），两个都确实跨边界，理由与去向写在清单条目里。

> 定稿 §12「阶段 1 退出判据」点名的五处里，另三处（`interaction_runtime_controls` / `interaction_auth_state`
> 双写、`first_post_onboarding` 双写）是**真跨/同层 SQL 双写**、扫描器看得见：前两张已在
> `table-write-exemptions.json` 里逐条挂着消除方式；`first_post_onboarding` 按 §4.7 两侧同属 `api`，
> 是同层双写、不构成本门禁的违规（结论写在 `table-ownership.json` 该表的 `basis` 里）。
