/**
 * 账号归属执行目标的跨属主契约（kernel）：占位结果类型 + 窄读写端口。
 * 实现方在 api（account-store），持有方在 automation（连接握手路径）。
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
  /** 仅当归属为空时原子占位。已被占位 → already_owned_by（附真实属主），MUST NOT 覆盖。保留供运维/兼容口，握手路径已改用 setExecutionTarget。 */
  claimExecutionTarget(accountId: string, target: DeploymentTarget): Promise<ClaimExecutionTargetResult>;
  /**
   * 无条件把归属改写为当前 target（change risk-target-follows-active-session）。
   * 归属**跟随当次连接**：每次握手都调用它，把 accounts.execution_target 更新为正在接入的 target。
   * 账号不存在 → account_not_found（**绝不 seed 造行**）。
   */
  setExecutionTarget(accountId: string, target: DeploymentTarget): Promise<ClaimExecutionTargetResult>;
}
