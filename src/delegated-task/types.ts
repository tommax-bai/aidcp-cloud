import {
  DEPLOYMENT_TARGETS,
  parseDeploymentTarget,
} from '../deployment-target.js';
// 纯类型契约已提到 kernel（发布 / 委托任务闭包共导）；本文件保留状态机 Set、转移/校验函数与运行时数组常量。
// re-export 保持既有 `from '../delegated-task/types'` 的类型导入面逐字不变。
import type {
  DelegatedAction,
  DelegatedTaskStatus,
  DelegatedExecutionTarget,
  DelegatedActionFamily,
  DelegatedTaskProgress,
  DelegatedTaskIntent,
  DelegatedVerificationKind,
} from '../kernel/delegated-task-types.js';
export type {
  DelegatedAction,
  DelegatedPlatformId,
  DelegatedTaskStatus,
  DelegatedExecutionTarget,
  DelegatedTaskPriority,
  DelegatedTaskSource,
  DelegatedApprovalMode,
  DelegatedScheduleMode,
  DelegatedActionFamily,
  JsonPrimitive,
  JsonValue,
  TaskConstraints,
  DelegatedTaskProgress,
  DelegatedTerminalOutcome,
  DelegatedTask,
  DelegatedTaskIntent,
  DelegatedVerificationKind,
  DelegatedAttemptStatus,
  DelegatedTaskAttempt,
} from '../kernel/delegated-task-types.js';

// 状态全集字面数组 DELEGATED_TASK_STATUSES 与纯归一 clampClientApprovalMode 抬入 kernel
// （change decouple-longtail-sweep），供 api 侧面板 / 客户端鉴权跨边界共导；本文件等值再导出，令既有消费方无感。
export { DELEGATED_TASK_STATUSES, clampClientApprovalMode } from '../kernel/delegated-task-types.js';

export const DELEGATED_EXECUTION_TARGETS = DEPLOYMENT_TARGETS;

/** Strict fail-closed parser for the existing Cloud deployment fact source. */
export function parseDelegatedExecutionTarget(value: unknown): DelegatedExecutionTarget | null {
  return parseDeploymentTarget(value);
}

const TERMINAL_STATUSES = new Set<DelegatedTaskStatus>([
  'partially_completed',
  'completed',
  'cancelled',
  'failed',
]);

const TRANSITIONS: Record<DelegatedTaskStatus, ReadonlySet<DelegatedTaskStatus>> = {
  draft: new Set(['awaiting_confirmation', 'cancelled']),
  awaiting_confirmation: new Set(['queued', 'cancelled', 'failed']),
  queued: new Set(['planning', 'deferred', 'partially_completed', 'cancelled', 'failed']),
  planning: new Set(['queued', 'waiting_approval', 'executing', 'deferred', 'partially_completed', 'completed', 'cancelled', 'failed']),
  waiting_approval: new Set(['planning', 'queued', 'executing', 'deferred', 'partially_completed', 'cancelled', 'failed', 'completed']),
  executing: new Set(['queued', 'waiting_approval', 'deferred', 'partially_completed', 'completed', 'cancelled', 'failed']),
  deferred: new Set(['queued', 'cancelled', 'failed', 'partially_completed']),
  partially_completed: new Set(),
  completed: new Set(),
  cancelled: new Set(),
  failed: new Set(),
};

export function isTerminalTaskStatus(status: DelegatedTaskStatus): boolean {
  return TERMINAL_STATUSES.has(status);
}

export function canTransitionTask(from: DelegatedTaskStatus, to: DelegatedTaskStatus): boolean {
  return from === to || TRANSITIONS[from].has(to);
}

export function assertTaskTransition(from: DelegatedTaskStatus, to: DelegatedTaskStatus): void {
  if (!canTransitionTask(from, to)) throw new Error(`invalid_task_transition:${from}->${to}`);
}

export function actionFamilyFor(action: DelegatedAction): DelegatedActionFamily {
  switch (action) {
    case 'comment_batch':
    case 'comment_curated':
    case 'facebook_group_comment':
      return 'comment';
    case 'publish_post':
    case 'publish_from_inspiration':
    case 'generate_candidates':
      return 'publish';
    case 'approve_candidate':
    case 'reject_candidate':
    case 'modify_candidate':
      return 'candidate_control';
  }
}

