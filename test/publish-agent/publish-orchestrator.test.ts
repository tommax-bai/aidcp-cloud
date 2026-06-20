import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { PublishOrchestrator } from '../../src/publish-agent/publish-orchestrator.js';
import { ContentScoutRole } from '../../src/publish-agent/roles/content-scout.js';
import { ContentTypeSelectorRole } from '../../src/publish-agent/roles/content-type-selector.js';
import { ContentCreatorRole } from '../../src/publish-agent/roles/content-creator.js';
import { ImagePlannerRole } from '../../src/publish-agent/roles/image-planner.js';
import { ImageGeneratorRole } from '../../src/publish-agent/roles/image-generator.js';
import { CoverSelectorRole } from '../../src/publish-agent/roles/cover-selector.js';
import { ContentCleanerRole } from '../../src/publish-agent/roles/content-cleaner.js';
import { AiFlavorScorerRole } from '../../src/publish-agent/roles/ai-flavor-scorer.js';
import { QualityScorerRole } from '../../src/publish-agent/roles/quality-scorer.js';
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

/**
 * 注册 A 阶段2 细拆后的 11 个生产段角色（顺序无关，黑板靠键就绪触发）。
 * fakeLlm 按 system prompt 路由：发布决策→Scout、小红书技术博主→Creator、
 * 配图策略→ImagePlanner、质量评审→QualityScorer、审批决策→Gatekeeper。
 */
