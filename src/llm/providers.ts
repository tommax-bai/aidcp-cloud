/**
 * 文本厂商注册表（change model-config-volcengine-provider）。
 *
 * 一份字面常量枚举所有 OpenAI 兼容的文本厂商；扩展即"加一条字面项 + 扩 union"，
 * 不提供 register() / 动态发现（YAGNI：只有少数同形厂商）。
 *
 * 仅文本：图片（通义万相）走 DashScope 独立客户端，不在此注册、不经此路由。
 */

import { DEFAULT_BASE_URL as DASHSCOPE_BASE_URL } from './qwen.js';

export interface TextProviderMeta {
  /** 稳定 id（落库 provider 列值、provider_credentials.provider 键）。 */
  id: string;
  /** 后台展示名。 */
  displayName: string;
  /** 默认兼容端点（OpenAI 形状 /chat/completions 的 base）。 */
  baseUrlDefault: string;
  /** 可选 env 覆盖 baseUrl（区域/自定义端点）；缺省用 baseUrlDefault。 */
  baseUrlEnv?: string;
  /** provider_credentials.field 值（该厂商 API key 的字段名）。 */
  credentialField: string;
  /** db 内凭据缺失时的 key env 回退键（按序取第一个非空）。 */
  envKeys: string[];
}

/** 已知文本厂商 id（扩展厂商时在此扩 union + 下方加一条字面项，TS 强制穷举）。 */
export type TextProviderId = 'dashscope' | 'volcengine';

/** 代码默认厂商（零回归基准 + 归一回落目标）。 */
export const DEFAULT_TEXT_PROVIDER: TextProviderId = 'dashscope';

export const TEXT_PROVIDERS: Record<TextProviderId, TextProviderMeta> = {
  dashscope: {
    id: 'dashscope',
    displayName: '阿里百炼 DashScope',
    baseUrlDefault: DASHSCOPE_BASE_URL,
    credentialField: 'dashscope_api_key',
    envKeys: ['DASHSCOPE_API_KEY'],
  },
  volcengine: {
    id: 'volcengine',
    displayName: '火山引擎方舟 Ark',
    baseUrlDefault: 'https://ark.cn-beijing.volces.com/api/v3',
    baseUrlEnv: 'ARK_BASE_URL',
    credentialField: 'volcengine_api_key',
    envKeys: ['ARK_API_KEY', 'VOLCENGINE_API_KEY'],
  },
};

/** provider 是否注册。 */
export function isKnownProvider(p: string | null | undefined): p is TextProviderId {
  return typeof p === 'string' && Object.prototype.hasOwnProperty.call(TEXT_PROVIDERS, p);
}

/**
 * 归一：已知 provider 原样返回，空 / 未知 / 脏串一律回落代码默认厂商。
 * 红线：绝不 brick、绝不跨层混搭（某层 provider 缺失只回落代码默认，不继承别层）。
 */
export function normProvider(p: string | null | undefined): TextProviderId {
  const t = p?.trim();
  return isKnownProvider(t) ? t : DEFAULT_TEXT_PROVIDER;
}

/** (provider, field) 是否在注册表派生的写白名单内（写凭据校验用）。 */
export function isAllowedCredential(provider: string, field: string): boolean {
  return isKnownProvider(provider) && TEXT_PROVIDERS[provider].credentialField === field;
}

/** 该 provider 的生效 baseUrl（env 覆盖 → 默认）。 */
export function resolveProviderBaseUrl(
  id: TextProviderId,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const meta = TEXT_PROVIDERS[id];
  const override = meta.baseUrlEnv ? env[meta.baseUrlEnv]?.trim() : undefined;
  return override || meta.baseUrlDefault;
}

/** 该 provider 的 key 的 env 回退值（按 envKeys 顺序取第一个非空）；无则 undefined。 */
export function resolveProviderEnvKey(
  id: TextProviderId,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  for (const k of TEXT_PROVIDERS[id].envKeys) {
    const v = env[k]?.trim();
    if (v) return v;
  }
  return undefined;
}
