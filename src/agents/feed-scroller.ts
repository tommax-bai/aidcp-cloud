/**
 * FeedScroller — 主Feed页纯翻页执行角色。
 *
 * 职责：在 feed 页面执行翻页，跟踪连续滚动次数，超过阈值时触发搜索。
 * 纯规则角色，不使用 LLM。
 *
 * 消费事件：content.no_valuable（pageType=feed）、search.skipped（currentPageType=feed）
 * 产出事件：feed.scrolled、search.needed、feed.refresh.needed
 */

import { BaseRole } from './base-role.js';
import type { RoleOptions } from './base-role.js';
import { SessionContext } from './session-context.js';
import type { RoleName, ContentNoValuablePayload, SearchSkippedPayload } from '../event-bus/types.js';

/** 连续滚动 N 次无收获后触发搜索的阈值 */
export const SEARCH_THRESHOLD = 5;

/** feed 浏览深度到阈值改点右下「刷新」（change feed-refresh-on-depth）。默认开启，仅显式 'false' 关（kill-switch）。 */
const FEED_REFRESH_ENABLED = process.env.AIDCP_FEED_REFRESH !== 'false';
/** 达此「已浏览不重复 feed 卡」数改刷新（默认 60，用户定案；非法回落 60；env 可调回 200）。 */
const FEED_REFRESH_AFTER = ((): number => {
  const raw = Number(process.env.AIDCP_FEED_REFRESH_AFTER);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 60;
})();

export class FeedScroller extends BaseRole {
  readonly roleName: RoleName = 'feed_scroller';
  private readonly ctx: SessionContext;
  private readonly refreshEnabled: boolean;
  private readonly refreshAfter: number;
  private unsubscribers: (() => void)[] = [];

  constructor(options: RoleOptions, ctx: SessionContext, config?: { enabled?: boolean; refreshAfter?: number }) {
    super(options);
    this.ctx = ctx;
    this.refreshEnabled = config?.enabled ?? FEED_REFRESH_ENABLED;
    this.refreshAfter = config?.refreshAfter ?? FEED_REFRESH_AFTER;
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
    // feed 浏览深度到阈值：改点右下「刷新」回顶换新批，代替继续下滚（change feed-refresh-on-depth）。
    // 乐观复位（emit 时即归零、不等回执）——去抖，避免刷新失败后紧接着又到阈值锤击。
    if (this.refreshEnabled && this.ctx.feedCardsBrowsed >= this.refreshAfter) {
      const cardsBrowsed = this.ctx.feedCardsBrowsed;
      this.ctx.resetFeedCardsBrowsed();
      this.ctx.resetScrolls();
      this.emit('feed.refresh.needed', {
        cardsBrowsed,
        currentPageType: 'feed',
        ts: Date.now(),
      });
      return;
    }

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
