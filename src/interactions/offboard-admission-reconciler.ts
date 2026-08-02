import { createHash } from 'node:crypto';
import type {
  ClaimPendingMaterializationsOutcome,
  OffboardAdmissionLedgerPort,
  ReconcileActiveOffboardSnapshotOutcome,
  RecordMaterializationReceiptOutcome,
} from '../kernel/api-direct-port.js';
import type {
  ClientEnvAutomationReader,
  OffboardProjection,
} from '../kernel/client-env-automation-types.js';
import type {
  MaterializeEnvironmentOffboardOutcome,
  OffboardMaterializationOperations,
} from '../kernel/offboard-materialization-types.js';

const CLAIM_LIMIT = 50;
const CLAIM_LEASE_MS = 30_000;

export type OffboardAdmissionReconcileStage =
  | 'active_snapshot'
  | 'snapshot_reconcile'
  | 'claim'
  | 'materialize'
  | 'record_receipt';

export interface OffboardAdmissionReconcileCounts {
  adopted: number;
  released: number;
  claimed: number;
  ownerMaterialized: number;
  bindingMissing: number;
  receiptsApplied: number;
  receiptsDuplicate: number;
  receiptsStale: number;
  receiptsCollision: number;
}

export interface OffboardAdmissionReconcileProgress {
  snapshotOutcome: ReconcileActiveOffboardSnapshotOutcome['outcome'] | null;
  claimOutcome: ClaimPendingMaterializationsOutcome['outcome'] | null;
  counts: OffboardAdmissionReconcileCounts;
  /**
   * Only projections whose API receipt was confirmed as applied/duplicate.
   * A local materialization followed by an unknown/stale/colliding receipt is
   * deliberately absent, so dispatch never treats an unresolved admission as complete.
   */
  materializedOffboards: OffboardProjection[];
}

export interface OffboardAdmissionReconcileResult extends OffboardAdmissionReconcileProgress {
  outcome: 'completed';
}

export interface OffboardAdmissionReconcileInput {
  /** Stable for this explicit round; callers use a new id for a later round. */
  commandId: string;
  /** Stable epoch-ms marker for snapshot, claim and materialization receipts in this round. */
  now: number;
}

export interface AutomationOffboardAdmissionReconcilerDeps {
  automationRead: Pick<ClientEnvAutomationReader, 'activeWechatOffboards'>;
  materializationOps: OffboardMaterializationOperations;
  /**
   * 只用写面三口。**刻意收窄成 `Omit`**：对账循环从不问撤权 hold，
   * 宽声明会逼每个替身去伪造一个它永远不会被调到的方法 —— 那种伪造正是「看着接好了」的来源。
   */
  admissionLedger: Omit<OffboardAdmissionLedgerPort, 'hasPendingRevocationHold'>;
  /** Stable process-worker identity, for example `offboard-reconcile-dev`. */
  workerId: string;
}

export class OffboardAdmissionReconcileIncompleteError extends Error {
  readonly code = 'offboard_admission_reconcile_incomplete';

  constructor(
    readonly stage: OffboardAdmissionReconcileStage,
    readonly progress: OffboardAdmissionReconcileProgress,
    readonly originalError?: unknown,
    readonly candidate?: { revocationId: string; offboardId: string },
    readonly receiptOutcome?: Extract<
      RecordMaterializationReceiptOutcome['outcome'],
      'stale' | 'collision'
    >,
  ) {
    super(
      receiptOutcome
        ? `offboard admission reconcile stopped at ${stage}: ${receiptOutcome}`
        : `offboard admission reconcile stopped at ${stage}`,
    );
    this.name = 'OffboardAdmissionReconcileIncompleteError';
  }
}

interface MutableProgress {
  snapshotOutcome: ReconcileActiveOffboardSnapshotOutcome['outcome'] | null;
  claimOutcome: ClaimPendingMaterializationsOutcome['outcome'] | null;
  counts: OffboardAdmissionReconcileCounts;
  materializedOffboards: OffboardProjection[];
}

function initialProgress(): MutableProgress {
  return {
    snapshotOutcome: null,
    claimOutcome: null,
    counts: {
      adopted: 0,
      released: 0,
      claimed: 0,
      ownerMaterialized: 0,
      bindingMissing: 0,
      receiptsApplied: 0,
      receiptsDuplicate: 0,
      receiptsStale: 0,
      receiptsCollision: 0,
    },
    materializedOffboards: [],
  };
}

