import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  createClientPublishApprovalHandler,
  type ClientPublishApprovalDeps,
} from '../../src/publish-agent/client-publish-approval.js';
import type { DispatchDraft, EditDraftResult } from '../../src/publish-agent/publish-log-store.js';
import type { PublishMetadata } from '../../src/publish-agent/types.js';

const NOW = Date.parse('2026-07-18T10:00:00+08:00');
const SCHEDULED_AT = NOW + 2 * 60 * 60 * 1000;

function metadata(mode: 'immediate' | 'scheduled' = 'immediate', publishTime: number | null = null): PublishMetadata {
  return {
    topics: ['Agent Memory'],
    mentions: [],
    location: null,
    collection: null,
    visibility: 'public',
    permissions: { comment: 'allow', save: 'allow' },
    mode,
    publishTime,
    decidedAt: NOW,
    compliance: {},
    metadataScore: 1,
  };
}

function draft(overrides: Partial<DispatchDraft> = {}): DispatchDraft {
  return {
    recordId: 42,
    accountId: 'account-1',
    platform: 'xiaohongshu',
    title: '工程 Wiki 的下一步是 Agent Memory',
    content: '正文',
    imageUrl: 'https://img/cover.jpg',
    imageUrls: ['https://img/cover.jpg'],
    metadata: metadata(),
    status: 'pending_approval',
    contentVersion: 3,
    ...overrides,
  };
}

function harness(overrides: Partial<ClientPublishApprovalDeps> = {}) {
  const calls = {
    order: [] as string[],
    edits: [] as unknown[],
    approvals: [] as unknown[],
    triggered: [] as string[],
    rejected: [] as string[],
  };
  const deps: ClientPublishApprovalDeps = {
    loadDraft: async () => draft(),
    readApproval: async () => null,
    editDraft: async (recordId, expectedVersion, patch, editor): Promise<EditDraftResult> => {
      calls.order.push('edit');
      calls.edits.push({ recordId, expectedVersion, patch, editor });
      return {
        ok: true,
        contentVersion: expectedVersion + 1,
        title: '工程 Wiki 的下一步是 Agent Memory',
        content: '正文',
        metadata: metadata(patch.publishMode as 'immediate' | 'scheduled', patch.publishTime ?? null),
        images: ['https://img/cover.jpg'],
      };
    },
    preflight: async () => {
      calls.order.push('preflight');
      return { ok: true };
    },
    writeApproval: async (requestId, approved, payload) => {
      calls.order.push('approval');
      calls.approvals.push({ requestId, approved, payload });
      return { written: true };
    },
    triggerApproved: (requestId) => calls.triggered.push(requestId),
    notifyRejected: (requestId) => calls.rejected.push(requestId),
    clock: () => NOW,
    ...overrides,
  };
  return { handle: createClientPublishApprovalHandler(deps), calls };
}

