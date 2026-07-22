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
  /** joinSpecificGroup（change facebook-comment-review-and-targeted-join）：claimSpecific 桩返回；缺省 → 该 url 的新 assigned 行。 */
  claimSpecific?: (accountId: string, url: string) => { row: FacebookGroupMembershipRow; ownedByOther: boolean } | null;
  claimNext?: () => FacebookGroupMembershipRow | null;
  isFacebookAccount?: boolean;
  scopeEligibility?: 'eligible' | 'scope_mismatch' | 'terminal' | 'missing';
} = {}) {
  const bus = new EventBus();
  const sent: Env[] = [];
  const auditRows: FacebookGroupJoinAuditRow[] = [];
  const membershipCalls: string[] = [];
  const targetCalls: string[] = [];
  const sessionBudgetCalls: string[] = [];
  const leasePriorities: string[] = [];
  const paused: string[] = [];
  const retryBackoffs: number[] = [];
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
    ensureTarget: async (url: string) => {
      targetCalls.push(`ensure:${url}`);
      return {
        groupUrl: url,
        groupName: null,
        joinGating: 'unknown' as const,
        priority: 0,
        enabled: false, // 只归该账号：绝不外泄成公共自动加群目标
        importBatch: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
    },
  };
  const memberships = {
    currentAssignment: async () => null,
    claimNext: async () => {
      membershipCalls.push('claim');
      return opts.claimNext ? opts.claimNext() : membership();
    },
    claimSpecific: async (accountId: string, url: string) => {
      membershipCalls.push(`claimSpecific:${url}`);
      return opts.claimSpecific
        ? opts.claimSpecific(accountId, url)
        : { row: membership({ groupUrl: url, status: 'assigned' }), ownedByOther: false };
    },
    markJoining: async (_accountId: string, groupUrl: string) => {
      membershipCalls.push(`joining:${groupUrl}`);
      return true;
    },
    revalidateScopedAssignment: async (_accountId: string, groupUrl: string) => {
      membershipCalls.push(`revalidate:${groupUrl}`);
      return opts.scopeEligibility ?? 'eligible';
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
        leasePriorities.push(request.priority);
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
    isFacebookAccount: async () => opts.isFacebookAccount ?? true,
    pauseAccount: async (accountId, reason) => {
      paused.push(`${accountId}:${reason}`);
    },
    stepTimeoutMs: 20,
    logger: { warn: () => {}, log: () => {} },
  });
  return { scheduler, sent, auditRows, membershipCalls, targetCalls, sessionBudgetCalls, leasePriorities, paused, retryBackoffs, bus };
}

