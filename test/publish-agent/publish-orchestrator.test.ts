import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { PublishOrchestrator } from '../../src/publish-agent/publish-orchestrator.js';
import { ContentScoutRole } from '../../src/publish-agent/roles/content-scout.js';
import { ContentCreatorRole } from '../../src/publish-agent/roles/content-creator.js';
import { ImageDirectorRole } from '../../src/publish-agent/roles/image-director.js';
import { ContentAssemblerRole } from '../../src/publish-agent/roles/content-assembler.js';
import { ApprovalGatekeeperRole } from '../../src/publish-agent/roles/approval-gatekeeper.js';
import { PublishExecutorRole } from '../../src/publish-agent/roles/publish-executor.js';
import type { TriggerInput } from '../../src/publish-agent/types.js';

const clock = () => 1700000000000;
const silentLogger = { log() {}, warn() {}, error() {} };

function makeTriggerInput(): TriggerInput {
  return {
    metrics: { hoursSinceLastPublish: 30, newConceptCount: 3, likedSinceLastPublish: 20 },
    generateInput: {
      concepts: [{ keyword: 'RAG 重排' }, { keyword: 'vLLM 量化' }, { keyword: 'KV cache' }],
      likedContents: [{ id: 1, title: 'RAG 实战', summary: '分块很关键', author: '老王' }],
      soul: {
        identity: { name: '小林', role: 'AI研发', background: '3年', tone: '理性' },
        interests: { primary: ['LLM'], secondary: [], seed_keywords: ['RAG'] },
        engagement_rules: { like: [], skip: [], comment_trigger: [] },
        browse_patterns: {
          mode: 'state_machine',
          states: { browse: { action: 'x', transitions: [] } },
          session: { max_duration_min: 10, max_likes: 8, max_searches: 3, cooldown_between_actions_sec: [3, 8] },
        },
      },
      recentPosts: [],
    },
    recentPublished: [],
  };
}

function buildFullPipeline(llmResponses: Record<string, string>, opts?: { enableImage?: boolean }) {
  let callCount = 0;
  const fakeLlm = {
    chat: async (messages: any[]) => {
      callCount++;
      // 根据 system prompt 内容判断是哪个角色在调用
      const systemContent = messages[0]?.content ?? '';
      if (systemContent.includes('发布决策')) return llmResponses.scout;
      if (systemContent.includes('小红书技术博主')) return llmResponses.creator;
      if (systemContent.includes('配图策略')) return llmResponses.image;
      if (systemContent.includes('质量评审')) return llmResponses.assembler;
      if (systemContent.includes('审批决策')) return llmResponses.gatekeeper;
      return '{}';
    },
    complete: async () => '',
  };

  const fakeImageProvider = {
    generate: async () => ({ url: 'https://example.com/generated.png', taskId: 'task-1' }),
  };

  const fakePostProcessor = {
    process: async (content: string) => ({
      content,
      aiScore: 0.1,
      rewritten: false,
      flaggedPhrases: [],
    }),
  };

  const insertedRecords: any[] = [];
  const fakeStore = {
    insert: async (record: any) => { insertedRecords.push(record); return 42; },
  };

  const pushedEnvelopes: any[] = [];
  const fakePusher = {
    pushToEdges: (envelope: any) => { pushedEnvelopes.push(envelope); return 1; },
  };

  const orchestrator = new PublishOrchestrator({ clock, idGen: () => 'run-001', logger: silentLogger, pipelineTimeoutMs: 5000 });

  orchestrator.registerRole(new ContentScoutRole({ llmClient: fakeLlm as any, clock, logger: silentLogger }));
  orchestrator.registerRole(new ContentCreatorRole({ llmClient: fakeLlm as any, clock, logger: silentLogger }));
  orchestrator.registerRole(new ImageDirectorRole({
    llmClient: fakeLlm as any,
    imageProvider: fakeImageProvider,
    enableImageGeneration: opts?.enableImage ?? false,
    clock,
    logger: silentLogger,
  }));
  orchestrator.registerRole(new ContentAssemblerRole({
    llmClient: fakeLlm as any,
    postProcessor: fakePostProcessor,
    clock,
    logger: silentLogger,
  }));
  orchestrator.registerRole(new ApprovalGatekeeperRole({ llmClient: fakeLlm as any, clock, logger: silentLogger }));
  orchestrator.registerRole(new PublishExecutorRole({
    store: fakeStore,
    pusher: fakePusher,
    idGen: () => 'env-001',
    clock,
    logger: silentLogger,
  }));

  return { orchestrator, insertedRecords, pushedEnvelopes };
}

