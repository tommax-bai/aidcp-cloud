/**
 * BackToFeed — 统一的"返回列表页"角色。
 *
 * 职责：消费多种"需要返回"的事件，清理会话上下文并 emit feed.entered。
 * 确定性执行角色，不使用 LLM。
 *
 * 消费事件：quality.reject、interaction.skipped、profile.skipped、
 *           profile.done(仅"不关注")、action.completed(仅 follow 完成)
 * 产出事件：feed.entered
 */

import { BaseRole } from './base-role.js';
import type { RoleOptions } from './base-role.js';
import { SessionContext } from './session-context.js';
import type { RoleName } from '../event-bus/types.js';

export class BackToFeed extends BaseRole {
  readonly roleName: RoleName = 'back_to_feed';
  private readonly ctx: SessionContext;
  private unsubscribers: (() => void)[] = [];

  constructor(options: RoleOptions, ctx: SessionContext) {
    super(options);
    this.ctx = ctx;
  }

  subscribe(): void {
    this.unsubscribers.push(
      this.eventBus.on('quality.reject', (p) => this.handleReturn(p.sourcePageType)),
      this.eventBus.on('interaction.skipped', (p) => this.handleReturn(p.sourcePageType)),
      this.eventBus.on('profile.skipped', (p) => this.handleReturn(p.sourcePageType)),
      // 主页这趟结束：不关注 → 直接返回；关注 → 不在此返回，等下面 follow 的动作回执再返回，
      // 否则 back 会抢在 follow 之前下发 → 已退回 feed、follow 点不到按钮而失败。
      this.eventBus.on('profile.done', (p) => { if (!p.followed) this.handleReturn(p.sourcePageType); }),
      // 关注动作完成（成功/失败都算这趟主页结束）→ 返回；来源页类型取自会话上下文。
      this.eventBus.on('action.completed', (p) => { if (p.action === 'follow') this.handleReturn(this.ctx.sourcePageType); }),
    );
  }

  unsubscribe(): void {
    for (const unsub of this.unsubscribers) unsub();
    this.unsubscribers = [];
  }

  // ─── 统一返回处理 ─────────────────────────────────────────

  private handleReturn(sourcePageType: 'feed' | 'search'): void {
    // 清理当前笔记上下文
    this.ctx.setCurrentNoteId(null);

    // 发出 feed.entered 事件
    this.emit('feed.entered', {
      pageType: sourcePageType,
      trigger: 'back_to_feed',
      ts: Date.now(),
    });
  }
}
