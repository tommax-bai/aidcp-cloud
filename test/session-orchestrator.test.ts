import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SessionOrchestrator,
  EngagementDecider,
  ConceptExtractor,
  type CommandSink,
  type ConceptPersistence,
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

test('orchestrator.onNote: 高质量笔记 → like + 抽概念 + browse_next', async () => {
  const decideLlm: LlmClient = { complete: async () => '{"action":"like","reason":"干货"}' };
  const extractLlm: LlmClient = { complete: async () => '["LoRA 微调"]' };
  const { sink, sent } = collectSink();
  const orch = new SessionOrchestrator({
    soul,
    decider: new EngagementDecider({ soul, llm: decideLlm }),
    extractor: new ConceptExtractor({ llm: extractLlm }),
    sink,
    persistence: memPersistence,
    clock: () => 1000,
    rng: () => 0,
    idGen: () => 'cmd-1',
  });
  await orch.start();
  const outcome = await orch.onNote({
    noteId: 'n1', title: '大模型推理优化实战', summary: 'vLLM + LoRA',
    likeCount: 300, collectCount: 120,
  });
  assert.equal(outcome.action, 'like');
  assert.deepEqual(outcome.newConcepts, ['LoRA 微调']);
  // 抽到新概念后概念池有候选 → found_new_concept 触发，迁移到 search
  assert.equal(outcome.command.kind, 'search');
  assert.equal(sent[0].type, 'search.execute');
  assert.equal(orch.session.totalLikes, 1);
});

test('orchestrator.onNote: 低质量笔记 → skip，不抽概念', async () => {
  const decideLlm: LlmClient = { complete: async () => { throw new Error('should not be called'); } };
  let extractCalled = false;
  const extractLlm: LlmClient = { complete: async () => { extractCalled = true; return '[]'; } };
  const { sink, sent } = collectSink();
  const orch = new SessionOrchestrator({
    soul,
    decider: new EngagementDecider({ soul, llm: decideLlm }),
    extractor: new ConceptExtractor({ llm: extractLlm }),
    sink,
    clock: () => 1000,
    rng: () => 0,
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
