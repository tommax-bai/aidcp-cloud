import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EventBus } from '../../src/event-bus/index.js';
import { SearchExecutor } from '../../src/agents/search-executor.js';
import { SessionContext } from '../../src/agents/session-context.js';
import type { Soul } from '../../src/soul/types.js';
import type { FeedEnteredPayload } from '../../src/event-bus/types.js';

const mockSoul: Soul = {
  identity: { name: 'TestBot', role: 'AI爱好者', background: '技术博主', tone: '友好' },
  interests: { primary: ['AI'], secondary: ['技术'], seed_keywords: ['LLM'] },
  session_limits: { max_duration_min: 10, max_likes: 8, max_collects: 5, max_searches: 3, cooldown_between_actions_sec: [2, 5] as [number, number] },
};

describe('SearchExecutor', () => {
  it('收到 search.approved → emit feed.entered(search)', () => {
    const bus = new EventBus();
    const ctx = new SessionContext();
    const role = new SearchExecutor({ eventBus: bus, soul: mockSoul, sessionContext: ctx });
    role.subscribe();

    let captured = null as FeedEnteredPayload | null;
    bus.on('feed.entered', (p) => { captured = p; });

    bus.emit('search.approved', { keyword: 'LLM Agent', reason: '概念池推荐', ts: Date.now() });

    assert.ok(captured, 'should emit feed.entered');
    assert.equal(captured!.pageType, 'search');
    assert.equal(captured!.trigger, 'search_completed');

    role.unsubscribe();
  });

  it('收到 search.approved → 记录搜索关键词', () => {
    const bus = new EventBus();
    const ctx = new SessionContext();
    const role = new SearchExecutor({ eventBus: bus, soul: mockSoul, sessionContext: ctx });
    role.subscribe();

    bus.emit('search.approved', { keyword: 'LLM Agent', reason: '测试', ts: Date.now() });
    bus.emit('search.approved', { keyword: 'RAG 实战', reason: '测试', ts: Date.now() });

    assert.deepEqual(role.searchedKeywords, ['LLM Agent', 'RAG 实战']);

    role.unsubscribe();
  });

  it('收到 search.approved → 重置 consecutiveScrolls', () => {
    const bus = new EventBus();
    const ctx = new SessionContext();
    // 先模拟一些滚动
    ctx.incrementScrolls();
    ctx.incrementScrolls();
    ctx.incrementScrolls();
    assert.equal(ctx.consecutiveScrolls, 3);

    const role = new SearchExecutor({ eventBus: bus, soul: mockSoul, sessionContext: ctx });
    role.subscribe();

    bus.emit('search.approved', { keyword: 'LLM Agent', reason: '测试', ts: Date.now() });

    assert.equal(ctx.consecutiveScrolls, 0, 'should reset consecutiveScrolls');

    role.unsubscribe();
  });

  it('unsubscribe 后不再响应事件', () => {
    const bus = new EventBus();
    const ctx = new SessionContext();
    const role = new SearchExecutor({ eventBus: bus, soul: mockSoul, sessionContext: ctx });
    role.subscribe();
    role.unsubscribe();

    let captured = null as FeedEnteredPayload | null;
    bus.on('feed.entered', (p) => { captured = p; });

    bus.emit('search.approved', { keyword: 'LLM Agent', reason: '测试', ts: Date.now() });
    assert.equal(captured, null);
  });

  it('searchedKeywords 返回副本（不可变）', () => {
    const bus = new EventBus();
    const ctx = new SessionContext();
    const role = new SearchExecutor({ eventBus: bus, soul: mockSoul, sessionContext: ctx });
    role.subscribe();

    bus.emit('search.approved', { keyword: 'LLM Agent', reason: '测试', ts: Date.now() });

    const kw1 = role.searchedKeywords;
    kw1.push('hack');  // 修改副本
    assert.deepEqual(role.searchedKeywords, ['LLM Agent'], 'original should not be modified');

    role.unsubscribe();
  });
});
