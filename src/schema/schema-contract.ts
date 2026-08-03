/**
 * 启动期 schema 契约（change cloud-schema-migration-executor 任务 6.1/6.2/6.4，design.md D5）。
 *
 * 本文件是纯判定层：不连库、不读文件系统，只把「账本里有哪些版本」翻译成三分支结论。
 * 判定结论与 warn / enforce 模式无关 —— 两种模式 MUST 输出完全一致的结论与版本清单，
 * 模式只决定「拒绝启动」还是「继续启动」。
 *
 * 这一层要堵的是回滚场景的静默假成功：库比代码新时，旧代码的存储会在启动期
 * 「发现表不在 → 建一张空表 → 开始往里写」，全程零告警。契约门把它变成一次显式的启动失败。
 */

import { compareVersions } from './migration-plan.js';

/**
 * 本构建正常工作所需的最低迁移版本 id。
 *
 * 第 5 节把 33 个存储的自建表全部改成了探测，于是本构建的硬依赖不再只是「账本存在」，
 * 而是「补齐迁移全部到位」——最后一条补齐迁移是 `0070_baseline_self_heal_columns`。
 * 不抬到这里，契约门会放过一个「迁移没跑但存储也不再自建」的必然启动失败。
 *
 * 注：`0069`（两条 `SET NOT NULL`，kind=contract）不是任何存储正常读写的前置，
 * 但它在复合序上低于 `0070`，被本要求顺带覆盖；这只是序的结果，不是对收缩的依赖。
 *
 * 今后每加一条存储真正依赖的迁移，本常量 MUST 一起抬。
 *
 * 注：change block3-l3-config-mirror-bump-decouple 把四类限频配置的镜像失效信号接到
 * `event_outbox`（0074）+ `config_mirror_bump_inbox`（0076）这条通道上。这两条自此是**真依赖**：
 * 缺表 ⇒ 四类限频配置改完后另一个进程的镜像不再更新。故 REQUIRED 一并抬到 0076。
 * 抬 REQUIRED 只影响启动期契约门的结论（默认 warn 模式仍继续启动），不改任何运行时行为。
 *
 * 副作用（有意，登记于此）：REQUIRED 抬到 0076 之后，序上低于它的 `0075_event_outbox_topic_cursor`
 * 也被顺带纳入「缺了就算 behind」——那条迁移本身仍不是硬依赖（只被非 monolith 模式的消费者用），
 * 只是复合序的结果。部署时两条一起跑即可，warn 模式下缺任一条也只是响亮提示、不拒绝启动。
 */
export const REQUIRED_SCHEMA_VERSION = '0109_content_schedule_hour_claim_env_key_optional';

