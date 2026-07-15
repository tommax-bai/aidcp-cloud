import { BasePublishRole } from './base-role.js';
import type { RoleConfig } from './base-role.js';
import type { PipelineContext } from '../pipeline-context.js';
import type { PipelineFields, CreatedContent, ImageSetPlan, ImageTheme, ReferenceImageSnapshot } from '../types.js';
import { buildImageSetPlanPrompt, IMAGE_COUNT_HARD_MAX } from '../prompts.js';
import { referenceImagesForGeneration } from '../reference-image-guidance.js';
import { executeWithFallback } from '../retry-strategy.js';
import type { ChatLlmClient } from '../../llm/qwen.js';
import type { ContentVisualBrief } from '../visual-reference-types.js';

/**
 * ImageSetPlanner — 配图「选题」（change publish-multi-image，从旧 ImagePlanner 拆出 Step 1）。
 * LLM 读正文决定：配几张 + 每张画什么主体（业务语言）+ 风格倾向；写 imageSetPlan。
 * 红线：决策与执行解耦——只产选题、绝不产万相 prompt、绝不调图源。
 * 图文帖必须有图：张数恒 clamp 到 [1, maxImages≤9]；LLM 失败降级朝「更少图」退（1 张通用主题），键必写不死锁。
 * change rewrite-image-count-parity：洗稿帖张数对齐源稿有效图数（≤maxImages），非洗稿维持内容驱动。
 */

const DEFAULT_MAX_IMAGES = 9;

// change raise-model-call-timeouts-for-thinking-models：配图选题是文本 LLM 调用，角色闸 ≥ 单次模型天花板（180s）
// 且同传进 chat()（旧 30s 峰值必误超时→退化为 1 张通用主题）。env 可调。注意：这是文本选题，非万相生图（生图闸另计）。
const IMAGE_SET_PLAN_TIMEOUT_MS = Number(process.env.AIDCP_PUBLISH_IMGSETPLAN_TIMEOUT_MS ?? 180_000);

function resolveMaxImages(): number {
  const raw = Number(process.env.AIDCP_PUBLISH_MAX_IMAGES);
  const n = Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : DEFAULT_MAX_IMAGES;
  return Math.max(1, Math.min(n, IMAGE_COUNT_HARD_MAX));
}

export interface ImageSetPlannerDeps {
  llmClient: ChatLlmClient;
  /** 张数上限（缺省读 env AIDCP_PUBLISH_MAX_IMAGES，默认 3，硬夹 ≤9）。 */
  maxImages?: number;
  clock?: () => number;
  logger?: Pick<Console, 'log' | 'warn' | 'error'>;
}

interface ParsedPlan {
  imageCount: number;
  themes: ImageTheme[];
  styleHint: string | null;
}

export class ImageSetPlannerRole extends BasePublishRole<CreatedContent, ImageSetPlan> {
  readonly config: RoleConfig = {
    name: 'ImageSetPlanner',
    watchKeys: ['createdContent'],
    timeoutMs: IMAGE_SET_PLAN_TIMEOUT_MS,
    fallback: 'default',
  };
  protected readonly outputKey = 'imageSetPlan' as const;
  private llmClient: ChatLlmClient;
  private maxImages: number;

  constructor(deps: ImageSetPlannerDeps) {
    super({ logger: deps.logger, clock: deps.clock });
    this.llmClient = deps.llmClient;
    this.maxImages = Math.max(1, Math.min(deps.maxImages ?? resolveMaxImages(), IMAGE_COUNT_HARD_MAX));
  }

  protected extractInput(snapshot: Partial<PipelineFields>): CreatedContent {
    return snapshot.createdContent!;
  }