describe('客户端审批定时发布', () => {
  it('先通过预检，再 CAS 更新计划，审批签名绑定写后版本', async () => {
    const { handle, calls } = harness();
    const result = await handle({
      requestId: 'publish-42',
      approved: true,
      contentVersion: 3,
      publishMode: 'scheduled',
      publishTime: SCHEDULED_AT,
    }, 'account-1');

    assert.deepEqual(result, {
      requestId: 'publish-42',
      ok: true,
      state: 'approved',
      currentVersion: 4,
    });
    assert.deepEqual(calls.order, ['preflight', 'edit', 'approval']);
    assert.deepEqual(calls.edits, [{
      recordId: 42,
      expectedVersion: 3,
      patch: { publishMode: 'scheduled', publishTime: SCHEDULED_AT },
      editor: 'client',
    }]);
    assert.deepEqual(calls.approvals, [{
      requestId: 'publish-42',
      approved: true,
      payload: {
        title: '工程 Wiki 的下一步是 Agent Memory',
        content: '正文',
        tags: ['Agent Memory'],
        contentVersion: 4,
      },
    }]);
    assert.deepEqual(calls.triggered, ['publish-42']);
  });

  it('计划未改变时不写草稿版本，仍批准当前版本', async () => {
    const { handle, calls } = harness({
      loadDraft: async () => draft({ metadata: metadata('scheduled', SCHEDULED_AT) }),
    });
    const result = await handle({
      requestId: 'publish-42',
      approved: true,
      contentVersion: 3,
      publishMode: 'scheduled',
      publishTime: SCHEDULED_AT,
    }, 'account-1');

    assert.equal(result.ok, true);
    assert.equal(result.currentVersion, 3);
    assert.equal(calls.edits.length, 0);
    assert.deepEqual(calls.order, ['preflight', 'approval']);
  });

  it('可把已有定时计划改回立即发布，并让审批绑定新版本', async () => {
    const { handle, calls } = harness({
      loadDraft: async () => draft({ metadata: metadata('scheduled', SCHEDULED_AT) }),
    });
    const result = await handle({
      requestId: 'publish-42',
      approved: true,
      contentVersion: 3,
      publishMode: 'immediate',
      publishTime: null,
    }, 'account-1');

    assert.equal(result.ok, true);
    assert.equal(result.currentVersion, 4);
    assert.deepEqual(calls.edits, [{
      recordId: 42,
      expectedVersion: 3,
      patch: { publishMode: 'immediate', publishTime: null },
      editor: 'client',
    }]);
  });

  it('旧客户端不传发布计划时保持原计划，不触发编辑', async () => {
    const { handle, calls } = harness({
      loadDraft: async () => draft({ metadata: metadata('scheduled', SCHEDULED_AT) }),
    });
    const result = await handle({ requestId: 'publish-42', approved: true, contentVersion: 3 }, 'account-1');

    assert.equal(result.ok, true);
    assert.equal(calls.edits.length, 0);
    assert.deepEqual(calls.order, ['preflight', 'approval']);
  });

  it('时间越界时拒绝，既不改计划也不写审批', async () => {
    const { handle, calls } = harness();
    const result = await handle({
      requestId: 'publish-42',
      approved: true,
      contentVersion: 3,
      publishMode: 'scheduled',
      publishTime: NOW + 30 * 60 * 1000,
    }, 'account-1');

    assert.equal(result.reason, 'schedule_time_out_of_range');
    assert.equal(calls.edits.length, 0);
    assert.equal(calls.approvals.length, 0);
  });

  it('预检失败发生在计划 CAS 之前，不留下部分修改', async () => {
    const { handle, calls } = harness({ preflight: async () => ({ ok: false, reason: 'edge_offline' }) });
    const result = await handle({
      requestId: 'publish-42',
      approved: true,
      contentVersion: 3,
      publishMode: 'scheduled',
      publishTime: SCHEDULED_AT,
    }, 'account-1');

    assert.equal(result.reason, 'edge_offline');
    assert.equal(calls.edits.length, 0);
    assert.equal(calls.approvals.length, 0);
  });

  it('CAS 冲突回带活版本且不写审批', async () => {
    let loads = 0;
    const { handle, calls } = harness({
      loadDraft: async () => draft({ contentVersion: ++loads === 1 ? 3 : 5 }),
      editDraft: async () => ({ ok: false, reason: 'version_conflict' }),
    });
    const result = await handle({
      requestId: 'publish-42',
      approved: true,
      contentVersion: 3,
      publishMode: 'scheduled',
      publishTime: SCHEDULED_AT,
    }, 'account-1');

    assert.deepEqual(result, {
      requestId: 'publish-42',
      ok: false,
      reason: 'version_stale',
      currentVersion: 5,
    });
    assert.equal(calls.approvals.length, 0);
  });

  it('取消不接受发布计划，也不会执行预检或编辑', async () => {
    const { handle, calls } = harness();
    const result = await handle({
      requestId: 'publish-42',
      approved: false,
      publishMode: 'immediate',
      publishTime: null,
    }, 'account-1');

    assert.equal(result.reason, 'invalid_request');
    assert.deepEqual(calls.order, []);
  });

  it('内容版本已过期时在所有写操作前拒绝', async () => {
    const { handle, calls } = harness({ loadDraft: async () => draft({ contentVersion: 6 }) });
    const result = await handle({
      requestId: 'publish-42',
      approved: true,
      contentVersion: 3,
      publishMode: 'immediate',
      publishTime: null,
    }, 'account-1');

    assert.deepEqual(result, {
      requestId: 'publish-42',
      ok: false,
      reason: 'version_stale',
      currentVersion: 6,
    });
    assert.deepEqual(calls.order, []);
  });

  it('账号不匹配或稿件非待审时在预检与写入前拒绝', async () => {
    const mismatch = harness({ loadDraft: async () => draft({ accountId: 'account-2' }) });
    const mismatchResult = await mismatch.handle({
      requestId: 'publish-42', approved: true, contentVersion: 3,
      publishMode: 'immediate', publishTime: null,
    }, 'account-1');
    assert.equal(mismatchResult.reason, 'account_mismatch');
    assert.deepEqual(mismatch.calls.order, []);

    const notPending = harness({ loadDraft: async () => draft({ status: 'needs_review' }) });
    const notPendingResult = await notPending.handle({
      requestId: 'publish-42', approved: true, contentVersion: 3,
      publishMode: 'immediate', publishTime: null,
    }, 'account-1');
    assert.equal(notPendingResult.reason, 'not_pending');
    assert.deepEqual(notPending.calls.order, []);
  });
});
