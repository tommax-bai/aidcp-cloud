/**
 * PublishExecutorRole（change decouple-publish-generation-from-dispatch）。
 * 生成候审段出口：只「落库待审草稿（pending_approval）+ 发飞书审批卡」即返回，
 * 不再内联等审、不再驱动序列、不再解析边缘（这些都属下发段 PublishDispatcher）。
 * 保留红线：无配图 → 诚实 failed、不发卡；真血缘 + 元数据落库 + aiEnforced 审计；标题忠实。
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

describe('PublishExecutorRole（生成候审段出口）', () => {
  test('auto_publish → 落库 pending_approval + 发审批卡，不下发、不驱动序列', async () => {
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
    // 审批卡是「已构建的 FeishuCard」（含 elements），requestId=publish-<recordId>。
    assert.equal(sentCards.length, 1, '应发审批卡');
    assert.ok(Array.isArray(sentCards[0]?.elements), '须为已构建卡片');
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
    role.register(ctx);
    ctx.write('gateDecision', makeGateDecision('manual_review'));

    await new Promise((r) => setTimeout(r, 50));

    const result = ctx.get('publishResult');
    assert.equal(result?.recordId, 99);
    assert.equal(result?.status, 'pending_approval');
    assert.equal(insertedRecords[0].status, 'pending_approval');
    assert.equal(sentCards.length, 1);
  });

  test('abort → 落库 status=failed、不发卡', async () => {
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
    role.register(ctx);
    ctx.write('gateDecision', makeGateDecision('abort'));

    await new Promise((r) => setTimeout(r, 50));

    const result = ctx.get('publishResult');
    assert.equal(result?.recordId, 77);
    assert.equal(result?.status, 'failed');
    assert.equal(insertedRecords[0].status, 'failed');
    assert.equal(sentCards.length, 0, 'abort 不发审批卡');
  });

  test('真血缘落库 + publishMetadata 落库 + aiEnforced 审计（供下发段重建）', async () => {
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

    assert.equal(ctx.get('publishResult')?.status, 'pending_approval');
    assert.deepEqual(insertedRecords[0].sourceConcepts, ['RAG 重排', 'vLLM']);
    assert.deepEqual(insertedRecords[0].sourceLikedIds, [11]);
    assert.equal(recordedMeta.length, 1);
    assert.equal(recordedMeta[0].aiEnforced, true, 'aiEnforced 审计如实落库');
  });

  test('AC-IMG-REQUIRED 无配图（imageUrl=null）→ 诚实 failed、不发卡、不落待审、markImagesAttached(false)', async () => {
    const insertedRecords: any[] = [];
    const attached: Array<{ id: number; a: boolean }> = [];
    const sentCards: any[] = [];
    const role = new PublishExecutorRole({
      store: {
        insert: async (r: any) => { insertedRecords.push(r); return 21; },
        markImagesAttached: async (id: number, a: boolean) => { attached.push({ id, a }); },
      },
      messenger: { sendApprovalCard: async (_c: string, card: any) => { sentCards.push(card); } },
      botChatStore: { getDefaultChat: async () => ({ chatId: 'c' }) },
      clock,
      logger: silentLogger,
    });

    const ctx = new PipelineContext<PipelineFields>();
    ctx.write('assembledContent', { ...makeAssembledContent(), imageUrl: null });
    ctx.write('titleSelection', makeTitleSelection());
    role.register(ctx);
    ctx.write('gateDecision', makeGateDecision('auto_publish'));

    await new Promise((r) => setTimeout(r, 60));

    const result = ctx.get('publishResult');
    assert.equal(result?.status, 'failed', '无图 → 诚实 failed');
    assert.equal(result?.dispatched, false);
    assert.equal(sentCards.length, 0, '无图 → 不发审批卡（不让人审注定失败的图文帖）');
    assert.equal(insertedRecords.length, 1);
    assert.equal(insertedRecords[0].status, 'failed');
    assert.deepEqual(attached, [{ id: 21, a: false }], 'markImagesAttached(false)');
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
    role.register(ctx);
    ctx.write('gateDecision', makeGateDecision('auto_publish')); // 故意不写 titleSelection

    await new Promise((r) => setTimeout(r, 50));

    assert.equal(ctx.get('publishResult'), undefined, '缺 titleSelection → waitAll 不满足 → 不激活');
    assert.equal(insertedRecords.length, 0, '未激活则不落库');
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
    role.register(ctx);
    ctx.write('gateDecision', makeGateDecision('auto_publish'));

    await new Promise((r) => setTimeout(r, 60));

    assert.equal(insertedRecords[0].title, TITLE, 'DB 落库标题 == titleSelection.title');
    assert.ok(JSON.stringify(sentCards[0]).includes(TITLE), '审批卡含真实标题');
  });
});
