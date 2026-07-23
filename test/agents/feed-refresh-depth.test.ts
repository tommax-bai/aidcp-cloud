import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EventBus } from '../../src/event-bus/index.js';
import { FeedScroller } from '../../src/agents/feed-scroller.js';
import { SessionContext } from '../../src/agents/session-context.js';
import { edgeCommandToEnvelope } from '../../src/comm/command-bridge.js';
import type { Soul } from '../../src/kernel/soul-types.js';
import type { FeedScrolledPayload, FeedRefreshNeededPayload, SearchNeededPayload } from '../../src/event-bus/types.js';

const mockSoul: Soul = {
  identity: { name: 'TestBot', role: 'AI爱好者', background: '技术博主', tone: '友好' },
  interests: { primary: ['AI'], secondary: ['技术'], seed_keywords: ['LLM'] },
};

// change feed-refresh-on-depth：feed 浏览深度到阈值改点右下「刷新」回顶换新批。

describe('SessionContext feed 浏览深度计数（feed-refresh-on-depth）', () => {
  it('addFeedCardsBrowsed 累加、忽略非正数；resetFeedCardsBrowsed 归零', () => {
    const ctx = new SessionContext();
    assert.equal(ctx.feedCardsBrowsed, 0);
    ctx.addFeedCardsBrowsed(6);
    ctx.addFeedCardsBrowsed(4);
    assert.equal(ctx.feedCardsBrowsed, 10);
    ctx.addFeedCardsBrowsed(0);
    ctx.addFeedCardsBrowsed(-3);
    assert.equal(ctx.feedCardsBrowsed, 10, '非正数不改变计数');
    ctx.resetFeedCardsBrowsed();
    assert.equal(ctx.feedCardsBrowsed, 0);
  });

  it('reset() 归零 feed 深度计数（per-session，重连即重置）', () => {
    const ctx = new SessionContext();
    ctx.addFeedCardsBrowsed(42);
    ctx.reset();
    assert.equal(ctx.feedCardsBrowsed, 0);
  });
});

describe('FeedScroller 深度到阈值改刷新（feed-refresh-on-depth）', () => {
  it('feedCardsBrowsed 达阈值 → emit feed.refresh.needed（非 scroll/search）并归零两计数', () => {
    const bus = new EventBus();
    const ctx = new SessionContext();
    const role = new FeedScroller({ eventBus: bus, soul: mockSoul }, ctx, { enabled: true, refreshAfter: 3 });
    role.subscribe();

    let refresh = null as FeedRefreshNeededPayload | null;
    let scrolled = null as FeedScrolledPayload | null;
    let search = null as SearchNeededPayload | null;
    bus.on('feed.refresh.needed', (p) => { refresh = p; });
    bus.on('feed.scrolled', (p) => { scrolled = p; });
    bus.on('search.needed', (p) => { search = p; });

    ctx.addFeedCardsBrowsed(3); // 达阈值
    ctx.incrementScrolls(); // 让 consecutiveScrolls 非 0，验证也被复位
    bus.emit('content.no_valuable', { pageType: 'feed', reason: 'no_match', ts: Date.now() });

    assert.ok(refresh, '应 emit feed.refresh.needed');
    assert.equal(refresh!.cardsBrowsed, 3);
    assert.equal(refresh!.currentPageType, 'feed');
    assert.equal(scrolled, null, '不应同时滚动');
    assert.equal(search, null, '不应转搜索');
    assert.equal(ctx.feedCardsBrowsed, 0, '深度计数乐观归零');
    assert.equal(ctx.consecutiveScrolls, 0, '连续滚动数归零');

    role.unsubscribe();
  });

  it('未达阈值 → 维持原有滚动行为', () => {
    const bus = new EventBus();
    const ctx = new SessionContext();
    const role = new FeedScroller({ eventBus: bus, soul: mockSoul }, ctx, { enabled: true, refreshAfter: 3 });
    role.subscribe();

    let refresh = false, scrolled = false;
    bus.on('feed.refresh.needed', () => { refresh = true; });
    bus.on('feed.scrolled', () => { scrolled = true; });

    ctx.addFeedCardsBrowsed(2); // 未达阈值 3
    bus.emit('content.no_valuable', { pageType: 'feed', reason: 'no_match', ts: Date.now() });

    assert.equal(refresh, false, '未达阈值不刷新');
    assert.equal(scrolled, true, '照常滚动');

    role.unsubscribe();
  });

  it('功能关闭 → 即便远超阈值也永不刷新', () => {
    const bus = new EventBus();
    const ctx = new SessionContext();
    const role = new FeedScroller({ eventBus: bus, soul: mockSoul }, ctx, { enabled: false, refreshAfter: 3 });
    role.subscribe();

    let refresh = false, scrolled = false;
    bus.on('feed.refresh.needed', () => { refresh = true; });
    bus.on('feed.scrolled', () => { scrolled = true; });

    ctx.addFeedCardsBrowsed(100);
    bus.emit('content.no_valuable', { pageType: 'feed', reason: 'no_match', ts: Date.now() });

    assert.equal(refresh, false, '关闭时不刷新');
    assert.equal(scrolled, true, '照常滚动');

    role.unsubscribe();
  });
});

describe('command-bridge：refresh → feed.refresh 信封（feed-refresh-on-depth）', () => {
  it('edgeCommandToEnvelope 把 action=refresh 映射为 feed.refresh 且透传 reason + thinkMs', () => {
    const env = edgeCommandToEnvelope({ action: 'refresh', reason: 'feed_refresh', params: { thinkMs: 700 } });
    assert.equal(env.type, 'feed.refresh');
    const payload = env.payload as { reason?: string; thinkMs?: number };
    assert.equal(payload.reason, 'feed_refresh');
    assert.equal(payload.thinkMs, 700);
  });
});
