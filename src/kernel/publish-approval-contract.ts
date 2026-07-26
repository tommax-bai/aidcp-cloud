/**
 * 发布审批的**纯枚举 / 哨兵错误契约**（原定义在 src/publish-agent/publish-approval-store.ts，automation）。
 * 抬入 kernel（change decouple-longtail-sweep）供发布下发编排等跨边界消费方直接引用，
 * 无需 type/value 依赖属主侧的 pg 审批存储类。零 import、零 SQL、无进程内活状态，满足 §4.7 kernel 准入
 * （Error 子类与 kernel/schema-capability-contract 的 SchemaCapabilityError 同一手法；const 数组为字面 tuple、非 Set/Map）。
 */

import type { DeploymentTarget } from '../deployment-target.js';
import type { PublishApprovalPayload } from './feishu-card-contract.js';

export const APPROVAL_DECIDED_VIA = [
  'feishu',
  'console',
  'client',
  'delegated_task',
  'schedule_auto_approve',
] as const;
export type ApprovalDecidedVia = (typeof APPROVAL_DECIDED_VIA)[number];

export interface PublishApprovalDecisionContext {
  decidedBy: string;
  decidedVia: ApprovalDecidedVia;
  envKey?: string | null;
}

export interface PublishApprovalDecisionWriteInput {
  requestId: string;
  approved: boolean;
  payload: PublishApprovalPayload;
  context: PublishApprovalDecisionContext;
  executionTarget: DeploymentTarget;
}

export interface PublishApprovalDecisionWriteOutcome {
  written: boolean;
  alreadyDecided?: boolean;
  revision: number;
}

/**
 * API-owned approval decision writer。automation 只能经此端口提交完整决策上下文，
 * 不能持有 API 数据库连接或直接构造 `PublishApprovalStore`。
 */
export interface PublishApprovalDecisionWriterPort {
  writeDecision(input: PublishApprovalDecisionWriteInput): Promise<PublishApprovalDecisionWriteOutcome>;
}

export const PUBLISH_APPROVAL_DECISION_WRITER_CONTRACT_VERSION = 1 as const;

export const PUBLISH_APPROVAL_DECISION_WRITER_ERROR_CODES = [
  'approval_decision_invalid_request',
  'approval_decision_target_mismatch',
  'approval_decision_unavailable',
  'approval_decision_result_unknown',
] as const;
export type PublishApprovalDecisionWriterErrorCode =
  (typeof PUBLISH_APPROVAL_DECISION_WRITER_ERROR_CODES)[number];

export class PublishApprovalDecisionWriterError extends Error {
  constructor(
    readonly code: PublishApprovalDecisionWriterErrorCode,
    message: string = code,
  ) {
    super(message);
    this.name = 'PublishApprovalDecisionWriterError';
  }
}

/** 作废原因枚举——四类既有作废场景各自可区分，MUST NOT 合并为泛化原因。枚举外 MUST 拒绝。 */
export const APPROVAL_VOID_REASONS = [
  'version_stale',
  'edge_offline',
  'preempt_exhausted',
  'lease_unconfirmed',
] as const;
export type ApprovalVoidReason = (typeof APPROVAL_VOID_REASONS)[number];

export function isApprovalVoidReason(value: unknown): value is ApprovalVoidReason {
  return typeof value === 'string' && (APPROVAL_VOID_REASONS as readonly string[]).includes(value);
}

/** 下发阻塞原因（可读、映射到既有五类阻塞）。阻塞解除 MUST 清空。 */
export const APPROVAL_BLOCKED_REASONS = [
  'edge_offline_waiting',
  'browser_slot_waiting',
  'breaker_open',
  'captcha_paused',
  'approval_unreadable',
] as const;
export type ApprovalBlockedReason = (typeof APPROVAL_BLOCKED_REASONS)[number];

export const APPROVAL_DISPATCH_STATES = ['pending_dispatch', 'dispatching', 'consumed', 'void'] as const;
export type ApprovalDispatchState = (typeof APPROVAL_DISPATCH_STATES)[number];

/** publish approval authority 的 wire/read 视图；不暴露 frozen payload。 */
export interface PublishApprovalView {
  requestId: string;
  revision: number;
  approved: boolean;
  contentVersion: number;
  dispatchState: ApprovalDispatchState;
  dispatchBlockedReason: string | null;
  envKey: string | null;
  executionTarget: DeploymentTarget;
  decidedAt: number;
  decidedBy: string;
  decidedVia: string;
}

export interface PublishApprovalReadInput {
  requestId: string;
  executionTarget: DeploymentTarget;
}

export interface PublishApprovalListInput {
  executionTarget: DeploymentTarget;
  limit?: number;
  subjectKind?: 'publish' | 'comment';
}

