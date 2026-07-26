import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPublishLifecycle } from '../src/panel/publish-stage-lifecycle.js';
import type { PanelPublish } from '../src/panel/panel-store.js';

function publish(overrides: Partial<PanelPublish> = {}): PanelPublish {
  return {
    id: 101,
    title: 'Agent 选型别盲信榜单高分',
    status: 'pending_approval',
    platform: 'xiaohongshu',
    platformPostId: null,
    publishedAt: 1_700_000_000_000,
    publishMode: 'immediate',
    publishTime: null,
    scheduledAt: null,
    scheduledPlatformId: null,
    accountId: 'acc-1',
    accountLabel: 'Tmax',
    content: '正文',
    postUrl: null,
    contentVersion: 0,
    images: ['https://img/1.jpg'],
    imageUrl: 'https://img/1.jpg',
    imagesAttachedCount: 0,
    imageReferenceAudit: null,
    coverFormAudit: null,
    visualReferenceAudit: null,
    sourceReference: null,
    ...overrides,
  };
}

function stateOf(result: ReturnType<typeof buildPublishLifecycle>, key: string, section: 'active' | 'recent' = 'active') {
  return result[section][0]?.stages.find((item) => item.key === key)?.state;
}

test('正文产出后文本质检与视觉策划可同时进行，不把任意字段当整段完成', () => {
  const lifecycle = buildPublishLifecycle({
    queue: {
      status: 'running',
      snapshot: null,
      runs: [{
        runId: 'r1', accountId: 'acc-1', kind: 'autonomous', sourceId: null, startedAt: 10, status: 'running',
        snapshot: {
          trigger: { accountId: 'acc-1', generateInput: {} },
          scoutDecision: { shouldPublish: true },
          createdContent: { title: '正文标题', content: '正文内容' },
          postCategory: { category: 'tech' },
        },
      }],
    },
    pending: [],
    recent: [],
  });

  assert.equal(lifecycle.status, 'running');
  assert.equal(stateOf(lifecycle, 'content'), 'completed');
  assert.equal(stateOf(lifecycle, 'text_quality'), 'running');
  assert.equal(stateOf(lifecycle, 'visual_plan'), 'running');
  assert.equal(stateOf(lifecycle, 'image_review'), 'pending');
});

test('显式 retrySignal 映射为重试中，不染成完成或普通进行中', () => {
  const lifecycle = buildPublishLifecycle({
    queue: {
      status: 'running', snapshot: null, runs: [{
        runId: 'retry', accountId: 'acc-1', kind: 'autonomous', sourceId: null, startedAt: 10, status: 'running',
        snapshot: {
          trigger: { accountId: 'acc-1', generateInput: {} },
          scoutDecision: { shouldPublish: true },
          createdContent: { title: '正文标题', content: '正文内容' },
          retrySignal: { reason: '质量分不足', attempt: 1 },
        },
      }],
    },
    pending: [], recent: [],
  });
  assert.equal(stateOf(lifecycle, 'text_quality'), 'retrying');
  assert.equal(lifecycle.active[0].stages.find((item) => item.key === 'text_quality')?.summary, '质量分不足');
});

test('待审与 dispatcher 在途使用同一持久化稿件但呈现不同阶段', () => {
  const row = publish();
  const waiting = buildPublishLifecycle({
    queue: { status: 'completed', snapshot: null, runs: [] },
    pending: [row],
    recent: [row],
  });
  assert.equal(waiting.status, 'waiting_human');
  assert.equal(waiting.active.length, 1);
  assert.equal(stateOf(waiting, 'approval'), 'waiting_human');
  assert.equal(stateOf(waiting, 'dispatch'), 'pending');
  assert.equal(waiting.recent.length, 0);

  const dispatching = buildPublishLifecycle({
    queue: { status: 'completed', snapshot: null, runs: [] },
    pending: [row],
    recent: [row],
    inFlightRecordIds: [row.id],
  });
  assert.equal(dispatching.status, 'running');
  assert.equal(dispatching.active[0].status, 'dispatching');
  assert.equal(stateOf(dispatching, 'approval'), 'completed');
  assert.equal(stateOf(dispatching, 'dispatch'), 'running');
});

