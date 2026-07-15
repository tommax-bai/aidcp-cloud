import type { CommentTerminalObservation } from '../comment-agent/comment-scheduler.js';
import type { TargetedCommentResult } from '../comment-agent/comment-task-runner.js';
import type { TriggerOutcome } from '../publish-agent/publish-scheduler.js';
import type { ReferenceNote } from '../publish-agent/publish-scheduler.js';
import type { ReferenceImageSnapshot } from '../publish-agent/types.js';
import type { DelegatedTaskExecutor, DelegatedExecutionResult } from './worker.js';
import type { DelegatedTask } from './types.js';

export interface DelegatedCommentPort {
  triggerManual(
    accountId: string,
    options: {
      priority: 'automatic' | 'human';
      manualOverride: boolean;
      force: boolean;
      approvalMode: 'review' | 'auto_approve';
      joinFirst?: boolean;
      joinGroupUrl?: string;
      onResult: (result: CommentTerminalObservation) => Promise<void> | void;
    },
  ): Promise<{ ok: boolean; message: string; code?: string }>;
  triggerTargeted(
    accountId: string,
    target: { noteId: string; title: string },
    options: {
      priority: 'automatic';
      approvalMode: 'review' | 'auto_approve';
      onResult: (result: TargetedCommentResult) => Promise<void> | void;
    },
  ): Promise<{ ok: boolean; message: string; reason?: string }>;
  isRunning(accountId: string): boolean;
}

export interface DelegatedPublishPort {
  triggerDelegated(
    accountId: string,
    opts: {
      action: 'publish_post' | 'publish_from_inspiration' | 'generate_candidates';
      approvalMode?: 'review' | 'auto_approve' | 'draft_only';
      referenceNote?: ReferenceNote;
      /**
       * change restore-delegated-command-card-origin-chat：命令来源会话，透传成审批卡目标（manual_source）。
       * 缺省 → 审批卡回落默认审批群（既有行为、零回归）。
       */
      manualApprovalChatId?: string;
    },
  ): Promise<TriggerOutcome>;
  isBusy(accountId?: string): boolean;
}

export interface CandidateSnapshot {
  recordId: number;
  accountId: string;
  platform: 'xiaohongshu' | 'facebook';
  status: 'draft' | 'pending_approval' | 'submitted' | 'published' | 'failed' | 'needs_review';
  contentVersion: number;
  title: string | null;
  content: string;
  images: string[];
}

export interface DelegatedExecutorDeps {
  comments: DelegatedCommentPort;
  publishes: DelegatedPublishPort;
  loadCandidate: (recordId: number) => Promise<CandidateSnapshot | null>;
  approveCandidate: (draft: CandidateSnapshot) => Promise<CandidateSnapshot | null>;
  rejectCandidate: (draft: CandidateSnapshot) => Promise<CandidateSnapshot | null>;
  modifyCandidate: (
    draft: CandidateSnapshot,
    patch: { title?: string; content?: string; images?: string[] },
  ) => Promise<CandidateSnapshot | null>;
  terminalWaitMs?: number;
  now?: () => number;
}

