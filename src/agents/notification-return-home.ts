/**
 * notification_return_home — 返回通知首页。
 *
 * 收 category_handled → 一类处理完，返回通知首页：emit notification.opening{reason:'back'}
 * （dispatcher 翻译为 notification_back_home 命令；边缘重报各类未读 → 分诊下一轮）。
 * 巡视已结束（resumer 已恢复）则忽略——避免在已返回信息流后又拽回通知页。
 *
 * 消费事件：notification.category_handled
 * 产出事件：notification.opening{reason:'back'}
 */

import { BaseRole } from './base-role.js';
import type { RoleOptions } from './base-role.js';
import { SessionContext } from './session-context.js';
import type { RoleName } from '../event-bus/types.js';

export class NotificationReturnHome extends BaseRole {
  readonly roleName: RoleName = 'notification_return_home';
  private readonly ctx: SessionContext;
  private unsubscribers: (() => void)[] = [];

  constructor(options: RoleOptions, ctx: SessionContext) {
    super(options);
    this.ctx = ctx;
  }

  subscribe(): void {
    this.unsubscribers.push(
      this.eventBus.on('notification.category_handled', (p) => {
        if (!this.ctx.excursionActive) return;
        this.log(`分类 ${p.category} 处理完，返回通知首页 epoch=${p.epoch}`);
        this.emit('notification.opening', { epoch: p.epoch, reason: 'back', ts: Date.now() });
      }),
    );
  }

  unsubscribe(): void {
    for (const u of this.unsubscribers) u();
    this.unsubscribers = [];
  }
}
