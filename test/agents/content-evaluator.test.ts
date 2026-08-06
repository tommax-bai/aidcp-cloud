import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EventBus } from '@automation/event-bus/index.js';
import { ContentEvaluator } from '@automation/agents/content-evaluator.js';
import type { VisibleCard } from '@automation/agents/content-evaluator.js';
import { SessionContext } from '@automation/agents/session-context.js';
import type { Soul } from '@kernel/kernel/soul-types.js';
import type { ContentValuablePayload, ContentNoValuablePayload } from '@automation/event-bus/types.js';

const mockSoul: Soul = {
  identity: { name: 'TestBot', role: 'AI爱好者', background: '技术博主', tone: '友好' },
  interests: { primary: ['AI', 'LLM'], secondary: ['编程', '技术'], seed_keywords: ['GPT'] },
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

  it('并发去重：evaluate 在途时再次调用直接返回，不重复调 LLM', async () => {
    const bus = new EventBus();
    const ctx = new SessionContext();
    let calls = 0;
    const llm = {
      complete: async () => {
        calls++;
        await new Promise((r) => setTimeout(r, 20));
        return '{"verdict":"skip","reason":"x"}';
      },
    };
    const role = new ContentEvaluator({ eventBus: bus, soul: mockSoul, llm }, ctx);
    role.setVisibleCards(sampleCards);

    // 不 await 第一次，立刻再触发两次：后两次应因“在途守卫”直接返回，不再调 LLM
    const p1 = role.evaluate('feed');
    await role.evaluate('feed');
    await role.evaluate('feed');
    await p1;

    assert.equal(calls, 1, `在途守卫应只放行一次 LLM 调用，实际=${calls}`);
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

// ─── change llm-role-review-remediation:输出域内校验 ─────────────────────────
describe('ContentEvaluator — 序号域内校验', () => {
  function make(llmResponse: string) {
    const bus = new EventBus();
    const ctx = new SessionContext();
    const llm = { complete: async () => llmResponse };
    const role = new ContentEvaluator({ eventBus: bus, soul: mockSoul, llm }, ctx);
    role.setVisibleCards(sampleCards);
    return { bus, role };
  }

  it('index 越界 → content.no_valuable(index_out_of_range)，绝不静默落第一张', async () => {
    const { bus, role } = make('{"verdict":"valuable","index":99,"reason":"x","confidence":0.9}');
    let valuable = null as ContentValuablePayload | null;
    let noValuable = null as ContentNoValuablePayload | null;
    bus.on('content.valuable', (p) => { valuable = p; });
    bus.on('content.no_valuable', (p) => { noValuable = p; });
    await role.evaluate('feed');
    assert.equal(valuable, null, '越界绝不 emit content.valuable');
    assert.ok(noValuable, '越界应按 skip 如实上报');
    assert.equal(noValuable!.reason, 'index_out_of_range');
  });

  it('index 非整数/负数/缺失 → 判解析失败(parse_failed)，不默认第一张', async () => {
    const bads = [
      '{"verdict":"valuable","index":1.5,"reason":"x"}',
      '{"verdict":"valuable","index":-1,"reason":"x"}',
      '{"verdict":"valuable","reason":"x"}',
    ];
    for (const bad of bads) {
      const { bus, role } = make(bad);
      let valuable = null as ContentValuablePayload | null;
      let noValuable = null as ContentNoValuablePayload | null;
      bus.on('content.valuable', (p) => { valuable = p; });
      bus.on('content.no_valuable', (p) => { noValuable = p; });
      await role.evaluate('feed');
      assert.equal(valuable, null, `非法 index 不该选卡: ${bad}`);
      assert.equal(noValuable?.reason, 'parse_failed', `应判解析失败: ${bad}`);
    }
  });
});
