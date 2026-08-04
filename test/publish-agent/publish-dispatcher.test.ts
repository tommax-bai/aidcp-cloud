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
  approvedRevision?: number;
  edgeId?: string | null;
  seqResult?: any;
  leaseError?: Error | (() => Error | undefined);
  /** 7.3：注入验证码硬暂停闸。 */
  isEdgePaused?: (edgeId: string) => boolean;
  /** 7.2：同稿连续被抢占达此阈值停自动重投（缺省 3）。 */
  preemptRedispatchMax?: number;
  /** change defer-transient-publish-predispatch-failures：提交前零副作用失败的重投上限（缺省 2）。 */
  deferredRedispatchMax?: number;
  executionTarget?: 'dev' | 'ol' | null;
  /** change publish-approval-signal-to-database：授权查询不可读（超时 / 接口不可达）。 */
  approvalUnreadable?: boolean;
  /** 兜底扫描的批量拉取（按本机 target 拉「已批准·待下发」）。 */
  pendingDispatchRecordIds?: () => Promise<number[]>;
  /** authority CAS/transport 未确认时，dispatching gate 必须阻断不可逆平台动作。 */
  dispatchProgressFails?: boolean;
  /** task 2.4d：Facebook 素材端口。**不传 = 本进程没有这条端口**，正是要断言的那一支。 */
  facebookPublishMedia?: {
    releaseReservation(setId: number, reservationId?: string): Promise<boolean>;
    markUsed(setId: number, publishLogId: number): Promise<boolean>;
    quarantine(setId: number, reason: string): Promise<boolean>;
  };
  /** 捕获日志（默认静默）：用于断言那条具名 error 真的说出来了。 */
  captureLogs?: string[];
}) {
  const events: string[] = [];
  /** 7.1：被抢占事件驱动重投的调度器捕获（不自动跑，测试手动泵/断言次数）。 */
  const redispatched: Array<() => void> = [];
  let seqInput: any;
  const statusUpdates: Array<{ id: number; status: string }> = [];
  let postWrite: any;
  const attached: Array<{ id: number; count: number }> = [];
  const voided: string[] = [];
  const voidReasons: Array<{ requestId: string; reason: string }> = [];
  const blocked: Array<{ requestId: string; reason: string | null }> = [];
  const progress: Array<{ requestId: string; action: string }> = [];
  const leasePriorities: string[] = [];
  const leaseDurations: Array<number | undefined> = [];
  const uiStates: Array<{ accountId: string; recordId: number; state: string; title?: string | null }> = [];
  const recordedPublishes: string[] = [];
  let scannedTarget: 'dev' | 'ol' | null | undefined;
  const store = {
    loadForDispatch: async (_id: number) => (opts.draft === undefined ? makeDraft() : opts.draft),
    updateStatus: async (id: number, status: string) => { statusUpdates.push({ id, status }); events.push(`status:${status}`); },
    updatePostId: async (id: number, postId: string, postUrl?: string | null) => { postWrite = { id, postId, postUrl }; events.push('postId'); },
    markScheduled: async (id: number, scheduledAt: number, scheduledPlatformId?: string | null) => {
      statusUpdates.push({ id, status: 'scheduled' });
      events.push(`scheduled:${scheduledAt}:${scheduledPlatformId ?? ''}`);
    },
    markImagesAttached: async (id: number, count: number) => { attached.push({ id, count }); },
    listPendingApprovalIds: async (target?: 'dev' | 'ol' | null) => {
      scannedTarget = target;
      return opts.draft && opts.draft.status === 'pending_approval' ? [opts.draft.recordId] : [];
    },
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
        leaseDurations.push(request.leaseMs);
        const leaseError = typeof opts.leaseError === 'function' ? opts.leaseError() : opts.leaseError;
        if (leaseError) throw leaseError;
        events.push('lease:acquired');
        try {
          return await work({ taskId: 'task-publish-1', edgeId: request.edgeId, kind: request.kind, priority: request.priority });
        } finally {
          events.push('lease:released');
        }
      },
    },
    resolveEdgeIdForAccount: () => (opts.edgeId === undefined ? 'edge-A' : opts.edgeId),
    executionTarget: opts.executionTarget,
    isEdgePaused: opts.isEdgePaused,
    preemptRedispatchMax: opts.preemptRedispatchMax,
    deferredRedispatchMax: opts.deferredRedispatchMax,
    scheduleRedispatch: (fn) => { redispatched.push(fn); },
    readApproval: async () => {
      if (opts.approvalUnreadable) throw new Error('approval_lookup_503');
      return (opts.approved ?? true)
        ? {
            approved: true,
            contentVersion: opts.approvedVersion ?? draftVersion,
            revision: opts.approvedRevision ?? 1,
          }
        : {
            approved: false,
            contentVersion: opts.approvedVersion ?? draftVersion,
            revision: opts.approvedRevision ?? 1,
          };
    },
    voidApprovalSignal: async (requestId: string, _revision: number, reason: string) => {
      voided.push(requestId);
      voidReasons.push({ requestId, reason });
      events.push('void');
    },
    approvalDispatchState: {
      markDispatching: async (requestId: string, _revision: number) => {
        if (opts.dispatchProgressFails) throw new Error('approval_revision_conflict');
        progress.push({ requestId, action: 'dispatching' });
      },
      markConsumed: async (requestId: string, _revision: number) => {
        progress.push({ requestId, action: 'consumed' });
      },
      releaseToPending: async (requestId: string, _revision: number, reason) => {
        progress.push({ requestId, action: 'pending_dispatch' });
        blocked.push({ requestId, reason: reason ?? null });
      },
      setBlockedReason: async (requestId: string, _revision: number, reason) => {
        blocked.push({ requestId, reason: reason ?? null });
      },
    },
    ...(opts.pendingDispatchRecordIds ? { listPendingDispatchRecordIds: opts.pendingDispatchRecordIds } : {}),
    onPublishStart: () => events.push('start'),
    onPublishEnd: () => events.push('end'),
    notifyUiPublishState: (accountId, recordId, state, title) => uiStates.push({ accountId, recordId, state, title }),
    notifyDispatchEvent: (n) => notices.push(n),
    recordPublish: async (accountId) => { recordedPublishes.push(accountId); },
    ...(opts.facebookPublishMedia ? { facebookPublishMedia: opts.facebookPublishMedia } : {}),
    logger: opts.captureLogs
      ? {
          log() {},
          warn: (m: unknown) => opts.captureLogs!.push(String(m)),
          error: (m: unknown) => opts.captureLogs!.push(String(m)),
        }
      : silentLogger,
  });
  return {
    dispatcher,
    events,
    get seqInput() { return seqInput; },
    statusUpdates,
    get postWrite() { return postWrite; },
    attached,
    voided,
    voidReasons,
    blocked,
    progress,
    notices,
    leasePriorities,
    leaseDurations,
    uiStates,
    redispatched,
    recordedPublishes,
    get scannedTarget() { return scannedTarget; },
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
    assert.deepEqual(h.leaseDurations, [1_000_000], '默认发布租约覆盖 400s 填写预算并保留 60% 序列余量');
    assert.deepEqual(h.attached, [{ id: 7, count: 2 }], '如实标记真实附着数 K=2');
    assert.deepEqual(h.postWrite, { id: 7, postId: 'post_real', postUrl: undefined });
    assert.deepEqual(h.recordedPublishes, ['acct-A'], '发布前是否越权不影响事实记账：平台确认发布后必须占用 publish 配额');
  });

  test('普通候选仍一律 automatic，单凭人工批准动作不会把自动候选抬档', async () => {
    const h = harness({ approved: true, edgeId: 'edge-A' });
    await h.dispatcher.dispatch(7, { humanApproval: true });
    assert.deepEqual(h.leasePriorities, ['automatic']);
  });

  test('其它 target 的自动排期稿在授权读取和 Edge 写入前被跳过，状态保持不变', async () => {
    const draft = makeDraft({
      metadata: {
        ...makeDraft().metadata!,
        scheduleExecution: { executionTarget: 'dev', envKey: 'env-a', hourCell: '2026-01-05-10' },
      },
    });
    const h = harness({ draft, executionTarget: 'ol' });
    await h.dispatcher.dispatch(draft.recordId, { humanApproval: true });
    assert.equal(h.events.includes('seq'), false);
    assert.equal(h.events.includes('lease:acquired'), false);
    assert.deepEqual(h.statusUpdates, []);
    assert.deepEqual(h.voided, []);
  });

  test('相同 target 的自动排期稿正常下发，兜底扫描把本地 target 传给存储过滤', async () => {
    const draft = makeDraft({
      metadata: {
        ...makeDraft().metadata!,
        scheduleExecution: { executionTarget: 'dev', envKey: 'env-a', hourCell: '2026-01-05-10' },
      },
    });
    const h = harness({ draft, executionTarget: 'dev', edgeId: 'ads-env-a' });
    await h.dispatcher.scanAndDispatchApproved();
    assert.equal(h.scannedTarget, 'dev');
    assert.equal(h.events.includes('seq'), true);
  });

  test('相同 target 但在线浏览器 envKey 已变化时，按当前在线环境照常下发', async () => {
    // 裁定 2026-08-03（change wire-content-scheduler-into-api-process）：账号连着引擎才执行排期，
    // 但**不再管是哪个浏览器环境**。此前这里会保留授权、绝不改投，结果是账号换了环境之后
    // 稿件永远投不出去。target 那道闸不受影响，另有用例钉着。
    const draft = makeDraft({
      metadata: {
        ...makeDraft().metadata!,
        scheduleExecution: { executionTarget: 'dev', envKey: 'env-a', hourCell: '2026-01-05-10' },
      },
    });
    const h = harness({ draft, executionTarget: 'dev', edgeId: 'ads-env-b' });
    await h.dispatcher.dispatch(draft.recordId);
    assert.equal(h.events.includes('seq'), true, '换了浏览器环境不再是跳过的理由');
  });

  test('触发时解析不出浏览器环境的自动稿件照常下发', async () => {
    // 归属里 envKey=null 是「没记录」，不是「非法归属」——它不该让稿件卡住。
    const draft = makeDraft({
      metadata: {
        ...makeDraft().metadata!,
        scheduleExecution: { executionTarget: 'dev', envKey: null, hourCell: '2026-01-05-10' },
      },
    });
    const h = harness({ draft, executionTarget: 'dev', edgeId: 'ads-env-b' });
    await h.dispatcher.dispatch(draft.recordId);
    assert.equal(h.events.includes('seq'), true);
  });

  test('精确手工 /publish 冻结的 human 档位跨审批等待与下发保持不变', async () => {
    const base = makeDraft();
    const h = harness({
      approved: true,
      edgeId: 'edge-A',
      draft: makeDraft({
        metadata: { ...base.metadata!, edgeLeasePriority: 'human' },
      }),
    });
    await h.dispatcher.dispatch(7, { humanApproval: true });
    assert.deepEqual(h.leasePriorities, ['human']);
  });

  test('AC-PUB 红线：未授权 → 绝不让位、绝不驱动序列、不改态', async () => {
    const h = harness({ approved: false });
    await h.dispatcher.dispatch(7);
    assert.equal(h.events.includes('seq'), false, '未授权绝不驱动序列');
    assert.equal(h.events.includes('start'), false, '未授权不让位');
    assert.equal(h.statusUpdates.length, 0, '未授权不改态（仍待审）');
  });

  test('初始 core 离线（零页面副作用）→ 保留授权等待恢复、不烧稿、不让位、不驱动序列', async () => {
    const h = harness({ approved: true, edgeId: null });
    await h.dispatcher.dispatch(7);
    assert.equal(h.events.includes('seq'), false, '离线不驱动序列');
    assert.equal(h.events.includes('start'), false, '离线不让位空转');
    assert.equal(h.statusUpdates.length, 0, '不改态：草稿留待审且不烧成 failed 终态');
    assert.deepEqual(h.voided, [], '批准已受理，初始 core 离线不得作废授权或要求重复批准');
    assert.deepEqual(
      h.notices,
      [{ kind: 'edge_offline_waiting', accountId: 'acct-A', recordId: 7, title: 'vLLM 部署踩坑' }],
      '如实通知已受理但待 core 恢复，绝不冒充已发布',
    );
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

  test('浏览器等待本机槽位（零副作用）→ 保留授权、保持待审、通知自动重试且不计熔断', async () => {
    const h = harness({
      approved: true,
      edgeId: 'edge-online',
      leaseError: new EdgeTaskLeaseError('browser_wake_failed', 'parked browser is still waiting for a local slot'),
    });
    await h.dispatcher.dispatch(7);
    assert.equal(h.events.includes('seq'), false, '未 acquired 前绝不驱动发布序列');
    assert.equal(h.statusUpdates.length, 0, '草稿保持 pending_approval');
    assert.deepEqual(h.voided, [], '槽位等待保留有效授权，后续无需重批');
    assert.deepEqual(
      h.notices,
      [{ kind: 'browser_slot_waiting', accountId: 'acct-A', recordId: 7, title: 'vLLM 部署踩坑' }],
    );
    assert.equal(h.dispatcher.isBreakerOpen('acct-A'), false, '零发布命令不计序列失败/熔断');
  });

  test('槽位等待由既有扫描重试；同进程连续等待只通知一次，取得 lease 后清除并可重新武装', async () => {
    const draft = makeDraft();
    let attempt = 0;
    const h = harness({
      approved: true,
      draft,
      edgeId: 'edge-online',
      leaseError: () => {
        attempt += 1;
        return attempt === 1 || attempt === 2 || attempt === 4
          ? new EdgeTaskLeaseError('browser_wake_failed', 'waiting for browser slot')
          : undefined;
      },
    });

    await h.dispatcher.dispatch(7); // 首次等待，发一次通知
    await h.dispatcher.scanAndDispatchApproved(); // 第二次仍等待，不重复通知
    assert.equal(h.notices.filter((n) => n.kind === 'browser_slot_waiting').length, 1);
    assert.deepEqual(h.voided, []);

    await h.dispatcher.scanAndDispatchApproved(); // 第三次取得 lease，清除等待去重并执行
    assert.equal(h.events.filter((event) => event === 'seq').length, 1, 'scanner 驱动的重试只执行一次序列');

    await h.dispatcher.dispatch(7); // 桩保持 pending，模拟新的独立等待生命周期
    assert.equal(h.notices.filter((n) => n.kind === 'browser_slot_waiting').length, 2, '取得 lease 后允许新等待重新通知');
    assert.deepEqual(h.voided, []);
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
      readApproval: async () => ({ approved: true, contentVersion: 0, revision: 1 }),
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

// ── change publish-approval-signal-to-database ────────────────────────────────
describe('PublishDispatcher · 持久授权与待下发态', () => {
  test('授权状态不可读 → 不下发、不写任何终态、落 approval_unreadable 阻塞原因', async () => {
    const h = harness({ approvalUnreadable: true, edgeId: 'edge-A' });
    await h.dispatcher.dispatch(7, { approvalRevision: 1 });

    assert.equal(h.events.includes('seq'), false, '授权读不到就绝不下发');
    assert.deepEqual(h.statusUpdates, [], '「不知道批没批」MUST NOT 烧成任何终态');
    assert.deepEqual(h.voided, [], '不可读不等于该作废——授权保持活跃');
    assert.deepEqual(h.blocked, [{ requestId: 'publish-7', reason: 'approval_unreadable' }]);
  });

  test('边缘离线 → 保留授权 + 落 edge_offline_waiting；正常下发时阻塞原因被清空', async () => {
    const offline = harness({ approved: true, edgeId: null });
    await offline.dispatcher.dispatch(7);
    assert.deepEqual(offline.blocked, [{ requestId: 'publish-7', reason: 'edge_offline_waiting' }]);
    assert.deepEqual(offline.statusUpdates, [], '零副作用，绝不烧稿');

    const ok = harness({ approved: true, edgeId: 'edge-A' });
    await ok.dispatcher.dispatch(7);
    assert.deepEqual(ok.blocked, [{ requestId: 'publish-7', reason: null }], '阻塞解除 MUST 清空，绝不遗留过期文案');
    assert.deepEqual(
      ok.progress.map((p) => p.action),
      ['dispatching', 'consumed'],
      '下发进度：领取即 dispatching，序列收敛即 consumed',
    );
  });

  test('等浏览器槽位 → 落 browser_slot_waiting，且 MUST 在从未 dispatching 的状态下也写得进去', async () => {
    const h = harness({
      approved: true,
      edgeId: 'edge-online',
      leaseError: new EdgeTaskLeaseError('browser_wake_failed', 'parked browser is still waiting for a local slot'),
    });
    await h.dispatcher.dispatch(7);

    // acquire 阶段就被 reject ⇒ 业务回调没跑 ⇒ 全程没有 dispatching 这一步。
    assert.deepEqual(h.progress.map((p) => p.action), ['pending_dispatch']);
    assert.deepEqual(
      h.blocked,
      [{ requestId: 'publish-7', reason: null }, { requestId: 'publish-7', reason: 'browser_slot_waiting' }],
      '先清旧原因、再落槽位等待；写不进去的话后台看不到真实原因，看门狗还会误报「下发侧失联」',
    );
    assert.deepEqual(h.voided, [], '槽位等待保留授权');
  });

  test('版本闸命中 → 作废原因是 version_stale（四类作废各自可区分）', async () => {
    const h = harness({ approved: true, approvedVersion: 1, draft: makeDraft({ contentVersion: 2 }), edgeId: 'edge-A' });
    await h.dispatcher.dispatch(7);
    assert.deepEqual(h.voidReasons, [{ requestId: 'publish-7', reason: 'version_stale' }]);
    assert.equal(h.events.includes('seq'), false);
  });

  test('dispatching revision CAS 未确认 → 租约内 fail closed，不发送任何平台命令', async () => {
    const h = harness({ approved: true, approvedRevision: 9, edgeId: 'edge-A', dispatchProgressFails: true });
    await h.dispatcher.dispatch(7, { approvalRevision: 9 });
    assert.equal(h.events.includes('lease:acquired'), true);
    assert.equal(h.events.includes('seq'), false, 'progress CAS 失败发生在第一条平台命令之前');
    assert.deepEqual(h.statusUpdates, [], '不得把 authority unknown/conflict 写成发布终态');
    assert.deepEqual(h.voided, [], 'CAS 未确认不等于可以作废当前授权');
  });

  test('租约未确认 → 作废原因是 lease_unconfirmed，稿件不烧成 failed', async () => {
    const h = harness({
      approved: true,
      edgeId: 'edge-A',
      leaseError: new EdgeTaskLeaseError('acquire_timeout', 'timeout'),
    });
    await h.dispatcher.dispatch(7);
    assert.deepEqual(h.voidReasons, [{ requestId: 'publish-7', reason: 'lease_unconfirmed' }]);
    assert.deepEqual(h.statusUpdates, []);
  });

  test('兜底扫描改为按本机 target 批量拉待下发，不再逐条读授权', async () => {
    const pulls: number[] = [];
    const h = harness({
      approved: true,
      edgeId: 'edge-A',
      pendingDispatchRecordIds: async () => { pulls.push(1); return [7]; },
    });
    await h.dispatcher.scanAndDispatchApproved();
    assert.equal(pulls.length, 1, '一次批量拉取，取代逐条查询放大器');
    assert.equal(h.events.includes('seq'), true);
    assert.equal(h.scannedTarget, undefined, '不再走 listPendingApprovalIds 的逐条复核路径');
  });

  test('批量拉取失败 → 本轮不下发，绝不当作「扫完了、没有待下发」', async () => {
    const h = harness({
      approved: true,
      edgeId: 'edge-A',
      pendingDispatchRecordIds: async () => { throw new Error('pg_down'); },
    });
    await h.dispatcher.scanAndDispatchApproved();
    assert.equal(h.events.includes('seq'), false);
  });
});

/**
 * Facebook 素材记账的两条「没做成」（task 2.4d）。
 *
 * 这两支**有意**不影响下发主链路，所以它们发生时没有任何调用方会知道；而每一次都对应一组
 * 永久停在 `reserved`、无人回收的素材。原先它们一个是与「这条稿本来就没有素材保留」挤在同一个
 * 静默 `return` 里，一个只有一句谁都不数的 warn。
 *
 * **三条一起才说明问题**：只断言「缺端口会响」不够——那样把「本来就没保留」也一并弄响就算过了，
 * 而那是一次正常返回，弄响等于制造噪声。所以第三条钉的是**不该响的那次真的没响**。
 */
describe('Facebook 素材记账没做成时必须留下可数的痕迹', () => {
  const facebookDraft = (over: Record<string, unknown> = {}) =>
    makeDraft({
      platform: 'facebook',
      metadata: { facebookMedia: { setId: 42, reservationId: 'rsv-1' }, ...over } as any,
    } as Partial<DispatchDraft>);

  test('本进程没有素材端口 → 计入 dropped 并具名说出来，MUST NOT 静默 return', async () => {
    const logs: string[] = [];
    const h = harness({ approved: true, edgeId: 'edge-A', draft: facebookDraft(), captureLogs: logs });
    await h.dispatcher.dispatch(7);

    assert.deepEqual(
      h.dispatcher.getFacebookMediaSettleMisses(),
      { dropped: 1, failed: 0 },
      '缺端口 MUST 计入 dropped —— 它是配置缺口，不是「这条稿没有素材」',
    );
    const named = logs.filter((line) => line.includes('facebook_media_settle_dropped'));
    assert.equal(named.length, 1, '缺端口 MUST 留一条具名日志');
    assert.match(named[0]!, /set=42/);
    assert.match(named[0]!, /reserved/, '日志 MUST 说出后果：这组素材会一直停在 reserved');
  });

  test('端口在但写失败 → 计入 failed，且仍不打断下发主链路', async () => {
    const logs: string[] = [];
    const h = harness({
      approved: true,
      edgeId: 'edge-A',
      draft: facebookDraft(),
      captureLogs: logs,
      facebookPublishMedia: {
        releaseReservation: async () => { throw new Error('content unreachable'); },
        markUsed: async () => { throw new Error('content unreachable'); },
        quarantine: async () => { throw new Error('content unreachable'); },
      },
    });
    await h.dispatcher.dispatch(7);

    assert.deepEqual(
      h.dispatcher.getFacebookMediaSettleMisses(),
      { dropped: 0, failed: 1 },
      '写失败 MUST 计入 failed —— 与「没这条端口」处置完全不同，所以分开数',
    );
    // 主链路照常走完：素材记账拖垮下发才是更坏的失败。
    assert.ok(h.events.includes('seq'), '素材记账失败 MUST NOT 打断下发');
  });

  test('这条稿本来就没有素材保留 → 两个计数都不动（这一支不该响）', async () => {
    const logs: string[] = [];
    const h = harness({
      approved: true,
      edgeId: 'edge-A',
      draft: makeDraft({ platform: 'facebook', metadata: {} as any } as Partial<DispatchDraft>),
      captureLogs: logs,
    });
    await h.dispatcher.dispatch(7);

    assert.deepEqual(
      h.dispatcher.getFacebookMediaSettleMisses(),
      { dropped: 0, failed: 0 },
      '「没有素材保留」是一次正常返回，把它也弄响只会制造噪声',
    );
    assert.equal(logs.filter((line) => line.includes('facebook_media_settle_dropped')).length, 0);
  });
});

/**
 * change defer-transient-publish-predispatch-failures —— 提交前失败按分档处置。
 *
 * 治的是这个：一个**已被序列器证明零派发**的失败，此前被当成「页面状态未知」——写 failed 终态、
 * 烧掉授权签名、计入熔断。熔断阈值默认 2，于是同账号连撞两次网络抖动就停掉整批已批准草稿，
 * 必须运营重新逐条点批准才能清除。**一次抖动的代价是重审一批稿。**
 */
describe('PublishDispatcher · 提交前失败分档', () => {
  /** 记录 FB 素材三个写各被调了几次（归还 vs 隔离是这一档最关键的分叉）。 */
  function mediaSpy() {
    const calls: string[] = [];
    return {
      calls,
      port: {
        releaseReservation: async () => { calls.push('release'); return true; },
        markUsed: async () => { calls.push('markUsed'); return true; },
        quarantine: async () => { calls.push('quarantine'); return true; },
      },
    };
  }

  const facebookDraft = () =>
    makeDraft({
      platform: 'facebook',
      metadata: { facebookMedia: { setId: 42, reservationId: 'rsv-1' } } as any,
    } as Partial<DispatchDraft>);

  const deferred = (error = 'no_target') => ({
    ok: false,
    outcome: 'deferred_before_submit',
    attachedCount: 0,
    failedAt: { seq: 1, kind: 'select_mode', error },
  });

  // ── 3.1 ────────────────────────────────────────────────────────────────────
  test('提交前抖动 → 保持待审 + 授权保留 + 素材归还 + 熔断计数不变 + 触发重投', async () => {
    const media = mediaSpy();
    const h = harness({
      approved: true,
      edgeId: 'edge-A',
      draft: facebookDraft(),
      facebookPublishMedia: media.port,
      seqResult: deferred(),
    });
    await h.dispatcher.dispatch(7);

    assert.equal(h.events.includes('seq'), true, '序列确实跑过（抖动发生在提交点之前）');
    assert.deepEqual(h.statusUpdates, [], '绝不写任何终态：草稿留 pending_approval（failed 不可逆）');
    assert.deepEqual(h.voided, [], '授权签名保留（不 void）→ 重投可再过 AC-PUB');
    assert.deepEqual(
      h.progress.map((p) => p.action),
      ['dispatching', 'pending_dispatch'],
      '授权退回待下发，MUST NOT markConsumed —— 消耗掉就得运营重新批准',
    );
    assert.deepEqual(media.calls, ['release'], '素材归还而非隔离（这一档零平台副作用）');
    assert.equal(h.dispatcher.isBreakerOpen('acct-A'), false);
    assert.equal(h.notices.some((n) => n.kind === 'breaker_open'), false, '零副作用档 MUST NOT 计熔断');
    assert.equal(h.redispatched.length, 1, '事件驱动重投一次');
  });

  test('同账号连撞多次提交前抖动仍不熔断（原来两次就停掉整批已批草稿）', async () => {
    const h = harness({ approved: true, edgeId: 'edge-A', seqResult: deferred(), deferredRedispatchMax: 99 });
    for (let i = 0; i < 4; i++) await h.dispatcher.dispatch(7);
    assert.equal(h.dispatcher.isBreakerOpen('acct-A'), false, '熔断守的是连环烧稿，这一档根本不烧稿');
    assert.deepEqual(h.statusUpdates, [], '四次抖动、零终态');
  });

  // ── 3.2 ────────────────────────────────────────────────────────────────────
  test('重投耗尽 → failed 终态，且说的是「重试 N 次未成」而不是「做不到」', async () => {
    const logs: string[] = [];
    const h = harness({
      approved: true,
      edgeId: 'edge-A',
      seqResult: deferred('page_not_ready'),
      deferredRedispatchMax: 2,
      captureLogs: logs,
    });
    // 三次下发 = 首投 + 2 次重投；第三次时预算已用尽。
    await h.dispatcher.dispatch(7);
    await h.dispatcher.dispatch(7);
    assert.deepEqual(h.statusUpdates, [], '预算未尽前绝不落终态');
    assert.equal(h.redispatched.length, 2, '上限 2 ⇒ 恰好调度 2 次重投');

    await h.dispatcher.dispatch(7);
    assert.deepEqual(h.statusUpdates.at(-1), { id: 7, status: 'failed' }, '耗尽后才落 failed');
    assert.equal(h.redispatched.length, 2, '耗尽后不再调度重投');
    const notice = h.notices.find((n) => n.kind === 'predispatch_retry_exhausted');
    assert.ok(notice, '耗尽 MUST 如实通知运营');
    assert.equal(notice!.attempts, 2, '通知带上真实次数，文案才写得出「重试 2 次未成」');
    assert.equal(h.notices.some((n) => n.kind === 'breaker_open'), false, '耗尽落 failed 仍不计熔断（零平台副作用）');
    const said = logs.find((l) => l.includes('重试 2 次未成'));
    assert.ok(said, '日志 MUST 说「重试 N 次未成」——「做不到」会让运营以为重批也没用');
  });

  test('恢复预算只由本档消费：被抢占重投 MUST NOT 递减它', async () => {
    // 先被抢占两次（走抢占自己的预算），再连吃两次提交前抖动——后者必须还有满额预算。
    let mode: 'preempted' | 'deferred' = 'preempted';
    const h = harness({
      approved: true,
      edgeId: 'edge-A',
      preemptRedispatchMax: 99,
      deferredRedispatchMax: 2,
      get seqResult() {
        return mode === 'preempted'
          ? { ok: false, outcome: 'preempted', attachedCount: 0, failedAt: { seq: 3, kind: 'fill_field', error: 'preempted_by_task' } }
          : deferred();
      },
    } as any);
    await h.dispatcher.dispatch(7);
    await h.dispatcher.dispatch(7);
    mode = 'deferred';
    await h.dispatcher.dispatch(7);
    await h.dispatcher.dispatch(7);
    assert.deepEqual(h.statusUpdates, [], '抢占吃掉的是抢占预算；恢复预算此时才用掉 2 次里的 2 次，尚未越界');
  });

  // ── 结构性档 ────────────────────────────────────────────────────────────────
  test('结构性提交前失败 → failed 终态、不重投、素材归还，但同样不计熔断', async () => {
    const media = mediaSpy();
    const h = harness({
      approved: true,
      edgeId: 'edge-A',
      draft: facebookDraft(),
      facebookPublishMedia: media.port,
      seqResult: {
        ok: false,
        outcome: 'structural_before_submit',
        attachedCount: 0,
        failedAt: { seq: -1, kind: 'submit_publish', error: 'not_approved' },
      },
    });
    await h.dispatcher.dispatch(7);
    await h.dispatcher.dispatch(7);
    assert.deepEqual(h.statusUpdates.at(-1), { id: 7, status: 'failed' }, '重来必然一样 ⇒ 终态');
    assert.equal(h.redispatched.length, 0, '结构性档 MUST NOT 自动重投');
    assert.deepEqual(media.calls, ['release', 'release'], '零平台副作用 ⇒ 素材归还');
    assert.equal(h.dispatcher.isBreakerOpen('acct-A'), false, '零副作用档不计熔断');
    assert.deepEqual(h.progress.map((p) => p.action).filter((a) => a === 'consumed').length, 2, '终态 ⇒ 授权消耗');
  });

  // ── 3.4 回归：跨过提交点的处置逐字未变 ────────────────────────────────────────
  test('回归：submitted_unconfirmed 处置一字不动——转 submitted、绝不重投、素材隔离', async () => {
    const media = mediaSpy();
    const h = harness({
      approved: true,
      edgeId: 'edge-A',
      draft: facebookDraft(),
      facebookPublishMedia: media.port,
      seqResult: { ok: true, outcome: 'submitted_unconfirmed', attachedCount: 1 },
    });
    await h.dispatcher.dispatch(7);
    assert.deepEqual(h.statusUpdates.at(-1), { id: 7, status: 'submitted' });
    assert.equal(h.redispatched.length, 0, '跨过提交点 MUST NOT 进任何重投通道（会双发）');
    assert.deepEqual(media.calls, ['quarantine'], '可能已上墙 ⇒ 隔离，MUST NOT 归还给别的稿');
    assert.equal(h.postWrite, undefined, '没抓到 postId 绝不伪造');
    assert.deepEqual(h.progress.map((p) => p.action), ['dispatching', 'consumed'], '授权已用掉，绝不留在待下发');
  });

  test('回归：页面状态未知（提交已推送、证明不了没按下）仍 failed + 计熔断 + 绝不重投', async () => {
    const h = harness({
      approved: true,
      edgeId: 'edge-A',
      seqResult: {
        ok: false,
        outcome: 'failed_page_state_unknown',
        attachedCount: 0,
        failedAt: { seq: 6, kind: 'submit_publish', error: 'publish.command timeout' },
      },
    });
    await h.dispatcher.dispatch(7);
    await h.dispatcher.dispatch(7);
    assert.deepEqual(h.statusUpdates.at(-1), { id: 7, status: 'failed' });
    assert.equal(h.redispatched.length, 0, '证明不了没跨过提交点 ⇒ 绝不自动重投');
    assert.equal(h.dispatcher.isBreakerOpen('acct-A'), true, '只有这一档计熔断（连环烧稿的那一档）');
  });

  test('未识别的 outcome → 按最保守的一档处置，且 MUST 当场喊出来（不静默漂移）', async () => {
    const logs: string[] = [];
    const h = harness({
      approved: true,
      edgeId: 'edge-A',
      captureLogs: logs,
      seqResult: { ok: false, outcome: 'some_future_outcome', attachedCount: 0, failedAt: { seq: 2, kind: 'x', error: 'y' } },
    });
    await h.dispatcher.dispatch(7);
    assert.deepEqual(h.statusUpdates.at(-1), { id: 7, status: 'failed' }, '不认识就按不重投处置（落错这一侧只会更保守）');
    assert.equal(h.redispatched.length, 0);
    assert.ok(logs.some((l) => l.includes('未识别的序列终局')), '沉默地更保守也是漂移，MUST 喊出来');
  });
});
