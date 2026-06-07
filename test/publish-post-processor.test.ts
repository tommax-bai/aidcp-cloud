import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PostProcessor,
  detectBannedPhrases,
  aiScoreFromHits,
} from '../src/publish-agent/post-processor.js';
import { BANNED_PHRASES } from '../src/publish-agent/prompts.js';

test('detectBannedPhrases 命中禁用词', () => {
  const hits = detectBannedPhrases('首先我们来看，其次还有，综上所述就这样');
  assert.ok(hits.includes('首先'));
  assert.ok(hits.includes('其次'));
  assert.ok(hits.includes('综上所述'));
});

test('detectBannedPhrases 干净文本 → 空', () => {
  assert.deepEqual(detectBannedPhrases('昨天调 bug 发现一个坑，记录下'), []);
});

test('detectBannedPhrases 过量感叹号被标记（>1）', () => {
  const hits = detectBannedPhrases('太强了！真香！');
  assert.ok(hits.includes('过量感叹号'));
});

test('detectBannedPhrases 单个感叹号不标记', () => {
  const hits = detectBannedPhrases('太强了！这个真的好用');
  assert.equal(hits.includes('过量感叹号'), false);
});

test('aiScoreFromHits 单调且封顶 1', () => {
  assert.equal(aiScoreFromHits(0), 0);
  assert.ok(aiScoreFromHits(1) > 0 && aiScoreFromHits(1) < 1);
  assert.equal(aiScoreFromHits(4), 1);
  assert.equal(aiScoreFromHits(10), 1);
});

test('BANNED_PHRASES 含设计要求的关键禁用词', () => {
  for (const p of ['首先', '值得一提的是', '众所周知', '总的来说', '综上所述', '各有优劣']) {
    assert.ok(BANNED_PHRASES.includes(p), `应包含 ${p}`);
  }
});

test('process 未达重写阈值 → 不重写', async () => {
  let called = false;
  const pp = new PostProcessor({ rewriteThreshold: 2, rewrite: async (c) => { called = true; return c; } });
  const res = await pp.process('首先讲个事'); // 仅命中 1 个
  assert.equal(res.rewritten, false);
  assert.equal(called, false);
  assert.deepEqual(res.flaggedPhrases, ['首先']);
});

test('process 命中 >= 阈值 → 触发重写，复检干净', async () => {
  const pp = new PostProcessor({
    rewriteThreshold: 2,
    rewrite: async () => '昨天试了三种方案，就这个最稳，记录下',
  });
  const res = await pp.process('首先看这个，其次看那个，综上所述');
  assert.equal(res.rewritten, true);
  assert.deepEqual(res.flaggedPhrases, []);
  assert.equal(res.aiScore, 0);
  assert.match(res.content, /三种方案/);
});

test('process 重写后仍命中 → flaggedPhrases 非空、aiScore 偏高（供上层标记审核）', async () => {
  const pp = new PostProcessor({
    rewriteThreshold: 2,
    rewrite: async () => '首先这样，其次那样，最后总结来说', // 重写器没改好
  });
  const res = await pp.process('首先这样，其次那样，众所周知');
  assert.equal(res.rewritten, true);
  assert.ok(res.flaggedPhrases.length >= 2);
  assert.ok(res.aiScore >= 0.5);
});

test('process 无重写器 → 仅检测不重写', async () => {
  const pp = new PostProcessor({ rewriteThreshold: 2 });
  const res = await pp.process('首先，其次，综上所述');
  assert.equal(res.rewritten, false);
  assert.ok(res.flaggedPhrases.length >= 3);
});

test('process 重写器抛错 → 退回原文、不算重写', async () => {
  const pp = new PostProcessor({ rewriteThreshold: 2, rewrite: async () => { throw new Error('boom'); } });
  const res = await pp.process('首先，其次，综上所述');
  assert.equal(res.rewritten, false);
  assert.match(res.content, /首先/);
});