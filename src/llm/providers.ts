/**
 * 文本厂商端点表（content）。身份段（id / 展示名 / 凭据字段 / envKeys）已提到
 * src/kernel/text-provider-registry.ts；本文件只留端点与合流后的旧导入面。
 */

import { DEFAULT_BASE_URL as DASHSCOPE_BASE_URL } from './qwen.js';
import {
  DEFAULT_TEXT_PROVIDER,
  TEXT_PROVIDER_META,
  isAllowedCredential,
  isKnownProvider,
  normProvider,
  type TextProviderId,
  type TextProviderIdentity,
} from '../kernel/text-provider-registry.js';

export {
  DEFAULT_TEXT_PROVIDER,
  TEXT_PROVIDER_META,
  isAllowedCredential,
  isKnownProvider,
  normProvider,
};
export type { TextProviderId, TextProviderIdentity };

interface TextProviderEndpoint {
  /** 默认兼容端点（OpenAI 形状 /chat/completions 的 base）。 */
  baseUrlDefault: string;
  /** 可选 env 覆盖 baseUrl（区域/自定义端点）；缺省用 baseUrlDefault。 */
  baseUrlEnv?: string;
}

export type TextProviderMeta = TextProviderIdentity & TextProviderEndpoint;

const TEXT_PROVIDER_ENDPOINTS: Record<TextProviderId, TextProviderEndpoint> = {
  dashscope: { baseUrlDefault: DASHSCOPE_BASE_URL },
  volcengine: { baseUrlDefault: 'https://ark.cn-beijing.volces.com/api/v3', baseUrlEnv: 'ARK_BASE_URL' },
};

export const TEXT_PROVIDERS: Record<TextProviderId, TextProviderMeta> = {
  dashscope: { ...TEXT_PROVIDER_META.dashscope, ...TEXT_PROVIDER_ENDPOINTS.dashscope },
  volcengine: { ...TEXT_PROVIDER_META.volcengine, ...TEXT_PROVIDER_ENDPOINTS.volcengine },
};

/** 该 provider 的生效 baseUrl（env 覆盖 → 默认）。 */
export function resolveProviderBaseUrl(
  id: TextProviderId,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const meta = TEXT_PROVIDER_ENDPOINTS[id];
  const override = meta.baseUrlEnv ? env[meta.baseUrlEnv]?.trim() : undefined;
  return override || meta.baseUrlDefault;
}

/** 该 provider 的 key 的 env 回退值（按 envKeys 顺序取第一个非空）；无则 undefined。 */
export function resolveProviderEnvKey(
  id: TextProviderId,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  for (const k of TEXT_PROVIDER_META[id].envKeys) {
    const v = env[k]?.trim();
    if (v) return v;
  }
  return undefined;
}
