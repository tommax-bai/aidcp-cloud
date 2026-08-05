/**
 * excursion_resumer — 恢复浏览（巡视终止的唯一收敛点）。
 *
 * 订阅**四类**终止入口，统一一次"关暂停 + 回信息流"，ctx.excursion.active 幂等（多终止只恢复一次）：
 *  - notification.triage_done：分诊收敛——三栏未读已清零（reason `triage_done`），或部分类到尝试上限被
 *    诚实放弃（reason `triage_incomplete:<类名>`，change guard-excursion-stall 起与前者分成两态）；
 *  - notification.classify_failed：评论分类异常；
 *  - 巡视命令回执 action.completed{ok:false}：赞收藏/新增关注进入失败（评论失败走空 items 正常收尾路径）；
 *  - **停滞兜底**（change guard-excursion-stall）：距上一次"巡视前进"超过 EXCURSION_STALL_TIMEOUT_MS。
 *
 * 为什么必须有第四条腿：前三条覆盖了巡视**所有已声明的结束方式**，看上去穷举；漏的是"巡视没有结束、
 * 也不会再结束"。一步"回执成功但语义走岔"（边缘把返回通知首页做成了回信息流、且回 ok:true）不产生
 * 任何终止信号 ⇒ 靠订阅终止信号收敛的设计对它结构上不可观测 ⇒ browseSuspended 永久为真、账号浏览
 * 无限期挂起且无人报警（2026-08-05 OL 实测）。少的那条腿只有计时器能补。
 *
 * 停滞兜底是**带上限的自愈通道**，不是终态判决：该失败结构性可恢复（同一步在重新加载后的页面上原样
 * 重来完全可能得到不同结果），故先花预算做一次**只读**重新对齐（重开通知首页、重读三栏计数），预算耗尽
 * 才诚实收尾。红线对照：① MUST NOT 直接落终态说"巡视失败"；② 自愈 MUST NOT 发分类栏点击——那是消费
 * 未读、无回滚的提交动作，本角色只发 notification.opening{reason:'open'}（首页，只读）；③ 收尾不推进
 * "已通知"水位，这批通知下次翻转仍会重新巡视，真消息不被静默吞掉。
 *
 * 务必在 emit feed.entered 之前 endExcursion（关暂停）——否则 back 命令会被发命令暂停出口扣住。
 *
 * 消费事件：notification.triage_done、notification.classify_failed、action.completed、
 *           excursion.requested + 各巡视前进信号（喂停滞计时器）
 * 产出事件：excursion.ended、feed.entered{back_to_feed}、notification.opening{reason:'open'}（自愈）
 */

import { BaseRole } from './base-role.js';
import type { RoleOptions } from './base-role.js';
import { SessionContext } from './session-context.js';
import type { RoleName } from '../event-bus/types.js';
import { EXCURSION_STALL_MAX_RECOVERIES, EXCURSION_STALL_TIMEOUT_MS } from '../risk/resume-limits.js';

/** 巡视命令集合（其回执 ok:false 视作巡视终止信号；ok:true 视作"巡视仍在前进"）。 */
const EXCURSION_ACTIONS = new Set([
  'open_notifications',
  'browse_notification_comments',
  'browse_notification_likes',
  'browse_notification_follows',
  'notification_back_home',
]);

export interface ExcursionResumerOptions extends RoleOptions {
  /** 停滞时限（毫秒）。缺省 EXCURSION_STALL_TIMEOUT_MS；测试可调小以缩短用例。 */
  stallTimeoutMs?: number;
  /** 停滞自愈预算（次）。缺省 EXCURSION_STALL_MAX_RECOVERIES。 */
  maxStallRecoveries?: number;
  /** 可注入定时器（测试用假时钟）；生产用真 setTimeout。 */
  setTimeoutFn?: (fn: () => void, ms: number) => unknown;
  clearTimeoutFn?: (handle: unknown) => void;
}

export class ExcursionResumer extends BaseRole {
  readonly roleName: RoleName = 'excursion_resumer';
  private readonly ctx: SessionContext;
  private readonly stallTimeoutMs: number;
  private readonly maxStallRecoveries: number;
  private readonly setTimeoutFn: (fn: () => void, ms: number) => unknown;
  private readonly clearTimeoutFn: (handle: unknown) => void;
  /** 停滞计时器句柄（瞬时态：resume / unsubscribe 必清，绝不跨场残留误触已结束的会话）。 */
  private stallTimer: unknown;
  /** 本趟巡视已消耗的自愈次数（**只由停滞消费**：健康巡视的导航 / 返回一次都不占）。 */
  private stallRecoveriesUsed = 0;
  private unsubscribers: (() => void)[] = [];

  constructor(options: ExcursionResumerOptions, ctx: SessionContext) {
    super(options);
    this.ctx = ctx;
    this.stallTimeoutMs = options.stallTimeoutMs ?? EXCURSION_STALL_TIMEOUT_MS;
    this.maxStallRecoveries = options.maxStallRecoveries ?? EXCURSION_STALL_MAX_RECOVERIES;
    this.setTimeoutFn = options.setTimeoutFn ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimeoutFn =
      options.clearTimeoutFn ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  }

