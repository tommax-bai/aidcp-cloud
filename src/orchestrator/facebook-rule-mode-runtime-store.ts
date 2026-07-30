import { randomUUID } from 'node:crypto';
import pg from 'pg';
import type { DeploymentTarget } from '../deployment-target.js';
import {
  DEFAULT_FACEBOOK_RULE_RUNTIME_POLICY,
  FACEBOOK_RULE_RUNTIME_DEFINITION_ID,
  FACEBOOK_RULE_RUNTIME_DEFINITION_VERSION,
  facebookRuleRoundIncludesJoin,
  type ApplyFacebookRuleViewResult,
  type FacebookRuleActionState,
  type FacebookRuleModeBatchView,
  type FacebookRuleModeRuntimeView,
  type FacebookRulePolicySnapshot,
  type FacebookRuleRuntimePolicy,
} from '../kernel/facebook-rule-mode-types.js';
import { DEFAULT_PG_CONFIG } from '../kernel/pg-config.js';
import {
  SchemaCapabilityError,
  classifySchemaCapability,
  type SchemaProber,
} from '../kernel/schema-capability-contract.js';

const { Pool } = pg;

const FACEBOOK_RULE_RUNTIME_REQUIREMENT = {
  tables: new Map([
    ['facebook_rule_progress', new Set([
      'account_id',
      'execution_target',
      'definition_id',
      'definition_version',
      'policy_revision',
      'policy_snapshot',
      'collecting_sequence',
      'view_count',
      'active_batch_id',
      'updated_at',
    ])],
    ['facebook_rule_view_fact', new Set([
      'account_id',
      'execution_target',
      'definition_id',
      'definition_version',
      'policy_revision',
      'collecting_sequence',
      'content_key',
      'source_dedupe_key',
      'occurred_at',
      'created_at',
    ])],
    ['facebook_rule_batch', new Set([
      'batch_id',
      'account_id',
      'execution_target',
      'definition_id',
      'definition_version',
      'policy_revision',
      'policy_snapshot',
      'sequence',
      'trigger_content_key',
      'like_state',
      'join_state',
      'comment_state',
      'terminal',
      'blocker',
      'created_at',
      'updated_at',
    ])],
  ]),
  indexes: new Map([
    ['idx_facebook_rule_batch_account_target', 'facebook_rule_batch'],
  ]),
};

interface BatchDbRow {
  batch_id: string;
  policy_revision: number | string;
  policy_snapshot: unknown;
  sequence: number | string;
  trigger_content_key: string;
  like_state: FacebookRuleActionState;
  join_state: FacebookRuleActionState;
  comment_state: FacebookRuleActionState;
  terminal: boolean;
  blocker: string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

interface RevisionTransitionBatchRow {
  batch_id: string;
  terminal: boolean;
}

export interface FacebookRuleModeRuntimeStoreOptions {
  pool?: pg.Pool;
  runtimePool?: pg.Pool;
  host?: string;
  port?: number;
  database?: string;
  user?: string;
  password?: string;
  executionTarget: DeploymentTarget;
  schemaProber: SchemaProber;
}

function normalizePolicy(
  policy: FacebookRuleRuntimePolicy = DEFAULT_FACEBOOK_RULE_RUNTIME_POLICY,
): FacebookRuleRuntimePolicy {
  const policyRevision = Number(policy.policyRevision);
  const viewsPerLike = Number(policy.snapshot.viewsPerLike);
  const joinEveryNRounds = Number(policy.snapshot.joinEveryNRounds);
  if (!Number.isSafeInteger(policyRevision) || policyRevision < 0) {
    throw new Error('facebook_rule_policy_revision_invalid');
  }
  if (!Number.isInteger(viewsPerLike) || viewsPerLike < 1 || viewsPerLike > 100) {
    throw new Error('facebook_rule_views_per_like_invalid');
  }
  if (!Number.isInteger(joinEveryNRounds) || joinEveryNRounds < 1 || joinEveryNRounds > 20) {
    throw new Error('facebook_rule_join_every_n_rounds_invalid');
  }
  return {
    policyRevision,
    snapshot: { viewsPerLike, joinEveryNRounds },
  };
}

function snapshotFromDb(value: unknown): FacebookRulePolicySnapshot {
  const raw = typeof value === 'string' ? JSON.parse(value) as unknown : value;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('facebook_rule_policy_snapshot_unreadable');
  }
  return normalizePolicy({
    policyRevision: 0,
    snapshot: {
      viewsPerLike: Number((raw as Record<string, unknown>).viewsPerLike),
      joinEveryNRounds: Number((raw as Record<string, unknown>).joinEveryNRounds),
    },
  }).snapshot;
}

