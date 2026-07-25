/**
 * NicknameEnricher — 登录账号真实昵称采集角色（change account-real-nickname）。
 *
 * 职责（纯云端编排，edge 纯执行）：按平台注册表选择固定副作用的本人身份读取命令，
 * 读回关联观察、差异持久化，并仅在命令确实离开 feed 时返回。
 *
 * 消费事件：
 *   - page.cards.arrived{startupId}：每个完整 Edge/browser 启动代号的首批 cards 才触发一次昵称采集；
 *     需要导航的平台同步暂停自主浏览；就地读取平台不暂停。
 *   - identity.observed.arrived：同时校验 captureId 与连接 accountId，非空昵称差异写库。
 * 产出事件：仅需要恢复 feed 时 emit feed.entered{back_to_feed}。
 *
 * 隔离红线：本人身份观察独立于普通作者 profile.detail；captureId 防迟到串代，accountId 防跨账号串写。
 *
 * 有界 / 幂等 / 中性：~20s 超时兜底（edge 静默/CDP 崩不困死会话，最坏滞留从 1h→~20s）；采空 K 次退避
 * （genuinely 抽不到的主页不永绕）；采到非空后仅等下一个完整启动代号再检测昵称变化；
 * 身份读取不触风控/预算/节奏。
 *
 * 不使用 LLM，纯确定性执行。
 */

import { randomUUID } from 'node:crypto';
import { BaseRole } from './base-role.js';
import type { RoleOptions } from './base-role.js';
import { SessionContext } from './session-context.js';
import type { RoleName } from '../event-bus/types.js';
import type { IdentityObservedPayload } from '../comm/protocol.js';

export interface NicknameCapturePlan {
  command: 'identity.read_current' | 'identity.read_self_profile';
  restore: 'none' | 'feed';
}

export interface NicknameEnricherDeps {
  sessionContext: SessionContext;
  /** 该连接当前账号（= 本人主页 id）；会话开始时已由握手 setCurrentAccountId 设为真实账号。 */
  getAccountId: () => string;
  /** 解析当前平台与已握手 Edge 能力后的采集计划；不支持或版本偏斜时返回 null。 */
  getCapturePlan: () => NicknameCapturePlan | null;
  /** 下发关联的固定副作用命令；返回 false 表示未下发。 */
  requestIdentityCapture: (request: NicknameCapturePlan & { captureId: string }) => boolean;
  /** 关联 id 生成器；测试可注入。 */
  createCaptureId?: () => string;
  /** 读取系统已记录昵称；用于启动刷新时避免同名重复写库。 */
  getNickname?: (accountId: string) => string | null;
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
  private readonly getCapturePlan: () => NicknameCapturePlan | null;
  private readonly requestIdentityCapture: NicknameEnricherDeps['requestIdentityCapture'];
  private readonly createCaptureId: () => string;
  private readonly getNicknameFn?: (accountId: string) => string | null;
  private readonly setNicknameFn?: (accountId: string, nickname: string) => Promise<void> | void;
  private readonly setTimeoutFn: (fn: () => void, ms: number) => unknown;
  private readonly clearTimeoutFn: (handle: unknown) => void;
  private unsubscribers: (() => void)[] = [];
  /** 采集已武装、等边缘就绪（首个 page.cards.arrived）再下发命令；下发后置 false。 */
  private awaitingEdgeReady = false;
  private activePlan: NicknameCapturePlan | null = null;
  private activeCaptureId: string | null = null;
  private readonly consumedStartupIds = new Set<string>();
  private readonly consumedStartupOrder: string[] = [];

  constructor(options: RoleOptions & NicknameEnricherDeps) {
    super(options);
    this.ctx = options.sessionContext;
    this.getAccountId = options.getAccountId;
    this.getCapturePlan = options.getCapturePlan;
    this.requestIdentityCapture = options.requestIdentityCapture;
    this.createCaptureId = options.createCaptureId ?? randomUUID;
    this.getNicknameFn = options.getNickname;
    this.setNicknameFn = options.setNickname;
    this.setTimeoutFn = options.setTimeoutFn ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimeoutFn = options.clearTimeoutFn ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  }

  subscribe(): void {
    this.unsubscribers.push(
      this.eventBus.on('page.cards.arrived', (p) => this.onPageCardsArrived(p)),
      this.eventBus.on('identity.observed.arrived', (p) =>
        this.onIdentityObserved(p.observation, p.accountId),
      ),
    );
  }

  unsubscribe(): void {
    for (const unsub of this.unsubscribers) unsub();
    this.unsubscribers = [];
    this.clearTimer();
  }

  private onPageCardsArrived(payload: { startupId?: string }): void {
    const startupId = typeof payload.startupId === 'string' ? payload.startupId.trim() : '';
    if (startupId) this.armStartupCapture(startupId);
    this.onEdgeReady();
  }

