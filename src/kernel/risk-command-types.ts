/**
 * 风控**写命令**的跨属主契约（change cloud-coupling-phase5 · P5-1）。
 *
 * ## 为什么是异步（用户 2026-07-25 拍板）
 *
 * 面板上有两个会改写账号风控最终状态的操作（施加人工信号 / 改配额档位）。CLAUDE §2 的铁律是
 * **风控最终状态只由 `RiskController` 单写**，而拆进程后那个单写者物理上落在 automation 服务——
 * api 进程里没有、也不该有它。于是这两个写只能变成「api 提交命令 → automation 应用 → api 回读结果」。
 *
 * ## 返回形状为什么不能保留写后真态
 *
 * 今天这两条路由返回的是 `{ state, statusBefore, changed }`，即**写后真实状态**——因为面板与风控
 * 同进程，调完就知道结果。异步之后 api **不可能**在受理的那一刻知道结果，任何 `state` 字段都只能
 * 是编的。那正是红线「静默假成功」的教科书形态：操作员看到一个绿色的「已限制」，而命令可能
 * 还在队列里、甚至已经失败。
 *
 * 所以本契约把两件事**分成两个形状**：
 *   - 提交只回 {@link RiskCommandAccepted}（**只有 commandId，没有任何状态字段**）；
 *   - 结果由 {@link RiskCommandPort.outcomeOf} 单独回读，是 {@link RiskCommandOutcome} 四态之一。
 *
 * ## 四态里 `unknown` 为什么必须存在
 *
 * 「查不到这条命令」与「这条命令还在处理中」是两件完全不同的事，前者意味着提交那一步就没落库
 * （或 id 被写错），后者只是还没轮到。把前者当成 `processing`，界面会永远转圈、永远不报错，
 * 操作员以为系统在忙——这是另一种静默假成功。故 `unknown` 独立成态，且 MUST 被界面区分渲染。
 *
 * 零 import、零 SQL、零 HTTP、零 LLM、无进程内活状态，满足 §4.7 kernel 准入。
 */

/** 提交受理回执。**刻意不含任何写后状态字段**——受理那一刻 api 不可能知道结果。 */
export interface RiskCommandAccepted {
  /** 命令的持久标识（= outbox 行 id 的字符串形式）。回读结果、审计追溯都用它。 */
  commandId: string;
}

/** 风控写命令的终局/中间态。 */
export type RiskCommandOutcome =
  /** 已受理、单写者尚未应用。界面 MUST 显式渲染「处理中」，MUST NOT 伪装成已生效。 */
  | { commandId: string; state: 'processing' }
  /** 单写者已应用。`status` / `quotaLevel` 是**单写者写完后回读的真态**，非提交方推断。 */
  | { commandId: string; state: 'applied'; decidedAt: number; status: string; quotaLevel: string }
  /** 单写者应用失败（含风控层拒绝）。`reason` MUST 可读，界面 MUST 显示它。 */
  | { commandId: string; state: 'failed'; decidedAt: number; reason: string }
  /** 查无此命令。与 processing 严格区分——见文件头说明。 */
  | { commandId: string; state: 'unknown' };

/** 提交一条人工风控信号。`kind` 的合法集合由风控层枚举，此处只约束非空。 */
export interface SubmitRiskSignalInput {
  accountId: string;
  kind: string;
  /** 审计理由。`operator_override_recover` 这类绕过恢复窗口的信号 MUST 带。 */
  reason?: string;
  /** 提交人（面板用户），入审计。 */
  requestedBy: string;
}

export interface SubmitRiskQuotaLevelInput {
  accountId: string;
  level: string;
  requestedBy: string;
}

/**
 * 面板侧唯一的风控写出口。
 *
 * **本端口不暴露任何同步写方法**——`applySignal` / `setQuotaLevel` / `recoverRestricted` 这三个
 * 真正改状态的方法只活在 automation 的 `RiskController` 上。面板拿到的永远只是「提交 + 回读」。
 */
export interface RiskCommandPort {
  submitSignal(input: SubmitRiskSignalInput): Promise<RiskCommandAccepted>;
  submitQuotaLevel(input: SubmitRiskQuotaLevelInput): Promise<RiskCommandAccepted>;
  outcomeOf(commandId: string): Promise<RiskCommandOutcome>;
}
