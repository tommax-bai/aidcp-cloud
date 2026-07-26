/**
 * API-owned publish approval authority 的 owner adapter 与 automation-facing client。
 *
 * - owner adapter 是唯一可直接调用 `PublishApprovalStore` 的边界；
 * - automation client 只依赖 kernel port，可由进程内 adapter 或真实 HTTP client 承载；
 * - 所有状态写必须携带 expected revision + execution target，零行更新必须区分
 *   not-found、revision conflict 与 state conflict。
 */

import { parseDeploymentTarget, type DeploymentTarget } from '../deployment-target.js';
import {
  APPROVAL_DECIDED_VIA,
  APPROVAL_BLOCKED_REASONS,
  ApprovalUnreadableError,
  PublishApprovalAuthorityError,
  PublishApprovalDecisionWriterError,
  type ApprovalBlockedReason,
  type ApprovalDispatchState,
  type ApprovalVoidReason,
  type PublishApprovalAuthorityPort,
  type PublishApprovalDecisionWriteInput,
  type PublishApprovalDecisionWriterPort,
  type PublishApprovalListInput,
  type PublishApprovalReadInput,
  type PublishApprovalRevisionInput,
  type PublishApprovalView,
  type ReleasePublishApprovalInput,
  type SetPublishApprovalBlockedReasonInput,
  type VoidPublishApprovalInput,
} from '../kernel/publish-approval-contract.js';
import type { PublishApprovalPayload } from '../kernel/feishu-card-contract.js';
import {
  ApprovalExecutionTargetError,
  isApprovalVoidReason,
  type ApprovalDecisionRow,
  type PublishApprovalStore,
} from './publish-approval-store.js';
import type { ApprovalWriteOutlet } from './publish-approval-outlet.js';

export type { PublishApprovalAuthorityPort, PublishApprovalView };

function normalizeDecisionPayload(value: unknown): PublishApprovalPayload {
  if (!value || typeof value !== 'object') {
    throw new PublishApprovalDecisionWriterError(
      'approval_decision_invalid_request',
      'approval_decision_payload_invalid',
    );
  }
  const payload = value as Partial<PublishApprovalPayload>;
  if (
    typeof payload.title !== 'string' ||
    typeof payload.content !== 'string' ||
    !Array.isArray(payload.tags) ||
    payload.tags.some((tag) => typeof tag !== 'string') ||
    (payload.contentVersion !== undefined && !Number.isFinite(payload.contentVersion))
  ) {
    throw new PublishApprovalDecisionWriterError(
      'approval_decision_invalid_request',
      'approval_decision_payload_invalid',
    );
  }
  return {
    title: payload.title,
    content: payload.content,
    tags: [...payload.tags],
    ...(payload.contentVersion === undefined ? {} : { contentVersion: payload.contentVersion }),
  };
}

/**
 * API owner adapter。target 与决策上下文在属主侧重新校验，再进入唯一持久写出口。
 */
export function createPublishApprovalDecisionWriter(
  outlet: ApprovalWriteOutlet,
  executionTarget: DeploymentTarget | null | undefined,
): PublishApprovalDecisionWriterPort {
  const localTarget = parseDeploymentTarget(executionTarget);
  return {
    async writeDecision(input: PublishApprovalDecisionWriteInput) {
      const requestTarget = parseDeploymentTarget(input?.executionTarget);
      if (!localTarget || !requestTarget || requestTarget !== localTarget) {
        throw new PublishApprovalDecisionWriterError(
          'approval_decision_target_mismatch',
          `approval_decision_target_mismatch(local=${localTarget ?? 'unset'},request=${String(input?.executionTarget)})`,
        );
      }
      if (typeof input?.requestId !== 'string' || input.requestId.trim().length === 0) {
        throw new PublishApprovalDecisionWriterError(
          'approval_decision_invalid_request',
          'approval_decision_request_id_invalid',
        );
      }
      if (typeof input.approved !== 'boolean') {
        throw new PublishApprovalDecisionWriterError(
          'approval_decision_invalid_request',
          'approval_decision_value_invalid',
        );
      }
      const context = input.context;
      if (
        !context ||
        typeof context.decidedBy !== 'string' ||
        context.decidedBy.trim().length === 0 ||
        !(APPROVAL_DECIDED_VIA as readonly string[]).includes(context.decidedVia) ||
        (context.envKey !== undefined && context.envKey !== null && typeof context.envKey !== 'string')
      ) {
        throw new PublishApprovalDecisionWriterError(
          'approval_decision_invalid_request',
          'approval_decision_context_invalid',
        );
      }
      try {
        return await outlet(
          input.requestId,
          input.approved,
          normalizeDecisionPayload(input.payload),
          {
            decidedBy: context.decidedBy,
            decidedVia: context.decidedVia,
            ...(context.envKey === undefined ? {} : { envKey: context.envKey }),
          },
        );
      } catch (err) {
        if (err instanceof ApprovalExecutionTargetError) {
          throw new PublishApprovalDecisionWriterError(
            'approval_decision_unavailable',
            err.message,
          );
        }
        throw err;
      }
    },
  };
}

