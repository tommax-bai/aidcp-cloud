import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ConceptExtractor,
  parseConcepts,
  mergeConcepts,
  buildExtractPrompt,
  emptyConceptPool,
} from '../src/orchestrator/index.js';
import type { LlmClient } from '../src/llm/index.js';

test('parseConcepts 解析 JSON 数组（容忍围栏/多余文字）', () => {
  assert.deepEqual(parseConcepts('```json\n["A", "B"]\n```'), ['A', 'B']);
  assert.deepEqual(parseConcepts('好的：["X","Y","Z","W"] 完毕'), ['X', 'Y', 'Z']); // 最多 3 个
});

test('parseConcepts 过滤空串/超长串/重复', () => {
  const long = 'x'.repeat(40);
  assert.deepEqual(parseConcepts(`["", "ok", "ok", "${long}"]`), ['ok']);
});

test('parseConcepts 容忍非 JSON → 空数组', () => {
  assert.deepEqual(parseConcepts('我不知道'), []);
});

test('mergeConcepts 去重 known/candidates 并登记来源', () => {
  const pool = emptyConceptPool();
  pool.known.push('已知概念');
  pool.candidates.push('待搜概念');
  const added = mergeConcepts(['已知概念', '待搜概念', '新概念'], pool, '来源笔记');
  assert.deepEqual(added, ['新概念']);
  assert.ok(pool.candidates.includes('新概念'));
  assert.equal(pool.source.get('新概念'), '来源笔记');
});

test('buildExtractPrompt 含标题与摘要', () => {
  const p = buildExtractPrompt({ title: 'T标题', summary: 'S摘要' });
  assert.match(p, /T标题/);
  assert.match(p, /S摘要/);
  assert.match(p, /JSON数组/);
});

test('ConceptExtractor.extract 用 mock Qwen 抽取并入池', async () => {
  const llm: LlmClient = { complete: async () => '["RAG 重排", "向量量化"]' };
  const extractor = new ConceptExtractor({ llm });
  const pool = emptyConceptPool();
  const res = await extractor.extract({ title: 't', summary: 's' }, pool, '来源');
  assert.deepEqual(res.newConcepts, ['RAG 重排', '向量量化']);
  assert.deepEqual(pool.candidates, ['RAG 重排', '向量量化']);
  assert.equal(pool.source.get('RAG 重排'), '来源');
});

test('ConceptExtractor.extract LLM 抛错 → 返回空，不影响主流程', async () => {
  const llm: LlmClient = { complete: async () => { throw new Error('boom'); } };
  const extractor = new ConceptExtractor({ llm });
  const pool = emptyConceptPool();
  const res = await extractor.extract({ title: 't', summary: 's' }, pool);
  assert.deepEqual(res.newConcepts, []);
  assert.equal(pool.candidates.length, 0);
});
