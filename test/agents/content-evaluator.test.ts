import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EventBus } from '../../src/event-bus/index.js';
import { ContentEvaluator } from '../../src/agents/content-evaluator.js';
import type { VisibleCard } from '../../src/agents/content-evaluator.js';
import { SessionContext } from '../../src/agents/session-context.js';
import type { Soul } from '../../src/soul/types.js';
import type { ContentValuablePayload, ContentNoValuablePayload } from '../../src/event-bus/types.js';

const mockSoul: Soul = {
  identity: { name: 'TestBot', role: 'AI爱好者', background: '技术博主', tone: '友好' },
  interests: { primary: ['AI', 'LLM'], secondary: ['编程', '技术'], seed_keywords: ['GPT'] },
  session_limits: { max_duration_min: 10, max_likes: 8, max_collects: 5, max_searches: 3, cooldown_between_actions_sec: [2, 5] as [number, number] },
};

const sampleCards: VisibleCard[] = [
  { index: 0, title: 'AI绘画教程', author: '小红', likeCount: 100, collectCount: 50, noteId: 'n1' },
  { index: 1, title: 'LLM最新进展', author: '技术猫', likeCount: 200, collectCount: 80, noteId: 'n2' },
  { index: 2, title: '美食推荐', author: '吃货', likeCount: 50, collectCount: 20, noteId: 'n3' },
];

describe('ContentEvaluator', () => {
  it('构造函数：无 LLM 抛错', () => {
    const bus = new EventBus();
    const ctx = new SessionContext();
    assert.throws(
      () => new ContentEvaluator({ eventBus: bus, soul: mockSoul }, ctx),
      /需要 LlmClient/,
    );
  });

  it('subscribe：主动触发模式，subscribe 为空操作', () => {
    const bus = new EventBus();
    const ctx = new SessionContext();
    const llm = { complete: async () => '{}' };
    const role = new ContentEvaluator({ eventBus: bus, soul: mockSoul, llm }, ctx);
    role.setVisibleCards(sampleCards);
    role.subscribe();

    // 新模式下 subscribe 不订阅事件，由 RoleDispatcher 主动调用 evaluate()
    role.unsubscribe();
  });

  it('有价值卡片：LLM 返回 valuable → emit content.valuable', async () => {
    const bus = new EventBus();
    const ctx = new SessionContext();
    const llm = {
      complete: async () => '{"verdict":"valuable","index":1,"reason":"与AI技术相关","confidence":0.9}',
    };
    const role = new ContentEvaluator({ eventBus: bus, soul: mockSoul, llm }, ctx);
    role.setVisibleCards(sampleCards);
    role.subscribe();

    let captured = null as ContentValuablePayload | null;
    bus.on('content.valuable', (p) => { captured = p; });

    // 直接调用 evaluate（由 RoleDispatcher 触发的方式）
    await role.evaluate('feed');

    assert.ok(captured, 'should emit content.valuable');
    assert.equal(captured!.index, 1);
    assert.equal(captured!.noteId, 'n2');
    assert.equal(captured!.title, 'LLM最新进展');
    assert.equal(captured!.reason, '与AI技术相关');
    assert.equal(captured!.confidence, 0.9);
    assert.equal(captured!.sourcePageType, 'feed');

    role.unsubscribe();
  });

  it('无价值卡片：LLM 返回 skip → emit content.no_valuable', async () => {
    const bus = new EventBus();
    const ctx = new SessionContext();
    const llm = {
      complete: async () => '{"verdict":"skip","reason":"无相关内容"}',
    };
    const role = new ContentEvaluator({ eventBus: bus, soul: mockSoul, llm }, ctx);
    role.setVisibleCards(sampleCards);
    role.subscribe();

    let captured = null as ContentNoValuablePayload | null;
    bus.on('content.no_valuable', (p) => { captured = p; });

    await role.evaluate('feed');

    assert.ok(captured, 'should emit content.no_valuable');
    assert.equal(captured!.pageType, 'feed');
    assert.equal(captured!.reason, '无相关内容');

    role.unsubscribe();
  });

  it('LLM 解析失败 → emit content.no_valuable (parse_failed)', async () => {
    const bus = new EventBus();
    const ctx = new SessionContext();
    const llm = {
      complete: async () => '这不是一个有效的JSON',
    };
    const role = new ContentEvaluator({ eventBus: bus, soul: mockSoul, llm }, ctx);
    role.setVisibleCards(sampleCards);
    role.subscribe();

    let captured = null as ContentNoValuablePayload | null;
    bus.on('content.no_valuable', (p) => { captured = p; });

    await role.evaluate('search');

    assert.ok(captured, 'should emit content.no_valuable');
    assert.equal(captured!.reason, 'parse_failed');

    role.unsubscribe();
  });

  it('LLM 抛错 → emit content.no_valuable (llm_error)', async () => {
    const bus = new EventBus();
    const ctx = new SessionContext();
    const llm = {
      complete: async () => { throw new Error('网络超时'); },
    };
    const role = new ContentEvaluator({ eventBus: bus, soul: mockSoul, llm }, ctx);
    role.setVisibleCards(sampleCards);
    role.subscribe();

    let captured = null as ContentNoValuablePayload | null;
    bus.on('content.no_valuable', (p) => { captured = p; });

    await role.evaluate('feed');

    assert.ok(captured, 'should emit content.no_valuable');
    assert.equal(captured!.reason, 'llm_error');

    role.unsubscribe();
  });

  it('已访问卡片被过滤 → 空候选时 emit content.no_valuable', async () => {
    const bus = new EventBus();
    const ctx = new SessionContext();
    // 标记所有卡片已访问
    ctx.markVisited('n1');
    ctx.markVisited('n2');
    ctx.markVisited('n3');

    const llm = {
      complete: async () => '{"verdict":"valuable","index":0,"reason":"test","confidence":0.9}',
    };
    const role = new ContentEvaluator({ eventBus: bus, soul: mockSoul, llm }, ctx);
    role.setVisibleCards(sampleCards);
    role.subscribe();

    let captured = null as ContentNoValuablePayload | null;
    bus.on('content.no_valuable', (p) => { captured = p; });

    await role.evaluate('feed');

    assert.ok(captured, 'should emit content.no_valuable when all visited');
    assert.equal(captured!.reason, 'all_cards_visited');

    role.unsubscribe();
  });

  it('unsubscribe：取消后直接调用 evaluate 仍然有效（subscribe 不影响 evaluate）', async () => {
    const bus = new EventBus();
    const ctx = new SessionContext();
    const llm = {
      complete: async () => '{"verdict":"valuable","index":0,"reason":"test","confidence":0.9}',
    };
    const role = new ContentEvaluator({ eventBus: bus, soul: mockSoul, llm }, ctx);
    role.setVisibleCards(sampleCards);
    role.subscribe();
    role.unsubscribe();

    let captured = null as ContentValuablePayload | null;
    bus.on('content.valuable', (p) => { captured = p; });

    // 直接调用 evaluate 仍然工作（主动触发模式）
    await role.evaluate('feed');
    assert.ok(captured, 'evaluate should still work after unsubscribe');
  });
});
