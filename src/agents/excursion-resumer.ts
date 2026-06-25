/**
 * excursion_resumer — 恢复浏览（收敛所有终止，无计时器）。
 *
 * 订阅所有终止信号，统一一次"关暂停 + 回信息流"，ctx.excursion.active 幂等（多终止只恢复一次）：
 *  - notification.triage_done：正常收尾——三栏未读已清零，或剩余未读已到尝试上限被诚实放弃
 *    （change notification-clear-to-zero：loop-to-zero 的单一收敛出口，本角色逻辑不变）；
 *  - notification.classify_failed：评论分类异常；
 *  - 巡视命令回执 action.completed{ok:false}：赞收藏/新增关注进入失败（评论失败走空 items 正常收尾路径）。
 * 务必在 emit feed.entered 之前 endExcursion（关暂停）——否则 back 命令会被发命令暂停出口扣住。
 *
 * 消费事件：notification.triage_done、notification.classify_failed、action.completed{ok:false}
 * 产出事件：excursion.ended、feed.entered{back_to_feed}
 */

import { BaseRole } from './base-role.js';
import type { RoleOptions } from './base-role.js';
import { SessionContext } from './session-context.js';
import type { RoleName } from '../event-bus/types.js';

/** 巡视命令集合（其回执 ok:false 视作巡视终止信号）。 */
const EXCURSION_ACTIONS = new Set([
  'open_notifications',
  'browse_notification_comments',
  'browse_notification_likes',
  'browse_notification_follows',
  'notification_back_home',
]);

export class ExcursionResumer extends BaseRole {
  readonly roleName: RoleName = 'excursion_resumer';
  private readonly ctx: SessionContext;
  private unsubscribers: (() => void)[] = [];

  constructor(options: RoleOptions, ctx: SessionContext) {
    super(options);
    this.ctx = ctx;
  }

  subscribe(): void {
    this.unsubscribers.push(
      this.eventBus.on('notification.triage_done', (p) => this.resume(p.epoch, 'triage_done')),
      this.eventBus.on('notification.classify_failed', (p) => this.resume(p.epoch, `classify_failed:${p.reason}`)),
      this.eventBus.on('action.completed', (p) => {
        if (p.ok === false && EXCURSION_ACTIONS.has(p.action)) {
          this.resume(this.ctx.excursionEpoch ?? 0, `cmd_failed:${p.action}`);
        }
      }),
    );
  }

  unsubscribe(): void {
    for (const u of this.unsubscribers) u();
    this.unsubscribers = [];
  }

  private resume(epoch: number, reason: string): void {
    if (!this.ctx.excursionActive) return; // 幂等：已恢复则忽略后续终止信号
    const sourcePageType = this.ctx.sourcePageType;
    this.ctx.endExcursion(); // 关暂停 + 清瞬时态（必须在 emit feed.entered 之前）
    this.log(`巡视结束（${reason}），恢复浏览 epoch=${epoch}`);
    this.emit('excursion.ended', { epoch, reason, ts: Date.now() });
    this.emit('feed.entered', { pageType: sourcePageType, trigger: 'back_to_feed', ts: Date.now() });
  }
}
