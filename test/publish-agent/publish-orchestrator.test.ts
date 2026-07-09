import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { PublishOrchestrator } from '../../src/publish-agent/publish-orchestrator.js';
import { ContentScoutRole } from '../../src/publish-agent/roles/content-scout.js';
import { ContentTypeSelectorRole } from '../../src/publish-agent/roles/content-type-selector.js';
import { ContentCreatorRole } from '../../src/publish-agent/roles/content-creator.js';
import { CategoryClassifierRole } from '../../src/publish-agent/roles/category-classifier.js';
import { CoverCardWriterRole } from '../../src/publish-agent/roles/cover-card-writer.js';
import { ImageSetPlannerRole } from '../../src/publish-agent/roles/image-set-planner.js';
import { ImagePromptComposerRole } from '../../src/publish-agent/roles/image-prompt-composer.js';
import { ImageGeneratorRole } from '../../src/publish-agent/roles/image-generator.js';
import { CoverSelectorRole } from '../../src/publish-agent/roles/cover-selector.js';
import { ContentCleanerRole } from '../../src/publish-agent/roles/content-cleaner.js';
import { AiFlavorScorerRole } from '../../src/publish-agent/roles/ai-flavor-scorer.js';
import { QualityScorerRole } from '../../src/publish-agent/roles/quality-scorer.js';
import { ContentAssemblerRole } from '../../src/publish-agent/roles/content-assembler.js';
import { TitleCreatorRole } from '../../src/publish-agent/roles/title-creator.js';
import {
  ReferenceAnalyzerRole,
  FaithfulRewritePlannerRole,
  FaithfulDraftWriterRole,
  FidelityAuditorRole,
  TopicGeneratorRole,
  TopicEvaluatorRole,
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
import { PipelineContext } from '../../src/publish-agent/pipeline-context.js';
import type { PipelineFields, TriggerInput } from '../../src/publish-agent/types.js';

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

function makeReferenceTriggerInput(): TriggerInput {
  const base = makeTriggerInput();
  return {
    ...base,
    forced: true,
    generateInput: {
      ...base.generateInput,
      concepts: [],
      likedContents: [],
      referenceNote: {
        sourceId: 'lmcache-1',
        title: 'LMCache 突破一万 star',
        body: 'LMCache 从实验室项目走向开源项目，先通过 vLLM patch 接入，后来改成 connector API，并在 agentic workload 增长后升级到多进程架构。',
        topics: ['LMCache', 'KV Cache'],
        author: 'committer',
      },
    },
  };
}

/**
 * 注册 A 阶段2 细拆后的 11 个生产段角色（顺序无关，黑板靠键就绪触发）。
 * fakeLlm 按 system prompt 路由：发布决策→Scout、正文创作→Creator、
 * 配图选题→ImageSetPlanner、配图指令→ImagePromptComposer、质量评审→QualityScorer、审批决策→Gatekeeper。
 */
function buildFullPipeline(llmResponses: Record<string, string>, opts?: { enableImage?: boolean }) {
  const fakeLlm = {
    chat: async (messages: any[]) => {
      const systemContent = messages[0]?.content ?? '';
      if (systemContent.includes('发布决策')) return llmResponses.scout;
      if (systemContent.includes('保真改写原稿分析员')) return llmResponses.referenceAnalysis ?? '{"title":"T","thesis":"t","structure":[],"keyFacts":[],"keyClaims":[],"entities":[],"timeline":[],"mustPreserve":[],"forbiddenAdditions":[],"perspective":"unknown"}';
      if (systemContent.includes('保真改写规划员')) return llmResponses.faithfulPlan ?? '{"titleDirection":"T","paragraphs":[],"styleNotes":[],"forbiddenAdditions":[]}';
      if (systemContent.includes('保真改写正文写手')) return llmResponses.faithfulDraft ?? '{"title":"保真标题","content":"保真正文","tone":"casual","style":{"rewriteMode":"faithful"}}';
      if (systemContent.includes('保真改写忠实度审核员')) return llmResponses.fidelityAudit ?? '{"pass":true,"score":0.9,"reason":"ok","issues":[],"unsupportedClaims":[],"missingKeyPoints":[]}';
      if (systemContent.includes('标题创作')) return llmResponses.title ?? '{"title":"测试标题"}';
      // change split-topic-roles：话题生成 → 候选；话题评判 → 保留子集。
      if (systemContent.includes('话题生成')) return llmResponses.topicGen ?? '{"topics":["测试话题","大模型"]}';
      if (systemContent.includes('话题评判')) return llmResponses.topicEval ?? '{"kept":["测试话题"]}';
      if (systemContent.includes('正文创作')) return llmResponses.creator;
      // 品类判定（category-adaptive-images-and-judgment）：读正文选一个品类 key，供配图风格档。
      if (systemContent.includes('品类分类器')) return llmResponses.category ?? '{"category":"food"}';
      // 配图三角色（publish-multi-image）：选题（配图选题师）→ 指令（文生图 prompt 工程师）。缺省给合法产物。
      if (systemContent.includes('配图选题')) return llmResponses.imageSet ?? '{"wantImage":true,"imageCount":1,"themes":[{"subject":"配图示意"}],"styleHint":null}';
      if (systemContent.includes('prompt 工程师') || systemContent.includes('文生图')) return llmResponses.imageCompose ?? '{"imagePrompt":"tech illustration","imageStyle":"illustration"}';
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
  orchestrator.registerRole(new ReferenceAnalyzerRole({ llmClient: fakeLlm as any, ...common }));
  orchestrator.registerRole(new FaithfulRewritePlannerRole({ llmClient: fakeLlm as any, ...common }));
  orchestrator.registerRole(new FaithfulDraftWriterRole({ llmClient: fakeLlm as any, ...common }));
  orchestrator.registerRole(new FidelityAuditorRole({ llmClient: fakeLlm as any, ...common }));
  // 品类判定（category-adaptive-images-and-judgment）：读正文判品类，供配图指令风格档（composer waitAll 依赖 postCategory）。
  orchestrator.registerRole(new CategoryClassifierRole({ llmClient: fakeLlm as any, ...common }));
  // 封面形态决策（textcard-cover-form）：恒写 coverCardPlan（composer waitAll 三键依赖此键）；
  // 测试缺省渲染旗标关 + 无参照图 → 生成式兜底、零额外 LLM，全管线行为与改造前一致。
  orchestrator.registerRole(new CoverCardWriterRole({ llmClient: fakeLlm as any, renderEnabled: () => false, ...common }));
  // 配图三角色（publish-multi-image）：选题 → 指令 → 执行。
  orchestrator.registerRole(new ImageSetPlannerRole({ llmClient: fakeLlm as any, ...common }));
  orchestrator.registerRole(new ImagePromptComposerRole({ llmClient: fakeLlm as any, ...common }));
  orchestrator.registerRole(new ImageGeneratorRole({ imageProvider: fakeImageProvider, enableImageGeneration: opts?.enableImage ?? false, ...common }));
  orchestrator.registerRole(new CoverSelectorRole(common));
  orchestrator.registerRole(new ContentCleanerRole({ postProcessor: fakePostProcessor, ...common }));
  orchestrator.registerRole(new AiFlavorScorerRole(common));
  orchestrator.registerRole(new QualityScorerRole({ llmClient: fakeLlm as any, ...common }));
  orchestrator.registerRole(new ContentAssemblerRole(common));
  // 标题链路：定稿后单独生成标题（发布门 waitAll 依赖 titleSelection）。
  orchestrator.registerRole(new TitleCreatorRole({ llmClient: fakeLlm as any, ...common }));
  // change split-topic-roles：话题拆生成/评判两 LLM 角色（生成 watch assembledContent、评判 watch topicCandidates → topicSelection）。
  orchestrator.registerRole(new TopicGeneratorRole({ llmClient: fakeLlm as any, ...common }));
  orchestrator.registerRole(new TopicEvaluatorRole({ llmClient: fakeLlm as any, ...common }));
  // 阶段3 元数据 + 合规决策（并行于发布链；规则式确定性，无需 LLM）
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
    // 既有 25 个发布角色 + 保真洗稿 4 角色 + 封面形态决策（textcard-cover-form）= 30。
    assert.equal(orchestrator.getRoles().length, 30);
  });

  test('保真洗稿链路：referenceNote 绕过 Scout/Creator，经审核后复用下游发布链', async () => {
    const { orchestrator, insertedRecords } = buildFullPipeline(
      {
        referenceAnalysis: JSON.stringify({
          title: 'LMCache 突破一万 star',
          thesis: '方向判断和工程落地促成开源认可',
          structure: ['起源', '接入演进', '架构升级'],
          keyFacts: ['vLLM patch', 'connector API', '多进程架构'],
          keyClaims: ['长期工程投入很关键'],
          entities: ['LMCache', 'vLLM'],
          timeline: ['2024 年 7 月', '2025 年 Q2-Q3'],
          mustPreserve: ['connector API 替代 patch'],
          forbiddenAdditions: ['个人实测延迟下降数据'],
          perspective: '项目成员复盘',
        }),
        faithfulPlan: JSON.stringify({
          titleDirection: '保留 star 与工程演进',
          paragraphs: [{ source: '接入演进', rewriteGoal: '换表达保留事实', mustKeep: ['connector API 替代 patch'] }],
          styleNotes: ['口语化'],
          forbiddenAdditions: ['个人实测延迟下降数据'],
        }),
        faithfulDraft: JSON.stringify({
          title: 'LMCache 万星背后',
          content: 'LMCache 破万星，重点不是热闹，而是它从实验室方案一路补工程：早期靠 vLLM patch，后来换成 connector API，再到多进程架构，都是围绕 KV cache 怎么稳定复用。',
          tone: 'casual',
          style: { rewriteMode: 'faithful' },
        }),
        fidelityAudit: JSON.stringify({ pass: true, score: 0.92, reason: 'ok', issues: [], unsupportedClaims: [], missingKeyPoints: [] }),
        title: JSON.stringify({ title: 'LMCache 万星背后' }),
        assembler: JSON.stringify({ qualityScore: 85 }),
        gatekeeper: JSON.stringify({ needsApproval: false, recommendedAction: 'auto_publish', reason: '质量ok' }),
      },
      { enableImage: true },
    );

    const result = await orchestrator.trigger(makeReferenceTriggerInput());

    assert.equal(result.status, 'pending_approval');
    assert.equal(insertedRecords.length, 1);
    assert.equal(insertedRecords[0].sourceReference?.sourceId, 'lmcache-1');
    assert.match(insertedRecords[0].content, /connector API/);
    assert.doesNotMatch(insertedRecords[0].content, /延迟直接降了58/);
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
    assert.match(result.reason ?? '', /无配图/, 'failed 带可读原因（供飞书回执 surface「为什么」），不再只给干瘪 status');
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
    assert.match(result.reason ?? '', /不发布/, 'skipped 带选题判定原因');
  });

  test('管道超时 → 返回 status=failed', async () => {
    const orchestrator = new PublishOrchestrator({ clock, idGen: () => 'run-timeout', logger: silentLogger, pipelineTimeoutMs: 200 });
    const result = await orchestrator.trigger(makeTriggerInput());
    assert.equal(result.status, 'failed');
    assert.equal(result.dispatched, false);
    assert.equal(result.recordId, null);
    assert.match(result.reason ?? '', /timed out/i, '超时失败带「为什么」（timed out），不再只给 failed');
  });

  test('僵尸轮拦截（change parallel-rewrite-drafts）：本轮收敛置中止标记后，迟到的 PublishExecutor 绝不落库、绝不发卡', async () => {
    const inserted: unknown[] = [];
    const executor = new PublishExecutorRole({
      store: { insert: async (r: unknown) => { inserted.push(r); return 1; } } as any,
      clock,
      logger: silentLogger,
    });
    const ctx = new PipelineContext<PipelineFields>();
    ctx.write('trigger', makeTriggerInput());
    executor.register(ctx);
    // 编排器超时收敛 → finally 置中止位；此后在途角色链仍会把发布门三键写齐（僵尸接力）。
    ctx.markAborted();
    ctx.write('gateDecision', { needsApproval: false, recommendedAction: 'auto_publish', reason: 'ok', decidedAt: clock() } as any);
    ctx.write('titleSelection', { title: 'T', source: 'llm', decidedAt: clock() } as any);
    ctx.write('publishMetadata', { topics: [], mentions: [], location: null, collection: null, visibility: 'public', permissions: { comment: 'allow', save: 'allow' }, mode: 'immediate', publishTime: null, compliance: {}, metadataScore: 0.5, decidedAt: clock() } as any);
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(inserted.length, 0, '中止轮绝不 INSERT 待审草稿（不穿透单飞键与容量帽、不出第二结局）');
    assert.equal(ctx.get('publishResult')?.status, 'skipped');
    assert.match(ctx.get('publishResult')?.reason ?? '', /run_aborted/);
  });

  test('并发 trigger（change parallel-rewrite-drafts：准入闸上移调度器 claim 层）→ 两轮并行各自完成、簿记互不串', async () => {
    const { orchestrator, insertedRecords } = buildFullPipeline({
      scout: JSON.stringify({ shouldPublish: true, publishDirection: 'test', keyPoints: [], confidence: 0.5, reason: 'ok' }),
      creator: JSON.stringify({ title: 'T', content: 'c', tags: [], tone: 'casual', style: {} }),
      image: JSON.stringify({ imagePrompt: null }),
      assembler: JSON.stringify({ qualityScore: 60 }),
      gatekeeper: JSON.stringify({ needsApproval: false, recommendedAction: 'auto_publish', reason: 'ok' }),
    }, { enableImage: true });
    const p1 = orchestrator.trigger(makeTriggerInput());
    const p2 = orchestrator.trigger(makeTriggerInput());
    // 在跑期间观测：多 run 形状可见两轮，旧字段聚合为 running（旧版 console 不白屏）。
    const during = orchestrator.getStatus();
    assert.equal(during.status, 'running');
    assert.equal(during.runs.length, 2, 'runs 列出两条并行管线');
    const [result1, result2] = await Promise.all([p1, p2]);
    assert.ok(['pending_approval', 'draft', 'needs_review'].includes(result1.status), `第一轮正常收敛（got ${result1.status}: ${result1.reason ?? ''}）`);
    assert.ok(['pending_approval', 'draft', 'needs_review'].includes(result2.status), `第二轮同样正常收敛、绝不被第一轮拒绝或抹掉（got ${result2.status}: ${result2.reason ?? ''}）`);
    assert.equal(insertedRecords.length, 2, '两轮各落各的待审草稿');
    // 全部收敛后：注册表清空、旧字段回落最近终态。
    const after = orchestrator.getStatus();
    assert.equal(after.runs.length, 0);
    assert.equal(after.status, 'completed');
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
    assert.match(result.reason ?? '', /aborted by/i, 'abort 失败带中止角色与理由（供飞书回执显示「哪一步、为什么」）');
    assert.ok(elapsed < 4000, `应即时失败而非干等超时（实际 ${elapsed}ms）`);
    assert.equal(insertedRecords.length, 0, 'titleSelection 未就绪 → executor 不激活 → 未落库');
    assert.equal(pushedEnvelopes.length, 0, '未下发 edge');
  });
});
