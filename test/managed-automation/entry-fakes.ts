/**
 * 期1-4 入口操作测试的内存 fakes：结构化满足 service/task-entry-service.ts 的
 * TaskAuthorityEntryPort / LedgerReadPort（RunState / DecisionTrace / PlanAuthority
 * 复用 engine-fakes.ts）。语义对齐真实 store：
 *   - createTask 是原子事务（task_id 命中既有行整体不落库，含创建修订）；
 *   - casSetTaskStatus 谓词式（expected 未命中返回 false）；
 *   - ledger 读侧按 (target, runId) / (target, intentId) 过滤。
 */

import type { ExecutionTarget } from '../../src/managed-automation/contracts/common.js';
import type { Task, TaskRevision } from '../../src/managed-automation/contracts/task.js';
import type { TaskLifecycleStatus } from '../../src/managed-automation/contracts/task.js';
import type {
  ExecutionAttempt,
  ExecutionIntent,
} from '../../src/managed-automation/contracts/execution-attempt.js';
import type {
  TaskInsert,
  TaskRevisionInsert,
} from '../../src/managed-automation/stores/index.js';
import type {
  LedgerReadPort,
  TaskAuthorityEntryPort,
} from '../../src/managed-automation/service/index.js';

export class InMemoryTaskAuthority implements TaskAuthorityEntryPort {
  private readonly tasks = new Map<string, Task>();
  /** 测试断言用：创建修订按写入序保留。 */
  readonly revisions: TaskRevision[] = [];

  constructor(private readonly now: () => number = Date.now) {}

  private key(target: ExecutionTarget, taskId: string): string {
    return `${target}|${taskId}`;
  }

  async createTask(
    executionTarget: ExecutionTarget,
    task: TaskInsert,
    creationRevision: TaskRevisionInsert,
  ): Promise<boolean> {
    if (this.tasks.has(this.key(executionTarget, task.taskId))) return false;
    this.tasks.set(this.key(executionTarget, task.taskId), structuredClone({
      ...task,
      executionTarget,
      aggregateVersion: 1,
      createdAt: this.now(),
      updatedAt: this.now(),
    }));
    this.revisions.push(structuredClone({ ...creationRevision, executionTarget, createdAt: this.now() }));
    return true;
  }

  async casSetTaskStatus(
    executionTarget: ExecutionTarget,
    taskId: string,
    expectedStatus: TaskLifecycleStatus,
    nextStatus: TaskLifecycleStatus,
  ): Promise<boolean> {
    const task = this.tasks.get(this.key(executionTarget, taskId));
    if (!task || task.status !== expectedStatus) return false;
    task.status = nextStatus;
    task.aggregateVersion += 1;
    task.updatedAt = this.now();
    return true;
  }

  async getTask(executionTarget: ExecutionTarget, taskId: string): Promise<Task | null> {
    const task = this.tasks.get(this.key(executionTarget, taskId));
    return task ? structuredClone(task) : null;
  }
}

/** 可播种的 ledger 读侧（期1-4 入口只读投影用；写侧属 worker/引擎，不在此仿真）。 */
export class InMemoryLedgerRead implements LedgerReadPort {
  readonly intents: ExecutionIntent[] = [];
  readonly attempts: ExecutionAttempt[] = [];

  async listIntentsByRun(executionTarget: ExecutionTarget, runId: string): Promise<ExecutionIntent[]> {
    return this.intents
      .filter((intent) => intent.executionTarget === executionTarget && intent.runId === runId)
      .map((intent) => structuredClone(intent));
  }

  async listAttemptsByIntent(executionTarget: ExecutionTarget, intentId: string): Promise<ExecutionAttempt[]> {
    return this.attempts
      .filter((attempt) => attempt.executionTarget === executionTarget && attempt.intentId === intentId)
      .sort((a, b) => a.ordinal - b.ordinal)
      .map((attempt) => structuredClone(attempt));
  }
}
