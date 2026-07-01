/**
 * PublishDispatcher（change decouple-publish-generation-from-dispatch）—— 下发段。
 * 由人审授权触发：复核授权 → 让位 → 从落库草稿重建发布输入 → 驱动序列 → 回写 → 解除让位。
 * 红线：未授权绝不下发；边缘离线诚实 failed 且不让位；忠于冻结草稿不重生成；幂等 + 按账号串行。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { PublishDispatcher } from '../../src/publish-agent/publish-dispatcher.js';
import type { DispatchDraft } from '../../src/publish-agent/publish-log-store.js';

const silentLogger = { log() {}, warn() {}, error() {} };

function makeDraft(over: Partial<DispatchDraft> = {}): DispatchDraft {
  return {
    recordId: 7,
    accountId: 'acct-A',
    title: 'vLLM 部署踩坑',
    content: '昨天试了 vLLM 跑 14B',
    imageUrl: 'https://example.com/a.png',
    imageUrls: ['https://example.com/a.png', 'https://example.com/b.png'],
    metadata: {
      topics: ['vLLM', '大模型部署'], mentions: [], location: null, collection: null,
      visibility: 'public', permissions: { comment: 'allow', save: 'allow' },
      mode: 'immediate', publishTime: null, compliance: {}, metadataScore: 0.5, decidedAt: 0,
    } as any,
    status: 'pending_approval',
    ...over,
  };
}

/** 可控 store/sequencer 桩，记录调用。 */
function harness(opts: {
  draft?: DispatchDraft | null;
  approved?: boolean;
  edgeId?: string | null;
  seqResult?: any;
}) {
  const events: string[] = [];
  let seqInput: any;
  const statusUpdates: Array<{ id: number; status: string }> = [];
  let postWrite: any;
  const attached: Array<{ id: number; count: number }> = [];
  const store = {
    loadForDispatch: async (_id: number) => (opts.draft === undefined ? makeDraft() : opts.draft),
    updateStatus: async (id: number, status: string) => { statusUpdates.push({ id, status }); events.push(`status:${status}`); },
    updatePostId: async (id: number, postId: string, postUrl?: string | null) => { postWrite = { id, postId, postUrl }; events.push('postId'); },
    markImagesAttached: async (id: number, count: number) => { attached.push({ id, count }); },
    listPendingApprovalIds: async () => (opts.draft && opts.draft.status === 'pending_approval' ? [opts.draft.recordId] : []),
  };
  const sequencer = {
    executePublishSequence: async (input: any) => {
      seqInput = input;
      events.push('seq');
      return opts.seqResult ?? { ok: true, attachedCount: 2, postId: 'post_real' };
    },
  };
  const dispatcher = new PublishDispatcher({
    store,
    sequencer,
    resolveEdgeIdForAccount: () => (opts.edgeId === undefined ? 'edge-A' : opts.edgeId),
    isApproved: async () => opts.approved ?? true,
    onPublishStart: () => events.push('start'),
    onPublishEnd: () => events.push('end'),
    logger: silentLogger,
  });
  return { dispatcher, events, get seqInput() { return seqInput; }, statusUpdates, get postWrite() { return postWrite; }, attached };
}

describe('PublishDispatcher', () => {
  test('已授权 + 在线边缘 → 让位→重建发布输入→驱动序列→回写 published→解除让位', async () => {
    const h = harness({ approved: true, edgeId: 'edge-A' });
    await h.dispatcher.dispatch(7);

    // 时序：让位先于序列，解除让位在序列之后。
    assert.deepEqual(h.events.filter((e) => ['start', 'seq', 'postId', 'end'].includes(e)), ['start', 'seq', 'postId', 'end']);
    // 重建：title/content 来自草稿；tags 来自 metadata.topics；多图来自 imageUrls 全集；本期不传 cover；edgeId 定向。
    assert.equal(h.seqInput.title, 'vLLM 部署踩坑');
    assert.deepEqual(h.seqInput.tags, ['vLLM', '大模型部署']);
    assert.deepEqual(h.seqInput.images, ['https://example.com/a.png', 'https://example.com/b.png'], '下发多图全集');
    assert.equal(h.seqInput.cover, undefined, '本期不传 cover（封面=首张上传=平台默认）');
    assert.equal(h.seqInput.edgeId, 'edge-A');
    assert.equal(h.seqInput.approvedByUser, true);
    assert.deepEqual(h.attached, [{ id: 7, count: 2 }], '如实标记真实附着数 K=2');
    assert.deepEqual(h.postWrite, { id: 7, postId: 'post_real', postUrl: undefined });
  });

  test('AC-PUB 红线：未授权 → 绝不让位、绝不驱动序列、不改态', async () => {
    const h = harness({ approved: false });
    await h.dispatcher.dispatch(7);
    assert.equal(h.events.includes('seq'), false, '未授权绝不驱动序列');
    assert.equal(h.events.includes('start'), false, '未授权不让位');
    assert.equal(h.statusUpdates.length, 0, '未授权不改态（仍待审）');
  });

  test('边缘离线 → 诚实 failed、不让位、不驱动序列', async () => {
    const h = harness({ approved: true, edgeId: null });
    await h.dispatcher.dispatch(7);
    assert.equal(h.events.includes('seq'), false, '离线不驱动序列');
    assert.equal(h.events.includes('start'), false, '离线不让位空转');
    assert.deepEqual(h.statusUpdates, [{ id: 7, status: 'failed' }], '离线诚实 failed');
  });

  test('幂等：已 published 草稿 → 跳过，不二次发布', async () => {
    const h = harness({ approved: true, draft: makeDraft({ status: 'published' }) });
    await h.dispatcher.dispatch(7);
    assert.equal(h.events.includes('seq'), false, '已发布不重发');
    assert.equal(h.events.includes('start'), false);
  });

  test('解除让位经唯一终止点：序列失败也调 onPublishEnd', async () => {
    const h = harness({ approved: true, edgeId: 'edge-A', seqResult: { ok: false, attachedCount: 0, failedAt: { seq: 5, kind: 'submit_publish', error: 'x' } } });
    await h.dispatcher.dispatch(7);
    assert.equal(h.events.includes('start'), true);
    assert.equal(h.events.includes('end'), true, '失败路径仍解除让位');
    assert.deepEqual(h.statusUpdates.at(-1), { id: 7, status: 'failed' }, '真失败如实 failed');
  });

  test('提交成功但未抓到 postId → updateStatus published（不误判 failed）', async () => {
    const h = harness({ approved: true, edgeId: 'edge-A', seqResult: { ok: true, attachedCount: 1 } });
    await h.dispatcher.dispatch(7);
    assert.deepEqual(h.statusUpdates.at(-1), { id: 7, status: 'published' });
  });

  test('草稿不存在 → 安静跳过', async () => {
    const h = harness({ approved: true, draft: null });
    await h.dispatcher.dispatch(7);
    assert.equal(h.events.length, 0);
  });

  test('兜底扫描：已授权待审草稿被补触发下发', async () => {
    const h = harness({ approved: true, edgeId: 'edge-A', draft: makeDraft({ status: 'pending_approval' }) });
    await h.dispatcher.scanAndDispatchApproved();
    assert.equal(h.events.includes('seq'), true, '兜底扫描补触发下发');
  });
});
