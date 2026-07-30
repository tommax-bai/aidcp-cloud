/**
 * 契约层：ExecutionIntent 与 ExecutionAttempt —— Execution Ledger 的平台动作真相
 * （design §11/§12，ledger spec）。
 *
 * 每次准备真实动作先建立**不可变** ExecutionIntent；Attempt 是一次真实平台动作尝试。
 * 核心状态机（design §11）：
 *
 *   prepared → blocked | cancelled | dispatched
 *   dispatched → platform_confirmed | confirmed_not_applied | submitted_unknown
 *   submitted_unknown →(Reconciler) platform_confirmed | confirmed_not_applied | 保持 unknown
 *
 * ledger spec 另要求三个派发后结果：accepted_pending（平台已受理、效果未外显）、
 * held_for_moderation（写入被第三方人工审核扣住）、precondition_already_satisfied
 * （证据显示目标末态本已成立）。
 * 红线：submitted_unknown 禁止再次执行同一不可逆动作，只能交给 Reconciler；
 * 派发后的传输超时/丢 ack/页面跳转/进程丢失不得翻译成成功或确认失败。
 */

import type { EpochMillis, ExecutionTarget, MissPolicy } from './common.js';
import type { ActionDomain, ActionExecutionClass } from './action-classification.js';
import type { AttemptNonStartReason, ReasonCode } from './reason-codes.js';
import type { CapabilityId } from './capability.js';

/**
 * 不可变执行意图（design §11 字段清单逐字冻结 + missPolicy 补全 schedule 三元组语义）。
 * 幂等：同一业务幂等键命中既有 intent/Attempt 时 Ledger 返回既有关系或拒绝，
 * 绝不产生第二个平台动作。
 */
export interface ExecutionIntent {
  intentId: string;
  accountId: string;
  envKey: string;
  executionTarget: ExecutionTarget;
  /** 账号绑定 revision（lane 身份冻结输入，design §7）。 */
  bindingRevision: string;
  /** 动作类型（落点能力 ID；'interaction.like'、'publish.submit' 等）。 */
  actionType: CapabilityId;
  /** 动作域与执行分类（准入判据快照；期1 platform_write 在准入即拒，不会建 intent）。 */
  actionDomain: ActionDomain;
  executionClass: ActionExecutionClass;
  /** 平台稳定目标 ID；无目标动作（如发布新帖）为 null。 */
  targetStableId: string | null;
  contentVersion: string | null;
  approvalRevision: string | null;
  scheduledAt: EpochMillis;
  latestStartAt: EpochMillis;
  missPolicy: MissPolicy;
  requiredCapability: CapabilityId;
  protocolVersion: string;
  /** 业务幂等键：锚定已批准工件身份 + 平台稳定标识（ledger spec）。 */
  idempotencyKey: string;
  correlationId: string;
  runId: string;
  stepId: string;
  createdAt: EpochMillis;
}

/**
 * Attempt 状态全集 = 派发前 3 态 + dispatched + 派发后 6 结果。
 * 见文件头状态机；除 submitted_unknown 可被 Reconciler 改判外，落定后不可逆。
 */
export type ExecutionAttemptStatus =
  | 'prepared'
  | 'blocked'
  | 'cancelled'
  | 'dispatched'
  | 'platform_confirmed'
  | 'confirmed_not_applied'
  | 'submitted_unknown'
  | 'accepted_pending'
  | 'held_for_moderation'
  | 'precondition_already_satisfied';

export const EXECUTION_ATTEMPT_STATUSES = [
  'prepared',
  'blocked',
  'cancelled',
  'dispatched',
  'platform_confirmed',
  'confirmed_not_applied',
  'submitted_unknown',
  'accepted_pending',
  'held_for_moderation',
  'precondition_already_satisfied',
] as const satisfies readonly ExecutionAttemptStatus[];

/** 未跨过派发线的状态（此前取消/阻断不产生平台副作用）。 */
export const ATTEMPT_PRE_DISPATCH_STATUSES = [
  'prepared',
  'blocked',
  'cancelled',
] as const satisfies readonly ExecutionAttemptStatus[];

/**
 * confirmed_not_applied 必须区分两种事实（ledger spec）：
 * - `never_applied`：写入从未落到平台；窗口与授权仍满足时可建新 Attempt；
 * - `platform_refused`：平台主动拒绝；**终局**，同一 intent 不得自动重试，
 *   必须路由到 risk/attention。
 */
export type ConfirmedNotAppliedKind = 'never_applied' | 'platform_refused';

export const CONFIRMED_NOT_APPLIED_KINDS = [
  'never_applied',
  'platform_refused',
] as const satisfies readonly ConfirmedNotAppliedKind[];

/**
 * 观测诚实三态（task-runtime/ledger spec）：「没看到」不等于「看到了不存在」。
 * 证据字段无法观测时持久化为 absent 并如实上报 unavailable，绝不合成。
 */
export type ObservationOutcome = 'observed_present' | 'observed_absent' | 'not_observed';

export const OBSERVATION_OUTCOMES = [
  'observed_present',
  'observed_absent',
  'not_observed',
] as const satisfies readonly ObservationOutcome[];

/**
 * ExecutionAttempt：一次真实平台动作尝试（design §2/§11）。
 * platform_confirmed 至少需要平台稳定 ID/URL、平台 API receipt 或合同认可的页面后置证据；
 * Edge 的「点击成功」、WebSocket ack、审批卡和 Host event 都不是平台成功。
 */
export interface ExecutionAttempt {
  attemptId: string;
  intentId: string;
  runId: string;
  stepId: string;
  executionTarget: ExecutionTarget;
  /** 同一 intent 下的尝试序号（重试必须有界且共享幂等键，design §11）。 */
  ordinal: number;
  status: ExecutionAttemptStatus;
  /**
   * 派发前未开始的类型化原因（仅 blocked/cancelled 且未跨派发线时非空）。
   * 四类不得合并；只有 resource_slot_wait 保留自动重试授权（ledger spec）。
   */
  nonStartReason: AttemptNonStartReason | null;
  /** 仅 status='confirmed_not_applied' 时非空。 */
  confirmedNotAppliedKind: ConfirmedNotAppliedKind | null;
  /** 拒绝/阻断/取消的原因码（blocked 时必填语义）。 */
  reasonCode: ReasonCode | null;
  /** 平台确认证据引用（独立观测、可归因、可否决，ledger spec）。 */
  evidenceRef: string | null;
  /** submitted_unknown 落定前观测到的最强进度证据（ledger spec 要求持久化）。 */
  strongestProgressEvidenceRef: string | null;
  /** 有界对账计数（对账次数/间隔/总窗口由平台合同定义，design §12）。 */
  reconciliationCount: number;
  preparedAt: EpochMillis;
  dispatchedAt: EpochMillis | null;
  settledAt: EpochMillis | null;
}
