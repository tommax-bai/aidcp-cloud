import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  EngagementDecider,
  parseDecision,
  buildEngagementPrompt,
} from '../src/orchestrator/index.js';
import { loadSoul } from '../src/soul/index.js';
import type { LlmClient } from '../src/llm/index.js';

const soul = loadSoul();

test('parseDecision 解析合法 JSON 决策（含 newConcepts）', () => {
  const d = parseDecision('结果：{"action":"like","reason":"干货","newConcepts":["vLLM"]}');
  assert.ok(d);
  assert.equal(d!.action, 'like');
  assert.equal(d!.reason, '干货');
  assert.deepEqual(d!.newConcepts, ['vLLM']);
});

test('parseDecision 非法 action → null', () => {
  assert.equal(parseDecision('{"action":"share","reason":"x"}'), null);
});

test('parseDecision 非 JSON → null', () => {
  assert.equal(parseDecision('不知道'), null);
});

test('buildEngagementPrompt 含人设/兴趣/笔记内容', () => {
  const p = buildEngagementPrompt(
    { title: 'TT', summary: 'SS', likeCount: 99, collectCount: 88 },
    soul,
  );
  assert.match(p, /小林/);
  assert.match(p, /TT/);
  assert.match(p, /99/);
});

test('decide 调用 LLM 并返回 like', async () => {
  let called = false;
  const llm: LlmClient = { complete: async () => { called = true; return '{"action":"like","reason":"干货"}'; } };
  const decider = new EngagementDecider({ soul, llm });
  const d = await decider.decide({ title: 't', summary: 's', likeCount: 1, collectCount: 1 });
  assert.equal(d.action, 'like');
  assert.equal(called, true);
});

test('decide 过门槛 → 用 mock Qwen 决策 like', async () => {
  const llm: LlmClient = {
    complete: async () => '{"action":"like","reason":"强相关干货"}',
  };
  const decider = new EngagementDecider({ soul, llm });
  const d = await decider.decide({ title: 't', summary: 's', likeCount: 200, collectCount: 100 });
  assert.equal(d.action, 'like');
  assert.equal(d.reason, '强相关干货');
});

test('decide 模型输出不可解析 → 保守 skip', async () => {
  const llm: LlmClient = { complete: async () => '随便说点什么' };
  const decider = new EngagementDecider({ soul, llm });
  const d = await decider.decide({ title: 't', summary: 's', likeCount: 200, collectCount: 100 });
  assert.equal(d.action, 'skip');
  assert.match(d.reason, /unparsable_output/);
});

test('decide LLM 抛错 → 保守 skip', async () => {
  const llm: LlmClient = { complete: async () => { throw new Error('net'); } };
  const decider = new EngagementDecider({ soul, llm });
  const d = await decider.decide({ title: 't', summary: 's', likeCount: 200, collectCount: 100 });
  assert.equal(d.action, 'skip');
  assert.match(d.reason, /llm_error/);
});