  /** 完整启动首批 page.cards 触发：守卫不过即 no-op；同一 startupId 只消费一次。 */
  private armStartupCapture(startupId: string): void {
    if (this.consumedStartupIds.has(startupId)) return; // 同一浏览器启动代号只采一次
    const plan = this.getCapturePlan();
    if (!plan) {
      this.rememberStartupId(startupId);
      this.log(`identity_capture_command_unavailable startup=${startupId}`);
      return;
    }
    if (this.ctx.selfCaptureInFlight) return; // 已在采集中，不重入
    if (this.ctx.selfCaptureAttempts >= this.ctx.selfCaptureMaxAttempts) return; // 采空退避，不永绕
    const accountId = this.getAccountId();
    if (!accountId) return; // honest-fail：缺账号不采（retire-default-account：default 已退役，无占位账号需跳过）
    this.rememberStartupId(startupId);

    // 同步置「挂起浏览 + 在途标记 + 武装超时」：立刻挡住 R3 窗口（在途 page.cards 驱动的 open_note 被 chokepoint 丢弃），
    // 并让通知巡视准入据 selfCaptureInFlight 让位（二者都要独占边缘：进本人主页 vs 进通知页）。
    this.ctx.setPendingNicknameCapture(true);
    this.ctx.setBrowseSuspended(plan.restore === 'feed');
    this.ctx.setSelfCaptureInFlight(true);
    this.activePlan = plan;
    this.awaitingEdgeReady = true;
    this.armTimeout(); // 兜底：即便边缘从不报 page.cards（静默 / 未登录），~20s 也恢复、不困死。
    this.log(
      `完整启动首批 page.cards startup=${startupId}，需采登录账号昵称 account=${accountId} command=${plan.command}`,
    );
  }

  private rememberStartupId(startupId: string): void {
    this.consumedStartupIds.add(startupId);
    this.consumedStartupOrder.push(startupId);
    while (this.consumedStartupOrder.length > 50) {
      const old = this.consumedStartupOrder.shift();
      if (old) this.consumedStartupIds.delete(old);
    }
  }

  /** 边缘就绪信号（带 startupId 的首个 page.cards.arrived）→ 此刻下发采集命令。 */
  private onEdgeReady(): void {
    if (!this.awaitingEdgeReady || !this.ctx.selfCaptureInFlight) return; // 未武装 / 已收尾 → 不发
    this.awaitingEdgeReady = false;
    const accountId = this.getAccountId();
    if (!accountId) {
      this.finishCapture('not_sent');
      return;
    }
    const plan = this.activePlan;
    if (!plan) return;
    const captureId = this.createCaptureId();
    this.activeCaptureId = captureId;
    this.armTimeout();
    const sent = this.requestIdentityCapture({ ...plan, captureId });
    if (!sent) {
      this.log(`本人身份采集命令未下发 account=${accountId} command=${plan.command}`);
      this.finishCapture('not_sent');
      return;
    }
    this.log(`边缘就绪 → 下发本人身份采集 account=${accountId} command=${plan.command} capture=${captureId}`);
  }

  private onIdentityObserved(observation: IdentityObservedPayload, accountId?: string): void {
    if (!this.ctx.selfCaptureInFlight) return;
    if (!accountId || observation.accountId !== accountId) return;
    if (!this.activeCaptureId || observation.captureId !== this.activeCaptureId) return;
    const plan = this.activePlan;
    if (!plan) return;
    const expected =
      plan.command === 'identity.read_current'
        ? observation.source === 'current_page' && observation.pageEffect === 'none'
        : observation.source === 'self_profile' && observation.pageEffect === 'navigated_self_profile';
    if (!expected) return;

    const nick = (observation.nickname ?? '').trim();
    const completion = plan.restore === 'feed' ? '回 feed' : '留在当前页';
    if (nick) {
      // 单写持久化（拒空、不阻塞回 feed）：失败仅告警；pending 保持 true，让后续任务启动继续刷新昵称。
      const current = (this.getNicknameFn?.(accountId) ?? '').trim();
      if (current !== nick) {
        void Promise.resolve(this.setNicknameFn?.(accountId, nick)).catch((err) =>
          this.log(`持久化昵称失败（不阻塞回 feed）account=${accountId}: ${(err as Error).message}`),
        );
        this.log(`本人昵称采集成功 account=${accountId} nickname「${nick}」→ 已${current ? '更新' : '持久化'}、${completion}`);
      } else {
        this.log(`本人昵称采集成功 account=${accountId} nickname「${nick}」→ 与系统昵称一致，不重复写、${completion}`);
      }
    } else {
      const n = this.ctx.incrementSelfCaptureAttempts();
      this.log(`本人昵称采集为空（诚实空不写，DB 保持 NULL 待重试）account=${accountId} 第 ${n}/${this.ctx.selfCaptureMaxAttempts} 次 → ${completion}`);
    }
    this.finishCapture('observed');
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
    this.log('本人昵称采集超时（edge 静默 ~20s）');
    this.finishCapture('timeout');
  }

  private finishCapture(reason: 'observed' | 'not_sent' | 'timeout'): void {
    const plan = this.activePlan;
    this.clearTimer();
    this.awaitingEdgeReady = false;
    this.activeCaptureId = null;
    this.activePlan = null;
    this.ctx.setSelfCaptureInFlight(false);
    this.ctx.setBrowseSuspended(false);
    if (plan?.restore === 'feed') {
      this.emit('feed.entered', {
        pageType: 'feed',
        trigger: reason === 'not_sent' ? 'session_start' : 'back_to_feed',
        ts: Date.now(),
      });
    }
  }

  private clearTimer(): void {
    const h = this.ctx.selfCaptureTimer;
    if (h !== null) {
      this.clearTimeoutFn(h);
      this.ctx.setSelfCaptureTimer(null);
    }
  }
}
