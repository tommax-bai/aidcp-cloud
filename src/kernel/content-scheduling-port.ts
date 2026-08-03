/**
 * 内容排期调度器向**自动化服务**取用的那一族事实与触发（kernel · 只定义契约）。
 *
 * 排期器本身归接口服务（类在 `src/orchestrator/content-scheduler.ts`，属主 api），但它每分钟要问的
 * 事实有大半住在自动化服务：谁连着引擎、账号风控态、三条管线在不在跑、委托任务是不是占着这个账号，
 * 以及三类动作的真正扳机。单体里这些全是进程内直调；拆开之后每一条都是一跳，而**每一跳都要回答
 * 同一个问题：问不到的时候算什么**。
 *
 * ── 一、失败方向按「哪边更严」判，不按「哪边更像缺省」判 ──────────────────────────
 *
 * 这是本文件存在的首要理由，也是每个方法上那句注释要钉死的东西：
 *
 *   - **在线账号清单**问不到 ⇒ 整个心跳跳过。回一个空数组＝「此刻没人在线」，与真的没人在线
 *     **在外部完全同形**：全员静默停摆，而日志、面板、卡片全都正常。
 *   - **风控状态**问不到 ⇒ 跳过该账号。回 `'normal'` 就是放行，而风控闸的全部意义就是拦住非 normal。
 *   - **三个「在不在跑」**问不到 ⇒ 判为在跑。回「不忙」是放行；这道闸就是防重复触发的，失败开闸＝双发。
 *   - **委托任务占用**问不到 ⇒ 判为占用。同上，且委托是人主动发起的、优先级高于周期任务。
 *
 * 所以这些方法**一律返回裸值、失败靠抛**（传输三件套统一译成 `ApiDirectHttpError`），
 * **MUST NOT** 在客户端 catch 成一个「看着正常」的缺省值 —— 那正是本仓反复点名的静默假成功。
 * 判到「更严」的那一侧由调用方（排期器）做，理由是只有它知道「跳过」意味着跳过什么。
 *
 * ── 二、触发的回执语义是「受不受理」，不是「结局如何」──────────────────────────────
 *
 * 单体里三类触发返回的 promise 在**生成完成或失败时**才 settle，排期器挂个 finally。跨进程不能这么办：
 * 一次 HTTP 挂住整条生成链，既占连接又把超时语义搅进业务结局（超时到底算发了还是没发？）。
 *
 * 故 {@link ScheduledTriggerAcceptance} 只回答「受理 / 未受理 + 具名原因」。由此推出一条**必须同批**
 * 办的事：**终态结果卡由自动化侧发**（结局在它那儿），排期器只对「未受理」回卡。两侧都发卡会让运营
 * 分不出是哪条路径放行的 —— 这个形态在拆仓过程里已经咬过一次。
 *
 * `retryable` 区分的是两种「未受理」，它们的处置**相反**：
 *   - `retryable: true` —— 瞬时未开始（边端离线 / 浏览器唤不醒 / 租约不可得）。小时格**归还**，
 *     本小时剩余分钟有界重试，且**不回卡**（重试期每次都发卡就是每分钟刷一张告警）。
 *   - `retryable: false` —— 持久性未触发（未绑人设 / 缺联系方式 / 配额拒 / 已在跑）。重试无用，
 *     照旧烧掉本格并如实回一张黄卡。
 *
 * ── 三、部署 target 由客户端从本机部署事实注入，调用方无入口可选 ─────────────────────
 *
 * 逐字复用 4a 的信封（{@link file://./api-direct-port.js}）：`version` + `executionTarget` + `input`，
 * 接收方逐字比对后才处理。DEV/OL 长期共用一个数据库，让调用方挑 target 等于把「在哪台机器上真跑」
 * 交给一个 HTTP body 字段。
 *
 * kernel 准入：零 SQL、零 HTTP、零 LLM、零模块级活状态（无 `let` / `var` / `new Map` / `new Set` /
 * 定时器 / 连接池），只 import 同层 kernel 契约。
 */
import { API_DIRECT_CONTRACT_VERSION } from './api-direct-port.js';
import type { DeploymentTarget } from '../deployment-target.js';

