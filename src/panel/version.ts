/**
 * GET /api/version：面板 API 契约版本 + live 枚举值 + 关键 DTO 字段指纹。
 *
 * console（aidcp-console）镜像一份枚举/字段，并对本接口断言以防三处漂移（design.md D11 +
 * change console-cloud-panel-hardening #4/#5/#6）。所有真值来自 cloud 的唯一 runtime 源
 * （RISK_STATUSES / RISK_QUOTA_LEVELS / RISK_ACTIONS / *_PROVIDERS / PanelAccount 字段清单），
 * 故 console 拿到的永远是 cloud 当下真值，而非硬编码副本；本地哨兵对拍此真值即可检出漂移
 * （不再「副本对副本」恒绿）。
 */

import { RISK_ACTIONS, RISK_STATUSES, RISK_QUOTA_LEVELS } from '../risk/index.js';
import { ALERT_SEVERITIES } from '../feishu/index.js';
import { TEXT_PROVIDERS } from '../llm/providers.js';
import { IMAGE_PROVIDERS } from '../kernel/image-provider-registry.js';
import type { PanelAccount } from './panel-store.js';
import type { LlmKind, ThinkingModeApi } from '../config/role-catalog.js';
import type { ModelEffectiveSource, PersonaSource } from './types.js';

/** 面板 API 契约版本号。接口形状变更时递增。 */
// v7（change risk-target-follows-active-session）：PanelAccount 去掉 executionTarget / riskWritable，
//    改为只读展示字段 currentDriverTarget（最近一次握手的驱动目标；写权已改回账号级不按归属禁用）。
// v6（change unified-account-display-name）：PanelAccount 增加运营别名和统一展示名投影。
// v5（change wechat-panel-permission-visibility）：新增只读视频号互动权限概览端点。
// v4（change generalize-contact-info）：PanelAccount.groupChatInfo → contactInfo（DTO 字段改名）。
export const PANEL_API_VERSION = 7;

/**
 * PanelAccount 字段权威清单（console 镜像对拍此清单防漂移，#5/#6）。
 * 下方 type-level 断言强制它与 PanelAccount 的键严格一致——漏/多字段均编译失败（对齐 protocol.ts 穷举范式）。
 */
export const PANEL_ACCOUNT_FIELDS = [
  'accountId',
  'label',
  'nickname',
  'operatorAlias',
  'displayName',
  'displayNameSource',
  'platform',
  'groupLabel',
  'machineLabel',
  'contactInfo',
  'operatorStatus',
  'pausedAt',
  'riskStatus',
  'riskQuotaLevel',
  'signalCount',
  'personaBound',
  'needsPersonaSetup',
  // change risk-target-follows-active-session：只读展示「最近一次握手的驱动目标」（归属跟随当次连接）。
  'currentDriverTarget',
  'environmentSummary',
] as const;

// typecheck 强制：清单必须恰好覆盖 PanelAccount 的键。若接口加字段没同步进清单，_Missing 非 never → 编译失败；
// 反之清单多余字段 _Extra 非 never → 编译失败。使 DTO 字段漂移在 cloud typecheck 阶段即暴露。
type _AssertNever<T extends never> = T;
type _PanelAccountFieldsMissing = _AssertNever<Exclude<keyof PanelAccount, (typeof PANEL_ACCOUNT_FIELDS)[number]>>;
type _PanelAccountFieldsExtra = _AssertNever<Exclude<(typeof PANEL_ACCOUNT_FIELDS)[number], keyof PanelAccount>>;
export type { _PanelAccountFieldsMissing, _PanelAccountFieldsExtra };

/**
 * 面板角色 / 模型配置枚举的权威 runtime 全集（console 镜像对拍此清单防漂移，change
 * console-panel-config-enum-fingerprint）。这些值被 console 用作 `{text,color}` 徽标映射的键，
 * 漂移会令未同步的 console 出现「键缺失」→ 曾使 /roles 整页崩（`llmKind:'vision'` / `effectiveSource:'vision'`）。
 * 类型定义仍在 role-catalog.ts / panel/types.ts；此处仅并列出 runtime 全集供 `/api/version` 导出。
 * 下方 `_AssertNever` 强制数组恰好覆盖对应类型全集——漏 / 多成员均编译失败（对齐 PANEL_ACCOUNT_FIELDS 范式）。
 */
