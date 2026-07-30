/**
 * 契约层：ManagedPlan / ManagedCycle / Trigger Binding（design §2/§3/§5，plans spec）。
 *
 * 所有权（design §3）：ManagedPlan 由 **API** 授权、持久化和激活（Agent 只能提案）；
 * ManagedCycle 由 Automation 拥有。Trigger Registry 只决定「是否创建 Task」，
 * 不执行任务图（design §5）。
 */

import type { EpochMillis, ExecutionTarget, StructuredConstraints } from './common.js';
import type { ActionDomainAuthorization } from './action-classification.js';
import type { TaskBudgets } from './task.js';
import type { OrthogonalRunState } from './task-run.js';

/** 触发来源四类（design §5）。 */
export type TriggerType = 'domain_event' | 'schedule' | 'manual' | 'agent_intent';

export const TRIGGER_TYPES = [
  'domain_event',
  'schedule',
  'manual',
  'agent_intent',
] as const satisfies readonly TriggerType[];

/**
 * 并发策略（design §5）。`latest_wins` 只可替换尚未进入外部 dispatched 的旧 TaskRun；
 * 已派发写动作时新版本必须另建 TaskRevision/ExecutionPlan/TaskRun 并等待旧结果归并。
 */
export type TriggerConcurrencyPolicy = 'ignore_if_running' | 'queue' | 'latest_wins';

export const TRIGGER_CONCURRENCY_POLICIES = [
  'ignore_if_running',
  'queue',
  'latest_wins',
] as const satisfies readonly TriggerConcurrencyPolicy[];

/**
 * Trigger Binding（design §5 逐项冻结）。Registry 不支持「订阅所有事件后让 Agent
 * 自己决定」，防止 浏览→计划更新→再浏览 的无限循环。
 */
export interface TriggerBinding {
  bindingId: string;
  planId: string | null;
  executionTarget: ExecutionTarget;
  triggerType: TriggerType;
  /** 允许的事件类型与 schema version（domain_event/schedule 等按类型填充）。 */
  eventType: string;
  eventSchemaVersion: number;
  taskDefinitionId: string;
  taskDefinitionVersion: number;
  /** 作用域键模板（如 'planId + accountId'）。 */
  scopeKeyRule: string;
  /** idempotencyKey 推导规则引用（如 'accountId + personaVersion + taskDefinitionVersion'）。 */
  idempotencyKeyRule: string;
  concurrencyPolicy: TriggerConcurrencyPolicy;
  maxDerivationDepth: number;
  /** 是否允许创建 ManagedCycle（false = 仅创建 Task）。 */
  allowCreateCycle: boolean;
  /** 意图漂移处置（design §6：人设/内容更新按 supersession policy 建新 run）。 */
  supersessionPolicy: TriggerConcurrencyPolicy;
  createdAt: EpochMillis;
  updatedAt: EpochMillis;
}

/**
 * ManagedPlan 生命周期（对应 API 事件 ManagedPlanActivated / ManagedPlanUpdated /
 * ManagedPlanPaused；design 未显式枚举，裁量补 cancelled 以承接取消提案）。
 */
export type ManagedPlanStatus = 'active' | 'paused' | 'cancelled';

export const MANAGED_PLAN_STATUSES = [
  'active',
  'paused',
  'cancelled',
] as const satisfies readonly ManagedPlanStatus[];

/** 运营窗口（plans spec：operating windows；每日周期/发布窗口的最小表达）。 */
export interface OperatingWindow {
  /** IANA 时区（窗口按客户运营时区解释）。 */
  timezone: string;
  /** 'HH:mm' 起止（跨日窗口 end < start）。 */
  start: string;
  end: string;
  /** ISO 星期几（1=周一 … 7=周日）；空数组 = 每天。 */
  daysOfWeek: number[];
}

/**
 * ManagedPlan：客户可见的长期运营目标和授权边界（design §2）。
 * Automation 侧为 runtime projection：只保存运行所需 ID、版本、授权与结构化约束。
 */
export interface ManagedPlan {
  planId: string;
  /** 每次 API 修订递增；TaskRun 冻结 planId + planVersion（design §6）。 */
  planVersion: number;
  executionTarget: ExecutionTarget;
  accountId: string;
  envKey: string;
  /** 长期运营目标引用（客户可编辑全文留在 API，此处只存引用）。 */
  goalRef: string;
  /** 授权边界：按动作域的可见授权（design §9）。 */
  actionAuthorization: ActionDomainAuthorization;
  /** Plan 级预算（Cycle 从中给子 Task 分配，design §10）。 */
  budgets: TaskBudgets;
  operatingWindows: OperatingWindow[];
  triggerBindings: TriggerBinding[];
  constraints: StructuredConstraints;
  status: ManagedPlanStatus;
  aggregateVersion: number;
  createdAt: EpochMillis;
  updatedAt: EpochMillis;
}

/**
 * ManagedCycle：Automation 拥有的有界执行周期（自然日、活动、人设刷新后的研究周期，
 * design §2）。只保存子 TaskRun 引用、预算和结果摘要（design §17）；
 * 研究成功而创作失败 → partially_succeeded；发布 submitted_unknown 时
 * 不能显示「已发布」。状态复用正交三元组（裁量：design 未单列 Cycle 状态枚举，
 * §17 的部分完成/未知语义与 TaskRun 同构）。
 */
export interface ManagedCycle extends OrthogonalRunState {
  cycleId: string;
  planId: string;
  planVersion: number;
  executionTarget: ExecutionTarget;
  /** 周期边界（有界执行周期的起止）。 */
  windowStartAt: EpochMillis;
  windowEndAt: EpochMillis;
  /** 分配给本周期的预算（子 Task 从中扣减，design §10）。 */
  budgets: TaskBudgets;
  /** 子 Task 引用（只存 ID，不复制内容）。 */
  taskIds: string[];
  /** 结果摘要引用（哪部分完成、哪部分未完成，design §15/§17）。 */
  resultSummaryRef: string | null;
  correlationId: string;
  aggregateVersion: number;
  createdAt: EpochMillis;
  updatedAt: EpochMillis;
}
