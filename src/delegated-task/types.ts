import type { PlatformId, DelegatedAction } from '../platform/index.js';

export type { DelegatedAction };
export type DelegatedPlatformId = Exclude<PlatformId, 'wechat_channels'>;

export const DELEGATED_TASK_STATUSES = [
  'draft',
  'awaiting_confirmation',
  'queued',
  'planning',
  'waiting_approval',
  'executing',
  'partially_completed',
  'completed',
  'deferred',
  'cancelled',
  'failed',
] as const;

export type DelegatedTaskStatus = (typeof DELEGATED_TASK_STATUSES)[number];
export type DelegatedTaskPriority = 'normal' | 'high';
export type DelegatedTaskSource = 'feishu' | 'edge' | 'console' | 'api' | 'legacy_command';
export type DelegatedApprovalMode = 'review' | 'auto_approve' | 'draft_only';
export type DelegatedScheduleMode = 'immediate' | 'at_time' | 'next_safe_slot';
export type DelegatedActionFamily = 'comment' | 'publish' | 'candidate_control';

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type TaskConstraints = Record<string, JsonValue>;

export interface DelegatedTaskProgress {
  successCount: number;
  attemptCount: number;
  skippedCount: number;
  failureCount: number;
}

export interface DelegatedTerminalOutcome {
  code: string;
  message: string;
  evidenceRef?: string;
  submittedUnknown?: boolean;
  remainingCount?: number;
}

export interface DelegatedTask {
  id: string;
  accountId: string;
  accountName: string;
  platform: DelegatedPlatformId;
  action: DelegatedAction;
  actionFamily: DelegatedActionFamily;
  targetSuccessCount: number;
  maxAttempts: number;
  deadlineAt: number;
  notBefore: number;
  executionWindow: { mode: DelegatedScheduleMode; startAt?: number; endAt?: number };
  sourceConstraints: TaskConstraints;
  targetConstraints: TaskConstraints;
  approvalMode: DelegatedApprovalMode;
  priority: DelegatedTaskPriority;
  source: DelegatedTaskSource;
  sourceRef: string | null;
  /**
   * 命令来源会话（飞书 `chatId`）。change restore-delegated-command-card-origin-chat：
   * 与偏向 messageId、参与去重键的 `sourceRef` 解耦，专职操作员向卡片（审批卡 / 终态结果卡）的投递目标。
   * 命令触发（私聊 / 群）→ 该会话；非飞书入口（console/api/edge）→ null → 回落既有默认 / 团队路由。
   */
  originChatId: string | null;
  status: DelegatedTaskStatus;
  progress: DelegatedTaskProgress;
  currentStep: string | null;
  terminalOutcome: DelegatedTerminalOutcome | null;
  pauseRequested: boolean;
  cancelRequested: boolean;
  nextEligibleAt: number | null;
  claimToken: string | null;
  claimExpiresAt: number | null;
  dedupeKey: string;
  version: number;
  createdAt: number;
  updatedAt: number;
  confirmedAt: number | null;
  completedAt: number | null;
}

export interface DelegatedTaskIntent {
  accountId?: string;
  accountName?: string;
  platform?: PlatformId;
  action: DelegatedAction;
  targetSuccessCount: number;
  maxAttempts: number;
  deadlineAt: number;
  notBefore?: number;
  executionWindow?: { mode: DelegatedScheduleMode; startAt?: number; endAt?: number };
  sourceConstraints?: TaskConstraints;
  targetConstraints?: TaskConstraints;
  approvalMode?: DelegatedApprovalMode;
  priority?: DelegatedTaskPriority;
  source: DelegatedTaskSource;
  sourceRef?: string;
  /** 命令来源会话（飞书 chatId）；仅命令入口带值，其余入口缺省 → 回落既有路由。 */
  originChatId?: string;
}

export type DelegatedVerificationKind =
  | 'platform_comment_confirmed'
  | 'platform_publish_confirmed'
  | 'candidate_persisted'
  | 'candidate_version_updated'
  | 'submitted_unknown'
  | 'not_dispatched';

export type DelegatedAttemptStatus =
  | 'prepared'
  | 'dispatched'
  | 'succeeded'
  | 'skipped'
  | 'failed'
  | 'submitted_unknown';

export interface DelegatedTaskAttempt {
  id: string;
  taskId: string;
  ordinal: number;
  targetKey: string;
  status: DelegatedAttemptStatus;
  verificationKind: DelegatedVerificationKind | null;
  evidenceRef: string | null;
  reason: string | null;
  preparedAt: number;
  dispatchedAt: number | null;
  finishedAt: number | null;
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
    kind === 'candidate_persisted' || kind === 'candidate_version_updated';
}

export function verificationCountsAsSuccess(action: DelegatedAction, kind: DelegatedVerificationKind): boolean {
  switch (kind) {
    case 'platform_comment_confirmed':
      return action === 'comment_batch' || action === 'comment_curated' || action === 'facebook_group_comment';
    case 'platform_publish_confirmed':
      return action === 'publish_post' || action === 'publish_from_inspiration' || action === 'approve_candidate';
    case 'candidate_persisted':
      return action === 'generate_candidates';
    case 'candidate_version_updated':
      return action === 'approve_candidate' || action === 'reject_candidate' || action === 'modify_candidate';
    case 'submitted_unknown':
    case 'not_dispatched':
      return false;
  }
}
