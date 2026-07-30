/**
 * 服务层（期1-4）：三入口操作 CreateTask / CancelTask / QueryTask。
 *
 * 职责边界（design §3/§4.4）：提案（Proposal）仅为建议，本服务是 API 权威化落点——
 *   - Create：提案 → 权威 Task + 创建修订（TaskAuthorityStore 同事务）→ 复用 PlanCompiler
 *     编译 ExecutionPlan（编译拒绝即整体拒绝，拒绝原因如实返回；trace 由编译器落）→
 *     编译成功 insertRun 入队（queued，等 worker 认领）。platform_write 在编译准入即被
 *     以 'capability_not_available' 明确拒绝（期1 只放行 read_only，期2 起支持写动作）。
 *   - Cancel：前向语义（design §12）——Task CAS active→cancelled，非终态 run CAS 置
 *     cancel_requested（reasonCode='cancelled_by_user'）；安全点停止由 worker 负责
 *     （task-run-worker.ts 已实现，本层不重复）。已终态/不存在时如实返回失败原因。
 *   - Query：只读投影（Task + 当前修订 + TaskRun 正交状态 + 进度 + decision-trace 摘要），
 *     **零副作用**：查询失败是读未命中，不写 trace、不改任何状态。
 *
 * 纪律：所有操作显式收 executionTarget（服务端注入，提案不携带）；所有拒绝写
 * DecisionTrace（复用 contracts/reason-codes.ts 既有原因码，不新造）；ReviseTask
 * 本期不实现（契约已预留，期3）。
 */

import { randomUUID } from 'node:crypto';
import type { PlatformId } from '../../kernel/platform-types.js';
import type { ExecutionTarget } from '../contracts/common.js';
import type {
  AttemptProjection,
  CancelTaskProposal,
  CreateTaskProposal,
  QueryTaskProjection,
  QueryTaskRequest,
  TaskRunProjection,
  TraceSummaryProjection,
} from '../contracts/agent-intents.js';
import type { RejectionReasonCode } from '../contracts/reason-codes.js';
import type { TaskLifecycleStatus } from '../contracts/task.js';
import type { TaskDefinition } from '../contracts/capability.js';
import type { TaskRun } from '../contracts/task-run.js';
import type { ExecutionAttempt } from '../contracts/execution-attempt.js';
import type { DecisionTrace, DecisionType } from '../contracts/decision-trace.js';
import type { DecisionTraceStore } from '../stores/decision-trace-store.js';
import type { ExecutionLedgerStore } from '../stores/execution-ledger-store.js';
import type { RunStateStore, TaskRunInsert } from '../stores/run-state-store.js';
import type { TaskAuthorityStore, TaskInsert, TaskRevisionInsert } from '../stores/task-authority-store.js';
import type { PlanCompiler } from '../engine/plan-compiler.js';
import { PlanCompileError } from '../engine/plan-compiler.js';

/** 入口操作对 stores 的端口（同 engine/ports.ts 纪律：Pick<真实 store>，签名唯一事实源在 stores/）。 */
export type TaskAuthorityEntryPort = Pick<TaskAuthorityStore, 'createTask' | 'casSetTaskStatus' | 'getTask'>;
export type RunStateEntryPort = Pick<RunStateStore, 'insertRun' | 'transitionRun' | 'listRunsByTask'>;
export type LedgerReadPort = Pick<ExecutionLedgerStore, 'listIntentsByRun' | 'listAttemptsByIntent'>;
export type DecisionTraceEntryPort = Pick<DecisionTraceStore, 'append' | 'listByCorrelation'>;
export type PlanCompilerPort = Pick<PlanCompiler, 'compile'>;

/** 任务定义解析口：注册表实现；解析不到返回 null（服务显式拒绝 'unsupported'，不猜版本）。 */
export type TaskDefinitionResolver = (taskDefinitionId: string, version: number) => TaskDefinition | null;

/** 账号绑定解析结果：run 冻结块所需的 envKey 与绑定 revision（design §7 lane 身份输入）。 */
export interface AccountBindingResolution {
  envKey: string;
  accountBindingRevision: string;
}

/** 账号绑定解析口：解析不到返回 null（提案指向未绑定账号 → 'invalid_task_proposal'）。 */
export type AccountBindingResolver = (accountId: string, platform: PlatformId) => AccountBindingResolution | null;

