import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDelegatedText } from '../../src/delegated-task/parser.js';

const NOW = Date.parse('2026-07-15T10:00:00+08:00');

test('parses batch comment goal with nickname, success count, attempts and priority', () => {
  const parsed = parseDelegatedText('让小萝北今晚前完成 5 条有效评论，最多尝试 8 次，优先执行', { now: NOW });
  assert.equal(parsed.ok, true);
  if (!parsed.ok || parsed.kind !== 'intent') return;
  assert.equal(parsed.nickname, '小萝北');
  assert.equal(parsed.intent.action, 'comment_batch');
  assert.equal(parsed.intent.targetSuccessCount, 5);
  assert.equal(parsed.intent.maxAttempts, 8);
  assert.equal(parsed.intent.priority, 'high');
  assert.ok(parsed.intent.deadlineAt > NOW);
});

test('legacy write slash command remains syntax-compatible but becomes a single task intent', () => {
  const parsed = parseDelegatedText('/comment 工程师大白 --contact --force', { now: NOW });
  assert.equal(parsed.ok, true);
  if (!parsed.ok || parsed.kind !== 'intent') return;
  assert.equal(parsed.nickname, '工程师大白');
  assert.equal(parsed.intent.source, 'legacy_command');
  assert.equal(parsed.intent.targetSuccessCount, 1);
  assert.equal(parsed.intent.targetConstraints?.manualSingle, true);
  assert.equal(parsed.intent.targetConstraints?.injectContact, true);
});

test('parses candidates, curated comment and task controls', () => {
  const candidates = parseDelegatedText('让小萝北生成 3 个候选稿但暂不发布', { now: NOW });
  assert.equal(candidates.ok && candidates.kind === 'intent' ? candidates.intent.action : '', 'generate_candidates');
  const curated = parseDelegatedText('让小萝北对精选内容 42 发起评论', { now: NOW });
  assert.equal(curated.ok && curated.kind === 'intent' ? curated.intent.targetConstraints?.curatedId : '', '42');
  const control = parseDelegatedText('暂停任务 019f6475-dbc7-4913-be36-2cd0b174762e', { now: NOW });
  assert.equal(control.ok && control.kind === 'control' ? control.action : '', 'pause');
});

test('fails closed when curated target or nickname is missing', () => {
  const curated = parseDelegatedText('对精选内容发起评论', { now: NOW });
  assert.equal(curated.ok, false);
  const vague = parseDelegatedText('完成 5 条评论', { now: NOW });
  assert.equal(vague.ok, false);
});
