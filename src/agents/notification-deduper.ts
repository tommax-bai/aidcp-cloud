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

/**
 * 剥**尾部**相对时间戳（「… 刚刚 / N分钟前 / 昨天 / MM-DD / YYYY-MM-DD」）。
 * 回退去重键含正文，而平台把时间戳渲染在评论行**末尾**；跨巡视时间会漂移（「3分钟前」→「8分钟前」）
 * → 同一条评论键变化 → 重复打扰（NCQ-3）。剥掉尾部时间戳后键跨巡视稳定。
 *
 * **只锚定尾部**：绝不剥正文内联的数字/日期（如「打折5-1活动」「价格12-25元」「我3年前去过」），
 * 否则两条仅内联 token 不同的评论会撞键、第二条被当已通知**静默丢失**（lose-real-data 红线）。
 */
export function stripRelativeTime(s: string): string {
  return (s || '')
    .replace(/\s*(刚刚|\d+\s*(秒|分钟|分|小时|天|周|个?月|年)前|昨天|今天|前天|\d{4}-\d{1,2}-\d{1,2}|\d{1,2}-\d{1,2})\s*$/, '')
    .trim();
}

/**
 * 去重主键：优先用边缘给的**稳定且 per-comment 的** itemKey；缺失（或仅 per-user profile 链——会把同人多条评论
 * 撞成一个键、静默折叠丢失，故排除）则退化为 用户名|剥时间后的正文。
 * 注：itemKey 究竟是 per-comment 还是 per-note 链需真机校准 item(a) 坐实；若真机发现是 per-note，再在此纳入正文。
 */
export function notificationItemKey(it: NotificationItem): string {
  const k = it.itemKey;
  if (k && !/\/user\/profile\//.test(k)) return k;
  return `${(it.fromUser || '').trim()}|${stripRelativeTime(it.content || '')}`;
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
