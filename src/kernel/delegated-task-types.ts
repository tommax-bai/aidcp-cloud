/**
 * 委托任务的**纯类型契约**（kernel 段）。
 *
 * 只含任务 / 意图 / 尝试 / 状态的类型与接口，外加两个纯物：状态全集字面数组 DELEGATED_TASK_STATUSES
 * （`as const` 冻结字面、非 Set/Map、非活状态）与纯归一函数 clampClientApprovalMode
 * （change decouple-longtail-sweep 抬入，供 api 侧客户端授权/面板跨边界共导）。
 * 状态机（TERMINAL_STATUSES / TRANSITIONS 模块级 Set）、转移/校验函数（isTerminalTaskStatus /
 * canTransitionTask / validateDelegatedTaskIntent 等）仍留在 src/delegated-task/types.ts（automation）
 * ——门禁 §4.7 禁止 kernel 持模块级活状态（Set/Map）。本文件供 api / content 侧 type-only 与纯值共导。
 */

import type { PlatformId, DelegatedAction } from './platform-types.js';
import type { DeploymentTarget } from '../deployment-target.js';

export type { DelegatedAction };
export type DelegatedPlatformId = Exclude<PlatformId, 'wechat_channels'>;

/**
 * 委托任务状态全集。运行时数组 DELEGATED_TASK_STATUSES 留在 delegated-task/types.ts，
 * 并 `satisfies readonly DelegatedTaskStatus[]` 与本联合逐字对齐（增删状态两处同改，编译期兜底）。
 */
export type DelegatedTaskStatus =
  | 'draft'
  | 'awaiting_confirmation'
  | 'queued'
  | 'planning'
  | 'waiting_approval'
  | 'executing'
  | 'partially_completed'
  | 'completed'
  | 'deferred'
  | 'cancelled'
  | 'failed';

export type DelegatedExecutionTarget = DeploymentTarget;
export type DelegatedTaskPriority = 'normal' | 'high';
export type DelegatedTaskSource = 'feishu' | 'edge' | 'console' | 'api' | 'legacy_command' | 'operator_action';
export type DelegatedApprovalMode = 'review' | 'auto_approve' | 'draft_only';
export type DelegatedScheduleMode = 'immediate' | 'at_time' | 'next_safe_slot';
export type DelegatedActionFamily = 'comment' | 'publish' | 'candidate_control';

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type TaskConstraints = Record<string, JsonValue>;

export interface DelegatedTaskProgress {
  successCount: number;
  attemptCount: number;
  skippedCount: number;
  failureCount: number;
}

export interface DelegatedTerminalOutcome {
  code: string;
  message: string;
  evidenceRef?: string;
  submittedUnknown?: boolean;
  remainingCount?: number;
}

export interface DelegatedTask {
  id: string;
  /**
   * Trusted Cloud deployment that created and may execute this task.
   * This is injected by the server-side store, never by client/task intent input.
   */
  executionTarget: DelegatedExecutionTarget;
  accountId: string;
  accountName: string;
  platform: DelegatedPlatformId;
  action: DelegatedAction;
  actionFamily: DelegatedActionFamily;
  targetSuccessCount: number;
  maxAttempts: number;
  deadlineAt: number;
  notBefore: number;
  executionWindow: { mode: DelegatedScheduleMode; startAt?: number; endAt?: number };
  sourceConstraints: TaskConstraints;
  targetConstraints: TaskConstraints;
  approvalMode: DelegatedApprovalMode;
  priority: DelegatedTaskPriority;
  source: DelegatedTaskSource;
  sourceRef: string | null;
  /**
   * 命令来源会话（飞书 `chatId`）。change restore-delegated-command-card-origin-chat：
   * 与偏向 messageId、参与去重键的 `sourceRef` 解耦，专职操作员向卡片（审批卡 / 终态结果卡）的投递目标。
   * 命令触发（私聊 / 群）→ 该会话；非飞书入口（console/api/edge）→ null → 回落既有默认 / 团队路由。
   */
  originChatId: string | null;
  status: DelegatedTaskStatus;
  progress: DelegatedTaskProgress;
  currentStep: string | null;
  terminalOutcome: DelegatedTerminalOutcome | null;
  pauseRequested: boolean;
  cancelRequested: boolean;
  nextEligibleAt: number | null;
  claimToken: string | null;
  claimExpiresAt: number | null;
  dedupeKey: string;
  version: number;
  createdAt: number;
  updatedAt: number;
  confirmedAt: number | null;
  completedAt: number | null;
}