function sameSnapshot(left: FacebookRulePolicySnapshot, right: FacebookRulePolicySnapshot): boolean {
  return left.viewsPerLike === right.viewsPerLike
    && left.joinEveryNRounds === right.joinEveryNRounds;
}

function batchFromDb(row: BatchDbRow): FacebookRuleModeBatchView {
  const sequence = Number(row.sequence);
  const policySnapshot = snapshotFromDb(row.policy_snapshot);
  return {
    batchId: row.batch_id,
    policyRevision: Number(row.policy_revision),
    policySnapshot,
    sequence,
    includesJoin: facebookRuleRoundIncludesJoin(sequence, policySnapshot.joinEveryNRounds),
    triggerContentKey: row.trigger_content_key,
    likeState: row.like_state,
    joinState: row.join_state,
    commentState: row.comment_state,
    terminal: row.terminal === true,
    blocker: row.blocker ?? null,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

const BATCH_SELECT = `batch_id, policy_revision, policy_snapshot, sequence,
  trigger_content_key, like_state, join_state, comment_state, terminal, blocker,
  created_at, updated_at`;

export class FacebookRuleModeRuntimeStore {
  private readonly runtimePool: pg.Pool;
  private readonly executionTarget: DeploymentTarget;
  private readonly schemaProber: SchemaProber;
  private readonly ownedPool?: pg.Pool;

  constructor(options: FacebookRuleModeRuntimeStoreOptions) {
    this.executionTarget = options.executionTarget;
    this.schemaProber = options.schemaProber;
    let pool = options.runtimePool ?? options.pool;
    if (!pool) {
      pool = new Pool({
        host: options.host ?? DEFAULT_PG_CONFIG.host,
        port: options.port ?? DEFAULT_PG_CONFIG.port,
        database: options.database ?? DEFAULT_PG_CONFIG.database,
        user: options.user ?? DEFAULT_PG_CONFIG.user,
        password: options.password ?? DEFAULT_PG_CONFIG.password,
      });
      this.ownedPool = pool;
    }
    this.runtimePool = pool;
  }

  async init(): Promise<void> {
    const shape = await this.schemaProber(
      this.runtimePool,
      [...FACEBOOK_RULE_RUNTIME_REQUIREMENT.tables.keys()],
    );
    const verdict = classifySchemaCapability(FACEBOOK_RULE_RUNTIME_REQUIREMENT, shape);
    if (verdict.status !== 'ready') {
      throw new SchemaCapabilityError(
        {
          capability: 'facebook_rule_mode_runtime',
          sinceVersion: '0101_facebook_rule_policy_revision_runtime',
          ddl: [],
        },
        verdict,
      );
    }
    await this.recoverInterruptedBatches();
  }

  async getRuntimeView(
    accountId: string,
    rawPolicy: FacebookRuleRuntimePolicy = DEFAULT_FACEBOOK_RULE_RUNTIME_POLICY,
  ): Promise<FacebookRuleModeRuntimeView> {
    const policy = normalizePolicy(rawPolicy);
    const [progress, batch] = await Promise.all([
      this.runtimePool.query<{
        view_count: number | string;
        collecting_sequence: number | string;
        policy_snapshot: unknown;
        updated_at: Date | string;
      }>(
        `SELECT view_count, collecting_sequence, policy_snapshot, updated_at
           FROM facebook_rule_progress
          WHERE account_id=$1 AND execution_target=$2
            AND definition_id=$3 AND definition_version=$4 AND policy_revision=$5`,
        [
          accountId,
          this.executionTarget,
          FACEBOOK_RULE_RUNTIME_DEFINITION_ID,
          FACEBOOK_RULE_RUNTIME_DEFINITION_VERSION,
          policy.policyRevision,
        ],
      ),
      this.runtimePool.query<BatchDbRow>(
        `SELECT ${BATCH_SELECT}
           FROM facebook_rule_batch
          WHERE account_id=$1 AND execution_target=$2
            AND definition_id=$3 AND definition_version=$4 AND policy_revision=$5
          ORDER BY sequence DESC
          LIMIT 1`,
        [
          accountId,
          this.executionTarget,
          FACEBOOK_RULE_RUNTIME_DEFINITION_ID,
          FACEBOOK_RULE_RUNTIME_DEFINITION_VERSION,
          policy.policyRevision,
        ],
      ),
    ]);
    const progressRow = progress.rows[0];
    if (progressRow && !sameSnapshot(snapshotFromDb(progressRow.policy_snapshot), policy.snapshot)) {
      throw new Error('facebook_rule_policy_snapshot_mismatch');
    }
    const collectingSequence = Number(progressRow?.collecting_sequence ?? 1);
    return {
      policyRevision: policy.policyRevision,
      viewCount: Number(progressRow?.view_count ?? 0),
      threshold: policy.snapshot.viewsPerLike,
      joinEveryNRounds: policy.snapshot.joinEveryNRounds,
      collectingSequence,
      collectingRoundIncludesJoin: facebookRuleRoundIncludesJoin(
        collectingSequence,
        policy.snapshot.joinEveryNRounds,
      ),
      currentBatch: batch.rows[0] ? batchFromDb(batch.rows[0]) : null,
      updatedAt: progressRow?.updated_at
        ? new Date(progressRow.updated_at).toISOString()
        : null,
    };
  }

  async applyConfirmedView(input: {
    accountId: string;
    contentKey: string;
    sourceDedupeKey: string;
    occurredAt: number;
    policy?: FacebookRuleRuntimePolicy;
  }): Promise<ApplyFacebookRuleViewResult> {
    const policy = normalizePolicy(input.policy);
    const client = await this.runtimePool.connect();
    try {
      await client.query('BEGIN');
      const transitioned = await this.supersedeOtherRevisionBatches(
        client,
        input.accountId,
        policy.policyRevision,
      );
      const blocking = transitioned.find((row) => row.terminal !== true);
      if (blocking) {
        await client.query('COMMIT');
        return { kind: 'batch_active', batchId: blocking.batch_id };
      }
      if (transitioned.length > 0) {
        await client.query('COMMIT');
        return {
          kind: 'policy_superseded',
          batchIds: transitioned.map((row) => row.batch_id),
        };
      }
      await client.query(
        `INSERT INTO facebook_rule_progress
           (account_id, execution_target, definition_id, definition_version,
            policy_revision, policy_snapshot)
         VALUES ($1,$2,$3,$4,$5,$6::jsonb)
         ON CONFLICT DO NOTHING`,
        [
          input.accountId,
          this.executionTarget,
          FACEBOOK_RULE_RUNTIME_DEFINITION_ID,
          FACEBOOK_RULE_RUNTIME_DEFINITION_VERSION,
          policy.policyRevision,
          JSON.stringify(policy.snapshot),
        ],
      );
      const progress = await client.query<{
        collecting_sequence: number | string;
        view_count: number | string;
        active_batch_id: string | null;
        policy_snapshot: unknown;
      }>(
        `SELECT collecting_sequence, view_count, active_batch_id, policy_snapshot
           FROM facebook_rule_progress
          WHERE account_id=$1 AND execution_target=$2
            AND definition_id=$3 AND definition_version=$4 AND policy_revision=$5
          FOR UPDATE`,
        [
          input.accountId,
          this.executionTarget,
          FACEBOOK_RULE_RUNTIME_DEFINITION_ID,
          FACEBOOK_RULE_RUNTIME_DEFINITION_VERSION,
          policy.policyRevision,
        ],
      );
      const row = progress.rows[0]!;
      if (!sameSnapshot(snapshotFromDb(row.policy_snapshot), policy.snapshot)) {
        throw new Error('facebook_rule_policy_snapshot_mismatch');
      }
      if (row.active_batch_id) {
        await client.query('COMMIT');
        return { kind: 'batch_active', batchId: row.active_batch_id };
      }
      const sequence = Number(row.collecting_sequence);
      const inserted = await client.query(
        `INSERT INTO facebook_rule_view_fact
           (account_id, execution_target, definition_id, definition_version,
            policy_revision, collecting_sequence, content_key, source_dedupe_key, occurred_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         ON CONFLICT DO NOTHING
         RETURNING content_key`,
        [
          input.accountId,
          this.executionTarget,
          FACEBOOK_RULE_RUNTIME_DEFINITION_ID,
          FACEBOOK_RULE_RUNTIME_DEFINITION_VERSION,
          policy.policyRevision,
          sequence,
          input.contentKey,
          input.sourceDedupeKey,
          new Date(input.occurredAt),
        ],
      );
      const currentCount = Number(row.view_count);
      if (inserted.rowCount === 0) {
        await client.query('COMMIT');
        return { kind: 'duplicate', viewCount: currentCount };
      }
      const nextCount = currentCount + 1;
      if (nextCount < policy.snapshot.viewsPerLike) {
        await client.query(
          `UPDATE facebook_rule_progress
              SET view_count=$6, updated_at=now()
            WHERE account_id=$1 AND execution_target=$2
              AND definition_id=$3 AND definition_version=$4 AND policy_revision=$5`,
          [
            input.accountId,
            this.executionTarget,
            FACEBOOK_RULE_RUNTIME_DEFINITION_ID,
            FACEBOOK_RULE_RUNTIME_DEFINITION_VERSION,
            policy.policyRevision,
            nextCount,
          ],
        );
        await client.query('COMMIT');
        return { kind: 'counted', viewCount: nextCount };
      }
      const batchId = randomUUID();
      const created = await client.query<BatchDbRow>(
        `INSERT INTO facebook_rule_batch
           (batch_id, account_id, execution_target, definition_id, definition_version,
            policy_revision, policy_snapshot, sequence, trigger_content_key)
         VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9)
         ON CONFLICT (
           account_id, execution_target, definition_id, definition_version, policy_revision, sequence
         )
         DO UPDATE SET trigger_content_key=facebook_rule_batch.trigger_content_key
         RETURNING ${BATCH_SELECT}`,
        [
          batchId,
          input.accountId,
          this.executionTarget,
          FACEBOOK_RULE_RUNTIME_DEFINITION_ID,
          FACEBOOK_RULE_RUNTIME_DEFINITION_VERSION,
          policy.policyRevision,
          JSON.stringify(policy.snapshot),
          sequence,
          input.contentKey,
        ],
      );
      const actualBatch = created.rows[0]!;
      await client.query(
        `UPDATE facebook_rule_progress
            SET collecting_sequence=$6, view_count=0, active_batch_id=$7, updated_at=now()
          WHERE account_id=$1 AND execution_target=$2
            AND definition_id=$3 AND definition_version=$4 AND policy_revision=$5`,
        [
          input.accountId,
          this.executionTarget,
          FACEBOOK_RULE_RUNTIME_DEFINITION_ID,
          FACEBOOK_RULE_RUNTIME_DEFINITION_VERSION,
          policy.policyRevision,
          sequence + 1,
          actualBatch.batch_id,
        ],
      );
      await client.query('COMMIT');
      return { kind: 'batch_created', batch: batchFromDb(actualBatch) };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async updateBatch(
    batchId: string,
    patch: {
      likeState?: FacebookRuleActionState;
      joinState?: FacebookRuleActionState;
      commentState?: FacebookRuleActionState;
      terminal?: boolean;
      blocker?: string | null;
    },
  ): Promise<FacebookRuleModeBatchView | null> {
    const client = await this.runtimePool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query<BatchDbRow>(
        `UPDATE facebook_rule_batch
            SET like_state=COALESCE($2, like_state),
                join_state=COALESCE($3, join_state),
                comment_state=COALESCE($4, comment_state),
                terminal=COALESCE($5, terminal),
                blocker=CASE WHEN $6 THEN $7 ELSE blocker END,
                updated_at=now()
          WHERE batch_id=$1 AND execution_target=$8
          RETURNING ${BATCH_SELECT}`,
        [
          batchId,
          patch.likeState ?? null,
          patch.joinState ?? null,
          patch.commentState ?? null,
          patch.terminal ?? null,
          Object.prototype.hasOwnProperty.call(patch, 'blocker'),
          patch.blocker ?? null,
          this.executionTarget,
        ],
      );
      if (!rows[0]) {
        await client.query('COMMIT');
        return null;
      }
      if (patch.terminal === true) {
        await client.query(
          `UPDATE facebook_rule_progress
              SET active_batch_id=NULL, updated_at=now()
            WHERE active_batch_id=$1 AND execution_target=$2`,
          [batchId, this.executionTarget],
        );
      }
      await client.query('COMMIT');
      return batchFromDb(rows[0]);
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async supersedeOtherRevisions(accountId: string, policyRevision: number): Promise<number> {
    if (!Number.isSafeInteger(policyRevision) || policyRevision < 0) {
      throw new Error('facebook_rule_policy_revision_invalid');
    }
    const client = await this.runtimePool.connect();
    try {
      await client.query('BEGIN');
      const superseded = await this.supersedeOtherRevisionBatches(
        client,
        accountId,
        policyRevision,
      );
      await client.query('COMMIT');
      return superseded.length;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  private async supersedeOtherRevisionBatches(
    client: pg.PoolClient,
    accountId: string,
    policyRevision: number,
  ): Promise<RevisionTransitionBatchRow[]> {
    const superseded = await client.query<RevisionTransitionBatchRow>(
      `UPDATE facebook_rule_batch
          SET like_state=CASE
                WHEN like_state IN ('pending','not_started') THEN 'policy_superseded'
                ELSE like_state
              END,
              join_state=CASE
                WHEN join_state IN ('pending','not_started') THEN 'policy_superseded'
                ELSE join_state
              END,
              comment_state=CASE
                WHEN comment_state IN ('pending','not_started') THEN 'policy_superseded'
                ELSE comment_state
              END,
              terminal=NOT (
                like_state='dispatched' OR join_state='dispatched' OR comment_state='dispatched'
              ),
              blocker='policy_superseded',
              updated_at=now()
        WHERE account_id=$1 AND execution_target=$2
          AND definition_id=$3 AND definition_version=$4
          AND policy_revision<>$5 AND terminal=false
        RETURNING batch_id, terminal`,
      [
        accountId,
        this.executionTarget,
        FACEBOOK_RULE_RUNTIME_DEFINITION_ID,
        FACEBOOK_RULE_RUNTIME_DEFINITION_VERSION,
        policyRevision,
      ],
    );
    const terminalBatchIds = superseded.rows
      .filter((row) => row.terminal === true)
      .map((row) => row.batch_id);
    if (terminalBatchIds.length > 0) {
      await client.query(
        `UPDATE facebook_rule_progress
            SET active_batch_id=NULL, updated_at=now()
          WHERE account_id=$1 AND execution_target=$2
            AND active_batch_id=ANY($3::uuid[])`,
        [accountId, this.executionTarget, terminalBatchIds],
      );
    }
    return superseded.rows;
  }

  async close(): Promise<void> {
    await this.ownedPool?.end();
  }

  private async recoverInterruptedBatches(): Promise<void> {
    const client = await this.runtimePool.connect();
    try {
      await client.query('BEGIN');
      const recovered = await client.query<{ batch_id: string }>(
        `UPDATE facebook_rule_batch
            SET like_state=CASE
                  WHEN like_state='pending' THEN 'not_started'
                  WHEN like_state='dispatched' THEN 'ambiguous'
                  ELSE like_state
                END,
                join_state=CASE
                  WHEN join_state='pending' THEN 'not_started'
                  WHEN join_state='dispatched' THEN 'ambiguous'
                  ELSE join_state
                END,
                comment_state=CASE
                  WHEN comment_state='pending' THEN 'not_started'
                  WHEN comment_state='dispatched' THEN 'submitted_unknown'
                  ELSE comment_state
                END,
                terminal=true,
                blocker='recovered_after_restart',
                updated_at=now()
          WHERE execution_target=$1 AND terminal=false
          RETURNING batch_id`,
        [this.executionTarget],
      );
      if (recovered.rows.length > 0) {
        await client.query(
          `UPDATE facebook_rule_progress
              SET active_batch_id=NULL, updated_at=now()
            WHERE execution_target=$1
              AND active_batch_id=ANY($2::uuid[])`,
          [this.executionTarget, recovered.rows.map((row) => row.batch_id)],
        );
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
}