function toView(row: ApprovalDecisionRow): PublishApprovalView {
  return {
    requestId: row.requestId,
    revision: row.revision,
    approved: row.approved,
    contentVersion: row.contentVersion,
    dispatchState: row.dispatchState,
    dispatchBlockedReason: row.dispatchBlockedReason,
    envKey: row.envKey,
    executionTarget: row.executionTarget,
    decidedAt: row.decidedAt,
    decidedBy: row.decidedBy,
    decidedVia: row.decidedVia,
  };
}

type AuthorityStore = Pick<
  PublishApprovalStore,
  | 'readActiveForTarget'
  | 'listPendingDispatch'
  | 'voidActive'
  | 'markDispatching'
  | 'markConsumed'
  | 'releaseToPending'
  | 'setBlockedReason'
>;

function requireTarget(
  requestTarget: unknown,
  localTarget: DeploymentTarget | null,
): DeploymentTarget {
  const parsed = parseDeploymentTarget(requestTarget);
  if (!localTarget || !parsed || parsed !== localTarget) {
    throw new PublishApprovalAuthorityError(
      'approval_target_mismatch',
      `approval_target_mismatch(local=${localTarget ?? 'unset'},request=${String(requestTarget)})`,
    );
  }
  return parsed;
}

function requireRequestId(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new PublishApprovalAuthorityError('approval_invalid_request', 'approval_request_id_invalid');
  }
  return value;
}

function requireRevision(value: unknown): number {
  if (!Number.isInteger(value) || Number(value) < 1) {
    throw new PublishApprovalAuthorityError('approval_invalid_request', 'approval_revision_invalid');
  }
  return Number(value);
}

async function resolveCasMiss(
  store: Pick<PublishApprovalStore, 'readActiveForTarget'>,
  input: PublishApprovalRevisionInput,
): Promise<never> {
  const current = await store.readActiveForTarget(input.requestId, input.executionTarget);
  if (!current) {
    throw new PublishApprovalAuthorityError('approval_not_found');
  }
  if (current.revision !== input.expectedRevision) {
    throw new PublishApprovalAuthorityError(
      'approval_revision_conflict',
      `approval_revision_conflict(expected=${input.expectedRevision},current=${current.revision})`,
      { currentRevision: current.revision, currentState: current.dispatchState },
    );
  }
  throw new PublishApprovalAuthorityError(
    'approval_state_conflict',
    `approval_state_conflict(state=${current.dispatchState})`,
    { currentRevision: current.revision, currentState: current.dispatchState },
  );
}

/**
 * API owner adapter。`executionTarget` 来自本服务运行配置；缺失或请求不匹配一律 fail closed。
 */
export function createPublishApprovalAuthorityService(
  store: AuthorityStore,
  executionTarget: DeploymentTarget | null | undefined,
): PublishApprovalAuthorityPort {
  const localTarget = parseDeploymentTarget(executionTarget);
  const normalizeRead = (input: PublishApprovalReadInput): PublishApprovalReadInput => ({
    requestId: requireRequestId(input?.requestId),
    executionTarget: requireTarget(input?.executionTarget, localTarget),
  });
  const normalizeRevision = (input: PublishApprovalRevisionInput): PublishApprovalRevisionInput => ({
    ...normalizeRead(input),
    expectedRevision: requireRevision(input?.expectedRevision),
  });

  return {
    async getApproval(input) {
      const normalized = normalizeRead(input);
      const row = await store.readActiveForTarget(normalized.requestId, normalized.executionTarget);
      return row ? toView(row) : null;
    },

    async listPendingDispatch(input: PublishApprovalListInput) {
      const target = requireTarget(input?.executionTarget, localTarget);
      const limit = input?.limit === undefined
        ? 200
        : Number.isInteger(input.limit) && input.limit > 0
          ? Math.min(input.limit, 500)
          : (() => {
              throw new PublishApprovalAuthorityError('approval_invalid_request', 'approval_limit_invalid');
            })();
      if (input?.subjectKind !== undefined && input.subjectKind !== 'publish' && input.subjectKind !== 'comment') {
        throw new PublishApprovalAuthorityError('approval_invalid_request', 'approval_subject_kind_invalid');
      }
      return (await store.listPendingDispatch(target, limit, input.subjectKind)).map(toView);
    },

    async voidApproval(input: VoidPublishApprovalInput) {
      const normalized = { ...normalizeRevision(input), reason: input?.reason };
      if (!isApprovalVoidReason(normalized.reason)) {
        throw new PublishApprovalAuthorityError('approval_invalid_request', 'approval_void_reason_invalid');
      }
      const row = await store.voidActive(normalized as VoidPublishApprovalInput);
      return row ? toView(row) : resolveCasMiss(store, normalized);
    },

    async markDispatching(input) {
      const normalized = normalizeRevision(input);
      const row = await store.markDispatching(normalized);
      return row ? toView(row) : resolveCasMiss(store, normalized);
    },

    async markConsumed(input) {
      const normalized = normalizeRevision(input);
      const row = await store.markConsumed(normalized);
      return row ? toView(row) : resolveCasMiss(store, normalized);
    },

    async releaseToPending(input: ReleasePublishApprovalInput) {
      const normalized = {
        ...normalizeRevision(input),
        blockedReason: input?.blockedReason ?? null,
      };
      if (
        normalized.blockedReason !== null &&
        !(APPROVAL_BLOCKED_REASONS as readonly string[]).includes(normalized.blockedReason)
      ) {
        throw new PublishApprovalAuthorityError('approval_invalid_request', 'approval_blocked_reason_invalid');
      }
      const row = await store.releaseToPending(normalized);
      return row ? toView(row) : resolveCasMiss(store, normalized);
    },

    async setBlockedReason(input: SetPublishApprovalBlockedReasonInput) {
      const normalized = {
        ...normalizeRevision(input),
        reason: input?.reason ?? null,
      };
      if (
        normalized.reason !== null &&
        !(APPROVAL_BLOCKED_REASONS as readonly string[]).includes(normalized.reason)
      ) {
        throw new PublishApprovalAuthorityError('approval_invalid_request', 'approval_blocked_reason_invalid');
      }
      const row = await store.setBlockedReason(normalized);
      return row ? toView(row) : resolveCasMiss(store, normalized);
    },
  };
}

