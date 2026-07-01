/**
 * 发布侧 prompt 只读预览的示例输入注册表（change publish-prompt-preview）。
 *
 * 与浏览侧角色实例的 previewPrompt() 并列：浏览侧调角色真实 buildPrompt(示例数据)，
 * 发布侧这里用最小合法示例输入调发布管线**既有的** build*Prompt 函数，渲染出忠实 prompt 文本。
 *
 * 铁律：
 * - 只调既有 build*Prompt、**绝不改其逻辑**（线上 prompt 行为零变化）。
 * - 示例入参用 types.ts 的类型对齐（编译期锁形状），占位串沿用浏览侧 `<示例…>` 约定；实时字段一望即知是占位。
 * - 发布正文人设为构建函数**内置默认**（如文案创作内置人设），**不随账号切换**——故本注册表不接账号口径。
 * - 配图生成执行（publish:ImageGenerator）确实无文本 prompt（吃配图指令输出 + 固定风格常量），不在此注册。
 */

import type { Soul } from '../soul/types.js';
import type { TriggerInput, ScoutDecision, CreatedContent, AssembledContent } from './types.js';
import {
  buildScoutPrompt,
  buildCreatorPrompt,
  buildTitlePrompt,
  buildImageSetPlanPrompt,
  buildImagePromptComposerPrompt,
  buildAssemblerPrompt,
  buildGatekeeperPrompt,
  IMAGE_COUNT_HARD_MAX,
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
    concepts: [{ keyword: '<示例技术概念>', sourceNote: '<示例来源笔记>' }],
    likedContents: [{ id: 0, title: '<示例点赞笔记标题>', summary: '<示例摘要>', author: '<示例作者>' }],
    soul: EXAMPLE_SOUL,
    recentPosts: [],
  },
  recentPublished: ['<示例最近已发布标题>'],
  forced: false,
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
 * 闭包用示例入参调既有 build*Prompt；预览提供方按此表忠实渲染发布侧文本角色。
 */
export const PUBLISH_PREVIEW_BUILDERS: Record<string, () => string> = {
  'publish:ContentScout': () => buildScoutPrompt(EXAMPLE_TRIGGER),
  'publish:ContentCreator': () => buildCreatorPrompt(EXAMPLE_SCOUT, EXAMPLE_TRIGGER),
  'publish:TitleCreator': () =>
    buildTitlePrompt(EXAMPLE_CREATED.content, '<示例账号人设>', '踩坑记录', '<示例草稿期标题>'),
  'publish:ImageSetPlanner': () => buildImageSetPlanPrompt(EXAMPLE_CREATED, IMAGE_COUNT_HARD_MAX),
  'publish:ImagePromptComposer': () =>
    buildImagePromptComposerPrompt({ subject: '<示例配图主体>', intent: '<示例配图要点>' }, '科技扁平'),
  'publish:QualityScorer': () => buildAssemblerPrompt(EXAMPLE_CREATED, EXAMPLE_POST_PROCESS),
  'publish:ApprovalGatekeeper': () => buildGatekeeperPrompt(EXAMPLE_ASSEMBLED),
};
