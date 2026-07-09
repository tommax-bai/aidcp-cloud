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

test('FacebookGroupJoinJudge fails closed on low-confidence model instant_join', async () => {
  const judge = new FacebookGroupJoinJudge({
    llm: { complete: async () => '{"verdict":"instant_join","confidence":0.4,"reason":"button visible only"}' },
  });

  const result = await judge.evaluatePreClick({ mainCtaText: 'Join group', headerText: 'Public group' });
  assert.equal(result.verdict, 'ambiguous_skip');
  assert.match(result.reason, /fail_closed/);
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