function snapshotProgress(progress: MutableProgress): OffboardAdmissionReconcileProgress {
  return {
    snapshotOutcome: progress.snapshotOutcome,
    claimOutcome: progress.claimOutcome,
    counts: { ...progress.counts },
    materializedOffboards: progress.materializedOffboards.map((row) => ({ ...row })),
  };
}

function requireIdentity(value: string, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > 200) {
    throw new Error(`${label}_invalid`);
  }
  return value;
}

function requireRoundInput(input: OffboardAdmissionReconcileInput): void {
  requireIdentity(input?.commandId, 'offboard_reconcile_command_id');
  if (!Number.isSafeInteger(input.now) || input.now < 0) {
    throw new Error('offboard_reconcile_now_invalid');
  }
}

function deriveCommandId(roundCommandId: string, capability: string, payload: unknown): string {
  const digest = createHash('sha256')
    .update(JSON.stringify([roundCommandId, capability, payload]))
    .digest('hex');
  return `offboard:${digest}`;
}

function isActiveProjection(row: OffboardProjection): boolean {
  return (
    typeof row?.offboardId === 'string'
    && row.offboardId.length > 0
    && typeof row.envKey === 'string'
    && row.envKey.length > 0
    && typeof row.accountId === 'string'
    && row.accountId.length > 0
    && (row.state === 'pending_edge' || row.state === 'dispatched' || row.state === 'tombstoned')
    && (
      row.reason === 'environment_unbind'
      || row.reason === 'customer_terminated'
      || row.reason === 'admin_revoked'
    )
    && Number.isSafeInteger(row.requestedAt)
    && row.requestedAt >= 0
    && Number.isSafeInteger(row.purgeDueAt)
    && row.purgeDueAt >= 0
  );
}

function requireCompleteActiveSnapshot(rows: unknown): OffboardProjection[] {
  if (!Array.isArray(rows) || !rows.every(isActiveProjection)) {
    throw new Error('offboard_active_snapshot_invalid');
  }
  const envKeys = new Set<string>();
  for (const row of rows) {
    if (envKeys.has(row.envKey)) {
      throw new Error('offboard_active_snapshot_duplicate_env');
    }
    envKeys.add(row.envKey);
  }
  return rows
    .map((row) => ({ ...row }))
    .sort((left, right) =>
      left.envKey < right.envKey
        ? -1
        : left.envKey > right.envKey
          ? 1
          : left.offboardId.localeCompare(right.offboardId));
}

/**
 * Automation-owned orchestration across owner-local primitives.
 *
 * Every await crosses at most one owner boundary and no transaction handle is
 * accepted or retained here. There is intentionally no retry: an unknown write
 * stops the round and leaves the API claim/admission to converge by lease and a
 * later round.
 */
export class AutomationOffboardAdmissionReconciler {
  private readonly workerId: string;

  constructor(private readonly deps: AutomationOffboardAdmissionReconcilerDeps) {
    this.workerId = requireIdentity(deps.workerId, 'offboard_reconcile_worker_id');
  }

