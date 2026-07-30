/**
 * TaskAuthorityStore（期1-2）：tasks / task_revisions / execution_plans 三张授权面表的 typed store。
 *
 * 纪律（任务硬性要求 + design §4.4/§4.5）：
 *   - 状态迁移一律 CAS 谓词式 UPDATE（WHERE 校验当前态与 aggregate_version），返回是否命中；
 *   - task_revisions / execution_plans 行**不可变**：只有 INSERT 与 SELECT，本文件不存在
 *     针对这两张表的 UPDATE/DELETE 语句；Revise = 追加新修订行 + CAS 推进 tasks.current_revision_id；
 *   - 所有接口显式收 executionTarget 并在谓词里过滤（CLAUDE.md §2）；
 *   - store 不做业务决策：不校验授权语义、不编译 plan，只保证持久化不变式。
 */

import type { PlatformId } from '../../kernel/platform-types.js';
import type { ExecutionTarget, ScheduleWindow, StructuredConstraints } from '../contracts/common.js';
import type { ActionDomainAuthorization } from '../contracts/action-classification.js';
import type {
  CapabilityScope,
  Task,
  TaskBudgets,
  TaskLifecycleStatus,
  TaskRevision,
  TaskRevisionCause,
} from '../contracts/task.js';
import type {
  ExecutionPlan,
  ExecutionPlanBounds,
  ExecutionPlanEdge,
  ExecutionPlanNode,
} from '../contracts/execution-plan.js';
import {
  ManagedAutomationStoreBase,
  toEpochMillis,
  type ManagedAutomationStoreOptions,
  type ManagedSchemaRequirement,
} from './store-base.js';

const TASK_AUTHORITY_REQUIREMENT: ManagedSchemaRequirement = {
  capability: 'managed_automation_task_authority',
  sinceVersion: '0106_managed_automation_task_authority',
  tables: new Map([
    ['tasks', new Set([
      'task_id', 'execution_target', 'plan_id', 'cycle_id', 'account_id', 'env_key',
      'platform', 'task_definition_id', 'task_definition_version', 'current_revision_id',
      'capability_scope', 'action_authorization', 'constraints', 'budgets', 'schedule',
      'completion_condition_ref', 'status', 'conversation_message_id', 'correlation_id',
      'aggregate_version', 'created_at', 'updated_at',
    ])],
    ['task_revisions', new Set([
      'revision_id', 'execution_target', 'task_id', 'revision_ordinal', 'cause',
      'capability_scope', 'action_authorization', 'constraints', 'budgets', 'schedule',
      'authorization_ref', 'supersedes_revision_id', 'proposal_ref', 'created_at',
    ])],
    ['execution_plans', new Set([
      'execution_plan_id', 'execution_target', 'task_id', 'task_revision_id',
      'task_definition_id', 'task_definition_version', 'plan_id', 'plan_version',
      'authorization_ref', 'nodes', 'edges', 'entry_node_id', 'bounds',
      'completion_condition_ref', 'compiled_at',
    ])],
  ]),
  indexes: new Map([
    ['idx_tasks_target_status', 'tasks'],
    ['idx_tasks_target_account', 'tasks'],
    ['uq_task_revisions_target_task_ordinal', 'task_revisions'],
    ['idx_execution_plans_target_task', 'execution_plans'],
    ['idx_execution_plans_target_revision', 'execution_plans'],
  ]),
};

interface TaskDbRow {
  task_id: string;
  execution_target: ExecutionTarget;
  plan_id: string | null;
  cycle_id: string | null;
  account_id: string;
  env_key: string;
  platform: string;
  task_definition_id: string;
  task_definition_version: number;
  current_revision_id: string;
  capability_scope: CapabilityScope;
  action_authorization: ActionDomainAuthorization;
  constraints: StructuredConstraints;
  budgets: TaskBudgets;
  schedule: ScheduleWindow;
  completion_condition_ref: string;
  status: TaskLifecycleStatus;
  conversation_message_id: string | null;
  correlation_id: string;
  aggregate_version: number;
  created_at: Date | string;
  updated_at: Date | string;
}

