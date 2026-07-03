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
import { IMAGE_PROVIDERS } from '../publish-agent/image-providers.js';
import type { PanelAccount } from './panel-store.js';

/** 面板 API 契约版本号。接口形状变更时递增。 */
export const PANEL_API_VERSION = 2;

/**
 * PanelAccount 字段权威清单（console 镜像对拍此清单防漂移，#5/#6）。
 * 下方 type-level 断言强制它与 PanelAccount 的键严格一致——漏/多字段均编译失败（对齐 protocol.ts 穷举范式）。
 */
export const PANEL_ACCOUNT_FIELDS = [
  'accountId',
  'label',
  'nickname',
  'platform',
  'groupLabel',
  'machineLabel',
  'groupChatInfo',
  'operatorStatus',
  'pausedAt',
  'riskStatus',
  'riskQuotaLevel',
  'signalCount',
  'personaBound',
  'needsPersonaSetup',
] as const;

// typecheck 强制：清单必须恰好覆盖 PanelAccount 的键。若接口加字段没同步进清单，_Missing 非 never → 编译失败；
// 反之清单多余字段 _Extra 非 never → 编译失败。使 DTO 字段漂移在 cloud typecheck 阶段即暴露。
type _AssertNever<T extends never> = T;
type _PanelAccountFieldsMissing = _AssertNever<Exclude<keyof PanelAccount, (typeof PANEL_ACCOUNT_FIELDS)[number]>>;
type _PanelAccountFieldsExtra = _AssertNever<Exclude<(typeof PANEL_ACCOUNT_FIELDS)[number], keyof PanelAccount>>;
export type { _PanelAccountFieldsMissing, _PanelAccountFieldsExtra };

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
    },
    dtoFields: {
      panelAccount: PANEL_ACCOUNT_FIELDS,
    },
  };
}
