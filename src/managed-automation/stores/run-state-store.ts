/**
 * RunStateStore（期1-2）：task_runs / step_runs 正交运行状态的 typed store。
 *
 * 纪律（任务硬性要求 + contracts/task-run.ts 文件头）：
 *   - 两条不变式在写路径**先于 SQL**强制（库侧 CHECK 只兜底）：
 *       waitReason !== null ⇔ status === 'waiting'
 *       terminalOutcome !== null ⇔ status === 'terminal'
 *   - 状态迁移一律 CAS 谓词式 UPDATE（WHERE 校验当前 status），返回是否命中，绝不盲写；
 *   - claim/lease：原子认领一条 queued（FOR UPDATE SKIP LOCKED + 租约到期时间）、
 *     按 token 续租、过期租约回收回 queued；claim_token/claim_expires_at 是 store 实现细节
 *     （contracts/STATE-MAPPING.md §2.1），不进 TaskRun 契约对象；
 *   - 所有接口显式收 executionTarget 并过滤。
 */

import type { PlatformId } from '../../kernel/platform-types.js';
import type { ExecutionTarget, ScheduleWindow } from '../contracts/common.js';
import type { ReasonCode } from '../contracts/reason-codes.js';
import type { CapabilityId } from '../contracts/capability.js';
import type { TaskBudgets } from '../contracts/task.js';
import type {
  OrthogonalRunState,
  RunProgress,
  RunStatus,
  RunTerminalOutcome,
  StepRun,
  TaskRun,
  WaitReason,
} from '../contracts/task-run.js';
import {
  ManagedAutomationInvariantError,
  ManagedAutomationStoreBase,
  toEpochMillis,
  toNullableEpochMillis,
  type ManagedAutomationStoreOptions,
  type ManagedSchemaRequirement,
} from './store-base.js';

const RUN_STATE_REQUIREMENT: ManagedSchemaRequirement = {
  capability: 'managed_automation_run_state',
  sinceVersion: '0107_managed_automation_run_state',
  tables: new Map([
    ['task_runs', new Set([
      'run_id', 'execution_target', 'task_id', 'task_revision_id', 'execution_plan_id',
      'cycle_id', 'correlation_id', 'plan_id', 'plan_version', 'task_definition_id',
      'task_definition_version', 'persona_version', 'account_id', 'env_key', 'platform',
      'account_binding_revision', 'candidate_version_id', 'content_version', 'approval_revision',
      'schedule', 'budgets', 'idempotency_key', 'status', 'wait_reason', 'terminal_outcome',
      'reason_code', 'confirmed_count', 'target_count', 'attempt_count', 'skipped_count',
      'failure_count', 'current_node_id', 'superseded_by_run_id', 'claim_token',
      'claim_expires_at', 'aggregate_version', 'created_at', 'updated_at', 'started_at',
      'finished_at',
    ])],
    ['step_runs', new Set([
      'step_run_id', 'execution_target', 'run_id', 'node_id', 'capability_id',
      'capability_version', 'status', 'wait_reason', 'terminal_outcome', 'reason_code',
      'input_ref', 'result_ref', 'checkpoint_ref', 'attempt_count', 'created_at',
      'updated_at', 'started_at', 'finished_at',
    ])],
  ]),
  indexes: new Map([
    ['idx_task_runs_target_status', 'task_runs'],
    ['idx_task_runs_target_task', 'task_runs'],
    ['uq_task_runs_target_idempotency', 'task_runs'],
    ['idx_task_runs_target_lease', 'task_runs'],
    ['uq_step_runs_target_run_node', 'step_runs'],
    ['idx_step_runs_target_run', 'step_runs'],
  ]),
};

/**
 * 两条不变式的唯一校验点（TaskRun/StepRun 共用）。违规即抛，绝不落库。
 */