export interface DelegatedTaskIntent {
  accountId?: string;
  accountName?: string;
  platform?: PlatformId;
  action: DelegatedAction;
  targetSuccessCount: number;
  maxAttempts: number;
  deadlineAt: number;
  notBefore?: number;
  executionWindow?: { mode: DelegatedScheduleMode; startAt?: number; endAt?: number };
  sourceConstraints?: TaskConstraints;
  targetConstraints?: TaskConstraints;
  approvalMode?: DelegatedApprovalMode;
  priority?: DelegatedTaskPriority;
  source: DelegatedTaskSource;
  sourceRef?: string;
  /** 命令来源会话（飞书 chatId）；仅命令入口带值，其余入口缺省 → 回落既有路由。 */
  originChatId?: string;
}

export type DelegatedVerificationKind =
  | 'platform_comment_confirmed'
  | 'platform_publish_confirmed'
  | 'platform_schedule_confirmed'
  | 'candidate_persisted'
  | 'candidate_version_updated'
  | 'submitted_unknown'
  /**
   * 执行器**跑过**、但没派发平台写入（如评论链搜了词、开了笔记，最终判定无强候选而不评）。
   * 浏览器动过——只是没落下写入。
   */
  | 'not_dispatched'
  /**
   * 执行器**根本没跑**：动作真正发生前就被让开（风控 / 并发占用等 → deferred）。
   *
   * change delegated-terminal-failure-reason：它与 `not_dispatched` 的分野是**有没有碰过平台**，
   * 而这正是终态回执能否说「均未真正开始」的唯一凭据。二者从前都记 `not_dispatched`，于是「让开」
   * 与「跑了但没写」不可分——据此说「未真正开始」就是在断言拿不出证据的事（红线：绝不编造）。
   * 与 `not_dispatched` 一样不计成功。
   */
  | 'not_started';

export type DelegatedAttemptStatus =
  | 'prepared'
  | 'dispatched'
  | 'succeeded'
  | 'skipped'
  | 'failed'
  | 'submitted_unknown';

export interface DelegatedTaskAttempt {
  id: string;
  taskId: string;
  ordinal: number;
  targetKey: string;
  status: DelegatedAttemptStatus;
  verificationKind: DelegatedVerificationKind | null;
  evidenceRef: string | null;
  reason: string | null;
  preparedAt: number;
  dispatchedAt: number | null;
  finishedAt: number | null;
}

/**
 * 委托任务确认卡的**纯投影摘要**（原定义在 src/delegated-task/service.ts）。全为字符串/枚举字面量字段，
 * 无 SQL / 无活状态。抬入 kernel 供 api 侧（feishu 卡片渲染）type-only 共导。
 */
export interface DelegatedTaskConfirmationSummary {
  taskId: string;
  version: number;
  title: string;
  accountName: string;
  platformLabel: string;
  actionLabel: string;
  target: string;
  attempts: string;
  schedule: string;
  approval: string;
  priority: string;
  constraints: string[];
  capability: 'supported' | 'beta';
  capabilityReason?: string;
}

