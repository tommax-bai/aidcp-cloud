import { BasePublishRole } from './base-role.js';
import type { RoleConfig } from './base-role.js';
import type { PipelineFields, ImageSetPlan, ImagePlan, ImageTheme } from '../types.js';
import { buildImagePromptComposerPrompt, IMAGE_STYLE_BASE } from '../prompts.js';
import type { ChatLlmClient } from '../../llm/qwen.js';

/**
 * ImagePromptComposer — 配图「指令」（change publish-multi-image，从旧 ImagePlanner 拆出 Step 2）。
 * watch imageSetPlan → 把每张图的主题翻成一条万相 prompt（各异主体 + 共享固定风格基底 IMAGE_STYLE_BASE），写 imagePlan。
 * 红线：
 * - 决策与执行解耦——只产 prompt、绝不调图源。
 * - 风格基底为模板常量、MUST NOT 由 LLM 产（图集风格统一）。
 * - 去重护栏：主体近重复即丢那张（不补不复用），但**永远保住第 0 张**（封面位）；wantImage:true → 去重后恒 ≥1。
 */

const IMAGE_STYLES: NonNullable<ImagePlan['imageStyle']>[] = ['photography', 'illustration', 'dataviz', 'isometric'];

// change raise-model-call-timeouts-for-thinking-models：每主题一条 prompt 是文本 LLM 调用（并行 Promise.all，
// 墙钟=最慢单次），角色闸 ≥ 单次模型天花板（180s）且同传进每次 chat()（旧 45s 峰值必误超时→退回主体文本）。env 可调。
const IMAGE_PROMPT_TIMEOUT_MS = Number(process.env.AIDCP_PUBLISH_IMGPROMPT_TIMEOUT_MS ?? 180_000);

export interface ImagePromptComposerDeps {
  llmClient: ChatLlmClient;
  /** 近重复 Jaccard 阈值（主体 token 集），≥ 此值判近重复丢弃（默认 0.85）。 */
  dedupThreshold?: number;
  clock?: () => number;
  logger?: Pick<Console, 'log' | 'warn' | 'error'>;
}

interface ComposedTheme {
  description: string;
  style: ImagePlan['imageStyle'];
}

export class ImagePromptComposerRole extends BasePublishRole<ImageSetPlan, ImagePlan> {
  readonly config: RoleConfig = {
    name: 'ImagePromptComposer',
    watchKeys: ['imageSetPlan'],
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

  protected extractInput(snapshot: Partial<PipelineFields>): ImageSetPlan {
    return snapshot.imageSetPlan!;
  }

  protected async execute(input: ImageSetPlan): Promise<ImagePlan> {
    if (!input.wantImage || input.themes.length === 0) {
      return this.emptyPlan();
    }

    // 每主题一条 prompt（并行，保序；某条 LLM 失败退回主体文本 fallback，不让该张凭空消失）。
    const composed = await Promise.all(
      input.themes.map((theme) => this.composeTheme(theme, input.styleHint)),
    );

    // 去重护栏：按主体近重复比对，命中即丢——但永远保住第 0 张（封面位）。
    const kept: ComposedTheme[] = [];
    const keptTokens: Set<string>[] = [];
    composed.forEach((c, idx) => {
      if (idx === 0) {
        kept.push(c);
        keptTokens.push(tokenize(c.description));
        return;
      }
      const tks = tokenize(c.description);
      const dup = keptTokens.some((prev) => jaccard(prev, tks) >= this.dedupThreshold);
      if (dup) {
        this.logger.log(`[ImagePromptComposer] 近重复主体丢弃第 ${idx} 张（不补不复用）`);
        return;
      }
      kept.push(c);
      keptTokens.push(tks);
    });

    // 拼固定风格基底（系统注入，非 LLM 产）。imagePrompts 恒非空（保住了 [0]）。
    const imagePrompts = kept.map((c) => `${c.description}. ${IMAGE_STYLE_BASE}`);
    const imageStyle = kept.map((c) => c.style).find((s): s is NonNullable<ImagePlan['imageStyle']> => !!s) ?? 'illustration';

    return {
      wantImage: true,
      imagePrompts,
      imageStyle,
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

  /** 单主题 → 主体描述 + 风格枚举；LLM 失败退回主体文本（该张不凭空消失，万相可吃中文主体）。 */
  private async composeTheme(theme: ImageTheme, styleHint: string | null): Promise<ComposedTheme> {
    try {
      const raw = await this.llmClient.chat([
        { role: 'system', content: '你是文生图 prompt 工程师。严格返回JSON。' },
        { role: 'user', content: buildImagePromptComposerPrompt(theme, styleHint) },
      ], { timeoutMs: IMAGE_PROMPT_TIMEOUT_MS });
      const match = raw.match(/\{[\s\S]*\}/);
      if (!match) throw new Error('no json');
      const obj = JSON.parse(match[0]) as { imagePrompt?: unknown; imageStyle?: unknown };
      const description = String(obj.imagePrompt ?? '').trim();
      if (!description) throw new Error('empty imagePrompt');
      const style = IMAGE_STYLES.includes(obj.imageStyle as NonNullable<ImagePlan['imageStyle']>)
        ? (obj.imageStyle as ImagePlan['imageStyle'])
        : 'illustration';
      return { description, style };
    } catch (err) {
      this.logger.warn(`[ImagePromptComposer] 主题「${theme.subject}」LLM 失败，退回主体文本: ${err instanceof Error ? err.message : String(err)}`);
      const fallback = theme.intent ? `${theme.subject}, ${theme.intent}` : theme.subject;
      return { description: fallback, style: 'illustration' };
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
