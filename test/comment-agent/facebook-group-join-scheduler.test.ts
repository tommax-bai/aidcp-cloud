import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { EventBus } from '../../src/event-bus/index.js';
import { FacebookGroupJoinScheduler } from '../../src/comment-agent/facebook-group-join-scheduler.js';
import { EdgeTaskLeaseError } from '../../src/comm/edge-task-lease-client.js';
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
  /** 每次 withLease 抛出的租约异常（P0-3 测试用）；设置后 observe 步的 withLease 立即抛。 */
  leaseError?: Error;
} = {}) {
  const bus = new EventBus();
  const sent: Env[] = [];
  const auditRows: FacebookGroupJoinAuditRow[] = [];
  const membershipCalls: string[] = [];
  const targetCalls: string[] = [];
  const sessionBudgetCalls: string[] = [];
  const paused: string[] = [];
  const retryBackoffs: number[] = [];
  const transientBackoffs: number[] = [];
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
    markRetryableFailure: async (
      _accountId: string,
      groupUrl: string,
      reason: string,
      options?: { maxAttempts?: number; backoffMs?: number },
    ) => {
      membershipCalls.push(`retry:${groupUrl}:${reason}`);
      if (typeof options?.backoffMs === 'number') retryBackoffs.push(options.backoffMs);
      return 'retryable' as const;
    },
    markTransientRetry: async (
      _accountId: string,
      groupUrl: string,
      reason: string,
      options?: { backoffMs?: number },
    ) => {
      membershipCalls.push(`transient:${groupUrl}:${reason}`);
      if (typeof options?.backoffMs === 'number') transientBackoffs.push(options.backoffMs);
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
    edgeTaskLeases: {
      withLease: async (request, work) => {
        if (opts.leaseError) throw opts.leaseError;
        return work({ taskId: `task-${request.kind}`, edgeId: request.edgeId, kind: request.kind, priority: request.priority });
      },
    },
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
    random: () => 0, // 定值抖动 → 网络瞬态退避取下限 NETWORK_TRANSIENT_BACKOFF_MIN_MS（2min），测试确定性。
    logger: { warn: () => {}, log: () => {} },
  });
  return { scheduler, sent, auditRows, membershipCalls, targetCalls, sessionBudgetCalls, paused, retryBackoffs, transientBackoffs, bus };
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

  it('P0-3/P1-5: 租约异常 → 网络瞬态短退避重试（markTransientRetry），不假成功/不永久失败/不计尝试上限/不暂停账号', async () => {
    const h = makeHarness({
      auto: true,
      leaseError: new EdgeTaskLeaseError('acquire_timeout', 'edge busy'),
    });
    const r = await h.scheduler.triggerScheduled('acc-fb');
    // 异常被接住（不外抛）、诚实回执 lease_unavailable（绝不假成功）。
    assert.equal(r.triggered, true);
    assert.equal(r.outcome, 'lease_unavailable:acquire_timeout');
    // 连租约都没拿到 → 未下发任何 group.join。
    assert.deepEqual(h.sent, []);
    // 走网络瞬态路径 markTransientRetry（非 markRetryableFailure）→ 不计入尝试上限；短退避取下限 2min（random=0）。
    // 堵住「status 停 joining + cooldown 空 → 每 60s 心跳热循环」，且绝不因基础设施瞬态推向永久 failed。
    assert.ok(h.membershipCalls.includes(`transient:${GROUP}:lease_unavailable:acquire_timeout`));
    assert.ok(!h.membershipCalls.some((c) => c.startsWith(`retry:${GROUP}:`)));
    assert.ok(!h.membershipCalls.some((c) => c.startsWith(`outcome:${GROUP}:`) && c.endsWith(':failed')));
    assert.deepEqual(h.transientBackoffs, [2 * 60_000]);
    assert.ok(h.auditRows.some((row) => row.reason === 'lease_unavailable:acquire_timeout:transient_retry'));
    assert.deepEqual(h.paused, []); // 租约瞬态不是 login/captcha → 不暂停账号
  });

  it('P1-5: observe 报 not_ready（慢渲染）→ 网络瞬态短退避重试，绝不喂判定角色/LLM、绝不落永久失败', async () => {
    const h = makeHarness({
      auto: true,
      // 若未被拦截，preClickDeterministic 对该半成品页返回 null → 问 LLM（默认 ambiguous_skip）→ markOutcome('failed')。
      llmVerdicts: ['{"verdict":"ambiguous_skip","confidence":0.2,"reason":"should not be asked"}'],
      edge: (env, bus) => {
        bus.emit('action.completed', {
          action: 'join_group',
          ok: false,
          reason: 'not_ready',
          groupUrl: env.payload.groupUrl,
          clicked: false,
          observation: { groupUrl: env.payload.groupUrl, documentReady: 'loading', actionNodeCount: 0 },
          ts: 0,
        } as never);
      },
    });
    const r = await h.scheduler.triggerScheduled('acc-fb');
    assert.equal(r.triggered, true);
    assert.equal(r.outcome, 'not_ready'); // 被拦截为瞬态，而非 ambiguous_skip（= 证明没走 LLM 终局）
    // 只发了 observe（click=false）一次，没有第二次 clickJoin。
    assert.equal(h.sent.length, 1);
    assert.equal(h.sent[0].payload.click, false);
    // 走网络瞬态：markTransientRetry + 短退避 2min；绝无 markOutcome failed（不永久失败）。
    assert.ok(h.membershipCalls.includes(`transient:${GROUP}:not_ready`));
    assert.ok(!h.membershipCalls.some((c) => c.startsWith(`outcome:${GROUP}:`) && c.endsWith(':failed')));
    assert.deepEqual(h.transientBackoffs, [2 * 60_000]);
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

  it('manual: 配额闸全拒（canJoin=false + canUseSessionJoin=false）仍加群、成功后仍 recordSessionJoin（change manual-comment-bypass-quota）', async () => {
    // 手动 /comment --join 是操作员命令 → 跳过风控速率/状态闸与会话额度闸；仍真加群、账本仍如实记录。
    let call = 0;
    const h = makeHarness({
      auto: true,
      canJoin: false, // 风控（状态/速率）拒
      canUseSessionJoin: false, // 会话额度耗尽
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
    const r = await h.scheduler.triggerScheduled('acc-fb', { manual: true });
    assert.equal(r.triggered, true);
    assert.equal(r.outcome, 'joined', '配额被拒但手动命令仍真加群');
    assert.ok(!h.auditRows.some((row) => row.reason === 'session_budget' || row.reason === 'canDo'), '手动路径绝不产 quota_denied 审计');
    assert.deepEqual(h.sessionBudgetCalls, ['acc-fb:edge-fb'], '成功后仍 recordSessionJoin，账本诚实不漏计');
  });

  it('auto（非 manual）: canJoin=false → quota_denied 不下发（回归：manual 旗标不误伤自动巡回）', async () => {
    const h = makeHarness({ auto: true, canJoin: false });
    const r = await h.scheduler.triggerScheduled('acc-fb');
    assert.equal(r.triggered, false);
    assert.equal(r.reason, 'quota_denied');
    assert.deepEqual(h.sent, []);
    assert.ok(h.auditRows.some((row) => row.outcome === 'quota_denied' && row.reason === 'canDo'));
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