  async reconcile(
    input: OffboardAdmissionReconcileInput,
  ): Promise<OffboardAdmissionReconcileResult> {
    requireRoundInput(input);
    const progress = initialProgress();

    let active: OffboardProjection[];
    try {
      active = requireCompleteActiveSnapshot(
        await this.deps.automationRead.activeWechatOffboards(),
      );
    } catch (error) {
      throw new OffboardAdmissionReconcileIncompleteError(
        'active_snapshot',
        snapshotProgress(progress),
        error,
      );
    }

    const snapshotCommandId = deriveCommandId(input.commandId, 'snapshot', {
      observedAt: input.now,
      rows: active.map((row) => ({
        offboardId: row.offboardId,
        envKey: row.envKey,
        reason: row.reason,
        requestedAt: row.requestedAt,
      })),
    });
    try {
      const snapshot = await this.deps.admissionLedger.reconcileActiveOffboardSnapshot({
        commandId: snapshotCommandId,
        complete: true,
        observedAt: input.now,
        rows: active.map((row) => ({
          offboardId: row.offboardId,
          envKey: row.envKey,
          reason: row.reason,
          requestedAt: row.requestedAt,
        })),
      });
      progress.snapshotOutcome = snapshot.outcome;
      progress.counts.adopted = snapshot.adopted;
      progress.counts.released = snapshot.released;
    } catch (error) {
      throw new OffboardAdmissionReconcileIncompleteError(
        'snapshot_reconcile',
        snapshotProgress(progress),
        error,
      );
    }

    let claim: ClaimPendingMaterializationsOutcome;
    try {
      claim = await this.deps.admissionLedger.claimPendingMaterializations({
        commandId: deriveCommandId(input.commandId, 'claim', {
          workerId: this.workerId,
          now: input.now,
          limit: CLAIM_LIMIT,
          leaseMs: CLAIM_LEASE_MS,
        }),
        workerId: this.workerId,
        limit: CLAIM_LIMIT,
        now: input.now,
        leaseMs: CLAIM_LEASE_MS,
      });
      progress.claimOutcome = claim.outcome;
      progress.counts.claimed = claim.candidates.length;
    } catch (error) {
      throw new OffboardAdmissionReconcileIncompleteError(
        'claim',
        snapshotProgress(progress),
        error,
      );
    }

    for (const candidate of claim.candidates) {
      const candidateIdentity = {
        revocationId: candidate.revocationId,
        offboardId: candidate.offboardId,
      };
      let materialization: MaterializeEnvironmentOffboardOutcome;
      try {
        materialization = await this.deps.materializationOps.materializeEnvironmentOffboard({
          offboardId: candidate.offboardId,
          envKey: candidate.envKey,
          userId: candidate.userId ?? '',
          reason: candidate.reason,
          actor: candidate.actor,
          unboundTerminalAllowed: candidate.unboundTerminalAllowed,
        });
      } catch (error) {
        throw new OffboardAdmissionReconcileIncompleteError(
          'materialize',
          snapshotProgress(progress),
          error,
          candidateIdentity,
        );
      }

      if (materialization.materialized) {
        if (
          !isActiveProjection(materialization.offboard)
          || materialization.offboard.offboardId !== candidate.offboardId
          || materialization.offboard.envKey !== candidate.envKey
        ) {
          throw new OffboardAdmissionReconcileIncompleteError(
            'materialize',
            snapshotProgress(progress),
            new Error('offboard_materialization_result_invalid'),
            candidateIdentity,
          );
        }
        progress.counts.ownerMaterialized += 1;
      } else {
        progress.counts.bindingMissing += 1;
      }
      const result = materialization.materialized
        ? {
            kind: 'materialized' as const,
            offboardId: materialization.offboard.offboardId,
            materializedAt: input.now,
          }
        : { kind: 'binding_missing' as const };

      let receipt: RecordMaterializationReceiptOutcome;
      try {
        receipt = await this.deps.admissionLedger.recordMaterializationReceipt({
          commandId: deriveCommandId(input.commandId, 'receipt', {
            revocationId: candidate.revocationId,
            claimToken: candidate.claimToken,
            expectedRevision: candidate.revision,
            result,
          }),
          revocationId: candidate.revocationId,
          claimToken: candidate.claimToken,
          expectedRevision: candidate.revision,
          result,
        });
      } catch (error) {
        throw new OffboardAdmissionReconcileIncompleteError(
          'record_receipt',
          snapshotProgress(progress),
          error,
          candidateIdentity,
        );
      }

      if (receipt.outcome === 'stale' || receipt.outcome === 'collision') {
        if (receipt.outcome === 'stale') progress.counts.receiptsStale += 1;
        else progress.counts.receiptsCollision += 1;
        throw new OffboardAdmissionReconcileIncompleteError(
          'record_receipt',
          snapshotProgress(progress),
          undefined,
          candidateIdentity,
          receipt.outcome,
        );
      }
      if (receipt.outcome === 'applied') progress.counts.receiptsApplied += 1;
      else progress.counts.receiptsDuplicate += 1;

      if (materialization.materialized) {
        progress.materializedOffboards.push({ ...materialization.offboard });
      }
    }

    return {
      outcome: 'completed',
      ...snapshotProgress(progress),
    };
  }
}
