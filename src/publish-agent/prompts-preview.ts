/**
 * 发布侧 prompt 只读预览的示例输入注册表（change publish-prompt-preview）。
 *
 * 与浏览侧角色实例的 previewPrompt() 并列：浏览侧调角色真实 buildPrompt(示例数据)，
 * 发布侧这里用最小合法示例输入调发布管线**既有的** build*Prompt 函数，渲染出忠实 prompt 文本。
 *
 * 铁律：
 * - 只调既有 build*Prompt、**绝不改其逻辑**（线上 prompt 行为零变化）。
 * - 示例入参用 types.ts 的类型对齐（编译期锁形状），占位串沿用浏览侧 `<示例…>` 约定；实时字段一望即知是占位。
 * - 默认用示例人设；预览提供方可传入选定账号人设，构造同形示例输入后忠实渲染（生产发布同样吃账号人设）。
 * - 配图生成执行（publish:ImageGenerator）确实无文本 prompt（吃配图指令输出 + 固定风格常量），不在此注册。
 */

import type { Soul } from '../soul/types.js';
import type {
  TriggerInput,
  ScoutDecision,
  CreatedContent,
  AssembledContent,
  ReferenceAnalysis,
  FaithfulRewritePlan,
  FaithfulDraft,
} from './types.js';
import {
  buildScoutPrompt,
  buildCreatorPrompt,
  buildReferenceAnalysisPrompt,
  buildFaithfulRewritePlanPrompt,
  buildFaithfulDraftPrompt,
  buildFidelityAuditPrompt,
  buildTitlePrompt,
  buildImageSetPlanPrompt,
  buildImagePromptComposerPrompt,
  buildCategoryClassifierPrompt,
  buildAssemblerPrompt,
  buildGatekeeperPrompt,
  buildDeAiRewritePrompt,
  buildTopicGenerationPrompt,
  buildTopicEvaluationPrompt,
  IMAGE_COUNT_HARD_MAX,
  resolveStyleProfile,
} from './prompts.js';

// —— 最小合法示例输入（仅供预览渲染；不触发任何真实发布）——

const EXAMPLE_SOUL: Soul = {
  identity: {
    name: '<示例账号>',
    role: '<示例角色定位>',
    background: '<示例背景>',
    tone: '<示例语气>',
  },
  interests: { primary: ['<示例兴趣领域>'], secondary: [], seed_keywords: ['<示例关键词>'] },
};

const EXAMPLE_TRIGGER: TriggerInput = {
  metrics: { hoursSinceLastPublish: 12, newConceptCount: 3, likedSinceLastPublish: 6 },
  generateInput: {
    concepts: [{ keyword: '<示例概念>', sourceNote: '<示例来源笔记>' }],
    likedContents: [{ id: 0, title: '<示例点赞笔记标题>', summary: '<示例摘要>', author: '<示例作者>' }],
    soul: EXAMPLE_SOUL,
    recentPosts: [],
  },
  recentPublished: ['<示例最近已发布标题>'],
  forced: false,
};

function triggerWithSoul(soul: Soul = EXAMPLE_SOUL): TriggerInput {
  return {
    ...EXAMPLE_TRIGGER,
    generateInput: {
      ...EXAMPLE_TRIGGER.generateInput,
      soul,
    },
  };
}

function personaLine(soul: Soul = EXAMPLE_SOUL): string {
  const { identity } = soul;
  return `${identity.role}｜${identity.background}（语气：${identity.tone}）`;
}

const EXAMPLE_REFERENCE_NOTE: NonNullable<TriggerInput['generateInput']['referenceNote']> = {
  sourceId: '<示例原稿sourceId>',
  title: '<示例原稿标题>',
  body: '示例原稿正文：项目从实验室走向开源社区，先通过 patch 接入推理框架，后来改为 connector API，并在 agentic workload 增长后升级到多进程架构。',
  topics: ['开源项目', '推理优化'],
  author: '<示例作者>',
};

