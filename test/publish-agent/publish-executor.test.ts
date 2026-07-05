/**
 * PublishExecutorRole（change decouple-publish-generation-from-dispatch）。
 * 生成候审段出口：只「落库待审草稿（pending_approval）+ 发飞书审批卡」即返回，
 * 不再内联等审、不再驱动序列、不再解析边缘（这些都属下发段 PublishDispatcher）。
 * 保留红线：无配图 → 诚实 failed、不发卡；真血缘 + 元数据落库 + aiEnforced 审计；标题忠实。
 *
 * change split-topic-roles：话题唯一真源 = publishMetadata.topics（finalTags 已恒空）；
 * executor 的 waitAll 新增 publishMetadata，卡/落库 tags 均取 publishMetadata.topics。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { PublishExecutorRole } from '../../src/publish-agent/roles/publish-executor.js';
import { PipelineContext } from '../../src/publish-agent/pipeline-context.js';
import type { PipelineFields, AssembledContent, GateDecision, TitleSelection } from '../../src/publish-agent/types.js';

const clock = () => 1700000000000;
const silentLogger = { log() {}, warn() {}, error() {} };

function makeTitleSelection(title = 'vLLM 部署踩坑'): TitleSelection {
  return { title, source: 'llm', decidedAt: 1700000000000 };
}

function makeAssembledContent(): AssembledContent {
  return {
    finalContent: '昨天试了 vLLM 跑 14B，显存直接爆了',
    // change split-topic-roles：finalTags 恒空；话题真源为 publishMetadata.topics。
    finalTags: [],
    imageUrls: ['https://example.com/a.png', 'https://example.com/b.png'],
    imageUrl: 'https://example.com/a.png',
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

/** change split-topic-roles：话题真源。默认 topics 刻意 ≠ finalTags，以证明 tags 取自 topics。 */
function makePublishMetadata(topics: string[] = ['话题甲', '话题乙']): any {
  return {
    topics, mentions: [], location: null, collection: null,
    visibility: 'public', permissions: { comment: 'allow', save: 'allow' },
    mode: 'immediate', publishTime: null,
    compliance: { ai: true, aiEnforced: false }, metadataScore: 0.6, decidedAt: 0,
  };
}

