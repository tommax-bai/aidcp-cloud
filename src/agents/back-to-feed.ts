/**
 * BackToFeed — 统一的"返回列表页"角色。
 *
 * 职责：消费多种"需要返回"的事件，清理会话上下文并 emit feed.entered。
 * 确定性执行角色，不使用 LLM。
 *
 * 消费事件：quality.reject、interaction.skipped、profile.skipped、profile.done
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
      this.eventBus.on('profile.done', (p) => this.handleReturn(p.sourcePageType)),
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