/**
 * 委托任务服务抛出的**typed error**（原定义在 src/delegated-task/service.ts）。抬入 kernel 供 api 侧
 * （client-auth-server / panel-server / feishu 卡片）在 `instanceof` 处捕获并映射 HTTP 状态，而无需
 * type-only 依赖 automation 的服务类。纯 Error 子类，满足 §4.7 kernel 准入。
 */
export class DelegatedTaskServiceError extends Error {
  constructor(readonly code: string, message: string, readonly status = 400) {
    super(message);
    this.name = 'DelegatedTaskServiceError';
  }
}

/**
 * 委托任务服务的**读写窄面**（consumer-facing service port）。api 侧（client-auth-server /
 * panel/types / feishu 卡片）通过本端口驱动草稿创建 / 确认 / 暂停 / 恢复 / 取消 / 取单 / 列表，
 * 而不依赖 automation 的具体服务类。返回/入参类型全为本文件既有 kernel 纯类型；`list` 的筛选面按
 * DelegatedTaskListFilter 逐字内联（automation store 侧的 DelegatedTaskListFilter 结构等价）。
 * automation 的 DelegatedTaskService 结构兼容本端口，由组合根注入其实例；服务类不 import 本契约。
 */
export interface DelegatedTaskServicePort {
  createDraft(intent: DelegatedTaskIntent): Promise<{
    task: DelegatedTask;
    confirmation: DelegatedTaskConfirmationSummary;
    created: boolean;
    autoQueued: boolean;
  }>;
  confirm(taskId: string, version: number): Promise<DelegatedTask>;
  pause(taskId: string, version?: number): Promise<DelegatedTask>;
  resume(taskId: string, version?: number): Promise<DelegatedTask>;
  cancel(taskId: string, version?: number): Promise<DelegatedTask>;
  get(taskId: string): Promise<DelegatedTask>;
  list(filter?: {
    accountId?: string;
    actionFamily?: DelegatedActionFamily;
    statuses?: DelegatedTaskStatus[];
    limit?: number;
  }): Promise<DelegatedTask[]>;
}

/**
 * 「已触发发帖」引用集读端口（automation 属主 delegated_tasks 的窄读投影）。
 * 跨 owner 消费方（content 的精选内容存储判定 created/uncreated）MUST 经本接口向 automation 域要，
 * MUST NOT 直连 automation 库。返回该账号 + target 下 publish_post 委托任务的 curatedId / sourceId
 * 引用集（去重、剔空）。实现方 = automation 的委托任务存储；拆进程后换 HTTP 客户端，接口不变。
 */
export interface TriggeredPublishRefsReader {
  triggeredPublishRefs(
    accountId: string,
    executionTarget: string,
  ): Promise<{ curatedIds: string[]; sourceIds: string[] }>;
}

/**
 * 委托任务状态全集（运行时字面数组）；`satisfies` 与上面的 DelegatedTaskStatus 联合逐字对齐
 * （增删状态两处同改，编译期兜底）。纯 `as const` 冻结字面，非 Set/Map、非进程内活状态。
 * change decouple-longtail-sweep 从 src/delegated-task/types.ts 抬入，供 api 侧面板跨边界共导。
 */
export const DELEGATED_TASK_STATUSES = [
  'draft',
  'awaiting_confirmation',
  'queued',
  'planning',
  'waiting_approval',
  'executing',
  'partially_completed',
  'completed',
  'deferred',
  'cancelled',
  'failed',
] as const satisfies readonly DelegatedTaskStatus[];

/**
 * 客户端提交的审批模式归一（纯函数）：仅接受 `draft_only`，其余非空一律夹到 `review`，空值透传 undefined。
 * change decouple-longtail-sweep 从 src/delegated-task/types.ts 抬入，供 api 侧客户端鉴权/面板跨边界共导。
 */
export function clampClientApprovalMode(mode: unknown): DelegatedApprovalMode | undefined {
  if (mode === undefined || mode === null) return undefined;
  if (mode === 'draft_only') return 'draft_only';
  return 'review';
}