/**
 * 本构建认识的最高迁移版本 id，等于本构建 `migrations/` 目录里的最大版本。
 * 由 test/schema/schema-contract.test.ts 断言与目录一致（构建产物里不一定带 migrations/，故不在运行时读目录）。
 *
 * 注：`0071`/`0072` 补声明的是共库上「库有、迁移没声明」的存活孤儿表/列（change cloud-schema-migration-executor
 * 任务 3.1/3.2 的收尾）；它们不是任何存储正常读写的前置，故只抬 KNOWN_MAX、不抬 REQUIRED。
 *
 * 注：`0073_publish_execution_state`（change publish-log-split-prep）建的是 publish_log 执行态影子表。
 * 它是**影子**，写者对它软探测 + fail-safe 双写（探不到即停用双写，绝不连累主路径），故只抬 KNOWN_MAX、不抬 REQUIRED
 * ——把它写进 REQUIRED 会让「迁移还没跑」变成硬启动失败，与影子表的可选性质相悖。
 *
 * 注：`0074_event_outbox`（change block2-outbox-transport）建的是拆进程用的事件 outbox 两张表。
 * 该 change 只建原语；**change block3-l3-config-mirror-bump-decouple 已把四类限频配置的镜像失效
 * 信号接上去**，它自此承重，与 `0076_config_mirror_bump_inbox`（同通道的消费侧去重表）一并进 REQUIRED。
 *
 * 注：`0075_event_outbox_topic_cursor`（change outbox-listen-and-topic-cursor）建的是按主题分维的
 * 消费游标表。它只被 outbox 消费者用到，而消费者**只在非 monolith 模式**（content/core/api/automation
 * 分段进程）才起——今天生产跑的 monolith 一条都不起，故仍只抬 KNOWN_MAX、不抬 REQUIRED。
 * 迁移没跑而又起了分段进程时不会静默：读游标的查询会直接报 `relation ... does not exist`，
 * 由消费轮询每轮 warn 出来（绝不退化成「查不到 = 没有事件」）。
 *
 * 注：`0077_automation_account_projection`（change automation-accounts-projection）建的是 automation 域
 * 对 api 属主账号主数据的守卫投影两张表。它**是**若干守卫的前置（投影探不到 ⇒ 那批守卫一律拒绝），
 * 但这正是设计要的 fail-closed 形态：能力级 fail-closed 比进程级硬启动失败更精准——迁移没跑时只有
 * 加群 / 委托任务认领停摆并响亮报错，其余功能照常。故仍只抬 KNOWN_MAX、不抬 REQUIRED。
 *
 * 注：`0078_client_env_cleanup_admission`（change block3-l3-offboard-eventual-consistency）给 api 属主的
 * `client_env_revocation_holds` 加三列 + 放宽两处约束，把「环境正在清理」这条**准入事实**收进 api 自己的库。
 * 本构建的 client-user-store **确实依赖这三列**（准入的条件写、`materialized_at` 决定改派闸的原因码、
 * `getOffboard` 的「已受理、尚未物化」中间态都读它们），但它与 client_identity 能力探测同门：
 * 迁移没跑 ⇒ 启动期该能力带 version id fail-closed 报错，比抬 REQUIRED 把整进程拒起更精准。
 * 故只抬 KNOWN_MAX、不抬 REQUIRED，与 0073 / 0074 同口径。
 *
 * 注：`0079_risk_command_outcome`（change cloud-coupling-phase5 P5-1）建 automation 属主的风控写命令
 * 结果账本。迁移没跑 ⇒ 提交时的占位行 INSERT 抛错（已 catch 成 warn，命令仍入队）、`outcomeOf` 直接
 * 报 `relation ... does not exist`——响亮，绝不退化成「查不到 = 处理中」。命令本身走 event_outbox、
 * 单写者照常应用，故不是承重前置。与上面几条同口径：只抬 KNOWN_MAX、不抬 REQUIRED。
 *
 * 注：`0080_restricted_recovery_outcome`（change split-cloud-api-composition-root-3b）只给上述账本增加
 * nullable recovery 结果列、环境作用域与 resume 阶段，并把 state check 扩为允许 `applying/refused`。
 * 旧 signal/quota 读写形状不变，
 * 迁移缺失时 recovery owner 写会显式失败并由 outbox 保持重放，故同样只抬 KNOWN_MAX、不抬 REQUIRED。
 *
 * 注：`0081_offboard_admission_claims`（change split-cloud-api-composition-root-4a）只给 api
 * admission ledger 增加 claim/CAS 列与 command receipt inbox。独立 automation 的 offboard
 * reconcile 依赖该能力；迁移缺失时 API owner route 显式报 schema/SQL 错且 automation 保持
 * admission pending，不会伪造物化完成。故只抬 KNOWN_MAX、不抬 REQUIRED。
 *
 * 注：`0082_api_sync_read_consumer_checkpoint` /
 * `0083_automation_sync_read_consumer_checkpoint`（change split-cloud-api-composition-root-4b）
 * 分别建立 api 与 automation consumer 自己的 target-scoped cursor/readiness/health 恢复表。
 * 两表不保存 owner payload、共享事实或业务 version；独立组合根启用前不承重，缺表时对应 mirror
 * bootstrap 响亮失败而 monolith 行为不变，故只抬 KNOWN_MAX、不抬 REQUIRED。
 *
 * 注：`0084_automation_account_projection_sync_read`（change split-cloud-api-composition-root-4b）
 * 只给既有共享 B4 投影增加 post-4a 仍有 automation 消费者的 created_at/status；展示与卡片字段
 * 不进入投影。独立 automation 的相关闸门缺列即能力级 fail-closed，故只抬 KNOWN_MAX。
 *
 * 注：`0085_automation_sync_read_owner_generation`（change split-cloud-api-composition-root-4b）
 * 只持久化 automation A3-A6 的 target-scoped digest/generation/emit-dedup 水位，不保存 runtime
 * 业务 payload。缺表时独立 runtime snapshot 响亮失败，绝不把进程内重置 cursor 当作恢复。
 *
 * 注：`0086_session_config_global_sync_read_revision`（change split-cloud-api-composition-root-4b）
 * 在 A1 owner 单例行内持久化 shared revision；mask mutation 与 revision 同一 UPSERT，outbox
 * 清理不影响 snapshot cursor，且不引入平行 revision authority。
 *
 * 注：`0087_automation_account_projection_shared_cursor`（change split-cloud-api-composition-root-4b）
 * 在既有 B4 shared projection-state 行记录 applied cursor/digest，跨 dev/ol 串行防旧快照回退；
 * target checkpoint 只保留 delivery/readiness。
 *
 * 注：`0088_client_environment_proxy_authority`（change cloud-authoritative-environment-proxy）
 * 为 api owner 增加环境原始代理权威；客户鉴权接口缺表时显式返回 schema unavailable，
 * Edge 不会回退到 AdsPower 当前执行副本，故只抬 KNOWN_MAX、不抬 monolith REQUIRED。
 *
 * 注：`0089_facebook_global_scope_regional_templates`
 * 为 automation owner 的 Facebook 群目标增加显式 global/restricted 范围，并持久化区域通用
 * 评论模板；缺失时相关范围与模板能力在 capability probe 处 fail-closed，故只抬 KNOWN_MAX。
 *
 * 注：`0090_facebook_comment_mode_configured`
 * 为 api owner 的账号 Facebook 评论配置增加独立的方案显式性；历史持久化行标记为显式，
 * 新行只有明确写入 commentMode 才置位。缺列时评论配置能力在 probe 处 fail-closed。
 *
 * 注：`0091_facebook_comment_config_snapshot_revision`
 * 推进 API owner 的 facebook_comment_config 镜像版本，使 0090 新增的快照字段与新 cursor
 * 同步生效；否则重启消费者会在旧 cursor 上看见新 payload 并以 same_cursor_payload_drift 拒绝。
 *
 * `0092_facebook_rule_mode_config` 与 `0093_facebook_rule_mode_runtime` 分属 api/automation，
 * 分别增加账号开关和 target-scoped 规则进度/批次。新 store 不保留运行时 DDL，启动必须先
 * 通过精确 schema probe；缺迁移时该固定规则能力不可工作。
 *
 * `0094_facebook_rule_two_tier_config` 与 `0095_facebook_rule_two_tier_runtime`（同样分属
 * api/automation）把 0092/0093 钉死的定义号 / 定义版本 CHECK 放宽为「新旧都接受」，并给 batch
 * 三个动作状态列加上 `not_scheduled`。两条都是**硬依赖**：代码常量已切到两级节奏定义
 * （`facebook_browse_5_like_1_join_contact_every_2@2`），缺这两条迁移时任何配置写入与进度写入
 * 都会被旧 CHECK 以 23514 拒绝，规则模式整体不可工作。
 *
 * `0096_facebook_rule_fallback_comment_state`（automation）再放宽一次 batch 三个动作状态列的 CHECK，
 * 容纳 `confirmed_without_contact`——账号缺联系方式时降级发出的普通评论。同样是硬依赖：缺它时该终态
 * 写不进去，规则轮次终结失败，故 REQUIRED 与 KNOWN_MAX 抬到 0096。
 *
 * 注：`0097_environment_level_rule_mode_and_approval`（change environment-level-rule-mode-and-approval）
 * 给规则模式配置与评论审批覆盖策略加环境键并回填。两个存储的 schema probe **都显式要求 env_key**：
 * 缺列时它们在 init 处带 version id fail-closed（规则模式=不启用、审批=按来源规则），而不是回落读旧账号列
 * ——回落等于把「设置跟账号走」这条已被否决的语义偷偷放回来。故 REQUIRED 与 KNOWN_MAX 一并抬到 0097。
 *
 * 注：`0098_facebook_group_join_daily_cap_50`（change raise-facebook-group-join-cap-ceiling）
 * 把自动加群日上限的库侧 CHECK 从 0..10 放宽到 0..50。**只抬 KNOWN_MAX、不抬 REQUIRED**：
 * 它是放宽方向的约束替换，缺它时旧库仍能正常跑（只是写不进大于 10 的值、写入被库拒并有明确报错），
 * 不构成「缺列就写不进、链路失败」的硬依赖，故不满足抬 REQUIRED 的门槛。
 *
 * 注：`0099_operator_command_receipt`（change split-cloud-automation-production-runtime，1.7③）
 * 新建运营指令的幂等台账表（属主 automation）。**本轮只抬 KNOWN_MAX、刻意不抬 REQUIRED。**
 * 判据就是这条常量自己的门槛「缺了这条迁移，链路写不进 / 失败」——今天**不成立**：
 * 用这张表的接收方是新写的、**还没有接进任何进程**（组装根接线属后续批次），
 * 所以缺表时现网一行代码都不会碰它。
 * ⚠️ **这段判断已被另一路 change 的改动盖过（2026-07-30 集成时发现，如实记下）**：
 * `REQUIRED_SCHEMA_VERSION` 现在是 `0102_facebook_consumption_runtime`，高于 0099。
 * 于是 0099 **按复合序被顺带纳入**「缺了就算 behind」——与上面 0075/0076 那条「副作用（有意，登记于此）」
 * 是同一种情形：**它仍然不是任何存储的硬依赖**，只是序的结果。
 * 实际影响是**接线那一批少一件事**：不必再为 0099 抬 REQUIRED（已被 0102 覆盖），
 * 但**部署序列里那一步照旧不能省**——重启前必须 `npm run migrate up`，且 ol 同理。
 *
 * 下面这段是当时（REQUIRED 还是 0097）的原始论证，保留是因为判据本身没变：
 * 现在抬 REQUIRED 的实际后果是**给还没跑过 `npm run migrate up` 的机器装一颗静默地雷**，
 * 而且比「起不来」更难查（实测这条链路，不是推测）：schema 契约门是 `segAApiFoundation` 的**第一句**、
 * 裸 `await`、刻意无 try/catch，跑在任何连接池与存储 `init()` 之前；enforce 模式下失败即
 * `throw` → `main().catch` 置 `exitCode = 1` → 事件循环排空、进程真的退出 →
 * systemd 只有 `Restart=on-failure` / `RestartSec=5`、**没有 OnFailure、机器上没有探针**
 * ⇒ 表现是**每 5 秒静默重启一次的崩溃循环，零告警**。
 * 而且「behind」这一档**没有豁免通道**：`waived`/`pass` 在该分支里是写死的 false，
 * `AIDCP_ALLOW_SCHEMA_AHEAD` 只作用于「库比代码新」那一档；唯一的杠杆是
 * `AIDCP_SCHEMA_GATE=warn`，那等于把整台机器的门关掉。
 *
 * **接线那一批 MUST 同时做三件事**：抬 REQUIRED 到本版本、部署序列里在**重启之前**
 * 跑一次 `npm run migrate up`、并对 ol 也补上同一步。漏了第一件，缺表会以运行期 42P01 的形式
 * 在第一次真写台账时才炸；漏了第二件，就是上面那个崩溃循环。
 *
 * **补迁移只能用 `npm run migrate up`（或 `baseline`），MUST NOT 用 `scripts/run-migration.ts`**：
 * 后者只执行 SQL、**不写 `schema_migrations` 账本**（它自己的文件头明写这条缺口，且用户 2026-07-25
 * 裁定有意保留它）。用它补完，表在库里、门读的账本却还停在旧版本 ⇒ 照样判 behind，
 * 而现场看起来「表明明建好了」，是最费时间的一种排查。
 *
 * 注：`0104_facebook_reel_mode_cadence` 为现有 Facebook target-global policy 增加普通人设 Reel
 * 点赞/关注与慢启动、规则、消费 Reel 关注的完整数字权威。运行时 schema probe 明确要求这些列；
 * 缺失时不能用编译期常量冒充管理后台配置，故 REQUIRED 与 KNOWN_MAX 一并抬到 0104。
 *
 * 注：`0105_facebook_primary_browse_surface` 增加环境级 Feed/Reels 主入口权威及审计。
 * Facebook 浏览会话启动必须读到该权威，故 REQUIRED 与 KNOWN_MAX 抬到 0105。
 *
 * 注：`0106_automation_sync_read_facebook_operation_policy` 只放宽同步读检查点表的流名取值域，
 * 收下新流 `facebook_operation_policy`。**REQUIRED 一并抬到 0106**：自动化消费者启动时
 * 就会写这条流的检查点，没跑这条迁移的机器上进程直接起不来（约束拒收 → 启动期抛错），
 * 所以它不是「早抬会埋雷」那一类，而是「不抬就起不来」的硬依赖。
 *
 * 注：`0107_facebook_slow_start_reel_like_cadence` 给 API 属主的全局 Facebook operation
 * policy 增加冷启动 Reel 点赞频率。策略 store 的 schema probe 与全量 SELECT 都明确依赖该列，
 * 且不得用进程常量冒充后台配置，故 REQUIRED 与 KNOWN_MAX 一并抬到 0107。属主收窄后
 * automation 仍要求自己的 0106，API 要求 0107。
 *
 * 注：`0108_facebook_operation_policy_snapshot_revision`（change
 * split-cloud-automation-production-runtime 批 H 第 3 片）推进 API 属主
 * `facebook_operation_policy` 的镜像版本，让 0107 与慢启动曲线两处**新增的快照字段**随新 cursor
 * 同步生效。**这是硬依赖，不是洁癖**：该流的 cursor 只在有人写配置时才动，缺这条迁移时
 * 已持有 checkpoint 的消费方重启后会在**旧 cursor 上看见不同的整份 payload**，按
 * `same_cursor_payload_drift` 正确拒收 —— 而那条拒收发生在单体启动路径上，直接起不来
 * （dev 上实测到了）。形态与理由同 `0091_facebook_comment_config_snapshot_revision`。
 * 故 REQUIRED 与 KNOWN_MAX 一并抬到 0108。
 *
 * 注：`0109_content_schedule_hour_claim_env_key_optional`（change
 * wire-content-scheduler-into-api-process）放宽 API 属主 `content_schedule_hour_claims.env_key`
 * 的 NOT NULL —— 排期发帖不再绑定触发时刻的浏览器环境，拿不到环境标识时写 NULL。
 * **REQUIRED 与 KNOWN_MAX 一并抬到 0109，这是硬依赖**：环境标识缺席时占位写的就是 NULL，
 * 库若还没放宽 NOT NULL，该账号每次占位都抛。**它是条件性的**（有环境标识的账号照写不误），
 * 而条件性正是最坏的一档 —— 平时不响，偏在「环境标识解析不出」的那个账号上响，
 * 也就是本 change 专门为之放行的那一类。
 *
 * 第一版曾在 `ContentScheduleStore` 的启动 DDL 里加同一句 `DROP NOT NULL` 想绕开硬依赖，
 * 被 `AC-SCHEMA-DDL-OWNER-01/02` 当场拦下：运行时 DDL 是只减不增的棘轮，新增 DDL 的落点只能是
 * migrations/。**那道闸是对的** —— 绕过硬依赖的代价是把 schema 真相分散回运行期。
 */
