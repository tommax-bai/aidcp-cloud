/**
 * 授权的**窄内部接口**（change publish-approval-signal-to-database）。
 *
 * 形状按未来 HTTP 写死（阶段 1 用进程内适配器，阶段 4 提取 `aidcp-api` 时把适配器换成真 HTTP 客户端，
 * 合同形状不变）：
 *   GET  /internal/publish-approvals/{requestId}
 *   GET  /internal/publish-approvals?dispatchState=pending_dispatch&executionTarget=<target>
 *   POST /internal/publish-approvals/{requestId}/void   { reason }
 *
 * 红线：执行侧 MUST NOT 直接读写授权表——那会在阶段 4 二次断裂。
 * fail-closed：`503`（不可读）在客户端侧抛 `ApprovalUnreadableError`，调用方 MUST 按未授权处理、
 * MUST NOT 写任何终态。`404`（无授权）与 `503`（读不到）在语义上 **必须可区分**：前者是「还没批」，
 * 后者是「不知道批没批」，后者要落 `dispatch_blocked_reason='approval_unreadable'` 并对运营可见。
 */

import type { DeploymentTarget } from '../deployment-target.js';
import {
  ApprovalUnreadableError,
  isApprovalVoidReason,
  type ApprovalDispatchState,
  type ApprovalVoidReason,
  type PublishApprovalStore,
} from './publish-approval-store.js';

/** 跨服务合同形状：授权的对外视图（只暴露判定与呈现所需，不泄露 frozenPayload）。 */
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

export type InternalResponse<T> =
  | { status: 200; body: T }
  | { status: 400; body: { error: string } }
  | { status: 404 }
  | { status: 503; body: { error: string } };

export interface PublishApprovalInternalApi {
  getApproval(requestId: string): Promise<InternalResponse<PublishApprovalView>>;
  listApprovals(query: {
    dispatchState: ApprovalDispatchState;
    executionTarget: DeploymentTarget;
    limit?: number;
    /** 只有发帖有下发段；调用方按用途收窄，免得评论授权把候选窗口永久占满（见 store 侧注释）。 */
    subjectKind?: 'publish' | 'comment';
  }): Promise<InternalResponse<{ approvals: PublishApprovalView[] }>>;
  voidApproval(
    requestId: string,
    reason: string,
  ): Promise<InternalResponse<{ voided: boolean; revision: number | null }>>;
}

function toView(row: {
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
}): PublishApprovalView {
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

/** 阶段 1 的进程内适配器：唯一直接触碰 Store 的地方。 */
export function createInProcessPublishApprovalApi(
  store: Pick<PublishApprovalStore, 'readActive' | 'listPendingDispatch' | 'voidActive'>,
): PublishApprovalInternalApi {
  return {
    async getApproval(requestId) {
      try {
        const row = await store.readActive(requestId);
        if (!row) return { status: 404 };
        return { status: 200, body: toView(row) };
      } catch (err) {
        return { status: 503, body: { error: err instanceof Error ? err.message : String(err) } };
      }
    },
    async listApprovals(query) {
      if (query.dispatchState !== 'pending_dispatch') {
        return { status: 400, body: { error: 'unsupported_dispatch_state' } };
      }
      try {
        const rows = await store.listPendingDispatch(query.executionTarget, query.limit ?? 200, query.subjectKind);
        return { status: 200, body: { approvals: rows.map(toView) } };
      } catch (err) {
        return { status: 503, body: { error: err instanceof Error ? err.message : String(err) } };
      }
    },
    async voidApproval(requestId, reason) {
      if (!isApprovalVoidReason(reason)) return { status: 400, body: { error: 'invalid_void_reason' } };
      try {
        const row = await store.voidActive(requestId, reason);
        return { status: 200, body: { voided: row !== null, revision: row?.revision ?? null } };
      } catch (err) {
        return { status: 503, body: { error: err instanceof Error ? err.message : String(err) } };
      }
    },
  };
}

/** 授权判定读回（沿用旧 `ApprovalDecision` 形状 + 下发进度）。无活跃行 → null（未授权）。 */
export interface ApprovalLookup {
  approved: boolean;
  contentVersion: number;
  revision: number;
  dispatchState: ApprovalDispatchState;
  dispatchBlockedReason: string | null;
  envKey: string | null;
}

/**
 * 执行侧客户端：把内部接口翻成调用方用的三个动作，并把 fail-closed 语义收口在一处。
 * - `404` → `null`（未授权，静默等待，正常路径）
 * - `503` → 抛 `ApprovalUnreadableError`（授权状态不可读，调用方 MUST 标阻塞原因、MUST NOT 写终态）
 */
export function createPublishApprovalClient(api: PublishApprovalInternalApi) {
  return {
    async readApproval(requestId: string): Promise<ApprovalLookup | null> {
      const res = await api.getApproval(requestId);
      if (res.status === 404) return null;
      if (res.status !== 200) throw new ApprovalUnreadableError(`approval_lookup_${res.status}`);
      const body = res.body;
      return {
        approved: body.approved === true,
        contentVersion: body.contentVersion,
        revision: body.revision,
        dispatchState: body.dispatchState,
        dispatchBlockedReason: body.dispatchBlockedReason,
        envKey: body.envKey,
      };
    },
    async listPendingDispatch(
      executionTarget: DeploymentTarget,
      limit?: number,
      subjectKind?: 'publish' | 'comment',
    ): Promise<PublishApprovalView[]> {
      const res = await api.listApprovals({ dispatchState: 'pending_dispatch', executionTarget, limit, subjectKind });
      if (res.status !== 200) throw new ApprovalUnreadableError(`approval_list_${res.status}`);
      return res.body.approvals;
    },
    async voidApproval(requestId: string, reason: ApprovalVoidReason): Promise<void> {
      const res = await api.voidApproval(requestId, reason);
      if (res.status !== 200) throw new ApprovalUnreadableError(`approval_void_${res.status}`);
    },
  };
}

export type PublishApprovalClient = ReturnType<typeof createPublishApprovalClient>;
