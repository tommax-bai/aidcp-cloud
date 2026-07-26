import crypto from 'node:crypto';
import type pg from 'pg';
import type {
  ClaimPendingMaterializationsInput,
  ClaimPendingMaterializationsOutcome,
  OffboardAdmissionLedgerPort,
  OffboardMaterializationCandidate,
  ReconcileActiveOffboardSnapshotInput,
  ReconcileActiveOffboardSnapshotOutcome,
  RecordMaterializationReceiptInput,
  RecordMaterializationReceiptOutcome,
} from '../kernel/api-direct-port.js';
import { parseDeploymentTarget, type DeploymentTarget } from '../deployment-target.js';

type CommandCapability =
  | 'reconcile_snapshot'
  | 'claim_materializations'
  | 'record_receipt';

interface CommandReceiptRow {
  capability: CommandCapability;
  payload_hash: string;
  receipt: unknown;
}

interface AdmissionClaimRow {
  revocation_id: string;
  offboard_id: string;
  env_key: string;
  user_id: string | null;
  reason: OffboardMaterializationCandidate['reason'];
  revoked_by: string | null;
  unbound_terminal_ok: boolean;
  requested_at: Date | string;
  claim_token: string;
  admission_revision: string | number;
  claim_expires_at: Date | string;
}

interface AdmissionReceiptRow {
  offboard_id: string;
  materialized_at: Date | string | null;
  claim_token: string | null;
  admission_revision: string | number;
}

interface SnapshotStateRow {
  observed_at_ms: string | number;
  snapshot_digest: string;
  receipt: unknown;
}

const OFFBOARD_CLAIM_LEASE_MS = 30_000;
const OFFBOARD_ADMISSION_COMMAND_LOCK_PREFIX = 'offboard-admission-command|';
const OFFBOARD_ADMISSION_CAPABILITY_LOCK_PREFIX = 'offboard-admission-capability|';

export class OffboardAdmissionLedgerError extends Error {
  constructor(
    readonly code:
      | 'offboard_admission_invalid_request'
      | 'offboard_admission_command_collision'
      | 'offboard_admission_stale_snapshot'
      | 'offboard_admission_snapshot_collision'
      | 'offboard_admission_execution_target_unassigned'
      | 'offboard_admission_receipt_corrupt',
    message: string = code,
  ) {
    super(message);
    this.name = 'OffboardAdmissionLedgerError';
  }
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function payloadHash(value: unknown): string {
  return crypto.createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function epoch(value: Date | string): number {
  const result = new Date(value).getTime();
  if (!Number.isFinite(result)) {
    throw new OffboardAdmissionLedgerError(
      'offboard_admission_receipt_corrupt',
      'offboard admission timestamp is invalid',
    );
  }
  return result;
}

function requireCommandId(commandId: unknown): string {
  if (typeof commandId !== 'string' || commandId.trim().length === 0 || commandId.length > 200) {
    throw new OffboardAdmissionLedgerError(
      'offboard_admission_invalid_request',
      'offboard admission commandId is invalid',
    );
  }
  return commandId;
}

function requireFiniteTimestamp(value: unknown, field: string): number {
  if (
    typeof value !== 'number'
    || !Number.isSafeInteger(value)
    || value < 0
  ) {
    throw new OffboardAdmissionLedgerError(
      'offboard_admission_invalid_request',
      `${field} must be a non-negative safe-integer epoch timestamp`,
    );
  }
  return value;
}

function parseStoredReceipt<T>(value: unknown): T {
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value;
    if (!parsed || typeof parsed !== 'object') throw new Error('not an object');
    return parsed as T;
  } catch {
    throw new OffboardAdmissionLedgerError(
      'offboard_admission_receipt_corrupt',
      'stored offboard command receipt is malformed',
    );
  }
}

function parseSnapshotReceipt(value: unknown): ReconcileActiveOffboardSnapshotOutcome {
  const parsed = parseStoredReceipt<Partial<ReconcileActiveOffboardSnapshotOutcome>>(value);
  if (
    parsed.outcome !== 'applied'
    || !Number.isSafeInteger(parsed.adopted)
    || Number(parsed.adopted) < 0
    || !Number.isSafeInteger(parsed.released)
    || Number(parsed.released) < 0
  ) {
    throw new OffboardAdmissionLedgerError(
      'offboard_admission_receipt_corrupt',
      'stored offboard snapshot receipt is malformed',
    );
  }
  return {
    outcome: 'applied',
    adopted: Number(parsed.adopted),
    released: Number(parsed.released),
  };
}

function snapshotDigest(rows: ReconcileActiveOffboardSnapshotInput['rows']): string {
  return payloadHash(
    [...rows]
      .map((row) => ({
        envKey: row.envKey,
        offboardId: row.offboardId,
        reason: row.reason,
        requestedAt: row.requestedAt,
      }))
      .sort((left, right) =>
        left.envKey < right.envKey ? -1 : left.envKey > right.envKey ? 1 : 0),
  );
}

export class PgOffboardAdmissionLedger implements OffboardAdmissionLedgerPort {
  private readonly executionTarget: DeploymentTarget;

