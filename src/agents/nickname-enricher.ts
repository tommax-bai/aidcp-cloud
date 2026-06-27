/**
 * NicknameEnricher — 登录账号真实昵称采集角色（change account-real-nickname）。
 *
 * 职责（纯云端编排，edge 纯执行）：在「真实账号 + 库内昵称空」时，会话开始驱动一次本人主页访问采昵称、
 * 读回上报、单写持久化、干净回 feed。决策/编排全在此（铁律：edge 只执行原子操作、绝不判定）。
 *
 * 消费事件：
 *   - feed.entered{trigger:'session_start'}：需采集 → 同一 tick 暂停自主浏览 + 置在途标记 + 武装 ~20s 超时
 *     + emit self.profile.capture（dispatcher 翻译为 profile_open{direct:true}）。
 *   - profile.detail.arrived（本人=detail.authorId===连接 accountId）：取消超时 → setNickname(非空) →
 *     清标记 → 解除暂停 → emit feed.entered{back_to_feed}（严格顺序，design D5）。
 * 产出事件：self.profile.capture（云端内部）、feed.entered{back_to_feed}。
 *
 * 隔离红线：本人绝不进社交管线——身份判据用 detail.authorId===accountId（race-free，by-id 自访问的 authorId
 * 由 edge 从导航 URL 派生），**不**用在途标记判定身份（标记受总线分发竞态，重叠会把别人昵称写到自己）。
 * 在途标记仅用于 chokepoint 放行 self profile_open + 超时 + 防重复收尾，绝不用于持久化/隔离身份判定。
 *
 * 有界 / 幂等 / 中性：~20s 超时兜底（edge 静默/CDP 崩不困死会话，最坏滞留从 1h→~20s）；采空 K 次退避
 * （genuinely 抽不到的主页不永绕）；采到非空即置 pending=false（本连接此后不再绕）；profile_open 不触风控/预算/节奏。
 *
 * 不使用 LLM，纯确定性执行。
 */

import { BaseRole } from './base-role.js';
import type { RoleOptions } from './base-role.js';
import { SessionContext } from './session-context.js';
import type { RoleName, FeedEnteredPayload, ProfileDetailData } from '../event-bus/types.js';

export interface NicknameEnricherDeps {
  sessionContext: SessionContext;
  /** 该连接当前账号（= 本人主页 id）；会话开始时已由握手 setCurrentAccountId 设为真实账号。 */
  getAccountId: () => string;
  /** 持久化昵称（拒空、单写 upsert）；缺省（无 PG）→ 不持久化。 */
  setNickname?: (accountId: string, nickname: string) => Promise<void> | void;
  /** 计时器注入（测试桩）；生产用全局 setTimeout/clearTimeout（unref，不阻进程退出）。 */
  setTimeoutFn?: (fn: () => void, ms: number) => unknown;
  clearTimeoutFn?: (handle: unknown) => void;
}

export class NicknameEnricher extends BaseRole {
  readonly roleName: RoleName = 'nickname_enricher';
  private readonly ctx: SessionContext;
  private readonly getAccountId: () => string;
  private readonly setNicknameFn?: (accountId: string, nickname: string) => Promise<void> | void;
  private readonly setTimeoutFn: (fn: () => void, ms: number) => unknown;
  private readonly clearTimeoutFn: (handle: unknown) => void;
  private unsubscribers: (() => void)[] = [];
  /** 采集已武装、等边缘就绪（首个 page.cards.arrived）再下发命令；下发后置 false。 */
  private awaitingEdgeReady = false;

  constructor(options: RoleOptions & NicknameEnricherDeps) {
    super(options);
    this.ctx = options.sessionContext;
    this.getAccountId = options.getAccountId;
    this.setNicknameFn = options.setNickname;
    this.setTimeoutFn = options.setTimeoutFn ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimeoutFn = options.clearTimeoutFn ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  }

  subscribe(): void {
    this.unsubscribers.push(
      this.eventBus.on('feed.entered', (p) => this.onFeedEntered(p)),
      this.eventBus.on('page.cards.arrived', () => this.onEdgeReady()),
      this.eventBus.on('profile.detail.arrived', (p) => this.onDetailArrived(p.detail, p.accountId)),
    );
  }

  unsubscribe(): void {
    for (const unsub of this.unsubscribers) unsub();
    this.unsubscribers = [];
    this.clearTimer();
  }

  // ─── 触发：登录引导（armLoginCapture）或浏览会话开始（feed.entered{session_start}）→ 武装一次本人主页采集 ───
  // change nickname-capture-on-login：采真名是登录后的固定步骤，从「浏览会话开始」解耦——未绑人设、不开浏览会话也照采。
  private onFeedEntered(payload: FeedEnteredPayload): void {
    if (payload.trigger !== 'session_start') return;
    this.arm('会话开始');
  }

  /**
   * 登录引导触发（change nickname-capture-on-login）：边端登录确立身份后，云端直接武装一次本人主页采集，
   * 不经浏览会话、不被人设闸阻断（dispatcher 在启动闸拦下未绑人设账号时调用）。与 session_start 路径共用 arm()。
   */
  armLoginCapture(): void {
    this.arm('登录引导');
  }

