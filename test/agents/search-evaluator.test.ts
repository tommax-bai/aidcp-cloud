import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EventBus } from '../../src/event-bus/index.js';
import { SearchEvaluator } from '../../src/agents/search-evaluator.js';
import type { SearchEvaluatorOptions } from '../../src/agents/search-evaluator.js';
import { SessionContext } from '../../src/agents/session-context.js';
import type { Soul } from '../../src/soul/types.js';
import type { SearchApprovedPayload, SearchSkippedPayload } from '../../src/event-bus/types.js';

const mockSoul: Soul = {
  identity: { name: 'TestBot', role: 'AI爱好者', background: '技术博主', tone: '友好' },
  interests: { primary: ['AI'], secondary: ['技术'], seed_keywords: ['LLM Agent', 'RAG 实战', 'vLLM 部署'] },
};

function createMockLlm(response: string) {
  return { complete: async (_prompt: string) => response };
}

function createFailingLlm() {
  return { complete: async (_prompt: string): Promise<string> => { throw new Error('LLM unavailable'); } };
}

describe('SearchEvaluator', () => {
  it('LLM 返回搜索决策 → emit search.approved', async () => {
    const bus = new EventBus();
    const ctx = new SessionContext();
    const searched: string[] = [];
    const llm = createMockLlm('{"verdict":"search","keyword":"LLM Agent","reason":"概念池有未搜索关键词"}');

    const options: SearchEvaluatorOptions = {
      eventBus: bus,
      soul: mockSoul,
      llm,
      sessionContext: ctx,
      getSearchedKeywords: () => searched,
    };
    const role = new SearchEvaluator(options);
    role.subscribe();

    let captured = null as SearchApprovedPayload | null;
    bus.on('search.approved', (p) => { captured = p; });

    await role.evaluate({ consecutiveScrolls: 5, currentPageType: 'feed', ts: Date.now() });

    assert.ok(captured, 'should emit search.approved');
    assert.equal(captured!.keyword, 'LLM Agent');
    assert.equal(captured!.reason, '概念池有未搜索关键词');

    role.unsubscribe();
  });

  it('候选集为空（种子词全已搜、无概念池）→ 短路跳过 no_available_keywords（不调 LLM）', async () => {
    const bus = new EventBus();
    const ctx = new SessionContext();
    const searched = ['LLM Agent', 'RAG 实战', 'vLLM 部署'];
    // 若被调用会让 reason 变成别的值；短路跳过时 LLM 不应被调用。
    const llm = createMockLlm('{"verdict":"search","keyword":"不该出现","reason":"LLM 不应被调用"}');

    const options: SearchEvaluatorOptions = {
      eventBus: bus,
      soul: mockSoul,
      llm,
      sessionContext: ctx,
      getSearchedKeywords: () => searched,
    };
    const role = new SearchEvaluator(options);
    role.subscribe();

    let captured = null as SearchSkippedPayload | null;
    bus.on('search.skipped', (p) => { captured = p; });

    await role.evaluate({ consecutiveScrolls: 5, currentPageType: 'feed', ts: Date.now() });

    assert.ok(captured, 'should emit search.skipped');
    assert.equal(captured!.currentPageType, 'feed');
    assert.equal(captured!.reason, 'no_available_keywords');

    role.unsubscribe();
  });

  it('LLM 异常 → emit search.skipped (reason=llm_error)', async () => {
    const bus = new EventBus();
    const ctx = new SessionContext();
    const llm = createFailingLlm();

    const options: SearchEvaluatorOptions = {
      eventBus: bus,
      soul: mockSoul,
      llm,
      sessionContext: ctx,
      getSearchedKeywords: () => [],
    };
    const role = new SearchEvaluator(options);
    role.subscribe();

    let captured = null as SearchSkippedPayload | null;
    bus.on('search.skipped', (p) => { captured = p; });

    await role.evaluate({ consecutiveScrolls: 5, currentPageType: 'search', ts: Date.now() });

    assert.ok(captured, 'should emit search.skipped on LLM error');
    assert.equal(captured!.reason, 'llm_error');
    assert.equal(captured!.currentPageType, 'search');

    role.unsubscribe();
  });

  it('LLM 返回无法解析的内容 → emit search.skipped (reason=parse_failed)', async () => {
    const bus = new EventBus();
    const ctx = new SessionContext();
    const llm = createMockLlm('这不是一个有效的JSON');

    const options: SearchEvaluatorOptions = {
      eventBus: bus,
      soul: mockSoul,
      llm,
      sessionContext: ctx,
      getSearchedKeywords: () => [],
    };
    const role = new SearchEvaluator(options);
    role.subscribe();

    let captured = null as SearchSkippedPayload | null;
    bus.on('search.skipped', (p) => { captured = p; });

    await role.evaluate({ consecutiveScrolls: 5, currentPageType: 'feed', ts: Date.now() });

    assert.ok(captured, 'should emit search.skipped on parse failure');
    assert.equal(captured!.reason, 'parse_failed');

    role.unsubscribe();
  });

  it('通过事件订阅触发 evaluate', async () => {
    const bus = new EventBus();
    const ctx = new SessionContext();
    const searched: string[] = [];
    const llm = createMockLlm('{"verdict":"search","keyword":"RAG 实战","reason":"测试"}');

    const options: SearchEvaluatorOptions = {
      eventBus: bus,
      soul: mockSoul,
      llm,
      sessionContext: ctx,
      getSearchedKeywords: () => searched,
    };
    const role = new SearchEvaluator(options);
    role.subscribe();

    let captured = null as SearchApprovedPayload | null;
    bus.on('search.approved', (p) => { captured = p; });

    // 通过 eventBus emit search.needed 触发
    bus.emit('search.needed', { consecutiveScrolls: 5, currentPageType: 'feed', ts: Date.now() });

    // 等待异步处理完成
    await new Promise((r) => setTimeout(r, 50));

    assert.ok(captured, 'should emit search.approved via event subscription');
    assert.equal(captured!.keyword, 'RAG 实战');

    role.unsubscribe();
  });

  it('构造时无 LLM → 抛出错误', () => {
    const bus = new EventBus();
    const ctx = new SessionContext();

    assert.throws(() => {
      new SearchEvaluator({
        eventBus: bus,
        soul: mockSoul,
        sessionContext: ctx,
        getSearchedKeywords: () => [],
      });
    }, /需要 LlmClient/);
  });
});

