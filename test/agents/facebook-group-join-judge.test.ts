import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FacebookGroupJoinJudge } from '../../src/agents/facebook-group-join-judge.js';
import type { FacebookGroupJoinAuditRow } from '../../src/comment-agent/facebook-group-store.js';

test('FacebookGroupJoinJudge pre-click skips already-member and gated observations without LLM', async () => {
  let calls = 0;
  const judge = new FacebookGroupJoinJudge({
    llm: { complete: async () => { calls++; return '{}'; } },
  });

  const member = await judge.evaluatePreClick({ mainCtaText: 'Joined', membershipSignals: ['Member of this group'] });
  assert.equal(member.verdict, 'already_member');

  const gated = await judge.evaluatePreClick({ mainCtaText: 'Join group', modalText: 'Answer membership questions before approval' });
  assert.equal(gated.verdict, 'gated_skip');
  assert.equal(calls, 0);
});

test('FacebookGroupJoinJudge fails closed on low-confidence model instant_join (no clear join CTA → LLM)', async () => {
  const judge = new FacebookGroupJoinJudge({
    llm: { complete: async () => '{"verdict":"instant_join","confidence":0.4,"reason":"unclear"}' },
  });

  // 无清晰加入 CTA（"View" 非加入词）→ 不走确定性 instant_join → 交 LLM → 低置信 → fail-closed。
  const result = await judge.evaluatePreClick({ mainCtaText: 'View', headerText: 'Public group' });
  assert.equal(result.verdict, 'ambiguous_skip');
  assert.match(result.reason, /fail_closed/);
});

test('FacebookGroupJoinJudge: clear Join CTA → deterministic instant_join, ignores documentReady=loading, no LLM', async () => {
  let calls = 0;
  const judge = new FacebookGroupJoinJudge({
    llm: { complete: async () => { calls++; return '{"verdict":"ambiguous_skip","confidence":0.9,"reason":"loading"}'; } },
  });
  // 真机回归:清晰「加入小组」+ documentReady='loading'（诊断字段）→ 应确定性 instant_join,不问 LLM、不被 loading 影响。
  const r = await judge.evaluatePreClick({
    mainCtaText: '加入小组',
    mainCtaAria: '加入小组',
    headerText: 'Tuyển Dụng Hà Nam 公开小组',
    // @ts-expect-error 诊断字段（边缘上报，云端类型未声明）——刻意验证它不影响判定
    documentReady: 'loading',
  });
  assert.equal(r.verdict, 'instant_join');
  assert.equal(r.reason, 'clear_join_cta');
  assert.equal(calls, 0, 'clear join CTA 不问 LLM（不受 loading 诊断字段左右）');
});

test('FacebookGroupJoinJudge records audit rows without affecting verdict', async () => {
  const rows: FacebookGroupJoinAuditRow[] = [];
  const judge = new FacebookGroupJoinJudge({
    accountId: 'fb-1',
    audit: (row) => rows.push(row),
  });

  const result = await judge.evaluatePostClick({
    groupUrl: 'https://www.facebook.com/groups/group-a',
    membershipSignals: ['You are now a member'],
  });

  assert.equal(result.verdict, 'joined');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].accountId, 'fb-1');
  assert.equal(rows[0].outcome, 'joined');
  assert.equal(rows[0].verdict, 'joined');
});
