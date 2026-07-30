/**
 * 契约层：TaskRun / StepRun 正交状态模型与运行对象（design §2）。
 *
 * 核心决策：**不使用互斥大枚举**（旧 delegated-task 的 11 态把「在等什么」和
 * 「怎么结束的」压进同一个 status），改用三字段正交：
 *
 *   status          在跑吗 —— queued | running | waiting | cancel_requested | terminal
 *   waitReason      在等什么 —— 仅 status='waiting' 时非空
 *   terminalOutcome 怎么结束的 —— 仅 status='terminal' 时非空
 *
 * 这样「正在等待 Edge」与「最终因 Edge 超过窗口而跳过」不会混成一个模糊状态。
 * 逐态映射见同目录 STATE-MAPPING.md。
 * 不变式（由期1-2 store 层与后续状态机实现强制，契约层只声明）：
 *   - waitReason !== null ⇔ status === 'waiting'
 *   - terminalOutcome !== null ⇔ status === 'terminal'
 *   - cancel_requested 是前向语义（design §12）：已派发的 Attempt 仍等待回执/对账，
 *     不覆盖真实平台结果。
 */

import type { PlatformId } from '../../kernel/platform-types.js';
import type { EpochMillis, ExecutionTarget, ScheduleWindow } from './common.js';
import type { ReasonCode, TerminalReasonCode, WaitReason } from './reason-codes.js';
import type { CapabilityId } from './capability.js';
import type { TaskBudgets } from './task.js';

export type { WaitReason };

/** 顶层运行状态（第一正交字段）。 */
export type RunStatus = 'queued' | 'running' | 'waiting' | 'cancel_requested' | 'terminal';

export const RUN_STATUSES = [
  'queued',
  'running',
  'waiting',
  'cancel_requested',
  'terminal',
] as const satisfies readonly RunStatus[];

/**
 * 终态结果（第三正交字段）。
 * - `partially_succeeded`：给出实际完成量（如 10+13），不得报告目标量（design §16）；
 * - `submitted_unknown`：平台结果未知即诚实未知，禁止猜测成功/失败（design §12）。
 */
export type RunTerminalOutcome =
  | 'succeeded'
  | 'partially_succeeded'
  | 'skipped'
  | 'failed'
  | 'cancelled'
  | 'submitted_unknown';

export const RUN_TERMINAL_OUTCOMES = [
  'succeeded',
  'partially_succeeded',
  'skipped',
  'failed',
  'cancelled',
  'submitted_unknown',
] as const satisfies readonly RunTerminalOutcome[];

/**
 * 正交状态三元组（TaskRun / StepRun / ManagedCycle 共用形态）。
 * `reasonCode` 解释当前 waiting/terminal 的成因，供投影与 Decision Trace 引用。
 */
export interface OrthogonalRunState {
  status: RunStatus;
  waitReason: WaitReason | null;
  terminalOutcome: RunTerminalOutcome | null;
  /** waiting 时为 WaitReason 同值或更细码；terminal 时为 TerminalReasonCode 等。 */
  reasonCode: ReasonCode | null;
}

/** 运行进度（唯一确认计数口径，design §16：只统计拿到稳定内容 ID 且完成阅读证据的唯一内容）。 */
export interface RunProgress {
  /** 已确认完成的唯一工作单元数（如唯一已读内容数、已确认动作数）。 */
  confirmedCount: number;
  /** 目标量；终态为 partially_succeeded 时二者之差即诚实缺口。 */
  targetCount: number | null;
  attemptCount: number;
  skippedCount: number;
  failureCount: number;
}

/**
 * TaskRun：执行某个 TaskRevision 与 ExecutionPlan 的一次实际运行（design §2）。
 * 创建时冻结意图（design §6「意图冻结、安全实时」）：业务意图不能在运行中悄悄漂移，
 * 安全控制必须能立刻停止旧意图。
 */
export interface TaskRun extends OrthogonalRunState {
  runId: string;
  taskId: string;
  taskRevisionId: string;
  executionPlanId: string;
  cycleId: string | null;
  executionTarget: ExecutionTarget;
  correlationId: string;
  /** —— 以下为创建时冻结块（design §6）—— */
  planId: string | null;
  planVersion: number | null;
  taskDefinitionId: string;
  taskDefinitionVersion: number;
  /** 单调版本或规范化内容哈希（design Open Question 2，不得用 updated_at 冒充）。 */
  personaVersion: string | null;
  accountId: string;
  envKey: string;
  platform: PlatformId;
  /** 账号绑定 revision（lane 身份判定输入，design §7）。 */
  accountBindingRevision: string;
  candidateVersionId: string | null;
  contentVersion: string | null;
  approvalRevision: string | null;
  schedule: ScheduleWindow;
  budgets: TaskBudgets;
  idempotencyKey: string;
  /** —— 运行期字段 —— */
  progress: RunProgress;
  /** 当前推进到的 ExecutionPlan 节点；未开始/已终态为 null。 */
  currentNodeId: string | null;
  /** 被新 TaskRevision 取代时指向接棒 run（design §4.5：supersede 不原地改写）。 */
  supersededByRunId: string | null;
  /** 乐观并发版本（单写者纪律配套）。 */
  aggregateVersion: number;
  createdAt: EpochMillis;
  updatedAt: EpochMillis;
  startedAt: EpochMillis | null;
  finishedAt: EpochMillis | null;
}

/**
 * StepRun：ExecutionPlan 中一个 Capability 节点的可恢复运行实例（design §2）。
 * 断线恢复从已确认进度继续，不从 0 开始，也不重复计数（design §16 步骤 9）。
 */
export interface StepRun extends OrthogonalRunState {
  stepRunId: string;
  runId: string;
  /** 对应 ExecutionPlan 节点。 */
  nodeId: string;
  capabilityId: CapabilityId;
  capabilityVersion: number;
  executionTarget: ExecutionTarget;
  /** 节点入参快照引用（不可变，受 inputSchemaRef 约束）。 */
  inputRef: string | null;
  /** 类型化结果引用（受 outputSchemaRef 约束）。 */
  resultRef: string | null;
  /** 恢复检查点引用（按唯一内容确认、步骤边界批量 checkpoint，design Risks）。 */
  checkpointRef: string | null;
  attemptCount: number;
  createdAt: EpochMillis;
  updatedAt: EpochMillis;
  startedAt: EpochMillis | null;
  finishedAt: EpochMillis | null;
}

/** 终态原因码窄化别名（终态投影处使用；非终态处用 ReasonCode）。 */
export type RunTerminalReasonCode = TerminalReasonCode;
