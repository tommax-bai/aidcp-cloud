/**
 * 账号归属执行目标（change risk-state-cross-process-integrity，design D3/D4）。
 *
 * dev 与 ol 是两个进程、两个 target、**一个库**。「每 target 单实例」只解决同一 target 内的多写者，
 * 跨 target 仍然是两个写者。解法不是给 risk_state / risk_counters 加 target 分区键——那会把
 * 「配额合计翻倍」从 bug 固化成 schema（平台不关心是我们哪个进程点的赞，一个账号在平台眼里只有
 * 一份活动预算）——而是让**账号归属唯一**：accounts.execution_target 是写权谓词的唯一权威。
 *
 * 分工一句话：**分裂的是写权限，不分裂的是事实。** risk_state 的写按 target 排他；
 * risk_counters 是 append-only 的既成事实账本，不按 target 分裂。
 */
import type { DeploymentTarget } from '../deployment-target.js';

export type { AccountOwnershipPort, ClaimExecutionTargetResult } from '../kernel/account-ownership-port.js';

/**
 * risk_state 条件写模式（change risk-target-follows-active-session）。
 *
 * 归属已改为「跟随当次连接」：握手无条件把 accounts.execution_target 设成当前 target，
 * 故条件写谓词在正常运行时**总是命中**。它只在「两个连接并发接管同一账号」的瞬间 rowCount=0，
 * 那正是需要作废先写方的止血场景。
 *
 * - `enforce`（有合法 target 时的默认）：条件写谓词生效；0 行即作废先写方（抛错→驱逐）。
 * - `off`：无合法 executionTarget（fail-closed），或 `AIDCP_RISK_OWNERSHIP_ENFORCE=false` 秒级回滚——
 *   退回历史无谓词 upsert（逐位零回归、不作废）。
 *
 * 旧的 `observe`（条件写但 0 行仍按历史语义盖写）已删除：那正是「后写方盖回先写方」的原路，
 * 与本 change 要保证的止血直接冲突。
 */
export type OwnershipMode = 'enforce' | 'off';

/**
 * risk_state 条件写影响 0 行：**账号已被另一个连接接管，本次状态写作废**。
 *
 * 握手刚把归属设成当前 target，故谓词正常总命中；rowCount=0 只发生在写入前的一瞬另一个连接
 * 抢先接管了同一账号（把 execution_target 改成了别的 target），此时先写方的这次 risk_state 写
 * MUST 作废——MUST NOT 返回成功、MUST NOT 重试、MUST NOT 换个宽松谓词把它盖回去。
 *
 * 三种触发原因仍可区分：账号不存在 / 归属为空 / 归属已是别的 target。
 */
export class RiskStateNotOwnedError extends Error {
  readonly code = 'risk_state_not_owned';

  constructor(
    readonly accountId: string,
    /** 本进程（先写方）的 target。 */
    readonly expectedTarget: DeploymentTarget,
    /** 写入前一瞬库里的真实归属：接管方的 target / null=未归属 / undefined=账号不存在。 */
    readonly actualTarget: DeploymentTarget | null | undefined,
    readonly cause2: 'account_not_found' | 'unowned' | 'owned_by_other',
  ) {
    super(
      `risk_state_taken_over account=${accountId} writer=${expectedTarget} owner=${
        actualTarget === undefined ? '<account_not_found>' : (actualTarget ?? '<unowned>')
      }`,
    );
    this.name = 'RiskStateNotOwnedError';
  }
}

export function isRiskStateNotOwnedError(err: unknown): err is RiskStateNotOwnedError {
  return err instanceof RiskStateNotOwnedError;
}
