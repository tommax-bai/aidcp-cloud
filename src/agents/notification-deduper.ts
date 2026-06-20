/**
 * notification_deduper — 去重。
 *
 * 收 classified → 滤掉已通知过的项（与 ctx.notifiedItemKeys 比对，跨巡视保持，避免重复打扰）。
 * 有新项 → worthy（交 notifier 发飞书；去重水位仅在发送成功后由 notifier 推进——"仅成功路径推进"）；
 * 无新项/为空 → all_seen + category_handled{comments}（直接收尾本类，回首页转下一轮分诊）。
 *
 * 消费事件：notification.classified
 * 产出事件：notification.worthy / notification.all_seen / notification.category_handled{comments}
 */

import { BaseRole } from './base-role.js';
import type { RoleOptions } from './base-role.js';
import { SessionContext } from './session-context.js';
import type { RoleName } from '../event-bus/types.js';
import type { NotificationItem } from '../comm/protocol.js';

/** 去重主键：优先用边缘给的稳定 itemKey（笔记/评论链接），缺失则退化为 用户名|内容。 */
export function notificationItemKey(it: NotificationItem): string {
  return it.itemKey || `${it.fromUser}|${it.content}`;
}

export class NotificationDeduper extends BaseRole {
  readonly roleName: RoleName = 'notification_deduper';
  private readonly ctx: SessionContext;
  private unsubscribers: (() => void)[] = [];

  constructor(options: RoleOptions, ctx: SessionContext) {
    super(options);
    this.ctx = ctx;
  }

  subscribe(): void {
    this.unsubscribers.push(
      this.eventBus.on('notification.classified', (p) => this.dedupe(p.worthy, p.epoch)),
    );
  }

  unsubscribe(): void {
    for (const u of this.unsubscribers) u();
    this.unsubscribers = [];
  }

  private dedupe(worthy: NotificationItem[], epoch: number): void {
    if (!this.ctx.excursionActive) return;
    const list = worthy ?? [];
    const fresh = list.filter((it) => !this.ctx.isItemNotified(notificationItemKey(it)));
    if (fresh.length > 0) {
      this.log(`去重后 ${fresh.length}/${list.length} 条为新 epoch=${epoch}`);
      this.emit('notification.worthy', { items: fresh, epoch, ts: Date.now() });
    } else {
      this.log(`无新项（全部已通知或为空），本类收尾 epoch=${epoch}`);
      this.emit('notification.all_seen', { epoch, ts: Date.now() });
      this.emit('notification.category_handled', { category: 'comments', epoch, ts: Date.now() });
    }
  }
}
