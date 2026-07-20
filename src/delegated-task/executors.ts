import type { CommentTerminalObservation } from '../comment-agent/comment-scheduler.js';
import type { TargetedCommentResult } from '../comment-agent/comment-task-runner.js';
import type { TriggerOutcome } from '../publish-agent/publish-scheduler.js';
import type { ReferenceNote } from '../publish-agent/publish-scheduler.js';
import type { ReferenceImageSnapshot } from '../publish-agent/types.js';
import type { DelegatedTaskExecutor, DelegatedExecutionResult } from './worker.js';
import type { DelegatedTask } from './types.js';
import { delegatedRewriteSourceId } from './ownership.js';
import { normalizeTextCardTranscription } from '../cache/curated-content-store.js';

export interface DelegatedCommentPort {
  triggerManual(
    accountId: string,
    options: {
      priority: 'automatic' | 'human';
      manualOverride: boolean;
      force: boolean;
      injectContact?: boolean;
      approvalMode: 'review' | 'auto_approve';
      joinFirst?: boolean;
      joinGroupUrl?: string;
      fastReturnToFeed?: boolean;
      /**
       * change unify-card-routing-origin-then-team：命令来源会话，透传成评论审批卡 + 终态结果卡的目标。
       * 与 DelegatedPublishPort.manualApprovalChatId 对称。缺省 → 补集回落账号团队群 → 默认群。
       */
      originChatId?: string;
      onResult: (result: CommentTerminalObservation) => Promise<void> | void;
    },
  ): Promise<{ ok: boolean; message: string; code?: string }>;
  triggerTargeted(
    accountId: string,
    target: { noteId: string; title: string },
    options: {
      priority: 'automatic';
      approvalMode: 'review' | 'auto_approve';
      /** change unify-card-routing-origin-then-team：同 triggerManual，命令来源会话透传成卡片目标。 */
      originChatId?: string;
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
      /** change delegated-executor-operator-authority-parity：仅精确 /publish 命令置 true，越风控保人审。 */
      operatorOverride?: boolean;
      /** 精确手工 /publish 的 Edge 租约保持 human；审批等待后仍不得退化成 automatic。 */
      edgeLeasePriority?: 'human';
    },
  ): Promise<TriggerOutcome>;
  isBusy(accountId?: string): boolean;
}

