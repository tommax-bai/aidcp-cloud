/**
 * 单场会话上限面板外观（全局单例，change restore-auto-resume-and-global-safety-config）。
 *
 * 把「全局单场时长 + 七项互动预算回显」与「全局写（校验）」收口成可单测的外观，与 server 装配解耦。
 * 不再有账号维度（用户 2026-06-27 拍板：取消账号、改全局通用，对所有账号生效）。
 *
 * 红线：写前校验每个数字（非负有限整数 + 合理上限；时长另需 >=1）；任一非法整块拒、
 *       绝不部分落库、绝不假成功。回显服务端真态（非乐观；经提供者回落 → 显示=当前真生效）。
 *       本外观只动 session_config_global，不碰风控状态单写路径（risk_state / setQuotaLevel / applySignal）、不经协议。
 *
 * ## 写入通道归属：本外观即 `session_config_global` 后台编辑的唯一窄内部写口，归 aidcp-automation
 *   （change config-table-write-collection；依据定稿方案 §5.1 / §4.6.8）。
 *
 * - 后台编辑 MUST 走 console → api → automation：面板/api 侧只持接口 `PanelSessionLimits`
 *   （src/panel/types.ts），automation 侧实现本外观并独占 store 引用。**aidcp-api MUST NOT 直写
 *   `session_config_global`**——panel-server 既不 import store、也无该表的 pg 写路径，只经本接口下发。
 * - 今日同进程即直调；拆进程时把 api 侧 `PanelSessionLimits` 的实现换成内部 HTTP 客户端、
 *   automation 侧仍是本外观即可，**panel-server 调用点一行不改、行为零变更、只换通道**。
 * - **MUST NOT 破坏镜像失效接线**：写仍只经 `store.set()` → `writeWithMirrorBump`
 *   （同事务推进镜像版本），供另一 target 的刷新器在 T_poll 内失效重载（change config-mirror-*）。
 */

import { SESSION_BUDGET_KEYS, SESSION_LIMIT_MAX, isValidWeekActiveMask } from '../risk/session-limits.js';
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
  // 全局回显：时长 + 七项预算经提供者口取（无行 / 字段非法已逐项回落 → 显示=当前真生效）；
  // overridden 看库内是否存在全局行（false = 显示的是写死默认）。
  const buildView = (): SessionLimitView => {
    const row = deps.store.getRow();
    return {
      maxDurationMin: Math.round(deps.store.sessionDurationMs() / 60_000),
      budget: deps.store.sessionBudget(),
      // 比例闸以「1:N 的 N」回显：经提供者口取比例后还原分母（无行 / 非法已回落默认 → 显示=当前真生效）。
      collectSaveLikeDenom: Math.round(1 / deps.store.collectSaveLikeRatio()),
      followFansDenom: Math.round(1 / deps.store.followFansRatio()),
      // 「可活跃时间」周历掩码：null = 未配置 / 不限（全天活跃）。提供者已对非法值回落 null。
      activeWeekMask: deps.store.weekActiveMask(),
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
      if (provided.every((v) => v === undefined) && patch.activeWeekMask === undefined) {
        return { ok: false, reason: 'no_valid_fields' };
      }

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
      // 「可活跃时间」周历掩码：传了就必须是 168 长的 '0'/'1' 串（非法整块拒，绝不落脏掩码）。
      if (patch.activeWeekMask !== undefined && !isValidWeekActiveMask(patch.activeWeekMask)) {
        return { ok: false, reason: 'invalid_value' };
      }

      const storePatch: SessionConfigPatch = {};
      if (patch.maxDurationMin !== undefined) storePatch.maxDurationMin = patch.maxDurationMin;
      for (const key of SESSION_BUDGET_KEYS) {
        const v = patch[key];
        if (v !== undefined) storePatch[key] = v;
      }
      if (patch.collectSaveLikeDenom !== undefined) storePatch.collectSaveLikeDenom = patch.collectSaveLikeDenom;
      if (patch.followFansDenom !== undefined) storePatch.followFansDenom = patch.followFansDenom;
      if (patch.activeWeekMask !== undefined) storePatch.activeWeekMask = patch.activeWeekMask;

      await deps.store.set(storePatch, updatedBy);
      return { ok: true, view: buildView() };
    },
  };
}