export function assertOrthogonalInvariants(state: OrthogonalRunState): void {
  if ((state.waitReason !== null) !== (state.status === 'waiting')) {
    throw new ManagedAutomationInvariantError(
      `waitReason 非空 ⇔ status='waiting' 被违反（status=${state.status}, waitReason=${state.waitReason}）`,
    );
  }
  if ((state.terminalOutcome !== null) !== (state.status === 'terminal')) {
    throw new ManagedAutomationInvariantError(
      `terminalOutcome 非空 ⇔ status='terminal' 被违反（status=${state.status}, terminalOutcome=${state.terminalOutcome}）`,
    );
  }
}

interface TaskRunDbRow {
  run_id: string;
  execution_target: ExecutionTarget;
  task_id: string;
  task_revision_id: string;
  execution_plan_id: string;
  cycle_id: string | null;
  correlation_id: string;
  plan_id: string | null;
  plan_version: number | null;
  task_definition_id: string;
  task_definition_version: number;
  persona_version: string | null;
  account_id: string;
  env_key: string;
  platform: string;
  account_binding_revision: string;
  candidate_version_id: string | null;
  content_version: string | null;
  approval_revision: string | null;
  schedule: ScheduleWindow;
  budgets: TaskBudgets;
  idempotency_key: string;
  status: RunStatus;
  wait_reason: WaitReason | null;
  terminal_outcome: RunTerminalOutcome | null;
  reason_code: ReasonCode | null;
  confirmed_count: number;
  target_count: number | null;
  attempt_count: number;
  skipped_count: number;
  failure_count: number;
  current_node_id: string | null;
  superseded_by_run_id: string | null;
  claim_token: string | null;
  claim_expires_at: Date | string | null;
  aggregate_version: number;
  created_at: Date | string;
  updated_at: Date | string;
  started_at: Date | string | null;
  finished_at: Date | string | null;
}

interface StepRunDbRow {
  step_run_id: string;
  execution_target: ExecutionTarget;
  run_id: string;
  node_id: string;
  capability_id: string;
  capability_version: number;
  status: RunStatus;
  wait_reason: WaitReason | null;
  terminal_outcome: RunTerminalOutcome | null;
  reason_code: ReasonCode | null;
  input_ref: string | null;
  result_ref: string | null;
  checkpoint_ref: string | null;
  attempt_count: number;
  created_at: Date | string;
  updated_at: Date | string;
  started_at: Date | string | null;
  finished_at: Date | string | null;
}

function taskRunFromDb(row: TaskRunDbRow): TaskRun {
  return {
    runId: row.run_id,
    taskId: row.task_id,
    taskRevisionId: row.task_revision_id,
    executionPlanId: row.execution_plan_id,
    cycleId: row.cycle_id,
    executionTarget: row.execution_target,
    correlationId: row.correlation_id,
    planId: row.plan_id,
    planVersion: row.plan_version === null ? null : Number(row.plan_version),
    taskDefinitionId: row.task_definition_id,
    taskDefinitionVersion: Number(row.task_definition_version),
    personaVersion: row.persona_version,
    accountId: row.account_id,
    envKey: row.env_key,
    platform: row.platform as PlatformId,
    accountBindingRevision: row.account_binding_revision,
    candidateVersionId: row.candidate_version_id,
    contentVersion: row.content_version,
    approvalRevision: row.approval_revision,
    schedule: row.schedule,
    budgets: row.budgets,
    idempotencyKey: row.idempotency_key,
    status: row.status,
    waitReason: row.wait_reason,
    terminalOutcome: row.terminal_outcome,
    reasonCode: row.reason_code,
    progress: {
      confirmedCount: Number(row.confirmed_count),
      targetCount: row.target_count === null ? null : Number(row.target_count),
      attemptCount: Number(row.attempt_count),
      skippedCount: Number(row.skipped_count),
      failureCount: Number(row.failure_count),
    },
    currentNodeId: row.current_node_id,
    supersededByRunId: row.superseded_by_run_id,
    aggregateVersion: Number(row.aggregate_version),
    createdAt: toEpochMillis(row.created_at),
    updatedAt: toEpochMillis(row.updated_at),
    startedAt: toNullableEpochMillis(row.started_at),
    finishedAt: toNullableEpochMillis(row.finished_at),
  };
}