  constructor(private readonly pool: pg.Pool, executionTarget: DeploymentTarget) {
    const target = parseDeploymentTarget(executionTarget);
    if (!target) {
      throw new OffboardAdmissionLedgerError(
        'offboard_admission_invalid_request',
        'offboard admission ledger requires a valid server execution target',
      );
    }
    this.executionTarget = target;
  }

  async reconcileActiveOffboardSnapshot(
    input: ReconcileActiveOffboardSnapshotInput,
  ): Promise<ReconcileActiveOffboardSnapshotOutcome> {
    const commandId = requireCommandId(input?.commandId);
    if (input?.complete !== true || !Array.isArray(input.rows)) {
      throw new OffboardAdmissionLedgerError(
        'offboard_admission_invalid_request',
        'offboard snapshot must be explicitly complete',
      );
    }
    requireFiniteTimestamp(input.observedAt, 'observedAt');
    const seenEnvKeys = new Set<string>();
    for (const row of input.rows) {
      if (
        !row
        || typeof row.offboardId !== 'string'
        || row.offboardId.trim().length === 0
        || typeof row.envKey !== 'string'
        || row.envKey.trim().length === 0
        || !['environment_unbind', 'customer_terminated', 'admin_revoked'].includes(row.reason)
      ) {
        throw new OffboardAdmissionLedgerError(
          'offboard_admission_invalid_request',
          'offboard snapshot row is invalid',
        );
      }
      requireFiniteTimestamp(row.requestedAt, 'requestedAt');
      if (seenEnvKeys.has(row.envKey)) {
        throw new OffboardAdmissionLedgerError(
          'offboard_admission_invalid_request',
          `offboard snapshot contains duplicate envKey ${row.envKey}`,
        );
      }
      seenEnvKeys.add(row.envKey);
    }

    return this.inTransaction(async (client) => {
      await this.assertNoUnassignedAdmissions(client);
      await this.lockCapability(client, 'reconcile_snapshot');
      await this.lockCommand(client, commandId);
      const hash = payloadHash(input);
      const duplicate = await this.readCommand<ReconcileActiveOffboardSnapshotOutcome>(
        client,
        commandId,
        'reconcile_snapshot',
        hash,
      );
      if (duplicate) return { ...duplicate, outcome: 'duplicate' };

      const digest = snapshotDigest(input.rows);
      const { rows: stateRows } = await client.query<SnapshotStateRow>(
        `SELECT observed_at_ms,snapshot_digest,receipt
           FROM client_env_admission_snapshot_state
          WHERE execution_target=$1
            AND capability='reconcile_snapshot'
          FOR UPDATE`,
        [this.executionTarget],
      );
      const state = stateRows[0];
      if (state) {
        const observedAt = Number(state.observed_at_ms);
        if (!Number.isSafeInteger(observedAt) || observedAt < 0) {
          throw new OffboardAdmissionLedgerError(
            'offboard_admission_receipt_corrupt',
            'stored offboard snapshot cursor is malformed',
          );
        }
        if (input.observedAt < observedAt) {
          throw new OffboardAdmissionLedgerError(
            'offboard_admission_stale_snapshot',
            `offboard snapshot observedAt=${input.observedAt} is older than ${observedAt}`,
          );
        }
        if (input.observedAt === observedAt) {
          if (state.snapshot_digest !== digest) {
            throw new OffboardAdmissionLedgerError(
              'offboard_admission_snapshot_collision',
              `offboard snapshot cursor collision at observedAt=${input.observedAt}`,
            );
          }
          const prior = parseSnapshotReceipt(state.receipt);
          const receipt: ReconcileActiveOffboardSnapshotOutcome = {
            ...prior,
            outcome: 'duplicate',
          };
          await this.writeCommand(
            client,
            commandId,
            'reconcile_snapshot',
            hash,
            prior,
          );
          return receipt;
        }
      }

      let adopted = 0;
      if (input.rows.length > 0) {
        const adoption = await client.query(
          `INSERT INTO client_env_revocation_holds
             (revocation_id,env_key,user_id,reason,revoked_by,offboard_id,unbound_terminal_ok,
              materialized_at,admission_revision,execution_target,requested_at,updated_at)
           SELECT md5('cleanup-admission:' || k.env_key || ':' || k.offboard_id)::uuid,
                  k.env_key,NULL,k.reason,NULL,k.offboard_id,false,now(),1,$5,k.requested_at,now()
             FROM unnest($1::text[],$2::text[],$3::text[],$4::timestamptz[])
                  AS k(env_key,offboard_id,reason,requested_at)
           ON CONFLICT (env_key) DO NOTHING`,
          [
            input.rows.map((row) => row.envKey),
            input.rows.map((row) => row.offboardId),
            input.rows.map((row) => row.reason),
            input.rows.map((row) => new Date(row.requestedAt).toISOString()),
            this.executionTarget,
          ],
        );
        adopted = adoption.rowCount ?? 0;
      }

      const release = await client.query(
        `DELETE FROM client_env_revocation_holds
          WHERE materialized_at IS NOT NULL
            AND execution_target=$2
            AND materialized_at <= $3::timestamptz
            AND NOT (env_key = ANY($1::text[]))`,
        [
          [...seenEnvKeys],
          this.executionTarget,
          new Date(input.observedAt).toISOString(),
        ],
      );
      const receipt: ReconcileActiveOffboardSnapshotOutcome = {
        outcome: 'applied',
        adopted,
        released: release.rowCount ?? 0,
      };
      await client.query(
        `INSERT INTO client_env_admission_snapshot_state
           (execution_target,capability,observed_at_ms,snapshot_digest,receipt,updated_at)
         VALUES ($1,'reconcile_snapshot',$2,$3,$4::jsonb,now())
         ON CONFLICT (execution_target,capability) DO UPDATE
           SET observed_at_ms=EXCLUDED.observed_at_ms,
               snapshot_digest=EXCLUDED.snapshot_digest,
               receipt=EXCLUDED.receipt,
               updated_at=now()
         WHERE client_env_admission_snapshot_state.observed_at_ms < EXCLUDED.observed_at_ms`,
        [
          this.executionTarget,
          input.observedAt,
          digest,
          JSON.stringify(receipt),
        ],
      );
      await this.writeCommand(client, commandId, 'reconcile_snapshot', hash, receipt);
      return receipt;
    });
  }

