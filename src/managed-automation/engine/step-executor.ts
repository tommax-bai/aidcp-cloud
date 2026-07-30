/**
 * 引擎层（期1-5）：StepRun 执行器接口。
 *
 * 期1 只定义接口 + 测试用假执行器（在 test/ 下）；真实浏览器动作执行属于任务 8
 * 的只读纵切，届时以 Capability 适配器实现本接口，不改 worker。
 *
 * 接口三要素（任务要求）：
 *   - 执行：worker 按 ExecutionPlan 链序逐节点调用 execute；
 *   - 结果/失败：判别联合诚实回报——succeeded / skipped / failed，skipped 与 failed
 *     都必须带具名 reason_code（绝不静默失败、绝不把拒绝伪装成成功）；
 *   - 可中断：ctx.signal 在租约丢失或 worker 停机时 abort，执行器应在安全点尽快返回；
 *     abort 后 worker 不再代表该 run 写任何状态（所有权已经或即将易主）。
 */

import type { ExecutionTarget } from '../contracts/common.js';
import type { ReasonCode, TerminalReasonCode } from '../contracts/reason-codes.js';
import type { ExecutionPlan, ExecutionPlanNode } from '../contracts/execution-plan.js';
import type { TaskRun } from '../contracts/task-run.js';

export interface StepExecutionContext {
  executionTarget: ExecutionTarget;
  run: TaskRun;
  plan: ExecutionPlan;
  node: ExecutionPlanNode;
  stepRunId: string;
  /** 上次中断留下的检查点引用（首跑为 null）；执行器从已确认进度继续，不从 0 开始。 */
  checkpointRef: string | null;
  /** 中断信号：worker 租约丢失 / stop() 时 abort。 */
  signal: AbortSignal;
}

/**
 * 步骤结果判别联合。
 * - `succeeded`：可附检查点/结果引用与本步新确认的唯一工作单元数（design §16 口径）；
 * - `skipped`：诚实跳过（如 no_qualified_target），run 继续走后续节点；
 * - `failed`：run 就地终态 failed（期1 无步内重试；重试预算属后续任务）。
 */
export type StepExecutionResult =
  | {
      kind: 'succeeded';
      resultRef: string | null;
      checkpointRef: string | null;
      /** 本步新增的已确认唯一工作单元数（累加进 RunProgress.confirmedCount）。 */
      confirmedDelta: number;
    }
  | { kind: 'skipped'; reasonCode: TerminalReasonCode; detail?: string }
  | { kind: 'failed'; reasonCode: ReasonCode; detail?: string };

export interface StepExecutor {
  execute(ctx: StepExecutionContext): Promise<StepExecutionResult>;
}