const EXAMPLE_REFERENCE_ANALYSIS: ReferenceAnalysis = {
  sourceId: EXAMPLE_REFERENCE_NOTE.sourceId,
  title: EXAMPLE_REFERENCE_NOTE.title,
  thesis: '开源项目被认可来自方向判断和长期工程投入。',
  structure: ['里程碑', '早期动机', '接入方式演进', '工业需求出现', '多进程架构升级', '总结'],
  keyFacts: ['曾通过 patch 接入推理框架', '后来改为 connector API', 'agentic workload 增长后需要外置 KV cache'],
  keyClaims: ['方向判断和工程落地共同促成项目被使用'],
  entities: ['LMCache', 'vLLM'],
  timeline: ['2024 年 7 月', '2025 年 Q2-Q3'],
  mustPreserve: ['项目演进脉络', 'connector API 替代 patch', '工业界接入需求', '多进程架构升级原因'],
  forbiddenAdditions: ['个人实测延迟下降数据', '未出现的公司业务场景', '未出现的使用者亲历'],
  perspective: '项目成员复盘',
  analyzedAt: 0,
};

const EXAMPLE_FAITHFUL_PLAN: FaithfulRewritePlan = {
  titleDirection: '保留里程碑与原因复盘，不改成使用测评',
  paragraphs: [
    {
      source: '项目突破 star 与起源',
      rewriteGoal: '换成更短的社媒开头，但仍说明项目演进背景',
      mustKeep: ['项目突破 star', '实验室到开源项目'],
    },
  ],
  styleNotes: ['口语化，但不要伪装成亲测经验'],
  forbiddenAdditions: EXAMPLE_REFERENCE_ANALYSIS.forbiddenAdditions,
  plannedAt: 0,
};

const EXAMPLE_FAITHFUL_DRAFT: FaithfulDraft = {
  title: '<示例保真改写标题>',
  content: '<示例保真改写正文>',
  tone: 'casual',
  style: { rewriteMode: 'faithful' },
  draftedAt: 0,
};

const EXAMPLE_SCOUT: ScoutDecision = {
  shouldPublish: true,
  publishDirection: '<示例发布方向>',
  keyPoints: ['<示例要点1>', '<示例要点2>', '<示例要点3>'],
  confidence: 0.8,
  reason: '<示例判断理由>',
  scoutedAt: 0,
};

const EXAMPLE_CREATED: CreatedContent = {
  title: '<示例正文标题>',
  content: '<示例正文内容：这里是一段供预览用的占位正文，线上由文案创作角色真实产出。>',
  tags: ['<示例标签1>', '<示例标签2>'],
  tone: 'casual',
  style: { type: '踩坑记录' },
  createdAt: 0,
};

const EXAMPLE_ASSEMBLED: AssembledContent = {
  finalContent: '<示例定稿正文：供预览用的占位正文，线上由内容组装角色产出。>',
  finalTags: ['<示例标签1>', '<示例标签2>'],
  imageUrls: [],
  imageUrl: null,
  aiScore: 0.1,
  qualityScore: 82,
  rewritten: false,
  flaggedPhrases: [],
  assembledAt: 0,
};

const EXAMPLE_POST_PROCESS = { aiScore: 0.1, flaggedPhrases: [] as string[], rewritten: false };

/**
 * roleId（含 `publish:` 前缀，与 role-catalog 一致）→ 渲染闭包。
 * 闭包用示例入参调既有 build*Prompt；可传入账号人设以替换示例人设。
 */
export type PublishPreviewBuilder = (soul?: Soul) => string;

