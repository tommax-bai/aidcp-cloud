/**
 * 抢占语义收口（change lease-strict-preemption 批 C）。
 *
 * 「被抢占 ≠ 失败」贯穿云端多处失败分类：发布指令编排（command-sequencer）、发布下发段
 * （publish-dispatcher）、评论调度（comment-scheduler）、浏览闭环调度（role-dispatcher）、
 * 加群调度（facebook-group-join-scheduler）。这些点各自读**裸字符串**原因（协议两端各写一份、
 * typecheck 跨端不校验——CLAUDE.md §2 第 5 处漂移点），若各写各的字面量集合，漏一个就退回烧稿。
 * 本模块把这组字符串与判据收成**单一事实源**，所有消费点一律 import 此处，杜绝集合漂移。
 *
 * 两条抵达渠道（消费点据此选读 error 还是 reason）：
 * - `publish.command.result.error` / `action.completed.reason`：边缘对**在飞的那条命令**如实回执
 *   （`preempted_by_task` 打字中途被接管、`task_lease_mismatch` 命令到达时租约已不在）。
 * - `edge.task.released.reason`：租约级释放（`window_busy` 撞提交窗口、`yield_timeout` 写者不停手），
 *   由 edge-task-lease-client 处理；只有在 7.5「活跃租约中断」把在飞命令**就地 reject** 时才会以
 *   `CommandPreemptedError` 形态流进命令编排的 catch。
 *
 * 红线：被抢占的作业 MUST 保持可重投（保持待审 / 不写 failed 终态 / 不计熔断）；但**提交动作已派发**
 * （submitDispatched===true 或已 submitted）的一律走「已提交待确认」终态、绝不重投（防双发）——该判据
 * 优先于本模块，由各消费点在调用本判据**之前**先判。
 */

/**
 * 「被抢占，不是失败」的原因字符串全集。
 * - `preempted_by_task`：被严格高档位抢占、edge 已确认写者真停（提交前，可干净重投）。
 * - `task_lease_mismatch`：命令到达边缘时该 taskId 已不持租约（`canExecute` 假）——命令**从未执行**，提交前。
 * - `window_busy`：抢占撞上不可逆提交窗口（仅经租约释放渠道；一般不作为命令 error 出现）。
 * - `yield_timeout`：写者收到取消仍不停手＝控制面故障（仅经租约释放渠道；通向人工重启，不自愈）。
 */
export const PREEMPTION_REASONS = [
  'preempted_by_task',
  'task_lease_mismatch',
  'window_busy',
  'yield_timeout',
] as const;

export type PreemptionReason = (typeof PREEMPTION_REASONS)[number];

/** 该原因串是否属于「被抢占（不烧稿）」类。null/undefined/空串一律 false。 */
export function isPreemptionReason(reason: string | null | undefined): reason is PreemptionReason {
  return typeof reason === 'string' && (PREEMPTION_REASONS as readonly string[]).includes(reason);
}

/**
 * 7.5 活跃租约中断的**结构化**载体：edge-task-lease-client 收到活跃租约的抢占释放时，用它 reject
 * 命令编排的在飞 publish.command，使 catch 能**按类型**判抢占（而非脆弱的 message 子串匹配）、
 * 归入独立 `preempted` outcome 而非任何提交前失败档。
 * `submitDispatched` 透传「提交是否已派发」：若中断时提交已派发，MUST 走「已提交待确认」、绝不重投。
 */
export class CommandPreemptedError extends Error {
  constructor(
    public readonly reason: PreemptionReason,
    public readonly submitDispatched: boolean = false,
    message?: string,
  ) {
    super(message ?? `publish command preempted: ${reason}`);
    this.name = 'CommandPreemptedError';
  }
}
