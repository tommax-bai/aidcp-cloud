/**
 * 操作兜底 floor 面板外观（change pacing-floor-config-min-interval）。
 *
 * 把「各类操作生效兜底区间视图」与「按 operation 写（校验）」收口成可单测的外观，与 server 装配解耦。
 * 复刻 quota-config-facade 形态。
 *
 * 红线：写前校验区间（非负有限整数 + `min ≤ max` + 最小展宽 `max ≥ min×1.5`（防零展宽退化打掉防指纹）+
 *       `≤ 类别上限`）；任一非法整块拒、绝不部分落库、绝不假成功。回显服务端真态（非乐观）。
 *       生效值经 store 读出口 clamp（含非零防呆下限护栏）——配置只能抬高延迟、抬不穿非零下限。
 *       本外观只动 pacing_floor_config，不碰风控状态单写路径。
 *
 * ## 写入通道归属：本外观即 `pacing_floor_config` 后台编辑的唯一窄内部写口，归 aidcp-automation
 *   （change config-table-write-collection；依据定稿方案 §5.1 / §4.6.8）。
 *
 * - 后台编辑 MUST 走 console → api → automation：面板/api 侧只持接口 `PanelPacingConfig`
 *   （src/panel/types.ts），automation 侧实现本外观并独占 store 引用。**aidcp-api MUST NOT 直写
 *   `pacing_floor_config`**——panel-server 既不 import store、也无该表的 pg 写路径，只经本接口下发。
 * - 今日同进程即直调；拆进程时把 api 侧 `PanelPacingConfig` 的实现换成内部 HTTP 客户端、
 *   automation 侧仍是本外观即可，**panel-server 调用点一行不改、行为零变更、只换通道**。
 * - **MUST NOT 破坏镜像失效接线**：写仍只经 `store.set()` → `writeWithMirrorBump`
 *   （同事务推进镜像版本），供另一 target 的刷新器在 T_poll 内失效重载（change config-mirror-*）。
 */

import { PACING_OPS, maxFloorForOp } from '../risk/pacing.js';
import type { PacingOp } from '../comm/protocol.js';
import type { PacingConfigStore } from './pacing-config-store.js';
import type {
  PacingConfigCatalogView,
  PacingConfigRowView,
  PacingConfigSetResult,
  PanelPacingConfig,
} from '../kernel/config-panel-ports.js';

export interface PacingConfigFacadeDeps {
  store: PacingConfigStore;
}

const isKnownOp = (op: unknown): op is PacingOp =>
  typeof op === 'string' && (PACING_OPS as readonly string[]).includes(op);

/** 单个 ms 边界值合法：非负有限整数 + 不超过类别上限。 */
const isValidBound = (op: PacingOp, n: unknown): n is number =>
  typeof n === 'number' && Number.isInteger(n) && n >= 0 && n <= maxFloorForOp(op);

export function createPacingConfigPanel(deps: PacingConfigFacadeDeps): PanelPacingConfig {
  const buildCatalog = (): PacingConfigCatalogView => {
    const pacing: PacingConfigRowView[] = [];
    for (const op of PACING_OPS) {
      // 生效值 = 读出口 clamp 后（库值优先、缺则内置默认；含非零下限护栏）——即运营看到的当前真生效。
      const eff = deps.store.floorFor(op);
      const row = deps.store.getRow(op);
      pacing.push({
        operation: op,
        minMs: eff.minMs,
        maxMs: eff.maxMs,
        overridden: !!row,
        updatedAt: row?.updatedAt ?? null,
        updatedBy: row?.updatedBy ?? null,
      });
    }
    return { pacing };
  };

  return {
    getCatalog: buildCatalog,
    setPacing: async (patch, updatedBy): Promise<PacingConfigSetResult> => {
      if (!isKnownOp(patch.operation)) return { ok: false, reason: 'unknown_operation' };

      const { minMs, maxMs } = patch;
      // 两值须成对给；都缺 → no_valid_fields（无可写字段）。
      if (minMs === undefined && maxMs === undefined) return { ok: false, reason: 'no_valid_fields' };
      // 单值缺、非整数、负数、超类别上限 → 整块拒（区间必须两端齐备且合法）。
      if (!isValidBound(patch.operation, minMs) || !isValidBound(patch.operation, maxMs)) return { ok: false, reason: 'invalid_value' };
      // 顺序 + 最小展宽：`max ≤ min`（含零展宽 min==max）或展宽不足 `max < min×1.5` → 整块拒。
      if (maxMs <= minMs || maxMs < minMs * 1.5) return { ok: false, reason: 'invalid_value' };

      await deps.store.set(patch.operation, { minMs, maxMs }, updatedBy);
      return { ok: true, view: buildCatalog() };
    },
  };
}