export interface TaskEntryServiceDeps {
  taskAuthority: TaskAuthorityEntryPort;
  runState: RunStateEntryPort;
  ledger: LedgerReadPort;
  decisionTrace: DecisionTraceEntryPort;
  compiler: PlanCompilerPort;
  resolveTaskDefinition: TaskDefinitionResolver;
  resolveAccountBinding: AccountBindingResolver;
  now?: () => number;
  newId?: () => string;
}

/** 拒绝应答公共形态：原因码如实返回（与 decision-trace 同码），note 携带补充说明。 */
export interface EntryRejected {
  accepted: false;
  reasonCode: RejectionReasonCode;
  detail: string;
  /** 补充说明（如 platform_write 期2 起支持）；无补充为 null。 */
  note: string | null;
}

export interface CreateTaskAccepted {
  accepted: true;
  taskId: string;
  revisionId: string;
  executionPlanId: string;
  runId: string;
  /** 入队即应答；认领与执行由 worker 负责。 */
  runStatus: 'queued';
}

export interface CreateTaskRejected extends EntryRejected {
  /** 提案已权威化但编译被拒时任务已 CAS 到 cancelled，此处回其 ID；未落库为 null。 */
  taskId: string | null;
}

export type CreateTaskResult = CreateTaskAccepted | CreateTaskRejected;

export interface CancelTaskAccepted {
  accepted: true;
  taskId: string;
  /** 已置（或此前已处）cancel_requested 的 run；安全点停止由 worker 收敛。 */
  cancelRequestedRunIds: string[];
  /** 已处终态、无需取消的 run（前向语义：不覆盖真实平台结果）。 */
  alreadyTerminalRunIds: string[];
}

export interface CancelTaskRejected extends EntryRejected {
  /** 拒绝时任务的真实当前状态；任务不存在为 null。 */
  currentStatus: TaskLifecycleStatus | null;
}

export type CancelTaskResult = CancelTaskAccepted | CancelTaskRejected;

/** 查询失败是读未命中（零副作用，不写 trace），与 Create/Cancel 的「拒绝」区分。 */
export type QueryTaskResult =
  | { found: true; projection: QueryTaskProjection }
  | { found: false; reasonCode: 'invalid_task_proposal'; detail: string };

const PLATFORM_WRITE_NOTE = 'platform_write 动作期1 执行层不可用（只放行 read_only），期2 起支持';

export class TaskEntryService {
  private readonly now: () => number;
  private readonly newId: () => string;

  constructor(private readonly deps: TaskEntryServiceDeps) {
    this.now = deps.now ?? Date.now;
    this.newId = deps.newId ?? randomUUID;
  }

