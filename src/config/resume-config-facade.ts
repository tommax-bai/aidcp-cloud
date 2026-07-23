/**
 * 自动续场护栏 + 看门狗阈值面板外观（全局单例，change restore-auto-resume-and-global-safety-config）。
 *
 * 把「全局续场配置回显」与「全局写（校验）」收口成可单测的外观，与 server 装配解耦。
 * 不再有账号维度（用户 2026-06-27 拍板：取消账号、改全局通用，对所有账号生效）。
 *
 * 红线：写前逐字段校验（非负有限整数 + 各自合理上限；分钟数 0..1440；轻推 >= 90s；放弃 > 轻推由 store 读时兜底）；
 *       任一非法整块拒、绝不部分落库、绝不假成功。回显服务端真态（非乐观；经提供者回落 → 显示=当前真生效）。
 *       本外观只动 resume_config_global，不碰风控状态单写路径（risk_state / setQuotaLevel / applySignal）、不经协议。
 *
 * ## 写入通道归属：本外观即 `resume_config_global` 后台编辑的唯一窄内部写口，归 aidcp-automation
 *   （change config-table-write-collection；依据定稿方案 §5.1 / §4.6.8）。
 *
 * - 后台编辑 MUST 走 console → api → automation：面板/api 侧只持接口 `PanelResumeConfig`
 *   （src/panel/types.ts），automation 侧实现本外观并独占 store 引用。**aidcp-api MUST NOT 直写
 *   `resume_config_global`**——panel-server 既不 import store、也无该表的 pg 写路径，只经本接口下发。
 * - 今日同进程即直调；拆进程时把 api 侧 `PanelResumeConfig` 的实现换成内部 HTTP 客户端、
 *   automation 侧仍是本外观即可，**panel-server 调用点一行不改、行为零变更、只换通道**。
 * - **MUST NOT 破坏镜像失效接线**：写仍只经 `store.set()` → `writeWithMirrorBump`
 *   （同事务推进镜像版本），供另一 target 的刷新器在 T_poll 内失效重载（change config-mirror-*）。
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
  ResumeConfigPatchInput,
  ResumeConfigView,
  ResumeConfigSetResult,
} from '../panel/types.js';

export interface ResumeConfigFacadeDeps {
  store: ResumeConfigStore;
}

const isInt = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n);
const inRange = (n: unknown, min: number, max: number): boolean => isInt(n) && n >= min && n <= max;

export function createResumeConfigPanel(deps: ResumeConfigFacadeDeps): PanelResumeConfig {
  // 全局回显：各项经提供者口取（无行 / 字段非法已逐项回落 → 显示=当前真生效）；
  // overridden 看库内是否存在全局行（false = 显示的是写死默认）。
  const buildView = (): ResumeConfigView => {
    const row = deps.store.getRow();
    const win = deps.store.activeWindow();
    const caps = deps.store.dailyCaps();
    return {
      restRatioPct: Math.round(deps.store.restRatio() * 100),
      activeWindowStartMin: win.startMin,
      activeWindowEndMin: win.endMin,
      dailyMaxSessions: caps.maxSessions,
      dailyMaxMinutes: caps.maxMinutes,
      idleNudgeMs: deps.store.idleNudgeMs(),
      idleEndMs: deps.store.idleEndMs(),
      overridden: !!row,
      updatedAt: row?.updatedAt ?? null,
      updatedBy: row?.updatedBy ?? null,
    };
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
    getView: buildView,
    set: async (patch, updatedBy): Promise<ResumeConfigSetResult> => {
      const provided = fieldChecks.filter(([key]) => patch[key] !== undefined);
      if (provided.length === 0) return { ok: false, reason: 'no_valid_fields' };
      for (const [key, ok] of provided) {
        if (!ok(patch[key] as number)) return { ok: false, reason: 'invalid_value' };
      }

      const storePatch: ResumeConfigPatch = {};
      for (const [key] of provided) {
        (storePatch as Record<string, number>)[key] = patch[key] as number;
      }

      await deps.store.set(storePatch, updatedBy);
      return { ok: true, view: buildView() };
    },
  };
}
