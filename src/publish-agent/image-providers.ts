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
// 图片厂商注册表纯数据段 + 无状态归一抬入 kernel（change decouple-longtail-sweep）供 api 侧跨边界共导；
// 本文件从 kernel 导入并等值再导出，令既有消费方无感。路由客户端类 RoutingImageProvider 留本文件。
import {
  DEFAULT_IMAGE_PROVIDER,
  IMAGE_PROVIDERS,
  isKnownImageProvider,
  normImageProvider,
  type ImageProviderId,
  type ImageProviderMeta,
} from '../kernel/image-provider-registry.js';
export {
  DEFAULT_IMAGE_PROVIDER,
  IMAGE_PROVIDERS,
  isKnownImageProvider,
  normImageProvider,
  type ImageProviderId,
  type ImageProviderMeta,
};

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