test('failed 与 submitted 只进入最近结果，并诚实区分失败和部分完成', () => {
  const failed = publish({ id: 102, status: 'failed', imagesAttachedCount: 1 });
  const submitted = publish({ id: 103, status: 'submitted', publishedAt: failed.publishedAt - 1 });
  const lifecycle = buildPublishLifecycle({
    queue: { status: 'failed', snapshot: { publishResult: { recordId: 102, status: 'failed' } }, runs: [] },
    pending: [],
    recent: [failed, submitted],
  });

  assert.equal(lifecycle.status, 'idle');
  assert.equal(lifecycle.active.length, 0);
  assert.equal(lifecycle.recent[0].status, 'failed');
  assert.equal(stateOf(lifecycle, 'dispatch', 'recent'), 'failed');
  assert.equal(lifecycle.recent[1].status, 'submitted');
  assert.equal(lifecycle.recent[1].stages.find((item) => item.key === 'dispatch')?.state, 'partial');
});

test('scheduled 进入最近结果并显示等待公开对账，不冒充已发布', () => {
  const scheduled = publish({
    id: 104,
    status: 'scheduled',
    publishMode: 'scheduled',
    publishTime: 1_800_007_200_000,
    scheduledAt: 1_800_007_200_000,
    scheduledPlatformId: 'scheduled-internal-104',
  });
  const lifecycle = buildPublishLifecycle({
    queue: { status: 'idle', snapshot: null },
    pending: [],
    recent: [scheduled],
  });
  assert.equal(lifecycle.recent[0]?.status, 'scheduled');
  assert.equal(stateOf(lifecycle, 'dispatch', 'recent'), 'partial');
  assert.match(lifecycle.recent[0]?.statusSummary ?? '', /等待公开后对账/);
});

test('run 已写 publishResult 时与同 recordId 待审稿去重', () => {
  const row = publish({ id: 104 });
  const lifecycle = buildPublishLifecycle({
    queue: {
      status: 'running',
      snapshot: { publishResult: { recordId: 104, status: 'pending_approval' } },
      runs: [{
        runId: 'r104', accountId: 'acc-1', kind: 'autonomous', sourceId: null, startedAt: row.publishedAt,
        status: 'running', snapshot: { publishResult: { recordId: 104, status: 'pending_approval' } },
      }],
    },
    pending: [row],
    recent: [row],
  });

  assert.deepEqual(lifecycle.active.map((item) => item.journeyId), ['publish:104']);
});

test('无 record 的生成失败进入最近结果，空闲时不冒充活跃稿件', () => {
  const lifecycle = buildPublishLifecycle({
    queue: {
      status: 'failed',
      runs: [],
      snapshot: {
        trigger: { accountId: 'acc-1', generateInput: {} },
        scoutDecision: { shouldPublish: true },
        pipelineAbort: { role: 'ImageGenerator', reason: 'visual audit rejected', abortedAt: 20 },
      },
    },
    pending: [],
    recent: [],
  });

  assert.equal(lifecycle.status, 'idle');
  assert.equal(lifecycle.active.length, 0);
  assert.equal(lifecycle.recent[0].status, 'failed');
  assert.equal(stateOf(lifecycle, 'image_review', 'recent'), 'failed');
});

