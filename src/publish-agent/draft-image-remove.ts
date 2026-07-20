/**
 * 客户端预览内删除待审稿件的某张配图（change client-preview-image-delete）。
 *
 * 为什么单独成模块：这条通道带的是**租户隔离**与**审=发**两道红线，必须可单测。
 * 闸序照搬应用内审批（handlePublishApprovalAction）的模板，并补上管理后台编辑路径**缺失**的账号归属闸——
 * 面板只认运营 JWT、不校验记录归属；客户端连接是账号级身份，MUST NOT 复制那份宽松，
 * 否则任一客户端可猜 recordId 去改他人租户的稿件。
 *
 * 落库复用既有单写方法 editDraft（事务内 FOR UPDATE + content_version CAS + 只删不注入），绝不新起裸 SQL。
 */
import type {
  PublishDraftImageRemovePayload,
  PublishDraftImageRemoveResultPayload,
} from '../comm/protocol.js';
import type { DispatchDraft, EditDraftPatch, EditDraftResult } from './publish-log-store.js';

export interface DraftImageRemoveDeps {
  /** 读草稿真态（含 accountId / status / imageUrls / contentVersion）。 */
  loadDraft: (recordId: number) => Promise<DispatchDraft | null>;
  /** 探测审批签名是否已落（已落则内容不可再改）。 */
  readApproval: (requestId: string) => Promise<unknown | null>;
  /** 既有单写编辑方法（乐观 CAS + 只删不注入）。 */
  editDraft: (
    recordId: number,
    expectedVersion: number,
    patch: EditDraftPatch,
    editor: string,
  ) => Promise<EditDraftResult>;
  /** 版本冲突时回带库内活版本（读不到则不回带，绝不编造）。 */
  readLiveVersion: (recordId: number) => Promise<number | null>;
  /** 写后重推预览快照（best-effort；应答回带真态才是客户端的主刷新路径）。 */
  refreshPreview: (recordId: number) => void;
  logger?: Pick<Console, 'warn'>;
}

/** 会话身份：只取握手确立的 accountId（自报 edgeId 之外的一切都不采信）。 */
export interface DraftImageRemoveSession {
  accountId?: string;
  /** 审计写入者；旧 Edge WS 缺省保持既有 edge-client 口径。 */
  actor?: string;
}

export function createPublishDraftImageRemoveHandler(deps: DraftImageRemoveDeps) {
  const logger = deps.logger ?? console;

  return async function handlePublishDraftImageRemove(
    payload: PublishDraftImageRemovePayload,
    session: DraftImageRemoveSession,
  ): Promise<PublishDraftImageRemoveResultPayload> {
    const requestId = typeof payload?.requestId === 'string' ? payload.requestId : '';
    const match = /^publish-(\d+)$/.exec(requestId);
    const imageUrl = typeof payload?.imageUrl === 'string' ? payload.imageUrl : '';
    const requestedVersion = payload?.contentVersion;
    if (!match || !imageUrl || !Number.isInteger(requestedVersion) || Number(requestedVersion) < 0) {
      return { requestId, ok: false, reason: 'invalid_request' };
    }
    if (!session.accountId) return { requestId, ok: false, reason: 'account_unavailable' };

    const recordId = Number(match[1]);
    const draft = await deps.loadDraft(recordId).catch(() => null);
    if (!draft) return { requestId, ok: false, reason: 'not_found' };

    // 账号归属闸（红线）：草稿必须属于握手确立的会话账号，绝不采信客户端自带的任何账号声明。
    if (draft.accountId !== session.accountId) return { requestId, ok: false, reason: 'account_mismatch' };
    // 决定已落（通过 / 驳回）即内容不可再改，否则绕过“审=发”。
    if (await deps.readApproval(requestId).catch(() => null)) {
      return { requestId, ok: false, reason: 'already_decided' };
    }
    if (draft.status !== 'pending_approval') return { requestId, ok: false, reason: 'not_pending' };
    if (requestedVersion !== draft.contentVersion) {
      return { requestId, ok: false, reason: 'version_stale', currentVersion: draft.contentVersion };
    }
    if (!draft.imageUrls.includes(imageUrl)) return { requestId, ok: false, reason: 'image_not_found' };

    // 保留子集由云端在库内真态上算出：客户端只表达“删这一张”的意图，绝不采信其提交的列表。
    const kept = draft.imageUrls.filter((url) => url !== imageUrl);
    // 最后一张不可删：下发段对 M=0 图文帖直接诚实 failed（spec publish-image-required），
    // 绝不给客户“删空 → 审批 → 稿子被烧”的路径。端上不给入口，服务端才是权威。
    if (kept.length === 0) return { requestId, ok: false, reason: 'last_image' };

    const edited = await deps
      .editDraft(
        recordId,
        Number(requestedVersion),
        { images: kept },
        session.actor ?? `edge-client:${session.accountId}`,
      )
      .catch((err: unknown) => {
        logger.warn(
          `[publish-draft] 客户端删配图落库失败 recordId=${recordId}: ${err instanceof Error ? err.message : String(err)}`,
        );
        return null;
      });
    if (!edited) return { requestId, ok: false, reason: 'store_unavailable' };

    if (!edited.ok) {
      // 事务内复检（前置校验与落库之间的 TOCTOU 兜底）拒因映射回本通道的具名拒因，绝不降级为泛化错误。
      const reason =
        edited.reason === 'version_conflict'
          ? 'version_stale'
          : edited.reason === 'invalid_field'
            ? 'image_not_found'
            : edited.reason;
      if (reason === 'version_stale') {
        const live = await deps.readLiveVersion(recordId).catch(() => null);
        if (typeof live === 'number') return { requestId, ok: false, reason, currentVersion: live };
      }
      return { requestId, ok: false, reason };
    }

    // 内容已变（content_version + 1，原飞书审核卡随之失效）：重推预览（best-effort），
    // 但客户端的主刷新路径是本应答回带的写后真态。
    deps.refreshPreview(recordId);
    return { requestId, ok: true, images: edited.images, contentVersion: edited.contentVersion };
  };
}
