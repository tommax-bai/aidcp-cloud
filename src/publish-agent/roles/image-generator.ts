import { BasePublishRole } from './base-role.js';
import type { RoleConfig } from './base-role.js';
import type { PipelineFields, ImagePlan, ImageDirective } from '../types.js';
import type { PipelineContext } from '../pipeline-context.js';
import type { ImageProvider } from '../image-provider.js';

/**
 * ImageGenerator — 配图「执行」（A 阶段2，从 ImageDirector 拆出 Step 2）。
 * 按 ImagePlan 调通义万相生成图；不配图 / 生图失败 → 诚实回 imageUrl:null（绝不伪造 / 复用 URL）。
 * 产出键仍是稳定的 imageDirective（形状不变，下游 CoverSelector/ContentAssembler 读法不变）。
 */
export interface ImageGeneratorDeps {
  imageProvider: ImageProvider;
  enableImageGeneration?: boolean;
  clock?: () => number;
  logger?: Pick<Console, 'log' | 'warn' | 'error'>;
}

export class ImageGeneratorRole extends BasePublishRole<ImagePlan, ImageDirective> {
  readonly config: RoleConfig = {
    name: 'ImageGenerator',
    watchKeys: ['imagePlan'],
    // 须 > 万相轮询总预算（18×5s=90s）；否则角色超时会先于轮询完成砍断生图。
    timeoutMs: 120000,
    fallback: 'skip',
  };
  protected readonly outputKey = 'imageDirective' as const;
  private imageProvider: ImageProvider;
  private enableImageGeneration: boolean;

  constructor(deps: ImageGeneratorDeps) {
    super({ logger: deps.logger, clock: deps.clock });
    this.imageProvider = deps.imageProvider;
    this.enableImageGeneration = deps.enableImageGeneration ?? true;
  }

  protected extractInput(snapshot: Partial<PipelineFields>): ImagePlan {
    return snapshot.imagePlan!;
  }

  protected async execute(input: ImagePlan, _context: PipelineContext<PipelineFields>): Promise<ImageDirective> {
    // 不开启 / 计划不配图 / 无 prompt → 直接空 directive（诚实纯文字）。
    if (!this.enableImageGeneration || !input.wantImage || !input.imagePrompt) {
      return this.emptyDirective(input.fallbackStrategy);
    }

    const imageResult = await this.imageProvider.generate(input.imagePrompt, input.imageStyle ?? undefined);

    // 红线：imageUrl 直接取生成结果（失败为 null），绝不伪造 / 复用上次 URL。
    if (!imageResult.url) {
      this.logger.warn(`[ImageGenerator] 生图失败，降级纯文字: ${imageResult.error ?? 'no_url'}`);
    }
    return {
      imagePrompt: input.imagePrompt,
      imageUrl: imageResult.url,
      imageStyle: input.imageStyle,
      fallbackStrategy: imageResult.url ? 'skip' : input.fallbackStrategy,
      directedAt: this.clock(),
    };
  }

  protected override getDefaultOutput(): ImageDirective {
    return this.emptyDirective('skip');
  }

  private emptyDirective(fallbackStrategy: ImageDirective['fallbackStrategy']): ImageDirective {
    return {
      imagePrompt: null,
      imageUrl: null,
      imageStyle: null,
      fallbackStrategy,
      directedAt: this.clock(),
    };
  }
}