// ── change publish-approval-signal-to-database：已批准·待下发是独立可见状态 ────────────────
test('已批准·待下发：与「待审批」可区分，带等待时长与可读阻塞原因', () => {
  const decidedAt = 1_700_000_000_000;
  const now = decidedAt + 7 * 60_000;
  const lifecycle = buildPublishLifecycle({
    queue: { status: 'idle', snapshot: null, runs: [] },
    pending: [publish()],
    recent: [],
    // 进程内在途集合是空的：投影**不得**因此把已批准的稿显示成「待审批」。
    inFlightRecordIds: [],
    approvalDispatch: new Map([[101, {
      approved: true,
      dispatchState: 'pending_dispatch' as const,
      dispatchBlockedReason: 'edge_offline_waiting',
      decidedAt,
    }]]),
    now,
  });

  const journey = lifecycle.active[0];
  assert.notEqual(journey.status, 'waiting_approval', '已批准 MUST NOT 与待审批同状态');
  assert.equal(journey.dispatchState, 'pending_dispatch');
  assert.equal(journey.dispatchBlockedReason, 'edge_offline_waiting');
  assert.equal(journey.decidedAt, decidedAt);
  assert.equal(journey.waitingMs, 7 * 60_000);
  assert.match(journey.statusSummary, /已批准·待下发/);
  assert.equal(stateOf(lifecycle, 'approval'), 'completed');
  const dispatchStage = lifecycle.active[0].stages.find((item) => item.key === 'dispatch');
  assert.match(dispatchStage?.summary ?? '', /已批准·待下发/);
  assert.ok(dispatchStage?.facts.some((fact) => /已等待 7 分钟/.test(fact)));
});

test('进程重启（在途集合清空）后，已批准·待下发不会退回待审批', () => {
  const lifecycle = buildPublishLifecycle({
    queue: { status: 'idle', snapshot: null, runs: [] },
    pending: [publish()],
    recent: [],
    inFlightRecordIds: [],
    approvalDispatch: new Map([[101, {
      approved: true,
      dispatchState: 'dispatching' as const,
      dispatchBlockedReason: null,
      decidedAt: 1_700_000_000_000,
    }]]),
    now: 1_700_000_060_000,
  });
  assert.equal(lifecycle.active[0].status, 'dispatching');
  assert.equal(stateOf(lifecycle, 'approval'), 'completed');
});

test('无持久授权（未接线 / 尚未批准）→ 回落既有在途集合判据，行为零回归', () => {
  const waiting = buildPublishLifecycle({
    queue: { status: 'idle', snapshot: null, runs: [] },
    pending: [publish()],
    recent: [],
    inFlightRecordIds: [],
  });
  assert.equal(waiting.active[0].status, 'waiting_approval');
  assert.equal(waiting.active[0].dispatchState, undefined);
  assert.equal(stateOf(waiting, 'approval'), 'waiting_human');

  const inFlight = buildPublishLifecycle({
    queue: { status: 'idle', snapshot: null, runs: [] },
    pending: [publish()],
    recent: [],
    inFlightRecordIds: [101],
  });
  assert.equal(inFlight.active[0].status, 'dispatching');
});

test('in-flight 证据不可用时不把空集合推断成待审或下发中，durable projection 仍优先', () => {
  const unavailable = buildPublishLifecycle({
    queue: { status: 'idle', snapshot: null, runs: [] },
    pending: [publish()],
    recent: [],
    inFlightEvidence: { state: 'stale', asOf: 1_700_000_000_000, recordIds: null },
  });
  assert.deepEqual(unavailable.inFlightEvidence, { state: 'stale', asOf: 1_700_000_000_000 });
  assert.equal(unavailable.active[0].statusSummary, '下发状态暂不可用');
  assert.equal(stateOf(unavailable, 'approval'), 'evidence_unavailable');
  assert.equal(stateOf(unavailable, 'dispatch'), 'evidence_unavailable');

  const durable = buildPublishLifecycle({
    queue: { status: 'idle', snapshot: null, runs: [] },
    pending: [publish()],
    recent: [],
    inFlightEvidence: { state: 'invalid', asOf: 1_700_000_000_000, recordIds: null },
    approvalDispatch: new Map([[101, {
      approved: true,
      dispatchState: 'dispatching',
      dispatchBlockedReason: null,
      decidedAt: 1_699_999_940_000,
    }]]),
    now: 1_700_000_000_000,
  });
  assert.equal(durable.active[0].status, 'dispatching');
  assert.equal(stateOf(durable, 'approval'), 'completed');
  assert.equal(stateOf(durable, 'dispatch'), 'running');
});
