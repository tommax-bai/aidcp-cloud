import { test } from 'node:test';
import assert from 'node:assert/strict';
import { triggerGatedAutoComment, type GatedAutoCommentDeps } from '../src/comment-agent/gated-auto-comment.js';

function deps(over: Partial<{
  canComment: boolean;
  attempts: number;
  cap: number;
  sessionRemaining: number | undefined;
}> = {}) {
  const calls = { recordComment: 0, recordAttempt: 0, triggered: 0 };
  const d: GatedAutoCommentDeps = {
    canComment: async () => over.canComment ?? true,
    recordComment: async () => { calls.recordComment++; return true; },
    countAttemptsToday: async () => over.attempts ?? 0,
    getDailyCap: async () => over.cap ?? 3,
    recordAttempt: async () => { calls.recordAttempt++; },
    ...(over.sessionRemaining !== undefined
      ? { getSessionCommentBudgetRemaining: () => over.sessionRemaining as number }
      : {}),
  };
  return { d, calls };
}

const okTrigger = (calls: { triggered: number }) => async () => { calls.triggered++; return { ok: true }; };

test('全闸过 → 触发 + 记共用配额 + 记子上限', async () => {
  const { d, calls } = deps();
  const r = await triggerGatedAutoComment({ accountId: 'a', source: 'hot_lead', triggerFn: okTrigger(calls) }, d);
  assert.equal(r.fired, true);
  assert.equal(calls.triggered, 1);
  assert.equal(calls.recordComment, 1);
  assert.equal(calls.recordAttempt, 1);
});

test('单场评论预算耗尽 → 不触发、不记账', async () => {
  const { d, calls } = deps({ sessionRemaining: 0 });
  const r = await triggerGatedAutoComment({ accountId: 'a', source: 'hot_lead', triggerFn: okTrigger(calls) }, d);
  assert.equal(r.fired, false);
  assert.equal(r.reason, 'session_budget');
  assert.equal(calls.triggered, 0);
  assert.equal(calls.recordComment, 0);
});

test('风控配额/状态拒 → 不触发、不记账（共用配额闸）', async () => {
  const { d, calls } = deps({ canComment: false });
  const r = await triggerGatedAutoComment({ accountId: 'a', source: 'scheduled_contact', triggerFn: okTrigger(calls) }, d);
  assert.equal(r.fired, false);
  assert.equal(r.reason, 'risk_blocked');
  assert.equal(calls.triggered, 0);
  assert.equal(calls.recordComment, 0);
});

test('子上限已满 → 不触发', async () => {
  const { d, calls } = deps({ attempts: 3, cap: 3 });
  const r = await triggerGatedAutoComment({ accountId: 'a', source: 'hot_lead', triggerFn: okTrigger(calls) }, d);
  assert.equal(r.fired, false);
  assert.equal(r.reason, 'daily_cap');
  assert.equal(calls.triggered, 0);
});

test('配置>安全额时子上限受配额封顶（canDo 先拦=min）', async () => {
  // cap 配置很大，但共用配额已耗尽（canComment=false）→ 先被 risk_blocked，等价 min(cap, 配额)
  const { d, calls } = deps({ cap: 999, canComment: false });
  const r = await triggerGatedAutoComment({ accountId: 'a', source: 'hot_lead', triggerFn: okTrigger(calls) }, d);
  assert.equal(r.fired, false);
  assert.equal(r.reason, 'risk_blocked');
});

test('触发回执非 ok（单飞/离线/缺码）→ 不记账（未真开跑）', async () => {
  const { d, calls } = deps();
  const r = await triggerGatedAutoComment(
    { accountId: 'a', source: 'hot_lead', triggerFn: async () => ({ ok: false, reason: 'running' }) },
    d,
  );
  assert.equal(r.fired, false);
  assert.equal(r.reason, 'running');
  assert.equal(calls.recordComment, 0);
  assert.equal(calls.recordAttempt, 0);
});
