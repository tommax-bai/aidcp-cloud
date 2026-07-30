/**
 * 契约层：Task / TaskRevision / CapabilityScope / 三类预算（design §2/§3/§4.3/§10）。
 *
 * 所有权（design §3）：Task、TaskRevision 由 **API** 授权与持久化；Automation 只拥有
 * runtime projection —— 保存运行所需的 ID、冻结版本、授权 revision 和结构化约束，
 * 不复制客户可编辑全文成为第二事实源。本文件的 Task/TaskRevision 即该运行副本的契约形态。
 */

import type { PlatformId } from '../../kernel/platform-types.js';
import type { EpochMillis, ExecutionTarget, ScheduleWindow, StructuredConstraints } from './common.js';
import type { ActionDomainAuthorization } from './action-classification.js';
import type { CapabilityId } from './capability.js';

/**
 * Task 能力范围（design §4.3）：护栏，不是流程。「允许点赞」≠「每篇点赞」，
 * 选择策略由 Task 参数与 ExecutionPlan 条件表达。
 */
export interface CapabilityScope {
  allow: CapabilityId[];
  deny: CapabilityId[];
}

/** 平台/风控预算（design §10 第 1 类）：每日动作数、会话动作数、冷却、重复目标限制。 */
export interface PlatformRiskBudget {
  maxDailyActions: number | null;
  maxSessionActions: number | null;
  cooldownMs: number | null;
  maxRepeatPerTarget: number | null;
}

/** 执行预算（design §10 第 2 类）：浏览器分钟数、唤醒次数、步骤数、等待上限、尝试次数。 */
export interface ExecutionResourceBudget {
  maxBrowserMinutes: number | null;
  maxWakeups: number | null;
  maxSteps: number | null;
  maxWaitMs: number | null;
  maxExecutionAttempts: number | null;
}

/** AI/内容预算（design §10 第 3 类）：token、图片/视频生成次数、创作尝试和成本上限。 */
export interface AiContentBudget {
  maxModelTokens: number | null;
  maxImageGenerations: number | null;
  maxVideoGenerations: number | null;
  maxCreationAttempts: number | null;
  maxCostUnits: number | null;
}

/**
 * 三类独立预算（design §10）：**不能互相替代**——「仍有 AI token」不能允许超过评论配额，
 * 「还有平台动作数」不能允许无限占用浏览器。记账极性按账本类别声明（§24.2 C12 裁决）：
 * 平台风险账本 halting，AI 成本账本 best-effort 且非幂等累加不得重试。
 */
export interface TaskBudgets {
  platformRisk: PlatformRiskBudget | null;
  executionResource: ExecutionResourceBudget | null;
  aiContent: AiContentBudget | null;
}

/**
 * Task 生命周期（Automation 运行副本视角，design 未显式枚举，裁量最小集）：
 * - `active`：已被 API 激活（TaskActivated），可派生 TaskRun；
 * - `cancelled`：API 取消（TaskCancelled）；已派发 Attempt 独立归并；
 * - `completed`：完成条件达成，不再派生新 TaskRun（终局由 TaskRun 终态聚合判定）。
 */
export type TaskLifecycleStatus = 'active' | 'cancelled' | 'completed';

export const TASK_LIFECYCLE_STATUSES = [
  'active',
  'cancelled',
  'completed',
] as const satisfies readonly TaskLifecycleStatus[];

/**
 * Task：一次具体、可完成、可取消的工作目标（design §2）。
 * 一次性用户命令可直接创建 Task，不要求存在 ManagedPlan 或 ManagedCycle。
 */
export interface Task {
  taskId: string;
  executionTarget: ExecutionTarget;
  planId: string | null;
  cycleId: string | null;
  accountId: string;
  envKey: string;
  platform: PlatformId;
  taskDefinitionId: string;
  taskDefinitionVersion: number;
  /** 当前生效的授权修订（每次 Revise 产生新 TaskRevision 并推进本指针）。 */
  currentRevisionId: string;
  capabilityScope: CapabilityScope;
  /** 动作域可见授权快照（API 权威，Automation 只读引用，design §9）。 */
  actionAuthorization: ActionDomainAuthorization;
  constraints: StructuredConstraints;
  budgets: TaskBudgets;
  schedule: ScheduleWindow;
  /** 完成条件引用（由 Plan Compiler 校验完整性，design §4.5）。 */
  completionConditionRef: string;
  status: TaskLifecycleStatus;
  /** 同一句话拆多个 Task 时共享（design §4.4）。 */
  conversationMessageId: string | null;
  correlationId: string;
  aggregateVersion: number;
  createdAt: EpochMillis;
  updatedAt: EpochMillis;
}

/** TaskRevision 的成因（对应 API 事件 TaskActivated / TaskRevised / TaskCancelled）。 */
export type TaskRevisionCause = 'create' | 'revise' | 'cancel';

export const TASK_REVISION_CAUSES = [
  'create',
  'revise',
  'cancel',
] as const satisfies readonly TaskRevisionCause[];

/**
 * TaskRevision：API 接受提案后记录的**不可变**授权修订（design §4.4）。
 * TaskPatch 不是一级领域对象；内部传输载荷不进入领域语言。
 * 扩大能力范围必须重新经过 API 授权；缩小范围可在安全点切换（design §4.5）。
 */
export interface TaskRevision {
  revisionId: string;
  taskId: string;
  executionTarget: ExecutionTarget;
  /** 单调递增修订序号；revisionOrdinal=1 即创建修订。 */
  revisionOrdinal: number;
  cause: TaskRevisionCause;
  /** 本修订生效的范围/约束/预算/排期快照（不可变）。 */
  capabilityScope: CapabilityScope;
  actionAuthorization: ActionDomainAuthorization;
  constraints: StructuredConstraints;
  budgets: TaskBudgets;
  schedule: ScheduleWindow;
  /** API 授权凭据引用（ApprovalRecorded / 授权事件）。 */
  authorizationRef: string;
  /** 被本修订取代的上一修订；创建修订为 null。 */
  supersedesRevisionId: string | null;
  /** 溯源：促成本修订的 Agent 提案（若来自对话）。 */
  proposalRef: string | null;
  createdAt: EpochMillis;
}