export const KNOWN_MAX_SCHEMA_VERSION = '0109_content_schedule_hour_claim_env_key_optional';

export type SchemaGateMode = 'warn' | 'enforce';

export type SchemaGateStatus = 'ok' | 'behind' | 'ahead' | 'unreadable';

export type SchemaGateCode =
  | 'schema_behind_code'
  | 'schema_ahead_of_code'
  | 'schema_ledger_unreadable'
  /**
   * 判据本身不可用（迁移目录读不出 / 边界清单读不出 / 有表查不到属主）。
   * 判据没了就等于什么都没校验，MUST 判失败 —— 旧实现在读不到 migrations/ 时退化成
   * 「只认最高版本」并照常放行，那是一条实打实的假绿路径。
   */
  | 'schema_owner_attribution_unavailable';

export interface SchemaGateInput {
  /** 账本里的全部版本 id；账本不可读时给空数组并设 ledgerError */
  ledgerVersions: string[];
  /** 账本读取本身失败（表不存在 / 连不上库）时的原因；设了它就一定是 unreadable 分支 */
  ledgerError?: string;
  /** unreadable 分支的错误码；缺省 `schema_ledger_unreadable`（判据不可用时传属主判据那一条） */
  ledgerErrorCode?: SchemaGateCode;
  /** 本构建知道的全部版本 id（用于列出「缺哪几条」） */
  knownVersions: string[];
  required?: string;
  knownMax?: string;
  /** env AIDCP_ALLOW_SCHEMA_AHEAD 的原始值 */
  allowAheadRaw?: string;
}

