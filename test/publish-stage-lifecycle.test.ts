import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPublishLifecycle } from '../src/panel/publish-stage-lifecycle.js';
import type { PanelPublish } from '../src/panel/panel-store.js';

function publish(overrides: Partial<PanelPublish> = {}): PanelPublish {
  return {
    id: 101,
    title: 'Agent 选型别盲信榜单高分',
    status: 'pending_approval',
    platformPostId: null,
    publishedAt: 1_700_000_000_000,
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
