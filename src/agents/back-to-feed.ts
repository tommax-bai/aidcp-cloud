/**
 * BackToFeed — 统一的"返回列表页"角色。
 *
 * 职责：消费多种"需要返回"的事件，清理会话上下文并 emit feed.entered。
 * 确定性执行角色，不使用 LLM。
 *
 * 消费事件：quality.reject、interaction.skipped、profile.skipped、profile.exit
 *           （profile.exit 由 RoleDispatcher 在主页关注评估后于单一时序点发出，覆盖
 *            关注已发 / 关注被风控拦 / 决定不关注 三分支——返回触发器唯一）
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
      // 主页子链结束（关注已发 / 关注被风控拦 / 决定不关注，由 RoleDispatcher 在单一时序点 emit）→ 返回。
      // 关注命令（若有）已由 dispatcher 先入队，本返回命令紧随其后入队，靠边缘 FIFO 队列保证关注先执行、返回后执行。
      // 不再单独监听 profile.done / action.completed{follow}：返回触发器唯一，杜绝「返回抢在关注前」竞态与重复返回，
      // 并修「关注被风控拦截 → 永无 follow 回执 → 旧的等回执死等 → 卡死在作者主页」。
      this.eventBus.on('profile.exit', (p) => this.handleReturn(p.sourcePageType)),
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