  async claimPendingMaterializations(
    input: ClaimPendingMaterializationsInput,
  ): Promise<ClaimPendingMaterializationsOutcome> {
    const commandId = requireCommandId(input?.commandId);
    if (
      typeof input.workerId !== 'string'
      || input.workerId.trim().length === 0
      || input.workerId.length > 200
      || !Number.isInteger(input.limit)
      || input.limit < 1
      || input.limit > 200
      || !Number.isFinite(input.leaseMs)
      || input.leaseMs <= 0
    ) {
      throw new OffboardAdmissionLedgerError(
        'offboard_admission_invalid_request',
        'offboard materialization claim input is invalid',
      );
    }
    requireFiniteTimestamp(input.now, 'now');

    return this.inTransaction(async (client) => {
      await this.assertNoUnassignedAdmissions(client);
      await this.lockCommand(client, commandId);
      const hash = payloadHash(input);
      const duplicate = await this.readCommand<ClaimPendingMaterializationsOutcome>(
        client,
        commandId,
        'claim_materializations',
        hash,
      );
      if (duplicate) return { ...duplicate, outcome: 'duplicate' };

      const { rows } = await client.query<AdmissionClaimRow>(
        `WITH due AS (
           SELECT revocation_id
             FROM client_env_revocation_holds
            WHERE materialized_at IS NULL
              AND execution_target=$5
              AND (claim_expires_at IS NULL OR claim_expires_at <= clock_timestamp())
            ORDER BY requested_at,env_key
            FOR UPDATE SKIP LOCKED
            LIMIT $1
         )
         UPDATE client_env_revocation_holds h
            SET admission_revision=h.admission_revision+1,
                claim_token=md5($3 || ':' || h.revocation_id::text || ':' || (h.admission_revision+1)::text),
                claimed_by=$2,
                claim_expires_at=clock_timestamp() + ($4 * interval '1 millisecond'),
                updated_at=now()
           FROM due
          WHERE h.revocation_id=due.revocation_id
         RETURNING h.revocation_id,h.offboard_id,h.env_key,h.user_id,h.reason,h.revoked_by,
                   h.unbound_terminal_ok,h.requested_at,h.claim_token,h.admission_revision,h.claim_expires_at`,
        [
          input.limit,
          input.workerId,
          commandId,
          OFFBOARD_CLAIM_LEASE_MS,
          this.executionTarget,
        ],
      );
      const candidates = rows.map((row): OffboardMaterializationCandidate => ({
        revocationId: row.revocation_id,
        offboardId: row.offboard_id,
        envKey: row.env_key,
        userId: row.user_id,
        reason: row.reason,
        actor: row.revoked_by,
        unboundTerminalAllowed: row.unbound_terminal_ok,
        requestedAt: epoch(row.requested_at),
        claimToken: row.claim_token,
        revision: Number(row.admission_revision),
        claimExpiresAt: epoch(row.claim_expires_at),
      }));
      const receipt: ClaimPendingMaterializationsOutcome = { outcome: 'applied', candidates };
      await this.writeCommand(client, commandId, 'claim_materializations', hash, receipt);
      return receipt;
    });
  }