  /**
   * CreateTaskProposal → 权威化 → 编译 → 入队。任一环拒绝即整体拒绝：
   * 编译拒绝时任务已落库，CAS active→cancelled 收敛（不留僵尸 active 任务）。
   */
  async createTask(executionTarget: ExecutionTarget, proposal: CreateTaskProposal): Promise<CreateTaskResult> {
    const invalid = validateCreateProposal(proposal);
    if (invalid) {
      await this.traceDenial(executionTarget, 'admission', proposal.correlationId, 'invalid_task_proposal', [
        `create-proposal:${proposal.correlationId}`,
      ]);
      return { accepted: false, taskId: null, reasonCode: 'invalid_task_proposal', detail: invalid, note: null };
    }

    const definition = this.deps.resolveTaskDefinition(proposal.taskDefinitionId, proposal.taskDefinitionVersion);
    if (!definition) {
      await this.traceDenial(executionTarget, 'admission', proposal.correlationId, 'unsupported', [
        `task-definition:${proposal.taskDefinitionId}@${proposal.taskDefinitionVersion}`,
      ]);
      return {
        accepted: false,
        taskId: null,
        reasonCode: 'unsupported',
        detail: `任务定义 ${proposal.taskDefinitionId}@${proposal.taskDefinitionVersion} 解析不到，显式不支持`,
        note: null,
      };
    }

    const binding = this.deps.resolveAccountBinding(proposal.accountId, proposal.platform);
    if (!binding) {
      await this.traceDenial(executionTarget, 'admission', proposal.correlationId, 'invalid_task_proposal', [
        `account:${proposal.accountId}`,
      ], proposal.taskDefinitionVersion);
      return {
        accepted: false,
        taskId: null,
        reasonCode: 'invalid_task_proposal',
        detail: `账号 ${proposal.accountId}（${proposal.platform}）无绑定，提案不可权威化`,
        note: null,
      };
    }

    const taskId = this.newId();
    const revisionId = this.newId();
    const executionPlanId = this.newId();
    const runId = this.newId();
    // 裁量：期1 无独立授权/完成条件事实源，引用从提案与定义机械导出（可追溯、不编造）。
    const authorizationRef = `create-proposal:${proposal.correlationId}`;
    const completionConditionRef = `completion:${proposal.taskDefinitionId}@${proposal.taskDefinitionVersion}`;

    const task: TaskInsert = {
      taskId,
      executionTarget,
      planId: proposal.planId,
      cycleId: proposal.cycleId,
      accountId: proposal.accountId,
      envKey: binding.envKey,
      platform: proposal.platform,
      taskDefinitionId: proposal.taskDefinitionId,
      taskDefinitionVersion: proposal.taskDefinitionVersion,
      currentRevisionId: revisionId,
      capabilityScope: proposal.requestedCapabilityScope,
      actionAuthorization: proposal.requestedAuthorization,
      constraints: proposal.constraints,
      budgets: proposal.budgets,
      schedule: proposal.schedule,
      completionConditionRef,
      status: 'active',
      conversationMessageId: proposal.conversationMessageId,
      correlationId: proposal.correlationId,
    };
    const creationRevision: TaskRevisionInsert = {
      revisionId,
      taskId,
      executionTarget,
      revisionOrdinal: 1,
      cause: 'create',
      capabilityScope: proposal.requestedCapabilityScope,
      actionAuthorization: proposal.requestedAuthorization,
      constraints: proposal.constraints,
      budgets: proposal.budgets,
      schedule: proposal.schedule,
      authorizationRef,
      supersedesRevisionId: null,
      proposalRef: proposal.conversationMessageId === null
        ? null
        : `conversation-message:${proposal.conversationMessageId}`,
    };
    const created = await this.deps.taskAuthority.createTask(executionTarget, task, creationRevision);
    if (!created) {
      // 新生成 UUID 撞既有行只可能是重放/冲突，如实拒绝，不覆盖。
      await this.traceDenial(executionTarget, 'admission', proposal.correlationId, 'duplicate_trigger', [
        `task:${taskId}`,
      ], proposal.taskDefinitionVersion);
      return {
        accepted: false,
        taskId: null,
        reasonCode: 'duplicate_trigger',
        detail: `task_id=${taskId} 已存在，创建未落库`,
        note: null,
      };
    }

    let planCompiled;
    try {
      planCompiled = await this.deps.compiler.compile(executionTarget, {
        executionPlanId,
        taskId,
        taskRevisionId: revisionId,
        correlationId: proposal.correlationId,
        causationId: null,
        planId: proposal.planId,
        planVersion: null,
        authorizationRef,
        completionConditionRef,
        capabilityScope: proposal.requestedCapabilityScope,
        definition,
      });
    } catch (err) {
      if (err instanceof PlanCompileError) {
        // 编译拒绝即整体拒绝：trace 已由编译器落（同码），这里只收敛任务状态。
        await this.deps.taskAuthority.casSetTaskStatus(executionTarget, taskId, 'active', 'cancelled');
        return {
          accepted: false,
          taskId,
          reasonCode: err.reasonCode,
          detail: err.message,
          note: err.reasonCode === 'capability_not_available' ? PLATFORM_WRITE_NOTE : null,
        };
      }
      throw err;
    }

    const run: TaskRunInsert = {
      runId,
      taskId,
      taskRevisionId: revisionId,
      executionPlanId: planCompiled.executionPlanId,
      cycleId: proposal.cycleId,
      executionTarget,
      correlationId: proposal.correlationId,
      planId: proposal.planId,
      planVersion: null,
      taskDefinitionId: proposal.taskDefinitionId,
      taskDefinitionVersion: proposal.taskDefinitionVersion,
      personaVersion: null,
      accountId: proposal.accountId,
      envKey: binding.envKey,
      platform: proposal.platform,
      accountBindingRevision: binding.accountBindingRevision,
      candidateVersionId: null,
      contentVersion: null,
      approvalRevision: null,
      schedule: proposal.schedule,
      budgets: proposal.budgets,
      idempotencyKey: `${taskId}:initial`,
      status: 'queued',
      waitReason: null,
      terminalOutcome: null,
      reasonCode: null,
    };
    const enqueued = await this.deps.runState.insertRun(executionTarget, run);
    if (!enqueued) {
      await this.traceDenial(executionTarget, 'admission', proposal.correlationId, 'duplicate_intent', [
        `run:${runId}`,
      ], proposal.taskDefinitionVersion);
      await this.deps.taskAuthority.casSetTaskStatus(executionTarget, taskId, 'active', 'cancelled');
      return {
        accepted: false,
        taskId,
        reasonCode: 'duplicate_intent',
        detail: `run 幂等键 ${run.idempotencyKey} 命中既有行，入队未落库`,
        note: null,
      };
    }
    return { accepted: true, taskId, revisionId, executionPlanId: planCompiled.executionPlanId, runId, runStatus: 'queued' };
  }