export const LLM_KINDS = ['text', 'image', 'vision', 'none'] as const;
export const MODEL_EFFECTIVE_SOURCES = ['override', 'category', 'default', 'image', 'vision'] as const;
export const PERSONA_SOURCES = ['override', 'none'] as const;
export const THINKING_MODES_API = ['default', 'off', 'on'] as const;

type _LlmKindMissing = _AssertNever<Exclude<LlmKind, (typeof LLM_KINDS)[number]>>;
type _LlmKindExtra = _AssertNever<Exclude<(typeof LLM_KINDS)[number], LlmKind>>;
type _ModelEffectiveSourceMissing = _AssertNever<Exclude<ModelEffectiveSource, (typeof MODEL_EFFECTIVE_SOURCES)[number]>>;
type _ModelEffectiveSourceExtra = _AssertNever<Exclude<(typeof MODEL_EFFECTIVE_SOURCES)[number], ModelEffectiveSource>>;
type _PersonaSourceMissing = _AssertNever<Exclude<PersonaSource, (typeof PERSONA_SOURCES)[number]>>;
type _PersonaSourceExtra = _AssertNever<Exclude<(typeof PERSONA_SOURCES)[number], PersonaSource>>;
type _ThinkingModeApiMissing = _AssertNever<Exclude<ThinkingModeApi, (typeof THINKING_MODES_API)[number]>>;
type _ThinkingModeApiExtra = _AssertNever<Exclude<(typeof THINKING_MODES_API)[number], ThinkingModeApi>>;
export type {
  _LlmKindMissing,
  _LlmKindExtra,
  _ModelEffectiveSourceMissing,
  _ModelEffectiveSourceExtra,
  _PersonaSourceMissing,
  _PersonaSourceExtra,
  _ThinkingModeApiMissing,
  _ThinkingModeApiExtra,
};

export interface VersionPayload {
  panelApiVersion: number;
  enums: {
    riskStatus: readonly string[];
    riskQuotaLevel: readonly string[];
    riskAction: readonly string[];
    /** 告警分级（V1 task 9.5 落地后补；console 镜像对其断言，防三处漂移 D11）。 */
    alertSeverity: readonly string[];
    /** 文本生成厂商全集（console 镜像对拍，#6）。 */
    textProvider: readonly string[];
    /** 图片生成厂商全集（console 镜像对拍，#5——图片厂商漂移的哨兵）。 */
    imageProvider: readonly string[];
    /** 模型类型全集（含 vision 视觉角色；console KIND_LABEL 徽标映射键，漂移哨兵）。 */
    llmKind: readonly string[];
    /** 生效模型来源全集（含 vision；console SOURCE_TAG 徽标映射键，漂移哨兵）。 */
    effectiveSource: readonly string[];
    /** 人设来源全集（console 人设页 SOURCE_TAG 徽标映射键，漂移哨兵）。 */
    personaSource: readonly string[];
    /** 思考模式三态全集（console THINKING_TAG 徽标映射键，漂移哨兵）。 */
    thinkingMode: readonly string[];
  };
  /** 关键 DTO 字段指纹（console 镜像对拍防漂移，#5/#6）。 */
  dtoFields: {
    panelAccount: readonly string[];
  };
}

export function buildVersionPayload(): VersionPayload {
  return {
    panelApiVersion: PANEL_API_VERSION,
    enums: {
      riskStatus: RISK_STATUSES,
      riskQuotaLevel: RISK_QUOTA_LEVELS,
      riskAction: RISK_ACTIONS,
      alertSeverity: ALERT_SEVERITIES,
      textProvider: Object.keys(TEXT_PROVIDERS),
      imageProvider: Object.keys(IMAGE_PROVIDERS),
      llmKind: LLM_KINDS,
      effectiveSource: MODEL_EFFECTIVE_SOURCES,
      personaSource: PERSONA_SOURCES,
      thinkingMode: THINKING_MODES_API,
    },
    dtoFields: {
      panelAccount: PANEL_ACCOUNT_FIELDS,
    },
  };
}