// ─── change llm-role-review-remediation:关键词域内校验 ───────────────────────
describe('SearchEvaluator — 关键词域内校验', () => {
  function make(llmResponse: string) {
    const bus = new EventBus();
    const options: SearchEvaluatorOptions = {
      eventBus: bus,
      soul: mockSoul,
      llm: createMockLlm(llmResponse),
      sessionContext: new SessionContext(),
      getSearchedKeywords: () => [],
    };
    const role = new SearchEvaluator(options);
    return { bus, role };
  }

  it('编造词（不在候选集）→ search.skipped(keyword_not_in_candidates)，绝不真实搜索', async () => {
    const { bus, role } = make('{"verdict":"search","keyword":"量化交易","reason":"编造"}');
    let approved = null as SearchApprovedPayload | null;
    let skipped = null as SearchSkippedPayload | null;
    bus.on('search.approved', (p) => { approved = p; });
    bus.on('search.skipped', (p) => { skipped = p; });
    await role.evaluate({ consecutiveScrolls: 5, currentPageType: 'feed', ts: Date.now() });
    assert.equal(approved, null, '编造词绝不 approved');
    assert.equal(skipped?.reason, 'keyword_not_in_candidates');
  });

  it('候选词大小写/空白不一致 → approved 且回写候选集原词', async () => {
    const { bus, role } = make('{"verdict":"search","keyword":" llm agent ","reason":"ok"}');
    let approved = null as SearchApprovedPayload | null;
    bus.on('search.approved', (p) => { approved = p; });
    await role.evaluate({ consecutiveScrolls: 5, currentPageType: 'feed', ts: Date.now() });
    assert.ok(approved, '候选集内词应放行');
    assert.equal(approved!.keyword, 'LLM Agent', '下游收到候选集原词');
  });
});
