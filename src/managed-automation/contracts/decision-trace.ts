/**
 * 契约层：Decision Trace —— 解释原因，但不成为状态真相（design §19，policy spec）。
 *
 * Trigger、ManagedCycle、Task Runtime、Arbiter、Policy-Risk、Ledger 与 Reconciler
 * 在创建/选择/准入/延迟/拒绝/跳过/取代/派发/对账等重要决策处追加 Trace。
 * 红线：Trace 不能反向覆盖 TaskRun/Ledger 状态；删除 Trace 也不能让平台结果消失。
 * 敏感原文尽量保存引用、哈希和必要摘要（design §22 分层授权与保留期）。
 */

import type { EpochMillis, ExecutionTarget } from './common.js';
import type { ReasonCode } from './reason-codes.js';

/** 决策点类别（policy spec 枚举的九类决策）。 */
export type DecisionType =
  | 'creation'
  | 'selection'
  | 'admission'
  | 'delay'
  | 'denial'
  | 'skip'
  | 'supersession'
  | 'dispatch'
  | 'reconciliation';

export const DECISION_TYPES = [
  'creation',
  'selection',
  'admission',
  'delay',
  'denial',
  'skip',
  'supersession',
  'dispatch',
  'reconciliation',
] as const satisfies readonly DecisionType[];

/** 决策结论（design §19 逐字冻结）。 */
export type DecisionOutcome = 'selected' | 'allowed' | 'denied' | 'delayed' | 'skipped' | 'superseded';

export const DECISION_OUTCOMES = [
  'selected',
  'allowed',
  'denied',
  'delayed',
  'skipped',
  'superseded',
] as const satisfies readonly DecisionOutcome[];

/** 决策时相关版本引用块（design §19：planVersion / taskDefinitionVersion / personaVersion 等）。 */
export interface DecisionVersionRefs {
  planVersion: number | null;
  taskDefinitionVersion: number | null;
  personaVersion: string | null;
  policyRevision: string | null;
  approvalRevision: string | null;
}

/** 被评估的候选项（candidates or evaluated alternatives，design §19）。 */
export interface DecisionCandidate {
  /** 候选标识（目标内容 ID、work 项 ID 等）。 */
  candidateRef: string;
  /** 该候选被选中/被淘汰的原因码。 */
  reasonCode: ReasonCode | null;
  selected: boolean;
}

/** design §19 字段清单逐字冻结（快照存引用不存原文）。 */
export interface DecisionTrace {
  traceId: string;
  correlationId: string;
  causationId: string | null;
  executionTarget: ExecutionTarget;
  versions: DecisionVersionRefs;
  /** 受影响的运行对象（按决策层级可空）。 */
  runId: string | null;
  stepId: string | null;
  attemptId: string | null;
  decisionType: DecisionType;
  /** 输入引用（不复制敏感原文，存稳定引用/哈希）。 */
  inputRefs: string[];
  candidates: DecisionCandidate[];
  outcome: DecisionOutcome;
  reasonCode: ReasonCode;
  /** policy/risk/budget 快照引用（design §19）。 */
  snapshotRefs: string[];
  createdAt: EpochMillis;
}