export interface PublishApprovalRevisionInput extends PublishApprovalReadInput {
  expectedRevision: number;
}

export interface VoidPublishApprovalInput extends PublishApprovalRevisionInput {
  reason: ApprovalVoidReason;
}

export interface ReleasePublishApprovalInput extends PublishApprovalRevisionInput {
  blockedReason: ApprovalBlockedReason | null;
}

export interface SetPublishApprovalBlockedReasonInput extends PublishApprovalRevisionInput {
  reason: ApprovalBlockedReason | null;
}

/**
 * API-owned publish approval authority。automation 只能经此端口读/推进授权，
 * 不能持有 API 数据库连接或直接写授权表。
 */
export interface PublishApprovalAuthorityPort {
  getApproval(input: PublishApprovalReadInput): Promise<PublishApprovalView | null>;
  listPendingDispatch(input: PublishApprovalListInput): Promise<PublishApprovalView[]>;
  voidApproval(input: VoidPublishApprovalInput): Promise<PublishApprovalView>;
  markDispatching(input: PublishApprovalRevisionInput): Promise<PublishApprovalView>;
  markConsumed(input: PublishApprovalRevisionInput): Promise<PublishApprovalView>;
  releaseToPending(input: ReleasePublishApprovalInput): Promise<PublishApprovalView>;
  setBlockedReason(input: SetPublishApprovalBlockedReasonInput): Promise<PublishApprovalView>;
}

export const PUBLISH_APPROVAL_AUTHORITY_ERROR_CODES = [
  'approval_not_found',
  'approval_revision_conflict',
  'approval_state_conflict',
  'approval_target_mismatch',
  'approval_authority_unavailable',
  'approval_authority_result_unknown',
  'approval_invalid_request',
] as const;
export type PublishApprovalAuthorityErrorCode = (typeof PUBLISH_APPROVAL_AUTHORITY_ERROR_CODES)[number];

export class PublishApprovalAuthorityError extends Error {
  constructor(
    readonly code: PublishApprovalAuthorityErrorCode,
    message: string = code,
    readonly details?: { currentRevision?: number; currentState?: ApprovalDispatchState },
  ) {
    super(message);
    this.name = 'PublishApprovalAuthorityError';
  }
}

export const PUBLISH_APPROVAL_AUTHORITY_CONTRACT_VERSION = 1 as const;

export const PUBLISH_DISPATCH_TRIGGER_KINDS = ['decision_recorded', 'human_reconfirm'] as const;
export type PublishDispatchTriggerKind = (typeof PUBLISH_DISPATCH_TRIGGER_KINDS)[number];

export interface PublishDispatchTriggerInput {
  requestId: string;
  revision: number;
  executionTarget: DeploymentTarget;
  kind: PublishDispatchTriggerKind;
}

/**
 * 已决授权上的人工重批唤醒。调用方不选择 target；组合根从本服务配置注入后再交给跨进程端口。
 * 首写批准 MUST 由事务 outbox 的 `decision_recorded` relay 承担，不能伪装成这类人工确认。
 */
export interface PublishHumanReconfirmTrigger {
  requestId: string;
  revision: number;
  kind: 'human_reconfirm';
}

/** `queued|duplicate` 只描述内部唤醒受理；刻意不含任何 dispatch / submit / publish 状态。 */
export interface PublishDispatchTriggerAccepted {
  accepted: true;
  disposition: 'queued' | 'duplicate';
}

export interface PublishDispatchTriggerPort {
  triggerApproved(input: PublishDispatchTriggerInput): Promise<PublishDispatchTriggerAccepted>;
}

export const PUBLISH_DISPATCH_TRIGGER_CONTRACT_VERSION = 1 as const;

export const PUBLISH_DISPATCH_TRIGGER_ERROR_CODES = [
  'publish_trigger_invalid_request',
  'publish_trigger_target_mismatch',
  'publish_trigger_approval_not_found',
  'publish_trigger_revision_conflict',
  'publish_trigger_unavailable',
  'publish_trigger_result_unknown',
] as const;
export type PublishDispatchTriggerErrorCode = (typeof PUBLISH_DISPATCH_TRIGGER_ERROR_CODES)[number];

export class PublishDispatchTriggerError extends Error {
  constructor(
    readonly code: PublishDispatchTriggerErrorCode,
    message: string = code,
    readonly details?: { currentRevision?: number },
  ) {
    super(message);
    this.name = 'PublishDispatchTriggerError';
  }
}

/** 审批记录读取失败的哨兵错误（下发段据 instanceof 与 code 区分不可读 vs 其他失败）。 */
export class ApprovalUnreadableError extends Error {
  readonly code = 'approval_unreadable';
  constructor(message: string) {
    super(message);
    this.name = 'ApprovalUnreadableError';
  }
}
