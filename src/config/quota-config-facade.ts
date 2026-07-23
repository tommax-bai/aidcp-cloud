/**
 * 安全限额面板外观（change safety-quota-config，stream D）。
 *
 * 把「三档 × 动作 × 三窗口生效值视图」与「按 (tier,action) 写（校验）」收口成可单测的外观，
 * 与 server 装配解耦。复刻 role-config-facade 形态。
 *
 * 红线：写前校验每个数字（非负有限整数 + 合理上限 + 合法 tier/action）；任一非法整块拒、
 *       绝不部分落库、绝不假成功。回显服务端真态（非乐观）。本外观只动 quota_config，不碰风控状态。
 *
 * ## 写入通道归属：本外观即 `quota_config` 后台编辑的唯一窄内部写口，归 aidcp-automation
 *   （change config-table-write-collection；依据定稿方案 §5.1 / §4.6.8）。
 *
 * - 后台编辑 MUST 走 console → api → automation：面板/api 侧只持接口 `PanelQuotaConfig`
 *   （src/panel/types.ts），automation 侧实现本外观并独占 store 引用。**aidcp-api MUST NOT 直写
 *   `quota_config`**——panel-server 既不 import store、也无该表的 pg 写路径，只经本接口下发。
 * - 今日同进程即直调；拆进程时把 api 侧 `PanelQuotaConfig` 的实现换成内部 HTTP 客户端、
 *   automation 侧仍是本外观即可，**panel-server 调用点一行不改、行为零变更、只换通道**。
 * - **MUST NOT 破坏镜像失效接线**：写仍只经 `store.set()` → `writeWithMirrorBump`
 *   （同事务推进镜像版本），供另一 target 的刷新器在 T_poll 内失效重载（change config-mirror-*）。
 */

import { QUOTA_MAX } from '../risk/quotas.js';
import {
  RISK_ACTIONS,
  RISK_QUOTA_LEVELS,
  type RiskAction,
  type RiskQuotaLevel,
} from '../risk/types.js';
import type { QuotaConfigStore } from './quota-config-store.js';
import type {
  PanelQuotaConfig,
  QuotaConfigCatalogView,
  QuotaConfigRowView,
  QuotaConfigSetResult,
} from '../panel/types.js';

export interface QuotaConfigFacadeDeps {
  store: QuotaConfigStore;
}

const isValidQuotaNumber = (n: unknown): n is number =>
  typeof n === 'number' && Number.isInteger(n) && n >= 0 && n <= QUOTA_MAX;

export function createQuotaConfigPanel(deps: QuotaConfigFacadeDeps): PanelQuotaConfig {
  const buildCatalog = (): QuotaConfigCatalogView => {
    const quotas: QuotaConfigRowView[] = [];
    for (const tier of RISK_QUOTA_LEVELS) {
      // 该档位三窗口生效值（库值优先、缺则派生写死默认）——即运营看到的当前真生效。
      const win = deps.store.windowQuotasFor(tier);
      for (const action of RISK_ACTIONS) {
        const row = deps.store.getRow(tier, action);
        quotas.push({
          tier,
          action,
          daily: win.day[action],
          perMinute: win.minute[action],
          perHour: win.hour[action],
          overridden: !!row,
          updatedAt: row?.updatedAt ?? null,
          updatedBy: row?.updatedBy ?? null,
        });
      }
    }
    return { quotas };
  };

  return {
    getCatalog: buildCatalog,
    setQuota: async (patch, updatedBy): Promise<QuotaConfigSetResult> => {
      if (!RISK_QUOTA_LEVELS.includes(patch.tier)) return { ok: false, reason: 'unknown_tier' };
      if (!RISK_ACTIONS.includes(patch.action)) return { ok: false, reason: 'unknown_action' };

      // 至少要带一个窗口值；带了的窗口必须合法（非负有限整数 + 上限）。任一非法整块拒、不落库。
      const provided: Array<number | undefined> = [patch.daily, patch.perMinute, patch.perHour];
      if (provided.every((v) => v === undefined)) return { ok: false, reason: 'no_valid_fields' };
      for (const v of provided) {
        if (v !== undefined && !isValidQuotaNumber(v)) return { ok: false, reason: 'invalid_value' };
      }

      await deps.store.set(
        patch.tier as RiskQuotaLevel,
        patch.action as RiskAction,
        { daily: patch.daily, perMinute: patch.perMinute, perHour: patch.perHour },
        updatedBy,
      );
      return { ok: true, view: buildCatalog() };
    },
  };
}
