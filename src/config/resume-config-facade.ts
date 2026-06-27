/**
 * 自动续场护栏 + 看门狗阈值面板外观（change session-auto-resume-with-excursions）。
 *
 * 把「按账号续场配置回显」与「按账号写（校验）」收口成可单测的外观，与 server 装配解耦。
 * 复刻 session-config-facade 形态。
 *
 * 红线：写前逐字段校验（非负有限整数 + 各自合理上限；分钟数 0..1440；轻推 >= 90s；放弃 > 轻推由 store 读时兜底）；
 *       任一非法整块拒、绝不部分落库、绝不假成功。回显服务端真态（非乐观；经提供者回落 → 显示=当前真生效）。
 *       本外观只动 resume_config，不碰风控状态单写路径（risk_state / setQuotaLevel / applySignal）、不经协议。
 */

import {
  IDLE_MS_MAX,
  IDLE_NUDGE_MIN_MS,
  MINUTES_PER_DAY,
  REST_RATIO_PCT_MAX,
} from '../risk/resume-limits.js';
import type { ResumeConfigPatch, ResumeConfigStore } from './resume-config-store.js';
import type {
  PanelResumeConfig,
  ResumeConfigCatalogView,
  ResumeConfigPatchInput,
  ResumeConfigRowView,
  ResumeConfigSetResult,
} from '../panel/types.js';

export interface ResumeConfigFacadeDeps {
  store: ResumeConfigStore;
}

const isInt = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n);
const inRange = (n: unknown, min: number, max: number): boolean => isInt(n) && n >= min && n <= max;

export function createResumeConfigPanel(deps: ResumeConfigFacadeDeps): PanelResumeConfig {
  // 单账号回显行：各项经提供者口取（缺行 / 字段非法已逐项回落 → 显示=当前真生效）；
  // overridden 看库内是否存在该账号行（false = 显示的是写死默认）。
  const buildRow = (accountId: string): ResumeConfigRowView => {
    const row = deps.store.getRow(accountId);
    const win = deps.store.activeWindowFor(accountId);
    const caps = deps.store.dailyCapsFor(accountId);
    return {
      accountId,
      restRatioPct: Math.round(deps.store.restRatioFor(accountId) * 100),
      activeWindowStartMin: win.startMin,
      activeWindowEndMin: win.endMin,
      dailyMaxSessions: caps.maxSessions,
      dailyMaxMinutes: caps.maxMinutes,
      idleNudgeMs: deps.store.idleNudgeMsFor(accountId),
      idleEndMs: deps.store.idleEndMsFor(accountId),
      overridden: !!row,
      updatedAt: row?.updatedAt ?? null,
      updatedBy: row?.updatedBy ?? null,
    };
  };

  const buildCatalog = (): ResumeConfigCatalogView => {
    const accountIds = new Set<string>(['default']);
    for (const id of deps.store.getAll().keys()) accountIds.add(id);
    return { configs: [...accountIds].sort().map(buildRow) };
  };

  // 逐字段校验规则（每项独立、非法即整块拒）。
  const fieldChecks: Array<[keyof ResumeConfigPatchInput, (v: number) => boolean]> = [
    ['restRatioPct', (v) => inRange(v, 0, REST_RATIO_PCT_MAX)],
    ['activeWindowStartMin', (v) => inRange(v, 0, MINUTES_PER_DAY)],
    ['activeWindowEndMin', (v) => inRange(v, 0, MINUTES_PER_DAY)],
    ['dailyMaxSessions', (v) => inRange(v, 0, 100_000)],
    ['dailyMaxMinutes', (v) => inRange(v, 0, 100_000)],
    ['idleNudgeMs', (v) => inRange(v, IDLE_NUDGE_MIN_MS, IDLE_MS_MAX)],
    ['idleEndMs', (v) => inRange(v, IDLE_NUDGE_MIN_MS, IDLE_MS_MAX)],
  ];

  return {
    getCatalog: buildCatalog,
    set: async (patch, updatedBy): Promise<ResumeConfigSetResult> => {
      if (typeof patch.accountId !== 'string' || patch.accountId.length === 0) {
        return { ok: false, reason: 'invalid_value' };
      }

      const provided = fieldChecks.filter(([key]) => patch[key] !== undefined);
      if (provided.length === 0) return { ok: false, reason: 'no_valid_fields' };
      for (const [key, ok] of provided) {
        if (!ok(patch[key] as number)) return { ok: false, reason: 'invalid_value' };
      }

      const storePatch: ResumeConfigPatch = {};
      for (const [key] of provided) {
        (storePatch as Record<string, number>)[key] = patch[key] as number;
      }

      await deps.store.set(patch.accountId, storePatch, updatedBy);
      return { ok: true, view: buildCatalog() };
    },
  };
}