/** 与 4a 共用同一个契约版本号（分开编号只会各自漂移）。 */
export const CONTENT_SCHEDULING_CONTRACT_VERSION = API_DIRECT_CONTRACT_VERSION;

/**
 * 排期动作的审批模式。**刻意与 `ContentScheduleApprovalMode` 逐字同值而不 import 它** ——
 * 那个类型住在 api 的配置层（`src/config/content-schedule-store.ts`），kernel 不得 import 业务层文件。
 * 两侧漂移由排期器构造处的类型检查暴露（它同时看得见两个类型）。
 */
export type ScheduledApprovalMode = 'manual_review' | 'auto_approve';

/** 评论扳机的两种形态：普通排期评论 / 联系评论（带联系方式注入）。 */
export type ScheduledCommentVariant = 'comment' | 'contact_comment';

/** 委托任务占用的动作族（与委托台账的 family 同值）。 */
export type ScheduledDelegatedFamily = 'comment' | 'publish';

/**
 * 在线账号身份。`envKey` **只作诊断**：连着引擎仍是排期的闸，连的是**哪个**浏览器环境不再是
 * （用户 2026-08-03 裁定）。null 表示边端标识里解析不出环境，不表示账号不可用。
 */
export interface ScheduledOnlineAccount {
  accountId: string;
  envKey: string | null;
}

/** 自动发帖被下发时冻结的执行事实（随扳机透传，供发布链归档与对账）。 */
export interface ScheduledPostExecutionInput {
  executionTarget: DeploymentTarget;
  /** 诊断用，绝不在下发时比对。绑定稿件到机器的是上面那个 target。 */
  envKey: string | null;
  hourCell: string;
}

/**
 * 触发回执：**受理与否**，不是结局。
 *
 * `accepted: true` 只声明「管线已接手、真的开跑了」。它**不声明**发出去了、也不声明会成功；
 * 终态由自动化侧自己的结果卡承担。
 */
export interface ScheduledTriggerAcceptance {
  accepted: boolean;
  /** 机器可读的未受理原因（如 `quota_denied` / `edge_offline` / `lease_unavailable` / `already_running`）。 */
  reason?: string;
  /**
   * true = 瞬时未开始，小时格可归还并在本小时内有界重试，且**不回卡**；
   * false / 缺省 = 持久性未触发，烧掉本格并如实回一张卡。
   */
  retryable?: boolean;
  /** 给运营看的人话（未受理时才有意义）。缺省由调用方按 reason 兜一句。 */
  level?: 'warning' | 'error';
  title?: string;
  message?: string;
}

export interface ScheduledAccountInput {
  accountId: string;
}

export interface ScheduledDelegatedOwnershipInput extends ScheduledAccountInput {
  family: ScheduledDelegatedFamily;
}

export interface ScheduledPostTriggerInput extends ScheduledAccountInput {
  approvalMode: ScheduledApprovalMode;
  execution: ScheduledPostExecutionInput;
}

export interface ScheduledCommentTriggerInput extends ScheduledAccountInput {
  approvalMode: ScheduledApprovalMode;
  variant: ScheduledCommentVariant;
}

export type ScheduledJoinTriggerInput = ScheduledAccountInput;

export interface ScheduledBusyView {
  busy: boolean;
}

export interface ScheduledCountView {
  count: number;
}

export interface ScheduledRiskStatusView {
  status: string;
}

/**
 * 在线清单一律**包一层记录**而不是回裸数组：线上形状守卫、以及「回了个非数组」这类畸形应答，
 * 在记录形状下才有统一的判法（本仓其余窄口皆同形，不发明第二种）。
 */
export interface ScheduledOnlineAccountsView {
  accounts: readonly ScheduledOnlineAccount[];
}

export interface ScheduledDailyCapView {
  cap: number;
}

/**
 * 接口进程的排期器向自动化服务取用的全部窄口。
 *
 * **每个方法都失败靠抛**（见文件头「一」）。客户端把不可达 / 超时 / 形状不符统一译成
 * `ApiDirectHttpError`；本接口 **MUST NOT** 出现任何「问不到时的缺省值」形状（如
 * `status?: string` 或 `busy?: boolean`）—— 缺省值一旦进了契约，判「哪边更严」的那个决定就
 * 从调用方手里被悄悄拿走了。
 */
