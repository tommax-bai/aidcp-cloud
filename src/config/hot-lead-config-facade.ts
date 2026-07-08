/**
 * 引流线索热度过滤阈值面板外观（全局单例，change feed-hot-lead-group-comment）。
 *
 * 把「三阈值回显」与「全局写（校验）」收口成可单测的外观，与 server 装配解耦。落「安全」页一张卡片。
 *
 * 红线：写前校验每个数字（>=1 的有限整数 + 合理上限）；任一非法整块拒、绝不部分落库、绝不假成功。
 *       回显服务端真态（经 store.getGateConfig 逐项回落 → 显示=当前真生效）。只动 hot_lead_config_global。
 */
import type { HotLeadConfigStore } from './hot-lead-config-store.js';
import type {
  PanelHotLeadConfig,
  HotLeadConfigView,
  HotLeadConfigSetResult,
} from '../panel/types.js';

/** 合理上限：帖龄≤1年小时数、速率/赞≤千万，挡误输入天文数字。 */
const HOT_LEAD_LIMIT_MAX = 10_000_000;

const isValidPositive = (n: unknown): n is number =>
  typeof n === 'number' && Number.isInteger(n) && n >= 1 && n <= HOT_LEAD_LIMIT_MAX;

export interface HotLeadConfigFacadeDeps {
  store: HotLeadConfigStore;
}

export function createHotLeadConfigPanel(deps: HotLeadConfigFacadeDeps): PanelHotLeadConfig {
  const buildView = (): HotLeadConfigView => {
    const cfg = deps.store.getGateConfig();
    const row = deps.store.getRow();
    return {
      postAgeMaxHours: cfg.maxAgeHours,
      velocityMin: cfg.velocityMin,
      minLikeFloor: cfg.minLikeFloor,
      overridden: !!row,
      updatedAt: row?.updatedAt ?? null,
      updatedBy: row?.updatedBy ?? null,
    };
  };

  return {
    getView: buildView,
    set: async (patch, updatedBy): Promise<HotLeadConfigSetResult> => {
      const provided = [patch.postAgeMaxHours, patch.velocityMin, patch.minLikeFloor];
      if (provided.every((v) => v === undefined)) return { ok: false, reason: 'no_valid_fields' };
      for (const v of provided) {
        if (v !== undefined && !isValidPositive(v)) return { ok: false, reason: 'invalid_value' };
      }
      const storePatch: Parameters<HotLeadConfigStore['set']>[0] = {};
      if (patch.postAgeMaxHours !== undefined) storePatch.postAgeMaxHours = patch.postAgeMaxHours;
      if (patch.velocityMin !== undefined) storePatch.velocityMin = patch.velocityMin;
      if (patch.minLikeFloor !== undefined) storePatch.minLikeFloor = patch.minLikeFloor;
      await deps.store.set(storePatch, updatedBy);
      return { ok: true, view: buildView() };
    },
  };
}
