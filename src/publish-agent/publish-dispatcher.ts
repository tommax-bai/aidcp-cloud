/**
 * PublishDispatcher —— 发布下发段（change decouple-publish-generation-from-dispatch）。
 *
 * 由人审授权信号到达触发（通过即切）。它是**唯一**碰边缘、**唯一**让位浏览的阶段：
 *   取下发锁（按账号串行）→ 让位（结束该账号浏览）→ 从落库草稿重建发布输入 → 驱动指令序列 →
 *   回写结果 → 解除让位（经续场各闸起新浏览）。
 *
 * 红线：
 * - AC-PUB：下发前 MUST 复核授权信号 approved===true，未授权绝不下发（纵深防御，触发源已写信号仍再核一遍）。
 * - 通过即切：授权到达即下发该草稿、不等自然空档。
 * - 忠于冻结草稿：从 publish_log 读回标题/正文/图/元数据原样发，MUST NOT 重生成（陈旧亦照发）。
 * - 边缘离线：诚实 failed（不发指令、不伪造、不静默吞授权、不让位空转）。
 * - 幂等 + 按账号单飞：同 recordId 重复触发不二次发布；同账号下发串行，绝不并发抢同一边缘。
 */

import type { DispatchDraft } from './publish-log-store.js';
import type { CommandSequencer } from './command-sequencer.js';

/** 下发段所需的落库读写子集。 */
export interface DispatchStore {
  loadForDispatch(recordId: number): Promise<DispatchDraft | null>;
  updateStatus(id: number, status: string): Promise<void>;
  updatePostId(id: number, postId: string, postUrl?: string | null): Promise<void>;
  /** 配图收口：标记真实附着张数 K（K>0 派生 images_attached=true）。 */
  markImagesAttached(id: number, count: number): Promise<void>;
  /** 兜底扫描用：列出所有待审草稿 id（供事件丢失时补触发）。 */
  listPendingApprovalIds(): Promise<number[]>;
}

export interface PublishDispatcherDeps {
  store: DispatchStore;
  sequencer: Pick<CommandSequencer, 'executePublishSequence'>;
  /** 解析绑定该账号的在线边缘节点 edgeId；无在线节点返回 null（→ 诚实 failed）。 */
  resolveEdgeIdForAccount: (accountId: string) => string | null;
  /** AC-PUB 复核：按 requestId 读授权信号，approved===true 才放行。 */
  isApproved: (requestId: string) => Promise<boolean>;
  /** 让位：结束该账号浏览会话（标记不可续场）。 */
  onPublishStart: (accountId: string) => void;
  /** 解除让位：经续场各闸起新浏览会话（无论成功/失败/异常，经唯一保证终止点）。 */
  onPublishEnd: (accountId: string) => void;
  logger?: Pick<Console, 'log' | 'warn' | 'error'>;
}

export class PublishDispatcher {
  private readonly store: DispatchStore;
  private readonly sequencer: Pick<CommandSequencer, 'executePublishSequence'>;
  private readonly resolveEdgeIdForAccount: (accountId: string) => string | null;
  private readonly isApproved: (requestId: string) => Promise<boolean>;
  private readonly onPublishStart: (accountId: string) => void;
  private readonly onPublishEnd: (accountId: string) => void;
  private readonly logger: Pick<Console, 'log' | 'warn' | 'error'>;

  /** 同 recordId 在途去重（防重复点击/事件与兜底扫描双触发）。 */
  private readonly inFlight = new Set<number>();
  /** 按账号串行：每账号一条 Promise 链尾，新下发挂到链尾、绝不并发抢同一边缘。 */
  private readonly accountTail = new Map<string, Promise<void>>();

  constructor(deps: PublishDispatcherDeps) {
    this.store = deps.store;
    this.sequencer = deps.sequencer;
    this.resolveEdgeIdForAccount = deps.resolveEdgeIdForAccount;
    this.isApproved = deps.isApproved;
    this.onPublishStart = deps.onPublishStart;
    this.onPublishEnd = deps.onPublishEnd;
    this.logger = deps.logger ?? console;
  }

