/**
 * ExecutionLedgerStore（期1-2）：execution_intents / execution_attempts 的 typed store。
 *
 * 纪律（design §11/§12，ledger spec，contracts/execution-attempt.ts 文件头状态机）：
 *   - intent **不可变**：只 INSERT/SELECT；业务幂等键命中既有 intent 时返回既有行，
 *     绝不产生第二个平台动作（红线）；
 *   - Attempt 状态迁移一律 CAS 谓词式 UPDATE（WHERE 校验当前 status）；
 *     字段耦合不变式在 store 层先断言（confirmedNotAppliedKind ⇔ status='confirmed_not_applied'；
 *     nonStartReason 仅 blocked/cancelled），库侧 CHECK 兜底；
 *   - submitted_unknown 只允许 Reconciler 改判（reconcile* 接口），普通迁移接口不受理该起点；
 *   - 所有接口显式收 executionTarget 并过滤。
 */

import type { ExecutionTarget, MissPolicy } from '../contracts/common.js';
import type { ActionDomain, ActionExecutionClass } from '../contracts/action-classification.js';
import type { AttemptNonStartReason, ReasonCode } from '../contracts/reason-codes.js';
import type { CapabilityId } from '../contracts/capability.js';
import type {
  ConfirmedNotAppliedKind,
  ExecutionAttempt,
  ExecutionAttemptStatus,
  ExecutionIntent,
} from '../contracts/execution-attempt.js';
import {
  ManagedAutomationInvariantError,
  ManagedAutomationStoreBase,
  toEpochMillis,
  toNullableEpochMillis,
  type ManagedAutomationStoreOptions,
  type ManagedSchemaRequirement,
} from './store-base.js';

const EXECUTION_LEDGER_REQUIREMENT: ManagedSchemaRequirement = {
  capability: 'managed_automation_execution_ledger',
  sinceVersion: '0108_managed_automation_execution_ledger',
  tables: new Map([
    ['execution_intents', new Set([
      'intent_id', 'execution_target', 'account_id', 'env_key', 'binding_revision',
      'action_type', 'action_domain', 'execution_class', 'target_stable_id',
      'content_version', 'approval_revision', 'scheduled_at', 'latest_start_at',
      'miss_policy', 'required_capability', 'protocol_version', 'idempotency_key',
      'correlation_id', 'run_id', 'step_id', 'created_at',
    ])],
    ['execution_attempts', new Set([
      'attempt_id', 'execution_target', 'intent_id', 'run_id', 'step_id', 'ordinal',
      'status', 'non_start_reason', 'confirmed_not_applied_kind', 'reason_code',
      'evidence_ref', 'strongest_progress_evidence_ref', 'reconciliation_count',
      'prepared_at', 'dispatched_at', 'settled_at',
    ])],
  ]),
  indexes: new Map([
    ['uq_execution_intents_target_idempotency', 'execution_intents'],
    ['idx_execution_intents_target_run', 'execution_intents'],
    ['uq_execution_attempts_intent_ordinal', 'execution_attempts'],
    ['idx_execution_attempts_target_status', 'execution_attempts'],
    ['idx_execution_attempts_target_run', 'execution_attempts'],
  ]),
};

/** Attempt 字段耦合不变式的唯一校验点。违规即抛，绝不落库。 */
export function assertAttemptFieldCoupling(state: {
  status: ExecutionAttemptStatus;
  nonStartReason: AttemptNonStartReason | null;
  confirmedNotAppliedKind: ConfirmedNotAppliedKind | null;
}): void {
  if ((state.confirmedNotAppliedKind !== null) !== (state.status === 'confirmed_not_applied')) {
    throw new ManagedAutomationInvariantError(
      `confirmedNotAppliedKind 非空 ⇔ status='confirmed_not_applied' 被违反`
      + `（status=${state.status}, kind=${state.confirmedNotAppliedKind}）`,
    );
  }
  if (state.nonStartReason !== null && state.status !== 'blocked' && state.status !== 'cancelled') {
    throw new ManagedAutomationInvariantError(
      `nonStartReason 仅派发前状态（blocked/cancelled）可携带（status=${state.status}）`,
    );
  }
}

interface IntentDbRow {
  intent_id: string;
  execution_target: ExecutionTarget;
  account_id: string;
  env_key: string;
  binding_revision: string;
  action_type: string;
  action_domain: ActionDomain;
  execution_class: ActionExecutionClass;
  target_stable_id: string | null;
  content_version: string | null;
  approval_revision: string | null;
  scheduled_at: Date | string;
  latest_start_at: Date | string;
  miss_policy: MissPolicy;
  required_capability: string;
  protocol_version: string;
  idempotency_key: string;
  correlation_id: string;
  run_id: string;
  step_id: string;
  created_at: Date | string;
}

