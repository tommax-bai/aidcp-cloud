/**
 * notification_follow_browser — 新增关注浏览（v1 看一眼清未读，不抽取、不发飞书）。
 *
 * 收 category_selected{follows} → browse_category{follows}（→ browse_notification_follows 命令）；
 * 收边缘回执 action.completed{browse_notification_follows, ok:true} → category_handled{follows}。
 * ok:false 交给 excursion_resumer 统一恢复（避免双发返回命令）。
 *
 * 消费事件：notification.category_selected{follows}、action.completed{browse_notification_follows}
 * 产出事件：notification.browse_category{follows}、notification.category_handled{follows}
 */

import { BaseRole } from './base-role.js';
import type { RoleOptions } from './base-role.js';
import { SessionContext } from './session-context.js';
import type { RoleName } from '../event-bus/types.js';

export class NotificationFollowBrowser extends BaseRole {
  readonly roleName: RoleName = 'notification_follow_browser';
  private readonly ctx: SessionContext;
  private unsubscribers: (() => void)[] = [];

  constructor(options: RoleOptions, ctx: SessionContext) {
    super(options);
    this.ctx = ctx;
  }

  subscribe(): void {
    this.unsubscribers.push(
      this.eventBus.on('notification.category_selected', (p) => {
        if (p.category !== 'follows' || !this.ctx.excursionActive) return;
        this.log(`进入新增关注浏览(看一眼清未读) epoch=${p.epoch}`);
        this.emit('notification.browse_category', { category: 'follows', epoch: p.epoch, ts: Date.now() });
      }),
      this.eventBus.on('action.completed', (p) => {
        if (p.action !== 'browse_notification_follows' || !p.ok || !this.ctx.excursionActive) return;
        const epoch = this.ctx.excursionEpoch ?? 0;
        this.log(`新增关注已看过 epoch=${epoch}`);
        this.emit('notification.category_handled', { category: 'follows', epoch, ts: Date.now() });
      }),
    );
  }

  unsubscribe(): void {
    for (const u of this.unsubscribers) u();
    this.unsubscribers = [];
  }
}
