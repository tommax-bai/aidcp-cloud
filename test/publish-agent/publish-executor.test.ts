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
import { REFERENCE_IMAGE_MAX_COUNT } from '../../src/publish-agent/reference-image-guidance.js';
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

  test('排期免审 → 写授权信号 + 触发下发段 + 发通知卡，不发送交互审批卡', async () => {
    const insertedRecords: any[] = [];
    const approvalSignals: any[] = [];
    const dispatched: string[] = [];
    const notifications: Array<{ chatId: string; card: any }> = [];
    const role = new PublishExecutorRole({
      store: { insert: async (r: any) => { insertedRecords.push(r); return 46; } },
      messenger: {
        sendApprovalCard: async () => {
          throw new Error('interactive approval card should not be sent in auto_approve mode');
        },
        sendCard: async (chatId: string, card: any) => { notifications.push({ chatId, card }); },
      },
      botChatStore: { getDefaultChat: async () => ({ chatId: 'chat-1' }) },
      writeApprovalSignal: async (requestId, approved, payload) => {
        approvalSignals.push({ requestId, approved, payload });
        return { written: true };
      },
      triggerApprovedDispatch: (requestId) => { dispatched.push(requestId); },
      clock,
      logger: silentLogger,
    });

    const ctx = new PipelineContext<PipelineFields>();
    ctx.write('trigger', {
      metrics: { hoursSinceLastPublish: 1, newConceptCount: 1, likedSinceLastPublish: 0 },
      generateInput: { concepts: [], likedContents: [], soul: {} as any, recentPosts: [] },
      recentPublished: [],
      accountId: 'acc-test',
      approvalMode: 'auto_approve',
    } as any);
    ctx.write('assembledContent', makeAssembledContent());
    ctx.write('titleSelection', makeTitleSelection());
    ctx.write('publishMetadata', makePublishMetadata());
    role.register(ctx);
    ctx.write('gateDecision', makeGateDecision('auto_publish'));

    await new Promise((r) => setTimeout(r, 50));

    const result = ctx.get('publishResult');
    assert.equal(result?.recordId, 46);
    assert.equal(result?.status, 'pending_approval');
    assert.equal(result?.dispatched, false, '生成段仍不直接下发边缘，由审批信号触发下发段');
    assert.equal(insertedRecords.length, 1);
    assert.equal(insertedRecords[0].status, 'pending_approval');
    assert.deepEqual(approvalSignals, [{
      requestId: 'publish-46',
      approved: true,
      payload: {
        title: 'vLLM 部署踩坑',
        content: '昨天试了 vLLM 跑 14B，显存直接爆了',
        tags: ['话题甲', '话题乙'],
        contentVersion: 0,
      },
    }]);
    assert.deepEqual(dispatched, ['publish-46']);
    assert.equal(notifications.length, 1, '免审只发通知卡');
    assert.equal(notifications[0].chatId, 'chat-1');
    assert.ok(JSON.stringify(notifications[0].card).includes('排期发帖已免审提交'));
    assert.equal(result?.approvalCard?.sent, true);
    assert.equal(result?.approvalCard?.targetSource, 'default_chat');
  });

  test('审批卡显示触发账号昵称，缺昵称时由卡片回落 accountId', async () => {
    const sentCards: any[] = [];
    const role = new PublishExecutorRole({
      store: { insert: async () => 42 },
      messenger: { sendApprovalCard: async (_c: string, card: any) => { sentCards.push(card); } },
      botChatStore: { getDefaultChat: async () => ({ chatId: 'chat-1' }) },
      getAccountName: (accountId) => (accountId === 'acc-test' ? 'Tmax' : undefined),
      clock,
      logger: silentLogger,
    });

    const ctx = new PipelineContext<PipelineFields>();
    ctx.write('trigger', {
      metrics: { hoursSinceLastPublish: 1, newConceptCount: 1, likedSinceLastPublish: 0 },
      generateInput: { concepts: [], likedContents: [], soul: {} as any, recentPosts: [] },
      recentPublished: [],
      accountId: 'acc-test',
    } as any);
    ctx.write('assembledContent', makeAssembledContent());
    ctx.write('titleSelection', makeTitleSelection());
    ctx.write('publishMetadata', makePublishMetadata());
    role.register(ctx);
    ctx.write('gateDecision', makeGateDecision('auto_publish'));

    await new Promise((r) => setTimeout(r, 50));

    const flat = JSON.stringify(sentCards[0]);
    assert.match(flat, /账号/);
    assert.match(flat, /Tmax/);
    assert.doesNotMatch(flat, /acc-test/);
  });

  test('Facebook 审批卡上传并展示所选素材缩略图；单张失败不阻断发卡', async () => {
    const sentCards: any[] = [];
    const uploaded: string[] = [];
    const warnings: string[] = [];
    const role = new PublishExecutorRole({
      store: { insert: async () => 42 },
      messenger: {
        uploadImageFromUrl: async (url: string) => {
          uploaded.push(url);
          if (url.endsWith('/b.png')) throw new Error('upload failed');
          return 'img_key_a';
        },
        sendApprovalCard: async (_c: string, card: any) => { sentCards.push(card); },
      },
      botChatStore: { getDefaultChat: async () => ({ chatId: 'chat-1' }) },
      clock,
      logger: { ...silentLogger, warn: (...args: unknown[]) => warnings.push(args.map(String).join(' ')) },
    });

    const ctx = new PipelineContext<PipelineFields>();
    ctx.write('trigger', {
      metrics: { hoursSinceLastPublish: 1, newConceptCount: 1, likedSinceLastPublish: 0 },
      generateInput: { concepts: [], likedContents: [], soul: {} as any, recentPosts: [] },
      recentPublished: [],
      accountId: 'fb-1',
      platform: 'facebook',
    } as any);
    ctx.write('imageDirective', {
      imagePrompt: null,
      imageUrls: ['https://example.com/a.png', 'https://example.com/b.png'],
      imageUrl: 'https://example.com/a.png',
      imageStyle: null,
      fallbackStrategy: 'skip',
      directedAt: clock(),
    } as any);
    ctx.write('assembledContent', makeAssembledContent());
    ctx.write('titleSelection', makeTitleSelection());
    ctx.write('publishMetadata', makePublishMetadata());
    role.register(ctx);
    ctx.write('gateDecision', makeGateDecision('auto_publish'));

    await new Promise((r) => setTimeout(r, 50));

    assert.deepEqual(uploaded, ['https://example.com/a.png', 'https://example.com/b.png']);
    assert.equal(sentCards.length, 1);
    assert.equal(JSON.stringify(sentCards[0]).includes('2 张'), true);
    const imageElements = sentCards[0].elements.filter((el: any) => el.tag === 'img');
    assert.deepEqual(imageElements.map((el: any) => el.img_key), ['img_key_a']);
    assert.match(warnings.join('\n'), /素材缩略图上传飞书失败/);
    assert.equal(ctx.get('publishResult')?.approvalCard?.sent, true);
  });

  test('手动飞书 publish source chat 优先于默认群', async () => {
    const sent: Array<{ chatId: string; card: any }> = [];
    const role = new PublishExecutorRole({
      store: { insert: async () => 43 },
      messenger: { sendApprovalCard: async (chatId: string, card: any) => { sent.push({ chatId, card }); } },
      botChatStore: {
        getDefaultChat: async () => {
          throw new Error('default chat should not be queried when manual source chat exists');
        },
      },
      clock,
      logger: silentLogger,
    });

    const ctx = new PipelineContext<PipelineFields>();
    ctx.write('trigger', {
      metrics: { hoursSinceLastPublish: 1, newConceptCount: 1, likedSinceLastPublish: 0 },
      generateInput: { concepts: [], likedContents: [], soul: {} as any, recentPosts: [] },
      recentPublished: [],
      accountId: 'acc-test',
      manualApprovalChatId: 'chat-private',
    } as any);
    ctx.write('assembledContent', makeAssembledContent());
    ctx.write('titleSelection', makeTitleSelection());
    ctx.write('publishMetadata', makePublishMetadata());
    role.register(ctx);
    ctx.write('gateDecision', makeGateDecision('auto_publish'));

    await new Promise((r) => setTimeout(r, 50));

    assert.equal(sent.length, 1);
    assert.equal(sent[0].chatId, 'chat-private');
    assert.equal(ctx.get('publishResult')?.approvalCard?.sent, true);
    assert.equal(ctx.get('publishResult')?.approvalCard?.targetSource, 'manual_source');
  });

  test('无手动 source chat 时回落默认审批群', async () => {
    const sent: Array<{ chatId: string; card: any }> = [];
    const role = new PublishExecutorRole({
      store: { insert: async () => 44 },
      messenger: { sendApprovalCard: async (chatId: string, card: any) => { sent.push({ chatId, card }); } },
      botChatStore: { getDefaultChat: async () => ({ chatId: 'chat-default' }) },
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

    assert.equal(sent.length, 1);
    assert.equal(sent[0].chatId, 'chat-default');
    assert.equal(ctx.get('publishResult')?.approvalCard?.sent, true);
    assert.equal(ctx.get('publishResult')?.approvalCard?.targetSource, 'default_chat');
  });

  test('审批卡发送失败 → pending_approval 仍诚实携带失败结果', async () => {
    const warnings: string[] = [];
    const logs: string[] = [];
    const role = new PublishExecutorRole({
      store: { insert: async () => 45 },
      messenger: { sendApprovalCard: async () => { throw new Error('Feishu HTTP 400'); } },
      botChatStore: { getDefaultChat: async () => ({ chatId: 'chat-default' }) },
      clock,
      logger: {
        log: (...args: unknown[]) => logs.push(args.map(String).join(' ')),
        warn: (...args: unknown[]) => warnings.push(args.map(String).join(' ')),
        error() {},
      },
    });

    const ctx = new PipelineContext<PipelineFields>();
    ctx.write('assembledContent', makeAssembledContent());
    ctx.write('titleSelection', makeTitleSelection());
    ctx.write('publishMetadata', makePublishMetadata());
    role.register(ctx);
    ctx.write('gateDecision', makeGateDecision('auto_publish'));

    await new Promise((r) => setTimeout(r, 50));

    const result = ctx.get('publishResult');
    assert.equal(result?.status, 'pending_approval');
    assert.deepEqual(result?.approvalCard, {
      sent: false,
      targetChatId: 'chat-default',
      targetSource: 'default_chat',
      error: 'Feishu HTTP 400',
    });
    assert.match(warnings.join('\n'), /发审批卡失败/);
    assert.match(logs.join('\n'), /审批卡未送达/);
    assert.doesNotMatch(logs.join('\n'), /已发审批卡/);
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
          images: Array.from({ length: REFERENCE_IMAGE_MAX_COUNT }, (_, i) => ({
            index: i,
            sourceUrl: `https://ref.test/${i + 1}.webp`,
            ...(i === 1 ? { ossUrl: 'https://oss.test/2.webp' } : {}),
            captureStatus: 'stored' as const,
          })),
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
      visualReferenceAudit: {
        analysisStatus: 'partial',
        analysisCacheKey: 'visual-cache-1',
        bindingMode: 'slot',
        auditEnabled: true,
        slots: [{
          slot: 0,
          binding: {
            slot: 0,
            mode: 'slot',
            references: [{ sourceArrayIndex: 0, sourceIndex: 0, url: 'https://ref.test/1.webp', role: 'primary' }],
            primarySourceArrayIndex: 0,
            primarySourceIndex: 0,
          },
          route: 'generative',
          styleSource: 'reference_analysis',
          providerReferenceStatus: 'used',
          outputUrl: 'https://example.com/a.png',
          attempts: [],
          finalStatus: 'unverified',
        }],
      },
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
      requestedCount: REFERENCE_IMAGE_MAX_COUNT,
      usableCount: REFERENCE_IMAGE_MAX_COUNT,
      status: 'unsupported',
      providerClaimedUsed: false,
      generatedCount: 2,
    });
    assert.deepEqual(recordedMeta[0].metadata.visualReferenceAudit, {
      analysisStatus: 'partial',
      analysisCacheKey: 'visual-cache-1',
      bindingMode: 'slot',
      auditEnabled: true,
      slots: [{
        slot: 0,
        binding: {
          slot: 0,
          mode: 'slot',
          references: [{ sourceArrayIndex: 0, sourceIndex: 0, url: 'https://ref.test/1.webp', role: 'primary' }],
          primarySourceArrayIndex: 0,
          primarySourceIndex: 0,
        },
        route: 'generative',
        styleSource: 'reference_analysis',
        providerReferenceStatus: 'used',
        outputUrl: 'https://example.com/a.png',
        attempts: [],
        finalStatus: 'unverified',
      }],
    }, '逐槽视觉核验原样并列落库');
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
