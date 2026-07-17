/**
 * PublishDispatcher —— 发布下发段（change decouple-publish-generation-from-dispatch）。
 *
 * 由人审授权信号到达触发（通过即切）。它是**唯一**碰边缘、**唯一**让位浏览的阶段：
 *   取下发锁（按账号串行）→ 让位（结束该账号浏览）→ 从落库草稿重建发布输入 → 驱动指令序列 →
 *   回写结果 → 解除让位（经续场各闸起新浏览）。
 *
 * 红线（change parallel-rewrite-drafts 重述，授权仍是发布的必要条件）：
 * - AC-PUB：下发前 MUST 复核授权信号 approved===true，未授权绝不下发（纵深防御，触发源已写信号仍再核一遍）。
 * - 通过即切：授权到达即下发该草稿、不等自然空档。唯一例外=该账号处于下发熔断（连续序列失败触发）——
 *   熔断只延后不放行不烧授权，人工再次批准（含 already-decided 重复批准）即确认清除、恢复 drain。
 * - 忠于冻结草稿：从 publish_log 读回标题/正文/图/元数据原样发，MUST NOT 重生成（陈旧亦照发）。
 * - 边缘离线（零副作用失败）：草稿回待审 + 作废本次授权信号 + 通知重批（不烧稿、不伪造、不静默吞授权、
 *   不让位空转）；序列中途失败（页面状态未知）仍诚实 failed 终态、绝不自动重跑。
 * - 幂等 + 按账号单飞：同 recordId 重复触发不二次发布；同账号下发串行，绝不并发抢同一边缘。
 */

import type { DispatchDraft } from './publish-log-store.js';
import type { CommandSequencer } from './command-sequencer.js';
import { EdgeTaskLeaseError, type EdgeTaskLeaseClient } from '../comm/edge-task-lease-client.js';
import type { EdgeTaskPriority } from '../comm/protocol.js';

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

/** 授权信号读回（edit-note-draft-before-publish）：approved + 授权所载内容版本号（缺→0，向后兼容）。无信号→null。 */
export interface ApprovalDecision {
  approved: boolean;
  contentVersion: number;
}

/** 下发段运维通知（best-effort，绝不影响下发主链路）：离线/接管超时回待审 / 熔断开启 / 熔断解除。 */
export interface DispatchNotice {
  kind:
    | 'offline_requeued'
    | 'acquire_timeout_requeued'
    | 'cdp_unhealthy_requeued'
    | 'breaker_open'
    | 'breaker_cleared'
    /** 7.3：验证码硬暂停期该 edge 收不到发布命令 → 零副作用回待审（不烧稿、保留授权）。 */
    | 'edge_paused_requeued'
    /** 7.2：同一稿连续被抢占达阈值 → 停自动重投、待运营处理（仍保持待审、绝不烧稿）。 */
    | 'preempted_exhausted';
  accountId: string;
  recordId?: number;
  title?: string | null;
}

