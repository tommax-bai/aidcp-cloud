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

/** 归属占位的诚实结果：占位成功 / 已被占位（附真实属主），MUST NOT 在已被占位时覆盖。 */
export type ClaimExecutionTargetResult =
  | { outcome: 'claimed'; target: DeploymentTarget }
  | { outcome: 'already_owned_by'; target: DeploymentTarget }
  | { outcome: 'account_not_found' };

/**
 * 归属事实的窄读写口（跨边界写入登记，tasks 3.1b 决议①）。
 *
 * 拆分方案 §5.1 把 `accounts` 定为 **aidcp-api 单写**，并明确：automation 在握手路径上占位 / 改写
 * 归属 MUST 经 api 的窄内部接口完成、MUST NOT 直写该表。今天三者仍在一个进程里，故该「窄内部接口」
 * 就是这个接口：**实现方是 account-store（api 侧），automation 侧（connection-runtime / 风控注册表）
 * 只持有本接口、只调方法、绝不自己拼 accounts 的 SQL**。拆进程时把它换成一次内部 HTTP 即可，
 * 调用点一行不用改。风控写路径对 execution_target 只**读**（属主谓词），不写。
 */
export interface AccountOwnershipPort {
  /** 读账号归属；未归属 → null；账号不存在 → null（调用方按「未归属」处理，与 NULL 同形）。 */
  getExecutionTarget(accountId: string): Promise<DeploymentTarget | null>;
  /** 仅当归属为空时原子占位。已被占位 → already_owned_by（附真实属主），MUST NOT 覆盖。 */
  claimExecutionTarget(accountId: string, target: DeploymentTarget): Promise<ClaimExecutionTargetResult>;
}

/**
 * 归属强制模式（AIDCP_RISK_OWNERSHIP_ENFORCE）。
 *
 * - `enforce`：条件写谓词生效、握手拒绝生效、面板写口拒绝生效。
 * - `observe`（默认）：占位照做、**每一次本会被拒的操作都留一条可检索告警**，但不拒绝。
 *   观察模式 MUST NOT 静默——它的存在意义是「先证明零跨 target 争用，再翻开强制」，
 *   而不是「先假装没事」。
 * - `off`：本进程未解析出合法 executionTarget（fail-closed），风控写路径整体不启用。
 */
export type OwnershipMode = 'enforce' | 'observe' | 'off';

/**
 * risk_state 条件写影响 0 行。**三种触发原因必须能从错误里区分**：
 * 账号不存在 / 归属为空 / 归属是别人。MUST NOT 返回成功、MUST NOT 重试、MUST NOT 换谓词绕过。
 */
export class RiskStateNotOwnedError extends Error {
  readonly code = 'risk_state_not_owned';

  constructor(
    readonly accountId: string,
    /** 本进程（写方）的 target。 */
    readonly expectedTarget: DeploymentTarget,
    /** 库里的真实归属：另一个 target / null=未归属 / undefined=账号不存在。 */
    readonly actualTarget: DeploymentTarget | null | undefined,
    readonly cause2: 'account_not_found' | 'unowned' | 'owned_by_other',
  ) {
    super(
      `risk_state_not_owned account=${accountId} writer=${expectedTarget} owner=${
        actualTarget === undefined ? '<account_not_found>' : (actualTarget ?? '<unowned>')
      }`,
    );
    this.name = 'RiskStateNotOwnedError';
  }
}

export function isRiskStateNotOwnedError(err: unknown): err is RiskStateNotOwnedError {
  return err instanceof RiskStateNotOwnedError;
}

/** 归属强制模式的环境解析：缺省 observe（两阶段发布的第一阶段）。 */
export function parseOwnershipEnforce(value: unknown): boolean {
  return typeof value === 'string' && value.trim().toLowerCase() === 'true';
}
