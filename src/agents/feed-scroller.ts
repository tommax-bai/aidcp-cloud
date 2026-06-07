/**
 * FeedScroller — 主Feed页纯翻页执行角色。
 *
 * 职责：在 feed 页面执行翻页，跟踪连续滚动次数，超过阈值时触发搜索。
 * 纯规则角色，不使用 LLM。
 *
 * 消费事件：content.no_valuable（pageType=feed）、search.skipped（currentPageType=feed）
 * 产出事件：feed.scrolled、search.needed
 */

import { BaseRole } from './base-role.js';
import type { RoleOptions } from './base-role.js';
import { SessionContext } from './session-context.js';
import type { RoleName, ContentNoValuablePayload, SearchSkippedPayload } from '../event-bus/types.js';

/** 连续滚动 N 次无收获后触发搜索的阈值 */
export const SEARCH_THRESHOLD = 5;

export class FeedScroller extends BaseRole {
  readonly roleName: RoleName = 'feed_scroller';
  private readonly ctx: SessionContext;
  private unsubscribers: (() => void)[] = [];

  constructor(options: RoleOptions, ctx: SessionContext) {
    super(options);
    this.ctx = ctx;
  }

  subscribe(): void {
    this.unsubscribers.push(
      this.eventBus.on('content.no_valuable', (p) => this.handleNoValuable(p)),
      this.eventBus.on('search.skipped', (p) => this.handleSearchSkipped(p)),
    );
  }

  unsubscribe(): void {
    for (const unsub of this.unsubscribers) unsub();
    this.unsubscribers = [];
  }

  // ─── 事件处理 ─────────────────────────────────────────────

  private handleNoValuable(payload: ContentNoValuablePayload): void {
    if (payload.pageType !== 'feed') return;
    this.scrollOrSearch();
  }

  private handleSearchSkipped(payload: SearchSkippedPayload): void {
    if (payload.currentPageType !== 'feed') return;
    this.scrollOrSearch();
  }

  // ─── 核心逻辑 ─────────────────────────────────────────────

  private scrollOrSearch(): void {
    const count = this.ctx.incrementScrolls();

    if (count >= SEARCH_THRESHOLD) {
      this.ctx.resetScrolls();
      this.emit('search.needed', {
        consecutiveScrolls: count,
        currentPageType: 'feed',
        ts: Date.now(),
      });
    } else {
      this.emit('feed.scrolled', {
        pageType: 'feed',
        scrollCount: count,
        ts: Date.now(),
      });
    }
  }
}