export interface CandidateSnapshot {
  recordId: number;
  accountId: string;
  platform: 'xiaohongshu' | 'facebook';
  status: 'draft' | 'pending_approval' | 'scheduled' | 'submitted' | 'published' | 'failed' | 'needs_review';
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
    patch: { title?: string; content?: string; images?: string[]; publishMode?: 'immediate' | 'scheduled'; publishTime?: number | null },
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

function commentResult(task: DelegatedTask, result: CommentTerminalObservation | TargetedCommentResult): DelegatedExecutionResult {
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
    return {
      kind: 'deferred',
      reason: result.reason ?? 'edge_task_not_started',
      retryAt: Date.now() + 30_000,
      // 加群评论可能已经完成入组、随后评论租约才失败；这种复合动作不能声称整轮零副作用。
      ...(task.action !== 'facebook_group_comment' ? { attemptStarted: false as const } : {}),
    };
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
  if (outcome.status === 'scheduled') {
    return { kind: 'success', verificationKind: 'platform_schedule_confirmed', evidenceRef: evidence };
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
    if (draft.status === 'scheduled') {
      return { kind: 'success', verificationKind: 'platform_schedule_confirmed', evidenceRef };
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

function parseCandidatePatch(
  task: DelegatedTask,
): { title?: string; content?: string; images?: string[]; publishMode?: 'immediate' | 'scheduled'; publishTime?: number | null } | null {
  const title = constraintString(task, 'title');
  const content = constraintString(task, 'content');
  const images = Array.isArray(task.targetConstraints.images) && task.targetConstraints.images.every((item) => typeof item === 'string')
    ? task.targetConstraints.images
    : undefined;
  const rawMode = task.targetConstraints.publishMode;
  const publishMode = rawMode === 'immediate' || rawMode === 'scheduled' ? rawMode : undefined;
  const rawPublishTime = task.targetConstraints.publishTime;
  const parsedPublishTime = typeof rawPublishTime === 'number'
    ? rawPublishTime
    : typeof rawPublishTime === 'string' && rawPublishTime.trim()
      ? Number(rawPublishTime)
      : rawPublishTime === null
        ? null
        : undefined;
  const publishTime = parsedPublishTime === null || Number.isFinite(parsedPublishTime) ? parsedPublishTime : undefined;
  if (title || content || images || publishMode || publishTime !== undefined) {
    return {
      ...(title ? { title } : {}),
      ...(content ? { content } : {}),
      ...(images ? { images } : {}),
      ...(publishMode ? { publishMode } : {}),
      ...(publishTime !== undefined ? { publishTime } : {}),
    };
  }
  const raw = constraintString(task, 'patch');
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as {
      title?: unknown;
      content?: unknown;
      publishMode?: unknown;
      publishTime?: unknown;
    };
    const out: {
      title?: string;
      content?: string;
      publishMode?: 'immediate' | 'scheduled';
      publishTime?: number | null;
    } = {
      ...(typeof parsed.title === 'string' && parsed.title.trim() ? { title: parsed.title.trim() } : {}),
      ...(typeof parsed.content === 'string' && parsed.content.trim() ? { content: parsed.content.trim() } : {}),
      ...(parsed.publishMode === 'immediate' || parsed.publishMode === 'scheduled' ? { publishMode: parsed.publishMode } : {}),
      ...(parsed.publishTime === null || (typeof parsed.publishTime === 'number' && Number.isFinite(parsed.publishTime))
        ? { publishTime: parsed.publishTime }
        : {}),
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
  const textCardTranscription = useReferenceImages
    ? normalizeTextCardTranscription(task.sourceConstraints.textCardTranscription)
    : undefined;
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
    ...(textCardTranscription ? { textCardTranscription } : {}),
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
    task: DelegatedTask,
    trigger: (onResult: (result: CommentTerminalObservation | TargetedCommentResult) => void) => Promise<{ ok: boolean; message: string; code?: string; reason?: string }>,
  ): Promise<DelegatedExecutionResult> => {
    let timer: NodeJS.Timeout | undefined;
    const terminal = new Promise<CommentTerminalObservation | TargetedCommentResult>((resolve, reject) => {
      timer = setTimeout(() => reject(new Error('comment_terminal_timeout')), terminalWaitMs);
      void trigger(resolve).then((receipt) => {
        if (receipt.ok) return;
        if (receipt.code === 'edge_offline' || receipt.reason === 'running') {
          // 触发器明确在任何后台任务/浏览器动作之前拒绝；可以安全归还尝试预算。
          reject(new Error(`deferred_not_started:${receipt.code ?? receipt.reason}`));
        } else {
          // 起跑前触发闸失败（人设未绑 / 联系方式缺 / 非 FB 带 --join / FB 未接线 / 平台画像失败）：
          // 携带人类可读文案（message 优先），供委托层补一张诚实失败卡（红线：绝不静默失败）。
          reject(new Error(`not_started:${receipt.message ?? receipt.reason ?? receipt.code}`));
        }
      }).catch(reject);
    });
    try {
      return commentResult(task, await terminal);
    } catch (err) {
      const message = (err as Error).message;
      if (message.startsWith('deferred_not_started:')) {
        return { kind: 'deferred', reason: message.slice('deferred_not_started:'.length), retryAt: now() + 30_000, attemptStarted: false };
      }
      if (message === 'comment_terminal_timeout') {
        return { kind: 'submitted_unknown', reason: '评论任务已触发但未在时限内收到终态；为防重复不自动重试。' };
      }
      // 触发闸失败＝永久性配置问题（人设 / 联系方式 / 平台不支持 / 未接线）：不重试、以非重试失败终结，
      // 由委托层在终态补一张诚实卡（评论链此时从未起跑、postResultCard 不会发）。
      if (message.startsWith('not_started:')) {
        return { kind: 'failed', reason: message.slice('not_started:'.length), retryable: false };
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
        return awaitComment(task, (onResult) => deps.comments.triggerManual(task.accountId, {
          priority: legacySingle ? 'human' : 'automatic',
          manualOverride: legacySingle,
          force: legacySingle && task.targetConstraints.force === true,
          fastReturnToFeed: legacySingle && task.targetConstraints.fastReturnToFeed === true,
          injectContact: task.targetConstraints.injectContact === true,
          approvalMode: commentApprovalMode(task),
          // 命令来源会话 → 审批卡与终态卡都回来源会话（私聊 / 群）；无来源会话 → 回落账号团队群 → 默认群。
          ...(task.originChatId ? { originChatId: task.originChatId } : {}),
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
        return awaitComment(task, (onResult) => deps.comments.triggerTargeted(task.accountId, { noteId, title }, {
          priority: 'automatic',
          approvalMode: commentApprovalMode(task),
          ...(task.originChatId ? { originChatId: task.originChatId } : {}),
          onResult,
        }));
      }
      if (
        task.action === 'publish_post' || task.action === 'publish_from_inspiration' ||
        task.action === 'generate_candidates'
      ) {
        const note = referenceNote(task);
        // 操作员全权白名单：①精确单次 slash；②仅由专用服务端入口创建、且形状完整的单篇精选洗稿。
        // 通用 edge/console/api 请求即使仿造精选字段也没有 operator_action 来源，不能借字段越风控/配额。
        const legacySingle = task.source === 'legacy_command' && task.targetSuccessCount === 1 &&
          task.targetConstraints.manualSingle === true;
        const operatorCuratedRewrite = task.source === 'operator_action' && task.action === 'publish_post' &&
          task.targetSuccessCount === 1 && typeof task.sourceConstraints.curatedId === 'number' &&
          Number.isInteger(task.sourceConstraints.curatedId) && task.sourceConstraints.curatedId > 0 && note !== undefined;
        const operatorOverride = legacySingle || operatorCuratedRewrite;
        return publishResult(task, await deps.publishes.triggerDelegated(task.accountId, {
          action: task.action,
          approvalMode: approvalMode(task),
          ...(operatorOverride ? { operatorOverride: true } : {}),
          ...(legacySingle ? { edgeLeasePriority: 'human' as const } : {}),
          ...(note ? { referenceNote: note } : {}),
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
      if (draft.status === 'scheduled') {
        return { kind: 'success', verificationKind: 'platform_schedule_confirmed', evidenceRef: `publish:${draft.recordId}` };
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
        ? delegatedRewriteSourceId(task) === null && deps.publishes.isBusy(task.accountId)
        : false,
  };
}
