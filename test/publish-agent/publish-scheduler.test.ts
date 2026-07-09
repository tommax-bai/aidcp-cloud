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

/**
 * 键控单飞 + 容量帽（change parallel-rewrite-drafts / spec publish-generation-concurrency）。
 * 并行单位=参照稿：洗稿 rewrite:(account,source) 单飞、跨源可并行（含同账号）；自主 auto:(account) 单飞。
 * claim 检查与置位零 await 原子；finally 覆盖 buildTriggerInput 全程（DB 瞬错不卡键）。
 */
describe('claim 键控单飞与容量帽', () => {
  function buildConcurrent(opts: {
    pendingCap?: number;
    maxRuns?: number;
    dbPending?: number;
    conceptsThrow?: boolean;
  } = {}) {
    const gates: Array<() => void> = [];
    let releasing = false;
    const started: string[] = [];
    const deps: PublishSchedulerDeps = {
      conceptStore: {
        countNewSince: async () => {
          if (opts.conceptsThrow) throw new Error('PG transient error');
          return 0;
        },
        getNewConceptsSince: async () => [],
      },
      likedStore: { countSince: async () => 0, recentSince: async () => [] },
      publishLog: { getMostRecentPublishTime: async () => null, recentPublishedContents: async () => [] },
      resolveRisk: async () => ({ canDo: () => true, getState: () => ({ status: 'normal' }) }),
      resolveSingleAccountId: async () => 'acc-test',
      countPendingForAccount: async () => opts.dbPending ?? 0,
      pendingCapPerAccount: opts.pendingCap ?? 3,
      maxConcurrentRuns: opts.maxRuns ?? 2,
      orchestrator: {
        trigger: async (input) => {
          started.push(input.generateInput.referenceNote?.sourceId ?? `auto:${input.accountId}`);
          // 可控挂起：让轮次保持在跑，供并发/在途断言。releaseAll 先于本处执行时直接放行（防注册晚于释放挂死）。
          if (!releasing) await new Promise<void>((r) => gates.push(r));
          return { status: 'pending_approval' };
        },
      },
      soul: {} as PublishSchedulerDeps['soul'],
      clock: () => T,
      logger: silent,
    };
    const scheduler = new PublishScheduler(deps);
    const note = (sourceId: string) => ({ sourceId, title: 't', body: '正文', topics: [] as string[] });
    const releaseAll = () => { releasing = true; for (const g of gates.splice(0)) g(); };
    return { scheduler, started, note, releaseAll };
  }

  it('同键并发双触发恰一成功：第二发同步拒 duplicate_source', async () => {
    const { scheduler, note, releaseAll } = buildConcurrent();
    const a = scheduler.tryBeginRewrite('acc-test', note('src-1'));
    const b = scheduler.tryBeginRewrite('acc-test', note('src-1'));
    assert.equal(a.started, true);
    assert.equal(b.started, false);
    if (!b.started) assert.equal(b.reason, 'duplicate_source');
    releaseAll();
    if (a.started) await a.outcome;
  });

  it('同账号跨参照稿并行放行；全局帽满第三发拒 publish_busy', async () => {
    const { scheduler, started, note, releaseAll } = buildConcurrent({ maxRuns: 2, pendingCap: 10 });
    const a = scheduler.tryBeginRewrite('acc-test', note('src-1'));
    const b = scheduler.tryBeginRewrite('acc-test', note('src-2'));
    const c = scheduler.tryBeginRewrite('acc-test', note('src-3'));
    assert.equal(a.started && b.started, true, '跨源两轮并行放行');
    assert.equal(c.started, false);
    if (!c.started) assert.equal(c.reason, 'publish_busy', '全局帽满诚实拒绝');
    await new Promise((r) => setTimeout(r, 5));
    assert.deepEqual(started.sort(), ['src-1', 'src-2'], '两轮真的都在跑');
    releaseAll();
    if (a.started) await a.outcome;
    if (b.started) await b.outcome;
  });

  it('账号在途帽 = claim + DB 待审之和：dbPending 达帽即拒 publish_capacity（排期等全部入口同受此帽）', async () => {
    const { scheduler, note } = buildConcurrent({ pendingCap: 3, dbPending: 3 });
    const a = scheduler.tryBeginRewrite('acc-test', note('src-1'), { dbPendingCount: 3 });
    assert.equal(a.started, false);
    if (!a.started) assert.equal(a.reason, 'publish_capacity');
    // 自主入口（排期/飞书）同受帽约束：doTrigger 预取 dbPending=3 → capacity 拒绝、诚实 skipped。
    const o = await scheduler.triggerScheduled('acc-test');
    assert.equal(o.result, 'triggered');
    if (o.result === 'triggered') {
      assert.equal(o.status, 'skipped');
      assert.match(o.failureReason ?? '', /publish_capacity/);
    }
  });

  it('自主同账号二次触发 → skipped already_running（飞书 20s 重推去重语义保住）', async () => {
    const { scheduler, releaseAll } = buildConcurrent({ pendingCap: 10 });
    const p1 = scheduler.triggerManual('acc-test');
    await new Promise((r) => setTimeout(r, 5)); // 第一轮进入编排挂起
    const o2 = await scheduler.triggerManual('acc-test');
    assert.equal(o2.result, 'triggered');
    if (o2.result === 'triggered') {
      assert.equal(o2.status, 'skipped');
      assert.match(o2.failureReason ?? '', /已有一轮发帖编排在运行中/, '黄卡文案语义原样');
    }
    releaseAll();
    await p1;
  });

  it('isBusy 收窄为自主轮：洗稿在途不算忙（排期不让槽）、自主在途才算', async () => {
    const { scheduler, note, releaseAll } = buildConcurrent({ pendingCap: 10 });
    const a = scheduler.tryBeginRewrite('acc-test', note('src-1'));
    assert.equal(a.started, true);
    assert.equal(scheduler.isBusy('acc-test'), false, '洗稿在途不让排期槽');
    const p = scheduler.triggerManual('acc-test');
    await new Promise((r) => setTimeout(r, 5));
    assert.equal(scheduler.isBusy('acc-test'), true, '自主轮在跑才算忙');
    releaseAll();
    if (a.started) await a.outcome;
    await p;
  });

  it('brick 防线：buildTriggerInput 抛 PG 错误 → claim 于 finally 释放、同键立即可再触发', async () => {
    const { scheduler, note } = buildConcurrent({ conceptsThrow: true });
    const a = scheduler.tryBeginRewrite('acc-test', note('src-1'));
    assert.equal(a.started, true);
    if (a.started) await assert.rejects(a.outcome, /PG transient error/, '本轮诚实失败上抛');
    // 键已释放：立即重试不再是 duplicate_source（这次仍会抛，但 claim 层放行即证键未卡死）。
    const b = scheduler.tryBeginRewrite('acc-test', note('src-1'));
    assert.equal(b.started, true, 'DB 瞬错绝不把键永久卡死');
    if (b.started) await assert.rejects(b.outcome);
  });
});