function stepRunFromDb(row: StepRunDbRow): StepRun {
  return {
    stepRunId: row.step_run_id,
    runId: row.run_id,
    nodeId: row.node_id,
    capabilityId: row.capability_id as CapabilityId,
    capabilityVersion: Number(row.capability_version),
    executionTarget: row.execution_target,
    status: row.status,
    waitReason: row.wait_reason,
    terminalOutcome: row.terminal_outcome,
    reasonCode: row.reason_code,
    inputRef: row.input_ref,
    resultRef: row.result_ref,
    checkpointRef: row.checkpoint_ref,
    attemptCount: Number(row.attempt_count),
    createdAt: toEpochMillis(row.created_at),
    updatedAt: toEpochMillis(row.updated_at),
    startedAt: toNullableEpochMillis(row.started_at),
    finishedAt: toNullableEpochMillis(row.finished_at),
  };
}

const TASK_RUN_COLUMNS = `run_id, execution_target, task_id, task_revision_id, execution_plan_id,
  cycle_id, correlation_id, plan_id, plan_version, task_definition_id, task_definition_version,
  persona_version, account_id, env_key, platform, account_binding_revision, candidate_version_id,
  content_version, approval_revision, schedule, budgets, idempotency_key, status, wait_reason,
  terminal_outcome, reason_code, confirmed_count, target_count, attempt_count, skipped_count,
  failure_count, current_node_id, superseded_by_run_id, claim_token, claim_expires_at,
  aggregate_version, created_at, updated_at, started_at, finished_at`;

const STEP_RUN_COLUMNS = `step_run_id, execution_target, run_id, node_id, capability_id,
  capability_version, status, wait_reason, terminal_outcome, reason_code, input_ref, result_ref,
  checkpoint_ref, attempt_count, created_at, updated_at, started_at, finished_at`;

/** 创建输入：冻结块 + 初始正交状态；进度/租约/版本/时间戳由库侧初始化。 */
export type TaskRunInsert = Omit<
  TaskRun,
  'progress' | 'currentNodeId' | 'supersededByRunId' | 'aggregateVersion'
  | 'createdAt' | 'updatedAt' | 'startedAt' | 'finishedAt'
> & { targetCount?: number | null };

export type StepRunInsert = Omit<
  StepRun,
  'resultRef' | 'checkpointRef' | 'attemptCount'
  | 'createdAt' | 'updatedAt' | 'startedAt' | 'finishedAt'
>;

/** CAS 迁移的目标状态（新三元组 + 原因码；terminal 时可携带接棒 run）。 */
export interface RunStateTransition extends OrthogonalRunState {
  supersededByRunId?: string | null;
}

/** 认领结果：契约对象 + 租约细节（租约不进 TaskRun 契约）。 */
export interface ClaimedTaskRun {
  run: TaskRun;
  claimToken: string;
  claimExpiresAt: number;
}

export class RunStateStore extends ManagedAutomationStoreBase {
  constructor(options: ManagedAutomationStoreOptions) {
    super(RUN_STATE_REQUIREMENT, options);
  }

  // —— task_runs ——

