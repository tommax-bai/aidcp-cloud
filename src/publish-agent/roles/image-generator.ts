import crypto from 'node:crypto';
import { BasePublishRole } from './base-role.js';
import type { RoleConfig } from './base-role.js';
import type { PipelineContext } from '../pipeline-context.js';
import type { PipelineFields, ImagePlan, ImageDirective, CoverFormAudit, CoverRenderStatus } from '../types.js';
import type { ImageProvider, ImageResult } from '../image-provider.js';
import { normImageProvider } from '../image-providers.js';
import type { ObjectStore } from '../../storage/object-store.js';
import { relocateImageToStore } from '../../storage/object-store.js';
import { IMAGE_COUNT_HARD_MAX } from '../prompts.js';
import { referenceImageUrl, referenceImagesForGeneration } from '../reference-image-guidance.js';
import type { TextCardRenderer, TextCardRenderMeta } from '../../render/text-card.js';

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

// 文字卡渲染内层闸（change textcard-cover-form）：渲染+字节直传在进入每图槽机制**之前**独立结算——
// 若共用每图槽，最坏序列 = 渲染 30s + 万相轮询尾部 ~185s + 转存 30s = 245s > 240s，兜底生图会在收尾前
// 被槽闸砍掉（评审 must-fix：由本特性引入的尾部回归）。故独立结算 + 角色总闸公式加渲染超时项。
const DEFAULT_TEXTCARD_RENDER_TIMEOUT_MS = 30_000;

// 每图超时：MUST > 单图万相轮询总预算 + OSS 转存预算，否则会先于「轮询 SUCCEEDED → 转存」结算前砍断 → 误判无图（红线）。
// 预算拆解：① 万相轮询——server.ts 把 maxPollAttempts 接到 AIDCP_WANXIANG_MAX_POLL（默认 34）、间隔 5s → 34×5s=170s
// 睡眠 + ~34 次 GET 往返（合计再几到十几秒），故生成 wall-clock 上限约 185s；② change cloud-oss-storage-integration：
// 注入 ossUploader 后「生成 + OSS 转存」串行共享本每图超时（3.3：不拖垮发布链），转存另有 30s 内层超时。
// 故默认取 240s（≈185s 生成上限 + 30s 转存 + 余量），避免「生成刚成功但转存被外闸砍」的尾部误丢。改任一子预算须同步调整。
// 生图实测 25~40s、转存实测数秒，绝大多数远在预算内；仅生成拖到轮询上限的尾部才吃到余量。
const DEFAULT_PER_IMAGE_TIMEOUT_MS = 240_000;
const DEFAULT_MAX_IMAGES = 3;

interface ImageGenerationOutcome {
  url: string | null;
  referenceStatus?: 'used' | 'unsupported' | 'unavailable' | 'skipped';
}

export interface ImageUsageRecord {
  accountId: string;
  provider: string;
  model: string;
  ok: boolean;
}

