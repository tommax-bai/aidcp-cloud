import type {
  PublishApprovalActionPayload,
  PublishApprovalActionResultPayload,
} from '../comm/protocol.js';
import type { DispatchDraft, EditDraftPatch, EditDraftResult } from './publish-log-store.js';
import { normalizePlatformId } from '../platform/index.js';
import { validatePublishSchedule } from './schedule-policy.js';

interface ApprovalSnapshot {
  approved: boolean;
  contentVersion: number;
}

interface ApprovalWriteResult {
  written: boolean;
  alreadyDecided?: boolean;
}

export interface ClientPublishApprovalDeps {
  loadDraft(recordId: number): Promise<DispatchDraft | null>;
  readApproval(requestId: string): Promise<ApprovalSnapshot | null>;
  editDraft(
    recordId: number,
    expectedVersion: number,
    patch: EditDraftPatch,
    editor: string,
  ): Promise<EditDraftResult>;
  preflight(requestId: string): Promise<{ ok: true } | { ok: false; reason: string }>;
  writeApproval(
    requestId: string,
    approved: boolean,
    payload: { title: string; content: string; tags: string[]; contentVersion: number },
  ): Promise<ApprovalWriteResult>;
  triggerApproved(requestId: string): void;
  notifyRejected(requestId: string): void;
  clock?: () => number;
}

function explicitPlan(payload: PublishApprovalActionPayload):
  | { mode: 'immediate' | 'scheduled'; publishTime: number | null }
  | null
  | 'invalid' {
  const hasMode = payload.publishMode !== undefined;
  const hasTime = payload.publishTime !== undefined;
  if (!hasMode && !hasTime) return null;
  if (!hasMode || !hasTime) return 'invalid';
  if (payload.publishMode === 'immediate' && payload.publishTime === null) {
    return { mode: 'immediate', publishTime: null };
  }
  if (payload.publishMode === 'scheduled' && typeof payload.publishTime === 'number' && Number.isFinite(payload.publishTime)) {
    return { mode: 'scheduled', publishTime: payload.publishTime };
  }
  return 'invalid';
}

function currentPlan(draft: DispatchDraft): { mode: 'immediate' | 'scheduled' | 'draft'; publishTime: number | null } {
  const mode = draft.metadata?.mode === 'scheduled' || draft.metadata?.mode === 'draft'
    ? draft.metadata.mode
    : 'immediate';
  const publishTime = mode === 'scheduled' && Number.isFinite(draft.metadata?.publishTime)
    ? draft.metadata!.publishTime
    : null;
  return { mode, publishTime };
}

/**
 * The approval signal is bound to the version produced by the schedule CAS.
 * Renderer and main-process checks are fast feedback only; this is the authority boundary.
 */
export function createClientPublishApprovalHandler(deps: ClientPublishApprovalDeps) {
  const clock = deps.clock ?? Date.now;
  return async (
    payload: PublishApprovalActionPayload,
    accountId: string | null | undefined,
  ): Promise<PublishApprovalActionResultPayload> => {
    const requestId = typeof payload?.requestId === 'string' ? payload.requestId : '';
    const match = /^publish-(\d+)$/.exec(requestId);
    if (!match || typeof payload?.approved !== 'boolean') {
      return { requestId, ok: false, reason: 'invalid_request' };
    }
    if (!accountId) return { requestId, ok: false, reason: 'account_unavailable' };
    if (!payload.approved && (payload.publishMode !== undefined || payload.publishTime !== undefined)) {
      return { requestId, ok: false, reason: 'invalid_request' };
    }

    const recordId = Number(match[1]);
    let draft = await deps.loadDraft(recordId).catch(() => null);
    if (!draft) return { requestId, ok: false, reason: 'not_found' };
    if (draft.accountId !== accountId) return { requestId, ok: false, reason: 'account_mismatch' };

    const existing = await deps.readApproval(requestId);
    if (existing) {
      if (existing.approved !== payload.approved) return { requestId, ok: false, reason: 'already_decided' };
      if (existing.approved) deps.triggerApproved(requestId);
      return {
        requestId,
        ok: true,
        state: existing.approved ? 'approved' : 'rejected',
        alreadyDecided: true,
        currentVersion: existing.contentVersion,
      };
    }
    if (draft.status !== 'pending_approval') return { requestId, ok: false, reason: 'not_pending' };

    if (payload.approved) {
      const requestedVersion = Number.isInteger(payload.contentVersion) ? Number(payload.contentVersion) : 0;
      if (requestedVersion !== draft.contentVersion) {
        return { requestId, ok: false, reason: 'version_stale', currentVersion: draft.contentVersion };
      }

      const requestedPlan = explicitPlan(payload);
      if (requestedPlan === 'invalid') return { requestId, ok: false, reason: 'invalid_publish_plan' };
      if (requestedPlan) {
        const scheduleError = validatePublishSchedule(
          normalizePlatformId(draft.platform),
          requestedPlan.mode,
          requestedPlan.publishTime,
          clock(),
        );
        if (scheduleError) return { requestId, ok: false, reason: scheduleError };

        const preflight = await deps.preflight(requestId);
        if (!preflight.ok) return { requestId, ok: false, reason: preflight.reason };

        const storedPlan = currentPlan(draft);
        const changed = storedPlan.mode !== requestedPlan.mode || storedPlan.publishTime !== requestedPlan.publishTime;
        if (changed) {
          const edit = await deps.editDraft(
            recordId,
            requestedVersion,
            { publishMode: requestedPlan.mode, publishTime: requestedPlan.publishTime },
            'client',
          );
          if (!edit.ok) {
            if (edit.reason === 'version_conflict') {
              const live = await deps.loadDraft(recordId).catch(() => null);
              return { requestId, ok: false, reason: 'version_stale', currentVersion: live?.contentVersion };
            }
            return {
              requestId,
              ok: false,
              reason: edit.reason === 'not_found' || edit.reason === 'not_pending'
                ? edit.reason
                : 'schedule_update_rejected',
            };
          }
          draft = {
            ...draft,
            title: edit.title,
            content: edit.content,
            metadata: edit.metadata,
            imageUrls: edit.images,
            imageUrl: edit.images[0] ?? null,
            contentVersion: edit.contentVersion,
          };
        }
      } else {
        const preflight = await deps.preflight(requestId);
        if (!preflight.ok) return { requestId, ok: false, reason: preflight.reason };
      }
    }

    const tags = Array.isArray(draft.metadata?.topics)
      ? draft.metadata.topics.filter((topic): topic is string => typeof topic === 'string')
      : [];
    const result = await deps.writeApproval(requestId, payload.approved, {
      title: draft.title ?? '',
      content: draft.content,
      tags,
      contentVersion: draft.contentVersion,
    });
    if (!result.written) {
      if (result.alreadyDecided !== payload.approved) return { requestId, ok: false, reason: 'already_decided' };
      if (payload.approved) deps.triggerApproved(requestId);
      return {
        requestId,
        ok: true,
        state: payload.approved ? 'approved' : 'rejected',
        alreadyDecided: true,
        currentVersion: draft.contentVersion,
      };
    }
    if (payload.approved) deps.triggerApproved(requestId);
    else deps.notifyRejected(requestId);
    return {
      requestId,
      ok: true,
      state: payload.approved ? 'approved' : 'rejected',
      currentVersion: draft.contentVersion,
    };
  };
}