  async recordMaterializationReceipt(
    input: RecordMaterializationReceiptInput,
  ): Promise<RecordMaterializationReceiptOutcome> {
    const commandId = requireCommandId(input?.commandId);
    if (
      typeof input.revocationId !== 'string'
      || input.revocationId.trim().length === 0
      || typeof input.claimToken !== 'string'
      || input.claimToken.trim().length === 0
      || !Number.isInteger(input.expectedRevision)
      || input.expectedRevision < 1
      || !input.result
      || (input.result.kind !== 'materialized' && input.result.kind !== 'binding_missing')
    ) {
      throw new OffboardAdmissionLedgerError(
        'offboard_admission_invalid_request',
        'offboard materialization receipt is invalid',
      );
    }
    if (input.result.kind === 'materialized') {
      if (typeof input.result.offboardId !== 'string' || input.result.offboardId.trim().length === 0) {
        throw new OffboardAdmissionLedgerError(
          'offboard_admission_invalid_request',
          'materialized receipt requires offboardId',
        );
      }
      requireFiniteTimestamp(input.result.materializedAt, 'materializedAt');
    }

    return this.inTransaction(async (client) => {
      await this.lockCommand(client, commandId);
      const hash = payloadHash(input);
      const duplicate = await this.readCommand<RecordMaterializationReceiptOutcome>(
        client,
        commandId,
        'record_receipt',
        hash,
      );
      if (duplicate) {
        return duplicate.outcome === 'applied'
          ? { outcome: 'duplicate', revision: duplicate.revision }
          : duplicate;
      }

      const { rows } = await client.query<AdmissionReceiptRow>(
        `SELECT offboard_id,materialized_at,claim_token,admission_revision
          FROM client_env_revocation_holds
          WHERE revocation_id=$1
            AND execution_target=$2
          FOR UPDATE`,
        [input.revocationId, this.executionTarget],
      );
      const row = rows[0];
      const currentRevision = Number(row?.admission_revision ?? 0);
      let receipt: RecordMaterializationReceiptOutcome;
      if (
        !row
        || row.materialized_at !== null
        || row.claim_token !== input.claimToken
        || currentRevision !== input.expectedRevision
      ) {
        receipt = { outcome: 'stale', revision: currentRevision };
      } else if (
        input.result.kind === 'materialized'
        && row.offboard_id !== input.result.offboardId
      ) {
        receipt = { outcome: 'collision', revision: currentRevision };
      } else {
        const materializedAt = input.result.kind === 'materialized'
          ? new Date(input.result.materializedAt).toISOString()
          : null;
        const updated = await client.query<{ admission_revision: string | number }>(
          `UPDATE client_env_revocation_holds
              SET materialized_at=CASE WHEN $2::timestamptz IS NULL THEN materialized_at ELSE $2::timestamptz END,
                  claim_token=NULL,
                  claimed_by=NULL,
                  claim_expires_at=NULL,
                  admission_revision=admission_revision+1,
                  updated_at=now()
            WHERE revocation_id=$1
              AND execution_target=$6
              AND claim_token=$3
              AND admission_revision=$4
          RETURNING admission_revision`,
          [
            input.revocationId,
            materializedAt,
            input.claimToken,
            input.expectedRevision,
            input.result.kind,
            this.executionTarget,
          ],
        );
        receipt = updated.rows[0]
          ? { outcome: 'applied', revision: Number(updated.rows[0].admission_revision) }
          : { outcome: 'stale', revision: currentRevision };
      }
      await this.writeCommand(client, commandId, 'record_receipt', hash, receipt);
      return receipt;
    });
  }

