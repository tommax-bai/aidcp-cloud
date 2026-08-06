import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ScheduledPublishReconciler } from '@automation/publish-agent/scheduled-publish-reconciler.js';
import type { ScheduledPublishRecord } from '@api/publish-agent/publish-log-store.js';

const silentLogger = { log() {}, warn() {}, error() {} };
const NOW = 1_800_000_000_000;

function record(overrides: Partial<ScheduledPublishRecord> = {}): ScheduledPublishRecord {
  return {
    recordId: 17,
    accountId: 'acct-xhs',
    title: '定时稿标题',
    scheduledAt: NOW - 10 * 60_000,
    scheduledPlatformId: 'scheduled-internal-17',
    reconcileAttempts: 0,
    ...overrides,
  };
}

function leasePort() {
  return {
    withLease: async (_request: unknown, work: (lease: { taskId: string }) => Promise<unknown>) => work({ taskId: 'lease-reconcile-1' }),
  } as any;
}

describe('ScheduledPublishReconciler', () => {
  it('公开身份确认后 CAS 记账；重复扫描 CAS=false 不会重复占用发布次数', async () => {
    const candidate = record();
    let first = true;
    let confirmations = 0;
    const counted: string[] = [];
    const reconcileInputs: unknown[] = [];
    const reconciler = new ScheduledPublishReconciler({
      store: {
        listDueScheduled: async () => [candidate],
        deferScheduledReconcile: async () => null,
        confirmScheduledPublished: async (_id, postId, postUrl) => {
          confirmations++;
          assert.equal(postId, 'public-post-17');
          assert.equal(postUrl, 'https://www.xiaohongshu.com/explore/public-post-17?xsec_token=token');
          const result = first;
          first = false;
          return result;
        },
      },
      sequencer: {
        executeScheduledReconciliation: async (input) => {
          reconcileInputs.push(input);
          return {
            state: 'published' as const,
            postId: 'public-post-17',
            postUrl: 'https://www.xiaohongshu.com/explore/public-post-17?xsec_token=token',
          };
        },
      },
      edgeTaskLeases: leasePort(),
      resolveEdgeIdForAccount: () => 'edge-xhs',
      recordPublish: async (accountId) => { counted.push(accountId); },
      clock: () => NOW,
      logger: silentLogger,
    });

    assert.equal(await reconciler.tick(), 1);
    assert.equal(await reconciler.tick(), 1);
    assert.equal(confirmations, 2);
    assert.equal(reconcileInputs.length, 2);
    assert.deepEqual(counted, ['acct-xhs']);
  });

  it('仍在定时列表时按有界退避延期，不伪造公开 postId', async () => {
    const deferred: Array<{ id: number; error: string; nextAt: number; maxAttempts: number }> = [];
    const reconciler = new ScheduledPublishReconciler({
      store: {
        listDueScheduled: async () => [record()],
        deferScheduledReconcile: async (id, error, nextAt, maxAttempts) => {
          deferred.push({ id, error, nextAt, maxAttempts: maxAttempts ?? 8 });
          return { status: 'scheduled', attempts: 1 };
        },
        confirmScheduledPublished: async () => { throw new Error('must_not_confirm'); },
      },
      sequencer: {
        executeScheduledReconciliation: async () => ({ state: 'pending', error: 'scheduled_pending' }),
      },
      edgeTaskLeases: leasePort(),
      resolveEdgeIdForAccount: () => 'edge-xhs',
      clock: () => NOW,
      maxAttempts: 8,
      logger: silentLogger,
    });

    assert.equal(await reconciler.tick(), 1);
    assert.deepEqual(deferred, [{ id: 17, error: 'scheduled_pending', nextAt: NOW + 15 * 60_000, maxAttempts: 8 }]);
  });

  it('边缘离线时只延期对账，不下发新发布命令', async () => {
    let sequencerCalls = 0;
    const errors: string[] = [];
    const reconciler = new ScheduledPublishReconciler({
      store: {
        listDueScheduled: async () => [record({ reconcileAttempts: 2 })],
        deferScheduledReconcile: async (_id, error) => {
          errors.push(error);
          return { status: 'scheduled', attempts: 3 };
        },
        confirmScheduledPublished: async () => false,
      },
      sequencer: {
        executeScheduledReconciliation: async () => {
          sequencerCalls++;
          return { state: 'pending', error: 'unexpected' };
        },
      },
      edgeTaskLeases: leasePort(),
      resolveEdgeIdForAccount: () => null,
      clock: () => NOW,
      logger: silentLogger,
    });

    assert.equal(await reconciler.tick(), 1);
    assert.equal(sequencerCalls, 0);
    assert.deepEqual(errors, ['scheduled_reconcile_edge_offline']);
  });
});
