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
