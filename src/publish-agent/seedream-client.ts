/**
 * 即梦 Seedream（字节，经火山方舟 Ark）文生图 HTTP 客户端。
 *
 * 走 Ark **OpenAI 兼容同步**端点：POST {baseUrl}/images/generations 单次请求直接返图 URL，
 * 无异步轮询（比通义万相的提交+轮询简单）。仅依赖运行时全局 fetch（Node>=18），不引第三方 SDK。
 *
 * 红线（延续配图诚实）：失败恒返回 { url: null, error } 不抛、绝不伪造/占位 URL；
 * 缺密钥在发请求前诚实失败（区别于万相同名语义），MUST NOT 跨厂商兜底（路由层不偷换、本客户端只诚实回错）。
 */

import type { ImageGenerateOptions, ImageProvider, ImageResult } from './image-provider.js';

/** Ark 图片端点默认 base（与文本火山同 base；实际路径为 {baseUrl}/images/generations）。 */
export const ARK_IMAGE_BASE_URL = 'https://ark.cn-beijing.volces.com/api/v3';

export interface SeedreamClientOptions {
  /** API Key（默认读 env ARK_API_KEY / VOLCENGINE_API_KEY）。生产由 server 从 providerRuntime['volcengine'] 注入。 */
  apiKey?: string;
  /** Ark 兼容端点 base（默认 ARK_IMAGE_BASE_URL；生产复用 providerRuntime['volcengine'].baseUrl）。 */
  baseUrl?: string;
  /** 模型名，默认 doubao-seedream-4-5-251128（当前最稳的 4K Seedream）。 */
  model?: string;
  /**
   * 运行时模型名解析器（优先于 model）。注入后每次调用按需取当前配置，
   * 使后台改图片模型名无需重启即热加载生效（与 WanxiangClient 一致）。
   */
  getModel?: () => string;
  /**
   * 生成尺寸（Ark 用 "宽x高" 像素）。缺省链：显式 options → env `AIDCP_SEEDREAM_IMAGE_SIZE` → 方图 2048x2048。
   * change category-adaptive-images-and-judgment（1.7）：竖版 3:4（如 1536x2048）经 env 激活、瞬间可回滚——
   * 代码默认保持方图不变，避免并发方整体升 HEAD 自动部署时误激活【未验证】的尺寸导致全部出图失败。
   */
  defaultSize?: string;
  /** 是否打水印，默认 false。 */
  watermark?: boolean;
  /** 单次请求超时（毫秒，默认 60s；Seedream 实测 ~15s）。 */
  timeoutMs?: number;
  /** 日志注入。 */
  logger?: Pick<Console, 'log' | 'warn' | 'error'>;
  /** 注入 fetch（测试用），默认全局 fetch。 */
  fetchImpl?: typeof fetch;
}

/** Ark images/generations 响应（OpenAI 形状：data[].url）。 */
interface ArkImageResponse {
  data?: Array<{ url?: string; b64_json?: string }>;
  error?: { message?: string; code?: string; type?: string };
  code?: string;
  message?: string;
}

export class SeedreamClient implements ImageProvider {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly getModel?: () => string;
  private readonly defaultSize: string;
  private readonly watermark: boolean;
  private readonly timeoutMs: number;
  private readonly logger: Pick<Console, 'log' | 'warn' | 'error'>;
  private readonly fetchImpl: typeof fetch;

  constructor(options: SeedreamClientOptions = {}) {
    this.apiKey = options.apiKey ?? process.env.ARK_API_KEY ?? process.env.VOLCENGINE_API_KEY ?? '';
    this.baseUrl = (options.baseUrl ?? ARK_IMAGE_BASE_URL).replace(/\/+$/, '');
    this.model = options.model ?? 'doubao-seedream-4-5-251128';
    this.getModel = options.getModel;
    this.defaultSize = options.defaultSize ?? process.env.AIDCP_SEEDREAM_IMAGE_SIZE ?? '2048x2048';
    this.watermark = options.watermark ?? false;
    this.timeoutMs = options.timeoutMs && options.timeoutMs > 0 ? options.timeoutMs : 60_000;
    this.logger = options.logger ?? console;
    const f = options.fetchImpl ?? globalThis.fetch;
    if (!f) throw new Error('global fetch 不可用（需 Node>=18）；请注入 fetchImpl');
    this.fetchImpl = f;
  }

  /** 生成图片：Ark 同步单次请求。失败诚实回 { url: null, error }，绝不抛、绝不伪造 URL。 */
  async generate(prompt: string, style?: string, options?: ImageGenerateOptions): Promise<ImageResult> {
    const withReferenceStatus = (result: ImageResult): ImageResult =>
      options?.referenceImages?.length ? { ...result, referenceStatus: 'unsupported', referenceUsed: false } : result;
    if (!this.apiKey) {
      // 缺密钥在发请求前诚实失败（红线：绝不发空 Bearer、绝不跨厂商兜底）。
      return { url: null, error: '即梦-Seedream key 缺失（在后台为火山方舟配置密钥并重启 cloud）' };
    }

    // Ark 基础文生图无独立 style 字段：风格并入提示词文本（与万相一致）。
    const text = style ? `${prompt}，风格：${style}` : prompt;
    const body = JSON.stringify({
      model: this.getModel?.() ?? this.model,
      prompt: text,
      size: this.defaultSize,
      response_format: 'url',
      watermark: this.watermark,
    });

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await this.fetchImpl(`${this.baseUrl}/images/generations`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
        },
        body,
        signal: controller.signal,
      });

      if (!res.ok) {
        const errText = await res.text().catch(() => '');
        const errMsg = `即梦-Seedream 请求失败 HTTP ${res.status}: ${errText.slice(0, 200)}`;
        this.logger.error(errMsg);
        return withReferenceStatus({ url: null, error: errMsg });
      }

      const data = (await res.json()) as ArkImageResponse;
      if (data.error || (data.code && data.code !== 'Success' && data.code !== '0')) {
        const errMsg = `即梦-Seedream 返回错误: ${data.error?.code ?? data.code ?? ''} - ${data.error?.message ?? data.message ?? ''}`;
        this.logger.error(errMsg);
        return withReferenceStatus({ url: null, error: errMsg });
      }

      const url = data.data?.find((d) => d.url)?.url ?? null;
      if (!url) {
        return { url: null, error: '即梦-Seedream 响应缺少图片 URL' };
      }
      return withReferenceStatus({ url });
    } catch (err) {
      const aborted = err instanceof Error && err.name === 'AbortError';
      const errMsg = aborted
        ? `即梦-Seedream 请求超时（${this.timeoutMs}ms）`
        : `即梦-Seedream 请求异常: ${err instanceof Error ? err.message : String(err)}`;
      this.logger.error(errMsg);
      return withReferenceStatus({ url: null, error: errMsg });
    } finally {
      clearTimeout(timer);
    }
  }
}