interface AttemptDbRow {
  attempt_id: string;
  execution_target: ExecutionTarget;
  intent_id: string;
  run_id: string;
  step_id: string;
  ordinal: number;
  status: ExecutionAttemptStatus;
  non_start_reason: AttemptNonStartReason | null;
  confirmed_not_applied_kind: ConfirmedNotAppliedKind | null;
  reason_code: ReasonCode | null;
  evidence_ref: string | null;
  strongest_progress_evidence_ref: string | null;
  reconciliation_count: number;
  prepared_at: Date | string;
  dispatched_at: Date | string | null;
  settled_at: Date | string | null;
}

function intentFromDb(row: IntentDbRow): ExecutionIntent {
  return {
    intentId: row.intent_id,
    accountId: row.account_id,
    envKey: row.env_key,
    executionTarget: row.execution_target,
    bindingRevision: row.binding_revision,
    actionType: row.action_type as CapabilityId,
    actionDomain: row.action_domain,
    executionClass: row.execution_class,
    targetStableId: row.target_stable_id,
    contentVersion: row.content_version,
    approvalRevision: row.approval_revision,
    scheduledAt: toEpochMillis(row.scheduled_at),
    latestStartAt: toEpochMillis(row.latest_start_at),
    missPolicy: row.miss_policy,
    requiredCapability: row.required_capability as CapabilityId,
    protocolVersion: row.protocol_version,
    idempotencyKey: row.idempotency_key,
    correlationId: row.correlation_id,
    runId: row.run_id,
    stepId: row.step_id,
    createdAt: toEpochMillis(row.created_at),
  };
}

function attemptFromDb(row: AttemptDbRow): ExecutionAttempt {
  return {
    attemptId: row.attempt_id,
    intentId: row.intent_id,
    runId: row.run_id,
    stepId: row.step_id,
    executionTarget: row.execution_target,
    ordinal: Number(row.ordinal),
    status: row.status,
    nonStartReason: row.non_start_reason,
    confirmedNotAppliedKind: row.confirmed_not_applied_kind,
    reasonCode: row.reason_code,
    evidenceRef: row.evidence_ref,
    strongestProgressEvidenceRef: row.strongest_progress_evidence_ref,
    reconciliationCount: Number(row.reconciliation_count),
    preparedAt: toEpochMillis(row.prepared_at),
    dispatchedAt: toNullableEpochMillis(row.dispatched_at),
    settledAt: toNullableEpochMillis(row.settled_at),
  };
}

const INTENT_COLUMNS = `intent_id, execution_target, account_id, env_key, binding_revision,
  action_type, action_domain, execution_class, target_stable_id, content_version,
  approval_revision, scheduled_at, latest_start_at, miss_policy, required_capability,
  protocol_version, idempotency_key, correlation_id, run_id, step_id, created_at`;

const ATTEMPT_COLUMNS = `attempt_id, execution_target, intent_id, run_id, step_id, ordinal,
  status, non_start_reason, confirmed_not_applied_kind, reason_code, evidence_ref,
  strongest_progress_evidence_ref, reconciliation_count, prepared_at, dispatched_at, settled_at`;

export type ExecutionIntentInsert = Omit<ExecutionIntent, 'createdAt'>;

/** Attempt 创建输入：一律从 prepared 起步（状态机入口唯一）。 */
export interface ExecutionAttemptInsert {
  attemptId: string;
  intentId: string;
  runId: string;
  stepId: string;
  ordinal: number;
}

/** CAS 迁移的目标状态与随附证据字段。 */
export interface AttemptTransition {
  status: ExecutionAttemptStatus;
  nonStartReason?: AttemptNonStartReason | null;
  confirmedNotAppliedKind?: ConfirmedNotAppliedKind | null;
  reasonCode?: ReasonCode | null;
  evidenceRef?: string | null;
  strongestProgressEvidenceRef?: string | null;
}

export interface IntentInsertResult {
  /** true = 新建；false = 业务幂等键命中既有 intent，intent 即那一行（红线：不建第二个）。 */
  created: boolean;
  intent: ExecutionIntent;
}

/** 落定后不再迁移的状态（submitted_unknown 除外——只有 Reconciler 可改判）。 */
const SETTLED_STATUSES: readonly ExecutionAttemptStatus[] = [
  'blocked', 'cancelled', 'platform_confirmed', 'confirmed_not_applied',
  'accepted_pending', 'held_for_moderation', 'precondition_already_satisfied',
];

export class ExecutionLedgerStore extends ManagedAutomationStoreBase {
  constructor(options: ManagedAutomationStoreOptions) {
    super(EXECUTION_LEDGER_REQUIREMENT, options);
  }

