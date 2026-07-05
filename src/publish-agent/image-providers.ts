/**
 * 图片厂商注册表 + 路由（change image-provider-volcengine-seedream）。
 *
 * 图片侧从"钉死万相"升级为可选厂商：`dashscope`（通义万相，DashScope 异步）/
 * `volcengine`（即梦-Seedream，火山方舟 Ark 同步）。一份字面枚举，扩展即加一条字面项 + 扩 union（YAGNI）。
 *
 * 与文本 `providers.ts` 分开：图片厂商语义/端点/客户端与文本不同（异步万相 vs 同步 Seedream），
 * 不共用 `normProvider`。密钥仍复用 `providerRuntime`（同厂商同 key），不重复造凭据存储。
 */

import type { ImageGenerateOptions, ImageProvider, ImageResult } from './image-provider.js';

/** 已知图片厂商 id（扩展时在此扩 union + 下方加一条字面项，TS 强制穷举）。 */
export type ImageProviderId = 'dashscope' | 'volcengine';

/** 代码默认图片厂商（零回归基准 + 归一回落目标）。 */
export const DEFAULT_IMAGE_PROVIDER: ImageProviderId = 'dashscope';

export interface ImageProviderMeta {
  id: ImageProviderId;
  /** 后台展示名。 */
  displayName: string;
}

export const IMAGE_PROVIDERS: Record<ImageProviderId, ImageProviderMeta> = {
  dashscope: { id: 'dashscope', displayName: '阿里百炼 · 通义万相' },
  volcengine: { id: 'volcengine', displayName: '火山方舟 · 即梦 Seedream' },
};

/** provider 是否已注册。 */
export function isKnownImageProvider(p: string | null | undefined): p is ImageProviderId {
  return typeof p === 'string' && Object.prototype.hasOwnProperty.call(IMAGE_PROVIDERS, p);
}

/**
 * 归一：已知 provider 原样返回，空 / 未知 / 脏串一律回落代码默认厂商。
 * 红线：归一**只**用于未知 provider（绝不 brick）；绝不用于把"已选定但生图失败/缺密钥"的厂商偷换掉。
 */
export function normImageProvider(p: string | null | undefined): ImageProviderId {
  const t = p?.trim();
  return isKnownImageProvider(t) ? t : DEFAULT_IMAGE_PROVIDER;
}

export interface RoutingImageProviderOptions {
  /** 运行时取当前全局图片厂商（热加载；如 () => modelConfigStore.getCached().imageProvider）。 */
  getProvider: () => string;
  /** 已装配的各图片厂商客户端。 */
  providers: Partial<Record<ImageProviderId, ImageProvider>>;
  logger?: Pick<Console, 'log' | 'warn' | 'error'>;
}

/**
 * 图片出口：每次生成按当前配置的图片厂商分发到对应客户端。
 * - 归一后选中厂商 → 转交其 `generate`（成败由该客户端诚实回报，不在此改写）。
 * - 选中厂商未装配（理论不应发生，防御）→ 诚实回 error，绝不静默改用另一厂商。
 */
export class RoutingImageProvider implements ImageProvider {
  private readonly getProvider: () => string;
  private readonly providers: Partial<Record<ImageProviderId, ImageProvider>>;
  private readonly logger: Pick<Console, 'log' | 'warn' | 'error'>;

  constructor(options: RoutingImageProviderOptions) {
    this.getProvider = options.getProvider;
    this.providers = options.providers;
    this.logger = options.logger ?? console;
  }

  async generate(prompt: string, style?: string, options?: ImageGenerateOptions): Promise<ImageResult> {
    const id = normImageProvider(this.getProvider());
    const provider = this.providers[id];
    if (!provider) {
      const errMsg = `图片厂商 ${id} 未装配（缺对应客户端）`;
      this.logger.error(`[image-router] ${errMsg}`);
      return { url: null, error: errMsg, referenceStatus: options?.referenceImages?.length ? 'unavailable' : 'skipped' };
    }
    return provider.generate(prompt, style, options);
  }
}