function constraintString(task: DelegatedTask, key: string): string | null {
  const value = task.targetConstraints[key];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function constraintNumber(task: DelegatedTask, key: string): number | null {
  const value = task.targetConstraints[key];
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  return Number.isInteger(n) ? n : null;
}

function approvalMode(task: DelegatedTask): 'review' | 'auto_approve' | 'draft_only' {
  return task.approvalMode;
}

function commentApprovalMode(task: DelegatedTask): 'review' | 'auto_approve' {
  return task.approvalMode === 'auto_approve' ? 'auto_approve' : 'review';
}

function commentResult(result: CommentTerminalObservation | TargetedCommentResult): DelegatedExecutionResult {
  if (result.outcome === 'commented') {
    const noteId = 'noteId' in result ? result.noteId : undefined;
    const container = 'container' in result ? result.container : undefined;
    return {
      kind: 'success',
      verificationKind: 'platform_comment_confirmed',
      evidenceRef: noteId ? `comment:${noteId}` : container ? `facebook-comment:${container}` : 'comment:platform-confirmed',
    };
  }
  if (result.outcome === 'not_started') {
    return { kind: 'deferred', reason: result.reason ?? 'edge_task_not_started', retryAt: Date.now() + 30_000 };
  }
  if (result.outcome === 'verification_ambiguous') {
    return { kind: 'submitted_unknown', reason: result.reason ?? 'comment_submission_unverified' };
  }
  // 7.6（change lease-strict-preemption）：XHS 提交已派发但未确认——与 FB 的 verification_ambiguous 同义：
  // 评论可能已发出、去重账本已写 → MUST 终结为「已提交未知」、**绝不重试**（否则 worker 重入 → 重复评论，--force 更甚）。
  if (result.outcome === 'submitted_unconfirmed') {
    return { kind: 'submitted_unknown', reason: result.reason ?? 'comment_submitted_unconfirmed' };
  }
  // 提交前被抢占：未发出、未写去重 → 重试安全，但退避 30s（不立刻对着仍被占用的浏览器空转）。
  if (result.outcome === 'preempted') {
    return { kind: 'deferred', reason: result.reason ?? 'comment_preempted', retryAt: Date.now() + 30_000 };
  }
  if (
    result.outcome === 'no_terms' || result.outcome === 'no_strong_candidate' || result.outcome === 'no_targets' ||
    result.outcome === 'compose_skipped' || result.outcome === 'shadow_ok' || result.outcome === 'note_not_found'
  ) {
    return { kind: 'skipped', reason: result.reason ?? result.outcome };
  }
  return { kind: 'failed', reason: result.reason ?? result.outcome, retryable: true };
}

function publishResult(task: DelegatedTask, outcome: TriggerOutcome): DelegatedExecutionResult {
  if (outcome.result === 'blocked') {
    if (/risk_|publish_capacity|publish_busy|already_running/.test(outcome.reason)) {
      return { kind: 'deferred', reason: outcome.reason, retryAt: Date.now() + 60_000 };
    }
    return { kind: 'failed', reason: outcome.reason, retryable: false };
  }
  if (outcome.result === 'skipped') return { kind: 'skipped', reason: outcome.reason };
  const evidence = outcome.recordId == null ? `publish-run:${outcome.reason}` : `publish:${outcome.recordId}`;
  if (outcome.status === 'published') {
    return { kind: 'success', verificationKind: 'platform_publish_confirmed', evidenceRef: evidence };
  }
  if (outcome.status === 'pending_approval' || outcome.status === 'draft') {
    if (outcome.recordId == null) return { kind: 'failed', reason: 'candidate_record_missing', retryable: false };
    if (task.action === 'generate_candidates') {
      return { kind: 'success', verificationKind: 'candidate_persisted', evidenceRef: evidence };
    }
    return { kind: 'waiting_approval', evidenceRef: evidence, reason: '候选稿已持久化，等待人工审批后发布。' };
  }
  if (outcome.status === 'submitted') {
    return { kind: 'submitted_unknown', reason: '稿件已提交但平台发布结果未确认', evidenceRef: evidence };
  }
  return { kind: 'failed', reason: outcome.failureReason ?? `publish_${outcome.status}`, retryable: true };
}

function candidateResult(task: DelegatedTask, draft: CandidateSnapshot | null): DelegatedExecutionResult {
  if (!draft) return { kind: 'failed', reason: 'candidate_not_found_after_write', retryable: false };
  if (draft.accountId !== task.accountId || draft.platform !== task.platform) {
    return { kind: 'failed', reason: 'candidate_account_or_platform_mismatch', retryable: false };
  }
  const evidenceRef = `publish:${draft.recordId}:v${draft.contentVersion}`;
  if (task.action === 'approve_candidate') {
    if (draft.status === 'published') {
      return { kind: 'success', verificationKind: 'platform_publish_confirmed', evidenceRef };
    }
    if (draft.status === 'submitted') {
      return { kind: 'submitted_unknown', reason: '候选稿已提交但平台结果未确认', evidenceRef };
    }
    if (draft.status === 'pending_approval') {
      return { kind: 'waiting_approval', evidenceRef, reason: '发布授权已记录，等待安全下发与平台验证。' };
    }
    return { kind: 'failed', reason: `candidate_approval_${draft.status}`, retryable: false };
  }
  const expectedStatus = task.action === 'reject_candidate' ? 'needs_review' : 'pending_approval';
  return draft.status === expectedStatus
    ? { kind: 'success', verificationKind: 'candidate_version_updated', evidenceRef }
    : { kind: 'failed', reason: `candidate_write_${draft.status}`, retryable: false };
}

function parseCandidatePatch(task: DelegatedTask): { title?: string; content?: string; images?: string[] } | null {
  const title = constraintString(task, 'title');
  const content = constraintString(task, 'content');
  const images = Array.isArray(task.targetConstraints.images) && task.targetConstraints.images.every((item) => typeof item === 'string')
    ? task.targetConstraints.images
    : undefined;
  if (title || content || images) return { ...(title ? { title } : {}), ...(content ? { content } : {}), ...(images ? { images } : {}) };
  const raw = constraintString(task, 'patch');
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as { title?: unknown; content?: unknown };
    const out = {
      ...(typeof parsed.title === 'string' && parsed.title.trim() ? { title: parsed.title.trim() } : {}),
      ...(typeof parsed.content === 'string' && parsed.content.trim() ? { content: parsed.content.trim() } : {}),
    };
    return Object.keys(out).length > 0 ? out : null;
  } catch {
    return { content: raw };
  }
}

