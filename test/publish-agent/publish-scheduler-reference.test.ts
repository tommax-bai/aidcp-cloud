/**
 * PublishScheduler 洗稿参照注入单测（change curated-note-actions）。
 * 覆盖：referenceNote 透传进 TriggerInput.generateInput（含正文 ≤800 字截断）、
 * 空正文参照触发即 blocked empty_body（不调编排）、无参照路径不带字段（向后兼容 /publish）。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { PublishScheduler, REFERENCE_BODY_MAX_LEN } from '../../src/publish-agent/publish-scheduler.js';
import type { PublishSchedulerDeps, ReferenceNote } from '../../src/publish-agent/publish-scheduler.js';
import type { TriggerInput } from '../../src/publish-agent/types.js';

const T = 1700000000000;
const silent = { log() {}, warn() {}, error() {} };

function build() {
  const inputs: TriggerInput[] = [];
  const deps: PublishSchedulerDeps = {
    conceptStore: {
      countNewSince: async () => 0,
      getNewConceptsSince: async () => [],
    },
    likedStore: { countSince: async () => 0, recentSince: async () => [] },
    publishLog: { getMostRecentPublishTime: async () => null, recentPublishedContents: async () => [] },
    resolveRisk: async () => ({ canDo: () => true, getState: () => ({ status: 'normal' }) }),
    resolveSingleAccountId: async () => 'acc-test',
    orchestrator: {
      trigger: async (input) => {
        inputs.push(input);
        return { status: 'pending_approval' };
      },
    },
    soul: {} as PublishSchedulerDeps['soul'],
    conceptThreshold: 5,
    minHoursBetween: 24,
    clock: () => T,
    logger: silent,
  };
  return { scheduler: new PublishScheduler(deps), inputs };
}

const ref: ReferenceNote = {
  sourceId: 'note-42',
  title: '好用的收纳技巧',
  body: '正文'.repeat(1000), // 2000 字 > 800 上限
  topics: ['收纳', '家居'],
  author: '博主甲',
  curatedContentId: 7,
  accountId: 'acc-test',
  sourceUrl: 'https://www.xiaohongshu.com/explore/note-42?xsec_token=tok',
  capturedAt: T - 1,
};

describe('triggerManual referenceNote（洗稿参照）', () => {
  it('参照透传进 generateInput.referenceNote，正文截 ≤800 字，forced=true，reason=manual_reference', async () => {
    const { scheduler, inputs } = build();
    const o = await scheduler.triggerManual('acc-test', { referenceNote: ref });
    assert.equal(o.result, 'triggered');
    assert.equal(o.reason, 'manual_reference');
    assert.equal(inputs.length, 1);
    const got = inputs[0].generateInput.referenceNote;
    assert.ok(got, 'referenceNote 应透传');
    assert.equal(got.sourceId, 'note-42');
    assert.equal(got.title, '好用的收纳技巧');
    assert.equal(got.body.length, REFERENCE_BODY_MAX_LEN); // 有界截断，防全文直灌
    assert.deepEqual(got.topics, ['收纳', '家居']);
    assert.equal(got.sourceReference?.curatedContentId, 7);
    assert.equal(got.sourceReference?.sourceUrl, 'https://www.xiaohongshu.com/explore/note-42?xsec_token=tok');
    assert.equal(got.sourceReference?.body, ref.body, '展示/审计快照保留触发时完整正文，不使用 prompt 截断片段');
    assert.equal(got.sourceReference?.capturedAt, T - 1);
    assert.equal(inputs[0].forced, true); // 人工触发不被 scout 否决
  });

  it('参照正文为空 → blocked empty_body，绝不调编排（空参照红线）', async () => {
    const { scheduler, inputs } = build();
    const o = await scheduler.triggerManual('acc-test', { referenceNote: { ...ref, body: '   ' } });
    assert.equal(o.result, 'blocked');
    assert.equal(o.reason, 'empty_body');
    assert.equal(inputs.length, 0);
  });

  it('无参照（既有 /publish 路径）→ 不带 referenceNote 字段、reason=manual_feishu（向后兼容）', async () => {
    const { scheduler, inputs } = build();
    const o = await scheduler.triggerManual('acc-test');
    assert.equal(o.result, 'triggered');
    assert.equal(o.reason, 'manual_feishu');
    assert.equal(inputs[0].generateInput.referenceNote, undefined);
  });

  it('阅读旁路参照创作可标记 reason=read_reference', async () => {
    const { scheduler, inputs } = build();
    const o = await scheduler.triggerManual('acc-test', { referenceNote: ref, reason: 'read_reference' });
    assert.equal(o.result, 'triggered');
    assert.equal(o.reason, 'read_reference');
    assert.equal(inputs.length, 1);
    assert.equal(inputs[0].generateInput.referenceNote?.sourceId, 'note-42');
  });

  it('未绑人设时参照创作同样被人设闸拒绝（与 /publish 同口径）', async () => {
    const gated = new PublishScheduler({
      conceptStore: { countNewSince: async () => 0, getNewConceptsSince: async () => [] },
      likedStore: { countSince: async () => 0, recentSince: async () => [] },
      publishLog: { getMostRecentPublishTime: async () => null, recentPublishedContents: async () => [] },
      resolveRisk: async () => ({ canDo: () => true, getState: () => ({ status: 'normal' }) }),
      resolveSingleAccountId: async () => 'acc-test',
      isPersonaBound: () => false,
      orchestrator: { trigger: async () => ({ status: 'draft' }) },
      soul: {} as PublishSchedulerDeps['soul'],
      conceptThreshold: 5,
      minHoursBetween: 24,
      clock: () => T,
      logger: silent,
    });
    const o = await gated.triggerManual('acc-test', { referenceNote: ref });
    assert.equal(o.result, 'blocked');
    assert.equal(o.reason, 'needs_persona_setup');
  });
});