describe('FacebookGroupJoinScheduler', () => {
  it('旧 auto/shadow 环境值不再阻断账号级加群调度', async () => {
    const previousAuto = process.env.AIDCP_FB_GROUP_JOIN_AUTO;
    const previousShadow = process.env.AIDCP_FB_GROUP_JOIN_SHADOW;
    process.env.AIDCP_FB_GROUP_JOIN_AUTO = 'false';
    process.env.AIDCP_FB_GROUP_JOIN_SHADOW = 'false';
    const h = makeHarness({
      llmVerdicts: ['{"verdict":"gated_skip","confidence":0.9,"reason":"approval required"}'],
      edge: (env, bus) => {
        bus.emit('action.completed', {
          action: 'join_group',
          ok: false,
          reason: 'observation_only',
          groupUrl: env.payload.groupUrl,
          clicked: false,
          observation: { groupUrl: env.payload.groupUrl, mainCtaText: 'Request to join' },
          ts: 0,
        } as never);
      },
    });
    try {
      const r = await h.scheduler.triggerScheduled('acc-fb');
      assert.equal(r.triggered, true);
      assert.equal(r.outcome, 'gated_skip');
      assert.equal(h.sent[0].type, 'group.join');
    } finally {
      if (previousAuto === undefined) delete process.env.AIDCP_FB_GROUP_JOIN_AUTO;
      else process.env.AIDCP_FB_GROUP_JOIN_AUTO = previousAuto;
      if (previousShadow === undefined) delete process.env.AIDCP_FB_GROUP_JOIN_SHADOW;
      else process.env.AIDCP_FB_GROUP_JOIN_SHADOW = previousShadow;
    }
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
    assert.ok(h.auditRows.every((row) => row.triggerSource === 'scheduled'));
  });

  it('scope change: 自动分配在导航前释放并返回 scope_mismatch，不下发 Edge', async () => {
    const h = makeHarness({ auto: true, scopeEligibility: 'scope_mismatch' });
    const r = await h.scheduler.triggerScheduled('acc-fb');
    assert.deepEqual(r, { triggered: false, groupUrl: GROUP, reason: 'scope_mismatch' });
    assert.deepEqual(h.sent, []);
    assert.ok(h.membershipCalls.includes(`revalidate:${GROUP}`));
    assert.ok(!h.membershipCalls.includes(`joining:${GROUP}`), '失配分配不得再推进 joining');
    assert.ok(h.auditRows.some((row) => row.outcome === 'scope_mismatch' && row.triggerSource === 'scheduled'));
  });

  it('scope revalidation: 终态竞态不被改写且不导航', async () => {
    const h = makeHarness({ auto: true, scopeEligibility: 'terminal' });
    const r = await h.scheduler.triggerScheduled('acc-fb');
    assert.equal(r.reason, 'assignment_not_executable');
    assert.deepEqual(h.sent, []);
    assert.ok(!h.membershipCalls.includes(`joining:${GROUP}`), 'joined/pending/gated 等终态不得被改回 joining');
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

  it('fail-fast: 租约异常 → 当前目标立即 failed，不冷却、不暂停账号', async () => {
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
    // 当前目标直接终态失败，不保留 assigned/joining 或冷却占位；账号可在下一次选择其它目标。
    assert.ok(h.membershipCalls.includes(`outcome:${GROUP}:failed:lease_unavailable:acquire_timeout`));
    assert.ok(!h.membershipCalls.some((c) => c.startsWith(`retry:${GROUP}:`)));
    assert.ok(h.auditRows.some((row) => row.reason === 'lease_unavailable:acquire_timeout'));
    assert.deepEqual(h.paused, []); // 租约失败不是 login/captcha → 不暂停账号
  });

  it('fail-fast: observe 报 not_ready（慢渲染）→ 当前目标立即 failed，绝不喂判定角色/LLM', async () => {
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
    assert.equal(r.outcome, 'not_ready'); // 直接返回页面未就绪，而非 ambiguous_skip（= 证明没走 LLM）
    // 只发了 observe（click=false）一次，没有第二次 clickJoin。
    assert.equal(h.sent.length, 1);
    assert.equal(h.sent[0].payload.click, false);
    assert.ok(h.membershipCalls.includes(`outcome:${GROUP}:failed:not_ready`));
    assert.ok(!h.membershipCalls.some((c) => c.startsWith(`retry:${GROUP}:`)));
    assert.ok(h.auditRows.some((row) => row.reason === 'not_ready'));
  });

  it('fail-fast: 打开群页 nav_error → 直接 failed 并保留具体审计，不进入 no_targets 冷却窗口', async () => {
    const h = makeHarness({
      auto: true,
      edge: (env, bus) => {
        bus.emit('action.completed', {
          action: 'join_group',
          ok: false,
          reason: 'nav_error',
          groupUrl: env.payload.groupUrl,
          clicked: false,
          ts: 0,
        } as never);
      },
    });
    const r = await h.scheduler.triggerScheduled('acc-fb');
    assert.deepEqual(r, { triggered: true, groupUrl: GROUP, outcome: 'nav_error' });
    assert.ok(h.membershipCalls.includes(`outcome:${GROUP}:failed:nav_error`));
    assert.ok(!h.membershipCalls.some((c) => c.startsWith(`retry:${GROUP}:`)));
    assert.ok(h.auditRows.some((row) => row.outcome === 'nav_error' && row.reason === 'nav_error'));
    assert.deepEqual(h.paused, []);
  });

  it('fail-fast: 上个目标 nav_error 后下一次可立即认领另一个目标，不返回 no_targets', async () => {
    const groups = [GROUP, 'https://www.facebook.com/groups/group-b'];
    let claimIndex = 0;
    const h = makeHarness({
      auto: true,
      claimNext: () => membership({ groupUrl: groups[claimIndex++] }),
      edge: (env, bus) => {
        bus.emit('action.completed', {
          action: 'join_group', ok: false, reason: 'nav_error', groupUrl: env.payload.groupUrl, clicked: false, ts: 0,
        } as never);
      },
    });
    const first = await h.scheduler.triggerScheduled('acc-fb');
    const second = await h.scheduler.triggerScheduled('acc-fb');
    assert.equal(first.groupUrl, groups[0]);
    assert.equal(second.groupUrl, groups[1]);
    assert.equal(second.outcome, 'nav_error');
    assert.equal(h.membershipCalls.filter((call) => call === 'claim').length, 2);
    assert.ok(!h.auditRows.some((row) => row.outcome === 'no_targets'));
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
    assert.ok(h.auditRows.every((row) => row.triggerSource === 'manual_pool'));
  });

  it('auto（非 manual）: canJoin=false → quota_denied 不下发（回归：manual 旗标不误伤自动巡回）', async () => {
    const h = makeHarness({ auto: true, canJoin: false });
    const r = await h.scheduler.triggerScheduled('acc-fb');
    assert.equal(r.triggered, false);
    assert.equal(r.reason, 'quota_denied');
    assert.deepEqual(h.sent, []);
    assert.ok(h.auditRows.some((row) => row.outcome === 'quota_denied' && row.reason === 'canDo'));
  });

  it('7.11 手动触发的加群一路带 human 档到租约（严格三档下不被别的 human 任务抢占）', async () => {
    const h = makeHarness({
      auto: true,
      edge: (env, bus) => {
        bus.emit('action.completed', { action: 'join_group', ok: true, reason: undefined, groupUrl: env.payload.groupUrl, clicked: true, ts: 0 } as never);
      },
    });
    await h.scheduler.triggerScheduled('acc-fb', { manual: true });
    assert.ok(h.leasePriorities.length > 0, '至少取一次租约（observe/click）');
    assert.ok(h.leasePriorities.every((p) => p === 'human'), '手动加群全程 human 档');
  });

  it('7.11 自动巡回的加群仍 automatic 档（人工旗标不误伤自动路径）', async () => {
    const h = makeHarness({
      auto: true,
      edge: (env, bus) => {
        bus.emit('action.completed', { action: 'join_group', ok: true, reason: undefined, groupUrl: env.payload.groupUrl, clicked: true, ts: 0 } as never);
      },
    });
    await h.scheduler.triggerScheduled('acc-fb');
    assert.ok(h.leasePriorities.length > 0);
    assert.ok(h.leasePriorities.every((p) => p === 'automatic'), '自动加群全程 automatic 档');
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

  // ── Feature B（change facebook-comment-review-and-targeted-join）：joinSpecificGroup 加入指定群、只归该账号 ──
  const SPEC_URL = 'https://www.facebook.com/groups/901700573618044';
  const memberEdge = (env: Env, bus: EventBus) => {
    const click = env.payload.click === true;
    bus.emit('action.completed', {
      action: 'join_group',
      ok: click, // observe: ok=false（observation_only，非瞬态）；click: ok=true
      ...(click ? {} : { reason: 'observation_only' }),
      groupUrl: env.payload.groupUrl,
      clicked: click,
      observation: { groupUrl: env.payload.groupUrl, mainCtaText: click ? 'Leave group' : 'Join group' },
      ts: 0,
    } as never);
  };

  it('joinSpecificGroup 新加入：ensureTarget(enabled=false) + claimSpecific + observe→click→joined', async () => {
    const h = makeHarness({ auto: true, edge: memberEdge });
    const r = await h.scheduler.joinSpecificGroup('acc-fb', SPEC_URL, { manual: true });
    assert.equal(r.triggered, true);
    assert.equal(r.outcome, 'joined');
    assert.equal(r.groupUrl, SPEC_URL);
    assert.ok(h.targetCalls.includes(`ensure:${SPEC_URL}`), 'ensureTarget 被调用（enabled=false、不外泄成公共目标）');
    assert.ok(h.membershipCalls.includes(`claimSpecific:${SPEC_URL}`));
    assert.ok(h.membershipCalls.includes(`joined:${SPEC_URL}:member_signal`));
    assert.equal(h.sent[0].type, 'group.join');
    assert.ok(h.auditRows.every((row) => row.triggerSource === 'manual_specific'));
  });

  it('joinSpecificGroup 已是成员（ledger status=joined）→ already_member 快路，绝不走边端', async () => {
    const h = makeHarness({
      auto: true,
      claimSpecific: (_a, url) => ({ row: membership({ groupUrl: url, status: 'joined' }), ownedByOther: false }),
    });
    const r = await h.scheduler.joinSpecificGroup('acc-fb', SPEC_URL, { manual: true });
    assert.equal(r.triggered, true);
    assert.equal(r.outcome, 'already_member');
    assert.deepEqual(h.sent, [], '已是成员 → 不下发 group.join');
    assert.ok(h.targetCalls.includes(`ensure:${SPEC_URL}`));
  });

  it('joinSpecificGroup 群已归属别的账号 → owned_by_other_account，诚实拒、不下发、不冒充成员', async () => {
    const h = makeHarness({
      auto: true,
      claimSpecific: (_a, url) => ({ row: membership({ groupUrl: url, status: 'joined' }), ownedByOther: true }),
    });
    const r = await h.scheduler.joinSpecificGroup('acc-fb', SPEC_URL, { manual: true });
    assert.equal(r.triggered, false);
    assert.equal(r.reason, 'owned_by_other_account');
    assert.deepEqual(h.sent, []);
  });

  it('joinSpecificGroup url 非法 → invalid_group_url，不 ensure、不 claim、不下发', async () => {
    const h = makeHarness({ auto: true });
    const r = await h.scheduler.joinSpecificGroup('acc-fb', 'not-a-facebook-group', { manual: true });
    assert.equal(r.triggered, false);
    assert.equal(r.reason, 'invalid_group_url');
    assert.deepEqual(h.sent, []);
    assert.deepEqual(h.membershipCalls, []);
    assert.deepEqual(h.targetCalls, []);
  });

  it('joinSpecificGroup 非 Facebook 账号 → not_facebook_account', async () => {
    const h = makeHarness({ auto: true, isFacebookAccount: false });
    const r = await h.scheduler.joinSpecificGroup('acc-fb', SPEC_URL, { manual: true });
    assert.equal(r.triggered, false);
    assert.equal(r.reason, 'not_facebook_account');
  });

  it('joinSpecificGroup 绕配额闸（canJoin/session 均拒）仍加入——人工授权，物理闸仍守', async () => {
    const h = makeHarness({ auto: true, canJoin: false, canUseSessionJoin: false, edge: memberEdge });
    const r = await h.scheduler.joinSpecificGroup('acc-fb', SPEC_URL, { manual: true });
    assert.equal(r.outcome, 'joined', '手动指定群绕风控/会话配额，与 --join manual 契约一致');
  });
});