export interface PublishDispatcherDeps {
  store: DispatchStore;
  sequencer: Pick<CommandSequencer, 'executePublishSequence'>;
  /** 同一 edge/CDP 任务级执行权；业务命令仅在 acquired 回调内发送。 */
  edgeTaskLeases: Pick<EdgeTaskLeaseClient, 'withLease'>;
  /** 解析绑定该账号的在线边缘节点 edgeId；无在线节点返回 null（→ 诚实 failed）。 */
  resolveEdgeIdForAccount: (accountId: string) => string | null;
  /**
   * 7.3：该 edge 是否处于验证码硬暂停态（ws-server pausedEdges）。暂停期发布命令不在下发豁免名单、
   * 投递必为 0 → 会被序列器 reject 烧成不可逆 failed。下发前先闸：暂停即零副作用回待审、保留授权、不烧稿。
   * 未注入（旧构造/测试）→ 视为从不暂停，行为不变。
   */
  isEdgePaused?: (edgeId: string) => boolean;
  /** AC-PUB 复核 + 版本闸：按 requestId 读授权信号（approved + contentVersion）；无信号返回 null（未授权）。 */
  readApproval: (requestId: string) => Promise<ApprovalDecision | null>;
  /** edit-note-draft-before-publish：作废（删除）一份过期授权签名，令草稿回可重审。 */
  voidApprovalSignal: (requestId: string) => Promise<void>;
  /** @deprecated 执行权现由 edgeTaskLeases 管理；保留可选形状兼容旧构造。 */
  onPublishStart?: (accountId: string) => void;
  /** @deprecated 不再由单功能 finally 无条件恢复浏览。 */
  onPublishEnd?: (accountId: string) => void;
  /**
   * 陪伴界面通知（change edge-companion-ui 8.1，可选）：审批已核通过（approved）、页面已提交待链接确认
   * （submitted）与云端终判失败（failed）推给该账号的在线边缘。best-effort，绝不影响下发主链路。
   */
  notifyUiPublishState?: (accountId: string, recordId: number, state: 'approved' | 'submitted' | 'failed', title?: string | null) => void;
  /** 运维通知（飞书 best-effort）：离线/接管超时回待审 / 熔断开启 / 熔断解除。 */
  notifyDispatchEvent?: (notice: DispatchNotice) => void;
  /** Facebook 发帖素材状态流转：确认成功 used、提交未确认 quarantine、提交前失败 release。 */
  facebookPublishMedia?: {
    releaseReservation(setId: number, reservationId?: string): Promise<boolean>;
    markUsed(setId: number, publishLogId: number): Promise<boolean>;
    quarantine(setId: number, reason: string): Promise<boolean>;
  };
  /**
   * 发布记账（change risk-record-actuated-facts）：一条稿**真的发出去了**之后驱动风控计数。
   *
   * 此前 `record('publish')` **全仓零调用点**，而它是 `risk_counters` 的唯一写入者 ⇒ 发布计数器恒 0
   * ⇒ `canDo('publish')` 的配额分支永不开火 ⇒ **发布日配额是装饰品**（发布实际只受状态闸 + 发布前
   * 人审 + 排期日上限约束）。
   *
   * **判据 = 与 `publish_log` 的权威口径逐字相同**（`status IN ('submitted','published')`，即下方
   * `published_confirmed` 与 `submitted_unconfirmed` 两个分支）——如此后台按 `publish_log` 算出的发布数
   * 与风控计数**应当永远对得上**，对不上即有 bug（白送的交叉校验）。**MUST NOT 凭下发即记**：下发是
   * 意图，可能被抢占 / 边缘离线 / 中途失败。
   *
   * 手动 `/publish` 同样记（用户裁决：手动跳过的是**闸**，不是**账**）。缺省不注入 ⇒ 不记（零回归）。
   */
  recordPublish?: (accountId: string) => Promise<void>;
  /** 同账号连续序列失败多少次触发熔断（默认 2）。 */
  breakerThreshold?: number;
  /** 7.2：同一稿连续被抢占多少次后停自动重投 + 通知运营（默认 3）。 */
  preemptRedispatchMax?: number;
  /**
   * 7.1 事件驱动重投调度器（可注入，缺省 setTimeout）。被抢占的稿在当前下发收尾后重触发一次
   * `dispatch(recordId)`，其 withLease 会在租约队列上等抢占方释放（事件驱动、非 60s 盲投）。
   * 延迟仅用于让当前 dispatch 的 inFlight 清理先跑完；测试可注入同步桩。
   */
  scheduleRedispatch?: (fn: () => void) => void;
  logger?: Pick<Console, 'log' | 'warn' | 'error'>;
}

