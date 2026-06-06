import { BasePublishRole } from './base-role.js';
import type { RoleConfig } from './base-role.js';
import type { PipelineFields, CreatedContent, ImageDirective } from '../types.js';
import type { PipelineContext } from '../pipeline-context.js';
import { buildImagePrompt } from '../prompts.js';
import { executeWithFallback } from '../retry-strategy.js';
import type { QwenClient } from '../../llm/qwen.js';
import type { ImageProvider } from '../image-provider.js';

export interface ImageDirectorDeps {
  llmClient: QwenClient;
  imageProvider: ImageProvider;
  enableImageGeneration?: boolean;
  clock?: () => number;
  logger?: Pick<Console, 'log' | 'warn' | 'error'>;
}

export class ImageDirectorRole extends BasePublishRole<CreatedContent, ImageDirective> {
  readonly config: RoleConfig = {
    name: 'ImageDirector',
    watchKeys: ['createdContent'],
    timeoutMs: 60000,
    fallback: 'skip',
  };
  protected readonly outputKey = 'imageDirective' as const;
  private llmClient: QwenClient;
  private imageProvider: ImageProvider;
  private enableImageGeneration: boolean;

  constructor(deps: ImageDirectorDeps) {
    super({ logger: deps.logger, clock: deps.clock });
    this.llmClient = deps.llmClient;
    this.imageProvider = deps.imageProvider;
    this.enableImageGeneration = deps.enableImageGeneration ?? true;
  }

  protected extractInput(snapshot: Partial<PipelineFields>): CreatedContent {
    return snapshot.createdContent!;
  }

  protected async execute(input: CreatedContent, _context: PipelineContext<PipelineFields>): Promise<ImageDirective> {
    if (!this.enableImageGeneration) {
      return this.getEmptyDirective();
    }

    // Step 1: LLM 生成配图 prompt
    const { result: imageSpec, usedFallback } = await executeWithFallback(
      async () => {
        const raw = await this.llmClient.chat([
          { role: 'system', content: '你是配图策略规划师。严格返回JSON。' },
          { role: 'user', content: buildImagePrompt(input) },
        ]);
        return this.parseLlmOutput(raw);
      },
      {
        default: { imagePrompt: null, imageStyle: null as ImageDirective['imageStyle'], fallbackStrategy: 'skip' as const },
        reason: 'LLM image prompt generation failed',
      },
    );

    if (usedFallback || !imageSpec.imagePrompt) {
      this.logger.warn('[ImageDirector] LLM failed or no prompt, skipping image generation');
      return this.getEmptyDirective();
    }

    // Step 2: 调用图片生成
    const imageResult = await this.imageProvider.generate(imageSpec.imagePrompt, imageSpec.imageStyle ?? undefined);

    return {
      imagePrompt: imageSpec.imagePrompt,
      imageUrl: imageResult.url,
      imageStyle: imageSpec.imageStyle,
      fallbackStrategy: imageResult.url ? 'skip' : imageSpec.fallbackStrategy,
      directedAt: this.clock(),
    };
  }

  protected override getDefaultOutput(): ImageDirective {
    return this.getEmptyDirective();
  }

  private getEmptyDirective(): ImageDirective {
    return {
      imagePrompt: null,
      imageUrl: null,
      imageStyle: null,
      fallbackStrategy: 'skip',
      directedAt: this.clock(),
    };
  }

  private parseLlmOutput(raw: string): { imagePrompt: string | null; imageStyle: ImageDirective['imageStyle']; fallbackStrategy: 'skip' | 'color_placeholder' } {
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) throw new Error('No JSON found in ImageDirector output');
    const obj = JSON.parse(match[0]);
    const validStyles: ImageDirective['imageStyle'][] = ['photography', 'illustration', 'dataviz', 'isometric'];
    const style = validStyles.includes(obj.imageStyle) ? obj.imageStyle : 'illustration';
    const fallback = obj.fallbackStrategy === 'color_placeholder' ? 'color_placeholder' : 'skip';
    return {
      imagePrompt: obj.imagePrompt ? String(obj.imagePrompt) : null,
      imageStyle: style,
      fallbackStrategy: fallback,
    };
  }
}
