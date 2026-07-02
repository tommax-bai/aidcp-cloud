import { BasePublishRole } from './base-role.js';
import type { RoleConfig } from './base-role.js';
import type { PipelineFields, ImageSetPlan, ImagePlan, ImageTheme, ImageCategory } from '../types.js';
import { buildImagePromptComposerPrompt, resolveStyleProfile } from '../prompts.js';
import type { ChatLlmClient } from '../../llm/qwen.js';

/**
 * ImagePromptComposer — 配图「指令」（change publish-multi-image；change category-adaptive-images-and-judgment 起按品类风格档）。
 * waitAll [imageSetPlan, postCategory] → 把每张图的主题翻成一条**中文**主体描述，拼上本帖【品类风格档】
 * （图0封面变体、图1..N内页 styleBase，逐字复用 → 帖内一致；帖间因品类而异），写 imagePlan。
 * 红线：
 * - 决策与执行解耦——只产 prompt、绝不调图源。
 * - 风格基底为品类风格档（模板常量派生），MUST NOT 由 LLM 产（图集风格统一）。
 * - 去重护栏：主体近重复即丢那张（不补不复用），但**永远保住第 0 张**（封面位）；wantImage:true → 去重后恒 ≥1。
 * - 主体保留中文（原生喂 Seedream）；不再产 imageStyle 枚举、不再由 provider 二次拼风格（去第二风格源）。
 */

// change raise-model-call-timeouts-for-thinking-models：每主题一条 prompt 是文本 LLM 调用（并行 Promise.all，
// 墙钟=最慢单次），角色闸 ≥ 单次模型天花板（180s）且同传进每次 chat()（旧 45s 峰值必误超时→退回主体文本）。env 可调。
const IMAGE_PROMPT_TIMEOUT_MS = Number(process.env.AIDCP_PUBLISH_IMGPROMPT_TIMEOUT_MS ?? 180_000);

/** waitAll 输入：图集选题 + 本帖品类（来自 CategoryClassifier）。 */
interface ComposerInput {
  plan: ImageSetPlan;
  category: ImageCategory;
}

export interface ImagePromptComposerDeps {
  llmClient: ChatLlmClient;
  /** 近重复 Jaccard 阈值（主体 token 集），≥ 此值判近重复丢弃（默认 0.85）。 */
  dedupThreshold?: number;
  clock?: () => number;
  logger?: Pick<Console, 'log' | 'warn' | 'error'>;
}

export class ImagePromptComposerRole extends BasePublishRole<ComposerInput, ImagePlan> {
  readonly config: RoleConfig = {
    name: 'ImagePromptComposer',
    watchKeys: ['imageSetPlan', 'postCategory'],
    waitAll: true,
    timeoutMs: IMAGE_PROMPT_TIMEOUT_MS,
    fallback: 'default',
  };
  protected readonly outputKey = 'imagePlan' as const;
  private llmClient: ChatLlmClient;
  private dedupThreshold: number;

  constructor(deps: ImagePromptComposerDeps) {
    super({ logger: deps.logger, clock: deps.clock });
    this.llmClient = deps.llmClient;
    this.dedupThreshold = deps.dedupThreshold ?? 0.85;
  }

  protected extractInput(snapshot: Partial<PipelineFields>): ComposerInput {
    return {
      plan: snapshot.imageSetPlan!,
      category: snapshot.postCategory?.category ?? 'general',
    };
  }

  protected async execute(input: ComposerInput): Promise<ImagePlan> {
    const plan = input.plan;
    if (!plan.wantImage || plan.themes.length === 0) {
      return this.emptyPlan();
    }

    // 每主题一条中文主体描述（并行，保序；某条 LLM 失败退回主体文本 fallback，不让该张凭空消失）。
    const composed = await Promise.all(
      plan.themes.map((theme) => this.composeTheme(theme, plan.styleHint)),
    );

    // 去重护栏：按主体近重复比对，命中即丢——但永远保住第 0 张（封面位）。
    const kept: string[] = [];
    const keptTokens: Set<string>[] = [];
    composed.forEach((desc, idx) => {
      if (idx === 0) {
        kept.push(desc);
        keptTokens.push(tokenize(desc));
        return;
      }
      const tks = tokenize(desc);
      const dup = keptTokens.some((prev) => jaccard(prev, tks) >= this.dedupThreshold);
      if (dup) {
        this.logger.log(`[ImagePromptComposer] 近重复主体丢弃第 ${idx} 张（不补不复用）`);
        return;
      }
      kept.push(desc);
      keptTokens.push(tks);
    });

    // 拼本帖品类风格档（系统注入，非 LLM 产）：图0封面变体、图1..N内页 styleBase，逐字复用守帧内一致。
    const profile = resolveStyleProfile(input.category);
    const imagePrompts = kept.map(
      (desc, i) => `${desc}. ${i === 0 ? profile.coverStyleBase : profile.styleBase}`,
    );

    return {
      wantImage: true,
      imagePrompts,
      imageStyle: null, // 风格由品类风格档承载；不再产枚举、不再由 provider 二次拼（去第二风格源）
      imageCount: imagePrompts.length,
      fallbackStrategy: 'skip',
      plannedAt: this.clock(),
    };
  }

  protected override getDefaultOutput(): ImagePlan {
    return this.emptyPlan();
  }

  private emptyPlan(): ImagePlan {
    return { wantImage: false, imagePrompts: [], imageStyle: null, imageCount: 0, fallbackStrategy: 'skip', plannedAt: this.clock() };
  }

  /** 单主题 → 中文主体描述；LLM 失败退回主体文本（该张不凭空消失，图像模型可吃中文主体）。 */
  private async composeTheme(theme: ImageTheme, styleHint: string | null): Promise<string> {
    try {
      const raw = await this.llmClient.chat([
        { role: 'system', content: '你是文生图 prompt 工程师。严格返回JSON。' },
        { role: 'user', content: buildImagePromptComposerPrompt(theme, styleHint) },
      ], { timeoutMs: IMAGE_PROMPT_TIMEOUT_MS });
      const match = raw.match(/\{[\s\S]*\}/);
      if (!match) throw new Error('no json');
      const obj = JSON.parse(match[0]) as { imagePrompt?: unknown };
      const description = String(obj.imagePrompt ?? '').trim();
      if (!description) throw new Error('empty imagePrompt');
      return description;
    } catch (err) {
      this.logger.warn(`[ImagePromptComposer] 主题「${theme.subject}」LLM 失败，退回主体文本: ${err instanceof Error ? err.message : String(err)}`);
      return theme.intent ? `${theme.subject}，${theme.intent}` : theme.subject;
    }
  }
}

/** 归一化为 token 集（小写、只留字母数字与 CJK、按空白切）。 */
function tokenize(s: string): Set<string> {
  return new Set(
    s
      .toLowerCase()
      .replace(/[^a-z0-9一-龥]+/g, ' ')
      .trim()
      .split(' ')
      .filter(Boolean),
  );
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}
