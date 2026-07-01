import { BasePublishRole } from './base-role.js';
import type { RoleConfig } from './base-role.js';
import type { PipelineFields, CreatedContent, ImageSetPlan, ImageTheme } from '../types.js';
import { buildImageSetPlanPrompt, IMAGE_COUNT_HARD_MAX } from '../prompts.js';
import { executeWithFallback } from '../retry-strategy.js';
import type { ChatLlmClient } from '../../llm/qwen.js';

/**
 * ImageSetPlanner — 配图「选题」（change publish-multi-image，从旧 ImagePlanner 拆出 Step 1）。
 * LLM 读正文决定：配几张 + 每张画什么主体（业务语言）+ 风格倾向；写 imageSetPlan。
 * 红线：决策与执行解耦——只产选题、绝不产万相 prompt、绝不调图源。
 * 图文帖必须有图：张数恒 clamp 到 [1, maxImages≤9]；LLM 失败降级朝「更少图」退（1 张通用主题），键必写不死锁。
 */

const DEFAULT_MAX_IMAGES = 3;

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
    timeoutMs: 30000,
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

  protected async execute(input: CreatedContent): Promise<ImageSetPlan> {
    const { result, usedFallback } = await executeWithFallback<ParsedPlan | null>(
      async () => {
        const raw = await this.llmClient.chat([
          { role: 'system', content: '你是配图选题师。严格返回JSON。' },
          { role: 'user', content: buildImageSetPlanPrompt(input, this.maxImages) },
        ]);
        return this.parse(raw);
      },
      { default: null, reason: 'ImageSetPlanner LLM failed' },
    );

    if (usedFallback || !result) {
      this.logger.warn('[ImageSetPlanner] LLM 失败，降级朝更少图退（1 张通用主题）');
      return this.degradePlan(input);
    }
    return this.buildPlan(result, input);
  }

  protected override getDefaultOutput(): ImageSetPlan {
    // 键必写（不死锁）：正文可能缺，用通用主题占位、保 1 张（图文帖必须有图）。
    return { wantImage: true, imageCount: 1, themes: [{ subject: '文章主题示意图' }], styleHint: null, plannedAt: this.clock() };
  }

  /** LLM 失败降级：图文帖必须有图 → 保 1 张，主体取标题（通用示意）。 */
  private degradePlan(input: CreatedContent): ImageSetPlan {
    const subject = (input.title || '文章主题').slice(0, 24);
    return { wantImage: true, imageCount: 1, themes: [{ subject: `${subject} 主题示意` }], styleHint: null, plannedAt: this.clock() };
  }

  private buildPlan(p: ParsedPlan, input: CreatedContent): ImageSetPlan {
    const count = Math.max(1, Math.min(p.imageCount, this.maxImages));
    const themes = p.themes.slice(0, count);
    // themes 不足 → 用标题派生补齐（保证长度=count，[0]=钩子图/封面位）。
    while (themes.length < count) {
      themes.push({ subject: `${(input.title || '文章主题').slice(0, 16)} 补充图 ${themes.length + 1}` });
    }
    return { wantImage: true, imageCount: themes.length, themes, styleHint: p.styleHint, plannedAt: this.clock() };
  }

  private parse(raw: string): ParsedPlan {
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) throw new Error('No JSON in ImageSetPlanner output');
    const obj = JSON.parse(match[0]) as { imageCount?: unknown; themes?: unknown; styleHint?: unknown };
    const themesRaw = Array.isArray(obj.themes) ? obj.themes : [];
    const themes: ImageTheme[] = themesRaw
      .map((t: unknown): ImageTheme => {
        if (typeof t === 'string') return { subject: t.trim() };
        const o = (t ?? {}) as { subject?: unknown; intent?: unknown };
        return { subject: String(o.subject ?? '').trim(), intent: o.intent ? String(o.intent) : undefined };
      })
      .filter((t) => t.subject.length > 0);
    if (themes.length === 0) throw new Error('ImageSetPlanner: no valid themes');
    const rawCount = Number(obj.imageCount);
    const imageCount = Number.isFinite(rawCount) && rawCount > 0 ? Math.floor(rawCount) : themes.length;
    return { imageCount, themes, styleHint: obj.styleHint ? String(obj.styleHint) : null };
  }
}
