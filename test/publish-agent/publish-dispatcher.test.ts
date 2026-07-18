/**
 * PublishDispatcher（change decouple-publish-generation-from-dispatch；parallel-rewrite-drafts 重述）—— 下发段。
 * 由人审授权触发：复核授权 → 让位 → 从落库草稿重建发布输入 → 驱动序列 → 回写 → 解除让位。
 * 红线（重述，授权仍是发布必要条件）：未授权绝不下发；边缘离线（零副作用）回待审+作废授权+通知、不烧稿；
 * 序列失败诚实 failed 且连续失败熔断停 drain（不烧授权、人工重批确认恢复）；忠于冻结草稿不重生成；幂等 + 按账号串行。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { PublishDispatcher, type DispatchNotice } from '../../src/publish-agent/publish-dispatcher.js';
import type { DispatchDraft } from '../../src/publish-agent/publish-log-store.js';
import { EdgeTaskLeaseError } from '../../src/comm/edge-task-lease-client.js';

const silentLogger = { log() {}, warn() {}, error() {} };

function makeDraft(over: Partial<DispatchDraft> = {}): DispatchDraft {
  return {
    recordId: 7,
    accountId: 'acct-A',
    title: 'vLLM 部署踩坑',
    content: '昨天试了 vLLM 跑 14B',
    imageUrl: 'https://example.com/a.png',
    imageUrls: ['https://example.com/a.png', 'https://example.com/b.png'],
    metadata: {
      topics: ['vLLM', '大模型部署'], mentions: [], location: null, collection: null,
      visibility: 'public', permissions: { comment: 'allow', save: 'allow' },
      mode: 'immediate', publishTime: null, compliance: {}, metadataScore: 0.5, decidedAt: 0,
    } as any,
    status: 'pending_approval',
    contentVersion: 0,
    ...over,
  };
}

/** 可控 store/sequencer 桩，记录调用。 */
function harness(opts: {
  draft?: DispatchDraft | null;
  approved?: boolean;
  /** 授权信号所载版本（edit-note-draft-before-publish）；缺省 = 草稿版本（版本一致，不触发版本闸）。 */
  approvedVersion?: number;
  edgeId?: string | null;
  seqResult?: any;
  leaseError?: Error;
  /** 7.3：注入验证码硬暂停闸。 */
  isEdgePaused?: (edgeId: string) => boolean;
  /** 7.2：同稿连续被抢占达此阈值停自动重投（缺省 3）。 */
  preemptRedispatchMax?: number;
}) {
  const events: string[] = [];
  /** 7.1：被抢占事件驱动重投的调度器捕获（不自动跑，测试手动泵/断言次数）。 */
  const redispatched: Array<() => void> = [];
  let seqInput: any;
  const statusUpdates: Array<{ id: number; status: string }> = [];
  let postWrite: any;
  const attached: Array<{ id: number; count: number }> = [];
  const voided: string[] = [];
  const leasePriorities: string[] = [];
  const uiStates: Array<{ accountId: string; recordId: number; state: string; title?: string | null }> = [];
  const recordedPublishes: string[] = [];
  const store = {
    loadForDispatch: async (_id: number) => (opts.draft === undefined ? makeDraft() : opts.draft),
    updateStatus: async (id: number, status: string) => { statusUpdates.push({ id, status }); events.push(`status:${status}`); },
    updatePostId: async (id: number, postId: string, postUrl?: string | null) => { postWrite = { id, postId, postUrl }; events.push('postId'); },
    markScheduled: async (id: number, scheduledAt: number, scheduledPlatformId?: string | null) => {
      statusUpdates.push({ id, status: 'scheduled' });
      events.push(`scheduled:${scheduledAt}:${scheduledPlatformId ?? ''}`);
    },
    markImagesAttached: async (id: number, count: number) => { attached.push({ id, count }); },
    listPendingApprovalIds: async () => (opts.draft && opts.draft.status === 'pending_approval' ? [opts.draft.recordId] : []),
  };
  const sequencer = {
    executePublishSequence: async (input: any) => {
      seqInput = input;
      events.push('seq');
      return opts.seqResult ?? { ok: true, outcome: 'published_confirmed', attachedCount: 2, postId: 'post_real' };
    },
  };
  // 授权所载版本：默认取草稿版本（版本一致）；显式传 approvedVersion 则模拟「授权后又被编辑」。
  const draftVersion = (opts.draft === undefined ? makeDraft() : opts.draft)?.contentVersion ?? 0;
  const notices: DispatchNotice[] = [];
  const dispatcher = new PublishDispatcher({
    store,
    sequencer,
    edgeTaskLeases: {
      withLease: async (request, work) => {
        leasePriorities.push(request.priority);
        if (opts.leaseError) throw opts.leaseError;
        events.push('lease:acquired');
        try {
          return await work({ taskId: 'task-publish-1', edgeId: request.edgeId, kind: request.kind, priority: request.priority });
        } finally {
          events.push('lease:released');
        }
      },
    },
    resolveEdgeIdForAccount: () => (opts.edgeId === undefined ? 'edge-A' : opts.edgeId),
    isEdgePaused: opts.isEdgePaused,
    preemptRedispatchMax: opts.preemptRedispatchMax,
    scheduleRedispatch: (fn) => { redispatched.push(fn); },
    readApproval: async () =>
      (opts.approved ?? true)
        ? { approved: true, contentVersion: opts.approvedVersion ?? draftVersion }
        : { approved: false, contentVersion: opts.approvedVersion ?? draftVersion },
    voidApprovalSignal: async (requestId: string) => { voided.push(requestId); events.push('void'); },
    onPublishStart: () => events.push('start'),
    onPublishEnd: () => events.push('end'),
    notifyUiPublishState: (accountId, recordId, state, title) => uiStates.push({ accountId, recordId, state, title }),
    notifyDispatchEvent: (n) => notices.push(n),
    recordPublish: async (accountId) => { recordedPublishes.push(accountId); },
    logger: silentLogger,
  });
  return {
    dispatcher,
    events,
    get seqInput() { return seqInput; },
    statusUpdates,
    get postWrite() { return postWrite; },
    attached,
    voided,
    notices,
    leasePriorities,
    uiStates,
    redispatched,
    recordedPublishes,
  };
}