/** Backward name retained while the composition root switches from local adapter to HTTP. */
export const createInProcessPublishApprovalApi = createPublishApprovalAuthorityService;

/** 授权判定读回（沿用旧形状并补齐 revision，供后续所有 CAS 写复用）。 */
export interface ApprovalLookup {
  approved: boolean;
  contentVersion: number;
  revision: number;
  dispatchState: ApprovalDispatchState;
  dispatchBlockedReason: string | null;
  envKey: string | null;
}

/**
 * automation-facing client：注入本进程 target，调用方不能逐请求自由选择。
 * 远端不可读与合法 404 保持严格区分。
 */
export function createPublishApprovalClient(
  authority: PublishApprovalAuthorityPort,
  executionTarget: DeploymentTarget | null | undefined,
) {
  const localTarget = parseDeploymentTarget(executionTarget);
  const target = (): DeploymentTarget => {
    if (!localTarget) throw new ApprovalUnreadableError('approval_authority_target_unavailable');
    return localTarget;
  };
  return {
    async readApproval(requestId: string): Promise<ApprovalLookup | null> {
      try {
        const body = await authority.getApproval({ requestId, executionTarget: target() });
        return body
          ? {
              approved: body.approved,
              contentVersion: body.contentVersion,
              revision: body.revision,
              dispatchState: body.dispatchState,
              dispatchBlockedReason: body.dispatchBlockedReason,
              envKey: body.envKey,
            }
          : null;
      } catch (err) {
        if (
          err instanceof PublishApprovalAuthorityError &&
          err.code !== 'approval_authority_unavailable' &&
          err.code !== 'approval_authority_result_unknown'
        ) {
          throw err;
        }
        throw new ApprovalUnreadableError(
          err instanceof Error ? `approval_lookup_unreadable:${err.message}` : 'approval_lookup_unreadable',
        );
      }
    },

    async listPendingDispatch(
      requestedTarget: DeploymentTarget,
      limit?: number,
      subjectKind?: 'publish' | 'comment',
    ): Promise<PublishApprovalView[]> {
      const injectedTarget = target();
      if (requestedTarget !== injectedTarget) {
        throw new PublishApprovalAuthorityError('approval_target_mismatch');
      }
      try {
        return await authority.listPendingDispatch({
          executionTarget: injectedTarget,
          limit,
          subjectKind,
        });
      } catch (err) {
        if (err instanceof PublishApprovalAuthorityError && err.code === 'approval_authority_unavailable') {
          throw new ApprovalUnreadableError(`approval_list_unreadable:${err.message}`);
        }
        throw err;
      }
    },

    voidApproval(requestId: string, expectedRevision: number, reason: ApprovalVoidReason): Promise<PublishApprovalView> {
      return authority.voidApproval({ requestId, expectedRevision, executionTarget: target(), reason });
    },
    markDispatching(requestId: string, expectedRevision: number): Promise<PublishApprovalView> {
      return authority.markDispatching({ requestId, expectedRevision, executionTarget: target() });
    },
    markConsumed(requestId: string, expectedRevision: number): Promise<PublishApprovalView> {
      return authority.markConsumed({ requestId, expectedRevision, executionTarget: target() });
    },
    releaseToPending(
      requestId: string,
      expectedRevision: number,
      blockedReason: ApprovalBlockedReason | null,
    ): Promise<PublishApprovalView> {
      return authority.releaseToPending({
        requestId,
        expectedRevision,
        executionTarget: target(),
        blockedReason,
      });
    },
    setBlockedReason(
      requestId: string,
      expectedRevision: number,
      reason: ApprovalBlockedReason | null,
    ): Promise<PublishApprovalView> {
      return authority.setBlockedReason({ requestId, expectedRevision, executionTarget: target(), reason });
    },
  };
}

export type PublishApprovalClient = ReturnType<typeof createPublishApprovalClient>;