  /**
   * CancelTaskProposal：Task CAS active→cancelled + 非终态 run 置 cancel_requested。
   * 已终态 / 不存在 / 并发漂移一律如实返回失败原因，不伪装成功。
   */
  async cancelTask(executionTarget: ExecutionTarget, proposal: CancelTaskProposal): Promise<CancelTaskResult> {
    if (proposal.kind !== 'cancel_task' || proposal.taskId.trim() === '' || proposal.correlationId.trim() === '') {
      await this.traceDenial(executionTarget, 'denial', proposal.correlationId, 'invalid_task_proposal', [
        `task:${proposal.taskId}`,
      ]);
      return {
        accepted: false,
        currentStatus: null,
        reasonCode: 'invalid_task_proposal',
        detail: '取消提案缺 taskId/correlationId 或 kind 不符',
        note: null,
      };
    }
    const task = await this.deps.taskAuthority.getTask(executionTarget, proposal.taskId);
    if (!task) {
      await this.traceDenial(executionTarget, 'denial', proposal.correlationId, 'invalid_task_proposal', [
        `task:${proposal.taskId}`,
      ]);
      return {
        accepted: false,
        currentStatus: null,
        reasonCode: 'invalid_task_proposal',
        detail: `task_id=${proposal.taskId} 不存在（target=${executionTarget}）`,
        note: null,
      };
    }
    if (task.status !== 'active') {
      await this.traceDenial(executionTarget, 'denial', proposal.correlationId, 'stale_target', [
        `task:${proposal.taskId}`,
      ], task.taskDefinitionVersion);
      return {
        accepted: false,
        currentStatus: task.status,
        reasonCode: 'stale_target',
        detail: `任务已处终态 ${task.status}，取消无事可做`,
        note: null,
      };
    }
    const cancelled = await this.deps.taskAuthority.casSetTaskStatus(executionTarget, proposal.taskId, 'active', 'cancelled');
    if (!cancelled) {
      const fresh = await this.deps.taskAuthority.getTask(executionTarget, proposal.taskId);
      await this.traceDenial(executionTarget, 'denial', proposal.correlationId, 'stale_target', [
        `task:${proposal.taskId}`,
      ], task.taskDefinitionVersion);
      return {
        accepted: false,
        currentStatus: fresh?.status ?? null,
        reasonCode: 'stale_target',
        detail: `任务状态并发漂移（当前=${fresh?.status ?? '未知'}），CAS 未命中`,
        note: null,
      };
    }
    const runs = await this.deps.runState.listRunsByTask(executionTarget, proposal.taskId);
    const cancelRequestedRunIds: string[] = [];
    const alreadyTerminalRunIds: string[] = [];
    for (const run of runs) {
      if (run.status === 'terminal') {
        alreadyTerminalRunIds.push(run.runId);
        continue;
      }
      if (run.status === 'cancel_requested') {
        cancelRequestedRunIds.push(run.runId);
        continue;
      }
      const hit = await this.deps.runState.transitionRun(executionTarget, run.runId, run.status, {
        status: 'cancel_requested',
        waitReason: null,
        terminalOutcome: null,
        reasonCode: 'cancelled_by_user',
      });
      // CAS 未命中 = 状态刚漂移；按新读回的现状归类，不盲报成功。
      if (hit) {
        cancelRequestedRunIds.push(run.runId);
      } else {
        const fresh = await this.deps.runState.listRunsByTask(executionTarget, proposal.taskId);
        const moved = fresh.find((row) => row.runId === run.runId);
        if (moved?.status === 'cancel_requested') cancelRequestedRunIds.push(run.runId);
        else if (moved?.status === 'terminal') alreadyTerminalRunIds.push(run.runId);
      }
    }
    return { accepted: true, taskId: proposal.taskId, cancelRequestedRunIds, alreadyTerminalRunIds };
  }