function referenceNote(task: DelegatedTask): ReferenceNote | undefined {
  const sourceId = task.sourceConstraints.sourceId;
  const title = task.sourceConstraints.title;
  const body = task.sourceConstraints.body;
  if (typeof sourceId !== 'string' || typeof title !== 'string' || typeof body !== 'string' || !body.trim()) return undefined;
  const topics = Array.isArray(task.sourceConstraints.topics)
    ? task.sourceConstraints.topics.filter((item): item is string => typeof item === 'string')
    : [];
  const curatedId = task.sourceConstraints.curatedId;
  const author = task.sourceConstraints.author;
  const sourceUrl = task.sourceConstraints.sourceUrl;
  const useReferenceImages = task.sourceConstraints.useReferenceImages === true;
  const images = useReferenceImages && Array.isArray(task.sourceConstraints.referenceImages)
    ? task.sourceConstraints.referenceImages.filter((item) => {
        if (!item || typeof item !== 'object' || Array.isArray(item)) return false;
        const image = item as Record<string, unknown>;
        return Number.isInteger(image.index) && typeof image.sourceUrl === 'string' && image.sourceUrl.length > 0;
      }) as unknown as ReferenceImageSnapshot[]
    : [];
  return {
    sourceId,
    title,
    body,
    topics,
    ...(typeof curatedId === 'number' ? { curatedContentId: curatedId } : {}),
    accountId: task.accountId,
    ...(typeof author === 'string' && author ? { author } : {}),
    ...(typeof sourceUrl === 'string' ? { sourceUrl: sourceUrl || null } : {}),
    ...(images.length > 0 ? { images } : {}),
    capturedAt: task.createdAt,
  };
}

