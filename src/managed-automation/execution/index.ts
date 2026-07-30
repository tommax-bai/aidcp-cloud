/**
 * 执行层（期1-6）出口：ResearchStepExecutor（StepExecutor 实现）与其
 * EdgeDispatchPort（端口 + 适配器；真实 comm 适配器期1 收缩为接线说明，
 * 见 comm-edge-dispatch-adapter.ts）。
 */

export type {
  EdgeDispatchOptions,
  EdgeDispatchOutcome,
  EdgeDispatchPort,
  ReadOnlyEdgeCommand,
} from './edge-dispatch-port.js';
export {
  ResearchStepExecutor,
  type ResearchStepExecutorDeps,
  type StepTracePort,
  type TaskReadPort,
} from './research-step-executor.js';
export type { CommEdgeDispatchWiring } from './comm-edge-dispatch-adapter.js';