export interface ImageGeneratorDeps {
  imageProvider: ImageProvider;
  enableImageGeneration?: boolean;
  /** 图片模型调用记账钩子；最佳努力，绝不能影响生图结果。 */
  usageRecorder?: (record: ImageUsageRecord) => void;
  /** 当前全局图片厂商/模型；与路由 provider 分开传入，用作 usage 维度。 */
  getProvider?: () => string;
  getModel?: () => string;
  /** 每图超时（毫秒，缺省 env AIDCP_PUBLISH_PER_IMAGE_TIMEOUT_MS，默认 100s）。 */
  perImageTimeoutMs?: number;
  /** 张数上限（缺省 env AIDCP_PUBLISH_MAX_IMAGES，默认 3，硬夹 ≤9）——仅用于计算角色总闸余量。 */
  maxImages?: number;
  /** 并发上限（缺省 env AIDCP_PUBLISH_IMAGE_CONCURRENCY，默认 = maxImages，即全并发）。 */
  concurrency?: number;
  /**
   * OSS 转存出口（change cloud-oss-storage-integration）。注入后每张图在生成成功后转存到 OSS、
   * 换成稳定公网 URL；**未注入时行为与集成前完全一致（零回归）**，直接用 provider 临时 URL。
   */
  ossUploader?: ObjectStore;
  /** 抓 provider 字节用的 fetch（缺省全局 fetch，测试可注入假实现脱网）。仅在 ossUploader 注入时用到。 */
  fetchImpl?: typeof fetch;
  /** 对象键的单次运行 token 生成器（缺省随机 hex）；记录 id 此刻尚未生成，故用运行 token 代替 recordId。 */
  idGen?: () => string;
  /**
   * 文字卡渲染出口（change textcard-cover-form）。工厂异步就绪故取 getter；未注入或返回 null =
   * 渲染不可用，text_card 决策按渲染失败降级生成式。**执行器只读 plan 与注入依赖，绝不二次读环境旗标。**
   */
  getTextCardRenderer?: () => TextCardRenderer | null;
  /** 渲染+字节直传内层闸（毫秒，缺省 env AIDCP_TEXTCARD_RENDER_TIMEOUT_MS，默认 30s）。 */
  renderTimeoutMs?: number;
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
  private ossUploader?: ObjectStore;
  private fetchImpl?: typeof fetch;
  private idGen: () => string;
  private usageRecorder?: (record: ImageUsageRecord) => void;
  private getProvider: () => string;
  private getModel: () => string;
  private getTextCardRenderer?: () => TextCardRenderer | null;
  private renderTimeoutMs: number;

  constructor(deps: ImageGeneratorDeps) {
    super({ logger: deps.logger, clock: deps.clock });
    this.imageProvider = deps.imageProvider;
    this.enableImageGeneration = deps.enableImageGeneration ?? true;
    this.ossUploader = deps.ossUploader;
    this.fetchImpl = deps.fetchImpl;
    this.idGen = deps.idGen ?? (() => crypto.randomBytes(6).toString('hex'));
    this.usageRecorder = deps.usageRecorder;
    this.getProvider = deps.getProvider ?? (() => 'unknown');
    this.getModel = deps.getModel ?? (() => 'unknown');
    this.getTextCardRenderer = deps.getTextCardRenderer;
    this.renderTimeoutMs = deps.renderTimeoutMs ?? envInt('AIDCP_TEXTCARD_RENDER_TIMEOUT_MS', DEFAULT_TEXTCARD_RENDER_TIMEOUT_MS);
    this.perImageTimeoutMs = deps.perImageTimeoutMs ?? envInt('AIDCP_PUBLISH_PER_IMAGE_TIMEOUT_MS', DEFAULT_PER_IMAGE_TIMEOUT_MS);
    const maxImages = Math.max(1, Math.min(deps.maxImages ?? envInt('AIDCP_PUBLISH_MAX_IMAGES', DEFAULT_MAX_IMAGES), IMAGE_COUNT_HARD_MAX));
    this.concurrency = Math.max(1, Math.min(deps.concurrency ?? envInt('AIDCP_PUBLISH_IMAGE_CONCURRENCY', maxImages), maxImages));
    // 角色总闸 = 每图超时 × 最坏波数 + 渲染内层闸（渲染出口注入时；渲染先于每图槽独立结算，评审 must-fix）+ 余量（20s）。
    // 波数=ceil(maxImages/concurrency)；默认全并发即 1 波。
    // 每图任务自超时（不 hang），execute 恒在此总闸前结算 → 总闸只作病态兜底，绝不吃掉部分成功。
    const waves = Math.ceil(maxImages / this.concurrency);
    const renderBudget = deps.getTextCardRenderer ? this.renderTimeoutMs : 0;
    this.config = {
      name: 'ImageGenerator',
      watchKeys: ['imagePlan'],
      timeoutMs: this.perImageTimeoutMs * waves + renderBudget + 20_000,
      fallback: 'skip',
    };
  }