interface TaskRevisionDbRow {
  revision_id: string;
  execution_target: ExecutionTarget;
  task_id: string;
  revision_ordinal: number;
  cause: TaskRevisionCause;
  capability_scope: CapabilityScope;
  action_authorization: ActionDomainAuthorization;
  constraints: StructuredConstraints;
  budgets: TaskBudgets;
  schedule: ScheduleWindow;
  authorization_ref: string;
  supersedes_revision_id: string | null;
  proposal_ref: string | null;
  created_at: Date | string;
}

interface ExecutionPlanDbRow {
  execution_plan_id: string;
  execution_target: ExecutionTarget;
  task_id: string;
  task_revision_id: string;
  task_definition_id: string;
  task_definition_version: number;
  plan_id: string | null;
  plan_version: number | null;
  authorization_ref: string;
  nodes: ExecutionPlanNode[];
  edges: ExecutionPlanEdge[];
  entry_node_id: string;
  bounds: ExecutionPlanBounds;
  completion_condition_ref: string;
  compiled_at: Date | string;
}

function taskFromDb(row: TaskDbRow): Task {
  return {
    taskId: row.task_id,
    executionTarget: row.execution_target,
    planId: row.plan_id,
    cycleId: row.cycle_id,
    accountId: row.account_id,
    envKey: row.env_key,
    platform: row.platform as PlatformId,
    taskDefinitionId: row.task_definition_id,
    taskDefinitionVersion: Number(row.task_definition_version),
    currentRevisionId: row.current_revision_id,
    capabilityScope: row.capability_scope,
    actionAuthorization: row.action_authorization,
    constraints: row.constraints,
    budgets: row.budgets,
    schedule: row.schedule,
    completionConditionRef: row.completion_condition_ref,
    status: row.status,
    conversationMessageId: row.conversation_message_id,
    correlationId: row.correlation_id,
    aggregateVersion: Number(row.aggregate_version),
    createdAt: toEpochMillis(row.created_at),
    updatedAt: toEpochMillis(row.updated_at),
  };
}

function revisionFromDb(row: TaskRevisionDbRow): TaskRevision {
  return {
    revisionId: row.revision_id,
    taskId: row.task_id,
    executionTarget: row.execution_target,
    revisionOrdinal: Number(row.revision_ordinal),
    cause: row.cause,
    capabilityScope: row.capability_scope,
    actionAuthorization: row.action_authorization,
    constraints: row.constraints,
    budgets: row.budgets,
    schedule: row.schedule,
    authorizationRef: row.authorization_ref,
    supersedesRevisionId: row.supersedes_revision_id,
    proposalRef: row.proposal_ref,
    createdAt: toEpochMillis(row.created_at),
  };
}

function planFromDb(row: ExecutionPlanDbRow): ExecutionPlan {
  return {
    executionPlanId: row.execution_plan_id,
    taskId: row.task_id,
    taskRevisionId: row.task_revision_id,
    executionTarget: row.execution_target,
    taskDefinitionId: row.task_definition_id,
    taskDefinitionVersion: Number(row.task_definition_version),
    planId: row.plan_id,
    planVersion: row.plan_version === null ? null : Number(row.plan_version),
    authorizationRef: row.authorization_ref,
    nodes: row.nodes,
    edges: row.edges,
    entryNodeId: row.entry_node_id,
    bounds: row.bounds,
    completionConditionRef: row.completion_condition_ref,
    compiledAt: toEpochMillis(row.compiled_at),
  };
}

const TASK_COLUMNS = `task_id, execution_target, plan_id, cycle_id, account_id, env_key,
  platform, task_definition_id, task_definition_version, current_revision_id,
  capability_scope, action_authorization, constraints, budgets, schedule,
  completion_condition_ref, status, conversation_message_id, correlation_id,
  aggregate_version, created_at, updated_at`;

const REVISION_COLUMNS = `revision_id, execution_target, task_id, revision_ordinal, cause,
  capability_scope, action_authorization, constraints, budgets, schedule,
  authorization_ref, supersedes_revision_id, proposal_ref, created_at`;