export interface SchemaGateDecision {
  status: SchemaGateStatus;
  code?: SchemaGateCode;
  /** 账本最高版本（复合序） */
  ledgerMax?: string;
  required: string;
  knownMax: string;
  /** behind 分支：本构建知道、账本里却没有、且版本序不高于 required 的版本 */
  missing: string[];
  /**
   * ok / ahead 分支里的**账本空洞**：账本最高版本够高，但中间缺了本应有的条目。
   *
   * 判定仍只看最高版本（口径不变，MUST NOT 因为本字段改判），但空洞必须被打出来 ——
   * 「最高版本够高」并不证明中间那些迁移真的跑过，只报一个 max 就是把这段事实吞掉。
   */
  holes: string[];
  /** ahead 分支：账本里高于 knownMax 的版本 */
  ahead: string[];
  /** 生效的放行版本 id（未放行为 undefined） */
  waivedUpTo?: string;
  /** 本次是否被显式放行（只对 ahead 分支有意义） */
  waived: boolean;
  /** true = 允许继续启动（enforce 下也放行） */
  pass: boolean;
  message: string;
}

const BOOLEAN_LIKE = new Set(['true', 'false', '1', '0', 'yes', 'no', 'on', 'off', '*', 'all', 'any']);

/**
 * 放行通道解析（任务 6.4）：必须是具体版本 id。
 * 布尔值、空串、通配值一律视为未放行 —— 布尔旁路一旦打开就永久生效，下一次真正危险的超前也会被同一个开关放过。
 */
