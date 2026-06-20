/**
 * notification_like_browser — 赞和收藏浏览（v1 看一眼清未读，不抽取、不发飞书）。
 *
 * 收 category_selected{likes} → browse_category{likes}（→ browse_notification_likes 命令）；
 * 收边缘回执 action.completed{browse_notification_likes, ok:true} → category_handled{likes}
 * （触发返回首页 + 分诊下一轮）。ok:false 不在此收尾——交给 excursion_resumer 统一恢复，
 * 否则会与 resumer 双发"返回"命令打架。
 *
 * 消费事件：notification.category_selected{likes}、action.completed{browse_notification_likes}
 * 产出事件：notification.browse_category{likes}、notification.category_handled{likes}
 */

import { BaseRole } from './base-role.js';
import type { RoleOptions } from './base-role.js';
import { SessionContext } from './session-context.js';
import type { RoleName } from '../event-bus/types.js';

export class NotificationLikeBrowser extends BaseRole {
  readonly roleName: RoleName = 'notification_like_browser';
  private readonly ctx: SessionContext;
  private unsubscribers: (() => void)[] = [];

  constructor(options: RoleOptions, ctx: SessionContext) {
    super(options);
    this.ctx = ctx;
  }

  subscribe(): void {
    this.unsubscribers.push(
      this.eventBus.on('notification.category_selected', (p) => {
        if (p.category !== 'likes' || !this.ctx.excursionActive) return;
        this.log(`进入赞和收藏浏览（看一眼清未读）epoch=${p.epoch}`);
        this.emit('notification.browse_category', { category: 'likes', epoch: p.epoch, ts: Date.now() });
      }),
      this.eventBus.on('action.completed', (p) => {
        if (p.action !== 'browse_notification_likes' || !p.ok || !this.ctx.excursionActive) return;
        const epoch = this.ctx.excursionEpoch ?? 0;
        this.log(`赞和收藏已看过 epoch=${epoch}`);
        this.emit('notification.category_handled', { category: 'likes', epoch, ts: Date.now() });
      }),
    );
  }

  unsubscribe(): void {
    for (const u of this.unsubscribers) u();
    this.unsubscribers = [];
  }
}
