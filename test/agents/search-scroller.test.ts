import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EventBus } from '../../src/event-bus/index.js';
import { SearchScroller, SEARCH_SCROLL_THRESHOLD } from '../../src/agents/search-scroller.js';
import { SessionContext } from '../../src/agents/session-context.js';
import type { Soul } from '../../src/kernel/soul-types.js';
import type { SearchScrolledPayload, SearchNeededPayload } from '../../src/event-bus/types.js';

const mockSoul: Soul = {
  identity: { name: 'TestBot', role: 'AI爱好者', background: '技术博主', tone: '友好' },
  interests: { primary: ['AI'], secondary: ['技术'], seed_keywords: ['LLM'] },
};

describe('SearchScroller', () => {
  it('收到 content.no_valuable (pageType=search) → emit search.scrolled', () => {
    const bus = new EventBus();
    const ctx = new SessionContext();
    const role = new SearchScroller({ eventBus: bus, soul: mockSoul }, ctx);
    role.subscribe();

    let captured = null as SearchScrolledPayload | null;
    bus.on('search.scrolled', (p) => { captured = p; });

    bus.emit('content.no_valuable', { pageType: 'search', reason: 'no_match', ts: Date.now() });

    assert.ok(captured, 'should emit search.scrolled');
    assert.equal(captured!.pageType, 'search');
    assert.equal(captured!.scrollCount, 1);

    role.unsubscribe();
  });

  it('收到 content.no_valuable (pageType=feed) → 不响应', () => {
    const bus = new EventBus();
    const ctx = new SessionContext();
    const role = new SearchScroller({ eventBus: bus, soul: mockSoul }, ctx);
    role.subscribe();

    let captured = null as SearchScrolledPayload | null;
    bus.on('search.scrolled', (p) => { captured = p; });

    bus.emit('content.no_valuable', { pageType: 'feed', reason: 'no_match', ts: Date.now() });

    assert.equal(captured, null, 'should not respond to feed pageType');

    role.unsubscribe();
  });

  it('收到 search.skipped (currentPageType=search) → emit search.scrolled', () => {
    const bus = new EventBus();
    const ctx = new SessionContext();
    const role = new SearchScroller({ eventBus: bus, soul: mockSoul }, ctx);
    role.subscribe();

    let captured = null as SearchScrolledPayload | null;
    bus.on('search.scrolled', (p) => { captured = p; });

    bus.emit('search.skipped', { currentPageType: 'search', reason: '搜索冷却', ts: Date.now() });

    assert.ok(captured, 'should emit search.scrolled');
    assert.equal(captured!.scrollCount, 1);

    role.unsubscribe();
  });

  it('收到 search.skipped (currentPageType=feed) → 不响应', () => {
    const bus = new EventBus();
    const ctx = new SessionContext();
    const role = new SearchScroller({ eventBus: bus, soul: mockSoul }, ctx);
    role.subscribe();

    let captured = null as SearchScrolledPayload | null;
    bus.on('search.scrolled', (p) => { captured = p; });

    bus.emit('search.skipped', { currentPageType: 'feed', reason: '搜索冷却', ts: Date.now() });

    assert.equal(captured, null, 'should not respond to feed currentPageType');

    role.unsubscribe();
  });

  it('连续滚动达到阈值 → emit search.needed 并 reset', () => {
    const bus = new EventBus();
    const ctx = new SessionContext();
    const role = new SearchScroller({ eventBus: bus, soul: mockSoul }, ctx);
    role.subscribe();

    let scrollCount = 0;
    let searchNeeded = null as SearchNeededPayload | null;
    bus.on('search.scrolled', () => { scrollCount++; });
    bus.on('search.needed', (p) => { searchNeeded = p; });

    // 触发 SEARCH_SCROLL_THRESHOLD 次
    for (let i = 0; i < SEARCH_SCROLL_THRESHOLD; i++) {
      bus.emit('content.no_valuable', { pageType: 'search', reason: 'no_match', ts: Date.now() });
    }

    // 前 SEARCH_SCROLL_THRESHOLD-1 次应 emit search.scrolled，最后一次 emit search.needed
    assert.equal(scrollCount, SEARCH_SCROLL_THRESHOLD - 1);
    assert.ok(searchNeeded, 'should emit search.needed at threshold');
    assert.equal(searchNeeded!.consecutiveScrolls, SEARCH_SCROLL_THRESHOLD);
    assert.equal(searchNeeded!.currentPageType, 'search');

    // reset 后应重新计数
    assert.equal(ctx.consecutiveScrolls, 0);

    role.unsubscribe();
  });

  it('阈值触发后重置计数器，新一轮可重新计数', () => {
    const bus = new EventBus();
    const ctx = new SessionContext();
    const role = new SearchScroller({ eventBus: bus, soul: mockSoul }, ctx);
    role.subscribe();

    let searchNeededCount = 0;
    bus.on('search.needed', () => { searchNeededCount++; });

    // 第一轮达到阈值
    for (let i = 0; i < SEARCH_SCROLL_THRESHOLD; i++) {
      bus.emit('content.no_valuable', { pageType: 'search', reason: 'no_match', ts: Date.now() });
    }
    assert.equal(searchNeededCount, 1);

    // 第二轮再次达到阈值
    for (let i = 0; i < SEARCH_SCROLL_THRESHOLD; i++) {
      bus.emit('content.no_valuable', { pageType: 'search', reason: 'no_match', ts: Date.now() });
    }
    assert.equal(searchNeededCount, 2);

    role.unsubscribe();
  });

  it('unsubscribe 后不再响应事件', () => {
    const bus = new EventBus();
    const ctx = new SessionContext();
    const role = new SearchScroller({ eventBus: bus, soul: mockSoul }, ctx);
    role.subscribe();
    role.unsubscribe();

    let captured = null as SearchScrolledPayload | null;
    bus.on('search.scrolled', (p) => { captured = p; });

    bus.emit('content.no_valuable', { pageType: 'search', reason: 'no_match', ts: Date.now() });
    assert.equal(captured, null);
  });
});