export function parseAllowSchemaAhead(raw: string | undefined): string | undefined {
  const value = raw?.trim();
  if (!value) return undefined;
  if (BOOLEAN_LIKE.has(value.toLowerCase())) return undefined;
  if (!/^\d+_[\w.-]+$/.test(value)) return undefined;
  return value;
}

export function parseSchemaGateMode(raw: string | undefined): SchemaGateMode {
  return raw?.trim().toLowerCase() === 'enforce' ? 'enforce' : 'warn';
}

function maxVersion(versions: string[]): string | undefined {
  let max: string | undefined;
  for (const v of versions) {
    if (max === undefined || compareVersions(v, max) > 0) max = v;
  }
  return max;
}

export function evaluateSchemaGate(input: SchemaGateInput): SchemaGateDecision {
  const required = input.required ?? REQUIRED_SCHEMA_VERSION;
  const knownMax = input.knownMax ?? KNOWN_MAX_SCHEMA_VERSION;
  const waivedUpTo = parseAllowSchemaAhead(input.allowAheadRaw);

  if (input.ledgerError) {
    return {
      status: 'unreadable',
      code: input.ledgerErrorCode ?? 'schema_ledger_unreadable',
      required,
      knownMax,
      missing: [],
      holes: [],
      ahead: [],
      waivedUpTo,
      waived: false,
      pass: false,
      message: `无法证明 schema 正确：读取迁移账本失败（${input.ledgerError}）。所需最低版本 ${required}。`,
    };
  }

  const ledgerMax = maxVersion(input.ledgerVersions);
  const ledgerSet = new Set(input.ledgerVersions);
  const holes = input.knownVersions
    .filter((v) => !ledgerSet.has(v) && compareVersions(v, required) <= 0)
    .sort(compareVersions);

  if (ledgerMax === undefined || compareVersions(ledgerMax, required) < 0) {
    return {
      status: 'behind',
      code: 'schema_behind_code',
      ledgerMax,
      required,
      knownMax,
      missing: holes,
      holes: [],
      ahead: [],
      waivedUpTo,
      waived: false,
      pass: false,
      message: `账本最高版本 ${ledgerMax ?? '(空)'} 低于本构建所需最低版本 ${required}；缺失 ${holes.length} 条，处置是补跑迁移。`,
    };
  }

  if (compareVersions(ledgerMax, knownMax) > 0) {
    const ahead = input.ledgerVersions.filter((v) => compareVersions(v, knownMax) > 0).sort(compareVersions);
    const waived = waivedUpTo !== undefined && compareVersions(ledgerMax, waivedUpTo) <= 0;
    return {
      status: 'ahead',
      code: 'schema_ahead_of_code',
      ledgerMax,
      required,
      knownMax,
      missing: [],
      holes,
      ahead,
      waivedUpTo,
      waived,
      pass: waived,
      message: waived
        ? `账本最高版本 ${ledgerMax} 高于本构建认识的最高版本 ${knownMax}，已按放行版本 ${waivedUpTo} 逐次放行（超前 ${ahead.length} 条）。`
        : `账本最高版本 ${ledgerMax} 高于本构建认识的最高版本 ${knownMax}（超前 ${ahead.length} 条）；这是回滚场景，继续启动会让旧代码静默重建空表。`,
    };
  }

  return {
    status: 'ok',
    ledgerMax,
    required,
    knownMax,
    missing: [],
    holes,
    ahead: [],
    waivedUpTo,
    waived: false,
    pass: true,
    message: `schema 契约门通过：账本最高版本 ${ledgerMax}（所需 ${required}，本构建认识到 ${knownMax}）。`,
  };
}

