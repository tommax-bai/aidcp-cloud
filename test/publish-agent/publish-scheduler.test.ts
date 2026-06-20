import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { PublishScheduler } from '../../src/publish-agent/publish-scheduler.js';
import type { PublishSchedulerDeps } from '../../src/publish-agent/publish-scheduler.js';

const T = 1700000000000;
const HOUR = 3_600_000;
const silent = { log() {}, warn() {}, error() {} };

interface Knobs {
  newConcepts?: number;
  lastPublishMs?: number | null;
  canDo?: boolean;
  status?: string;
  conceptThreshold?: number;
  minHoursBetween?: number;
}

function build(k: Knobs = {}) {
  const triggered: string[] = [];
  const deps: PublishSchedulerDeps = {
    conceptStore: {
      countNewSince: async () => k.newConcepts ?? 0,
      getNewConceptsSince: async () => ['LLM Agent', 'RAG'],
    },
    likedStore: {
      countSince: async () => 1,
      recentSince: async () => [{ id: 7, title: 'RAG 实战', summary: '分块', author: '老王' }],
    },
    publishLog: {
      getMostRecentPublishTime: async () => (k.lastPublishMs === undefined ? null : k.lastPublishMs),
      recentPublishedContents: async () => ['上一篇'],
    },
    risk: { canDo: () => k.canDo ?? true, getState: () => ({ status: k.status ?? 'normal' }) },
    orchestrator: { trigger: async (input) => { triggered.push(JSON.stringify(input.metrics)); return { status: 'draft' }; } },
    soul: {} as PublishSchedulerDeps['soul'],
    conceptThreshold: k.conceptThreshold ?? 5,
    minHoursBetween: k.minHoursBetween ?? 24,
    clock: () => T,
    logger: silent,
  };
  return { scheduler: new PublishScheduler(deps), triggered };
}

describe('AC-PUB-SCHED PublishScheduler 三扳机', () => {
  it('概念积累达阈 + canDo=true → 触发编排', async () => {
    const { scheduler, triggered } = build({ newConcepts: 10, canDo: true });
    const o = await scheduler.checkAndMaybeTrigger();
    assert.equal(o.result, 'triggered');
    assert.match(o.reason, /concept_threshold/);
    assert.equal(triggered.length, 1);
  });

  it('概念达阈 + canDo=false → 被风控拦截、不触发（红线：不静默假发布）', async () => {
    const { scheduler, triggered } = build({ newConcepts: 10, canDo: false, status: 'warned' });
    const o = await scheduler.checkAndMaybeTrigger();
    assert.equal(o.result, 'blocked');
    assert.equal(triggered.length, 0, '被拒时绝不调 orchestrator.trigger');
  });

  it('风控窗口（距上次发布≥24h 且 normal）+ canDo=true → 触发', async () => {
    const { scheduler, triggered } = build({ newConcepts: 0, lastPublishMs: T - 25 * HOUR, status: 'normal', canDo: true });
    const o = await scheduler.checkAndMaybeTrigger();
    assert.equal(o.result, 'triggered');
    assert.match(o.reason, /risk_window/);
    assert.equal(triggered.length, 1);
  });

  it('未达阈 + 窗口未到 → 跳过、不触发', async () => {
    const { scheduler, triggered } = build({ newConcepts: 1, lastPublishMs: T - 1 * HOUR });
    const o = await scheduler.checkAndMaybeTrigger();
    assert.equal(o.result, 'skipped');
    assert.equal(triggered.length, 0);
  });

  it('手动 /publish → 越过 canDo（canDo=false 仍触发，人工授权；人审在下游）', async () => {
    const { scheduler, triggered } = build({ newConcepts: 0, canDo: false, status: 'warned' });
    const o = await scheduler.triggerManual();
    assert.equal(o.result, 'triggered');
    assert.equal(o.reason, 'manual_feishu');
    assert.equal(triggered.length, 1, '手动越过风控仍触发编排');
  });

  it('buildTriggerInput 聚合真概念 + 真点赞 + 最近已发', async () => {
    const { scheduler } = build({ newConcepts: 3, lastPublishMs: T - 10 * HOUR });
    const input = await scheduler.buildTriggerInput();
    assert.deepEqual(input.generateInput.concepts.map((c) => c.keyword), ['LLM Agent', 'RAG']);
    assert.equal(input.generateInput.likedContents[0].id, 7);
    assert.equal(input.metrics.newConceptCount, 3);
    assert.equal(input.metrics.likedSinceLastPublish, 1);
    assert.deepEqual(input.recentPublished, ['上一篇']);
  });
});
