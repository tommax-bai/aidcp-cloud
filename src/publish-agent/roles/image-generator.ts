import { BasePublishRole } from './base-role.js';
import type { RoleConfig } from './base-role.js';
import type { PipelineFields, ImagePlan, ImageDirective } from '../types.js';
import type { ImageProvider, ImageResult } from '../image-provider.js';
import { IMAGE_COUNT_HARD_MAX } from '../prompts.js';

/**
 * ImageGenerator — 配图「执行」（change publish-multi-image：单图 → 并行多图）。
 * 按 imagePlan.imagePrompts **并行**出图（每张独立超时、独立成败）；收成功 URL 进 imageUrls（保序，[0]=封面位）。
 * 红线：
 * - 失败那张诚实不进数组（不补空、不复用别张、不伪造/占位 URL）。
 * - 已成功的图**绝不被角色总闸清零**：每张自超时（不 hang）→ allSettled 天然在总闸前结算；即便总闸触发，
 *   也因每张任务先结算而拿到部分成功。总闸设为 每图超时×波数 + 余量（wall-clock≈max 而非 sum）。
 * - M=0（全失败/不配图）→ 空 directive，交由下游 executor 诚实 failed。
 */

function envInt(name: string, def: number): number {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : def;
}

// 每图超时：MUST > 单图万相轮询总预算，否则每图超时会先于轮询 SUCCEEDED 砍断生图 → 误判无图（红线）。
// 实装接线预算：server.ts 把 WanxiangClient 的 maxPollAttempts 接到 AIDCP_WANXIANG_MAX_POLL（默认 34）、间隔 5s
// → 34×5s=170s。故默认取 200s（> 170s 留余量，对齐旧单图角色闸 200s）。改万相轮询预算时须同步抬高本默认。
const DEFAULT_PER_IMAGE_TIMEOUT_MS = 200_000;
const DEFAULT_MAX_IMAGES = 3;

export interface ImageGeneratorDeps {
  imageProvider: ImageProvider;
  enableImageGeneration?: boolean;
  /** 每图超时（毫秒，缺省 env AIDCP_PUBLISH_PER_IMAGE_TIMEOUT_MS，默认 100s）。 */
  perImageTimeoutMs?: number;
  /** 张数上限（缺省 env AIDCP_PUBLISH_MAX_IMAGES，默认 3，硬夹 ≤9）——仅用于计算角色总闸余量。 */
  maxImages?: number;
  /** 并发上限（缺省 env AIDCP_PUBLISH_IMAGE_CONCURRENCY，默认 = maxImages，即全并发）。 */
  concurrency?: number;
  clock?: () => number;
  logger?: Pick<Console, 'log' | 'warn' | 'error'>;
}

export class ImageGeneratorRole extends BasePublishRole<ImagePlan, ImageDirective> {
  readonly config: RoleConfig;
  protected readonly outputKey = 'imageDirective' as const;
  private imageProvider: ImageProvider;
  private enableImageGeneration: boolean;
  private perImageTimeoutMs: number;
  private concurrency: number;

  constructor(deps: ImageGeneratorDeps) {
    super({ logger: deps.logger, clock: deps.clock });
    this.imageProvider = deps.imageProvider;
    this.enableImageGeneration = deps.enableImageGeneration ?? true;
    this.perImageTimeoutMs = deps.perImageTimeoutMs ?? envInt('AIDCP_PUBLISH_PER_IMAGE_TIMEOUT_MS', DEFAULT_PER_IMAGE_TIMEOUT_MS);
    const maxImages = Math.max(1, Math.min(deps.maxImages ?? envInt('AIDCP_PUBLISH_MAX_IMAGES', DEFAULT_MAX_IMAGES), IMAGE_COUNT_HARD_MAX));
    this.concurrency = Math.max(1, Math.min(deps.concurrency ?? envInt('AIDCP_PUBLISH_IMAGE_CONCURRENCY', maxImages), maxImages));
    // 角色总闸 = 每图超时 × 最坏波数 + 余量（20s）。波数=ceil(maxImages/concurrency)；默认全并发即 1 波。
    // 每图任务自超时（不 hang），execute 恒在此总闸前结算 → 总闸只作病态兜底，绝不吃掉部分成功。
    const waves = Math.ceil(maxImages / this.concurrency);
    this.config = {
      name: 'ImageGenerator',
      watchKeys: ['imagePlan'],
      timeoutMs: this.perImageTimeoutMs * waves + 20_000,
      fallback: 'skip',
    };
  }

  protected extractInput(snapshot: Partial<PipelineFields>): ImagePlan {
    return snapshot.imagePlan!;
  }

  protected async execute(input: ImagePlan): Promise<ImageDirective> {
    // 不开启 / 计划不配图 / 无 prompt → 直接空 directive（诚实纯文字，交下游 executor 判 failed）。
    if (!this.enableImageGeneration || !input.wantImage || input.imagePrompts.length === 0) {
      return this.emptyDirective(input.fallbackStrategy);
    }

    const style = input.imageStyle ?? undefined;
    // 并行出图（有界并发）：每张 Promise.race(generate, 每图超时)，settle 后按规划顺序收成功 URL。
    const results = await mapWithConcurrency(input.imagePrompts, this.concurrency, (prompt) =>
      this.generateOne(prompt, style),
    );
    const imageUrls = results.filter((url): url is string => !!url);

    if (imageUrls.length === 0) {
      this.logger.warn(`[ImageGenerator] ${input.imagePrompts.length} 张全部生图失败，降级纯文字（M=0）`);
    } else if (imageUrls.length < input.imagePrompts.length) {
      this.logger.warn(`[ImageGenerator] 部分成功 M=${imageUrls.length}/${input.imagePrompts.length}（失败那张不进数组，诚实）`);
    }

    return {
      imagePrompt: input.imagePrompts[0] ?? null,
      imageUrls,
      imageUrl: imageUrls[0] ?? null,
      imageStyle: input.imageStyle,
      fallbackStrategy: imageUrls.length > 0 ? 'skip' : input.fallbackStrategy,
      directedAt: this.clock(),
    };
  }

  protected override getDefaultOutput(): ImageDirective {
    return this.emptyDirective('skip');
  }

  /** 单张：Promise.race(generate, 每图超时)。超时/异常/无 URL → 诚实回 null（该张不进数组、不伪造）。 */
  private async generateOne(prompt: string, style: string | undefined): Promise<string | null> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const res = await Promise.race<ImageResult>([
        this.imageProvider.generate(prompt, style),
        new Promise<ImageResult>((resolve) => {
          timer = setTimeout(() => resolve({ url: null, error: `per-image timeout ${this.perImageTimeoutMs}ms` }), this.perImageTimeoutMs);
        }),
      ]);
      if (!res.url) this.logger.warn(`[ImageGenerator] 单张生图失败: ${res.error ?? 'no_url'}`);
      return res.url ?? null;
    } catch (err) {
      this.logger.warn(`[ImageGenerator] 单张生图异常: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private emptyDirective(fallbackStrategy: ImageDirective['fallbackStrategy']): ImageDirective {
    return {
      imagePrompt: null,
      imageUrls: [],
      imageUrl: null,
      imageStyle: null,
      fallbackStrategy,
      directedAt: this.clock(),
    };
  }
}

/** 有界并发 map，结果保序（results[i] 对应 items[i]）。每个 fn 自处理异常、不抛，故池不中断。 */
async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  const n = Math.max(1, Math.min(limit, items.length));
  const worker = async (): Promise<void> => {
    while (true) {
      const i = cursor++;
      if (i >= items.length) break;
      results[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: n }, () => worker()));
  return results;
}