export function createDelegatedExecutorRouter(deps: DelegatedExecutorDeps): {
  executorFor(task: DelegatedTask): DelegatedTaskExecutor;
  externalBusy(task: DelegatedTask): boolean;
} {
  const now = deps.now ?? Date.now;
  const terminalWaitMs = Math.max(10_000, deps.terminalWaitMs ?? 4 * 60_000);

  const awaitComment = async (
    trigger: (onResult: (result: CommentTerminalObservation | TargetedCommentResult) => void) => Promise<{ ok: boolean; message: string; code?: string; reason?: string }>,
  ): Promise<DelegatedExecutionResult> => {
    let timer: NodeJS.Timeout | undefined;
    const terminal = new Promise<CommentTerminalObservation | TargetedCommentResult>((resolve, reject) => {
      timer = setTimeout(() => reject(new Error('comment_terminal_timeout')), terminalWaitMs);
      void trigger(resolve).then((receipt) => {
        if (receipt.ok) return;
        if (receipt.code === 'edge_offline' || receipt.reason === 'running') {
          reject(new Error(`deferred:${receipt.code ?? receipt.reason}`));
        } else {
          reject(new Error(`not_started:${receipt.reason ?? receipt.code ?? receipt.message}`));
        }
      }).catch(reject);
    });
    try {
      return commentResult(await terminal);
    } catch (err) {
      const message = (err as Error).message;
      if (message.startsWith('deferred:')) return { kind: 'deferred', reason: message, retryAt: now() + 30_000 };
      if (message === 'comment_terminal_timeout') {
        return { kind: 'submitted_unknown', reason: '评论任务已触发但未在时限内收到终态；为防重复不自动重试。' };
      }
      return { kind: 'failed', reason: message, retryable: true };
    } finally {
      if (timer) clearTimeout(timer);
    }
  };

  const executor: DelegatedTaskExecutor = {
    targetKey(task) {
      const candidateId = constraintString(task, 'candidateId');
      if (candidateId) return `candidate:${candidateId}:v${constraintNumber(task, 'candidateVersion') ?? 'unknown'}`;
      const curatedId = constraintString(task, 'curatedId');
      if (curatedId) return `curated:${curatedId}`;
      return `${task.action}:attempt:${task.progress.attemptCount + 1}`;
    },

    async execute(task, _attempt) {
      if (task.action === 'comment_batch' || task.action === 'facebook_group_comment') {
        const legacySingle = task.source === 'legacy_command' && task.targetSuccessCount === 1 &&
          task.targetConstraints.manualSingle === true;
        return awaitComment((onResult) => deps.comments.triggerManual(task.accountId, {
          priority: legacySingle ? 'human' : 'automatic',
          manualOverride: legacySingle,
          force: legacySingle && task.targetConstraints.force === true,
          approvalMode: commentApprovalMode(task),
          ...(task.action === 'facebook_group_comment' ? {
            joinFirst: true,
            ...(constraintString(task, 'groupUrl') ? { joinGroupUrl: constraintString(task, 'groupUrl')! } : {}),
          } : {}),
          onResult,
        }));
      }
      if (task.action === 'comment_curated') {
        const noteId = constraintString(task, 'noteId');
        const title = constraintString(task, 'title');
        if (!noteId || !title) return { kind: 'failed', reason: 'curated_target_snapshot_missing', retryable: false };
        return awaitComment((onResult) => deps.comments.triggerTargeted(task.accountId, { noteId, title }, {
          priority: 'automatic', approvalMode: commentApprovalMode(task), onResult,
        }));
      }
      if (
        task.action === 'publish_post' || task.action === 'publish_from_inspiration' ||
        task.action === 'generate_candidates'
      ) {
        return publishResult(task, await deps.publishes.triggerDelegated(task.accountId, {
          action: task.action,
          approvalMode: approvalMode(task),
          ...(referenceNote(task) ? { referenceNote: referenceNote(task)! } : {}),
          // 命令来源会话 → 审批卡回来源会话（私聊 / 群）；无来源会话 → 回落默认审批群。
          ...(task.originChatId ? { manualApprovalChatId: task.originChatId } : {}),
        }));
      }

      const recordId = constraintNumber(task, 'candidateId');
      const expectedVersion = constraintNumber(task, 'candidateVersion');
      if (recordId === null || expectedVersion === null) {
        return { kind: 'failed', reason: 'candidate_id_or_version_missing', retryable: false };
      }
      const before = await deps.loadCandidate(recordId);
      if (!before || before.accountId !== task.accountId || before.platform !== task.platform) {
        return { kind: 'failed', reason: 'candidate_not_found_or_mismatch', retryable: false };
      }
      if (before.contentVersion !== expectedVersion) {
        return { kind: 'failed', reason: `candidate_version_conflict(current=${before.contentVersion})`, retryable: false };
      }
      if (task.action === 'approve_candidate') {
        try {
          return candidateResult(task, await deps.approveCandidate(before));
        } catch (err) {
          const reason = (err as Error).message;
          if (reason.startsWith('candidate_deferred:')) {
            return { kind: 'deferred', reason, retryAt: now() + 30_000 };
          }
          return { kind: 'failed', reason, retryable: false };
        }
      }
      if (task.action === 'reject_candidate') return candidateResult(task, await deps.rejectCandidate(before));
      const patch = parseCandidatePatch(task);
      if (!patch) return { kind: 'failed', reason: 'candidate_patch_missing', retryable: false };
      return candidateResult(task, await deps.modifyCandidate(before, patch));
    },

    async reconcileAttempt(_task, attempt) {
      return {
        kind: 'submitted_unknown',
        reason: `派发账本 ${attempt.id} 在进程重启前未收敛；缺少可安全证明未提交的证据，为防重复停止重试。`,
      };
    },

    async reconcileWaitingApproval(task) {
      const evidence = task.terminalOutcome?.evidenceRef;
      const match = evidence ? /^publish:(\d+)/.exec(evidence) : null;
      if (!match) return { kind: 'waiting_approval', evidenceRef: evidence ?? '', reason: '等待审批证据回读。' };
      const draft = await deps.loadCandidate(Number(match[1]));
      if (!draft) return { kind: 'failed', reason: 'candidate_missing_during_reconcile', retryable: false };
      if (draft.status === 'published') {
        return { kind: 'success', verificationKind: 'platform_publish_confirmed', evidenceRef: `publish:${draft.recordId}` };
      }
      if (draft.status === 'submitted') {
        return { kind: 'submitted_unknown', reason: '候选已提交但平台结果未确认', evidenceRef: `publish:${draft.recordId}` };
      }
      if (draft.status === 'pending_approval') {
        return { kind: 'waiting_approval', evidenceRef: `publish:${draft.recordId}`, reason: '仍在等待人工审批。' };
      }
      return { kind: 'failed', reason: `candidate_terminal_${draft.status}`, retryable: false };
    },
  };

  return {
    executorFor: () => executor,
    externalBusy: (task) => task.actionFamily === 'comment'
      ? deps.comments.isRunning(task.accountId)
      : task.actionFamily === 'publish'
        ? deps.publishes.isBusy(task.accountId)
        : false,
  };
}