  /** 武装采集（两触发共用）：守卫不过即 no-op；置挂起/在途/超时，命令延到边缘就绪（首个 page.cards）再发。 */
  private arm(via: string): void {
    if (!this.ctx.pendingNicknameCapture) return; // 库内已有昵称 / 占位账号 → 零扰动（已采过的不绕）
    if (this.ctx.selfCaptureInFlight) return; // 已在采集中，不重入
    if (this.ctx.selfCaptureAttempts >= this.ctx.selfCaptureMaxAttempts) return; // 采空退避，不永绕
    const accountId = this.getAccountId();
    if (!accountId || accountId === 'default') return; // 双保险：占位账号绝不采

    // 同步置「挂起浏览 + 在途标记 + 武装超时」：立刻挡住 R3 窗口（在途 page.cards 驱动的 open_note 被 chokepoint 丢弃），
    // 并让通知巡视准入据 selfCaptureInFlight 让位（二者都要独占边缘：进本人主页 vs 进通知页）。
    this.ctx.setBrowseSuspended(true);
    this.ctx.setSelfCaptureInFlight(true);
    this.awaitingEdgeReady = true;
    this.armTimeout(); // 兜底：即便边缘从不报 page.cards（静默 / 未登录），~20s 也恢复、不困死。
    // 命令延到「边缘就绪」再发：触发点（session_start / 登录 hello）都在握手同步窗口内——此刻边缘既未登记进
    // 可推送表（ws-server edges.set 在 await routeMessage 之后 → sent=0），也仍在初始扫 feed（命令循环未起 → 命令被丢）。
    // 故等首个 page.cards.arrived（初始扫描完、进命令循环、已登记）再 emit → profile_open 真送达且被执行。
    this.log(`${via}，需采登录账号昵称 account=${accountId} → 待边缘就绪（首个 page.cards）即驱动本人主页直驱`);
  }

  /** 边缘就绪信号（首个 page.cards.arrived：初始扫描完、进命令循环、已登记可推送）→ 此刻下发采集命令。 */
  private onEdgeReady(): void {
    if (!this.awaitingEdgeReady || !this.ctx.selfCaptureInFlight) return; // 未武装 / 已收尾 → 不发
    this.awaitingEdgeReady = false;
    const accountId = this.getAccountId();
    if (!accountId || accountId === 'default') return;
    this.armTimeout(); // 重置超时：从命令真正下发起算，给本人主页导航 + 抽取留足 ~20s。
    this.log(`边缘就绪 → 下发本人主页直驱采集 account=${accountId}（profile_open direct）`);
    this.emit('self.profile.capture', { accountId });
  }

  // ─── 本人主页资料到达：持久化非空昵称 + 回 feed（严格顺序，design D5）───
  private onDetailArrived(detail: ProfileDetailData, accountId?: string): void {
    // 身份判据（race-free）：detail.authorId === 连接 accountId 才是本人；普通作者浏览(authorId≠accountId) 忽略。
    if (!accountId || !detail.authorId || detail.authorId !== accountId) return;
    // 仅在本角色驱动的采集在途时收尾——防止已收尾/超时后到达的迟来本人 detail 再触发一次回 feed（重复 back）。
    // 注意：此标记只做「本次采集是否活跃」的去重门，不做身份判定（身份恒由上面的 authorId===accountId 决定）。
    if (!this.ctx.selfCaptureInFlight) return;

    const nick = (detail.nickname ?? '').trim();
    if (nick) {
      // 单写持久化（拒空、不阻塞回 feed）：失败仅告警；采到 → 本连接此后 pending=false（幂等，不再绕）。
      void Promise.resolve(this.setNicknameFn?.(accountId, nick)).catch((err) =>
        this.log(`持久化昵称失败（不阻塞回 feed）account=${accountId}: ${(err as Error).message}`),
      );
      this.ctx.setPendingNicknameCapture(false);
      this.log(`本人昵称采集成功 account=${accountId} nickname「${nick}」→ 已持久化、回 feed`);
    } else {
      const n = this.ctx.incrementSelfCaptureAttempts();
      this.log(`本人昵称采集为空（诚实空不写，DB 保持 NULL 待重试）account=${accountId} 第 ${n}/${this.ctx.selfCaptureMaxAttempts} 次 → 回 feed`);
    }
    // 严格顺序：取消超时 → 清在途标记 → 解除暂停 → emit back_to_feed（此时 browseSuspended 已清，返回 back 命令放行）。
    this.clearTimer();
    this.awaitingEdgeReady = false;
    this.ctx.setSelfCaptureInFlight(false);
    this.ctx.setBrowseSuspended(false);
    this.emit('feed.entered', { pageType: 'feed', trigger: 'back_to_feed', ts: Date.now() });
  }

  // ─── ~20s 兜底超时：edge 静默 / CDP 崩 → 清标记 + 恢复浏览 + 回 feed（绝不困死会话）───
  private armTimeout(): void {
    this.clearTimer();
    const handle = this.setTimeoutFn(() => this.onTimeout(), SessionContext.SELF_CAPTURE_TIMEOUT_MS);
    // unref：兜底定时器绝不拖住进程退出（与续场休息计时器同款）。注入桩可能无 unref，故守卫。
    if (handle && typeof (handle as { unref?: () => void }).unref === 'function') {
      (handle as { unref: () => void }).unref();
    }
    this.ctx.setSelfCaptureTimer(handle as ReturnType<typeof setTimeout>);
  }

  private onTimeout(): void {
    if (!this.ctx.selfCaptureInFlight) return; // 已被本人 detail 收尾 → 超时空响（防竞态双回 feed）
    this.ctx.setSelfCaptureTimer(null);
    this.awaitingEdgeReady = false;
    this.ctx.setSelfCaptureInFlight(false);
    this.ctx.setBrowseSuspended(false);
    this.log('本人昵称采集超时（edge 静默 ~20s）→ 恢复浏览、回 feed');
    this.emit('feed.entered', { pageType: 'feed', trigger: 'back_to_feed', ts: Date.now() });
  }

  private clearTimer(): void {
    const h = this.ctx.selfCaptureTimer;
    if (h !== null) {
      this.clearTimeoutFn(h);
      this.ctx.setSelfCaptureTimer(null);
    }
  }
}