export interface ContentSchedulingAutomationPort {
  /** 问不到 ⇒ 调用方 MUST 跳过整个心跳。回空数组与「真的没人在线」在外部完全同形。 */
  listOnlineAccounts(): Promise<ScheduledOnlineAccountsView>;
  /** 问不到 ⇒ 调用方 MUST 跳过该账号。MUST NOT 落成 `'normal'`。 */
  readRiskStatus(input: ScheduledAccountInput): Promise<ScheduledRiskStatusView>;
  /** 问不到 ⇒ 判为在跑。失败开闸＝同一账号双发。 */
  readPublishBusy(input: ScheduledAccountInput): Promise<ScheduledBusyView>;
  /** 问不到 ⇒ 判为在跑。 */
  readCommentBusy(input: ScheduledAccountInput): Promise<ScheduledBusyView>;
  /** 问不到 ⇒ 判为在跑。 */
  readJoinBusy(input: ScheduledAccountInput): Promise<ScheduledBusyView>;
  /** 问不到 ⇒ 判为占用（委托是人主动发起的，优先级高于周期任务）。 */
  readDelegatedOwnershipBusy(
    input: ScheduledDelegatedOwnershipInput,
  ): Promise<ScheduledBusyView>;
  /** 今日已发评论数（持久互动记录）。问不到 ⇒ 由调用方按 catch 跳过该账号，MUST NOT 落成 0。 */
  readCommentedTodayCount(input: ScheduledAccountInput): Promise<ScheduledCountView>;
  /** 今日已确认加入的群数。问不到 ⇒ 同上。 */
  readJoinedTodayCount(input: ScheduledAccountInput): Promise<ScheduledCountView>;
  /** join_group 的风控日上限。问不到 ⇒ 同上。 */
  readJoinDailyCap(input: ScheduledAccountInput): Promise<ScheduledDailyCapView>;
  /**
   * 排期发帖扳机。接收方负责走既有 提议→人审→派发 管线并在终态自发结果卡；
   * 本调用**受理即返回**，MUST NOT 挂到生成结束。
   */
  triggerScheduledPost(
    input: ScheduledPostTriggerInput,
  ): Promise<ScheduledTriggerAcceptance>;
  /**
   * 排期评论 / 联系评论扳机。**配额闸（`canDo('comment')`）由接收方执行** —— 它挨着风控事实源，
   * 放在调用方这侧就要么多一跳、要么让排期器拿一份可能过期的副本去判。
   */
  triggerScheduledComment(
    input: ScheduledCommentTriggerInput,
  ): Promise<ScheduledTriggerAcceptance>;
  /** 排期加群扳机。开关 / 日上限 / 时段三道闸在调用方（配置属主是接口服务），此处只管开跑。 */
  triggerScheduledJoin(
    input: ScheduledJoinTriggerInput,
  ): Promise<ScheduledTriggerAcceptance>;
}

/** 结构化守卫：跨进程后回执是 JSON 反序列化出来的裸对象，原型链上什么都没有。 */
export function isScheduledTriggerAcceptance(
  value: unknown,
): value is ScheduledTriggerAcceptance {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (typeof record.accepted !== 'boolean') return false;
  if (record.reason !== undefined && typeof record.reason !== 'string') return false;
  if (record.retryable !== undefined && typeof record.retryable !== 'boolean') return false;
  if (
    record.level !== undefined
    && record.level !== 'warning'
    && record.level !== 'error'
  ) {
    return false;
  }
  if (record.title !== undefined && typeof record.title !== 'string') return false;
  if (record.message !== undefined && typeof record.message !== 'string') return false;
  return true;
}

export function isScheduledApprovalMode(value: unknown): value is ScheduledApprovalMode {
  return value === 'manual_review' || value === 'auto_approve';
}

export function isScheduledCommentVariant(
  value: unknown,
): value is ScheduledCommentVariant {
  return value === 'comment' || value === 'contact_comment';
}

export function isScheduledDelegatedFamily(
  value: unknown,
): value is ScheduledDelegatedFamily {
  return value === 'comment' || value === 'publish';
}
