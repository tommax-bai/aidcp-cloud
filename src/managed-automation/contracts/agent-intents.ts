/**
 * 契约层：Agent 意图与四入口操作契约（design §3/§4.4，task-runtime spec）。
 *
 * Agent 先解释命令类型，不直接调用 Capability。提案（Proposal）**仅为建议**：
 * 由 Agent Service 产生、提交给 API 鉴权与持久化，不能直接执行；
 * QueryTaskRequest 经 API 读取投影，不创建可执行工作。
 *
 * 期程说明：CreateTask / CancelTask / QueryTask 的入口操作在期1-4 实现；
 * **ReviseTaskProposal 本期仅冻结契约，期3 实现**（安全点切换、supersede 语义）。
 */

import type { PlatformId } from '../../kernel/platform-types.js';
import type { EpochMillis, ExecutionTarget, ScheduleWindow, StructuredConstraints } from './common.js';
import type { ActionDomainAuthorization } from './action-classification.js';
import type { CapabilityScope, TaskBudgets, TaskLifecycleStatus } from './task.js';
import type { OperatingWindow, TriggerBinding } from './plan.js';
import type { RunProgress, RunStatus, RunTerminalOutcome, WaitReason } from './task-run.js';
import type { ExecutionAttemptStatus } from './execution-attempt.js';
import type { DecisionOutcome } from './decision-trace.js';
import type { ReasonCode } from './reason-codes.js';

/** 所有 Agent 意图共享的溯源块（同一句话拆多 Task 时共享，design §4.4）。 */
export interface AgentIntentProvenance {
  /** 对话消息 ID（自然语言来源锚点）。 */
  conversationMessageId: string | null;
  correlationId: string;
  /** 提案产生时间（API 侧收妥后另记权威时间）。 */
  proposedAt: EpochMillis;
}

/**
 * CreateTaskProposal：「现在、这次、帮我……」（design §4.4 映射表）。
 * executionTarget 由服务端注入，提案本身不携带（防止 Agent/客户端指定 target）。
 */
export interface CreateTaskProposal extends AgentIntentProvenance {
  kind: 'create_task';
  accountId: string;
  platform: PlatformId;
  taskDefinitionId: string;
  taskDefinitionVersion: number;
  /** 请求的能力范围（API 授权后可能收窄，不会放大）。 */
  requestedCapabilityScope: CapabilityScope;
  /** 请求涉及的动作域授权（API 按客户配置裁决）。 */
  requestedAuthorization: ActionDomainAuthorization;
  constraints: StructuredConstraints;
  budgets: TaskBudgets;
  schedule: ScheduleWindow;
  /** 归属 Plan/Cycle（一次性命令为 null，design §2）。 */
  planId: string | null;
  cycleId: string | null;
}

/**
 * ReviseTaskProposal：「接下来改成……」。**本期仅契约，期3 实现。**
 * API 接受后记录不可变 TaskRevision（TaskPatch 不是一级对象，design §4.4）；
 * 缩小范围可在安全点切换，扩大范围必须重新授权（design §4.5）。
 */
export interface ReviseTaskProposal extends AgentIntentProvenance {
  kind: 'revise_task';
  taskId: string;
  /** 基于的修订（乐观并发：修订漂移时 API 拒绝并要求重读）。 */
  baseRevisionId: string;
  /** 全量目标形态（非 patch 语义）：接受后成为新 TaskRevision 的快照。 */
  requestedCapabilityScope: CapabilityScope;
  requestedAuthorization: ActionDomainAuthorization;
  constraints: StructuredConstraints;
  budgets: TaskBudgets;
  schedule: ScheduleWindow;
}

/** CancelTaskProposal：「停掉、不要继续……」。取消是前向语义（design §12）。 */
export interface CancelTaskProposal extends AgentIntentProvenance {
  kind: 'cancel_task';
  taskId: string;
  /** 取消理由（客户可见摘要；结构化原因由 API 落 TaskRevision cause='cancel'）。 */
  reason: string | null;
}