  /**
   * 创建 run。run_id 或 (target, idempotency_key) 命中既有行都视为幂等重放，
   * 不覆盖、返回 false（ON CONFLICT DO NOTHING 无目标列 = 任一唯一约束命中即静默）。
   */
  async insertRun(executionTarget: ExecutionTarget, run: TaskRunInsert): Promise<boolean> {
    assertOrthogonalInvariants(run);
    const result = await this.pool.query(
      `INSERT INTO task_runs (run_id, execution_target, task_id, task_revision_id, execution_plan_id,
         cycle_id, correlation_id, plan_id, plan_version, task_definition_id, task_definition_version,
         persona_version, account_id, env_key, platform, account_binding_revision, candidate_version_id,
         content_version, approval_revision, schedule, budgets, idempotency_key,
         status, wait_reason, terminal_outcome, reason_code, target_count)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27)
       ON CONFLICT DO NOTHING`,
      [
        run.runId, executionTarget, run.taskId, run.taskRevisionId, run.executionPlanId,
        run.cycleId, run.correlationId, run.planId, run.planVersion, run.taskDefinitionId,
        run.taskDefinitionVersion, run.personaVersion, run.accountId, run.envKey, run.platform,
        run.accountBindingRevision, run.candidateVersionId, run.contentVersion, run.approvalRevision,
        JSON.stringify(run.schedule), JSON.stringify(run.budgets), run.idempotencyKey,
        run.status, run.waitReason, run.terminalOutcome, run.reasonCode, run.targetCount ?? null,
      ],
    );
    return result.rowCount === 1;
  }

  /**
   * CAS 状态迁移：WHERE 校验当前 status（可选再校验 aggregate_version），命中才写。
   * 不变式先在 store 层断言；离开 running 即释放租约；进 terminal 落 finished_at。
   */
  async transitionRun(
    executionTarget: ExecutionTarget,
    runId: string,
    expectedStatus: RunStatus,
    next: RunStateTransition,
    expectedAggregateVersion?: number,
  ): Promise<boolean> {
    assertOrthogonalInvariants(next);
    const params: unknown[] = [
      runId, executionTarget, expectedStatus,
      next.status, next.waitReason, next.terminalOutcome, next.reasonCode,
      next.supersededByRunId ?? null,
    ];
    let versionPredicate = '';
    if (expectedAggregateVersion !== undefined) {
      params.push(expectedAggregateVersion);
      versionPredicate = ` AND aggregate_version=$${params.length}`;
    }
    const result = await this.pool.query(
      `UPDATE task_runs
          SET status=$4, wait_reason=$5, terminal_outcome=$6, reason_code=$7,
              superseded_by_run_id=COALESCE($8, superseded_by_run_id),
              claim_token=CASE WHEN $4='running' THEN claim_token ELSE NULL END,
              claim_expires_at=CASE WHEN $4='running' THEN claim_expires_at ELSE NULL END,
              started_at=CASE WHEN $4='running' THEN COALESCE(started_at, now()) ELSE started_at END,
              finished_at=CASE WHEN $4='terminal' THEN COALESCE(finished_at, now()) ELSE finished_at END,
              aggregate_version=aggregate_version+1, updated_at=now()
        WHERE run_id=$1 AND execution_target=$2 AND status=$3${versionPredicate}`,
      params,
    );
    return result.rowCount === 1;
  }

  /**
   * 原子认领一条 queued（创建序最老优先）：FOR UPDATE SKIP LOCKED 保证并发 worker 互斥，
   * 认领即 queued→running 并落租约到期时间。无可认领行返回 null。
   */
  async claimNextQueued(
    executionTarget: ExecutionTarget,
    claimToken: string,
    leaseMs: number,
  ): Promise<ClaimedTaskRun | null> {
    const result = await this.pool.query<TaskRunDbRow>(
      `UPDATE task_runs
          SET status='running', claim_token=$2,
              claim_expires_at=now() + make_interval(secs => $3::double precision / 1000),
              started_at=COALESCE(started_at, now()),
              aggregate_version=aggregate_version+1, updated_at=now()
        WHERE run_id = (
          SELECT run_id FROM task_runs
           WHERE execution_target=$1 AND status='queued'
           ORDER BY created_at ASC
           LIMIT 1
           FOR UPDATE SKIP LOCKED)
          AND execution_target=$1 AND status='queued'
        RETURNING ${TASK_RUN_COLUMNS}`,
      [executionTarget, claimToken, leaseMs],
    );
    const row = result.rows[0];
    if (!row) return null;
    return {
      run: taskRunFromDb(row),
      claimToken,
      claimExpiresAt: toEpochMillis(row.claim_expires_at as Date | string),
    };
  }