const PLAN_COLUMNS = `execution_plan_id, execution_target, task_id, task_revision_id,
  task_definition_id, task_definition_version, plan_id, plan_version, authorization_ref,
  nodes, edges, entry_node_id, bounds, completion_condition_ref, compiled_at`;

/** 创建输入：Task 的持久字段（时间戳/aggregateVersion 由库侧默认）。 */
export type TaskInsert = Omit<Task, 'aggregateVersion' | 'createdAt' | 'updatedAt'>;
export type TaskRevisionInsert = Omit<TaskRevision, 'createdAt'>;
export type ExecutionPlanInsert = Omit<ExecutionPlan, 'compiledAt'>;

export class TaskAuthorityStore extends ManagedAutomationStoreBase {
  constructor(options: ManagedAutomationStoreOptions) {
    super(TASK_AUTHORITY_REQUIREMENT, options);
  }

  /**
   * 创建 Task + 其创建修订（revisionOrdinal=1），同事务原子落库。
   * task_id 已存在时不覆盖（幂等重放安全），返回 false。
   */
  async createTask(
    executionTarget: ExecutionTarget,
    task: TaskInsert,
    creationRevision: TaskRevisionInsert,
  ): Promise<boolean> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const inserted = await client.query(
        `INSERT INTO tasks (task_id, execution_target, plan_id, cycle_id, account_id, env_key,
           platform, task_definition_id, task_definition_version, current_revision_id,
           capability_scope, action_authorization, constraints, budgets, schedule,
           completion_condition_ref, status, conversation_message_id, correlation_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
         ON CONFLICT (task_id) DO NOTHING`,
        [
          task.taskId, executionTarget, task.planId, task.cycleId, task.accountId, task.envKey,
          task.platform, task.taskDefinitionId, task.taskDefinitionVersion, task.currentRevisionId,
          JSON.stringify(task.capabilityScope), JSON.stringify(task.actionAuthorization),
          JSON.stringify(task.constraints), JSON.stringify(task.budgets), JSON.stringify(task.schedule),
          task.completionConditionRef, task.status, task.conversationMessageId, task.correlationId,
        ],
      );
      if (inserted.rowCount !== 1) {
        await client.query('ROLLBACK');
        return false;
      }
      await this.insertRevisionWith(client, executionTarget, creationRevision);
      await client.query('COMMIT');
      return true;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * 追加不可变修订并 CAS 推进 tasks.current_revision_id。
   * WHERE 校验「当前修订还是调用方看到的那个」——并发 Revise 只有一个赢家，输家收 false。
   */
  async appendRevision(
    executionTarget: ExecutionTarget,
    revision: TaskRevisionInsert,
    expectedCurrentRevisionId: string,
  ): Promise<boolean> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const advanced = await client.query(
        `UPDATE tasks
            SET current_revision_id=$4, aggregate_version=aggregate_version+1, updated_at=now()
          WHERE task_id=$1 AND execution_target=$2 AND current_revision_id=$3`,
        [revision.taskId, executionTarget, expectedCurrentRevisionId, revision.revisionId],
      );
      if (advanced.rowCount !== 1) {
        await client.query('ROLLBACK');
        return false;
      }
      await this.insertRevisionWith(client, executionTarget, revision);
      await client.query('COMMIT');
      return true;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  /** 生命周期 CAS：仅当当前 status 等于 expectedStatus 时迁移，返回是否命中。 */
  async casSetTaskStatus(
    executionTarget: ExecutionTarget,
    taskId: string,
    expectedStatus: TaskLifecycleStatus,
    nextStatus: TaskLifecycleStatus,
  ): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE tasks
          SET status=$4, aggregate_version=aggregate_version+1, updated_at=now()
        WHERE task_id=$1 AND execution_target=$2 AND status=$3`,
      [taskId, executionTarget, expectedStatus, nextStatus],
    );
    return result.rowCount === 1;
  }

  async getTask(executionTarget: ExecutionTarget, taskId: string): Promise<Task | null> {
    const result = await this.pool.query<TaskDbRow>(
      `SELECT ${TASK_COLUMNS} FROM tasks WHERE task_id=$1 AND execution_target=$2`,
      [taskId, executionTarget],
    );
    return result.rows[0] ? taskFromDb(result.rows[0]) : null;
  }

  async listTasksByStatus(
    executionTarget: ExecutionTarget,
    status: TaskLifecycleStatus,
    limit = 100,
  ): Promise<Task[]> {
    const result = await this.pool.query<TaskDbRow>(
      `SELECT ${TASK_COLUMNS} FROM tasks
        WHERE execution_target=$1 AND status=$2
        ORDER BY created_at ASC
        LIMIT $3`,
      [executionTarget, status, limit],
    );
    return result.rows.map(taskFromDb);
  }

  async listRevisions(executionTarget: ExecutionTarget, taskId: string): Promise<TaskRevision[]> {
    const result = await this.pool.query<TaskRevisionDbRow>(
      `SELECT ${REVISION_COLUMNS} FROM task_revisions
        WHERE execution_target=$1 AND task_id=$2
        ORDER BY revision_ordinal ASC`,
      [executionTarget, taskId],
    );
    return result.rows.map(revisionFromDb);
  }

  /** 不可变编译产物：只 INSERT；execution_plan_id 冲突时不覆盖，返回 false。 */
  async insertExecutionPlan(
    executionTarget: ExecutionTarget,
    plan: ExecutionPlanInsert,
  ): Promise<boolean> {
    const result = await this.pool.query(
      `INSERT INTO execution_plans (execution_plan_id, execution_target, task_id, task_revision_id,
         task_definition_id, task_definition_version, plan_id, plan_version, authorization_ref,
         nodes, edges, entry_node_id, bounds, completion_condition_ref)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
       ON CONFLICT (execution_plan_id) DO NOTHING`,
      [
        plan.executionPlanId, executionTarget, plan.taskId, plan.taskRevisionId,
        plan.taskDefinitionId, plan.taskDefinitionVersion, plan.planId, plan.planVersion,
        plan.authorizationRef, JSON.stringify(plan.nodes), JSON.stringify(plan.edges),
        plan.entryNodeId, JSON.stringify(plan.bounds), plan.completionConditionRef,
      ],
    );
    return result.rowCount === 1;
  }

  async getExecutionPlan(
    executionTarget: ExecutionTarget,
    executionPlanId: string,
  ): Promise<ExecutionPlan | null> {
    const result = await this.pool.query<ExecutionPlanDbRow>(
      `SELECT ${PLAN_COLUMNS} FROM execution_plans
        WHERE execution_plan_id=$1 AND execution_target=$2`,
      [executionPlanId, executionTarget],
    );
    return result.rows[0] ? planFromDb(result.rows[0]) : null;
  }

  async listExecutionPlansByTask(
    executionTarget: ExecutionTarget,
    taskId: string,
  ): Promise<ExecutionPlan[]> {
    const result = await this.pool.query<ExecutionPlanDbRow>(
      `SELECT ${PLAN_COLUMNS} FROM execution_plans
        WHERE execution_target=$1 AND task_id=$2
        ORDER BY compiled_at ASC`,
      [executionTarget, taskId],
    );
    return result.rows.map(planFromDb);
  }

  private async insertRevisionWith(
    client: { query(text: string, values?: unknown[]): Promise<unknown> },
    executionTarget: ExecutionTarget,
    revision: TaskRevisionInsert,
  ): Promise<void> {
    await client.query(
      `INSERT INTO task_revisions (revision_id, execution_target, task_id, revision_ordinal, cause,
         capability_scope, action_authorization, constraints, budgets, schedule,
         authorization_ref, supersedes_revision_id, proposal_ref)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [
        revision.revisionId, executionTarget, revision.taskId, revision.revisionOrdinal, revision.cause,
        JSON.stringify(revision.capabilityScope), JSON.stringify(revision.actionAuthorization),
        JSON.stringify(revision.constraints), JSON.stringify(revision.budgets),
        JSON.stringify(revision.schedule), revision.authorizationRef,
        revision.supersedesRevisionId, revision.proposalRef,
      ],
    );
  }
}
