/**
 * DecisionTraceStore（期1-2）：decision_traces 的 typed store。
 *
 * 红线（design §19，migrations/0109 文件头）：**仅 append + 查询**。
 * 本文件不存在任何 UPDATE / DELETE 语句；Trace 解释原因，不成为状态真相，
 * 不能反向覆盖 TaskRun / Ledger 状态。查询按 subject（run / step / attempt /
 * correlation）走 0109 的四条 partial/组合索引，追加序（seq）回放。
 * 所有接口显式收 executionTarget 并过滤。
 */

import type { ExecutionTarget } from '../contracts/common.js';
import type { ReasonCode } from '../contracts/reason-codes.js';
import type {
  DecisionCandidate,
  DecisionOutcome,
  DecisionTrace,
  DecisionType,
  DecisionVersionRefs,
} from '../contracts/decision-trace.js';
import {
  ManagedAutomationStoreBase,
  toEpochMillis,
  type ManagedAutomationStoreOptions,
  type ManagedSchemaRequirement,
} from './store-base.js';

const DECISION_TRACE_REQUIREMENT: ManagedSchemaRequirement = {
  capability: 'managed_automation_decision_traces',
  sinceVersion: '0109_managed_automation_decision_traces',
  tables: new Map([
    ['decision_traces', new Set([
      'trace_id', 'execution_target', 'seq', 'correlation_id', 'causation_id',
      'versions', 'run_id', 'step_id', 'attempt_id', 'decision_type',
      'input_refs', 'candidates', 'outcome', 'reason_code', 'snapshot_refs', 'created_at',
    ])],
  ]),
  indexes: new Map([
    ['idx_decision_traces_target_run', 'decision_traces'],
    ['idx_decision_traces_target_step', 'decision_traces'],
    ['idx_decision_traces_target_attempt', 'decision_traces'],
    ['idx_decision_traces_target_correlation', 'decision_traces'],
  ]),
};

interface TraceDbRow {
  trace_id: string;
  execution_target: ExecutionTarget;
  correlation_id: string;
  causation_id: string | null;
  versions: DecisionVersionRefs;
  run_id: string | null;
  step_id: string | null;
  attempt_id: string | null;
  decision_type: DecisionType;
  input_refs: string[];
  candidates: DecisionCandidate[];
  outcome: DecisionOutcome;
  reason_code: ReasonCode;
  snapshot_refs: string[];
  created_at: Date | string;
}

function traceFromDb(row: TraceDbRow): DecisionTrace {
  return {
    traceId: row.trace_id,
    correlationId: row.correlation_id,
    causationId: row.causation_id,
    executionTarget: row.execution_target,
    versions: row.versions,
    runId: row.run_id,
    stepId: row.step_id,
    attemptId: row.attempt_id,
    decisionType: row.decision_type,
    inputRefs: row.input_refs,
    candidates: row.candidates,
    outcome: row.outcome,
    reasonCode: row.reason_code,
    snapshotRefs: row.snapshot_refs,
    createdAt: toEpochMillis(row.created_at),
  };
}

const TRACE_COLUMNS = `trace_id, execution_target, correlation_id, causation_id, versions,
  run_id, step_id, attempt_id, decision_type, input_refs, candidates, outcome, reason_code,
  snapshot_refs, created_at`;

export type DecisionTraceInsert = Omit<DecisionTrace, 'createdAt'>;

export class DecisionTraceStore extends ManagedAutomationStoreBase {
  constructor(options: ManagedAutomationStoreOptions) {
    super(DECISION_TRACE_REQUIREMENT, options);
  }

  /** 追加一条 Trace；trace_id 重放即忽略（append-only，无覆盖语义）。 */
  async append(executionTarget: ExecutionTarget, trace: DecisionTraceInsert): Promise<boolean> {
    const result = await this.pool.query(
      `INSERT INTO decision_traces (trace_id, execution_target, correlation_id, causation_id,
         versions, run_id, step_id, attempt_id, decision_type, input_refs, candidates,
         outcome, reason_code, snapshot_refs)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
       ON CONFLICT DO NOTHING`,
      [
        trace.traceId, executionTarget, trace.correlationId, trace.causationId,
        JSON.stringify(trace.versions), trace.runId, trace.stepId, trace.attemptId,
        trace.decisionType, JSON.stringify(trace.inputRefs), JSON.stringify(trace.candidates),
        trace.outcome, trace.reasonCode, JSON.stringify(trace.snapshotRefs),
      ],
    );
    return result.rowCount === 1;
  }

  async listByRun(executionTarget: ExecutionTarget, runId: string, limit = 200): Promise<DecisionTrace[]> {
    const result = await this.pool.query<TraceDbRow>(
      `SELECT ${TRACE_COLUMNS} FROM decision_traces
        WHERE execution_target=$1 AND run_id=$2
        ORDER BY seq ASC
        LIMIT $3`,
      [executionTarget, runId, limit],
    );
    return result.rows.map(traceFromDb);
  }

  async listByStep(executionTarget: ExecutionTarget, stepId: string, limit = 200): Promise<DecisionTrace[]> {
    const result = await this.pool.query<TraceDbRow>(
      `SELECT ${TRACE_COLUMNS} FROM decision_traces
        WHERE execution_target=$1 AND step_id=$2
        ORDER BY seq ASC
        LIMIT $3`,
      [executionTarget, stepId, limit],
    );
    return result.rows.map(traceFromDb);
  }

  async listByAttempt(executionTarget: ExecutionTarget, attemptId: string, limit = 200): Promise<DecisionTrace[]> {
    const result = await this.pool.query<TraceDbRow>(
      `SELECT ${TRACE_COLUMNS} FROM decision_traces
        WHERE execution_target=$1 AND attempt_id=$2
        ORDER BY seq ASC
        LIMIT $3`,
      [executionTarget, attemptId, limit],
    );
    return result.rows.map(traceFromDb);
  }

  async listByCorrelation(
    executionTarget: ExecutionTarget,
    correlationId: string,
    limit = 200,
  ): Promise<DecisionTrace[]> {
    const result = await this.pool.query<TraceDbRow>(
      `SELECT ${TRACE_COLUMNS} FROM decision_traces
        WHERE execution_target=$1 AND correlation_id=$2
        ORDER BY seq ASC
        LIMIT $3`,
      [executionTarget, correlationId, limit],
    );
    return result.rows.map(traceFromDb);
  }
}
