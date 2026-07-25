/**
 * 文本厂商身份注册表（kernel）：id / 展示名 / 凭据字段 / env 回退键。
 * 端点（baseUrlDefault / baseUrlEnv）留 content 的 src/llm/providers.ts。
 */

export interface TextProviderIdentity {
  id: string;
  displayName: string;
  credentialField: string;
  envKeys: string[];
}

export type TextProviderId = 'dashscope' | 'volcengine';

export const DEFAULT_TEXT_PROVIDER: TextProviderId = 'dashscope';

export const TEXT_PROVIDER_META: Record<TextProviderId, TextProviderIdentity> = {
  dashscope: {
    id: 'dashscope',
    displayName: '阿里百炼 DashScope',
    credentialField: 'dashscope_api_key',
    envKeys: ['DASHSCOPE_API_KEY'],
  },
  volcengine: {
    id: 'volcengine',
    displayName: '火山引擎方舟 Ark',
    credentialField: 'volcengine_api_key',
    envKeys: ['ARK_API_KEY', 'VOLCENGINE_API_KEY'],
  },
};

export function isKnownProvider(p: string | null | undefined): p is TextProviderId {
  return typeof p === 'string' && Object.prototype.hasOwnProperty.call(TEXT_PROVIDER_META, p);
}

export function normProvider(p: string | null | undefined): TextProviderId {
  const t = p?.trim();
  return isKnownProvider(t) ? t : DEFAULT_TEXT_PROVIDER;
}

export function isAllowedCredential(provider: string, field: string): boolean {
  return isKnownProvider(provider) && TEXT_PROVIDER_META[provider].credentialField === field;
}
