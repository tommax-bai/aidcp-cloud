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
  /** 编排器返回的终态（缺省 'draft' 正常）；用于模拟 failed/skipped 等非正常出口。 */
  orchestratorStatus?: string;
  /** 编排器返回的非正常原因（failed/skipped 时填，验证沿链路 surface）。 */
  orchestratorReason?: string;
  personaBound?: boolean;
}

function build(k: Knobs = {}) {
  const triggered: string[] = [];
  const inputs: any[] = [];
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
    resolveRisk: async () => ({ canDo: () => k.canDo ?? true, getState: () => ({ status: k.status ?? 'normal' }) }),
    resolveSingleAccountId: async () => 'acc-test',
    isPersonaBound: k.personaBound === undefined ? undefined : () => k.personaBound === true,
    orchestrator: { trigger: async (input) => { triggered.push(JSON.stringify(input.metrics)); inputs.push(input); return { status: k.orchestratorStatus ?? 'draft', reason: k.orchestratorReason }; } },
    soul: {} as PublishSchedulerDeps['soul'],
    conceptThreshold: k.conceptThreshold ?? 5,
    minHoursBetween: k.minHoursBetween ?? 24,
    clock: () => T,
    logger: silent,
  };
  return { scheduler: new PublishScheduler(deps), triggered, inputs };
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

  it('手动 /publish 编排失败 → 触发但 status=failed，并把编排失败原因沿链路 surface 为 failureReason', async () => {
    const { scheduler } = build({ orchestratorStatus: 'failed', orchestratorReason: 'Pipeline aborted by TitleCreator: 标题解析失败' });
    const o = await scheduler.triggerManual('acc-test');
    assert.equal(o.result, 'triggered');
    assert.equal(o.result === 'triggered' && o.status, 'failed');
    assert.equal(o.result === 'triggered' && o.failureReason, 'Pipeline aborted by TitleCreator: 标题解析失败', '失败原因不再被丢，供飞书回执显示「为什么」');
  });

  it('手动 /publish 未绑人设 → 拒绝 needs_persona_setup，绝不以默认人设发布（不触发编排）', async () => {
    const { scheduler, triggered } = build({ newConcepts: 10, canDo: true, personaBound: false });
    const o = await scheduler.triggerManual('acc-test');
    assert.equal(o.result, 'blocked');
    assert.equal(o.reason, 'needs_persona_setup');
    assert.equal(triggered.length, 0, '未绑人设绝不调 orchestrator.trigger');
  });

  it('自动扳机未绑人设 → 拒绝 needs_persona_setup，不触发', async () => {
    const { scheduler, triggered } = build({ newConcepts: 10, canDo: true, personaBound: false });
    const o = await scheduler.checkAndMaybeTrigger();
    assert.equal(o.result, 'blocked');
    assert.equal(o.reason, 'needs_persona_setup');
    assert.equal(triggered.length, 0);
  });

  it('绑人设账号 → 人设闸放行，正常触发', async () => {
    const { scheduler, triggered } = build({ newConcepts: 10, canDo: true, personaBound: true });
    const o = await scheduler.checkAndMaybeTrigger();
    assert.equal(o.result, 'triggered');
    assert.equal(triggered.length, 1);
  });

  it('buildTriggerInput 聚合真概念 + 真点赞 + 最近已发', async () => {
    const { scheduler } = build({ newConcepts: 3, lastPublishMs: T - 10 * HOUR });
    const input = await scheduler.buildTriggerInput('acc-test');
    assert.deepEqual(input.generateInput.concepts.map((c) => c.keyword), ['LLM Agent', 'RAG']);
    assert.equal(input.generateInput.likedContents[0].id, 7);
    assert.equal(input.metrics.newConceptCount, 3);
    assert.equal(input.metrics.likedSinceLastPublish, 1);
    assert.deepEqual(input.recentPublished, ['上一篇']);
  });

  it('手动 /publish 可携带审批卡目标 chatId 到 TriggerInput', async () => {
    const { scheduler, inputs } = build({ newConcepts: 0 });
    const o = await scheduler.triggerManual('acc-test', { manualApprovalChatId: 'chat-private' });
    assert.equal(o.result, 'triggered');
    assert.equal(inputs[0].manualApprovalChatId, 'chat-private');
  });

  it('自动/排期触发不携带手动审批卡目标 chatId', async () => {
    const auto = build({ newConcepts: 10, canDo: true });
    await auto.scheduler.checkAndMaybeTrigger();
    assert.equal(auto.inputs[0].manualApprovalChatId, undefined);

    const scheduled = build({ newConcepts: 0, canDo: true });
    await scheduled.scheduler.triggerScheduled('acc-test');
    assert.equal(scheduled.inputs[0].manualApprovalChatId, undefined);
  });
});
