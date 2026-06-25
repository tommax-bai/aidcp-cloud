/**
 * 验收用例 AC-SEARCH-* — 概念池驱动的搜索智能
 *
 * 守护点（change: wire-concept-pool-search-intelligence）：
 *   1. 关键词来自「seed_keywords ∪ 概念池 candidates」，不再仅 6 个写死种子词；
 *   2. search.execute 的 source 如实标注来源（new_concept / random_from_interests）；
 *   3. 搜索前两道闸（预算 + 限频）生效，被拦时诚实跳过——不下发、不扣 budget、不 markSearched（红线：不假成功）；
 *   4. 已搜关键词跨会话不重复（markSearched → known → 候选集排除）。
 *
 * 环境层级：离线 / 逻辑级（无外部依赖；桩 LLM + 桩 ConceptStore，不接 PG）。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EventBus } from '../../src/event-bus/index.js';
import { SearchEvaluator } from '../../src/agents/search-evaluator.js';
import { RoleDispatcher } from '../../src/orchestrator/role-dispatcher.js';
import type { EdgeCommand, ConceptStorePort } from '../../src/orchestrator/role-dispatcher.js';
import { SessionContext } from '../../src/agents/session-context.js';
import type { Soul } from '../../src/soul/types.js';
import type { ConceptPool, SearchApprovedPayload, SearchSkippedPayload } from '../../src/event-bus/types.js';

const mockSoul: Soul = {
  identity: { name: '小林', role: 'AI工程师', background: '技术博主', tone: '友好' },
  interests: { primary: ['AI'], secondary: ['技术'], seed_keywords: ['LLM Agent', 'RAG 实战'] },
};

const llmReturning = (s: string) => ({ complete: async () => s });
const llmThrowing = () => ({ complete: async (): Promise<string> => { throw new Error('LLM must not be called'); } });
const emptyPool = (): ConceptPool => ({ known: [], candidates: [], source: new Map() });

// ─── SearchEvaluator：候选集来源 + source 归因 ─────────────────────────

describe('AC-SEARCH 概念池驱动的搜索智能', () => {
  it('AC-SEARCH-01 概念池 candidate 被选中 → approved.source=new_concept', async () => {
    const bus = new EventBus();
    const pool: ConceptPool = { known: [], candidates: ['向量数据库'], source: new Map() };
    const role = new SearchEvaluator({
      eventBus: bus,
      soul: mockSoul,
      llm: llmReturning('{"verdict":"search","keyword":"向量数据库","reason":"概念池有新概念"}'),
      sessionContext: new SessionContext(),
      getSearchedKeywords: () => [],
      getConceptPool: () => pool,
    });
    let captured = null as SearchApprovedPayload | null;
    bus.on('search.approved', (p) => { captured = p; });

    await role.evaluate({ consecutiveScrolls: 5, currentPageType: 'feed', ts: Date.now() });

    assert.ok(captured, '应 emit search.approved');
    assert.equal(captured!.keyword, '向量数据库');
    assert.equal(captured!.source, 'new_concept', '概念池来源必须如实标注 new_concept');
  });

  it('AC-SEARCH-02 种子词被选中 → approved.source=random_from_interests', async () => {
    const bus = new EventBus();
    const role = new SearchEvaluator({
      eventBus: bus,
      soul: mockSoul,
      llm: llmReturning('{"verdict":"search","keyword":"LLM Agent","reason":"兴趣相关"}'),
      sessionContext: new SessionContext(),
      getSearchedKeywords: () => [],
      getConceptPool: emptyPool,
    });
    let captured = null as SearchApprovedPayload | null;
    bus.on('search.approved', (p) => { captured = p; });

    await role.evaluate({ consecutiveScrolls: 5, currentPageType: 'feed', ts: Date.now() });

    assert.equal(captured!.source, 'random_from_interests', '种子词来源必须标注 random_from_interests');
  });

  it('AC-SEARCH-03 候选集为空 → 诚实跳过(no_available_keywords)，且不调用 LLM', async () => {
    const bus = new EventBus();
    const role = new SearchEvaluator({
      eventBus: bus,
      soul: mockSoul,
      llm: llmThrowing(), // 若被调用会抛错 → reason 会变成 llm_error
      sessionContext: new SessionContext(),
      getSearchedKeywords: () => ['LLM Agent', 'RAG 实战'], // 种子词全已搜
      getConceptPool: emptyPool,
    });
    let captured = null as SearchSkippedPayload | null;
    bus.on('search.skipped', (p) => { captured = p; });

    await role.evaluate({ consecutiveScrolls: 5, currentPageType: 'feed', ts: Date.now() });

    assert.ok(captured, '应 emit search.skipped');
    assert.equal(captured!.reason, 'no_available_keywords', '候选空时短路跳过，不应调 LLM（否则会是 llm_error）');
  });

  it('AC-SEARCH-04 已搜词在 known 中 → 跨会话被候选集排除', async () => {
    const bus = new EventBus();
    // 候选只有一个，且它已在 known（上一会话 markSearched 的结果）→ 候选集为空 → 跳过
    const pool: ConceptPool = { known: ['向量数据库'], candidates: ['向量数据库'], source: new Map() };
    const role = new SearchEvaluator({
      eventBus: bus,
      soul: { ...mockSoul, interests: { ...mockSoul.interests, seed_keywords: [] } },
      llm: llmThrowing(),
      sessionContext: new SessionContext(),
      getSearchedKeywords: () => [],
      getConceptPool: () => pool,
    });
    let skipped = null as SearchSkippedPayload | null;
    bus.on('search.skipped', (p) => { skipped = p; });

    await role.evaluate({ consecutiveScrolls: 5, currentPageType: 'feed', ts: Date.now() });

    assert.ok(skipped, '已搜词应被排除，候选空 → 跳过');
    assert.equal(skipped!.reason, 'no_available_keywords');
  });

  // ─── RoleDispatcher：搜索前两道闸 ─────────────────────────────────

  function setupDispatcher() {
    const commands: EdgeCommand[] = [];
    const marked: string[] = [];
    const bus = new EventBus();
    const conceptStore: ConceptStorePort = {
      loadPool: async () => emptyPool(),
      addCandidate: async () => true,
      markSearched: async (k: string) => { marked.push(k); },
    };
    const d = new RoleDispatcher({
      soul: mockSoul,
      llm: llmReturning('pass'),
      eventBus: bus,
      sendCommand: (c) => commands.push(c),
      conceptStore,
      clock: () => 0,
    });
    d.setup();
    d.startSession(); // 指令翻译接线随会话激活进行（multi-account：setup 不再接线）
    return { bus, commands, marked, d };
  }

  const searchCmds = (cmds: EdgeCommand[]) => cmds.filter((c) => c.action === 'search');

  it('AC-SEARCH-05 两道闸通过 → 下发 search（带 source）+ markSearched', () => {
    const { bus, commands, marked } = setupDispatcher();

    bus.emit('search.approved', { keyword: '向量数据库', reason: 'r', source: 'new_concept', ts: 0 });

    const cmds = searchCmds(commands);
    assert.equal(cmds.length, 1, '应下发一条 search');
    assert.equal(cmds[0].params?.keyword, '向量数据库');
    assert.equal(cmds[0].params?.source, 'new_concept', 'source 必须透传到指令');
    assert.deepEqual(marked, ['向量数据库'], '通过后应 markSearched');
  });

  it('AC-SEARCH-06 预算耗尽 → 被拦，不下发、不 markSearched（红线：不假成功）', () => {
    const { bus, commands, marked, d } = setupDispatcher();
    // 抽干搜索预算（freshBudget.searches=5）
    for (let i = 0; i < 5; i++) d.consumeBudget('search');

    bus.emit('search.approved', { keyword: 'LLM Agent', reason: 'r', source: 'random_from_interests', ts: 0 });

    assert.equal(searchCmds(commands).length, 0, '预算耗尽必须不下发');
    assert.deepEqual(marked, [], '被拦时不得 markSearched');
  });

  it('AC-SEARCH-07 限频拦截：同一关键词第二次被拦（默认 maxPerSession=1）', () => {
    const { bus, commands, marked } = setupDispatcher();

    bus.emit('search.approved', { keyword: 'RAG 实战', reason: 'r', source: 'random_from_interests', ts: 0 });
    bus.emit('search.approved', { keyword: 'RAG 实战', reason: 'r', source: 'random_from_interests', ts: 0 });

    assert.equal(searchCmds(commands).length, 1, '同词第二次应被限频闸拦下，仅下发一次');
    assert.deepEqual(marked, ['RAG 实战'], '仅第一次通过时 markSearched');
  });
});
