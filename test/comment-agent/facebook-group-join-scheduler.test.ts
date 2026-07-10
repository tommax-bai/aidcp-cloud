import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { EventBus } from '../../src/event-bus/index.js';
import { FacebookGroupJoinScheduler } from '../../src/comment-agent/facebook-group-join-scheduler.js';
import type { FacebookGroupJoinAuditRow, FacebookGroupMembershipRow } from '../../src/comment-agent/facebook-group-store.js';

interface Env {
  type: string;
  payload: Record<string, unknown>;
}

const GROUP = 'https://www.facebook.com/groups/1';

function membership(over: Partial<FacebookGroupMembershipRow> = {}): FacebookGroupMembershipRow {
  return {
    accountId: 'acc-fb',
    groupUrl: GROUP,
    status: 'assigned',
    assignedAt: new Date().toISOString(),
    joinedAt: null,
    lastAttemptAt: null,
    attempts: 0,
    lastReason: null,
    lastCommentedAt: null,
    cooldownUntil: null,
    commentsTotal: 0,
    leftConfirmations: 0,
    updatedAt: new Date().toISOString(),
    ...over,
  };
}

function makeHarness(opts: {
  auto?: boolean;
  shadow?: boolean;
  canJoin?: boolean;
  canUseSessionJoin?: boolean;
  llmVerdicts?: string[];
  edge?: (env: Env, bus: EventBus) => void;
} = {}) {
  const bus = new EventBus();
  const sent: Env[] = [];
  const auditRows: FacebookGroupJoinAuditRow[] = [];
  const membershipCalls: string[] = [];
  const targetCalls: string[] = [];
  const sessionBudgetCalls: string[] = [];
  const paused: string[] = [];
  let llmIndex = 0;

  const targets = {
    nextJoinCandidate: async () => ({
      groupUrl: GROUP,
      groupName: null,
      joinGating: 'unknown' as const,
      priority: 0,
      enabled: true,
      importBatch: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }),
    markJoinGating: async (groupUrl: string, gating: string) => {
      targetCalls.push(`gating:${groupUrl}:${gating}`);
    },
  };
  const memberships = {
    currentAssignment: async () => null,
    claimNext: async () => {
      membershipCalls.push('claim');
      return membership();
    },
    markJoining: async (_accountId: string, groupUrl: string) => {
      membershipCalls.push(`joining:${groupUrl}`);
    },
    markJoined: async (_accountId: string, groupUrl: string, reason?: string) => {
      membershipCalls.push(`joined:${groupUrl}:${reason ?? ''}`);
    },
    markOutcome: async (_accountId: string, groupUrl: string, status: string, reason: string) => {
      membershipCalls.push(`outcome:${groupUrl}:${status}:${reason}`);
    },
    markRetryableFailure: async (_accountId: string, groupUrl: string, reason: string) => {
      membershipCalls.push(`retry:${groupUrl}:${reason}`);
      return 'retryable' as const;
    },
  };
  const audit = {
    append: async (row: FacebookGroupJoinAuditRow) => {
      auditRows.push(row);
    },
  };
  const pusher = {
    pushToEdges: (envelope: unknown): number => {
      const env = envelope as Env;
      sent.push(env);
      opts.edge?.(env, bus);
      return 1;
    },
  };
  const scheduler = new FacebookGroupJoinScheduler({
    resolveConnection: () => ({ bus, edgeId: 'edge-fb' }),
    pusher,
    targets: targets as never,
    memberships: memberships as never,
    audit: audit as never,
    llmFor: () => ({
      complete: async () => opts.llmVerdicts?.[llmIndex++] ?? '{"verdict":"ambiguous_skip","confidence":0.2,"reason":"test"}',
    }),
    canJoin: async () => opts.canJoin ?? true,
    canUseSessionJoin: async () => opts.canUseSessionJoin ?? true,
    recordSessionJoin: async (accountId, edgeId) => {
      sessionBudgetCalls.push(`${accountId}:${edgeId ?? ''}`);
      return true;
    },
    isFacebookAccount: async () => true,
    pauseAccount: async (accountId, reason) => {
      paused.push(`${accountId}:${reason}`);
    },
    autoEnabled: () => opts.auto ?? false,
    shadow: () => opts.shadow ?? false,
    stepTimeoutMs: 20,
    logger: { warn: () => {}, log: () => {} },
  });
  return { scheduler, sent, auditRows, membershipCalls, targetCalls, sessionBudgetCalls, paused, bus };
}

