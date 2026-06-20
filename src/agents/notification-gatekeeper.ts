/**
 * notification_gatekeeper — 通知巡视准入。
 *
 * 三查（同步、无 LLM）：① 硬暂停（验证码/人工接管）中？② 已有巡视在跑？③ 该 epoch 已处理过？
 * 任一为真则忽略。通过 → 同步开一次巡视（写 ctx.excursion，check-then-set 防并发重入）→ excursion.requested。
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
    if (this.ctx.excursionActive) { this.log(`已有巡视在跑，忽略 epoch=${epoch}`); return; }
    const last = this.ctx.excursion.lastHandledEpoch;
    if (last !== null && epoch <= last) { this.log(`epoch=${epoch} 已处理过（last=${last}），忽略`); return; }
    this.ctx.beginExcursion(epoch);
    this.log(`准入通过，开启巡视 epoch=${epoch}`);
    this.emit('excursion.requested', { epoch, ts: Date.now() });
  }
}
