/**
 * notification_classifier — 内容分类。
 *
 * 收 notification.items.arrived（仅评论/@ 路径）→ 校验巡视活跃 → 挑值得通知的项
 * （v1：评论与@皆值得，仅滤掉空内容；此处是未来接 LLM 精筛的缝）→ classified（worthy 可能为空，
 * 由 deduper 收尾）；异常 → classify_failed（交给 resumer 收敛）。
 *
 * 消费事件：notification.items.arrived
 * 产出事件：notification.classified / notification.classify_failed
 */

import { BaseRole } from './base-role.js';
import type { RoleOptions } from './base-role.js';
import { SessionContext } from './session-context.js';
import type { RoleName } from '../event-bus/types.js';
import type { NotificationItem } from '../comm/protocol.js';

export class NotificationClassifier extends BaseRole {
  readonly roleName: RoleName = 'notification_classifier';
  private readonly ctx: SessionContext;
  private unsubscribers: (() => void)[] = [];

  constructor(options: RoleOptions, ctx: SessionContext) {
    super(options);
    this.ctx = ctx;
  }

  subscribe(): void {
    this.unsubscribers.push(
      this.eventBus.on('notification.items.arrived', (p) => this.classify(p.items)),
    );
  }

  unsubscribe(): void {
    for (const u of this.unsubscribers) u();
    this.unsubscribers = [];
  }

  private classify(items: NotificationItem[]): void {
    if (!this.ctx.excursionActive) return;
    const epoch = this.ctx.excursionEpoch ?? 0;
    try {
      const worthy = (items ?? []).filter((it) => {
        if (!it || typeof it.content !== 'string') return false;
        const c = it.content.trim();
        if (c.length === 0) return false; // 无正文（含边缘正文缺失诚实发空串的路径）
        // 防御性过滤（NCQ-1 纵深）：边缘正文子选择器在 reds- 命名下漏掉时，旧码会回退整行 textContent → 飞书 blob。
        // 边缘已改为正文缺失发空串，此处再拦两类残留：正文 == 用户名（错抓到名字）、正文是纯动作标签（无真实评论）。
        if (it.fromUser && c === it.fromUser.trim()) return false;
        if (/^(赞了你的(评论|笔记)|收藏了你的笔记|关注了你|回复了你的?(评论|笔记)?|点赞)$/.test(c)) return false;
        return true;
      });
      this.log(`分类：${worthy.length}/${(items ?? []).length} 条值得通知 epoch=${epoch}`);
      this.emit('notification.classified', { worthy, epoch, ts: Date.now() });
    } catch (err) {
      this.log(`分类失败（不吞，交 resumer 收敛）：${(err as Error).message}`);
      this.emit('notification.classify_failed', { epoch, reason: (err as Error).message, ts: Date.now() });
    }
  }
}
