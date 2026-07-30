/**
 * 引擎层（期1-5）出口：线性 Plan Compiler + TaskRun 队列 worker + StepRun 执行器接口。
 * 引擎只经 stores/ 的 typed store 读写持久状态（见 ports.ts），不直写 SQL。
 */

export type { DecisionTracePort, PlanAuthorityPort, RunStatePort } from './ports.js';
export { resolveLinearChain, type LinearChainResult, type LinearChainViolation } from './linear-graph.js';
export {
  PlanCompileError,
  PlanCompiler,
  type CapabilityResolver,
  type CompilePlanRequest,
  type PlanCompilerDeps,
} from './plan-compiler.js';
export type { StepExecutionContext, StepExecutionResult, StepExecutor } from './step-executor.js';
export {
  MANAGED_AUTOMATION_WORKER_ENV,
  TaskRunWorker,
  aggregateRunOutcome,
  isManagedAutomationWorkerEnabled,
  type StepOutcomeRecord,
  type TaskRunWorkerDeps,
} from './task-run-worker.js';