function buildFullPipeline(llmResponses: Record<string, string>, opts?: { enableImage?: boolean }) {
  const fakeLlm = {
    chat: async (messages: any[]) => {
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
  const fakeImageProvider = { generate: async () => ({ url: 'https://example.com/generated.png', taskId: 'task-1' }) };
  const fakePostProcessor = {
    process: async (content: string) => ({ content, aiScore: 0.1, rewritten: false, flaggedPhrases: [] }),
  };
  const insertedRecords: any[] = [];
  const fakeStore = { insert: async (record: any) => { insertedRecords.push(record); return 42; } };
  const pushedEnvelopes: any[] = [];
  const fakePusher = { pushToEdges: (envelope: any) => { pushedEnvelopes.push(envelope); return 1; } };

  const orchestrator = new PublishOrchestrator({ clock, idGen: () => 'run-001', logger: silentLogger, pipelineTimeoutMs: 5000 });
  const common = { clock, logger: silentLogger };
  orchestrator.registerRole(new ContentScoutRole({ llmClient: fakeLlm as any, ...common }));
  orchestrator.registerRole(new ContentTypeSelectorRole(common));
  orchestrator.registerRole(new ContentCreatorRole({ llmClient: fakeLlm as any, ...common }));
  orchestrator.registerRole(new ImagePlannerRole({ llmClient: fakeLlm as any, ...common }));
  orchestrator.registerRole(new ImageGeneratorRole({ imageProvider: fakeImageProvider, enableImageGeneration: opts?.enableImage ?? false, ...common }));
  orchestrator.registerRole(new CoverSelectorRole(common));
  orchestrator.registerRole(new ContentCleanerRole({ postProcessor: fakePostProcessor, ...common }));
  orchestrator.registerRole(new AiFlavorScorerRole(common));
  orchestrator.registerRole(new QualityScorerRole({ llmClient: fakeLlm as any, ...common }));
  orchestrator.registerRole(new ContentAssemblerRole(common));
  orchestrator.registerRole(new ApprovalGatekeeperRole({ llmClient: fakeLlm as any, ...common }));
  orchestrator.registerRole(new PublishExecutorRole({ store: fakeStore, pusher: fakePusher, idGen: () => 'env-001', ...common }));

  return { orchestrator, insertedRecords, pushedEnvelopes };
}

describe('PublishOrchestrator', () => {
  test('完整链路（11 角色细拆）：trigger → … → assembledContent → gate → executor → publishResult', async () => {
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
    // 稳定边界：组装产出仍含八字段（细拆后等价）。
    assert.equal(orchestrator.getRoles().length, 12);
  });

  test('细拆后端到端等价 + 配图失败降级：组装边界正确、imageUrl 诚实为 null', async () => {
    // 经 PublishExecutor 落库记录反映 assembledContent（管道完成后 activeContext 清空、无法读 snapshot）。
    const { orchestrator, insertedRecords } = buildFullPipeline(
      {
        scout: JSON.stringify({ shouldPublish: true, publishDirection: 'x', keyPoints: [], confidence: 0.8, reason: 'ok' }),
        creator: JSON.stringify({ title: 'T', content: '正文', tags: ['a', 'b'], tone: 'casual', style: {} }),
        image: JSON.stringify({ imagePrompt: 'p', imageStyle: 'illustration', fallbackStrategy: 'skip' }),
        assembler: JSON.stringify({ qualityScore: 77 }),
        gatekeeper: JSON.stringify({ needsApproval: false, recommendedAction: 'auto_publish', reason: 'ok' }),
      },
      { enableImage: false }, // 生图关闭 → imageDirective 空 → 封面无 → imageUrl 诚实 null（waitAll 五键仍全写、不死锁）
    );
    const result = await orchestrator.trigger(makeTriggerInput());
    assert.equal(result.status, 'draft', '五键全写 → 组装触发 → 走到 executor draft');
    assert.equal(insertedRecords.length, 1, 'assembledContent 经 executor 落库一条');
    const rec = insertedRecords[0];
    assert.equal(rec.imageUrl, null, '生图关闭 → 诚实 null，不伪造');
    assert.equal(rec.qualityScore, 77, 'qualityScore 来自 QualityScorer');
    assert.deepEqual(rec.tags, ['a', 'b'], 'finalTags 来自 createdContent');
    assert.equal(rec.content, '正文', 'finalContent 来自 cleanedContent');
  });

  test('scout 决定不发布 → 早期终止，返回 status=skipped', async () => {
    const { orchestrator } = buildFullPipeline({
      scout: JSON.stringify({ shouldPublish: false, publishDirection: 'none', keyPoints: [], confidence: 0.3, reason: '素材不足' }),
      creator: '{}', image: '{}', assembler: '{}', gatekeeper: '{}',
    });
    const result = await orchestrator.trigger(makeTriggerInput());
    assert.equal(result.status, 'skipped');
    assert.equal(result.dispatched, false);
    assert.equal(result.recordId, null);
  });

  test('管道超时 → 返回 status=failed', async () => {
    const fakeLlm = { chat: async () => new Promise<string>(() => {}), complete: async () => '' };
    const orchestrator = new PublishOrchestrator({ clock, idGen: () => 'run-timeout', logger: silentLogger, pipelineTimeoutMs: 200 });
    orchestrator.registerRole(new ContentScoutRole({ llmClient: fakeLlm as any, clock, logger: silentLogger }));
    const result = await orchestrator.trigger(makeTriggerInput());
    assert.equal(result.status, 'failed');
    assert.equal(result.dispatched, false);
    assert.equal(result.recordId, null);
  });

  test('重复 trigger → 第二次被忽略（running 状态防重入）', async () => {
    const { orchestrator } = buildFullPipeline({
      scout: JSON.stringify({ shouldPublish: true, publishDirection: 'test', keyPoints: [], confidence: 0.5, reason: 'ok' }),
      creator: JSON.stringify({ title: 'T', content: 'c', tags: [], tone: 'casual', style: {} }),
      image: JSON.stringify({ imagePrompt: null }),
      assembler: JSON.stringify({ qualityScore: 60 }),
      gatekeeper: JSON.stringify({ needsApproval: false, recommendedAction: 'auto_publish', reason: 'ok' }),
    });
    const p1 = orchestrator.trigger(makeTriggerInput());
    const result2 = await orchestrator.trigger(makeTriggerInput());
    assert.equal(result2.status, 'skipped');
    assert.equal(result2.runId, '');
    const result1 = await p1;
    assert.ok(['draft', 'needs_review', 'failed'].includes(result1.status));
  });
});