describe('PublishDispatcher', () => {
  test('已授权 + 在线边缘 → acquired→重建发布输入→驱动序列→释放→回写 published', async () => {
    const h = harness({ approved: true, edgeId: 'edge-A' });
    await h.dispatcher.dispatch(7);

    assert.deepEqual(
      h.events.filter((e) => ['lease:acquired', 'seq', 'lease:released', 'postId'].includes(e)),
      ['lease:acquired', 'seq', 'lease:released', 'postId'],
    );
    // 重建：title/content 来自草稿；tags 来自 metadata.topics；多图来自 imageUrls 全集；本期不传 cover；edgeId 定向。
    assert.equal(h.seqInput.title, 'vLLM 部署踩坑');
    assert.deepEqual(h.seqInput.tags, ['vLLM', '大模型部署']);
    assert.deepEqual(h.seqInput.images, ['https://example.com/a.png', 'https://example.com/b.png'], '下发多图全集');
    assert.equal(h.seqInput.cover, undefined, '本期不传 cover（封面=首张上传=平台默认）');
    assert.equal(h.seqInput.edgeId, 'edge-A');
    assert.equal(h.seqInput.approvedByUser, true);
    assert.deepEqual(h.leasePriorities, ['automatic'], '兜底/非人工触发按 automatic 排队');
    assert.deepEqual(h.attached, [{ id: 7, count: 2 }], '如实标记真实附着数 K=2');
    assert.deepEqual(h.postWrite, { id: 7, postId: 'post_real', postUrl: undefined });
  });

  test('9.1：一切发布一律 automatic 档，人工批准入口也不再抬到 human', async () => {
    // change lease-strict-preemption 9.1（用户 2026-07-14 拍板）：发布是异步队列作业、没人在线等回执，
    // 一律自动档——消灭「同稿因触发路径不同而档位不同 + 重投降级」两个反 aging 缺陷。humanApproval 仍保留（另驱动熔断解除）。
    const h = harness({ approved: true, edgeId: 'edge-A' });
    await h.dispatcher.dispatch(7, { humanApproval: true });
    assert.deepEqual(h.leasePriorities, ['automatic']);
  });

  test('AC-PUB 红线：未授权 → 绝不让位、绝不驱动序列、不改态', async () => {
    const h = harness({ approved: false });
    await h.dispatcher.dispatch(7);
    assert.equal(h.events.includes('seq'), false, '未授权绝不驱动序列');
    assert.equal(h.events.includes('start'), false, '未授权不让位');
    assert.equal(h.statusUpdates.length, 0, '未授权不改态（仍待审）');
  });

  test('边缘离线（零副作用）→ 回待审：作废授权、通知重批、不烧稿、不让位、不驱动序列', async () => {
    const h = harness({ approved: true, edgeId: null });
    await h.dispatcher.dispatch(7);
    assert.equal(h.events.includes('seq'), false, '离线不驱动序列');
    assert.equal(h.events.includes('start'), false, '离线不让位空转');
    assert.equal(h.statusUpdates.length, 0, '不改态：草稿留待审可重批（不烧成 failed 终态）');
    assert.deepEqual(h.voided, ['publish-7'], '作废本次授权信号（防兜底扫描对离线空转/旧授权无人知情自动发出）');
    assert.deepEqual(h.notices, [{ kind: 'offline_requeued', accountId: 'acct-A', recordId: 7, title: 'vLLM 部署踩坑' }], '如实通知重批');
  });

  test('在线 edge 的 acquire 超时（零副作用）→ 回待审但不得误报离线', async () => {
    const h = harness({
      approved: true,
      edgeId: 'edge-online',
      leaseError: new EdgeTaskLeaseError('acquire_timeout', 'edge task acquire timeout taskId=task-timeout edge=edge-online'),
    });
    await h.dispatcher.dispatch(7);
    assert.equal(h.events.includes('seq'), false, '未 acquired 前绝不驱动发布序列');
    assert.equal(h.statusUpdates.length, 0, '草稿保持待审可重批');
    assert.deepEqual(h.voided, ['publish-7'], '作废本次授权，避免旧授权自动重发');
    assert.deepEqual(
      h.notices,
      [{ kind: 'acquire_timeout_requeued', accountId: 'acct-A', recordId: 7, title: 'vLLM 部署踩坑' }],
      '接管超时必须是独立通知语义，不得混为边缘离线',
    );
  });

  test('edge 明确拒绝：浏览器控制不可用（零副作用）→ 回待审且通知不得混为离线或接管超时', async () => {
    const h = harness({
      approved: true,
      edgeId: 'edge-online',
      leaseError: new EdgeTaskLeaseError('edge_unhealthy', 'browser control unavailable'),
    });
    await h.dispatcher.dispatch(7);
    assert.equal(h.events.includes('seq'), false, '未 acquired 前绝不驱动发布序列');
    assert.equal(h.statusUpdates.length, 0, '草稿保持待审可重批');
    assert.deepEqual(h.voided, ['publish-7']);
    assert.deepEqual(
      h.notices,
      [{ kind: 'cdp_unhealthy_requeued', accountId: 'acct-A', recordId: 7, title: 'vLLM 部署踩坑' }],
    );
  });

  test('幂等：已 published 草稿 → 跳过，不二次发布', async () => {
    const h = harness({ approved: true, draft: makeDraft({ status: 'published' }) });
    await h.dispatcher.dispatch(7);
    assert.equal(h.events.includes('seq'), false, '已发布不重发');
    assert.equal(h.events.includes('start'), false);
  });

  test('租约 finally：序列失败也释放执行权', async () => {
    const h = harness({ approved: true, edgeId: 'edge-A', seqResult: { ok: false, attachedCount: 0, failedAt: { seq: 5, kind: 'submit_publish', error: 'x' } } });
    await h.dispatcher.dispatch(7);
    assert.equal(h.events.includes('lease:acquired'), true);
    assert.equal(h.events.includes('lease:released'), true, '失败路径仍释放任务租约');
    assert.deepEqual(h.statusUpdates.at(-1), { id: 7, status: 'failed' }, '真失败如实 failed');
  });

  test('页面已提交但未抓到 postId → submitted，不报失败、不刷新或自动重试', async () => {
    const h = harness({
      approved: true,
      edgeId: 'edge-A',
      seqResult: { ok: true, outcome: 'submitted_unconfirmed', attachedCount: 1 },
    });
    await h.dispatcher.dispatch(7);
    assert.deepEqual(h.statusUpdates.at(-1), { id: 7, status: 'submitted' });
    assert.equal(h.postWrite, undefined, '无 postId/permalink 绝不伪造发布确认');
    assert.deepEqual(h.uiStates.at(-1), { accountId: 'acct-A', recordId: 7, state: 'submitted', title: 'vLLM 部署踩坑' });
  });

  test('原生定时提交 → scheduled、内部句柄独立落库且不占发布次数', async () => {
    const publishTime = 1_800_007_200_000;
    const h = harness({
      draft: makeDraft({ metadata: {
        topics: [], mentions: [], location: null, collection: null,
        visibility: 'public', permissions: { comment: 'allow', save: 'allow' },
        mode: 'scheduled', publishTime, compliance: {}, metadataScore: 1, decidedAt: 1_800_000_000_000,
      } as any }),
      seqResult: {
        ok: true,
        outcome: 'scheduled_pending',
        attachedCount: 2,
        scheduledAt: publishTime,
        scheduledPlatformId: 'scheduled-internal-1',
      },
    });
    await h.dispatcher.dispatch(7);
    assert.equal(h.events.some((event) => event === `scheduled:${publishTime}:scheduled-internal-1`), true);
    assert.equal(h.postWrite, undefined, '内部定时句柄不得写入公开 platform_post_id');
    assert.deepEqual(h.recordedPublishes, [], '平台尚未公开时不消耗发布次数');
  });

  test('草稿不存在 → 安静跳过', async () => {
    const h = harness({ approved: true, draft: null });
    await h.dispatcher.dispatch(7);
    assert.equal(h.events.length, 0);
  });

  test('兜底扫描：已授权待审草稿被补触发下发', async () => {
    const h = harness({ approved: true, edgeId: 'edge-A', draft: makeDraft({ status: 'pending_approval' }) });
    await h.dispatcher.scanAndDispatchApproved();
    assert.equal(h.events.includes('seq'), true, '兜底扫描补触发下发');
  });

  test('版本闸：授权版本 ≠ 草稿版本 → 作废过期签名、留待审、绝不下发未审内容', async () => {
    // 草稿已被编辑到 v2，但授权签名载的是旧 v1（授权后又落了一次编辑）。
    const h = harness({ approved: true, edgeId: 'edge-A', draft: makeDraft({ contentVersion: 2 }), approvedVersion: 1 });
    await h.dispatcher.dispatch(7);
    assert.equal(h.events.includes('seq'), false, '版本不符绝不驱动序列（不发未审内容）');
    assert.equal(h.events.includes('start'), false, '版本不符不让位');
    assert.deepEqual(h.voided, ['publish-7'], '作废过期签名');
    assert.equal(h.statusUpdates.length, 0, '留待审：不改态、不落 failed/needs_review（不锁死，可重审）');
  });

  test('版本闸：授权版本 == 草稿版本 → 照常下发', async () => {
    const h = harness({ approved: true, edgeId: 'edge-A', draft: makeDraft({ contentVersion: 3 }), approvedVersion: 3 });
    await h.dispatcher.dispatch(7);
    assert.equal(h.events.includes('seq'), true, '版本一致照常下发');
    assert.equal(h.voided.length, 0, '版本一致不作废签名');
  });

  test('版本闸兼容：缺版本的老签名(v0) 对未编辑草稿(v0) → 照常下发', async () => {
    // 部署前在飞的老审批：signal 无 contentVersion → 读回 0；未编辑草稿 content_version 默认 0 → 0===0 放行。
    const h = harness({ approved: true, edgeId: 'edge-A', draft: makeDraft({ contentVersion: 0 }), approvedVersion: 0 });
    await h.dispatcher.dispatch(7);
    assert.equal(h.events.includes('seq'), true, '老签名 0 == 未编辑草稿 0 → 照常发（deploy 向后兼容）');
    assert.equal(h.voided.length, 0);
  });

  /** 多记录桩：按 id 出草稿，序列可注入逐次结果。供熔断/扫描并发用例。 */
  function multiHarness(opts: {
    drafts: Record<number, DispatchDraft>;
    seqResultFor?: (recordId: number) => any | Promise<any>;
    breakerThreshold?: number;
  }) {
    const events: string[] = [];
    const notices: DispatchNotice[] = [];
    const statusUpdates: Array<{ id: number; status: string }> = [];
    const voided: string[] = [];
    const dispatcher = new PublishDispatcher({
      store: {
        loadForDispatch: async (id: number) => opts.drafts[id] ?? null,
        updateStatus: async (id, status) => {
          statusUpdates.push({ id, status });
          if (opts.drafts[id]) opts.drafts[id].status = status as DispatchDraft['status']; // 保真：状态迁移对后续读可见（镜像 DB 行为）
        },
        updatePostId: async (id) => {
          if (opts.drafts[id]) opts.drafts[id].status = 'published';
        },
        markScheduled: async (id) => {
          if (opts.drafts[id]) opts.drafts[id].status = 'scheduled';
        },
        markImagesAttached: async () => {},
        listPendingApprovalIds: async () =>
          Object.values(opts.drafts).filter((d) => d.status === 'pending_approval').map((d) => d.recordId),
      },
      sequencer: {
        executePublishSequence: async (input: any) => {
          events.push(`seq:${input.recordId}`);
          return (await opts.seqResultFor?.(input.recordId)) ?? { ok: true, outcome: 'published_confirmed', attachedCount: 1, postId: 'p' };
        },
      },
      edgeTaskLeases: {
        withLease: async (request, work) => work({ taskId: 'task-publish-multi', edgeId: request.edgeId, kind: request.kind, priority: request.priority }),
      },
      resolveEdgeIdForAccount: () => 'edge-X',
      readApproval: async () => ({ approved: true, contentVersion: 0 }),
      voidApprovalSignal: async (rid) => { voided.push(rid); },
      onPublishStart: () => events.push('start'),
      onPublishEnd: () => events.push('end'),
      notifyDispatchEvent: (n) => notices.push(n),
      breakerThreshold: opts.breakerThreshold,
      logger: silentLogger,
    });
    return { dispatcher, events, notices, statusUpdates, voided };
  }

  test('熔断：同账号连续 2 次序列失败 → 开熔断+告警；第三份不下发且授权保留不烧', async () => {
    const drafts = {
      1: makeDraft({ recordId: 1 }),
      2: makeDraft({ recordId: 2 }),
      3: makeDraft({ recordId: 3 }),
    };
    const h = multiHarness({
      drafts,
      seqResultFor: () => ({ ok: false, attachedCount: 0, failedAt: { seq: 5, kind: 'submit_publish', error: 'x' } }),
    });
    await h.dispatcher.dispatch(1);
    await h.dispatcher.dispatch(2);
    assert.equal(h.dispatcher.isBreakerOpen('acct-A'), true, '连续两败开熔断');
    assert.deepEqual(h.notices.filter((n) => n.kind === 'breaker_open').length, 1, '熔断告警恰一次');
    await h.dispatcher.dispatch(3);
    assert.equal(h.events.includes('seq:3'), false, '熔断中第三份不驱动序列');
    assert.equal(h.voided.length, 0, '熔断拒绝绝不烧授权信号');
    assert.equal(h.statusUpdates.some((s) => s.id === 3), false, '熔断拒绝不改第三份状态');
  });

  test('熔断恢复：人工批准（humanApproval，含 already-decided 重批）→ 清熔断+通知+恢复下发', async () => {
    let fail = true;
    const drafts = { 1: makeDraft({ recordId: 1 }), 2: makeDraft({ recordId: 2 }), 3: makeDraft({ recordId: 3 }) };
    const h = multiHarness({
      drafts,
      seqResultFor: () => (fail ? { ok: false, attachedCount: 0, failedAt: { seq: 1, kind: 'x', error: 'x' } } : undefined),
    });
    await h.dispatcher.dispatch(1);
    await h.dispatcher.dispatch(2);
    assert.equal(h.dispatcher.isBreakerOpen('acct-A'), true);
    fail = false; // 运营已排除边缘故障
    await h.dispatcher.dispatch(3, { humanApproval: true });
    assert.equal(h.dispatcher.isBreakerOpen('acct-A'), false, '人工批准确认清熔断');
    assert.equal(h.notices.some((n) => n.kind === 'breaker_cleared'), true, '熔断解除如实通知');
    assert.equal(h.events.includes('seq:3'), true, '清熔断后本条照常下发');
    // 清熔断触发的兜底扫描（fire-and-forget）收敛后不重复发已发条目（inFlight/status 幂等）。
    await new Promise((r) => setTimeout(r, 0));
  });

  test('非人工路径（兜底扫描）绝不清熔断', async () => {
    const drafts = { 1: makeDraft({ recordId: 1 }), 2: makeDraft({ recordId: 2 }), 3: makeDraft({ recordId: 3 }) };
    const h = multiHarness({
      drafts,
      seqResultFor: () => ({ ok: false, attachedCount: 0, failedAt: { seq: 1, kind: 'x', error: 'x' } }),
    });
    await h.dispatcher.dispatch(1);
    await h.dispatcher.dispatch(2);
    await h.dispatcher.scanAndDispatchApproved();
    assert.equal(h.dispatcher.isBreakerOpen('acct-A'), true, '扫描不是人工确认，熔断保持');
    assert.equal(h.events.filter((e) => e.startsWith('seq:')).length, 2, '熔断后扫描不再驱动新序列');
  });

  test('兜底扫描并发启动：一账号在发不拖死他账号（跨账号即时推进）', async () => {
    let releaseA!: () => void;
    const gateA = new Promise<void>((r) => { releaseA = r; });
    const drafts = {
      1: makeDraft({ recordId: 1, accountId: 'acct-A' }),
      2: makeDraft({ recordId: 2, accountId: 'acct-B' }),
    };
    const h = multiHarness({
      drafts,
      seqResultFor: async (id) => {
        if (id === 1) await gateA; // A 慢发（模拟 1-3 分钟下发）
        return { ok: true, outcome: 'published_confirmed', attachedCount: 1, postId: 'p' };
      },
    });
    const scan = h.dispatcher.scanAndDispatchApproved();
    // 等 B 的链路推进（A 仍被 gate 挡住）。
    for (let i = 0; i < 20 && !h.events.includes('seq:2'); i++) await new Promise((r) => setTimeout(r, 1));
    assert.equal(h.events.includes('seq:2'), true, 'B 不等 A 完成即被驱动');
    assert.equal(h.events.includes('seq:1'), true, 'A 已启动（被 gate 挡在序列内）');
    releaseA();
    await scan;
  });

  // ── 被抢占 ≠ 失败（change lease-strict-preemption 批 C 7.1/7.2/7.3）──────────────────
  test('7.1 outcome=preempted → 保持待审（不写终态）、保留授权（不作废）、不计熔断、事件驱动重投', async () => {
    const h = harness({ approved: true, edgeId: 'edge-A', seqResult: { ok: false, outcome: 'preempted', attachedCount: 0, failedAt: { seq: 3, kind: 'fill_field', error: 'preempted_by_task' } } });
    await h.dispatcher.dispatch(7);
    assert.equal(h.events.includes('seq'), true, '已驱动序列（被抢占发生在序列中途）');
    assert.equal(h.statusUpdates.length, 0, '绝不写任何终态：草稿留 pending_approval（failed 不可逆，被抢占绝不烧）');
    assert.deepEqual(h.voided, [], '保留授权签名（不 void）→ 重投可再过 AC-PUB');
    assert.equal(h.notices.some((n) => n.kind === 'breaker_open'), false, '被抢占不计熔断');
    assert.equal(h.dispatcher.isBreakerOpen('acct-A'), false);
    assert.equal(h.redispatched.length, 1, '调度一次事件驱动重投（排队等抢占方释放）');
    assert.equal(h.notices.some((n) => n.kind === 'preempted_exhausted'), false, '未达退避阈值');
  });

  test('7.2 同稿连续被抢占达阈值 → 停自动重投 + 作废授权 + 通知运营（仍保持待审、绝不烧稿；防 60s 扫描再捞起重投）', async () => {
    const h = harness({ approved: true, edgeId: 'edge-A', preemptRedispatchMax: 1, seqResult: { ok: false, outcome: 'preempted', attachedCount: 0, failedAt: { seq: 3, kind: 'fill_field', error: 'preempted_by_task' } } });
    await h.dispatcher.dispatch(7);
    assert.equal(h.statusUpdates.length, 0, '仍保持待审、绝不烧稿');
    assert.deepEqual(h.voided, ['publish-7'], '达阈值须作废授权：否则 60s 兜底扫描每轮再捞起爆一轮重投，退避形同虚设');
    assert.equal(h.redispatched.length, 0, '达阈值 → 不再调度自动重投');
    assert.equal(h.notices.some((n) => n.kind === 'preempted_exhausted'), true, '通知运营已停自动重投');
  });

  test('7.3 验证码硬暂停 → 零副作用回待审（不驱动序列、不写终态、保留授权、通知 edge_paused_requeued）', async () => {
    const h = harness({ approved: true, edgeId: 'edge-A', isEdgePaused: () => true });
    await h.dispatcher.dispatch(7);
    assert.equal(h.events.includes('seq'), false, '暂停期绝不驱动序列（投递必为 0，会被烧 failed）');
    assert.equal(h.events.includes('lease:acquired'), false, '暂停期不取租约');
    assert.equal(h.statusUpdates.length, 0, '不写终态：草稿留待审');
    assert.deepEqual(h.voided, [], '瞬态暂停不作废授权（解除后自动重投）');
    assert.equal(h.notices.some((n) => n.kind === 'edge_paused_requeued'), true);
  });
});
