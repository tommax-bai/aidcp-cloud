import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SessionOrchestrator,
  EngagementDecider,
  ConceptExtractor,
  ContextBuilder,
  parseManagerDecision,
  type CommandSink,
  type ConceptPersistence,
  type ManagerDecider,
  type ManagerDecision,
} from '../src/orchestrator/index.js';
import { loadSoul } from '../src/soul/index.js';
import type { Envelope } from '../src/comm/index.js';
import type { LlmClient } from '../src/llm/index.js';

const soul = loadSoul();

function collectSink(): { sink: CommandSink; sent: Envelope[] } {
  const sent: Envelope[] = [];
  return { sink: { send: (e) => sent.push(e) }, sent };
}

const memPersistence: ConceptPersistence = {
  loadPool: async () => ({ known: [], candidates: [], source: new Map() }),
  addCandidates: async (kws) => kws,
  markSearched: async () => {},
};

function manager(actionJson: string): ManagerDecider {
  const decision: ManagerDecision = JSON.parse(actionJson);
  return { decide: async () => decision };
}

test('manager parser: invalid JSON or unavailable action falls back to browse_next', () => {
  assert.equal(parseManagerDecision('bad', ['search']).action, 'browse_next');
  assert.equal(parseManagerDecision('{"action":"like"}', ['browse_next']).action, 'browse_next');
  assert.equal(parseManagerDecision('{"action":"search","params":{}}', ['search']).action, 'browse_next');
});

test('context builder: includes risk budget and filters unavailable interactions', () => {
  const context = new ContextBuilder().build({
    pageType: 'note',
    loginState: 'logged_in',
    note: { noteId: 'n1', title: 'T', content: '', author: '', likeCount: 0, collectCount: 0, isLiked: false, isCollected: false },
    sessionStats: { startedAt: 1, durationMs: 10, views: 1, likes: 0, collects: 0, searches: 0, follows: 0 },
    riskStatus: {
      status: 'restricted',
      quotaLevel: 'normal',
      remainingActionsToday: { like: 0, collect: 2 },
      viewOnly: false,
    },
  });
  assert.equal(context.currentPage.type, 'note');
  assert.equal(context.riskStatus.remainingActionsToday.collect, 2);
  assert.ok(!context.availableActions.includes('like'));
  assert.ok(context.availableActions.includes('collect'));
  assert.ok(context.availableActions.includes('close_note'));
});

test('orchestrator.onNote: 高质量笔记 → like + 抽概念 + manager search', async () => {
  const decideLlm: LlmClient = { complete: async () => '{"action":"like","reason":"干货"}' };
  const extractLlm: LlmClient = { complete: async () => '["LoRA 微调"]' };
  const { sink, sent } = collectSink();
  const orch = new SessionOrchestrator({
    soul,
    decider: new EngagementDecider({ soul, llm: decideLlm }),
    extractor: new ConceptExtractor({ llm: extractLlm }),
    sink,
    manager: manager('{"action":"search","params":{"keyword":"LoRA 微调"},"reason":"深入相关概念"}'),
    persistence: memPersistence,
    clock: () => 1000,
    idGen: () => 'cmd-1',
  });
  await orch.start();
  const outcome = await orch.onNote({
    noteId: 'n1', title: '大模型推理优化实战', summary: 'vLLM + LoRA',
    likeCount: 300, collectCount: 120,
  });
  assert.equal(outcome.action, 'like');
  assert.deepEqual(outcome.newConcepts, ['LoRA 微调']);
  assert.equal(outcome.command.action, 'search');
  assert.equal(sent[0].type, 'search.execute');
  assert.equal((sent[0].payload as { keyword: string }).keyword, 'LoRA 微调');
  assert.equal(orch.session.likes, 1);
  assert.equal(orch.session.searches, 1);
});

test('orchestrator.onNote: 低质量笔记 → skip', async () => {
  const decideLlm: LlmClient = { complete: async () => '{"action":"skip","reason":"不相关"}' };
  let extractCalled = false;
  const extractLlm: LlmClient = { complete: async () => { extractCalled = true; return '[]'; } };
  const { sink, sent } = collectSink();
  const orch = new SessionOrchestrator({
    soul,
    decider: new EngagementDecider({ soul, llm: decideLlm }),
    extractor: new ConceptExtractor({ llm: extractLlm }),
    sink,
    manager: manager('{"action":"browse_next","reason":"继续观察"}'),
    clock: () => 1000,
  });
  await orch.start();
  const outcome = await orch.onNote({
    noteId: 'n2', title: '标题党', summary: '无解读',
    likeCount: 5, collectCount: 1,
  });
  assert.equal(outcome.action, 'skip');
  assert.equal(extractCalled, false);
  assert.equal(outcome.newConcepts.length, 0);
  assert.equal(sent[0].type, 'browse.next');
});

test('orchestrator.kick 下发首条 browse.next', async () => {
  const { sink, sent } = collectSink();
  const orch = new SessionOrchestrator({
    soul,
    decider: new EngagementDecider({ soul, llm: { complete: async () => '{}' } }),
    extractor: new ConceptExtractor({ llm: { complete: async () => '[]' } }),
    sink,
    clock: () => 1000,
  });
  await orch.start();
  const env = orch.kick();
  assert.equal(env.type, 'browse.next');
  assert.equal(sent.length, 1);
});
