/**
 * SearchScroller — 搜索结果页纯翻页执行角色。
 *
 * 职责：在搜索结果页执行翻页，跟踪连续滚动次数，超过阈值时触发新一轮搜索。
 * 纯规则角色，不使用 LLM。与 FeedScroller 逻辑高度相似，但专用于搜索结果页。
 *
 * 消费事件：content.no_valuable（pageType=search）、search.skipped（currentPageType=search）
 * 产出事件：search.scrolled、search.needed
 */

import { BaseRole } from './base-role.js';
import type { RoleOptions } from './base-role.js';
import { SessionContext } from './session-context.js';
import type { RoleName, ContentNoValuablePayload, SearchSkippedPayload } from '../event-bus/types.js';

/** 搜索结果页连续滚动阈值（与 FeedScroller 共享同一默认值） */
export const SEARCH_SCROLL_THRESHOLD = 5;

export class SearchScroller extends BaseRole {
  readonly roleName: RoleName = 'search_scroller';
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
    if (payload.pageType !== 'search') return;
    this.scrollOrSearch();
  }

  private handleSearchSkipped(payload: SearchSkippedPayload): void {
    if (payload.currentPageType !== 'search') return;
    this.scrollOrSearch();
  }

  // ─── 核心逻辑 ─────────────────────────────────────────────

  private scrollOrSearch(): void {
    const count = this.ctx.incrementScrolls();

    if (count >= SEARCH_SCROLL_THRESHOLD) {
      this.ctx.resetScrolls();
      this.emit('search.needed', {
        consecutiveScrolls: count,
        currentPageType: 'search',
        ts: Date.now(),
      });
    } else {
      this.emit('search.scrolled', {
        pageType: 'search',
        scrollCount: count,
        ts: Date.now(),
      });
    }
  }
}