  /**
   * 触发一条草稿的下发（幂等 + 按账号串行）。授权信号到达即调用。
   * 已在途的同 recordId 直接忽略；不存在/非待审的草稿安静跳过。
   */
  async dispatch(recordId: number): Promise<void> {
    if (this.inFlight.has(recordId)) {
      this.logger.log(`[PublishDispatcher] recordId=${recordId} 已在下发途中，忽略重复触发`);
      return;
    }
    // 先轻读取账号用于串行键（只读、不改态）。读不到则不入队。
    let accountId: string;
    try {
      const peek = await this.store.loadForDispatch(recordId);
      if (!peek) {
        this.logger.warn(`[PublishDispatcher] recordId=${recordId} 草稿不存在，跳过`);
        return;
      }
      accountId = peek.accountId;
    } catch (err) {
      this.logger.warn(`[PublishDispatcher] recordId=${recordId} 读草稿失败，跳过: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }

    this.inFlight.add(recordId);
    const prev = this.accountTail.get(accountId) ?? Promise.resolve();
    const run = prev
      .catch(() => {})
      .then(() => this.runDispatch(recordId, accountId))
      .finally(() => {
        this.inFlight.delete(recordId);
        if (this.accountTail.get(accountId) === run) this.accountTail.delete(accountId);
      });
    this.accountTail.set(accountId, run);
    return run;
  }

  /**
   * 兜底补偿（at-least-once）：扫描所有待审草稿，已授权者补触发下发（靠 dispatch 幂等去重）。
   * 覆盖「飞书/面板写了授权信号但下发事件丢失」的情形。低频调用。
   */
  async scanAndDispatchApproved(): Promise<void> {
    let ids: number[];
    try {
      ids = await this.store.listPendingApprovalIds();
    } catch (err) {
      this.logger.warn(`[PublishDispatcher] 兜底扫描列待审失败: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    for (const id of ids) {
      const approved = await this.isApproved(`publish-${id}`).catch(() => false);
      if (approved) {
        this.logger.log(`[PublishDispatcher] 兜底扫描发现已授权待审 recordId=${id} → 补触发下发`);
        await this.dispatch(id).catch((e) =>
          this.logger.warn(`[PublishDispatcher] 兜底下发 recordId=${id} 失败: ${e instanceof Error ? e.message : String(e)}`),
        );
      }
    }
  }

  /** 临界区：单条草稿的实际下发（已按账号串行进入）。 */
  private async runDispatch(recordId: number, accountId: string): Promise<void> {
    const draft = await this.store.loadForDispatch(recordId);
    if (!draft) {
      this.logger.warn(`[PublishDispatcher] recordId=${recordId} 下发时草稿已不存在，跳过`);
      return;
    }
    // 幂等：已发布或非待审态不重发（兜底扫描/重复触发可能命中）。
    if (draft.status === 'published') {
      this.logger.log(`[PublishDispatcher] recordId=${recordId} 已发布，跳过（幂等）`);
      return;
    }
    if (draft.status !== 'pending_approval') {
      this.logger.log(`[PublishDispatcher] recordId=${recordId} 非待审态(${draft.status})，跳过下发`);
      return;
    }

    // AC-PUB 复核：下发前必核授权信号，未授权绝不下发（纵深防御）。
    const requestId = `publish-${recordId}`;
    const approved = await this.isApproved(requestId).catch(() => false);
    if (!approved) {
      this.logger.warn(`[PublishDispatcher] recordId=${recordId} 授权信号未确认 approved，绝不下发（AC-PUB）`);
      return;
    }

    // 图文帖必须有图（executor 已拦，下发段再守一道；缺图诚实 failed）。
    if (draft.imageUrls.length === 0) {
      await this.store.updateStatus(recordId, 'failed').catch(() => {});
      this.logger.warn(`[PublishDispatcher] recordId=${recordId} 无配图，诚实 failed（不下发）`);
      return;
    }

    // 边缘离线 → 诚实 failed，不让位空转、不伪造、不静默吞授权。
    const edgeId = this.resolveEdgeIdForAccount(accountId);
    if (!edgeId) {
      await this.store.updateStatus(recordId, 'failed').catch(() => {});
      this.logger.warn(`[PublishDispatcher] 账号 ${accountId} 无在线边缘节点，recordId=${recordId} 诚实 failed（不让位、不下发）`);
      return;
    }

    // 让位 → 下发 → 解除让位（finally 唯一保证终止点）。
    this.onPublishStart(accountId);
    try {
      const result = await this.sequencer.executePublishSequence({
        recordId,
        title: draft.title ?? '',
        content: draft.content,
        // 话题取落库元数据的 topics（生成候审段经 recordMetadata 落库）；缺则空数组。
        tags: draft.metadata?.topics ?? [],
        // 多图：下发全部成功配图逐张上传（[0]=封面）。本期不传 cover——封面=首张上传=平台默认；
        // 强发 set_cover 会踩 edge fail-closed 桩（coverActiveValidator 缺 anchor 必败、非 best-effort 整帖 failed）。
        images: draft.imageUrls,
        cover: undefined,
        metadata: draft.metadata ?? undefined,
        approvedByUser: true,
        edgeId,
      });

      // 配图收口：如实标记真实附着张数 K（部分成功 K≥1 即有效帖；全失败 K=0）。
      await this.store.markImagesAttached(recordId, result.attachedCount).catch(() => {});

      if (result.ok) {
        if (result.postId) {
          await this.store.updatePostId(recordId, result.postId, result.postUrl).catch(() => {});
        } else {
          await this.store.updateStatus(recordId, 'published').catch(() => {});
        }
        this.logger.log(`[PublishDispatcher] recordId=${recordId} published postId=${result.postId ?? '(未抓到)'} edge=${edgeId}`);
      } else {
        await this.store.updateStatus(recordId, 'failed').catch(() => {});
        this.logger.warn(`[PublishDispatcher] recordId=${recordId} 下发失败 failedAt=${JSON.stringify(result.failedAt)}`);
      }
    } catch (err) {
      await this.store.updateStatus(recordId, 'failed').catch(() => {});
      this.logger.warn(`[PublishDispatcher] recordId=${recordId} 下发异常: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      // 无论成功/失败/异常，经此唯一终止点解除让位 → 续场各闸起新浏览。
      this.onPublishEnd(accountId);
    }
  }
}
