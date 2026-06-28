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
import { TitleCreatorRole } from '../../src/publish-agent/roles/title-creator.js';
import {
  TopicStrategistRole,
  MentionStrategistRole,
  LocationStrategistRole,
  CollectionStrategistRole,
  VisibilityDeciderRole,
  PermissionDeciderRole,
  PublishModeDeciderRole,
  ComplianceDeciderRole,
  MetadataAggregatorRole,
} from '../../src/publish-agent/roles/index.js';
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
      if (systemContent.includes('标题创作')) return llmResponses.title ?? '{"title":"测试标题"}';
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
  // decouple-publish-generation-from-dispatch：生成候审段不下发边缘（executor 不再 push）；保留空数组以断言「生成不下发」。
  const pushedEnvelopes: any[] = [];

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
  // 标题链路：定稿后单独生成标题（发布门 waitAll 依赖 titleSelection）。
  orchestrator.registerRole(new TitleCreatorRole({ llmClient: fakeLlm as any, ...common }));
  // 阶段3 元数据 + 合规决策（并行于发布链；规则式确定性，无需 LLM）
  orchestrator.registerRole(new TopicStrategistRole(common));
  orchestrator.registerRole(new MentionStrategistRole(common));
  orchestrator.registerRole(new LocationStrategistRole(common));
  orchestrator.registerRole(new CollectionStrategistRole(common));
  orchestrator.registerRole(new VisibilityDeciderRole(common));
  orchestrator.registerRole(new PermissionDeciderRole(common));
  orchestrator.registerRole(new PublishModeDeciderRole(common));
  orchestrator.registerRole(new ComplianceDeciderRole(common));
  orchestrator.registerRole(new MetadataAggregatorRole(common));
  orchestrator.registerRole(new ApprovalGatekeeperRole({ llmClient: fakeLlm as any, ...common }));
  orchestrator.registerRole(new PublishExecutorRole({ store: fakeStore, ...common }));

  return { orchestrator, insertedRecords, pushedEnvelopes };
}

describe('PublishOrchestrator', () => {
  test('完整链路（11 角色细拆）：trigger → … → assembledContent → gate → executor → publishResult', async () => {
    const { orchestrator, insertedRecords, pushedEnvelopes } = buildFullPipeline(
      {
        scout: JSON.stringify({ shouldPublish: true, publishDirection: 'RAG优化', keyPoints: ['切块'], confidence: 0.9, reason: '充足' }),
        creator: JSON.stringify({ title: 'RAG踩坑', content: '昨天切块切碎了召回一坨', tags: ['RAG'], tone: 'casual', style: { type: '踩坑' } }),
        image: JSON.stringify({ imagePrompt: 'tech illustration', imageStyle: 'illustration', fallbackStrategy: 'skip' }),
        assembler: JSON.stringify({ qualityScore: 85 }),
        gatekeeper: JSON.stringify({ needsApproval: false, recommendedAction: 'auto_publish', reason: '质量ok' }),
      },
      { enableImage: true }, // 图文帖必须有图（change publish-image-required-or-fail）：生图开启 → imageUrl 有值 → 走 draft
    );

    const result = await orchestrator.trigger(makeTriggerInput());

    // decouple-publish-generation-from-dispatch：生成候审段终止于「落库待审 + 发审批卡」，不下发边缘。
    assert.equal(result.status, 'pending_approval');
    assert.equal(result.dispatched, false);
    assert.equal(result.recordId, 42);
    assert.equal(result.runId, 'run-001');
    assert.equal(insertedRecords.length, 1);
    assert.equal(insertedRecords[0].status, 'pending_approval', '落库为待审草稿');
    assert.equal(pushedEnvelopes.length, 0, '生成候审段绝不下发边缘');
    // 稳定边界：组装产出仍含八字段（细拆后等价）。
    // 12（stage-2 生产段+下游）+ 9（stage-3 元数据/合规决策）+ 1（TitleCreator）= 22；新角色并行、不阻塞 publishResult。
    assert.equal(orchestrator.getRoles().length, 22);
  });

  test('配图失败/无图 → 诚实 failed（change publish-image-required-or-fail：图文帖必须有图，绝不走必然 no_target 的纯文字路径）', async () => {
    // 经 PublishExecutor 落库记录反映 assembledContent（管道完成后 activeContext 清空、无法读 snapshot）。
    const { orchestrator, insertedRecords, pushedEnvelopes } = buildFullPipeline(
      {
        scout: JSON.stringify({ shouldPublish: true, publishDirection: 'x', keyPoints: [], confidence: 0.8, reason: 'ok' }),
        creator: JSON.stringify({ title: 'T', content: '正文', tags: ['a', 'b'], tone: 'casual', style: {} }),
        image: JSON.stringify({ imagePrompt: 'p', imageStyle: 'illustration', fallbackStrategy: 'skip' }),
        assembler: JSON.stringify({ qualityScore: 77 }),
        gatekeeper: JSON.stringify({ needsApproval: false, recommendedAction: 'auto_publish', reason: 'ok' }),
      },
      { enableImage: false }, // 生图关闭 → imageUrl 诚实 null → executor 提前诚实 failed（不发卡、不下发）
    );
    const result = await orchestrator.trigger(makeTriggerInput());
    assert.equal(result.status, 'failed', '无图 → 图文帖无有效内容 → 诚实 failed（不再降级纯文字 draft）');
    assert.equal(result.dispatched, false, '无图 → 不下发任何指令到边缘');
    assert.equal(pushedEnvelopes.length, 0, '无图 → 不驱动 edge');
    assert.equal(insertedRecords.length, 1, '诚实落库一条 failed 记录（审计）');
    const rec = insertedRecords[0];
    assert.equal(rec.status, 'failed', '落库 status=failed');
    assert.equal(rec.imageUrl, null, '生图关闭 → 诚实 null，不伪造');
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
    assert.ok(['pending_approval', 'draft', 'needs_review', 'failed'].includes(result1.status));
  });

  test('AC-TITLE-FIDELITY / task0.2：TitleCreator 抛错 → 流水线即时 failed、未落库未发布（不干等 pipelineTimeoutMs）', async () => {
    const { orchestrator, insertedRecords, pushedEnvelopes } = buildFullPipeline({
      scout: JSON.stringify({ shouldPublish: true, publishDirection: 'x', keyPoints: [], confidence: 0.9, reason: 'ok' }),
      creator: JSON.stringify({ title: 'T', content: '正文内容在这里', tags: ['a'], tone: 'casual', style: {} }),
      image: JSON.stringify({ imagePrompt: 'p', imageStyle: 'illustration', fallbackStrategy: 'skip' }),
      assembler: JSON.stringify({ qualityScore: 80 }),
      gatekeeper: JSON.stringify({ needsApproval: false, recommendedAction: 'auto_publish', reason: 'ok' }),
      title: '这不是JSON标题会解析失败', // 无 {} → TitleCreator 每次解析失败 → 重试用尽 → abort
    });
    const started = Date.now();
    const result = await orchestrator.trigger(makeTriggerInput());
    const elapsed = Date.now() - started;
    // 即时失败：pipelineTimeoutMs=5000；若 abort 不即时收敛会干等到 5000ms。
    assert.equal(result.status, 'failed', '标题 abort → 流水线 failed');
    assert.ok(elapsed < 4000, `应即时失败而非干等超时（实际 ${elapsed}ms）`);
    assert.equal(insertedRecords.length, 0, 'titleSelection 未就绪 → executor 不激活 → 未落库');
    assert.equal(pushedEnvelopes.length, 0, '未下发 edge');
  });
});
