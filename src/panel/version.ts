/**
 * GET /api/version：面板 API 契约版本 + live 枚举值。
 *
 * console（aidcp-console）镜像一份枚举，并对本接口断言以防三处漂移（design.md D11）。
 * 枚举值来自 cloud 风控类型的唯一 runtime 源（RISK_STATUSES / RISK_QUOTA_LEVELS / RISK_ACTIONS），
 * 故 console 拿到的永远是 cloud 当下真值，而非硬编码副本。
 */

import { RISK_ACTIONS, RISK_STATUSES, RISK_QUOTA_LEVELS } from '../risk/index.js';

/** 面板 API 契约版本号。接口形状变更时递增。 */
export const PANEL_API_VERSION = 1;

export interface VersionPayload {
  panelApiVersion: number;
  enums: {
    riskStatus: readonly string[];
    riskQuotaLevel: readonly string[];
    riskAction: readonly string[];
  };
}

export function buildVersionPayload(): VersionPayload {
  return {
    panelApiVersion: PANEL_API_VERSION,
    enums: {
      riskStatus: RISK_STATUSES,
      riskQuotaLevel: RISK_QUOTA_LEVELS,
      riskAction: RISK_ACTIONS,
    },
  };
}
