/**
 * 单场会话上限面板外观（全局单例，change restore-auto-resume-and-global-safety-config）。
 *
 * 把「全局单场时长 + 六项互动预算回显」与「全局写（校验）」收口成可单测的外观，与 server 装配解耦。
 * 不再有账号维度（用户 2026-06-27 拍板：取消账号、改全局通用，对所有账号生效）。
 *
 * 红线：写前校验每个数字（非负有限整数 + 合理上限；时长另需 >=1）；任一非法整块拒、
 *       绝不部分落库、绝不假成功。回显服务端真态（非乐观；经提供者回落 → 显示=当前真生效）。
 *       本外观只动 session_config_global，不碰风控状态单写路径（risk_state / setQuotaLevel / applySignal）、不经协议。
 */

import { SESSION_BUDGET_KEYS, SESSION_LIMIT_MAX } from '../risk/session-limits.js';
import type { SessionConfigPatch, SessionConfigStore } from './session-config-store.js';
import type {
  PanelSessionLimits,
  SessionLimitView,
  SessionLimitSetResult,
} from '../panel/types.js';

export interface SessionLimitFacadeDeps {
  store: SessionConfigStore;
}

const isValidLimitNumber = (n: unknown): n is number =>
  typeof n === 'number' && Number.isInteger(n) && n >= 0 && n <= SESSION_LIMIT_MAX;

export function createSessionLimitPanel(deps: SessionLimitFacadeDeps): PanelSessionLimits {
  // 全局回显：时长 + 六项预算经提供者口取（无行 / 字段非法已逐项回落 → 显示=当前真生效）；
  // overridden 看库内是否存在全局行（false = 显示的是写死默认）。
  const buildView = (): SessionLimitView => {
    const row = deps.store.getRow();
    return {
      maxDurationMin: Math.round(deps.store.sessionDurationMs() / 60_000),
      budget: deps.store.sessionBudget(),
      // 比例闸以「1:N 的 N」回显：经提供者口取比例后还原分母（无行 / 非法已回落默认 → 显示=当前真生效）。
      collectSaveLikeDenom: Math.round(1 / deps.store.collectSaveLikeRatio()),
      followFansDenom: Math.round(1 / deps.store.followFansRatio()),
      overridden: !!row,
      updatedAt: row?.updatedAt ?? null,
      updatedBy: row?.updatedBy ?? null,
    };
  };

  return {
    getView: buildView,
    set: async (patch, updatedBy): Promise<SessionLimitSetResult> => {
      // 至少带一个可改字段；带了的字段必须合法（非负有限整数 + 上限；时长另需 >=1）。任一非法整块拒、不落库。
      const provided: Array<number | undefined> = [
        patch.maxDurationMin,
        ...SESSION_BUDGET_KEYS.map((k) => patch[k]),
        patch.collectSaveLikeDenom,
        patch.followFansDenom,
      ];
      if (provided.every((v) => v === undefined)) return { ok: false, reason: 'no_valid_fields' };

      if (patch.maxDurationMin !== undefined) {
        if (!isValidLimitNumber(patch.maxDurationMin) || patch.maxDurationMin < 1) {
          return { ok: false, reason: 'invalid_value' };
        }
      }
      for (const key of SESSION_BUDGET_KEYS) {
        const v = patch[key];
        if (v !== undefined && !isValidLimitNumber(v)) return { ok: false, reason: 'invalid_value' };
      }
      // 比例分母：整数 + 合理上限 + 另需 >= 1（0 = 除零无意义、会把闸搞坏）。任一非法整块拒。
      for (const denomKey of ['collectSaveLikeDenom', 'followFansDenom'] as const) {
        const v = patch[denomKey];
        if (v !== undefined && (!isValidLimitNumber(v) || v < 1)) {
          return { ok: false, reason: 'invalid_value' };
        }
      }

      const storePatch: SessionConfigPatch = {};
      if (patch.maxDurationMin !== undefined) storePatch.maxDurationMin = patch.maxDurationMin;
      for (const key of SESSION_BUDGET_KEYS) {
        const v = patch[key];
        if (v !== undefined) storePatch[key] = v;
      }
      if (patch.collectSaveLikeDenom !== undefined) storePatch.collectSaveLikeDenom = patch.collectSaveLikeDenom;
      if (patch.followFansDenom !== undefined) storePatch.followFansDenom = patch.followFansDenom;

      await deps.store.set(storePatch, updatedBy);
      return { ok: true, view: buildView() };
    },
  };
}
