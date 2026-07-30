/**
 * 托管自动化运行时（change add-managed-automation-runtime）契约层：公共基础类型。
 *
 * 本目录（src/managed-automation/contracts/）是设计定稿 design.md Migration Phase 0
 * 「冻结 CapabilityDefinition、TaskDefinition、Task/TaskRevision、ExecutionPlan、
 * TaskRun/StepRun/Attempt、事件信封和 reason code」的落点：**纯类型契约，零运行时副作用**。
 * 仅允许 type-only 依赖 kernel 纯类型；不 import 任何业务模块，不持模块级 Set/Map 活状态。
 * store / 路由 / worker 等实现由后续任务（期1-2 起）在 src/managed-automation/ 下扩展。
 */

import type { DeploymentTarget } from '../../deployment-target.js';

/**
 * 执行环境隔离标识（design §21：所有可认领/扫描记录带服务端注入的 execution_target）。
 * 与既有 DeploymentTarget（'dev' | 'ol'）同一枚举：由服务端注入，
 * 客户端、Agent、自然语言和 envKey 都不能指定 target。
 * 所有携带持久化语义的契约类型必须包含本字段。
 */
export type ExecutionTarget = DeploymentTarget;

/** 毫秒级 Unix 时间戳（沿用仓内 createdAt/updatedAt: number 习惯）。 */
export type EpochMillis = number;

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

/**
 * 结构化约束袋（Task 约束、TaskRevision 约束等）。契约层不枚举具体键，
 * 由 TaskDefinition 的 inputSchemaRef 约束其 schema。
 */
export type StructuredConstraints = Record<string, JsonValue>;

/**
 * 持久命令/事件信封（design §5：所有持久消息携带 messageId、correlationId、
 * causationId、aggregateVersion 和 executionTarget）。跨服务命令/事件走 Outbox/Inbox
 * 时以本信封为最小必带字段集。
 */
export interface MessageEnvelope {
  messageId: string;
  correlationId: string;
  /** 因果链上游消息 ID；链头（如用户手动触发）为 null。 */
  causationId: string | null;
  aggregateVersion: number;
  executionTarget: ExecutionTarget;
}

/**
 * 错过策略（design §8）：
 * - `skip`：窗口过期则终态 skipped，不得补做；
 * - `require_reapproval`：保留意图但撤销当前执行授权，回 API 重新确认
 *   （§24.2 C9 裁决：latestStartAt 只约束派发窗口，不终结人审等待，内容保持可重批）；
 * - `execute_when_available`：资源恢复后继续，仅适合用户明确接受延迟的工作。
 */
export type MissPolicy = 'skip' | 'require_reapproval' | 'execute_when_available';

export const MISS_POLICIES = [
  'skip',
  'require_reapproval',
  'execute_when_available',
] as const satisfies readonly MissPolicy[];

/**
 * 时间语义三元组（design §8：每个有时间语义的 work 必须同时表达目标时间、
 * 最迟开始和错过策略）。
 */
export interface ScheduleWindow {
  scheduledAt: EpochMillis;
  latestStartAt: EpochMillis;
  missPolicy: MissPolicy;
}
