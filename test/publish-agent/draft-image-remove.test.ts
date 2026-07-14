/**
 * 客户端预览删配图闸序（change client-preview-image-delete）。
 * 重点守两条红线：账号归属（租户隔离）与最后一张不可删（M=0 会被下发段判 failed）。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  createPublishDraftImageRemoveHandler,
  type DraftImageRemoveDeps,
} from '../../src/publish-agent/draft-image-remove.js';
import type { DispatchDraft, EditDraftResult } from '../../src/publish-agent/publish-log-store.js';

const IMGS = ['https://o/a.jpg', 'https://o/b.jpg', 'https://o/c.jpg'];

function draft(over: Partial<DispatchDraft> = {}): DispatchDraft {
  return {
    recordId: 89,
    accountId: 'acc-1',
    title: 't',
    content: 'c',
    imageUrl: IMGS[0],
    imageUrls: [...IMGS],
    metadata: null,
    status: 'pending_approval',
    contentVersion: 0,
    ...over,
  } as DispatchDraft;
}

function harness(over: Partial<DraftImageRemoveDeps> = {}) {
  const calls: { editDraft: unknown[]; refreshed: number[] } = { editDraft: [], refreshed: [] };
  const deps: DraftImageRemoveDeps = {
    loadDraft: async () => draft(),
    readApproval: async () => null,
    editDraft: async (recordId, expectedVersion, patch, editor) => {
      calls.editDraft.push({ recordId, expectedVersion, patch, editor });
      const kept = patch.images ?? [];
      return { ok: true, contentVersion: expectedVersion + 1, title: 't', content: 'c', metadata: null, images: kept };
    },
    readLiveVersion: async () => null,
    refreshPreview: (recordId) => calls.refreshed.push(recordId),
    logger: { warn: () => {} },
    ...over,
  };
  return { handle: createPublishDraftImageRemoveHandler(deps), calls };
}

const OK_PAYLOAD = { requestId: 'publish-89', contentVersion: 0, imageUrl: IMGS[1] };
const SESSION = { accountId: 'acc-1' };

describe('客户端删配图 — 成功路径', () => {
  it('删中间一张：保留子集由云端算出、保序、经既有 editDraft 落库、回带写后真态', async () => {
    const { handle, calls } = harness();
    const res = await handle(OK_PAYLOAD, SESSION);

    assert.equal(res.ok, true);
    assert.deepEqual(res.images, [IMGS[0], IMGS[2]]);
    assert.equal(res.contentVersion, 1); // content_version + 1 → 旧飞书卡失效
    assert.deepEqual(calls.editDraft, [
      { recordId: 89, expectedVersion: 0, patch: { images: [IMGS[0], IMGS[2]] }, editor: 'edge-client:acc-1' },
    ]);
    assert.deepEqual(calls.refreshed, [89]); // best-effort 重推预览
  });

  it('删封面（第一张）：保留列表首项成为新封面（由 editDraft 重算）', async () => {
    const { handle, calls } = harness();
    const res = await handle({ ...OK_PAYLOAD, imageUrl: IMGS[0] }, SESSION);

    assert.equal(res.ok, true);
    assert.deepEqual(res.images, [IMGS[1], IMGS[2]]);
    assert.deepEqual((calls.editDraft[0] as { patch: { images: string[] } }).patch.images, [IMGS[1], IMGS[2]]);
  });
});

describe('客户端删配图 — 红线', () => {
  it('账号归属：草稿不属于握手会话账号 → account_mismatch，绝不落库', async () => {
    const { handle, calls } = harness({ loadDraft: async () => draft({ accountId: 'acc-other' }) });
    const res = await handle(OK_PAYLOAD, SESSION);

    assert.deepEqual(res, { requestId: 'publish-89', ok: false, reason: 'account_mismatch' });
    assert.equal(calls.editDraft.length, 0);
  });

  it('最后一张不可删 → last_image，配图与版本不变（M=0 会被下发段判 failed）', async () => {
    const { handle, calls } = harness({ loadDraft: async () => draft({ imageUrls: [IMGS[0]] }) });
    const res = await handle({ ...OK_PAYLOAD, imageUrl: IMGS[0] }, SESSION);

    assert.deepEqual(res, { requestId: 'publish-89', ok: false, reason: 'last_image' });
    assert.equal(calls.editDraft.length, 0);
  });

  it('只删不注入：待删 URL 非当前成员 → image_not_found，绝不落库', async () => {
    const { handle, calls } = harness();
    const res = await handle({ ...OK_PAYLOAD, imageUrl: 'https://evil/x.jpg' }, SESSION);

    assert.deepEqual(res, { requestId: 'publish-89', ok: false, reason: 'image_not_found' });
    assert.equal(calls.editDraft.length, 0);
  });

  it('版本过期 → version_stale 并回带库内活版本（审=发）', async () => {
    const { handle, calls } = harness({ loadDraft: async () => draft({ contentVersion: 2 }) });
    const res = await handle(OK_PAYLOAD, SESSION);

    assert.deepEqual(res, { requestId: 'publish-89', ok: false, reason: 'version_stale', currentVersion: 2 });
    assert.equal(calls.editDraft.length, 0);
  });

  it('审批签名已落 → already_decided，内容不可再改', async () => {
    const { handle, calls } = harness({ readApproval: async () => ({ approved: true }) });
    const res = await handle(OK_PAYLOAD, SESSION);

    assert.deepEqual(res, { requestId: 'publish-89', ok: false, reason: 'already_decided' });
    assert.equal(calls.editDraft.length, 0);
  });

  it('非待审草稿 → not_pending', async () => {
    const { handle } = harness({ loadDraft: async () => draft({ status: 'published' }) });
    const res = await handle(OK_PAYLOAD, SESSION);
    assert.equal(res.reason, 'not_pending');
  });

  it('记录不存在 → not_found', async () => {
    const { handle } = harness({ loadDraft: async () => null });
    const res = await handle(OK_PAYLOAD, SESSION);
    assert.equal(res.reason, 'not_found');
  });

  it('会话无账号 → account_unavailable', async () => {
    const { handle } = harness();
    const res = await handle(OK_PAYLOAD, {});
    assert.equal(res.reason, 'account_unavailable');
  });

  it('入参不合法（坏 requestId / 空 URL / 非整数版本）→ invalid_request', async () => {
    const { handle, calls } = harness();
    for (const bad of [
      { requestId: 'edge-abc', contentVersion: 0, imageUrl: IMGS[0] },
      { requestId: 'publish-89', contentVersion: 0, imageUrl: '' },
      { requestId: 'publish-89', contentVersion: -1, imageUrl: IMGS[0] },
      { requestId: 'publish-89', contentVersion: 1.5, imageUrl: IMGS[0] },
    ]) {
      const res = await handle(bad as never, SESSION);
      assert.equal(res.reason, 'invalid_request', JSON.stringify(bad));
    }
    assert.equal(calls.editDraft.length, 0);
  });
});

describe('客户端删配图 — 事务内复检（TOCTOU 兜底）拒因映射', () => {
  it('editDraft 回 version_conflict → version_stale + 回带活版本', async () => {
    const { handle } = harness({
      editDraft: async (): Promise<EditDraftResult> => ({ ok: false, reason: 'version_conflict' }),
      readLiveVersion: async () => 3,
    });
    const res = await handle(OK_PAYLOAD, SESSION);
    assert.deepEqual(res, { requestId: 'publish-89', ok: false, reason: 'version_stale', currentVersion: 3 });
  });

  it('editDraft 回 invalid_field（非成员）→ image_not_found', async () => {
    const { handle } = harness({
      editDraft: async (): Promise<EditDraftResult> => ({ ok: false, reason: 'invalid_field' }),
    });
    const res = await handle(OK_PAYLOAD, SESSION);
    assert.equal(res.reason, 'image_not_found');
  });

  it('落库抛错 → 诚实 store_unavailable，MUST NOT 假成功', async () => {
    const { handle, calls } = harness({
      editDraft: async () => {
        throw new Error('pg down');
      },
    });
    const res = await handle(OK_PAYLOAD, SESSION);
    assert.deepEqual(res, { requestId: 'publish-89', ok: false, reason: 'store_unavailable' });
    assert.deepEqual(calls.refreshed, []); // 失败不重推预览
  });
});
