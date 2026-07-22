# boundaries/ —— 云端拆仓边界的机械执行机构

这里的清单文件是两族门禁的输入。门禁本体在 `test/acceptance/module-boundary.test.ts`（`AC-BOUND-01..06`）
与 `test/acceptance/table-ownership.test.ts`（`AC-OWN-01..05`），由既有的 `npm run test:acceptance`
与控制仓 `scripts/land-change` 在每次集成前执行。零新依赖、不依赖 CI。

规范位置在控制仓 `docs/cloud-service-decomposition-proposal.md`：
族名与族内编号见 §12「两族门禁」；文件归属判据见 §4.7；表属主判据见 §5.1；协议归属裁决见 §10.9。
**这些文件 MUST NOT 另立判据**——认为某条判错了，走控制仓 change 改定稿，再回写这里。

## 文件

| 文件 | 是什么 | 谁改 |
| --- | --- | --- |
| `ownership-rules.json` | §4.7 的机械转写：目录规则 + 逐文件例外 + `composition` 白名单 | 人工，改前先改 §4.7 |
| `module-ownership.json` | 上表展开出的**文件级**全量归属清单（生成物） | 生成器 |
| `table-ownership.json` | 表名 → 属主层的全量映射，逐条写明 §5.1 依据 | 人工 |
| `exception-tables.json` | §5.1 具名的设计内永久例外表；**不占豁免条目、不参与棘轮计数** | 人工，须控制仓 change 批准 |
| `dynamic-sql-resolutions.json` | 动态拼接 SQL 的逐处具名解析；未登记的动态 SQL 一律判失败 | 人工 |
| `kernel-non-members.json` | kernel 花名册 + 「被多边共导但 MUST NOT 进 kernel」的文件与原因 | 人工，改前先改 §4.7 |
| `import-exemptions.json` | 跨边界 import 的棘轮式豁免清单 | 只减不增（见下） |
| `table-write-exemptions.json` | 跨层表写入的棘轮式豁免清单 | 只减不增（见下） |

## 新增源文件之后（最常见的一件事）

```sh
npx tsx test/acceptance/helpers/boundary-record.ts ownership   # 重生成文件级归属表
npm run test:acceptance                                        # 两族门禁必须全绿
```

新文件由所在目录的规则接住。**若它不该跟着目录默认走**，先在 `ownership-rules.json` 的
`fileOverrides` 里加一行（`basis` 必须指到定稿的具体章节），再重跑生成器。
不重跑就提交 → `AC-BOUND-01` 当场失败并指名该文件。

新文件若引入了新的跨边界 import 或跨层写表，门禁会失败并把条目打印出来。**处置是修，不是追加豁免**：
定稿 §12 写死「seed 之后发现的既存违规 MUST 当场修复，MUST NOT 通过追加豁免条目放行」。

## 棘轮怎么工作

两份豁免清单的头部有四个数：

- `seedTotal` / `seedUnplanned`：seed 当天的条目数与「未挂消除 change」的条目数，**不可变**，是棘轮上界；
- `frozenTotal`：当前允许的上界，随削减一起下调；
- `raises[]`：**唯一**的上调通道，每个元素必须齐备 `amount` / `approvedByChange` / `eliminateBy` 三字段，
  缺任一即门禁失败（定稿 §12「例外通道（唯一）」）。

削减一条违规时，**必须在同一个提交里**删掉对应条目并把 `frozenTotal` 减掉相应数量；
只删代码不删条目 → `AC-BOUND-05` / `AC-OWN-04` 失败（不留空位给未来的新违规回填）。

`boundary-record.ts seed` 只用于本 change 的一次性 seed。此后 MUST NOT 再跑它重刷清单——
那等于把棘轮拆掉。（它会保留已写过的 `reason` / `eliminatedBy` / `note`，但仍会把 `frozenTotal` 重置。）

## 对账口径（与 change `cloud-schema-migration-executor` 统一）

```sh
npx tsx test/acceptance/helpers/boundary-record.ts census
```

2026-07-22 于 `aidcp-cloud@313eba2` 实测：

- 源文件 323，归属条目 323，未归属 0（层分布 api 91 / content 80 / automation 146 / kernel 4 / composition 2）；
- 需豁免的跨边界 import 257 条，无豁免通道的 0 条；
- 表全集 distinct 并集 84 张（`src` 自建 59 张 ∪ `migrations` 建 60 张）；
- `src` 内 `CREATE TABLE`：文本命中 77 处 / 去注释后生效 59 处 / 分布在 35 个源文件；
- 跨层写入 12 处（10 条豁免条目，DDL 侧 0 条）；
- SQL 写入点 231 处（含动态拼接登记解析出的条目）。

## 门禁看不见什么（MUST NOT 因全绿就判定无违规）

定稿 §12 门禁定义第 3 条点名两类天然失明的形态，MUST 靠人工盘点补位：

1. **写点全在属主一侧、但由另一边界的文件在调用路径上驱动**。SQL 字面量扫描只看写入语句写在哪个文件里，
   看不见「谁调用了它」，因此这类跨边界写入**门禁恒为绿**。今天已坐实两处（均为定稿 §12「阶段 1 退出判据」
   点名 MUST 有明确结论的五处之一）：
   - `client_environments`：写点全在 `src/client-auth/client-user-store.ts`（`api`），
     但由 `src/server.ts` 的 `registerEnvironments` 在自动化握手路径上调用；
   - **跨域保留清理**：`src/panel/retention-sweeper.ts`（`api`）调用三个属主侧 store 的 purge 方法删数据——
     `riskStore.purgeCountersOlderThan`（`src/risk/pg-risk-store.ts`，`automation`，表 `risk_counters`）、
     `interactionFeedStore.purgeOlderThan`（`src/cache/interaction-feed-store.ts`，`automation`，表 `interaction_feed`）、
     `tokenUsageStore.purgeOlderThan`（`src/metrics/token-usage-store.ts`，`content`，表 `llm_token_usage`）。
     `DELETE` 语句全在属主一侧，故 `AC-OWN-02` 不会红；定稿 §5.1 第 9 项要求阶段 1 拆成各服务自调本地 purge。
2. 文件系统信号与 PostgreSQL advisory lock 通道（§14 红线 24）。

> 定稿 §12「阶段 1 退出判据」点名的五处里，另三处（`interaction_runtime_controls` / `interaction_auth_state`
> 双写、`first_post_onboarding` 双写）是**真跨/同层 SQL 双写**、扫描器看得见：前两张已在
> `table-write-exemptions.json` 里逐条挂着消除方式；`first_post_onboarding` 按 §4.7 两侧同属 `api`，
> 是同层双写、不构成本门禁的违规（结论写在 `table-ownership.json` 该表的 `basis` 里）。
