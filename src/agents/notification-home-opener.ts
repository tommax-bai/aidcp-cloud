/**
 * notification_home_opener — 打开通知首页。
 *
 * 收 browse.suspended → 安全点导航到通知首页：emit notification.opening{reason:'open'}
 * （dispatcher 翻译为 open_notifications 命令；边缘导航后上报各类未读 notification.home → 分诊）。
 *
 * 消费事件：browse.suspended
 * 产出事件：notification.opening{reason:'open'}
 */

import { BaseRole } from './base-role.js';
import type { RoleOptions } from './base-role.js';
import { SessionContext } from './session-context.js';
import type { RoleName } from '../event-bus/types.js';

export class NotificationHomeOpener extends BaseRole {
  readonly roleName: RoleName = 'notification_home_opener';
  private readonly ctx: SessionContext;
  private unsubscribers: (() => void)[] = [];

  constructor(options: RoleOptions, ctx: SessionContext) {
    super(options);
    this.ctx = ctx;
  }

  subscribe(): void {
    this.unsubscribers.push(
      this.eventBus.on('browse.suspended', (p) => {
        this.ctx.setExcursionPhase('opening');
        this.log(`打开通知首页 epoch=${p.epoch}`);
        this.emit('notification.opening', { epoch: p.epoch, reason: 'open', ts: Date.now() });
      }),
    );
  }

  unsubscribe(): void {
    for (const u of this.unsubscribers) u();
    this.unsubscribers = [];
  }
}
