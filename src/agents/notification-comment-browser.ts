/**
 * notification_comment_browser — 评论和@浏览。
 *
 * 收 category_selected{comments} → 决定滚动加载量 → browse_category{comments}
 * （dispatcher 翻译为 browse_notification_comments 命令；边缘进「评论和@」滚动抽取原始项，
 * 经 notification.items 回传 → classifier）。
 *
 * 消费事件：notification.category_selected{comments}
 * 产出事件：notification.browse_category{comments}
 */

import { BaseRole } from './base-role.js';
import type { RoleOptions } from './base-role.js';
import { SessionContext } from './session-context.js';
import type { RoleName } from '../event-bus/types.js';

/** 评论和@ 列表滚动加载次数（边缘按实际可滚截断）。 */
const COMMENT_SCROLL_MAX = 3;

export class NotificationCommentBrowser extends BaseRole {
  readonly roleName: RoleName = 'notification_comment_browser';
  private readonly ctx: SessionContext;
  private unsubscribers: (() => void)[] = [];

  constructor(options: RoleOptions, ctx: SessionContext) {
    super(options);
    this.ctx = ctx;
  }

  subscribe(): void {
    this.unsubscribers.push(
      this.eventBus.on('notification.category_selected', (p) => {
        if (p.category !== 'comments' || !this.ctx.excursionActive) return;
        this.log(`进入评论和@浏览 epoch=${p.epoch}`);
        this.emit('notification.browse_category', {
          category: 'comments',
          epoch: p.epoch,
          scrollMax: COMMENT_SCROLL_MAX,
          ts: Date.now(),
        });
      }),
    );
  }

  unsubscribe(): void {
    for (const u of this.unsubscribers) u();
    this.unsubscribers = [];
  }
}