export class PublishDispatcher {
  private readonly store: DispatchStore;
  private readonly sequencer: Pick<CommandSequencer, 'executePublishSequence'>;
  private readonly edgeTaskLeases: Pick<EdgeTaskLeaseClient, 'withLease'>;
  private readonly resolveEdgeIdForAccount: (accountId: string) => string | null;
  private readonly isEdgePaused?: (edgeId: string) => boolean;
  private readonly readApproval: (requestId: string) => Promise<ApprovalDecision | null>;
  private readonly voidApprovalSignal: (requestId: string) => Promise<void>;
  private readonly notifyUiPublishState?: (accountId: string, recordId: number, state: 'approved' | 'submitted' | 'failed', title?: string | null) => void;
  private readonly notifyDispatchEvent?: (notice: DispatchNotice) => void;
  private readonly facebookPublishMedia?: NonNullable<PublishDispatcherDeps['facebookPublishMedia']>;
  private readonly recordPublish?: (accountId: string) => Promise<void>;
  private readonly breakerThreshold: number;
  private readonly preemptRedispatchMax: number;
  private readonly scheduleRedispatch: (fn: () => void) => void;
  private readonly logger: Pick<Console, 'log' | 'warn' | 'error'>;

  /** 同 recordId 在途去重（防重复点击/事件与兜底扫描双触发）。 */
  private readonly inFlight = new Set<number>();
  /** 按账号串行：每账号一条 Promise 链尾，新下发挂到链尾、绝不并发抢同一边缘。 */
  private readonly accountTail = new Map<string, Promise<void>>();
  /** 熔断（防连环烧稿）：同账号连续序列失败计数（成功清零；内存态，重启即清=有界代价）。 */
  private readonly consecutiveSeqFails = new Map<string, number>();
  /** 熔断中的账号：停 drain 已批队列、新下发拒绝且不烧授权；人工批准确认清除。 */
  private readonly openBreakers = new Set<string>();
  /**
   * 7.2 抢占计数（按 recordId）：被抢占不计熔断（拆掉了唯一那道刹车），必须补一道独立退避——
   * 同一稿连续被抢占达阈值 → 停自动重投 + 通知运营（仍保持待审、绝不烧稿）。成功/真失败终态即清零。
   */
  private readonly consecutivePreemptions = new Map<number, number>();
  /** 7.3：已就「验证码硬暂停」通知过运维的 recordId——防 60s 兜底扫描每轮对同一暂停重复 ping 运维（只在进入暂停态时发一次）。 */
  private readonly pausedNotified = new Set<number>();

  /**
   * 发布真发出后记一笔风控计数（change risk-record-actuated-facts）。
   *
   * **best-effort**：这是**事后账**，绝不能反过来动摇已经成功的发布终态——记账失败只告警。
   * 未注入 `recordPublish` ⇒ 不记（零回归）。
   */
  private async recordActuatedPublish(accountId: string, recordId: number): Promise<void> {
    if (!this.recordPublish) return;
    try {
      await this.recordPublish(accountId);
    } catch (err) {
      this.logger.warn(
        `[PublishDispatcher] recordId=${recordId} 发布已成功但风控记账失败（配额将偏松，需关注）：${(err as Error).message}`,
      );
    }
  }

  constructor(deps: PublishDispatcherDeps) {
    this.store = deps.store;
    this.sequencer = deps.sequencer;
    this.edgeTaskLeases = deps.edgeTaskLeases;
    this.resolveEdgeIdForAccount = deps.resolveEdgeIdForAccount;
    this.isEdgePaused = deps.isEdgePaused;
    this.readApproval = deps.readApproval;
    this.voidApprovalSignal = deps.voidApprovalSignal;
    this.notifyUiPublishState = deps.notifyUiPublishState;
    this.notifyDispatchEvent = deps.notifyDispatchEvent;
    this.recordPublish = deps.recordPublish;
    this.facebookPublishMedia = deps.facebookPublishMedia;
    this.breakerThreshold = Math.max(1, deps.breakerThreshold ?? 2);
    this.preemptRedispatchMax = Math.max(1, deps.preemptRedispatchMax ?? 3);
    this.scheduleRedispatch = deps.scheduleRedispatch ?? ((fn) => { const t = setTimeout(fn, 0); (t as { unref?: () => void }).unref?.(); });
    this.logger = deps.logger ?? console;
  }