  protected extractInput(snapshot: Partial<PipelineFields>): ImagePlan {
    return snapshot.imagePlan!;
  }

  protected async execute(input: ImagePlan, context: PipelineContext<PipelineFields>): Promise<ImageDirective> {
    // 不开启 / 计划不配图 / 无 prompt → 直接空 directive（诚实纯文字，交下游 executor 判 failed）。
    if (!this.enableImageGeneration || !input.wantImage || input.imagePrompts.length === 0) {
      return this.emptyDirective(input.fallbackStrategy);
    }

    // 配图转存 OSS（change cloud-oss-storage-integration）：键按账号 + 单次运行 token 分层。
    // recordId 此刻尚未生成（发布记录晚于此处落库），故用运行 token 代替 recordId 做键分组。
    const accountId = context.snapshot().trigger?.accountId ?? 'default';
    const runToken = this.idGen();
    const rawReferenceImages = input.referenceImages ?? context.snapshot().trigger?.generateInput?.referenceNote?.images ?? [];
    const referenceImages = referenceImagesForGeneration(rawReferenceImages);
    const referenceUrls = referenceImages.map((img) => referenceImageUrl(img)!);

    // 文字卡封面分支（change textcard-cover-form）：决策为 text_card 且文案/渲染出口/OSS 俱备时，
    // 0 号槽先由本地渲染+字节直传产出——在进入每图槽机制**之前**独立结算（30s 内层闸），
    // 失败后 0 号以**完整每图槽预算**用计划内恒在的生成式提示词走 provider（评审 must-fix：不挤占兜底预算）。
    const renderer = this.getTextCardRenderer?.() ?? null;
    const renderWanted = input.coverForm === 'text_card' && !!input.coverCard;
    let renderedCover: { url: string; meta: TextCardRenderMeta } | null = null;
    if (renderWanted) {
      if (renderer && this.ossUploader) {
        const postKey =
          context.snapshot().trigger?.generateInput?.referenceNote?.sourceId ?? input.coverCard!.title;
        renderedCover = await this.renderCoverCard(renderer, input, { accountId, runToken }, postKey);
      } else {
        this.logger.warn('[ImageGenerator] 计划为 text_card 但渲染出口/OSS 不可用，0 号回落生成式（诚实降级）');
      }
    }

    // 并行出图（有界并发）：每张 Promise.race(生成+转存, 每图超时)，settle 后按规划顺序收成功 URL。
    // 去第二风格源（change category-adaptive-images-and-judgment）：不再把 imageStyle 枚举传给 provider——
    // 风格已并入品类风格档写进 prompt；provider 侧再拼「，风格：<enum>」会与风格档冲突、劣化 Seedream。
    // 渲染成功时 0 号槽直接用渲染结果替换（不前插不移位），该槽不再走 provider。
    const results = await mapWithConcurrency(input.imagePrompts, this.concurrency, (prompt, i) => {
      if (i === 0 && renderedCover) {
        return Promise.resolve<ImageGenerationOutcome>({ url: renderedCover.url, referenceStatus: 'skipped' });
      }
      return this.generateOne(prompt, { accountId, runToken, seq: i }, referenceUrls);
    });
    const imageUrls = results.map((r) => r.url).filter((url): url is string => !!url);

    if (imageUrls.length === 0) {
      this.logger.warn(`[ImageGenerator] ${input.imagePrompts.length} 张全部生图失败，降级纯文字（M=0）`);
    } else if (imageUrls.length < input.imagePrompts.length) {
      this.logger.warn(`[ImageGenerator] 部分成功 M=${imageUrls.length}/${input.imagePrompts.length}（失败那张不进数组，诚实）`);
    }

    // 渲染结局审计（诚实红线：降级用了生成图绝不标 rendered；unknown 绝不猜 text_card）。
    const renderStatus: CoverRenderStatus = !renderWanted
      ? 'not_attempted'
      : renderedCover
        ? 'rendered'
        : results[0]?.url
          ? 'render_failed_generative'
          : 'render_failed_none';

    return {
      imagePrompt: input.imagePrompts[0] ?? null,
      imageUrls,
      imageUrl: imageUrls[0] ?? null,
      imageStyle: input.imageStyle,
      fallbackStrategy: imageUrls.length > 0 ? 'skip' : input.fallbackStrategy,
      ...(referenceImages.length > 0 ? { referenceImages } : {}),
      referenceImageStatus: this.summarizeReferenceStatus(referenceUrls, results),
      ...(input.coverGate
        ? {
            coverFormAudit: {
              coverForm: input.coverForm ?? 'generative',
              sensedForm: input.coverGate.sensedForm,
              sensedSource: input.coverGate.sensedSource,
              gateReason: input.coverGate.gateReason,
              renderStatus,
              ...(renderedCover
                ? {
                    renderMeta: {
                      themeKey: renderedCover.meta.themeKey,
                      truncated: renderedCover.meta.truncated,
                      sanitized: renderedCover.meta.sanitized,
                      reductions: renderedCover.meta.reductions,
                    },
                  }
                : {}),
            } satisfies CoverFormAudit,
          }
        : {}),
      directedAt: this.clock(),
    };
  }