  /**
   * QueryTaskRequest → QueryTaskProjection。只读零副作用；include.X=false 对应层为 null
   * （区别于「无数据」的空数组）。StepRun 进度经 run.progress/currentNodeId 透出
   * （冻结契约无步级行）。
   */
  async queryTask(executionTarget: ExecutionTarget, request: QueryTaskRequest): Promise<QueryTaskResult> {
    if (request.kind !== 'query_task' || request.taskId === null || request.taskId.trim() === '') {
      return { found: false, reasonCode: 'invalid_task_proposal', detail: '期1 查询要求显式 taskId（按 account 列表查询未实现）' };
    }
    const task = await this.deps.taskAuthority.getTask(executionTarget, request.taskId);
    if (!task) {
      return { found: false, reasonCode: 'invalid_task_proposal', detail: `task_id=${request.taskId} 不存在（target=${executionTarget}）` };
    }
    let runs: TaskRunProjection[] | null = null;
    let attempts: AttemptProjection[] | null = null;
    if (request.include.runs || request.include.attempts) {
      const rows = await this.deps.runState.listRunsByTask(executionTarget, task.taskId);
      if (request.include.runs) runs = rows.map(projectRun);
      if (request.include.attempts) {
        attempts = [];
        for (const row of rows) {
          const intents = await this.deps.ledger.listIntentsByRun(executionTarget, row.runId);
          for (const intent of intents) {
            const settled = await this.deps.ledger.listAttemptsByIntent(executionTarget, intent.intentId);
            attempts.push(...settled.map(projectAttempt));
          }
        }
      }
    }
    const traces: TraceSummaryProjection[] | null = request.include.traces
      ? (await this.deps.decisionTrace.listByCorrelation(executionTarget, task.correlationId)).map(projectTrace)
      : null;
    return {
      found: true,
      projection: {
        taskId: task.taskId,
        executionTarget: task.executionTarget,
        status: task.status,
        currentRevisionId: task.currentRevisionId,
        runs,
        attempts,
        traces,
        projectedAt: this.now(),
      },
    };
  }

  /** 拒绝落 trace（复用既有原因码；与编译器同形：admission/denial + denied）。 */
  private async traceDenial(
    executionTarget: ExecutionTarget,
    decisionType: DecisionType,
    correlationId: string,
    reasonCode: RejectionReasonCode,
    inputRefs: string[],
    taskDefinitionVersion: number | null = null,
  ): Promise<void> {
    await this.deps.decisionTrace.append(executionTarget, {
      traceId: this.newId(),
      correlationId,
      causationId: null,
      executionTarget,
      versions: {
        planVersion: null,
        taskDefinitionVersion,
        personaVersion: null,
        policyRevision: null,
        approvalRevision: null,
      },
      runId: null,
      stepId: null,
      attemptId: null,
      decisionType,
      inputRefs,
      candidates: [],
      outcome: 'denied',
      reasonCode,
      snapshotRefs: [],
    });
  }
}

function validateCreateProposal(proposal: CreateTaskProposal): string | null {
  if (proposal.kind !== 'create_task') return `kind=${String(proposal.kind)} 不是 create_task`;
  if (proposal.correlationId.trim() === '') return 'correlationId 为空';
  if (proposal.accountId.trim() === '') return 'accountId 为空';
  if (proposal.taskDefinitionId.trim() === '') return 'taskDefinitionId 为空';
  if (!Number.isInteger(proposal.taskDefinitionVersion) || proposal.taskDefinitionVersion < 1) {
    return `taskDefinitionVersion=${proposal.taskDefinitionVersion} 非法`;
  }
  return null;
}

function projectRun(run: TaskRun): TaskRunProjection {
  return {
    runId: run.runId,
    taskRevisionId: run.taskRevisionId,
    status: run.status,
    waitReason: run.waitReason,
    terminalOutcome: run.terminalOutcome,
    reasonCode: run.reasonCode,
    progress: run.progress,
    currentNodeId: run.currentNodeId,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
  };
}

function projectAttempt(attempt: ExecutionAttempt): AttemptProjection {
  return {
    attemptId: attempt.attemptId,
    runId: attempt.runId,
    stepId: attempt.stepId,
    status: attempt.status,
    reasonCode: attempt.reasonCode,
    evidenceRef: attempt.evidenceRef,
    settledAt: attempt.settledAt,
  };
}

function projectTrace(trace: DecisionTrace): TraceSummaryProjection {
  return {
    traceId: trace.traceId,
    decisionType: trace.decisionType,
    outcome: trace.outcome,
    reasonCode: trace.reasonCode,
    createdAt: trace.createdAt,
  };
}
