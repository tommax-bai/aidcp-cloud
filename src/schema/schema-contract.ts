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
export const REQUIRED_SCHEMA_VERSION = '0076_config_mirror_bump_inbox';

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
 */
export const KNOWN_MAX_SCHEMA_VERSION = '0087_automation_account_projection_shared_cursor';

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