  private async inTransaction<T>(operation: (client: pg.PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await operation(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  private async lockCommand(client: pg.PoolClient, commandId: string): Promise<void> {
    await client.query(
      `SELECT pg_advisory_xact_lock(hashtextextended($1,0))`,
      [`${OFFBOARD_ADMISSION_COMMAND_LOCK_PREFIX}${this.executionTarget}|${commandId}`],
    );
  }

  private async lockCapability(
    client: pg.PoolClient,
    capability: CommandCapability,
  ): Promise<void> {
    await client.query(
      `SELECT pg_advisory_xact_lock(hashtextextended($1,0))`,
      [`${OFFBOARD_ADMISSION_CAPABILITY_LOCK_PREFIX}${this.executionTarget}|${capability}`],
    );
  }

  private async assertNoUnassignedAdmissions(client: pg.PoolClient): Promise<void> {
    const { rows } = await client.query<{ env_key: string }>(
      `SELECT env_key
         FROM client_env_revocation_holds
        WHERE execution_target IS NULL
        ORDER BY requested_at,env_key
        LIMIT 1`,
    );
    if (rows[0]) {
      throw new OffboardAdmissionLedgerError(
        'offboard_admission_execution_target_unassigned',
        `offboard_admission_execution_target_unassigned envKey=${rows[0].env_key}`,
      );
    }
  }

  private async readCommand<T>(
    client: pg.PoolClient,
    commandId: string,
    capability: CommandCapability,
    hash: string,
  ): Promise<T | null> {
    const { rows } = await client.query<CommandReceiptRow>(
      `SELECT capability,payload_hash,receipt
         FROM client_env_admission_command_receipts
        WHERE execution_target=$1 AND command_id=$2`,
      [this.executionTarget, commandId],
    );
    const existing = rows[0];
    if (!existing) return null;
    if (existing.capability !== capability || existing.payload_hash !== hash) {
      throw new OffboardAdmissionLedgerError(
        'offboard_admission_command_collision',
        `offboard commandId collision: ${commandId}`,
      );
    }
    return parseStoredReceipt<T>(existing.receipt);
  }

  private async writeCommand(
    client: pg.PoolClient,
    commandId: string,
    capability: CommandCapability,
    hash: string,
    receipt: object,
  ): Promise<void> {
    await client.query(
      `INSERT INTO client_env_admission_command_receipts
         (execution_target,command_id,capability,payload_hash,receipt)
       VALUES ($1,$2,$3,$4,$5::jsonb)`,
      [this.executionTarget, commandId, capability, hash, JSON.stringify(receipt)],
    );
  }
}