  // —— execution_intents（不可变） ——

  /**
   * 建 intent：同 target 下业务幂等键命中既有行时不建第二个，返回既有 intent
   * （Ledger 幂等红线，唯一索引 uq_execution_intents_target_idempotency 兜底）。
   */
  async insertIntent(
    executionTarget: ExecutionTarget,
    intent: ExecutionIntentInsert,
  ): Promise<IntentInsertResult> {
    const inserted = await this.pool.query<IntentDbRow>(
      `INSERT INTO execution_intents (intent_id, execution_target, account_id, env_key,
         binding_revision, action_type, action_domain, execution_class, target_stable_id,
         content_version, approval_revision, scheduled_at, latest_start_at, miss_policy,
         required_capability, protocol_version, idempotency_key, correlation_id, run_id, step_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,to_timestamp($12::double precision / 1000),
               to_timestamp($13::double precision / 1000),$14,$15,$16,$17,$18,$19,$20)
       ON CONFLICT DO NOTHING
       RETURNING ${INTENT_COLUMNS}`,
      [
        intent.intentId, executionTarget, intent.accountId, intent.envKey,
        intent.bindingRevision, intent.actionType, intent.actionDomain, intent.executionClass,
        intent.targetStableId, intent.contentVersion, intent.approvalRevision,
        intent.scheduledAt, intent.latestStartAt, intent.missPolicy,
        intent.requiredCapability, intent.protocolVersion, intent.idempotencyKey,
        intent.correlationId, intent.runId, intent.stepId,
      ],
    );
    if (inserted.rows[0]) {
      return { created: true, intent: intentFromDb(inserted.rows[0]) };
    }
    const existing = await this.getIntentByIdempotencyKey(executionTarget, intent.idempotencyKey);
    if (!existing) {
      // intent_id 撞了但幂等键没撞：调用方复用了 intentId，这是实现 bug，不是幂等命中。
      throw new ManagedAutomationInvariantError(
        `intent_id ${intent.intentId} 已存在但幂等键 ${intent.idempotencyKey} 查无既有 intent`,
      );
    }
    return { created: false, intent: existing };
  }

  async getIntent(executionTarget: ExecutionTarget, intentId: string): Promise<ExecutionIntent | null> {
    const result = await this.pool.query<IntentDbRow>(
      `SELECT ${INTENT_COLUMNS} FROM execution_intents
        WHERE intent_id=$1 AND execution_target=$2`,
      [intentId, executionTarget],
    );
    return result.rows[0] ? intentFromDb(result.rows[0]) : null;
  }

  async getIntentByIdempotencyKey(
    executionTarget: ExecutionTarget,
    idempotencyKey: string,
  ): Promise<ExecutionIntent | null> {
    const result = await this.pool.query<IntentDbRow>(
      `SELECT ${INTENT_COLUMNS} FROM execution_intents
        WHERE execution_target=$1 AND idempotency_key=$2`,
      [executionTarget, idempotencyKey],
    );
    return result.rows[0] ? intentFromDb(result.rows[0]) : null;
  }

  async listIntentsByRun(executionTarget: ExecutionTarget, runId: string): Promise<ExecutionIntent[]> {
    const result = await this.pool.query<IntentDbRow>(
      `SELECT ${INTENT_COLUMNS} FROM execution_intents
        WHERE execution_target=$1 AND run_id=$2
        ORDER BY created_at ASC`,
      [executionTarget, runId],
    );
    return result.rows.map(intentFromDb);
  }

  // —— execution_attempts ——

  /** 建 Attempt（一律 prepared 起步）；同 intent 下 ordinal 已存在即返回 false。 */
  async insertAttempt(executionTarget: ExecutionTarget, attempt: ExecutionAttemptInsert): Promise<boolean> {
    const result = await this.pool.query(
      `INSERT INTO execution_attempts (attempt_id, execution_target, intent_id, run_id, step_id,
         ordinal, status)
       VALUES ($1,$2,$3,$4,$5,$6,'prepared')
       ON CONFLICT DO NOTHING`,
      [
        attempt.attemptId, executionTarget, attempt.intentId, attempt.runId,
        attempt.stepId, attempt.ordinal,
      ],
    );
    return result.rowCount === 1;
  }

  /**
   * CAS 状态迁移：WHERE 校验当前 status。红线：expectedStatus 不受理 'submitted_unknown'
   * ——unknown 的改判只能走 reconcileSubmittedUnknown（design §12）。
   */
  async transitionAttempt(
    executionTarget: ExecutionTarget,
    attemptId: string,
    expectedStatus: ExecutionAttemptStatus,
    next: AttemptTransition,
  ): Promise<boolean> {
    if (expectedStatus === 'submitted_unknown') {
      throw new ManagedAutomationInvariantError(
        `submitted_unknown 禁止经普通迁移接口改判，只能走 reconcileSubmittedUnknown`,
      );
    }
    return this.applyAttemptTransition(executionTarget, attemptId, expectedStatus, next);
  }