export const PUBLISH_PREVIEW_BUILDERS: Record<string, PublishPreviewBuilder> = {
  'publish:ContentScout': (soul) => buildScoutPrompt(triggerWithSoul(soul)),
  'publish:ContentCreator': (soul) => buildCreatorPrompt(EXAMPLE_SCOUT, triggerWithSoul(soul)),
  'publish:ReferenceAnalyzer': (soul) => buildReferenceAnalysisPrompt(EXAMPLE_REFERENCE_NOTE, soul ?? EXAMPLE_SOUL),
  'publish:FaithfulRewritePlanner': (soul) =>
    buildFaithfulRewritePlanPrompt(EXAMPLE_REFERENCE_ANALYSIS, EXAMPLE_REFERENCE_NOTE, soul ?? EXAMPLE_SOUL),
  'publish:FaithfulDraftWriter': (soul) =>
    buildFaithfulDraftPrompt(EXAMPLE_REFERENCE_ANALYSIS, EXAMPLE_FAITHFUL_PLAN, EXAMPLE_REFERENCE_NOTE, soul ?? EXAMPLE_SOUL),
  'publish:FidelityAuditor': () =>
    buildFidelityAuditPrompt(EXAMPLE_REFERENCE_ANALYSIS, EXAMPLE_FAITHFUL_PLAN, EXAMPLE_FAITHFUL_DRAFT, EXAMPLE_REFERENCE_NOTE),
  'publish:TitleCreator': (soul) =>
    buildTitlePrompt(EXAMPLE_CREATED.content, personaLine(soul), '踩坑记录', '<示例草稿期标题>'),
  'publish:ImageSetPlanner': () => buildImageSetPlanPrompt(EXAMPLE_CREATED, IMAGE_COUNT_HARD_MAX),
  'publish:CategoryClassifier': () =>
    buildCategoryClassifierPrompt(EXAMPLE_CREATED.title, EXAMPLE_CREATED.content),
  'publish:ImagePromptComposer': () =>
    buildImagePromptComposerPrompt({ subject: '<示例配图主体>', intent: '<示例配图要点>' }, '温暖生活感'),
  'publish:QualityScorer': (soul) => buildAssemblerPrompt(EXAMPLE_CREATED, EXAMPLE_POST_PROCESS, soul ?? EXAMPLE_SOUL, 'knowledge'),
  'publish:ApprovalGatekeeper': () => buildGatekeeperPrompt(EXAMPLE_ASSEMBLED),
  'publish:TopicGenerator': (soul) => buildTopicGenerationPrompt(EXAMPLE_ASSEMBLED.finalContent, personaLine(soul)),
  'publish:TopicEvaluator': () =>
    buildTopicEvaluationPrompt(['<示例话题1>', '<示例话题2>', '<示例话题3>'], '', EXAMPLE_ASSEMBLED.finalContent),
  // 正文去 AI 味改写（ContentCleaner）：prompt 与 server.ts 注入的 rewrite 同源（buildDeAiRewritePrompt）。
  'publish:ContentCleaner': () =>
    buildDeAiRewritePrompt(EXAMPLE_CREATED.content, ['首先', '过量感叹号']),
};

// —— 图像角色（配图生成执行）：发给文生图模型的「有效图片指令」预览 ——
// 图片角色不调文本大模型，但它发给文生图模型的图片指令 = 「配图指令」角色按正文产出的中文主体描述
// （此处为示例）+ 系统按【内容品类】追加的品类风格档 styleBase。风格档随品类而变（此处以「美食」档示例），
// 承载风格/光线/色板/人物/负向约束——本预览把它显性化。
const EXAMPLE_IMAGE_SUBJECT =
  '一碗热气腾腾的番茄牛腩面摆在原木餐桌上，斜上方45度俯拍，撒着葱花';

/** roleId → 图片指令渲染闭包（示例中文主体 + 品类风格档，以美食档示例），与文本预览分开，供图像分支使用。 */
export const IMAGE_PROMPT_PREVIEW_BUILDERS: Record<string, () => string> = {
  'publish:ImageGenerator': () => `${EXAMPLE_IMAGE_SUBJECT}. ${resolveStyleProfile('food').styleBase}`,
};