  subscribe(): void {
    this.unsubscribers.push(
      this.eventBus.on('notification.triage_done', (p) => {
        // 三态拆分：真清零 vs 到尝试上限诚实放弃（givenUp 非空）。端到端可区分，MUST NOT 压成一态。
        const givenUp = p.givenUp ?? [];
        this.resume(p.epoch, givenUp.length > 0 ? `triage_incomplete:${givenUp.join(',')}` : 'triage_done');
      }),
      this.eventBus.on('notification.classify_failed', (p) => this.resume(p.epoch, `classify_failed:${p.reason}`)),
      this.eventBus.on('action.completed', (p) => {
        if (!EXCURSION_ACTIONS.has(p.action)) return;
        if (p.ok === false) {
          this.resume(this.ctx.excursionEpoch ?? 0, `cmd_failed:${p.action}`);
          return;
        }
        this.noteProgress(); // 一条巡视命令真被执行完 = 还在动
      }),

      // ─── 停滞计时器：起算 / 重排 ───
      // 起算于巡视开启；此后每一个"巡视仍在前进"的证据重排。
      // 刻意**不**订阅 page.cards.arrived 等非巡视上报——巡视走岔时恰恰是它在让停滞"看起来还活着"，
      // 把它算作前进，这道兜底就在它本该抓住的那一类上恒不触发。
      this.eventBus.on('excursion.requested', () => {
        this.stallRecoveriesUsed = 0;
        this.armStallTimer();
      }),
      this.eventBus.on('notification.opening', () => this.noteProgress()),
      this.eventBus.on('notification.home.arrived', () => this.noteProgress()),
      this.eventBus.on('notification.category_selected', () => this.noteProgress()),
      this.eventBus.on('notification.items.arrived', () => this.noteProgress()),
    );
  }

  unsubscribe(): void {
    for (const u of this.unsubscribers) u();
    this.unsubscribers = [];
    // 计时器是瞬时态：角色实例跨会话复用（endSession 只 unsubscribe），残留会误触已结束的会话。
    this.clearStallTimer();
    this.stallRecoveriesUsed = 0;
  }

  /** 一条"巡视仍在前进"的证据：重排停滞时限。非巡视期不重排（杂散事件不该续命一个不存在的巡视）。 */
  private noteProgress(): void {
    if (!this.ctx.excursionActive) return;
    this.armStallTimer();
  }

  private armStallTimer(): void {
    this.clearStallTimer();
    this.stallTimer = this.setTimeoutFn(() => this.onStall(), this.stallTimeoutMs);
    (this.stallTimer as { unref?: () => void } | undefined)?.unref?.();
  }

  private clearStallTimer(): void {
    if (this.stallTimer === undefined) return;
    this.clearTimeoutFn(this.stallTimer);
    this.stallTimer = undefined;
  }

  /**
   * 停滞时限到点：巡视超过 stallTimeoutMs 没有任何前进证据。
   * 预算未耗尽 ⇒ 花一次做**只读**重新对齐（重开通知首页）；耗尽 ⇒ 诚实收尾。
   */
  private onStall(): void {
    this.stallTimer = undefined;
    if (!this.ctx.excursionActive) return; // 二道闸：巡视已由其它入口收尾
    const epoch = this.ctx.excursionEpoch ?? 0;
    const phase = this.ctx.excursion.phase;
    const seconds = Math.round(this.stallTimeoutMs / 1000);

    if (this.stallRecoveriesUsed < this.maxStallRecoveries) {
      this.stallRecoveriesUsed += 1; // 恢复预算只由停滞消费
      console.warn(
        `[ExcursionResumer] 巡视停滞 ${seconds}s 无进展（phase=${phase} epoch=${epoch}）→ ` +
          `第 ${this.stallRecoveriesUsed}/${this.maxStallRecoveries} 次只读重新对齐（重开通知首页、重读三栏计数；不点分类栏）`,
      );
      // 只读重新对齐：不假设浏览器现在在哪（走岔时它可能已在信息流），open_notifications 从任何页都能拽回。
      // 属巡视命令集 ⇒ 能穿过自己设的浏览暂停开关。MUST NOT 在此发 browse_notification_*（提交点）。
      this.emit('notification.opening', { epoch, reason: 'open', ts: Date.now() });
      // 显式重排（不依赖自己那条 notification.opening 订阅的自喂回环——兄弟订阅者的异常不该让本表停摆）：
      // 自愈也可能落空，必须继续计时，下一次到点走诚实收尾。armStallTimer 幂等（先清后设）。
      this.armStallTimer();
      return;
    }

    console.warn(
      `[ExcursionResumer] 巡视停滞兜底收尾：${seconds}s 无进展且自愈预算已耗尽` +
        `（used=${this.stallRecoveriesUsed}/${this.maxStallRecoveries} phase=${phase} epoch=${epoch}）→ ` +
        '解除浏览暂停 + 回信息流。这不是「巡视失败」终态：已通知水位未推进，下次未读翻转仍会重新巡视',
    );
    this.resume(epoch, `stalled_no_progress:${phase}`);
  }

  private resume(epoch: number, reason: string): void {
    if (!this.ctx.excursionActive) return; // 幂等：已恢复则忽略后续终止信号
    this.clearStallTimer(); // 收尾即停表（含由显式终止信号收尾的正常路径）
    if (this.stallRecoveriesUsed > 0 && !reason.startsWith('stalled_')) {
      // 一次成功的抢救 MUST 留痕——否则它与「从来没出过事」在观测上不可区分。
      console.warn(
        `[ExcursionResumer] 本趟巡视曾被停滞兜底救回（自愈 ${this.stallRecoveriesUsed} 次）后正常收尾（${reason}）epoch=${epoch}`,
      );
    }
    const sourcePageType = this.ctx.sourcePageType;
    this.ctx.endExcursion(); // 关暂停 + 清瞬时态（必须在 emit feed.entered 之前）
    this.stallRecoveriesUsed = 0;
    this.log(`巡视结束（${reason}），恢复浏览 epoch=${epoch}`);
    this.emit('excursion.ended', { epoch, reason, ts: Date.now() });
    this.emit('feed.entered', { pageType: sourcePageType, trigger: 'back_to_feed', ts: Date.now() });
  }
}
