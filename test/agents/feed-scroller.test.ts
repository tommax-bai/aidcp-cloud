import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EventBus } from '../../src/event-bus/index.js';
import { FeedScroller, SEARCH_THRESHOLD } from '../../src/agents/feed-scroller.js';
import { SessionContext } from '../../src/agents/session-context.js';
import type { Soul } from '../../src/kernel/soul-types.js';
import type { FeedScrolledPayload, SearchNeededPayload } from '../../src/event-bus/types.js';

const mockSoul: Soul = {
  identity: { name: 'TestBot', role: 'AI爱好者', background: '技术博主', tone: '友好' },
  interests: { primary: ['AI'], secondary: ['技术'], seed_keywords: ['LLM'] },
};

describe('FeedScroller', () => {
  it('收到 content.no_valuable (pageType=feed) → emit feed.scrolled', () => {
    const bus = new EventBus();
    const ctx = new SessionContext();
    const role = new FeedScroller({ eventBus: bus, soul: mockSoul }, ctx);
    role.subscribe();

    let captured = null as FeedScrolledPayload | null;
    bus.on('feed.scrolled', (p) => { captured = p; });

    bus.emit('content.no_valuable', { pageType: 'feed', reason: 'no_match', ts: Date.now() });

    assert.ok(captured, 'should emit feed.scrolled');
    assert.equal(captured!.pageType, 'feed');
    assert.equal(captured!.scrollCount, 1);

    role.unsubscribe();
  });

  it('收到 content.no_valuable (pageType=search) → 不响应', () => {
    const bus = new EventBus();
    const ctx = new SessionContext();
    const role = new FeedScroller({ eventBus: bus, soul: mockSoul }, ctx);
    role.subscribe();

    let captured = null as FeedScrolledPayload | null;
    bus.on('feed.scrolled', (p) => { captured = p; });

    bus.emit('content.no_valuable', { pageType: 'search', reason: 'no_match', ts: Date.now() });

    assert.equal(captured, null, 'should not respond to search pageType');

    role.unsubscribe();
  });

  it('收到 search.skipped (currentPageType=feed) → emit feed.scrolled', () => {
    const bus = new EventBus();
    const ctx = new SessionContext();
    const role = new FeedScroller({ eventBus: bus, soul: mockSoul }, ctx);
    role.subscribe();

    let captured = null as FeedScrolledPayload | null;
    bus.on('feed.scrolled', (p) => { captured = p; });

    bus.emit('search.skipped', { currentPageType: 'feed', reason: '搜索冷却', ts: Date.now() });

    assert.ok(captured, 'should emit feed.scrolled');
    assert.equal(captured!.scrollCount, 1);

    role.unsubscribe();
  });

  it('收到 search.skipped (currentPageType=search) → 不响应', () => {
    const bus = new EventBus();
    const ctx = new SessionContext();
    const role = new FeedScroller({ eventBus: bus, soul: mockSoul }, ctx);
    role.subscribe();

    let captured = null as FeedScrolledPayload | null;
    bus.on('feed.scrolled', (p) => { captured = p; });

    bus.emit('search.skipped', { currentPageType: 'search', reason: '搜索冷却', ts: Date.now() });

    assert.equal(captured, null, 'should not respond to search currentPageType');

    role.unsubscribe();
  });

  it('连续滚动达到阈值 → emit search.needed 并 reset', () => {
    const bus = new EventBus();
    const ctx = new SessionContext();
    const role = new FeedScroller({ eventBus: bus, soul: mockSoul }, ctx);
    role.subscribe();

    let scrollCount = 0;
    let searchNeeded = null as SearchNeededPayload | null;
    bus.on('feed.scrolled', () => { scrollCount++; });
    bus.on('search.needed', (p) => { searchNeeded = p; });

    // 触发 SEARCH_THRESHOLD 次
    for (let i = 0; i < SEARCH_THRESHOLD; i++) {
      bus.emit('content.no_valuable', { pageType: 'feed', reason: 'no_match', ts: Date.now() });
    }

    // 前 SEARCH_THRESHOLD-1 次应 emit feed.scrolled，最后一次 emit search.needed
    assert.equal(scrollCount, SEARCH_THRESHOLD - 1);
    assert.ok(searchNeeded, 'should emit search.needed at threshold');
    assert.equal(searchNeeded!.consecutiveScrolls, SEARCH_THRESHOLD);
    assert.equal(searchNeeded!.currentPageType, 'feed');

    // reset 后应重新计数
    assert.equal(ctx.consecutiveScrolls, 0);

    role.unsubscribe();
  });

  it('阈值触发后重置计数器，新一轮可重新计数', () => {
    const bus = new EventBus();
    const ctx = new SessionContext();
    const role = new FeedScroller({ eventBus: bus, soul: mockSoul }, ctx);
    role.subscribe();

    let searchNeededCount = 0;
    bus.on('search.needed', () => { searchNeededCount++; });

    // 第一轮达到阈值
    for (let i = 0; i < SEARCH_THRESHOLD; i++) {
      bus.emit('content.no_valuable', { pageType: 'feed', reason: 'no_match', ts: Date.now() });
    }
    assert.equal(searchNeededCount, 1);

    // 第二轮再次达到阈值
    for (let i = 0; i < SEARCH_THRESHOLD; i++) {
      bus.emit('content.no_valuable', { pageType: 'feed', reason: 'no_match', ts: Date.now() });
    }
    assert.equal(searchNeededCount, 2);

    role.unsubscribe();
  });

  it('unsubscribe 后不再响应事件', () => {
    const bus = new EventBus();
    const ctx = new SessionContext();
    const role = new FeedScroller({ eventBus: bus, soul: mockSoul }, ctx);
    role.subscribe();
    role.unsubscribe();

    let captured = null as FeedScrolledPayload | null;
    bus.on('feed.scrolled', (p) => { captured = p; });

    bus.emit('content.no_valuable', { pageType: 'feed', reason: 'no_match', ts: Date.now() });
    assert.equal(captured, null);
  });
});
