/**
 * 单场会话上限面板外观（change session-limits-to-quota-layer）。
 *
 * 把「按账号的单场时长 + 六项互动预算回显」与「按账号写（校验）」收口成可单测的外观，
 * 与 server 装配解耦。复刻 quota-config-facade 形态。
 *
 * 红线：写前校验每个数字（非负有限整数 + 合理上限；时长另需 >=1）；任一非法整块拒、
 *       绝不部分落库、绝不假成功。回显服务端真态（非乐观；经提供者回落 → 显示=当前真生效）。
 *       本外观只动 session_config，不碰风控状态单写路径（risk_state / setQuotaLevel / applySignal）、不经协议。
 */

import { SESSION_BUDGET_KEYS, SESSION_LIMIT_MAX } from '../risk/session-limits.js';
import type { SessionConfigPatch, SessionConfigStore } from './session-config-store.js';
import type {
  PanelSessionLimits,
  SessionLimitCatalogView,
  SessionLimitRowView,
  SessionLimitSetResult,
} from '../panel/types.js';

export interface SessionLimitFacadeDeps {
  store: SessionConfigStore;
}

const isValidLimitNumber = (n: unknown): n is number =>
  typeof n === 'number' && Number.isInteger(n) && n >= 0 && n <= SESSION_LIMIT_MAX;

export function createSessionLimitPanel(deps: SessionLimitFacadeDeps): PanelSessionLimits {
  // 单账号回显行：时长 + 六项预算经提供者口取（缺行 / 字段非法已逐项回落 → 显示=当前真生效）；
  // overridden 看库内是否存在该账号行（false = 显示的是写死默认）。
  const buildRow = (accountId: string): SessionLimitRowView => {
    const row = deps.store.getRow(accountId);
    return {
      accountId,
      maxDurationMin: Math.round(deps.store.sessionDurationMsFor(accountId) / 60_000),
      budget: deps.store.sessionBudgetFor(accountId),
      overridden: !!row,
      updatedAt: row?.updatedAt ?? null,
      updatedBy: row?.updatedBy ?? null,
    };
  };

  const buildCatalog = (): SessionLimitCatalogView => {
    // default 账号恒列（单租户下唯一账号）+ 库内已覆盖账号；按账号名排序稳定回显。
    const accountIds = new Set<string>(['default']);
    for (const id of deps.store.getAll().keys()) accountIds.add(id);
    return { limits: [...accountIds].sort().map(buildRow) };
  };

  return {
    getCatalog: buildCatalog,
    set: async (patch, updatedBy): Promise<SessionLimitSetResult> => {
      if (typeof patch.accountId !== 'string' || patch.accountId.length === 0) {
        return { ok: false, reason: 'invalid_value' };
      }

      // 至少带一个可改字段；带了的字段必须合法（非负有限整数 + 上限；时长另需 >=1）。任一非法整块拒、不落库。
      const provided: Array<number | undefined> = [
        patch.maxDurationMin,
        ...SESSION_BUDGET_KEYS.map((k) => patch[k]),
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

      const storePatch: SessionConfigPatch = {};
      if (patch.maxDurationMin !== undefined) storePatch.maxDurationMin = patch.maxDurationMin;
      for (const key of SESSION_BUDGET_KEYS) {
        const v = patch[key];
        if (v !== undefined) storePatch[key] = v;
      }

      await deps.store.set(patch.accountId, storePatch, updatedBy);
      return { ok: true, view: buildCatalog() };
    },
  };
}
