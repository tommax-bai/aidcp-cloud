import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { InteractionStore } from '../../src/interactions/interaction-store.js';
import { InteractionInboxService } from '../../src/interactions/interaction-inbox-service.js';
import { InteractionMetrics } from '../../src/interactions/metrics.js';
import type { ReplyConfigStore } from '../../src/interactions/reply-config-store.js';
import type { ReplyWorkflow } from '../../src/interactions/reply-workflow.js';
import type { InteractionReplyResultPayload } from '../../src/interactions/types.js';

/**
 * 幂等占位的释放判据 = 「**有没有写成**」，不是「策略允不允许」（change risk-record-actuated-facts）。
 *
 * 这段代码跑在 `status === 'confirmed'` 下——**平台已确认这条回复发出去了**。`record()` 现在无条件写入
 * 既成事实、其返回值只答「在不在策略内」。若照旧按返回值释放占位，重放会**再写一次** ⇒ 真实重复计数。
 *
 * **这个文件存在的理由**（对抗性复核 2026-07-17 用注入实验坐实）：把该 bug 原样种回去
 * （`if (!withinPolicy) await releaseRiskRecordClaim(...)`），typecheck 干净、验收 55/55、全量 2443 全绿
 * ——**这个 change 存在的意义那条回归，此前静悄悄地绿着过**。`dm_reply` 三档配额都是 0
 * ⇒ `canDo('dm_reply')` 恒 false ⇒ 这条路**每一次**都会踩到，不是边角。
 */

const payload: InteractionReplyResultPayload = {
  envKey: 'env-a',
  accountId: 'acct-a',
  platform: 'wechat_channels',
  channel: 'dm',
  jobId: 'job-a',
  attemptId: 'attempt-a',
  status: 'confirmed',
  errorCode: null,
  observedAt: 1,
} as unknown as InteractionReplyResultPayload;

function makeService(recordImpl: () => Promise<boolean>, opts: { hasController?: boolean } = {}) {
  const released: string[] = [];
  let claimed = 0;
  const store = {
    applyReplyResult: async () => ({ duplicate: false, confirmedNeedsRiskRecord: true }),
    getJobContext: async () => null,
    noteSendOutcome: async () => {},
    claimRiskRecord: async () => { claimed += 1; return true; },
    releaseRiskRecordClaim: async (attemptId: string) => { released.push(attemptId); },
  } as unknown as InteractionStore;

  const metrics = new InteractionMetrics();
  const statuses: string[] = [];
  const originalIncrement = metrics.increment.bind(metrics);
  metrics.increment = ((name: string, labels?: Record<string, string>) => {
    if (name === 'interaction_risk_record_total' && labels?.status) statuses.push(labels.status);
    return originalIncrement(name, labels);
  }) as typeof metrics.increment;

  const svc = new InteractionInboxService({
    store,
    workflow: {} as unknown as ReplyWorkflow,
    configs: {} as unknown as ReplyConfigStore,
    controllerFor: () => (opts.hasController === false ? undefined : { record: recordImpl }),
    metrics,
  } as unknown as ConstructorParameters<typeof InteractionInboxService>[0]);

  return { svc, released, statuses, claimed: () => claimed };
}

test('策略拒绝（超配额）：写已经发生 ⇒ 占位绝不释放（否则重放重复计数）', async () => {
  // dm_reply 配额恒 0 ⇒ record 恒返 false，但它**已经把这条已确认发出的回复记下了**。
  const { svc, released, statuses } = makeService(async () => false);
  await svc.onReplyResult(payload);
  assert.deepEqual(released, [], '返 false 只表示「超策略」，不表示「没记下」——释放占位会让重放再记一次');
  assert.deepEqual(statuses, ['recorded_over_policy'], '如实标注：记下了、但超策略');
});

test('策略允许：占位保留，记为 recorded', async () => {
  const { svc, released, statuses } = makeService(async () => true);
  await svc.onReplyResult(payload);
  assert.deepEqual(released, []);
  assert.deepEqual(statuses, ['recorded']);
});

test('真抛错（如 PG 故障）：什么都没写成 ⇒ 释放占位、留给重放', async () => {
  const { svc, released, statuses } = makeService(async () => { throw new Error('pg down'); });
  await svc.onReplyResult(payload);
  assert.deepEqual(released, ['attempt-a'], '这才是真故障：写没发生，占位必须放回去');
  assert.deepEqual(statuses, ['failed'], '与「策略拒绝」是两回事——此前二者被收敛成同一处理、下游分不出');
});

test('拿不到 controller：什么都没写成 ⇒ 同样释放占位', async () => {
  const { svc, released, statuses } = makeService(async () => true, { hasController: false });
  await svc.onReplyResult(payload);
  assert.deepEqual(released, ['attempt-a']);
  assert.deepEqual(statuses, ['failed']);
});