/** 查询范围选择（按需取层，避免默认全量拉取）。 */
export interface QueryTaskInclude {
  runs: boolean;
  attempts: boolean;
  traces: boolean;
}

/** QueryTaskRequest：「为什么、进度如何……」。只读，不创建可执行工作（design §3）。 */
export interface QueryTaskRequest extends AgentIntentProvenance {
  kind: 'query_task';
  /** 按 Task 查询；为 null 时按 correlation/account 过滤列表。 */
  taskId: string | null;
  accountId: string | null;
  include: QueryTaskInclude;
}

/** ——— ManagedPlan 提案族（design §4.4 AgentAutomationIntent 联合成员）——— */

export interface CreateManagedPlanProposal extends AgentIntentProvenance {
  kind: 'create_managed_plan';
  accountId: string;
  platform: PlatformId;
  goalDescription: string;
  requestedAuthorization: ActionDomainAuthorization;
  budgets: TaskBudgets;
  operatingWindows: OperatingWindow[];
  /** 请求的触发绑定（bindingId/时间戳等由 API/Automation 定稿，此处为形态子集）。 */
  requestedBindings: Array<
    Pick<TriggerBinding, 'triggerType' | 'eventType' | 'taskDefinitionId' | 'taskDefinitionVersion' | 'concurrencyPolicy'>
  >;
  constraints: StructuredConstraints;
}

export interface ReviseManagedPlanProposal extends AgentIntentProvenance {
  kind: 'revise_managed_plan';
  planId: string;
  basePlanVersion: number;
  requestedAuthorization: ActionDomainAuthorization;
  budgets: TaskBudgets;
  operatingWindows: OperatingWindow[];
  constraints: StructuredConstraints;
}

export interface CancelManagedPlanProposal extends AgentIntentProvenance {
  kind: 'cancel_managed_plan';
  planId: string;
  reason: string | null;
}

/** design §4.4 逐字冻结的意图联合（kind 判别）。 */
export type AgentAutomationIntent =
  | CreateTaskProposal
  | ReviseTaskProposal
  | CancelTaskProposal
  | QueryTaskRequest
  | CreateManagedPlanProposal
  | ReviseManagedPlanProposal
  | CancelManagedPlanProposal;

/** ——— 查询投影（QueryTaskRequest 的应答契约）——— */

/** TaskRun 投影行：正交三字段原样透出，不折叠回大枚举（design §20）。 */
export interface TaskRunProjection {
  runId: string;
  taskRevisionId: string;
  status: RunStatus;
  waitReason: WaitReason | null;
  terminalOutcome: RunTerminalOutcome | null;
  reasonCode: ReasonCode | null;
  progress: RunProgress;
  currentNodeId: string | null;
  startedAt: EpochMillis | null;
  finishedAt: EpochMillis | null;
}

/** Attempt 投影行：平台确认结果的权威来源是 Ledger（design §20 三种真相之三）。 */
export interface AttemptProjection {
  attemptId: string;
  runId: string;
  stepId: string;
  status: ExecutionAttemptStatus;
  reasonCode: ReasonCode | null;
  evidenceRef: string | null;
  settledAt: EpochMillis | null;
}

/** Decision Trace 客户可见摘要行（内部调试证据分层授权，design §22）。 */
export interface TraceSummaryProjection {
  traceId: string;
  decisionType: string;
  outcome: DecisionOutcome;
  reasonCode: ReasonCode;
  createdAt: EpochMillis;
}

/**
 * QueryTaskProjection：查询应答。首次成功前客户端显示未知/加载失败，
 * 不编造 0 或成功（design §20）。
 */
export interface QueryTaskProjection {
  taskId: string;
  executionTarget: ExecutionTarget;
  status: TaskLifecycleStatus;
  currentRevisionId: string;
  /** include.runs=false 时为 null（区别于「无 run」的空数组）。 */
  runs: TaskRunProjection[] | null;
  attempts: AttemptProjection[] | null;
  traces: TraceSummaryProjection[] | null;
  projectedAt: EpochMillis;
}