  /** 续租：仅当仍持有**未过期**的同 token 租约时延长，返回是否命中。 */
  async renewLease(
    executionTarget: ExecutionTarget,
    runId: string,
    claimToken: string,
    leaseMs: number,
  ): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE task_runs
          SET claim_expires_at=now() + make_interval(secs => $4::double precision / 1000),
              updated_at=now()
        WHERE run_id=$1 AND execution_target=$2 AND status='running'
          AND claim_token=$3 AND claim_expires_at > now()`,
      [runId, executionTarget, claimToken, leaseMs],
    );
    return result.rowCount === 1;
  }

  /**
   * 回收过期租约：running 且 claim_expires_at 已过 → 放回 queued（清租约），
   * 返回被回收的 run_id。回收后由下一次 claimNextQueued 接管。
   */
  async reclaimExpiredLeases(executionTarget: ExecutionTarget, limit = 20): Promise<string[]> {
    const result = await this.pool.query<{ run_id: string }>(
      `UPDATE task_runs
          SET status='queued', claim_token=NULL, claim_expires_at=NULL,
              aggregate_version=aggregate_version+1, updated_at=now()
        WHERE run_id IN (
          SELECT run_id FROM task_runs
           WHERE execution_target=$1 AND status='running'
             AND claim_token IS NOT NULL AND claim_expires_at <= now()
           ORDER BY claim_expires_at ASC
           LIMIT $2
           FOR UPDATE SKIP LOCKED)
          AND execution_target=$1 AND status='running'
          AND claim_token IS NOT NULL AND claim_expires_at <= now()
        RETURNING run_id`,
      [executionTarget, limit],
    );
    return result.rows.map((row) => row.run_id);
  }

  /**
   * 记录进度（谓词式：必须仍是 running 且持有同 token 租约，防「僵尸 worker 隔代写」）。
   */
  async recordRunProgress(
    executionTarget: ExecutionTarget,
    runId: string,
    claimToken: string,
    progress: RunProgress,
    currentNodeId: string | null,
  ): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE task_runs
          SET confirmed_count=$4, target_count=$5, attempt_count=$6, skipped_count=$7,
              failure_count=$8, current_node_id=$9,
              aggregate_version=aggregate_version+1, updated_at=now()
        WHERE run_id=$1 AND execution_target=$2 AND status='running' AND claim_token=$3`,
      [
        runId, executionTarget, claimToken,
        progress.confirmedCount, progress.targetCount, progress.attemptCount,
        progress.skippedCount, progress.failureCount, currentNodeId,
      ],
    );
    return result.rowCount === 1;
  }

  async getRun(executionTarget: ExecutionTarget, runId: string): Promise<TaskRun | null> {
    const result = await this.pool.query<TaskRunDbRow>(
      `SELECT ${TASK_RUN_COLUMNS} FROM task_runs WHERE run_id=$1 AND execution_target=$2`,
      [runId, executionTarget],
    );
    return result.rows[0] ? taskRunFromDb(result.rows[0]) : null;
  }

  async listRunsByStatus(
    executionTarget: ExecutionTarget,
    status: RunStatus,
    limit = 100,
  ): Promise<TaskRun[]> {
    const result = await this.pool.query<TaskRunDbRow>(
      `SELECT ${TASK_RUN_COLUMNS} FROM task_runs
        WHERE execution_target=$1 AND status=$2
        ORDER BY created_at ASC
        LIMIT $3`,
      [executionTarget, status, limit],
    );
    return result.rows.map(taskRunFromDb);
  }

  async listRunsByTask(executionTarget: ExecutionTarget, taskId: string): Promise<TaskRun[]> {
    const result = await this.pool.query<TaskRunDbRow>(
      `SELECT ${TASK_RUN_COLUMNS} FROM task_runs
        WHERE execution_target=$1 AND task_id=$2
        ORDER BY created_at ASC`,
      [executionTarget, taskId],
    );
    return result.rows.map(taskRunFromDb);
  }

  // —— step_runs ——

  /** 创建节点运行实例；同 (target, run, node) 已存在即返回 false（恢复 = 续写既有行）。 */
  async insertStepRun(executionTarget: ExecutionTarget, step: StepRunInsert): Promise<boolean> {
    assertOrthogonalInvariants(step);
    const result = await this.pool.query(
      `INSERT INTO step_runs (step_run_id, execution_target, run_id, node_id, capability_id,
         capability_version, status, wait_reason, terminal_outcome, reason_code, input_ref)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       ON CONFLICT DO NOTHING`,
      [
        step.stepRunId, executionTarget, step.runId, step.nodeId, step.capabilityId,
        step.capabilityVersion, step.status, step.waitReason, step.terminalOutcome,
        step.reasonCode, step.inputRef,
      ],
    );
    return result.rowCount === 1;
  }

  /** CAS 状态迁移（同 transitionRun 的不变式与谓词纪律）。 */
  async transitionStep(
    executionTarget: ExecutionTarget,
    stepRunId: string,
    expectedStatus: RunStatus,
    next: OrthogonalRunState,
  ): Promise<boolean> {
    assertOrthogonalInvariants(next);
    const result = await this.pool.query(
      `UPDATE step_runs
          SET status=$4, wait_reason=$5, terminal_outcome=$6, reason_code=$7,
              attempt_count=attempt_count + CASE WHEN $4='running' AND $3<>'running' THEN 1 ELSE 0 END,
              started_at=CASE WHEN $4='running' THEN COALESCE(started_at, now()) ELSE started_at END,
              finished_at=CASE WHEN $4='terminal' THEN COALESCE(finished_at, now()) ELSE finished_at END,
              updated_at=now()
        WHERE step_run_id=$1 AND execution_target=$2 AND status=$3`,
      [
        stepRunId, executionTarget, expectedStatus,
        next.status, next.waitReason, next.terminalOutcome, next.reasonCode,
      ],
    );
    return result.rowCount === 1;
  }

  /** checkpoint/result 只在 running 中续写（谓词式，断线恢复从已确认进度继续）。 */
  async recordStepCheckpoint(
    executionTarget: ExecutionTarget,
    stepRunId: string,
    checkpointRef: string | null,
    resultRef: string | null,
  ): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE step_runs
          SET checkpoint_ref=COALESCE($3, checkpoint_ref),
              result_ref=COALESCE($4, result_ref), updated_at=now()
        WHERE step_run_id=$1 AND execution_target=$2 AND status='running'`,
      [stepRunId, executionTarget, checkpointRef, resultRef],
    );
    return result.rowCount === 1;
  }

  async getStepRun(executionTarget: ExecutionTarget, stepRunId: string): Promise<StepRun | null> {
    const result = await this.pool.query<StepRunDbRow>(
      `SELECT ${STEP_RUN_COLUMNS} FROM step_runs WHERE step_run_id=$1 AND execution_target=$2`,
      [stepRunId, executionTarget],
    );
    return result.rows[0] ? stepRunFromDb(result.rows[0]) : null;
  }

  async listStepRunsByRun(executionTarget: ExecutionTarget, runId: string): Promise<StepRun[]> {
    const result = await this.pool.query<StepRunDbRow>(
      `SELECT ${STEP_RUN_COLUMNS} FROM step_runs
        WHERE execution_target=$1 AND run_id=$2
        ORDER BY created_at ASC`,
      [executionTarget, runId],
    );
    return result.rows.map(stepRunFromDb);
  }
}