  /** 该账号是否处于下发熔断（观测/预检提示用）。 */
  isBreakerOpen(accountId: string): boolean {
    return this.openBreakers.has(accountId);
  }

  /**
   * 管理后台只读观测：当前已经进入 dispatcher 单飞集合的发布记录。
   * 返回副本，调用方不能借此修改 inFlight；这里只证明“已批准并正在排队/下发”，
   * 不臆造 CommandSequencer 内部的逐命令进度。
   */
  getInFlightRecordIds(): number[] {
    return [...this.inFlight];
  }

  /** 运维通知 best-effort 包装：通知层异常绝不打断下发主链路。 */
  private notifyOps(notice: DispatchNotice): void {
    try {
      this.notifyDispatchEvent?.(notice);
    } catch {
      /* best-effort */
    }
  }

  /** 序列失败记账：连续 N 次触发熔断（自愈不自残——停 drain 防连环烧掉整批获批草稿）。 */
  private recordSeqFailure(accountId: string, recordId: number, title?: string | null): void {
    const n = (this.consecutiveSeqFails.get(accountId) ?? 0) + 1;
    this.consecutiveSeqFails.set(accountId, n);
    if (n >= this.breakerThreshold && !this.openBreakers.has(accountId)) {
      this.openBreakers.add(accountId);
      this.logger.warn(
        `[PublishDispatcher] 账号 ${accountId} 连续 ${n} 次下发序列失败 → 熔断开启：停 drain 已批队列、新下发拒绝且不烧授权；人工重新批准即确认恢复`,
      );
      this.notifyOps({ kind: 'breaker_open', accountId, recordId, title });
    }
  }

  /**
   * 7.1 + 7.2 被抢占后的事件驱动重投：被抢占的稿保持待审、授权仍在，重触发一次 `dispatch(recordId)`——
   * 其 withLease 的 acquire 会在租约队列上**等抢占方释放**（事件驱动、非 60s 盲投；抢占方多为秒级的手动评论/加群）。
   * 7.2 退避：同一稿连续被抢占达阈值 → 停自动重投 + 通知运营（仍保持待审、绝不烧稿），防抢占方长时间占用时无限重投空转。
   * 延到当前 dispatch 的 inFlight 清理之后再触发（scheduleRedispatch 默认 setTimeout(0)）。
   */
  private schedulePreemptedRedispatch(recordId: number, accountId: string, title?: string | null): void {
    const n = (this.consecutivePreemptions.get(recordId) ?? 0) + 1;
    this.consecutivePreemptions.set(recordId, n);
    if (n >= this.preemptRedispatchMax) {
      this.consecutivePreemptions.delete(recordId);
      // 达阈值停自动重投：**作废本次授权签名**，否则草稿仍 pending_approval + 授权仍在 → 60s 兜底扫描每轮把它
      // 重新捞起再爆一轮重投（退避形同虚设 + 反复 ping 运营），且「人工再批即恢复」的提示就成了空话。作废后
      // 兜底扫描不再自动补投，运营重新批准才恢复——退避才真正生效。草稿仍 pending_approval、绝不烧成 failed。
      void this.voidApprovalSignal(`publish-${recordId}`).catch(() => {});
      this.logger.warn(
        `[PublishDispatcher] recordId=${recordId} 连续被抢占 ${n} 次 → 停自动重投、作废授权、通知运营（保持待审、绝不烧稿；人工再批即恢复）`,
      );
      this.notifyOps({ kind: 'preempted_exhausted', accountId, recordId, title });
      return;
    }
    this.logger.log(`[PublishDispatcher] recordId=${recordId} 被抢占第 ${n} 次 → 事件驱动重投（排队等抢占方释放）`);
    this.scheduleRedispatch(() => {
      void this.dispatch(recordId).catch((e) =>
        this.logger.warn(`[PublishDispatcher] 被抢占重投 recordId=${recordId} 失败: ${e instanceof Error ? e.message : String(e)}`),
      );
    });
  }

