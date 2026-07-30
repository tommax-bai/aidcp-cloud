/**
 * 服务层（期1-4）出口：三入口操作（Create/Cancel/Query）。
 * 只经 stores/ 的 typed store 读写持久状态（见 task-entry-service.ts 的 Pick<> 端口），
 * 编译复用 engine/PlanCompiler，不重复实现校验。ReviseTask 期3 实现（契约已预留）。
 */

export {
  TaskEntryService,
  type AccountBindingResolution,
  type AccountBindingResolver,
  type CancelTaskAccepted,
  type CancelTaskRejected,
  type CancelTaskResult,
  type CreateTaskAccepted,
  type CreateTaskRejected,
  type CreateTaskResult,
  type DecisionTraceEntryPort,
  type EntryRejected,
  type LedgerReadPort,
  type PlanCompilerPort,
  type QueryTaskResult,
  type RunStateEntryPort,
  type TaskAuthorityEntryPort,
  type TaskDefinitionResolver,
  type TaskEntryServiceDeps,
} from './task-entry-service.js';