  /**
   * Reconciler 专用改判：submitted_unknown → platform_confirmed | confirmed_not_applied。
   * 每次调用（无论是否得出结论）递增有界对账计数。
   */
  async reconcileSubmittedUnknown(
    executionTarget: ExecutionTarget,
    attemptId: string,
    next: AttemptTransition | null,
  ): Promise<boolean> {
    if (next === null) {
      // 本轮无结论：保持 unknown，只记一次对账。
      const result = await this.pool.query(
        `UPDATE execution_attempts
            SET reconciliation_count=reconciliation_count+1
          WHERE attempt_id=$1 AND execution_target=$2 AND status='submitted_unknown'`,
        [attemptId, executionTarget],
      );
      return result.rowCount === 1;
    }
    if (next.status !== 'platform_confirmed' && next.status !== 'confirmed_not_applied') {
      throw new ManagedAutomationInvariantError(
        `Reconciler 只能把 submitted_unknown 改判为 platform_confirmed / confirmed_not_applied`
        + `（收到 ${next.status}）`,
      );
    }
    return this.applyAttemptTransition(executionTarget, attemptId, 'submitted_unknown', next, true);
  }

  async getAttempt(executionTarget: ExecutionTarget, attemptId: string): Promise<ExecutionAttempt | null> {
    const result = await this.pool.query<AttemptDbRow>(
      `SELECT ${ATTEMPT_COLUMNS} FROM execution_attempts
        WHERE attempt_id=$1 AND execution_target=$2`,
      [attemptId, executionTarget],
    );
    return result.rows[0] ? attemptFromDb(result.rows[0]) : null;
  }

  async listAttemptsByIntent(executionTarget: ExecutionTarget, intentId: string): Promise<ExecutionAttempt[]> {
    const result = await this.pool.query<AttemptDbRow>(
      `SELECT ${ATTEMPT_COLUMNS} FROM execution_attempts
        WHERE execution_target=$1 AND intent_id=$2
        ORDER BY ordinal ASC`,
      [executionTarget, intentId],
    );
    return result.rows.map(attemptFromDb);
  }

  /** Reconciler 扫描路径：按 (target, status) 走 idx_execution_attempts_target_status。 */
  async listAttemptsByStatus(
    executionTarget: ExecutionTarget,
    status: ExecutionAttemptStatus,
    limit = 100,
  ): Promise<ExecutionAttempt[]> {
    const result = await this.pool.query<AttemptDbRow>(
      `SELECT ${ATTEMPT_COLUMNS} FROM execution_attempts
        WHERE execution_target=$1 AND status=$2
        ORDER BY prepared_at ASC
        LIMIT $3`,
      [executionTarget, status, limit],
    );
    return result.rows.map(attemptFromDb);
  }

  private async applyAttemptTransition(
    executionTarget: ExecutionTarget,
    attemptId: string,
    expectedStatus: ExecutionAttemptStatus,
    next: AttemptTransition,
    bumpReconciliation = false,
  ): Promise<boolean> {
    const coupled = {
      status: next.status,
      nonStartReason: next.nonStartReason ?? null,
      confirmedNotAppliedKind: next.confirmedNotAppliedKind ?? null,
    };
    assertAttemptFieldCoupling(coupled);
    const settled = SETTLED_STATUSES.includes(next.status);
    const result = await this.pool.query(
      `UPDATE execution_attempts
          SET status=$4, non_start_reason=$5, confirmed_not_applied_kind=$6,
              reason_code=COALESCE($7, reason_code),
              evidence_ref=COALESCE($8, evidence_ref),
              strongest_progress_evidence_ref=COALESCE($9, strongest_progress_evidence_ref),
              dispatched_at=CASE WHEN $4='dispatched' THEN COALESCE(dispatched_at, now()) ELSE dispatched_at END,
              settled_at=CASE WHEN $10 THEN COALESCE(settled_at, now()) ELSE settled_at END,
              reconciliation_count=reconciliation_count + CASE WHEN $11 THEN 1 ELSE 0 END
        WHERE attempt_id=$1 AND execution_target=$2 AND status=$3`,
      [
        attemptId, executionTarget, expectedStatus,
        next.status, coupled.nonStartReason, coupled.confirmedNotAppliedKind,
        next.reasonCode ?? null, next.evidenceRef ?? null,
        next.strongestProgressEvidenceRef ?? null, settled, bumpReconciliation,
      ],
    );
    return result.rowCount === 1;
  }
}
