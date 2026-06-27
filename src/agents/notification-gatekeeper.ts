/**
 * notification_gatekeeper — 通知巡视准入。
 *
 * 两查（同步、无 LLM）：① 硬暂停（验证码/人工接管）中？② 已有巡视在跑？任一为真则忽略。
 * 通过 → 同步开一次巡视（写 ctx.excursion，check-then-set 防并发重入）→ excursion.requested。
 *
 * 刻意不再判「该 epoch 已处理过」（change notification-clear-to-zero）：真有新消息（无→有翻转）就处理，
 * 不因「处理过一次」而在有新消息时拒绝。并发由「已有巡视在跑」闸防止；巡视途中到达的新一波由
 * 正在跑的清零循环重读计数时自然吸收。再触发的去重交给「未读真清零 → 下一次无→有翻转」。
 *
 * 消费事件：notification.detected.arrived
 * 产出事件：excursion.requested
 */

import { BaseRole } from './base-role.js';
import type { RoleOptions } from './base-role.js';
import { SessionContext } from './session-context.js';
import type { RoleName } from '../event-bus/types.js';

export interface NotificationGatekeeperOptions extends RoleOptions {
  /** 硬暂停闸（验证码/人工接管）：硬暂停期连帧都不发，不该再叠通知巡视。缺省永不硬停。 */
  isHardPaused?: (edgeId?: string) => boolean;
}

export class NotificationGatekeeper extends BaseRole {
  readonly roleName: RoleName = 'notification_gatekeeper';
  private readonly ctx: SessionContext;
  private readonly isHardPaused: (edgeId?: string) => boolean;
  private unsubscribers: (() => void)[] = [];

  constructor(options: NotificationGatekeeperOptions, ctx: SessionContext) {
    super(options);
    this.ctx = ctx;
    this.isHardPaused = options.isHardPaused ?? (() => false);
  }

  subscribe(): void {
    this.unsubscribers.push(
      this.eventBus.on('notification.detected.arrived', (p) => this.admit(p.epoch, p.edgeId)),
    );
  }

  unsubscribe(): void {
    for (const u of this.unsubscribers) u();
    this.unsubscribers = [];
  }

  private admit(epoch: number, edgeId?: string): void {
    if (this.isHardPaused(edgeId)) { this.log(`硬暂停中，放弃巡视 epoch=${epoch}`); return; }
    // 让位本人昵称采集（change account-real-nickname）：采集在途时不开巡视——二者都要独占边缘（进本人主页 vs 进通知页）。
    // 采集是登录后一次性首动作（仅库内昵称空时），~20s 内必收尾（成功/超时）；其后下一次未读检测再正常准入。
    if (this.ctx.selfCaptureInFlight) { this.log(`本人昵称采集在途，巡视让位 epoch=${epoch}`); return; }
    if (this.ctx.excursionActive) { this.log(`已有巡视在跑，忽略 epoch=${epoch}`); return; }
    this.ctx.beginExcursion(epoch);
    this.log(`准入通过，开启巡视 epoch=${epoch}`);
    this.emit('excursion.requested', { epoch, ts: Date.now() });
  }
}