  /** 人工批准确认（含 already-decided 重复批准）：熔断中即视为人工确认清除，并踢一次兜底扫描恢复 drain。 */
  private confirmHumanApproval(accountId: string): boolean {
    if (!this.openBreakers.has(accountId)) return false;
    this.openBreakers.delete(accountId);
    this.consecutiveSeqFails.delete(accountId);
    this.logger.log(`[PublishDispatcher] 账号 ${accountId} 人工批准确认 → 熔断清除，恢复 drain 已批队列`);
    this.notifyOps({ kind: 'breaker_cleared', accountId });
    return true;
  }

  /**
   * 触发一条草稿的下发（幂等 + 按账号串行）。授权信号到达即调用。
   * 已在途的同 recordId 直接忽略；不存在/非待审的草稿安静跳过。
   * opts.humanApproval：人工批准入口（飞书/面板，含 already-decided 重复批准）——熔断中即视为
   * 人工确认清除熔断并踢兜底扫描恢复 drain；非人工路径（兜底扫描）在熔断中被拒且不烧授权。
   */
  async dispatch(recordId: number, opts?: { humanApproval?: boolean }): Promise<void> {
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

    const clearedBreaker = opts?.humanApproval ? this.confirmHumanApproval(accountId) : false;
    if (this.openBreakers.has(accountId)) {
      // 熔断中：新下发拒绝且不烧授权信号（信号原样保留，人工批准确认后由兜底扫描恢复 drain）。
      this.logger.warn(`[PublishDispatcher] 账号 ${accountId} 下发熔断中，recordId=${recordId} 暂不下发（授权保留不烧）`);
      return;
    }

    this.inFlight.add(recordId);
    // 9.1（用户 2026-07-14 拍板）：一切发布一律自动档，不论触发路径（人审入口 / 兜底扫描 / 事件驱动重投）。
    // 发布是异步队列作业，批准完人就走了、没人在线等回执 → 不给人工档。人工档只留「运营在线等回执」的动作
    // （手动评论 / 手动加群 / 客户端内审批即时动作）。opts.humanApproval 仍保留——它另驱动熔断解除
    // （confirmHumanApproval），只是不再据此定租约档位。同时消灭「同稿因触发路径不同而档位不同 + 重投降级」两个反 aging 缺陷。
    const priority: EdgeTaskPriority = 'automatic';
    const prev = this.accountTail.get(accountId) ?? Promise.resolve();
    const run = prev
      .catch(() => {})
      .then(() => this.runDispatch(recordId, accountId, priority))
      .finally(() => {
        this.inFlight.delete(recordId);
        if (this.accountTail.get(accountId) === run) this.accountTail.delete(accountId);
      });
    this.accountTail.set(accountId, run);
    // 熔断刚被本次人工批准清除：踢一次兜底扫描，恢复 drain 该账号此前被跳过的已批队列。
    if (clearedBreaker) {
      void this.scanAndDispatchApproved().catch(() => {});
    }
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
    // 逐条并发启动、不逐条串行 await（多稿同窗获批时一账号多篇背靠背下发不拖死跨账号扫描；
    // 同账号内串行由 accountTail 保证，同 recordId 幂等由 inFlight 保证）。整体 allSettled 供测试/调用方等待收敛。
    const launched: Array<Promise<void>> = [];
    for (const id of ids) {
      const decision = await this.readApproval(`publish-${id}`).catch(() => null);
      if (decision?.approved) {
        this.logger.log(`[PublishDispatcher] 兜底扫描发现已授权待审 recordId=${id} → 补触发下发`);
        launched.push(
          this.dispatch(id).catch((e) =>
            this.logger.warn(`[PublishDispatcher] 兜底下发 recordId=${id} 失败: ${e instanceof Error ? e.message : String(e)}`),
          ),
        );
      }
    }
    await Promise.allSettled(launched);
  }