describe('FacebookGroupJoinScheduler', () => {
  it('default-off: auto/shadow 都未开时不 claim、不下发', async () => {
    const h = makeHarness();
    const r = await h.scheduler.triggerScheduled('acc-fb');
    assert.equal(r.triggered, false);
    assert.equal(r.reason, 'disabled');
    assert.deepEqual(h.sent, []);
    assert.deepEqual(h.membershipCalls, []);
  });

  it('shadow: 只 observe + judge + audit，不 claim membership', async () => {
    const h = makeHarness({
      shadow: true,
      llmVerdicts: ['{"verdict":"instant_join","confidence":0.9,"reason":"visible join"}'],
      edge: (env, bus) => {
        bus.emit('action.completed', {
          action: 'join_group',
          ok: false,
          reason: 'observation_only',
          groupUrl: env.payload.groupUrl,
          clicked: false,
          observation: { groupUrl: env.payload.groupUrl, mainCtaText: 'Join group' },
          ts: 0,
        } as never);
      },
    });
    const r = await h.scheduler.triggerScheduled('acc-fb');
    assert.equal(r.triggered, true);
    assert.equal(r.outcome, 'instant_join');
    assert.equal(h.sent[0].type, 'group.join');
    assert.equal(h.sent[0].payload.click, false);
    assert.deepEqual(h.membershipCalls, []);
    assert.ok(h.auditRows.some((row) => row.shadow === true && row.verdict === 'instant_join'));
  });

  it('real: pre-click gated verdict 写 membership gated + target gated，不点击', async () => {
    const h = makeHarness({
      auto: true,
      edge: (env, bus) => {
        bus.emit('action.completed', {
          action: 'join_group',
          ok: false,
          reason: 'observation_only',
          groupUrl: env.payload.groupUrl,
          clicked: false,
          observation: {
            groupUrl: env.payload.groupUrl,
            mainCtaText: 'Join group',
            modalText: 'Membership questions are required',
            questionnaireRequired: true,
          },
          ts: 0,
        } as never);
      },
    });
    const r = await h.scheduler.triggerScheduled('acc-fb');
    assert.equal(r.outcome, 'gated_skip');
    assert.deepEqual(h.sent.map((e) => e.payload.click), [false]);
    assert.ok(h.membershipCalls.includes(`outcome:${GROUP}:gated:gated_or_questionnaire_signal`));
    assert.ok(h.targetCalls.includes(`gating:${GROUP}:gated`));
    assert.deepEqual(h.sessionBudgetCalls, []);
  });

  it('real: 单场加群预算耗尽时不 claim、不下发', async () => {
    const h = makeHarness({ auto: true, canUseSessionJoin: false });
    const r = await h.scheduler.triggerScheduled('acc-fb');
    assert.equal(r.triggered, false);
    assert.equal(r.reason, 'session_budget');
    assert.deepEqual(h.sent, []);
    assert.deepEqual(h.membershipCalls, []);
    assert.ok(h.auditRows.some((row) => row.outcome === 'quota_denied' && row.reason === 'session_budget'));
  });

  it('real: instant pre-click + joined post-click 写 joined', async () => {
    let call = 0;
    const h = makeHarness({
      auto: true,
      llmVerdicts: ['{"verdict":"instant_join","confidence":0.9,"reason":"instant"}'],
      edge: (env, bus) => {
        call++;
        if (call === 1) {
          bus.emit('action.completed', {
            action: 'join_group',
            ok: false,
            reason: 'observation_only',
            groupUrl: env.payload.groupUrl,
            clicked: false,
            observation: { groupUrl: env.payload.groupUrl, mainCtaText: 'Join group' },
            ts: 0,
          } as never);
          return;
        }
        bus.emit('action.completed', {
          action: 'join_group',
          ok: true,
          groupUrl: env.payload.groupUrl,
          clicked: true,
          postObservation: { groupUrl: env.payload.groupUrl, mainCtaText: 'Joined', membershipSignals: ['You are now a member'] },
          ts: 0,
        } as never);
      },
    });
    const r = await h.scheduler.triggerScheduled('acc-fb');
    assert.equal(r.outcome, 'joined');
    assert.deepEqual(h.sent.map((e) => e.payload.click), [false, true]);
    assert.ok(h.membershipCalls.some((c) => c.startsWith(`joined:${GROUP}:member_signal`)));
    assert.ok(h.targetCalls.includes(`gating:${GROUP}:instant`));
    assert.deepEqual(h.sessionBudgetCalls, ['acc-fb:edge-fb']);
  });

  it('real: login_required observation 暂停账号并保留 retryable assignment，不学习 group gated', async () => {
    const h = makeHarness({
      auto: true,
      edge: (env, bus) => {
        bus.emit('action.completed', {
          action: 'join_group',
          ok: false,
          reason: 'login_required',
          groupUrl: env.payload.groupUrl,
          clicked: false,
          ts: 0,
        } as never);
      },
    });
    const r = await h.scheduler.triggerScheduled('acc-fb');
    assert.equal(r.outcome, 'login_required');
    assert.ok(h.membershipCalls.includes(`retry:${GROUP}:login_required`));
    assert.deepEqual(h.paused, ['acc-fb:facebook_group_join:login_required']);
    assert.deepEqual(h.targetCalls, [], '登录态问题是账号 transient，不学习 group gated');
  });
});
