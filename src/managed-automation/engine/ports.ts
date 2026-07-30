/**
 * 引擎层（期1-5）：对期1-2 typed stores 的**结构化端口**。
 *
 * 引擎只通过这些端口读写持久状态（任务硬性要求：不绕过 store 直写 SQL）。
 * 用 Pick<真实 store 类> 而不是手抄接口：方法签名的唯一事实源仍是 stores/，
 * store 层演进时这里编译期同步；测试侧用内存 fake 结构化满足同一端口，
 * 真实 PG 语义已由 stores-pg.integration.test.ts 盖住，引擎测试不重复建库。
 *
 * 纪律：本文件只做 type-only 引用，不 new 任何 store，不持任何活状态。
 */

import type { RunStateStore } from '../stores/run-state-store.js';
import type { TaskAuthorityStore } from '../stores/task-authority-store.js';
import type { DecisionTraceStore } from '../stores/decision-trace-store.js';

/** worker 全部运行面：入队、认领/租约、CAS 迁移、进度检查点、StepRun 读写。 */
export type RunStatePort = Pick<
  RunStateStore,
  | 'insertRun'
  | 'claimNextQueued'
  | 'renewLease'
  | 'reclaimExpiredLeases'
  | 'transitionRun'
  | 'recordRunProgress'
  | 'getRun'
  | 'listRunsByStatus'
  | 'insertStepRun'
  | 'transitionStep'
  | 'recordStepCheckpoint'
  | 'listStepRunsByRun'
>;

/** 编译器落库面（不可变 INSERT）+ worker 读回编译产物。 */
export type PlanAuthorityPort = Pick<TaskAuthorityStore, 'insertExecutionPlan' | 'getExecutionPlan'>;

/** Decision Trace 仅 append（红线：Trace 不覆盖运行状态）。 */
export type DecisionTracePort = Pick<DecisionTraceStore, 'append'>;