/**
 * change delegated-approvalmode-clamp：客户端请求体（panel / edge 建草稿路由）的 approvalMode 不可信——
 * **绝不放行 `auto_approve`**，否则结构化入口可自带免审、把内容审批两道闸全绕过（免审本应只由账号级后台开关授予）。
 * 规则：缺省保持 undefined（交由 store 按 action 取默认，如 generate_candidates → draft_only）；显式 `draft_only`
 * 放行（仅生成候选、不落平台）；其余（含 `auto_approve` 与任何未来新模式）一律夹成 `review`。
 * 服务端自建 intent（如洗稿 curated 调用已显式传 `review`、飞书 parser 已硬编码 `review`）不经此路、不受影响。
 */
// clampClientApprovalMode 已抬入 kernel 并于本文件顶部等值再导出（change decouple-longtail-sweep）。

export function validateDelegatedTaskIntent(intent: DelegatedTaskIntent, now = Date.now()): string[] {
  const errors: string[] = [];
  if (!Number.isInteger(intent.targetSuccessCount) || intent.targetSuccessCount < 1) errors.push('invalid_target_success_count');
  if (!Number.isInteger(intent.maxAttempts) || intent.maxAttempts < intent.targetSuccessCount) errors.push('invalid_max_attempts');
  if (!Number.isFinite(intent.deadlineAt) || intent.deadlineAt <= now) errors.push('invalid_deadline');
  if (intent.notBefore !== undefined && (!Number.isFinite(intent.notBefore) || intent.notBefore > intent.deadlineAt)) {
    errors.push('invalid_not_before');
  }
  if (intent.accountId !== undefined && !intent.accountId.trim()) errors.push('invalid_account_id');
  if (intent.accountName !== undefined && !intent.accountName.trim()) errors.push('invalid_account_name');
  if (intent.source === 'feishu' && !intent.accountName?.trim()) errors.push('feishu_account_name_required');
  if (intent.action === 'comment_curated' && !String(intent.targetConstraints?.curatedId ?? '').trim()) {
    errors.push('curated_target_required');
  }
  if (
    (intent.action === 'approve_candidate' || intent.action === 'reject_candidate' || intent.action === 'modify_candidate') &&
    !String(intent.targetConstraints?.candidateId ?? '').trim()
  ) {
    errors.push('candidate_target_required');
  }
  return errors;
}

export function honestTerminalStatus(
  progress: DelegatedTaskProgress,
  reason: 'goal' | 'deadline' | 'max_attempts' | 'cancelled' | 'failure',
): DelegatedTaskStatus {
  if (progress.successCount > 0 && reason !== 'goal') return 'partially_completed';
  if (reason === 'goal') return 'completed';
  if (reason === 'cancelled') return 'cancelled';
  return 'failed';
}

export function isVerifiedSuccessKind(kind: DelegatedVerificationKind): boolean {
  return kind === 'platform_comment_confirmed' || kind === 'platform_publish_confirmed' ||
    kind === 'platform_schedule_confirmed' ||
    kind === 'candidate_persisted' || kind === 'candidate_version_updated';
}

export function verificationCountsAsSuccess(action: DelegatedAction, kind: DelegatedVerificationKind): boolean {
  switch (kind) {
    case 'platform_comment_confirmed':
      return action === 'comment_batch' || action === 'comment_curated' || action === 'facebook_group_comment';
    case 'platform_publish_confirmed':
      return action === 'publish_post' || action === 'publish_from_inspiration' || action === 'approve_candidate';
    case 'platform_schedule_confirmed':
      return action === 'publish_post' || action === 'publish_from_inspiration' || action === 'approve_candidate';
    case 'candidate_persisted':
      return action === 'generate_candidates';
    case 'candidate_version_updated':
      return action === 'approve_candidate' || action === 'reject_candidate' || action === 'modify_candidate';
    case 'submitted_unknown':
    case 'not_dispatched':
    case 'not_started':
      return false;
  }
}