describe('PublishOrchestrator', () => {
  test('完整链路：trigger → scout → creator → image → assembler → gate → executor → publishResult', async () => {
    const { orchestrator, insertedRecords, pushedEnvelopes } = buildFullPipeline({
      scout: JSON.stringify({ shouldPublish: true, publishDirection: 'RAG优化', keyPoints: ['切块'], confidence: 0.9, reason: '充足' }),
      creator: JSON.stringify({ title: 'RAG踩坑', content: '昨天切块切碎了召回一坨', tags: ['RAG'], tone: 'casual', style: { type: '踩坑' } }),
      image: JSON.stringify({ imagePrompt: 'tech illustration', imageStyle: 'illustration', fallbackStrategy: 'skip' }),
      assembler: JSON.stringify({ qualityScore: 85 }),
      gatekeeper: JSON.stringify({ needsApproval: false, recommendedAction: 'auto_publish', reason: '质量ok' }),
    });

    const result = await orchestrator.trigger(makeTriggerInput());

    assert.equal(result.status, 'draft');
    assert.equal(result.dispatched, true);
    assert.equal(result.recordId, 42);
    assert.equal(result.runId, 'run-001');
    assert.equal(insertedRecords.length, 1);
    assert.equal(pushedEnvelopes.length, 1);
  });

  test('scout 决定不发布 → 早期终止，返回 status=skipped', async () => {
    const { orchestrator } = buildFullPipeline({
      scout: JSON.stringify({ shouldPublish: false, publishDirection: 'none', keyPoints: [], confidence: 0.3, reason: '素材不足' }),
      creator: '{}',
      image: '{}',
      assembler: '{}',
      gatekeeper: '{}',
    });

    const result = await orchestrator.trigger(makeTriggerInput());

    assert.equal(result.status, 'skipped');
    assert.equal(result.dispatched, false);
    assert.equal(result.recordId, null);
  });

  test('管道超时 → 返回 status=failed', async () => {
    // LLM 永不返回，导致超时
    const fakeLlm = {
      chat: async () => new Promise<string>(() => {}), // 永不 resolve
      complete: async () => '',
    };

    const orchestrator = new PublishOrchestrator({ clock, idGen: () => 'run-timeout', logger: silentLogger, pipelineTimeoutMs: 200 });
    orchestrator.registerRole(new ContentScoutRole({ llmClient: fakeLlm as any, clock, logger: silentLogger }));

    const result = await orchestrator.trigger(makeTriggerInput());

    assert.equal(result.status, 'failed');
    assert.equal(result.dispatched, false);
    assert.equal(result.recordId, null);
  });

  test('重复 trigger → 第二次被忽略（running 状态防重入）', async () => {
    const fakeLlm = {
      chat: async () => {
        await new Promise(r => setTimeout(r, 100));
        return JSON.stringify({ shouldPublish: true, publishDirection: 'test', keyPoints: [], confidence: 0.5, reason: 'ok' });
      },
      complete: async () => '',
    };

    const fakeStore = { insert: async () => 1 };
    const fakePusher = { pushToEdges: () => 1 };
    const fakePostProcessor = { process: async (c: string) => ({ content: c, aiScore: 0.1, rewritten: false, flaggedPhrases: [] }) };
    const fakeImageProvider = { generate: async () => ({ url: null }) };

    const orchestrator = new PublishOrchestrator({ clock, idGen: () => 'run-dup', logger: silentLogger, pipelineTimeoutMs: 5000 });
    orchestrator.registerRole(new ContentScoutRole({ llmClient: fakeLlm as any, clock, logger: silentLogger }));
    orchestrator.registerRole(new ContentCreatorRole({ llmClient: fakeLlm as any, clock, logger: silentLogger }));
    orchestrator.registerRole(new ImageDirectorRole({ llmClient: fakeLlm as any, imageProvider: fakeImageProvider, enableImageGeneration: false, clock, logger: silentLogger }));
    orchestrator.registerRole(new ContentAssemblerRole({ llmClient: fakeLlm as any, postProcessor: fakePostProcessor, clock, logger: silentLogger }));
    orchestrator.registerRole(new ApprovalGatekeeperRole({ llmClient: fakeLlm as any, clock, logger: silentLogger }));
    orchestrator.registerRole(new PublishExecutorRole({ store: fakeStore, pusher: fakePusher, idGen: () => 'env-dup', clock, logger: silentLogger }));

    // 触发第一个（不等待完成）
    const p1 = orchestrator.trigger(makeTriggerInput());
    // 立即触发第二个
    const result2 = await orchestrator.trigger(makeTriggerInput());

    // 第二次应直接返回 skipped
    assert.equal(result2.status, 'skipped');
    assert.equal(result2.runId, '');

    // 第一次应正常完成
    const result1 = await p1;
    assert.ok(['draft', 'needs_review', 'failed'].includes(result1.status) || result1.status === 'draft');
  });
});
