/**
 * notification_notifier — 发飞书。
 *
 * 收 worthy → 推飞书（复用注入闭包，走 server 的 messenger + resolveChatId，不走命令通道、
 * 不在恢复关键路径上）。成功才推进去重水位（markItemNotified，避免下次重复打扰）；失败不吞、
 * 记日志、不推水位（下次仍会通知），但仍 emit category_handled 收尾本类（不阻塞巡视收敛）。
 *
 * 消费事件：notification.worthy
 * 产出事件：notification.notified、notification.category_handled{comments}
 */

import { BaseRole } from './base-role.js';
import type { RoleOptions } from './base-role.js';
import { SessionContext } from './session-context.js';
import type { RoleName } from '../event-bus/types.js';
import type { NotificationItem } from '../comm/protocol.js';
import { notificationItemKey } from './notification-deduper.js';

export interface NotificationNotifierOptions extends RoleOptions {
  /** 发飞书闭包（复用 server 的 messenger + resolveChatId）。缺省仅日志（不发，但仍收尾）。 */
  notify?: (items: NotificationItem[]) => Promise<void>;
}

export class NotificationNotifier extends BaseRole {
  readonly roleName: RoleName = 'notification_notifier';
  private readonly ctx: SessionContext;
  private readonly notify?: (items: NotificationItem[]) => Promise<void>;
  private unsubscribers: (() => void)[] = [];

  constructor(options: NotificationNotifierOptions, ctx: SessionContext) {
    super(options);
    this.ctx = ctx;
    this.notify = options.notify;
  }

  subscribe(): void {
    this.unsubscribers.push(
      this.eventBus.on('notification.worthy', (p) => { void this.push(p.items, p.epoch); }),
    );
  }

  unsubscribe(): void {
    for (const u of this.unsubscribers) u();
    this.unsubscribers = [];
  }

  private async push(items: NotificationItem[], epoch: number): Promise<void> {
    try {
      if (this.notify) {
        await this.notify(items);
        for (const it of items) this.ctx.markItemNotified(notificationItemKey(it)); // 仅成功路径推进水位
        this.log(`已发飞书 ${items.length} 条 epoch=${epoch}`);
        this.emit('notification.notified', { count: items.length, epoch, ts: Date.now() });
      } else {
        this.log(`未配置飞书通道，跳过发送（仍收尾）epoch=${epoch}`);
      }
    } catch (err) {
      // 红线：失败不吞——记日志、不推水位（下次重发）；但仍在 finally 收尾本类，避免卡死巡视。
      this.log(`发飞书失败（不吞，水位不推进，下次重试）：${(err as Error).message}`);
    } finally {
      this.emit('notification.category_handled', { category: 'comments', epoch, ts: Date.now() });
    }
  }
}