  /** 陪伴界面通知 best-effort 包装：通知层异常绝不打断下发主链路。 */
  private notifyUi(accountId: string, recordId: number, state: 'approved' | 'submitted' | 'failed', title?: string | null): void {
    try {
      this.notifyUiPublishState?.(accountId, recordId, state, title);
    } catch {
      /* best-effort */
    }
  }

  private async settleFacebookMedia(
    draft: DispatchDraft,
    outcome: 'published_confirmed' | 'submitted_unconfirmed' | 'failed_before_submit' | 'preempted',
    recordId: number,
    reason?: string,
  ): Promise<void> {
    if (draft.platform !== 'facebook') return;
    const reservation = draft.metadata?.facebookMedia;
    if (!reservation || !this.facebookPublishMedia) return;
    try {
      if (outcome === 'published_confirmed') {
        await this.facebookPublishMedia.markUsed(reservation.setId, recordId);
      } else if (outcome === 'submitted_unconfirmed') {
        await this.facebookPublishMedia.quarantine(reservation.setId, reason ?? 'submitted_unconfirmed');
      } else {
        await this.facebookPublishMedia.releaseReservation(reservation.setId, reservation.reservationId);
      }
    } catch (err) {
      this.logger.warn(
        `[PublishDispatcher] Facebook 素材状态回写失败 recordId=${recordId} set=${reservation.setId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  /** 临界区：单条草稿的实际下发（已按账号串行进入）。 */
  private async runDispatch(recordId: number, accountId: string, priority: EdgeTaskPriority): Promise<void> {
    // 入队后熔断才开启（同链前序项连败）的迟到项：同样跳过且不烧授权，防连环烧稿。
    if (this.openBreakers.has(accountId)) {
      this.logger.warn(`[PublishDispatcher] 账号 ${accountId} 下发熔断中，recordId=${recordId} 队内跳过（授权保留不烧）`);
      return;
    }
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
    const decision = await this.readApproval(requestId).catch(() => null);
    if (!decision?.approved) {
      this.logger.warn(`[PublishDispatcher] recordId=${recordId} 授权信号未确认 approved，绝不下发（AC-PUB）`);
      return;
    }

    // 版本闸（edit-note-draft-before-publish）：授权所载版本 ≠ 当前草稿版本 → 说明草稿在授权后又被编辑，
    // 该授权是对旧字节的、绝不能发出未审内容。作废（删除）过期签名并留待审（自愈回可重审），绝不落 needs_review、绝不自毁。
    // 这是「审=发」的结构性权威兜底：写时预检漏网（读版本与写签名之间又落编辑的 TOCTOU）在此收口。
    if (decision.contentVersion !== draft.contentVersion) {
      await this.voidApprovalSignal(requestId).catch(() => {});
      this.logger.warn(
        `[PublishDispatcher] recordId=${recordId} 授权版本 v${decision.contentVersion} ≠ 草稿 v${draft.contentVersion} → 作废过期签名、留待审（不下发未审内容）`,
      );
      return;
    }

    // 图文帖必须有图（executor 已拦，下发段再守一道；缺图诚实 failed）。
    if (draft.imageUrls.length === 0) {
      await this.store.updateStatus(recordId, 'failed').catch(() => {});
      await this.settleFacebookMedia(draft, 'failed_before_submit', recordId, 'draft_missing_images');
      this.logger.warn(`[PublishDispatcher] recordId=${recordId} 无配图，诚实 failed（不下发）`);
      this.notifyUi(accountId, recordId, 'failed', draft.title);
      return;
    }

    // 边缘离线（零副作用失败，change parallel-rewrite-drafts）→ 草稿回待审 + 作废本次授权信号 + 通知重批。
    // 不烧稿（保住生成+生图成本）、不让位空转、不伪造、不静默吞授权；边缘恢复后人工重批即可下发。
    // 作废信号防两害：60s 兜底扫描对着离线边缘反复空转、以及边缘恢复后旧授权在无人知情时自动发出。
    const edgeId = this.resolveEdgeIdForAccount(accountId);
    if (!edgeId) {
      await this.voidApprovalSignal(requestId).catch(() => {});
      this.logger.warn(
        `[PublishDispatcher] 账号 ${accountId} 无在线边缘节点，recordId=${recordId} 回待审（作废本次授权、通知重批；不烧稿、不让位、不下发）`,
      );
      this.notifyOps({ kind: 'offline_requeued', accountId, recordId, title: draft.title });
      return;
    }

    // 7.3 验证码硬暂停闸：暂停期该 edge 收不到发布命令（不在 ws-server 下发豁免名单）→ 投递必为 0 →
    // 序列器立即 reject → 会被烧成不可逆 failed + 熔断 +1。下发前先闸：暂停即零副作用回待审、不烧稿、不计熔断。
    // 与离线分支不同：验证码暂停是**瞬态**（解完即恢复），故**不作废授权**——留待兜底扫描在恢复后重投。
    if (this.isEdgePaused?.(edgeId)) {
      this.logger.warn(
        `[PublishDispatcher] 账号 ${accountId} edge ${edgeId} 处于验证码硬暂停 → recordId=${recordId} 保持待审、不下发（零副作用、保留授权）`,
      );
      // 只在**进入**暂停态时通知一次；60s 兜底扫描每轮重命中同一暂停不再重复 ping 运维。暂停解除后本记录下次
      // 走到下方非暂停路径会清标记、重新武装。
      if (!this.pausedNotified.has(recordId)) {
        this.pausedNotified.add(recordId);
        this.notifyOps({ kind: 'edge_paused_requeued', accountId, recordId, title: draft.title });
      }
      return;
    }
    // 非暂停路径：清「已通知暂停」标记（暂停已解除，重新武装下次暂停的一次性通知）。
    this.pausedNotified.delete(recordId);

    let sequenceStarted = false;
    try {
      const result = await this.edgeTaskLeases.withLease(
        {
          edgeId,
          kind: 'publish',
          priority,
          leaseMs: Number(process.env.AIDCP_EDGE_PUBLISH_LEASE_MS ?? 10 * 60_000),
        },
        async (lease) => {
          // acquired 同时代表 edge 已 quiesced；此前不得推 approved/不得发送首条业务命令。
          this.notifyUi(accountId, recordId, 'approved', draft.title);
          return this.sequencer.executePublishSequence({
            taskId: lease.taskId,
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
            platform: draft.platform ?? 'xiaohongshu',
            approvedByUser: true,
            edgeId,
            // 7.1 HOLE-13：把「已开始」下移到提交点击真正下发前——此前的导航/上传/填字段皆平台零副作用，
            // 若因意外抛错收敛，走下方 !sequenceStarted 分支零副作用回待审，不烧成 failed + 熔断。
            onFirstSideEffect: () => { sequenceStarted = true; },
          });
        },
      );

      // 配图收口：如实标记真实附着张数 K（部分成功 K≥1 即有效帖；全失败 K=0）。
      await this.store.markImagesAttached(recordId, result.attachedCount).catch(() => {});

      if (result.ok && result.outcome === 'published_confirmed') {
        await this.settleFacebookMedia(draft, result.outcome, recordId, result.failedAt?.error);
        this.consecutiveSeqFails.delete(accountId);
        this.consecutivePreemptions.delete(recordId);
        await this.store.updatePostId(recordId, result.postId!, result.postUrl).catch(() => {});
        // 发布记账（change risk-record-actuated-facts）：发出去了 ⇒ 平台看见了 ⇒ 记。与 publish_log 的
        // 权威口径同轴（published）。best-effort：记账失败绝不影响已成功的发布终态。
        await this.recordActuatedPublish(accountId, recordId);
        this.logger.log(`[PublishDispatcher] recordId=${recordId} published postId=${result.postId} edge=${edgeId}`);
      } else if (result.outcome === 'submitted_unconfirmed') {
        // 当前页面已确认提交，但未拿到同页 postId/permalink。
        // 对用户是“已提交，待链接确认”，不是失败；仍不重试，素材隔离。
        await this.settleFacebookMedia(draft, result.outcome, recordId, result.failedAt?.error);
        this.consecutivePreemptions.delete(recordId);
        await this.store.updateStatus(recordId, 'submitted').catch(() => {});
        // 与上面 published 同理：页面已确认提交 ⇒ 平台收到了这条帖 ⇒ 记。拿没拿到链接是「平台对我们已做
        // 之事的回答」，MUST NOT 决定这次动作算不算数——与 publish_log 把 submitted 计入日上限同轴。
        await this.recordActuatedPublish(accountId, recordId);
        this.logger.warn(
          `[PublishDispatcher] recordId=${recordId} submitted_unconfirmed，已转 submitted（不刷新、不自动重试）`,
        );
        this.notifyUi(accountId, recordId, 'submitted', draft.title);
      } else if (result.outcome === 'preempted') {
        // 7.1 被抢占（严格高档位打断，提交前零副作用）≠ 失败：保持待审（**不写任何终态**，留 pending_approval）、
        // 保留授权签名（不 voidApprovalSignal）、FB 素材归还而非隔离、**不计熔断**。交抢占方释放后事件驱动重投。
        await this.settleFacebookMedia(draft, 'preempted', recordId, result.failedAt?.error);
        this.logger.warn(
          `[PublishDispatcher] recordId=${recordId} 被抢占（${result.failedAt?.error ?? 'preempted'}）→ 保持待审、保留授权、事件驱动重投（不烧稿、不计熔断）`,
        );
        this.schedulePreemptedRedispatch(recordId, accountId, draft.title);
      } else {
        // 序列中途失败（页面状态未知）→ failed 终态、绝不自动重跑；计入熔断（连续 N 次停 drain 防连环烧稿）。
        await this.settleFacebookMedia(draft, result.outcome, recordId, result.failedAt?.error);
        this.consecutivePreemptions.delete(recordId);
        await this.store.updateStatus(recordId, 'failed').catch(() => {});
        this.logger.warn(`[PublishDispatcher] recordId=${recordId} 下发失败 failedAt=${JSON.stringify(result.failedAt)}`);
        this.notifyUi(accountId, recordId, 'failed', draft.title);
        this.recordSeqFailure(accountId, recordId, draft.title);
      }
    } catch (err) {
      if (!sequenceStarted) {
        // acquire 未确认 = 零业务命令副作用；作废授权回待审，绝不把协议过旧/离线烧成 failed。
        await this.voidApprovalSignal(requestId).catch(() => {});
        const noticeKind = err instanceof EdgeTaskLeaseError && err.code === 'acquire_timeout'
          ? 'acquire_timeout_requeued'
          : err instanceof EdgeTaskLeaseError && err.code === 'edge_unhealthy'
            ? 'cdp_unhealthy_requeued'
            : 'offline_requeued';
        this.logger.warn(
          `[PublishDispatcher] recordId=${recordId} 未取得 edge task lease，零命令下发、回待审: ${err instanceof Error ? err.message : String(err)}`,
        );
        this.notifyOps({ kind: noticeKind, accountId, recordId, title: draft.title });
        return;
      }
      // 序列驱动异常（页面状态未知）→ 同序列失败处理：failed 终态 + 计入熔断。
      // 注：抢占以 preempted **结果**回来（在 command-sequencer 的 catch 内收敛为结果、绝不 unwind），故此处不会是抢占。
      await this.settleFacebookMedia(draft, 'submitted_unconfirmed', recordId, err instanceof Error ? err.message : String(err));
      this.consecutivePreemptions.delete(recordId);
      await this.store.updateStatus(recordId, 'failed').catch(() => {});
      this.logger.warn(`[PublishDispatcher] recordId=${recordId} 下发异常: ${err instanceof Error ? err.message : String(err)}`);
      this.notifyUi(accountId, recordId, 'failed', draft.title);
      this.recordSeqFailure(accountId, recordId, draft.title);
    }
  }
}
