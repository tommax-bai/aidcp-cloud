import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FirstPostOnboardingCoordinator } from '../../src/onboarding/first-post-onboarding-coordinator.js';
import type { CuratedSourceAdmission } from '../../src/cache/curated-content-store.js';

const source: CuratedSourceAdmission = {
  accountId: 'acc-1',
  contentType: 'image_text',
  sourceId: 'note-1',
  title: '上升话题',
  body: '目标人群正在关注的正文',
  author: '作者甲',
  sourceUrl: 'https://example.test/note-1',
  topics: ['趋势'],
  referenceImages: [],
};

test('首条精选命中后复用参照创作，产出待确认作品才完成首作状态', async () => {
  const events: string[] = [];
  let received: Record<string, unknown> | undefined;
  const coordinator = new FirstPostOnboardingCoordinator({
    store: {
      claim: async () => { events.push('claim'); return true; },
      release: async () => { events.push('release'); return true; },
      complete: async () => { events.push('complete'); return true; },
    },
    countPendingForAccount: async () => 0,
    beginRewrite: (accountId, referenceNote, options) => {
      received = { accountId, referenceNote, options };
      return {
        started: true,
        outcome: Promise.resolve({ result: 'triggered', reason: 'reference_rewrite', status: 'pending_approval' }),
      };
    },
    onStateChanged: () => { events.push('state'); },
    logger: { log: () => {}, warn: () => {} },
  });

  await coordinator.onSourceAdmitted(source);

  assert.deepEqual(events, ['claim', 'state', 'complete', 'state']);
  assert.equal(received?.accountId, 'acc-1');
  const note = received?.referenceNote as { sourceId: string; body: string; topics: string[] };
  assert.equal(note.sourceId, 'note-1');
  assert.equal(note.body, '目标人群正在关注的正文');
  assert.deepEqual(note.topics, ['趋势']);
});

test('参照创作未开始或未产出作品时释放状态，允许后续真实精选重试', async () => {
  const releases: string[] = [];
  const coordinator = new FirstPostOnboardingCoordinator({
    store: {
      claim: async () => true,
      release: async (_accountId, _sourceId, reason) => { releases.push(reason); return true; },
      complete: async () => { throw new Error('must not complete'); },
    },
    countPendingForAccount: async () => 3,
    beginRewrite: () => ({ started: false, reason: 'publish_capacity' }),
    logger: { log: () => {}, warn: () => {} },
  });

  await coordinator.onSourceAdmitted(source);
  assert.deepEqual(releases, ['claim_rejected:publish_capacity']);
});

test('并发精选只有拿到原子 claim 的一条会触发参照创作', async () => {
  let beginCalls = 0;
  const coordinator = new FirstPostOnboardingCoordinator({
    store: {
      claim: async (_accountId, sourceId) => sourceId === 'note-1',
      release: async () => true,
      complete: async () => true,
    },
    countPendingForAccount: async () => 0,
    beginRewrite: () => {
      beginCalls += 1;
      return { started: true, outcome: Promise.resolve({ result: 'triggered', reason: 'reference_rewrite', status: 'draft' }) };
    },
    logger: { log: () => {}, warn: () => {} },
  });

  await Promise.all([
    coordinator.onSourceAdmitted(source),
    coordinator.onSourceAdmitted({ ...source, sourceId: 'note-2' }),
  ]);
  assert.equal(beginCalls, 1);
});
