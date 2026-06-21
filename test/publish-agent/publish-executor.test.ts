import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { PublishExecutorRole } from '../../src/publish-agent/roles/publish-executor.js';
import { PipelineContext } from '../../src/publish-agent/pipeline-context.js';
import type { PipelineFields, AssembledContent, GateDecision } from '../../src/publish-agent/types.js';

const clock = () => 1700000000000;
const silentLogger = { log() {}, warn() {}, error() {} };

function makeAssembledContent(): AssembledContent {
  return {
    finalContent: '昨天试了 vLLM 跑 14B，显存直接爆了',
    finalTags: ['vLLM', '大模型部署'],
    imageUrl: 'https://example.com/img.png',
    aiScore: 0.1,
    qualityScore: 80,
    rewritten: false,
    flaggedPhrases: [],
    assembledAt: 1700000000000,
  };
}

function makeGateDecision(action: GateDecision['recommendedAction']): GateDecision {
  return {
    needsApproval: action === 'manual_review',
    recommendedAction: action,
    reason: 'test reason',
    decidedAt: 1700000000000,
  };
}

describe('PublishExecutorRole', () => {
  test('auto_publish → 调用 store.insert + pusher.pushToEdges', async () => {
    const insertedRecords: any[] = [];
    const pushedEnvelopes: any[] = [];
    const fakeStore = {
      insert: async (record: any) => { insertedRecords.push(record); return 42; },
    };
    const fakePusher = {
      pushToEdges: (envelope: any, edgeId?: string) => { pushedEnvelopes.push({ envelope, edgeId }); return 1; },
    };

    const role = new PublishExecutorRole({
      store: fakeStore,
      pusher: fakePusher,
      idGen: () => 'test-env-001',
      clock,
      logger: silentLogger,
    });

    const ctx = new PipelineContext<PipelineFields>();
    ctx.write('assembledContent', makeAssembledContent());
    role.register(ctx);
    ctx.write('gateDecision', makeGateDecision('auto_publish'));

    await new Promise(r => setTimeout(r, 50));

    const result = ctx.get('publishResult');
    assert.ok(result);
    assert.equal(result.recordId, 42);
    assert.equal(result.status, 'draft');
    assert.equal(result.dispatched, true);
    assert.ok(result.envelope);

    // 验证 store.insert 参数
    assert.equal(insertedRecords.length, 1);
    assert.equal(insertedRecords[0].status, 'draft');
    assert.match(insertedRecords[0].content, /vLLM/);

    // 验证 pusher 被调用
    assert.equal(pushedEnvelopes.length, 1);
    assert.equal(pushedEnvelopes[0].envelope.type, 'publish.request');
    assert.equal(pushedEnvelopes[0].envelope.id, 'test-env-001');
  });

  test('stage-4 指令驱动：真血缘落库 + publishMetadata 落库/穿透 sequencer + 已授权回写 published', async () => {
    const insertedRecords: any[] = [];
    const recordedMeta: any[] = [];
    let updatedPostId: { id: number; postId: string } | undefined;
    let seqInput: any;
    const fakeStore = {
      insert: async (record: any) => { insertedRecords.push(record); return 7; },
      updateStatus: async () => {},
      updatePostId: async (id: number, postId: string) => { updatedPostId = { id, postId }; },
      recordMetadata: async (id: number, metadata: any, aiEnforced: boolean) => { recordedMeta.push({ id, metadata, aiEnforced }); },
    };
    const fakeSequencer = {
      executePublishSequence: async (input: any) => { seqInput = input; return { ok: true, postId: 'post_real_1' }; },
    } as any;

    const role = new PublishExecutorRole({
      store: fakeStore,
      pusher: { pushToEdges: () => 1 },
      sequencer: fakeSequencer,
      isApproved: async () => true,
      clock,
      logger: silentLogger,
    });

    const ctx = new PipelineContext<PipelineFields>();
    ctx.write('assembledContent', makeAssembledContent());
    ctx.write('trigger', {
      metrics: { hoursSinceLastPublish: 30, newConceptCount: 2, likedSinceLastPublish: 1 },
      generateInput: {
        concepts: [{ keyword: 'RAG 重排' }, { keyword: 'vLLM' }],
        likedContents: [{ id: 11, title: 'RAG', summary: 's', author: 'a' }],
        soul: {} as any,
        recentPosts: [],
      },
      recentPublished: [],
    } as any);
    ctx.write('publishMetadata', {
      topics: ['RAG'], mentions: [], location: null, collection: null,
      visibility: 'public', permissions: { comment: 'allow', save: 'allow' },
      mode: 'immediate', publishTime: null, compliance: { ai: true, aiEnforced: true }, metadataScore: 0.6, decidedAt: 0,
    } as any);
    role.register(ctx);
    ctx.write('gateDecision', makeGateDecision('auto_publish'));

    await new Promise((r) => setTimeout(r, 50));

    const result = ctx.get('publishResult');
    assert.equal(result?.status, 'published');
    // 真血缘：sourceConcepts 来自 trigger 概念、sourceLikedIds 来自真实点赞 id（不再写死 []）
    assert.deepEqual(insertedRecords[0].sourceConcepts, ['RAG 重排', 'vLLM']);
    assert.deepEqual(insertedRecords[0].sourceLikedIds, [11]);
    // publishMetadata 落库 + 防篡改审计（aiEnforced=true）
    assert.equal(recordedMeta.length, 1);
    assert.equal(recordedMeta[0].aiEnforced, true);
    // metadata 穿透给 sequencer
    assert.equal(seqInput.metadata.visibility, 'public');
    assert.equal(seqInput.approvedByUser, true);
    // 回写 postId → published
    assert.deepEqual(updatedPostId, { id: 7, postId: 'post_real_1' });
  });

  test('manual_review → 调用 store.insert + messenger.sendApprovalCard', async () => {
    const insertedRecords: any[] = [];
    const sentCards: any[] = [];
    const fakeStore = {
      insert: async (record: any) => { insertedRecords.push(record); return 99; },
    };
    const fakePusher = {
      pushToEdges: () => 0,
    };
    const fakeMessenger = {
      sendApprovalCard: async (chatId: string, card: any) => { sentCards.push({ chatId, card }); },
    };
    const fakeBotChatStore = {
      getDefaultChat: async () => ({ chatId: 'chat-123' }),
    };

    const role = new PublishExecutorRole({
      store: fakeStore,
      pusher: fakePusher,
      messenger: fakeMessenger,
      botChatStore: fakeBotChatStore,
      idGen: () => 'test-env-002',
      clock,
      logger: silentLogger,
    });

    const ctx = new PipelineContext<PipelineFields>();
    ctx.write('assembledContent', makeAssembledContent());
    role.register(ctx);
    ctx.write('gateDecision', makeGateDecision('manual_review'));

    await new Promise(r => setTimeout(r, 50));

    const result = ctx.get('publishResult');
    assert.ok(result);
    assert.equal(result.recordId, 99);
    assert.equal(result.status, 'needs_review');
    assert.equal(result.dispatched, false);
    assert.equal(result.envelope, null);

    // 验证 store.insert 参数
    assert.equal(insertedRecords.length, 1);
    assert.equal(insertedRecords[0].status, 'needs_review');

    // 验证 messenger 被调用
    assert.equal(sentCards.length, 1);
    assert.equal(sentCards[0].chatId, 'chat-123');
    assert.equal(sentCards[0].card.recordId, 99);
  });

  test('abort → 调用 store.insert(status=failed)', async () => {
    const insertedRecords: any[] = [];
    const fakeStore = {
      insert: async (record: any) => { insertedRecords.push(record); return 77; },
    };
    const fakePusher = {
      pushToEdges: () => 0,
    };

    const role = new PublishExecutorRole({
      store: fakeStore,
      pusher: fakePusher,
      idGen: () => 'test-env-003',
      clock,
      logger: silentLogger,
    });

    const ctx = new PipelineContext<PipelineFields>();
    ctx.write('assembledContent', makeAssembledContent());
    role.register(ctx);
    ctx.write('gateDecision', makeGateDecision('abort'));

    await new Promise(r => setTimeout(r, 50));

    const result = ctx.get('publishResult');
    assert.ok(result);
    assert.equal(result.recordId, 77);
    assert.equal(result.status, 'failed');
    assert.equal(result.dispatched, false);
    assert.equal(result.envelope, null);

    // 验证 store.insert 参数
    assert.equal(insertedRecords.length, 1);
    assert.equal(insertedRecords[0].status, 'failed');
  });

  test('AC-PUB executor 闸：审批窗内始终未授权 → needs_review 且绝不驱动序列（红线：未授权不发布）', async () => {
    let seqCalls = 0;
    const fakeStore = {
      insert: async () => 5,
      updateStatus: async () => {},
    };
    const fakeSequencer = {
      executePublishSequence: async () => { seqCalls++; return { ok: true, imagesOk: true, postId: 'x' }; },
    } as any;

    const sentCards: any[] = [];
    const role = new PublishExecutorRole({
      store: fakeStore,
      pusher: { pushToEdges: () => 0 },
      sequencer: fakeSequencer,
      messenger: { sendApprovalCard: async (_c: string, card: any) => { sentCards.push(card); } },
      botChatStore: { getDefaultChat: async () => ({ chatId: 'c' }) },
      isApproved: async () => false, // 始终未授权
      approvalWaitMs: 40, // 小窗口快速超时（用真实 clock）
      approvalPollMs: 5,
      logger: silentLogger,
    });

    const ctx = new PipelineContext<PipelineFields>();
    ctx.write('assembledContent', makeAssembledContent());
    role.register(ctx);
    ctx.write('gateDecision', makeGateDecision('auto_publish'));

    await new Promise((r) => setTimeout(r, 120));

    const result = ctx.get('publishResult');
    assert.equal(result?.status, 'needs_review');
    assert.equal(result?.dispatched, false);
    assert.equal(seqCalls, 0, '未授权 executor 闸：绝不调 executePublishSequence');
    // 发的是"已构建的交互式卡片"（有 elements），不是原始数据对象（飞书发原始对象会 400）。
    assert.equal(sentCards.length, 1, '应发审批卡');
    assert.ok(Array.isArray(sentCards[0]?.elements), '审批卡须为已构建的 FeishuCard（含 elements），非原始数据对象');
  });

  test('AC-PUB executor 闸：发卡后人审通过 → 驱动序列 + published（发布所审的那份内容）', async () => {
    let approveCalls = 0;
    let seqInput: any;
    const sentCards: any[] = [];
    const fakeStore = {
      insert: async () => 8,
      updateStatus: async () => {},
      updatePostId: async () => {},
      markImagesAttached: async () => {},
    };
    const fakeSequencer = {
      executePublishSequence: async (input: any) => { seqInput = input; return { ok: true, imagesOk: true, postId: 'post_ok' }; },
    } as any;

    const role = new PublishExecutorRole({
      store: fakeStore,
      pusher: { pushToEdges: () => 1 },
      sequencer: fakeSequencer,
      messenger: { sendApprovalCard: async (_c: string, card: any) => { sentCards.push(card); } },
      botChatStore: { getDefaultChat: async () => ({ chatId: 'c' }) },
      // 初次检查 + 前一次轮询未授权，之后人审通过。
      isApproved: async () => (++approveCalls >= 3),
      approvalWaitMs: 1000,
      approvalPollMs: 5,
      logger: silentLogger,
    });

    const ctx = new PipelineContext<PipelineFields>();
    ctx.write('assembledContent', makeAssembledContent());
    role.register(ctx);
    ctx.write('gateDecision', makeGateDecision('auto_publish'));

    await new Promise((r) => setTimeout(r, 200));

    const result = ctx.get('publishResult');
    assert.equal(result?.status, 'published', '人审通过后应驱动序列并 published');
    assert.equal(sentCards.length, 1, '应先发审批卡');
    assert.ok(seqInput, '人审通过后应驱动 executePublishSequence');
    assert.equal(seqInput.approvedByUser, true);
  });

  test('AC-MEDIA 图文全图失败 → status=failed 且 executor 标 markImagesAttached(false)（落库回正，杜绝有图假信号）', async () => {
    const attached: Array<{ id: number; a: boolean }> = [];
    const fakeStore = {
      insert: async () => 9,
      updateStatus: async () => {},
      updatePostId: async () => {},
      markImagesAttached: async (id: number, a: boolean) => { attached.push({ id, a }); },
    };
    // 图文编辑器被传图门控：全图失败 → sequencer 诚实 ok:false（imagesOk:false），无有效帖。
    const fakeSequencer = {
      executePublishSequence: async () => ({ ok: false, imagesOk: false, failedAt: { seq: 2, kind: 'upload_image', error: 'all_images_failed' } }),
    } as any;

    const role = new PublishExecutorRole({
      store: fakeStore,
      pusher: { pushToEdges: () => 1 },
      sequencer: fakeSequencer,
      isApproved: async () => true,
      clock,
      logger: silentLogger,
    });

    const ctx = new PipelineContext<PipelineFields>();
    ctx.write('assembledContent', makeAssembledContent()); // 含 imageUrl → hadImage=true
    role.register(ctx);
    ctx.write('gateDecision', makeGateDecision('auto_publish'));

    await new Promise((r) => setTimeout(r, 50));

    assert.deepEqual(attached, [{ id: 9, a: false }], '请求了配图但失败 → images_attached=false（即便整帖 failed 也回正）');
    const result = ctx.get('publishResult');
    assert.equal(result?.status, 'failed', '图文无图 → 诚实 failed');
  });
});