  /**
   * 文字卡渲染 + PNG 字节直传 OSS（0 号封面槽专用）。
   * 内层闸 renderTimeoutMs 独立结算；任一环节失败/超时诚实回 null（调用方立即回落生成式），绝不伪造 URL。
   */
  private async renderCoverCard(
    renderer: TextCardRenderer,
    input: ImagePlan,
    keyCtx: { accountId: string; runToken: string },
    postKey: string,
  ): Promise<{ url: string; meta: TextCardRenderMeta } | null> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        (async (): Promise<{ url: string; meta: TextCardRenderMeta } | null> => {
          const res = await renderer.render(
            { title: input.coverCard!.title, bullets: input.coverCard!.bullets, tags: input.coverCard!.tags },
            { accountId: keyCtx.accountId, postKey },
          );
          if (!res.ok) {
            this.logger.warn(`[ImageGenerator] 文字卡渲染失败（${res.reason}${res.detail ? `: ${res.detail}` : ''}），0 号回落生成式`);
            return null;
          }
          const { url } = await this.ossUploader!.put(
            `publish/${keyCtx.accountId}/${keyCtx.runToken}/0.png`,
            res.png,
            { contentType: 'image/png' },
          );
          if (!url) {
            this.logger.warn('[ImageGenerator] 文字卡 OSS 直传未返回 URL，0 号回落生成式');
            return null;
          }
          this.logger.log(`[ImageGenerator] 文字卡封面渲染成功 theme=${res.meta.themeKey}${res.meta.truncated ? ' truncated' : ''}${res.meta.sanitized ? ' sanitized' : ''}`);
          return { url, meta: res.meta };
        })(),
        new Promise<null>((resolve) => {
          timer = setTimeout(() => {
            this.logger.warn(`[ImageGenerator] 文字卡渲染超时 ${this.renderTimeoutMs}ms，0 号回落生成式（兜底享完整每图槽预算）`);
            resolve(null);
          }, this.renderTimeoutMs);
        }),
      ]);
    } catch (err) {
      this.logger.warn(`[ImageGenerator] 文字卡渲染异常，0 号回落生成式: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  protected override getDefaultOutput(): ImageDirective {
    return this.emptyDirective('skip');
  }

  /**
   * 单张：Promise.race(生成+转存, 每图超时)。超时/异常/无 URL/转存失败 → 诚实回 null（该张不进数组、不伪造）。
   * 转存（抓字节 + PUT OSS）与生成共享同一每图超时预算（承 3.3：不拖垮发布链）；转存自身另有 30s 内层超时。
   */
  private async generateOne(
    prompt: string,
    keyCtx: { accountId: string; runToken: string; seq: number },
    referenceUrls: string[],
  ): Promise<ImageGenerationOutcome> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let usageRecorded = false;
    const recordAttempt = (ok: boolean): void => {
      if (usageRecorded) return;
      usageRecorded = true;
      this.recordUsage(keyCtx.accountId, ok);
    };
    try {
      return await Promise.race<ImageGenerationOutcome>([
        this.produceAndRelocate(prompt, keyCtx, referenceUrls, recordAttempt),
        new Promise<ImageGenerationOutcome>((resolve) => {
          timer = setTimeout(() => {
            this.logger.warn(`[ImageGenerator] 单张超时 ${this.perImageTimeoutMs}ms，诚实落空`);
            recordAttempt(false);
            resolve({ url: null, referenceStatus: referenceUrls.length > 0 ? 'unavailable' : 'skipped' });
          }, this.perImageTimeoutMs);
        }),
      ]);
    } catch (err) {
      recordAttempt(false);
      this.logger.warn(`[ImageGenerator] 单张生图异常: ${err instanceof Error ? err.message : String(err)}`);
      return { url: null, referenceStatus: referenceUrls.length > 0 ? 'unavailable' : 'skipped' };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /**
   * 出图 → （若注入 ossUploader）转存 OSS 换稳定公网 URL。
   * - 未注入 ossUploader：直接回 provider 临时 URL（**零回归**，与集成前一致）。
   * - 注入了：转存失败（抓字节 / PUT 任一）即回 null，复用「失败那张不进数组、M=K 诚实」语义，绝不伪造 URL。
   */
  private async produceAndRelocate(
    prompt: string,
    keyCtx: { accountId: string; runToken: string; seq: number },
    referenceUrls: string[],
    recordAttempt: (ok: boolean) => void,
  ): Promise<ImageGenerationOutcome> {
    let res: ImageResult;
    try {
      res = await this.imageProvider.generate(
        prompt,
        undefined,
        referenceUrls.length > 0 ? { referenceImages: referenceUrls } : undefined,
      );
      recordAttempt(!!res.url);
    } catch (err) {
      recordAttempt(false);
      throw err;
    }
    const referenceStatus = res.referenceStatus ?? (referenceUrls.length > 0 ? 'unsupported' : 'skipped');
    if (!res.url) {
      this.logger.warn(`[ImageGenerator] 单张生图失败: ${res.error ?? 'no_url'}`);
      return { url: null, referenceStatus };
    }
    if (!this.ossUploader) return { url: res.url, referenceStatus };
    const keyBase = `publish/${keyCtx.accountId}/${keyCtx.runToken}/${keyCtx.seq}`;
    const ossUrl = await relocateImageToStore(res.url, keyBase, {
      store: this.ossUploader,
      fetchImpl: this.fetchImpl,
      logger: this.logger,
    });
    if (!ossUrl) {
      this.logger.warn('[ImageGenerator] OSS 转存失败，该张诚实落空（M 少一张，不伪造 URL）');
      return { url: null, referenceStatus };
    }
    return { url: ossUrl, referenceStatus };
  }

  private recordUsage(accountId: string, ok: boolean): void {
    if (!this.usageRecorder) return;
    try {
      this.usageRecorder({
        accountId,
        provider: normImageProvider(this.getProvider()),
        model: this.getModel().trim() || 'unknown',
        ok,
      });
    } catch {
      /* metrics never breaks image generation */
    }
  }

  private summarizeReferenceStatus(
    referenceUrls: string[],
    outcomes: ImageGenerationOutcome[],
  ): NonNullable<ImageDirective['referenceImageStatus']> {
    if (referenceUrls.length === 0) return 'none';
    const statuses = outcomes.map((r) => r.referenceStatus).filter(Boolean);
    if (statuses.includes('used')) return 'used';
    if (statuses.includes('unavailable')) return 'unavailable';
    if (statuses.includes('unsupported')) return 'unsupported';
    return 'skipped';
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