  protected async execute(input: CreatedContent, context: PipelineContext<PipelineFields>): Promise<ImageSetPlan> {
    // 洗稿对齐（rewrite-image-count-parity）：源参照笔记有效图 ≥1 张 → 目标张数 = clamp(有效源图数, 1, maxImages)；
    // 有效口径同生图参考图（referenceImagesForGeneration）。非洗稿 / 无有效源图 → undefined，维持内容驱动。
    const refImages = context.snapshot().trigger?.generateInput?.referenceNote?.images ?? [];
    const usableSourceImages = referenceImagesForGeneration(refImages);
    const usableSourceCount = usableSourceImages.length;
    const targetCount = usableSourceCount >= 1 ? Math.min(usableSourceCount, this.maxImages) : undefined;

    const { result, usedFallback } = await executeWithFallback<ParsedPlan | null>(
      async () => {
        const raw = await this.llmClient.chat([
          { role: 'system', content: '你是配图选题师。严格返回JSON。' },
          { role: 'user', content: buildImageSetPlanPrompt(input, this.maxImages, targetCount) },
        ], { timeoutMs: IMAGE_SET_PLAN_TIMEOUT_MS, accountId: this.accountIdFrom(context) });
        return this.parse(raw);
      },
      { default: null, reason: 'ImageSetPlanner LLM failed' },
    );

    if (usedFallback || !result) {
      this.logger.warn('[ImageSetPlanner] LLM 失败，降级朝更少图退（1 张通用主题）');
      return this.degradePlan(input, targetCount, usableSourceImages);
    }
    return this.buildPlan(result, input, targetCount, usableSourceImages);
  }

  protected override getDefaultOutput(): ImageSetPlan {
    // 键必写（不死锁）：正文可能缺，用通用主题占位、保 1 张（图文帖必须有图）。
    return { wantImage: true, imageCount: 1, themes: [{ subject: '文章主题示意图' }], styleHint: null, plannedAt: this.clock() };
  }

  /** LLM 失败降级：图文帖必须有图 → 保 1 张，主体取标题（通用示意）。 */
  private degradePlan(
    input: CreatedContent,
    targetCount?: number,
    sourceImages: ReferenceImageSnapshot[] = [],
  ): ImageSetPlan {
    const subject = (input.title || '文章主题').slice(0, 24);
    const count = targetCount ?? 1;
    const themes = Array.from({ length: count }, (_, i) => this.bindSource(
      this.withFallbackBrief(
        { subject: i === 0 ? `${subject} 主题示意` : `${subject} 补充图 ${i + 1}` },
        input,
      ),
      sourceImages?.[i],
      i,
    ));
    return { wantImage: true, imageCount: themes.length, themes, styleHint: null, plannedAt: this.clock() };
  }

  private buildPlan(
    p: ParsedPlan,
    input: CreatedContent,
    targetCount?: number,
    sourceImages: ReferenceImageSnapshot[] = [],
  ): ImageSetPlan {
    // 洗稿对齐时张数钉死为 targetCount（已 ≤ maxImages）；否则取 LLM 判断值夹 [1, maxImages]。
    const count =
      targetCount !== undefined
        ? Math.max(1, Math.min(targetCount, this.maxImages))
        : Math.max(1, Math.min(p.imageCount, this.maxImages));
    const themes = p.themes.slice(0, count);
    // themes 不足 → 用标题派生补齐（保证长度=count，[0]=钩子图/封面位）。
    while (themes.length < count) {
      themes.push({ subject: `${(input.title || '文章主题').slice(0, 16)} 补充图 ${themes.length + 1}` });
    }
    const boundThemes = themes.map((theme, i) => this.bindSource(this.withFallbackBrief(theme, input), sourceImages?.[i], i));
    return { wantImage: true, imageCount: boundThemes.length, themes: boundThemes, styleHint: p.styleHint, plannedAt: this.clock() };
  }

  private bindSource(
    theme: ImageTheme,
    image: ReferenceImageSnapshot | undefined,
    sourceArrayIndex: number,
  ): ImageTheme {
    if (!image) return theme;
    return {
      ...theme,
      sourceArrayIndex,
      sourceIndex: Number.isInteger(image.index) ? image.index : sourceArrayIndex,
    };
  }

