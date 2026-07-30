/**
 * 契约层 barrel：src/managed-automation/contracts/ 的统一出口。
 *
 * 全目录为纯类型契约 + 冻结字面数组 + 极少数纯归一函数，零运行时副作用。
 * 后续任务（store / 路由 / worker）从本入口 type-only 引入契约；
 * 逐态映射与 supersession map 见同目录 STATE-MAPPING.md。
 */

export * from './common.js';
export * from './reason-codes.js';
export * from './action-classification.js';
export * from './capability.js';
export * from './task.js';
export * from './task-run.js';
export * from './execution-plan.js';
export * from './execution-attempt.js';
export * from './plan.js';
export * from './decision-trace.js';
export * from './agent-intents.js';
export * from './session-mode.js';