/**
 * 把「全构建」的契约窗口收窄到某个属主自己的版本集合上（纯函数）。
 *
 * - `knownMax` = 该属主认识的最高版本；
 * - `required` = 该属主认识的、不高于全局所需版本的最高一条。
 *   该属主全部版本都高于全局所需版本时（防御分支，本仓当前不出现），退化取它的最低版本
 *   —— 那是这个属主的下限，MUST NOT 退化成「无要求」。
 *
 * 收窄是必须的：全局 `REQUIRED` / `KNOWN_MAX` 取自三家的并集，直接套到只有 19 条迁移的
 * content 库上会得到一次假的 behind / ahead 判定。
 */
export function narrowSchemaContract(
  ownerVersions: string[],
  globalRequired = REQUIRED_SCHEMA_VERSION,
): { required: string; knownMax: string } {
  const sorted = [...ownerVersions].sort(compareVersions);
  const knownMax = sorted.at(-1);
  if (knownMax === undefined) {
    throw new Error('属主版本集合为空，无法收窄 schema 契约窗口');
  }
  const atOrBelow = sorted.filter((v) => compareVersions(v, globalRequired) <= 0);
  return { required: atOrBelow.at(-1) ?? sorted[0], knownMax };
}

/** warn 与 enforce 共用的结论文本；两种模式 MUST 逐字一致，只有前缀不同。 */
export function formatGateConclusion(decision: SchemaGateDecision): string {
  const parts = [decision.message];
  if (decision.missing.length > 0) parts.push(`缺失版本：${decision.missing.join(', ')}`);
  if (decision.holes.length > 0) {
    // 空洞可能很长（一次回滚能把整批都算进来），列前 10 条 + 总数：既不吞事实，也不把一行日志撑成几千字。
    const head = decision.holes.slice(0, 10).join(', ');
    const tail = decision.holes.length > 10 ? `，… 共 ${decision.holes.length} 条` : '';
    parts.push(`账本空洞（最高版本够高但中间缺条目）：${head}${tail}`);
  }
  if (decision.ahead.length > 0) parts.push(`超前版本：${decision.ahead.join(', ')}`);
  if (decision.waived && decision.waivedUpTo) parts.push(`放行区间：(${decision.knownMax}, ${decision.waivedUpTo}]`);
  return parts.join('；');
}
