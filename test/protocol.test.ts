import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  makeEnvelope,
  parseEnvelope,
  isEnvelope,
  PROTOCOL_VERSION,
} from '../src/comm/index.js';

test('makeEnvelope 产出带版本/类型/id/ts 的合法信封', () => {
  const env = makeEnvelope('ping', 'req-1', 123, {});
  assert.equal(env.v, PROTOCOL_VERSION);
  assert.equal(env.type, 'ping');
  assert.equal(env.id, 'req-1');
  assert.equal(env.ts, 123);
  assert.ok(isEnvelope(env));
});

test('parseEnvelope 解析合法 JSON 帧', () => {
  const text = JSON.stringify(makeEnvelope('plan.request', 'r1', 1, { goal: '点赞' }));
  const env = parseEnvelope(text);
  assert.ok(env);
  assert.equal(env?.type, 'plan.request');
  assert.deepEqual(env?.payload, { goal: '点赞' });
});

test('parseEnvelope 对坏数据返回 null', () => {
  assert.equal(parseEnvelope('not json'), null);
  assert.equal(parseEnvelope('{"v":1}'), null, '缺字段不是合法信封');
});

test('makeEnvelope 构造 publish.request（类型安全 payload）', () => {
  const env = makeEnvelope('publish.request', 'pub-1', 9, {
    title: '调 RAG 踩坑',
    content: '昨天分块切碎了召回一坨',
    tags: ['RAG', '踩坑'],
  });
  assert.equal(env.type, 'publish.request');
  assert.ok(isEnvelope(env));
  const round = parseEnvelope(JSON.stringify(env));
  assert.equal(round?.type, 'publish.request');
});

test('makeEnvelope 构造 publish.approval_request', () => {
  const env = makeEnvelope('publish.approval_request', 'apr-1', 9, {
    requestId: 'req-1',
    title: '调 RAG 踩坑',
    content: '昨天分块切碎了召回一坨',
    tags: ['RAG', '踩坑'],
    edgeId: 'edge-1',
  });
  assert.equal(env.type, 'publish.approval_request');
  assert.ok(isEnvelope(env));
  const round = parseEnvelope(JSON.stringify(env));
  assert.equal(round?.type, 'publish.approval_request');
});

test('makeEnvelope 构造 publish.result', () => {
  const ok = makeEnvelope('publish.result', 'pub-1', 9, { ok: true, postId: 'xhs-123' });
  assert.equal(ok.type, 'publish.result');
  const fail = makeEnvelope('publish.result', 'pub-2', 10, { ok: false, error: '页面超时' });
  const round = parseEnvelope(JSON.stringify(fail));
  assert.equal(round?.type, 'publish.result');
  assert.deepEqual(round?.payload, { ok: false, error: '页面超时' });
});
