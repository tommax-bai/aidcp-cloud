/**
 * 平台凭据注册表（change platform-provider-credentials-config）。
 *
 * provider_credentials 本身是通用 (provider, field) 加密表；这里集中声明后台允许写入、
 * GET /api/config/model 允许展示、以及 env 回退的凭据项。扩展平台凭据只改这一处。
 */

import { TEXT_PROVIDERS, type TextProviderId } from '../llm/providers.js';

export type PlatformCredentialGroup = 'model_api' | 'billing_access';

export interface PlatformCredentialDefinition {
  provider: string;
  field: string;
  label: string;
  providerLabel: string;
  group: PlatformCredentialGroup;
  groupLabel: string;
  envKeys: string[];
  secretKind: 'api_key' | 'access_key_id' | 'access_key_secret';
  restartRequired: boolean;
}

const MODEL_API_GROUP = '模型 API Key';
const BILLING_ACCESS_GROUP = '账单查询 AccessKey';

const modelCredentials: PlatformCredentialDefinition[] = (Object.keys(TEXT_PROVIDERS) as TextProviderId[]).map((id) => ({
  provider: id,
  field: TEXT_PROVIDERS[id].credentialField,
  label: `${TEXT_PROVIDERS[id].displayName} API Key`,
  providerLabel: TEXT_PROVIDERS[id].displayName,
  group: 'model_api',
  groupLabel: MODEL_API_GROUP,
  envKeys: TEXT_PROVIDERS[id].envKeys,
  secretKind: 'api_key',
  restartRequired: true,
}));

export const PLATFORM_CREDENTIALS: readonly PlatformCredentialDefinition[] = [
  ...modelCredentials,
  {
    provider: 'aliyun',
    field: 'access_key_id',
    label: '阿里云平台 AccessKey ID',
    providerLabel: '阿里云平台',
    group: 'billing_access',
    groupLabel: BILLING_ACCESS_GROUP,
    envKeys: ['ALIYUN_BILLING_ACCESS_KEY_ID', 'ALIBABA_CLOUD_ACCESS_KEY_ID', 'ALIYUN_ACCESS_KEY_ID'],
    secretKind: 'access_key_id',
    restartRequired: true,
  },
  {
    provider: 'aliyun',
    field: 'access_key_secret',
    label: '阿里云平台 AccessKey Secret',
    providerLabel: '阿里云平台',
    group: 'billing_access',
    groupLabel: BILLING_ACCESS_GROUP,
    envKeys: ['ALIYUN_BILLING_ACCESS_KEY_SECRET', 'ALIBABA_CLOUD_ACCESS_KEY_SECRET', 'ALIYUN_ACCESS_KEY_SECRET'],
    secretKind: 'access_key_secret',
    restartRequired: true,
  },
  {
    provider: 'volcengine',
    field: 'access_key_id',
    label: '火山引擎平台 AccessKey ID',
    providerLabel: '火山引擎平台',
    group: 'billing_access',
    groupLabel: BILLING_ACCESS_GROUP,
    envKeys: ['VOLCENGINE_BILLING_ACCESS_KEY_ID', 'VOLC_ACCESSKEY', 'VOLCENGINE_ACCESS_KEY_ID'],
    secretKind: 'access_key_id',
    restartRequired: true,
  },
  {
    provider: 'volcengine',
    field: 'access_key_secret',
    label: '火山引擎平台 AccessKey Secret',
    providerLabel: '火山引擎平台',
    group: 'billing_access',
    groupLabel: BILLING_ACCESS_GROUP,
    envKeys: ['VOLCENGINE_BILLING_ACCESS_KEY_SECRET', 'VOLC_SECRETKEY', 'VOLCENGINE_ACCESS_KEY_SECRET'],
    secretKind: 'access_key_secret',
    restartRequired: true,
  },
];

export function findPlatformCredential(provider: string, field: string): PlatformCredentialDefinition | undefined {
  return PLATFORM_CREDENTIALS.find((item) => item.provider === provider && item.field === field);
}

export function isAllowedPlatformCredential(provider: string, field: string): boolean {
  return !!findPlatformCredential(provider, field);
}

export function resolvePlatformCredentialEnvValue(
  credential: PlatformCredentialDefinition,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  for (const key of credential.envKeys) {
    const value = env[key]?.trim();
    if (value) return value;
  }
  return undefined;
}
