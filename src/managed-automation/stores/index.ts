/**
 * 托管自动化 typed stores（期1-2）：migrations/0106–0109 八张核心表的持久层出口。
 * 表 ↔ store 对应：
 *   tasks / task_revisions / execution_plans      → TaskAuthorityStore
 *   task_runs / step_runs                         → RunStateStore
 *   execution_intents / execution_attempts        → ExecutionLedgerStore
 *   decision_traces                               → DecisionTraceStore
 */

export {
  ManagedAutomationInvariantError,
  ManagedAutomationStoreBase,
  type ManagedAutomationStoreOptions,
  type ManagedSchemaRequirement,
} from './store-base.js';
export {
  TaskAuthorityStore,
  type ExecutionPlanInsert,
  type TaskInsert,
  type TaskRevisionInsert,
} from './task-authority-store.js';
export {
  RunStateStore,
  assertOrthogonalInvariants,
  type ClaimedTaskRun,
  type RunStateTransition,
  type StepRunInsert,
  type TaskRunInsert,
} from './run-state-store.js';
export {
  ExecutionLedgerStore,
  assertAttemptFieldCoupling,
  type AttemptTransition,
  type ExecutionAttemptInsert,
  type ExecutionIntentInsert,
  type IntentInsertResult,
} from './execution-ledger-store.js';
export {
  DecisionTraceStore,
  type DecisionTraceInsert,
} from './decision-trace-store.js';