describe('PublishExecutorRole（生成候审段出口）', () => {
  test('auto_publish → 落库 pending_approval + 发审批卡，不下发、不驱动序列；tags 取 publishMetadata.topics', async () => {
    const insertedRecords: any[] = [];
    const sentCards: any[] = [];
    const role = new PublishExecutorRole({
      store: { insert: async (r: any) => { insertedRecords.push(r); return 42; } },
      messenger: { sendApprovalCard: async (_c: string, card: any) => { sentCards.push(card); } },
      botChatStore: { getDefaultChat: async () => ({ chatId: 'chat-1' }) },
      clock,
      logger: silentLogger,
    });

    const ctx = new PipelineContext<PipelineFields>();
    ctx.write('assembledContent', makeAssembledContent());
    ctx.write('titleSelection', makeTitleSelection());
    ctx.write('publishMetadata', makePublishMetadata());
    role.register(ctx);
    ctx.write('gateDecision', makeGateDecision('auto_publish'));

    await new Promise((r) => setTimeout(r, 50));

    const result = ctx.get('publishResult');
    assert.equal(result?.recordId, 42);
    assert.equal(result?.status, 'pending_approval', '生成候审段产物为待审草稿');
    assert.equal(result?.dispatched, false, '生成候审段不下发边缘');
    assert.equal(result?.envelope, null);
    assert.equal(insertedRecords.length, 1);
    assert.equal(insertedRecords[0].status, 'pending_approval');
    assert.match(insertedRecords[0].content, /vLLM/);
    assert.deepEqual(insertedRecords[0].tags, ['话题甲', '话题乙'], 'tags 取 publishMetadata.topics（非 finalTags）');
    assert.deepEqual(insertedRecords[0].images, ['https://example.com/a.png', 'https://example.com/b.png'], '多图全集随草稿落库（下发段读回）');
    // 审批卡是「已构建的 FeishuCard」（含 elements），requestId=publish-<recordId>。
    assert.equal(sentCards.length, 1, '应发审批卡');
    assert.ok(Array.isArray(sentCards[0]?.elements), '须为已构建卡片');
    assert.ok(JSON.stringify(sentCards[0]).includes('话题甲'), '审批卡话题取自 publishMetadata.topics');
  });

  test('manual_review → 同 auto_publish：落库 pending_approval + 发审批卡（人审为常态闸）', async () => {
    const insertedRecords: any[] = [];
    const sentCards: any[] = [];
    const role = new PublishExecutorRole({
      store: { insert: async (r: any) => { insertedRecords.push(r); return 99; } },
      messenger: { sendApprovalCard: async (_c: string, card: any) => { sentCards.push(card); } },
      botChatStore: { getDefaultChat: async () => ({ chatId: 'chat-1' }) },
      clock,
      logger: silentLogger,
    });

    const ctx = new PipelineContext<PipelineFields>();
    ctx.write('assembledContent', makeAssembledContent());
    ctx.write('titleSelection', makeTitleSelection());
    ctx.write('publishMetadata', makePublishMetadata());
    role.register(ctx);
    ctx.write('gateDecision', makeGateDecision('manual_review'));

    await new Promise((r) => setTimeout(r, 50));

    const result = ctx.get('publishResult');
    assert.equal(result?.recordId, 99);
    assert.equal(result?.status, 'pending_approval');
    assert.equal(insertedRecords[0].status, 'pending_approval');
    assert.equal(sentCards.length, 1);
  });

  test('abort → 落库 status=failed、不发卡；tags 仍取 publishMetadata.topics', async () => {
    const insertedRecords: any[] = [];
    const sentCards: any[] = [];
    const role = new PublishExecutorRole({
      store: { insert: async (r: any) => { insertedRecords.push(r); return 77; } },
      messenger: { sendApprovalCard: async (_c: string, card: any) => { sentCards.push(card); } },
      botChatStore: { getDefaultChat: async () => ({ chatId: 'c' }) },
      clock,
      logger: silentLogger,
    });

    const ctx = new PipelineContext<PipelineFields>();
    ctx.write('assembledContent', makeAssembledContent());
    ctx.write('titleSelection', makeTitleSelection());
    ctx.write('publishMetadata', makePublishMetadata(['风险话题']));
    role.register(ctx);
    ctx.write('gateDecision', makeGateDecision('abort'));

    await new Promise((r) => setTimeout(r, 50));

    const result = ctx.get('publishResult');
    assert.equal(result?.recordId, 77);
    assert.equal(result?.status, 'failed');
    assert.equal(insertedRecords[0].status, 'failed');
    assert.deepEqual(insertedRecords[0].tags, ['风险话题'], 'abort 落库 tags 也取 publishMetadata.topics');
    assert.equal(sentCards.length, 0, 'abort 不发审批卡');
  });

  test('真血缘落库 + publishMetadata 落库 + aiEnforced 审计（供下发段重建）；tags == topics', async () => {
    const insertedRecords: any[] = [];
    const recordedMeta: any[] = [];
    const role = new PublishExecutorRole({
      store: {
        insert: async (r: any) => { insertedRecords.push(r); return 7; },
        recordMetadata: async (id: number, metadata: any, aiEnforced: boolean) => { recordedMeta.push({ id, metadata, aiEnforced }); },
      },
      messenger: { sendApprovalCard: async () => {} },
      botChatStore: { getDefaultChat: async () => ({ chatId: 'c' }) },
      clock,
      logger: silentLogger,
    });

    const ctx = new PipelineContext<PipelineFields>();
    ctx.write('assembledContent', makeAssembledContent());
    ctx.write('titleSelection', makeTitleSelection());
    ctx.write('trigger', {
      metrics: { hoursSinceLastPublish: 30, newConceptCount: 2, likedSinceLastPublish: 1 },
      generateInput: {
        concepts: [{ keyword: 'RAG 重排' }, { keyword: 'vLLM' }],
        likedContents: [{ id: 11, title: 'RAG', summary: 's', author: 'a' }],
        referenceNote: {
          sourceId: 'note-42',
          title: '来源标题',
          body: 'prompt 片段',
          topics: ['来源话题'],
          author: '来源作者',
          images: [
            { index: 0, sourceUrl: 'https://ref.test/1.webp', captureStatus: 'stored' },
            { index: 1, sourceUrl: 'https://ref.test/2.webp', ossUrl: 'https://oss.test/2.webp', captureStatus: 'stored' },
          ],
          sourceReference: {
            kind: 'curated_reference',
            curatedContentId: 7,
            accountId: 'acc-1',
            sourceId: 'note-42',
            title: '来源标题',
            body: '完整来稿正文，不应被 prompt 截断影响',
            author: '来源作者',
            topics: ['来源话题'],
            sourceUrl: 'https://www.xiaohongshu.com/explore/note-42?xsec_token=tok',
            capturedAt: 1699999999000,
          },
        },
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
    ctx.write('imageDirective', {
      imagePrompt: 'prompt',
      imageUrls: ['https://example.com/a.png', 'https://example.com/b.png'],
      imageUrl: 'https://example.com/a.png',
      imageStyle: null,
      fallbackStrategy: 'skip',
      referenceImageStatus: 'unsupported',
      directedAt: 0,
    });
    role.register(ctx);
    ctx.write('gateDecision', makeGateDecision('auto_publish'));

    await new Promise((r) => setTimeout(r, 50));

    assert.equal(ctx.get('publishResult')?.status, 'pending_approval');
    assert.deepEqual(insertedRecords[0].sourceConcepts, ['RAG 重排', 'vLLM']);
    assert.deepEqual(insertedRecords[0].sourceLikedIds, [11]);
    assert.equal(insertedRecords[0].sourceReference?.curatedContentId, 7);
    assert.equal(insertedRecords[0].sourceReference?.body, '完整来稿正文，不应被 prompt 截断影响');
    assert.equal(insertedRecords[0].sourceReference?.sourceUrl, 'https://www.xiaohongshu.com/explore/note-42?xsec_token=tok');
    assert.deepEqual(insertedRecords[0].tags, ['RAG'], '落库 tags == publishMetadata.topics');
    assert.equal(recordedMeta.length, 1);
    assert.equal(recordedMeta[0].aiEnforced, true, 'aiEnforced 审计如实落库');
    assert.deepEqual(recordedMeta[0].metadata.referenceImageAudit, {
      requestedCount: 2,
      usableCount: 2,
      status: 'unsupported',
      providerClaimedUsed: false,
      generatedCount: 2,
    });
  });

  test('参考图 provider 返回 used → publishMetadata.referenceImageAudit 标记 providerClaimedUsed=true', async () => {
    const recordedMeta: any[] = [];
    const role = new PublishExecutorRole({
      store: {
        insert: async () => 8,
        recordMetadata: async (id: number, metadata: any, aiEnforced: boolean) => { recordedMeta.push({ id, metadata, aiEnforced }); },
      },
      clock,
      logger: silentLogger,
    });

    const ctx = new PipelineContext<PipelineFields>();
    ctx.write('assembledContent', {
      ...makeAssembledContent(),
      imageUrls: ['https://example.com/a.png'],
      imageUrl: 'https://example.com/a.png',
    });
    ctx.write('titleSelection', makeTitleSelection());
    ctx.write('trigger', {
      metrics: { hoursSinceLastPublish: 30, newConceptCount: 1, likedSinceLastPublish: 0 },
      generateInput: {
        concepts: [],
        likedContents: [],
        referenceNote: {
          sourceId: 'note-used',
          title: '来源标题',
          body: '来源正文',
          topics: [],
          images: [{ index: 0, sourceUrl: 'https://ref.test/used.webp', captureStatus: 'stored' }],
        },
        soul: {} as any,
        recentPosts: [],
      },
      recentPublished: [],
    } as any);
    ctx.write('publishMetadata', makePublishMetadata());
    ctx.write('imageDirective', {
      imagePrompt: 'prompt',
      imageUrls: ['https://example.com/a.png'],
      imageUrl: 'https://example.com/a.png',
      imageStyle: null,
      fallbackStrategy: 'skip',
      referenceImageStatus: 'used',
      directedAt: 0,
    });
    role.register(ctx);
    ctx.write('gateDecision', makeGateDecision('auto_publish'));

    await new Promise((r) => setTimeout(r, 50));

    assert.deepEqual(recordedMeta[0].metadata.referenceImageAudit, {
      requestedCount: 1,
      usableCount: 1,
      status: 'used',
      providerClaimedUsed: true,
      generatedCount: 1,
    });
  });

  test('无 reference images → publishMetadata 不伪造 referenceImageAudit', async () => {
    const recordedMeta: any[] = [];
    const role = new PublishExecutorRole({
      store: {
        insert: async () => 9,
        recordMetadata: async (_id: number, metadata: any) => { recordedMeta.push(metadata); },
      },
      clock,
      logger: silentLogger,
    });

    const ctx = new PipelineContext<PipelineFields>();
    ctx.write('assembledContent', makeAssembledContent());
    ctx.write('titleSelection', makeTitleSelection());
    ctx.write('publishMetadata', makePublishMetadata());
    role.register(ctx);
    ctx.write('gateDecision', makeGateDecision('auto_publish'));

    await new Promise((r) => setTimeout(r, 50));

    assert.equal(recordedMeta[0].referenceImageAudit, undefined);
  });

  test('AC-IMG-REQUIRED 无配图（imageUrls 空）→ 诚实 failed、不发卡、不落待审、markImagesAttached(0)', async () => {
    const insertedRecords: any[] = [];
    const attached: Array<{ id: number; count: number }> = [];
    const sentCards: any[] = [];
    const role = new PublishExecutorRole({
      store: {
        insert: async (r: any) => { insertedRecords.push(r); return 21; },
        markImagesAttached: async (id: number, count: number) => { attached.push({ id, count }); },
      },
      messenger: { sendApprovalCard: async (_c: string, card: any) => { sentCards.push(card); } },
      botChatStore: { getDefaultChat: async () => ({ chatId: 'c' }) },
      clock,
      logger: silentLogger,
    });

    const ctx = new PipelineContext<PipelineFields>();
    ctx.write('assembledContent', { ...makeAssembledContent(), imageUrls: [], imageUrl: null });
    ctx.write('titleSelection', makeTitleSelection());
    ctx.write('publishMetadata', makePublishMetadata());
    role.register(ctx);
    ctx.write('gateDecision', makeGateDecision('auto_publish'));

    await new Promise((r) => setTimeout(r, 60));

    const result = ctx.get('publishResult');
    assert.equal(result?.status, 'failed', '无图（M=0）→ 诚实 failed');
    assert.equal(result?.dispatched, false);
    assert.equal(sentCards.length, 0, '无图 → 不发审批卡（不让人审注定失败的图文帖）');
    assert.equal(insertedRecords.length, 1);
    assert.equal(insertedRecords[0].status, 'failed');
    assert.deepEqual(attached, [{ id: 21, count: 0 }], 'markImagesAttached(0)');
  });

  test('AC-TITLE-GATE 发布门 waitAll：titleSelection 未写 → executor 不激活、不落库', async () => {
    const insertedRecords: any[] = [];
    const role = new PublishExecutorRole({
      store: { insert: async (r: any) => { insertedRecords.push(r); return 1; } },
      clock,
      logger: silentLogger,
    });

    const ctx = new PipelineContext<PipelineFields>();
    ctx.write('assembledContent', makeAssembledContent());
    ctx.write('publishMetadata', makePublishMetadata());
    role.register(ctx);
    ctx.write('gateDecision', makeGateDecision('auto_publish')); // 故意不写 titleSelection

    await new Promise((r) => setTimeout(r, 50));

    assert.equal(ctx.get('publishResult'), undefined, '缺 titleSelection → waitAll 不满足 → 不激活');
    assert.equal(insertedRecords.length, 0, '未激活则不落库');
  });

  test('change split-topic-roles 发布门 waitAll：publishMetadata 未写 → executor 不激活（不早于 publishMetadata 触发）', async () => {
    const insertedRecords: any[] = [];
    const role = new PublishExecutorRole({
      store: { insert: async (r: any) => { insertedRecords.push(r); return 1; } },
      clock,
      logger: silentLogger,
    });

    const ctx = new PipelineContext<PipelineFields>();
    ctx.write('assembledContent', makeAssembledContent());
    ctx.write('titleSelection', makeTitleSelection());
    role.register(ctx);
    ctx.write('gateDecision', makeGateDecision('auto_publish')); // 故意不写 publishMetadata

    await new Promise((r) => setTimeout(r, 50));
    assert.equal(ctx.get('publishResult'), undefined, '缺 publishMetadata → waitAll 不满足 → 不激活');
    assert.equal(insertedRecords.length, 0);

    // 补写 publishMetadata → waitAll 满足 → 激活落库。
    ctx.write('publishMetadata', makePublishMetadata());
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(ctx.get('publishResult')?.status, 'pending_approval', '补齐 publishMetadata 后激活');
    assert.equal(insertedRecords.length, 1);
  });

  test('AC-TITLE-FIDELITY 落库标题 == titleSelection.title，审批卡含该标题', async () => {
    const insertedRecords: any[] = [];
    const sentCards: any[] = [];
    const role = new PublishExecutorRole({
      store: { insert: async (r: any) => { insertedRecords.push(r); return 3; } },
      messenger: { sendApprovalCard: async (_c: string, card: any) => { sentCards.push(card); } },
      botChatStore: { getDefaultChat: async () => ({ chatId: 'c' }) },
      clock,
      logger: silentLogger,
    });

    const TITLE = 'RAG 别再无脑上向量库';
    const ctx = new PipelineContext<PipelineFields>();
    ctx.write('assembledContent', makeAssembledContent());
    ctx.write('titleSelection', makeTitleSelection(TITLE));
    ctx.write('publishMetadata', makePublishMetadata());
    role.register(ctx);
    ctx.write('gateDecision', makeGateDecision('auto_publish'));

    await new Promise((r) => setTimeout(r, 60));

    assert.equal(insertedRecords[0].title, TITLE, 'DB 落库标题 == titleSelection.title');
    assert.ok(JSON.stringify(sentCards[0]).includes(TITLE), '审批卡含真实标题');
  });
});