  private parse(raw: string): ParsedPlan {
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) throw new Error('No JSON in ImageSetPlanner output');
    const obj = JSON.parse(match[0]) as { imageCount?: unknown; themes?: unknown; styleHint?: unknown };
    const themesRaw = Array.isArray(obj.themes) ? obj.themes : [];
    const themes: ImageTheme[] = themesRaw
      .map((t: unknown): ImageTheme => {
        if (typeof t === 'string') return { subject: t.trim() };
        const o = (t ?? {}) as { subject?: unknown; intent?: unknown; contentVisualBrief?: unknown };
        const contentVisualBrief = parseContentVisualBrief(o.contentVisualBrief);
        return {
          subject: String(o.subject ?? '').trim(),
          intent: o.intent ? String(o.intent).trim() : undefined,
          ...(contentVisualBrief ? { contentVisualBrief } : {}),
        };
      })
      .filter((t) => t.subject.length > 0);
    if (themes.length === 0) throw new Error('ImageSetPlanner: no valid themes');
    const rawCount = Number(obj.imageCount);
    const imageCount = Number.isFinite(rawCount) && rawCount > 0 ? Math.floor(rawCount) : themes.length;
    return { imageCount, themes, styleHint: obj.styleHint ? String(obj.styleHint) : null };
  }

  private withFallbackBrief(theme: ImageTheme, input: CreatedContent): ImageTheme {
    if (theme.contentVisualBrief) return theme;
    const context = `${theme.subject} ${theme.intent ?? ''} ${input.title} ${input.content.slice(0, 800)}`;
    const personLikely = /人物|人像|访谈|男人|女人|男生|女生|他|她|情绪|表情|肖像/.test(context);
    return {
      ...theme,
      contentVisualBrief: {
        narrativeMoment: theme.intent || theme.subject,
        emotion: input.tone || '与正文语气一致',
        emotionIntensity: 0.5,
        action: theme.intent || `自然呈现${theme.subject}`,
        environment: '与正文叙事语境一致',
        ...(personLikely
          ? {
              facialExpression: '与正文情绪一致的非摆拍表情',
              gazeDirection: '不默认僵硬直视镜头',
              headAngle: '自然偏转而非证件照式完全正面',
              bodyLanguage: '肩颈和身体重心体现正文张力',
            }
          : {}),
        avoid: personLikely
          ? ['证件照式正面端坐', '标准商业微笑', '僵硬直视镜头', '与正文无关的摆拍']
          : ['与正文无关的摆拍或装饰'],
      },
    };
  }
}

function compactString(value: unknown, max = 240): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.replace(/\s+/g, ' ').trim();
  return normalized ? normalized.slice(0, max) : null;
}

function parseContentVisualBrief(value: unknown): ContentVisualBrief | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const o = value as Record<string, unknown>;
  const narrativeMoment = compactString(o.narrativeMoment);
  const emotion = compactString(o.emotion);
  const action = compactString(o.action);
  const environment = compactString(o.environment);
  const intensity = Number(o.emotionIntensity);
  if (!narrativeMoment || !emotion || !action || !environment || !Number.isFinite(intensity)) return undefined;
  const avoid = Array.isArray(o.avoid)
    ? o.avoid.map((item) => compactString(item, 120)).filter((item): item is string => !!item).slice(0, 8)
    : [];
  const optional = (key: 'facialExpression' | 'gazeDirection' | 'headAngle' | 'bodyLanguage'): string | undefined =>
    compactString(o[key]) ?? undefined;
  const facialExpression = optional('facialExpression');
  const gazeDirection = optional('gazeDirection');
  const headAngle = optional('headAngle');
  const bodyLanguage = optional('bodyLanguage');
  return {
    narrativeMoment,
    emotion,
    emotionIntensity: Math.max(0, Math.min(1, intensity)),
    action,
    environment,
    ...(facialExpression ? { facialExpression } : {}),
    ...(gazeDirection ? { gazeDirection } : {}),
    ...(headAngle ? { headAngle } : {}),
    ...(bodyLanguage ? { bodyLanguage } : {}),
    avoid,
  };
}
