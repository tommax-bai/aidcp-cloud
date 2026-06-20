import { BasePublishRole } from './base-role.js';
import type { RoleConfig } from './base-role.js';
import type { PipelineFields, CreatedContent, ImagePlan } from '../types.js';
import type { PipelineContext } from '../pipeline-context.js';
import { buildImagePrompt } from '../prompts.js';
import { executeWithFallback } from '../retry-strategy.js';
import type { QwenClient } from '../../llm/qwen.js';

/**
 * ImagePlanner — 配图「决策」（A 阶段2，从 ImageDirector 拆出 Step 1）。
 * LLM 规划配图 prompt / 风格；失败或无 prompt → wantImage:false（不配图计划）。
 * 红线：决策与执行分离，本角色只产计划、不调图源。
 */
export interface ImagePlannerDeps {
  llmClient: QwenClient;
  clock?: () => number;
  logger?: Pick<Console, 'log' | 'warn' | 'error'>;
}

export class ImagePlannerRole extends BasePublishRole<CreatedContent, ImagePlan> {
  readonly config: RoleConfig = {
    name: 'ImagePlanner',
    watchKeys: ['createdContent'],
    timeoutMs: 30000,
    fallback: 'default',
  };
  protected readonly outputKey = 'imagePlan' as const;
  private llmClient: QwenClient;

  constructor(deps: ImagePlannerDeps) {
    super({ logger: deps.logger, clock: deps.clock });
    this.llmClient = deps.llmClient;
  }

  protected extractInput(snapshot: Partial<PipelineFields>): CreatedContent {
    return snapshot.createdContent!;
  }

  protected async execute(input: CreatedContent, _context: PipelineContext<PipelineFields>): Promise<ImagePlan> {
    const { result: imageSpec, usedFallback } = await executeWithFallback(
      async () => {
        const raw = await this.llmClient.chat([
          { role: 'system', content: '你是配图策略规划师。严格返回JSON。' },
          { role: 'user', content: buildImagePrompt(input) },
        ]);
        return this.parseLlmOutput(raw);
      },
      {
        default: { imagePrompt: null, imageStyle: null as ImagePlan['imageStyle'], fallbackStrategy: 'skip' as const },
        reason: 'LLM image prompt generation failed',
      },
    );

    // LLM 降级或无 prompt → 不配图计划（对齐现 image-director 的"无 prompt 即跳过"判定）。
    if (usedFallback || !imageSpec.imagePrompt) {
      if (usedFallback) this.logger.warn('[ImagePlanner] LLM failed, planning no image');
      return this.noImagePlan();
    }

    return {
      wantImage: true,
      imagePrompt: imageSpec.imagePrompt,
      imageStyle: imageSpec.imageStyle,
      imageCount: 1,
      fallbackStrategy: imageSpec.fallbackStrategy,
      plannedAt: this.clock(),
    };
  }

  protected override getDefaultOutput(): ImagePlan {
    return this.noImagePlan();
  }

  private noImagePlan(): ImagePlan {
    return {
      wantImage: false,
      imagePrompt: null,
      imageStyle: null,
      imageCount: 0,
      fallbackStrategy: 'skip',
      plannedAt: this.clock(),
    };
  }

  private parseLlmOutput(raw: string): { imagePrompt: string | null; imageStyle: ImagePlan['imageStyle']; fallbackStrategy: 'skip' | 'color_placeholder' } {
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) throw new Error('No JSON found in ImagePlanner output');
    const obj = JSON.parse(match[0]);
    const validStyles: ImagePlan['imageStyle'][] = ['photography', 'illustration', 'dataviz', 'isometric'];
    const style = validStyles.includes(obj.imageStyle) ? obj.imageStyle : 'illustration';
    const fallback = obj.fallbackStrategy === 'color_placeholder' ? 'color_placeholder' : 'skip';
    return {
      imagePrompt: obj.imagePrompt ? String(obj.imagePrompt) : null,
      imageStyle: style,
      fallbackStrategy: fallback,
    };
  }
}
