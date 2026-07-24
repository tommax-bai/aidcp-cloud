/**
 * 图片厂商注册表的**纯数据段 + 无状态归一**（原定义在 src/publish-agent/image-providers.ts，content）。
 * 抬入 kernel（change decouple-longtail-sweep）供 api 侧面板版本视图 / 配置外观跨边界共导。
 * 零 SQL / HTTP / LLM / 模块级 Set-Map，仅字面枚举 + Object.hasOwnProperty 归一，满足 §4.7 kernel 准入。
 * 路由客户端类 RoutingImageProvider（依赖 image-provider.js 的 ImageProvider）留 image-providers.ts（content）。
 */

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
