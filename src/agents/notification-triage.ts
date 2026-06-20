/**
 * notification_triage — 分诊（拟人优先级 + 必收敛）。
 *
 * 收 notification.home.arrived → 在通知首页按优先级（评论和@ > 赞和收藏 > 新增关注）挑
 * "有未读 且 本趟未处理"的最高类；选中即记入 processedCategories（即使红点没清也不会重挑，
 * 最多 3 轮必收敛）→ category_selected；无可处理 → triage_done。
 *
 * 消费事件：notification.home.arrived
 * 产出事件：notification.category_selected / notification.triage_done
 */

import { BaseRole } from './base-role.js';
import type { RoleOptions } from './base-role.js';
import { SessionContext } from './session-context.js';
import type { RoleName, NotificationCategory } from '../event-bus/types.js';

/** 拟人优先级：评论和@ 最高，其次赞和收藏，最后新增关注。 */
const PRIORITY: NotificationCategory[] = ['comments', 'likes', 'follows'];

export class NotificationTriage extends BaseRole {
  readonly roleName: RoleName = 'notification_triage';
  private readonly ctx: SessionContext;
  private unsubscribers: (() => void)[] = [];

  constructor(options: RoleOptions, ctx: SessionContext) {
    super(options);
    this.ctx = ctx;
  }

  subscribe(): void {
    this.unsubscribers.push(
      this.eventBus.on('notification.home.arrived', (p) => this.triage(p)),
    );
  }

  unsubscribe(): void {
    for (const u of this.unsubscribers) u();
    this.unsubscribers = [];
  }

  private triage(home: { comments: number; likes: number; follows: number }): void {
    if (!this.ctx.excursionActive) return; // 非巡视期的杂散首页上报，忽略
    const epoch = this.ctx.excursionEpoch ?? 0;
    const counts: Record<NotificationCategory, number> = {
      comments: home.comments,
      likes: home.likes,
      follows: home.follows,
    };
    for (const cat of PRIORITY) {
      if (counts[cat] > 0 && !this.ctx.isCategoryProcessed(cat)) {
        this.ctx.markCategoryProcessed(cat); // 选中即记账：红点没清也不重挑，保证收敛
        this.log(`选中分类 ${cat}（未读 ${counts[cat]}）epoch=${epoch}`);
        this.emit('notification.category_selected', { category: cat, epoch, ts: Date.now() });
        return;
      }
    }
    this.log(`无可处理分类，分诊完成 epoch=${epoch}`);
    this.emit('notification.triage_done', { epoch, ts: Date.now() });
  }
}
