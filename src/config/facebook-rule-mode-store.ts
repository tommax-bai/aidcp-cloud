import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { DEFAULT_PG_CONFIG } from '../kernel/pg-config.js';
import {
  SchemaCapabilityError,
  classifySchemaCapability,
  type SchemaProber,
} from '../kernel/schema-capability-contract.js';
import type { DeploymentTarget } from '../deployment-target.js';
import { normalizePlatformId } from '../kernel/platform-types.js';
import { writeWithMirrorBump, type MirrorVersionBumper } from './mirror-version-store.js';

const { Pool } = pg;

export const FACEBOOK_RULE_DEFINITION_ID = 'facebook_browse_10_like_1_join_contact_1';
export const FACEBOOK_RULE_DEFINITION_VERSION = 1;
export const FACEBOOK_RULE_VIEW_THRESHOLD = 10;

export type FacebookRuleActionState =
  | 'pending'
  | 'dispatched'
  | 'confirmed'
  | 'already_satisfied'
  | 'risk_suppressed'
  | 'structural_skip'
  | 'not_started'
  | 'rejected'
  | 'failed'
  | 'ambiguous'
  | 'submitted_unknown';

export interface FacebookRuleModeConfig {
  accountId: string;
  enabled: boolean;
  definitionId: typeof FACEBOOK_RULE_DEFINITION_ID;
  definitionVersion: typeof FACEBOOK_RULE_DEFINITION_VERSION;
  updatedAt: string | null;
  updatedBy: string | null;
}

export interface FacebookRuleModeBatchView {
  batchId: string;
  sequence: number;
  triggerContentKey: string;
  likeState: FacebookRuleActionState;
  joinState: FacebookRuleActionState;
  commentState: FacebookRuleActionState;
  terminal: boolean;
  blocker: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface FacebookRuleModeRuntimeView {
  viewCount: number;
  threshold: typeof FACEBOOK_RULE_VIEW_THRESHOLD;
  currentBatch: FacebookRuleModeBatchView | null;
  updatedAt: string | null;
}

export interface FacebookRuleModeView {
  config: FacebookRuleModeConfig;
  runtime: FacebookRuleModeRuntimeView;
}

export type SetFacebookRuleModeResult =
  | { ok: true; row: FacebookRuleModeConfig }
  | { ok: false; reason: 'account_not_found' | 'unsupported_platform' | 'invalid_value' | 'no_valid_fields' };

export type ApplyFacebookRuleViewResult =
  | { kind: 'counted'; viewCount: number }
  | { kind: 'duplicate'; viewCount: number }
  | { kind: 'batch_active'; batchId: string }
  | { kind: 'batch_created'; batch: FacebookRuleModeBatchView };

const FACEBOOK_RULE_CONFIG_REQUIREMENT = {
  tables: new Map([
    ['facebook_rule_mode_config', new Set([
      'account_id',
      'enabled',
      'definition_id',
      'definition_version',
      'updated_at',
      'updated_by',
    ])],
  ]),
  indexes: new Map<string, string>(),
};

const FACEBOOK_RULE_RUNTIME_REQUIREMENT = {
  tables: new Map([
    ['facebook_rule_progress', new Set([
      'account_id',
      'execution_target',
      'definition_id',
      'definition_version',
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

interface ConfigDbRow {
  account_id: string;
  enabled: boolean;
  definition_id: string;
  definition_version: number | string;
  updated_at: Date | string | null;
  updated_by: string | null;
}

interface BatchDbRow {
  batch_id: string;
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

export interface FacebookRuleModeStoreOptions {
  /** 兼容单库测试；生产优先显式传 configPool/runtimePool。 */
  pool?: pg.Pool;
  configPool?: pg.Pool;
  runtimePool?: pg.Pool;
  host?: string;
  port?: number;
  database?: string;
  user?: string;
  password?: string;
  executionTarget: DeploymentTarget;
  schemaProber: SchemaProber;
  mirrorVersionBumper?: MirrorVersionBumper;
}

function defaultConfig(accountId: string): FacebookRuleModeConfig {
  return {
    accountId,
    enabled: false,
    definitionId: FACEBOOK_RULE_DEFINITION_ID,
    definitionVersion: FACEBOOK_RULE_DEFINITION_VERSION,
    updatedAt: null,
    updatedBy: null,
  };
}

function batchFromDb(row: BatchDbRow): FacebookRuleModeBatchView {
  return {
    batchId: row.batch_id,
    sequence: Number(row.sequence),
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

export class FacebookRuleModeStore {
  private readonly configPool: pg.Pool;
  private readonly runtimePool: pg.Pool;
  private readonly executionTarget: DeploymentTarget;
  private readonly schemaProber: SchemaProber;
  private readonly mirrorVersionBumper?: MirrorVersionBumper;
  private readonly ownedPools = new Set<pg.Pool>();
  private cache = new Map<string, FacebookRuleModeConfig>();

  constructor(options: FacebookRuleModeStoreOptions) {
    this.executionTarget = options.executionTarget;
    this.schemaProber = options.schemaProber;
    this.mirrorVersionBumper = options.mirrorVersionBumper;
    let fallbackPool = options.pool;
    if (!fallbackPool && (!options.configPool || !options.runtimePool)) {
      fallbackPool = new Pool({
        host: options.host ?? DEFAULT_PG_CONFIG.host,
        port: options.port ?? DEFAULT_PG_CONFIG.port,
        database: options.database ?? DEFAULT_PG_CONFIG.database,
        user: options.user ?? DEFAULT_PG_CONFIG.user,
        password: options.password ?? DEFAULT_PG_CONFIG.password,
      });
      this.ownedPools.add(fallbackPool);
    }
    const configPool = options.configPool ?? fallbackPool;
    const runtimePool = options.runtimePool ?? fallbackPool;
    if (!configPool) throw new Error('facebook_rule_mode_config_pool_required');
    if (!runtimePool) throw new Error('facebook_rule_mode_runtime_pool_required');
    this.configPool = configPool;
    this.runtimePool = runtimePool;
  }

  async init(): Promise<void> {
    await this.assertSchema(
      this.configPool,
      'facebook_rule_mode_config',
      '0092_facebook_rule_mode_config',
      FACEBOOK_RULE_CONFIG_REQUIREMENT,
    );
    await this.assertSchema(
      this.runtimePool,
      'facebook_rule_mode_runtime',
      '0093_facebook_rule_mode_runtime',
      FACEBOOK_RULE_RUNTIME_REQUIREMENT,
    );
    await this.recoverInterruptedBatches();
    await this.refreshFromAuthority();
  }

  async refreshFromAuthority(): Promise<void> {
    const { rows } = await this.configPool.query<ConfigDbRow>(
      `SELECT account_id, enabled, definition_id, definition_version, updated_at, updated_by
         FROM facebook_rule_mode_config`,
    );
    const next = new Map<string, FacebookRuleModeConfig>();
    for (const row of rows) next.set(row.account_id, this.configFromDb(row));
    this.cache = next;
  }

  getConfig(accountId: string): FacebookRuleModeConfig {
    return this.cache.get(accountId) ?? defaultConfig(accountId);
  }

  async setAccount(
    accountId: string,
    patch: { enabled?: boolean },
    updatedBy: string,
  ): Promise<SetFacebookRuleModeResult> {
    if (!Object.prototype.hasOwnProperty.call(patch, 'enabled')) {
      return { ok: false, reason: 'no_valid_fields' };
    }
    if (typeof patch.enabled !== 'boolean') return { ok: false, reason: 'invalid_value' };
    const account = await this.configPool.query<{ platform: string | null }>(
      `SELECT platform FROM accounts WHERE account_id = $1`,
      [accountId],
    );
    if (!account.rows[0]) return { ok: false, reason: 'account_not_found' };
    try {
      if (normalizePlatformId(account.rows[0].platform) !== 'facebook') {
        return { ok: false, reason: 'unsupported_platform' };
      }
    } catch {
      return { ok: false, reason: 'unsupported_platform' };
    }
    const { rows } = await writeWithMirrorBump(
      this.configPool,
      this.mirrorVersionBumper,
      'content_schedule',
      (q) => q.query<ConfigDbRow>(
        `INSERT INTO facebook_rule_mode_config
           (account_id, enabled, definition_id, definition_version, updated_at, updated_by)
         VALUES ($1, $2, $3, $4, now(), $5)
         ON CONFLICT (account_id) DO UPDATE
           SET enabled = EXCLUDED.enabled,
               definition_id = EXCLUDED.definition_id,
               definition_version = EXCLUDED.definition_version,
               updated_at = now(),
               updated_by = EXCLUDED.updated_by
         RETURNING account_id, enabled, definition_id, definition_version, updated_at, updated_by`,
        [accountId, patch.enabled, FACEBOOK_RULE_DEFINITION_ID, FACEBOOK_RULE_DEFINITION_VERSION, updatedBy],
      ),
    );
    const row = this.configFromDb(rows[0]!);
    this.cache.set(accountId, row);
    return { ok: true, row };
  }

  async getView(accountId: string): Promise<FacebookRuleModeView> {
    const [progress, batch] = await Promise.all([
      this.runtimePool.query<{ view_count: number | string; updated_at: Date | string }>(
        `SELECT view_count, updated_at
           FROM facebook_rule_progress
          WHERE account_id=$1 AND execution_target=$2
            AND definition_id=$3 AND definition_version=$4`,
        [accountId, this.executionTarget, FACEBOOK_RULE_DEFINITION_ID, FACEBOOK_RULE_DEFINITION_VERSION],
      ),
      this.runtimePool.query<BatchDbRow>(
        `SELECT batch_id, sequence, trigger_content_key, like_state, join_state,
                comment_state, terminal, blocker, created_at, updated_at
           FROM facebook_rule_batch
          WHERE account_id=$1 AND execution_target=$2
            AND definition_id=$3 AND definition_version=$4
          ORDER BY sequence DESC
          LIMIT 1`,
        [accountId, this.executionTarget, FACEBOOK_RULE_DEFINITION_ID, FACEBOOK_RULE_DEFINITION_VERSION],
      ),
    ]);
    const progressRow = progress.rows[0];
    return {
      config: this.getConfig(accountId),
      runtime: {
        viewCount: Number(progressRow?.view_count ?? 0),
        threshold: FACEBOOK_RULE_VIEW_THRESHOLD,
        currentBatch: batch.rows[0] ? batchFromDb(batch.rows[0]) : null,
        updatedAt: progressRow?.updated_at ? new Date(progressRow.updated_at).toISOString() : null,
      },
    };
  }

  async applyConfirmedView(input: {
    accountId: string;
    contentKey: string;
    sourceDedupeKey: string;
    occurredAt: number;
  }): Promise<ApplyFacebookRuleViewResult> {
    const client = await this.runtimePool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO facebook_rule_progress
           (account_id, execution_target, definition_id, definition_version)
         VALUES ($1,$2,$3,$4)
         ON CONFLICT DO NOTHING`,
        [input.accountId, this.executionTarget, FACEBOOK_RULE_DEFINITION_ID, FACEBOOK_RULE_DEFINITION_VERSION],
      );
      const progress = await client.query<{
        collecting_sequence: number | string;
        view_count: number | string;
        active_batch_id: string | null;
      }>(
        `SELECT collecting_sequence, view_count, active_batch_id
           FROM facebook_rule_progress
          WHERE account_id=$1 AND execution_target=$2
            AND definition_id=$3 AND definition_version=$4
          FOR UPDATE`,
        [input.accountId, this.executionTarget, FACEBOOK_RULE_DEFINITION_ID, FACEBOOK_RULE_DEFINITION_VERSION],
      );
      const row = progress.rows[0]!;
      if (row.active_batch_id) {
        await client.query('COMMIT');
        return { kind: 'batch_active', batchId: row.active_batch_id };
      }
      const sequence = Number(row.collecting_sequence);
      const inserted = await client.query(
        `INSERT INTO facebook_rule_view_fact
           (account_id, execution_target, definition_id, definition_version,
            collecting_sequence, content_key, source_dedupe_key, occurred_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT DO NOTHING
         RETURNING content_key`,
        [
          input.accountId,
          this.executionTarget,
          FACEBOOK_RULE_DEFINITION_ID,
          FACEBOOK_RULE_DEFINITION_VERSION,
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
      if (nextCount < FACEBOOK_RULE_VIEW_THRESHOLD) {
        await client.query(
          `UPDATE facebook_rule_progress
              SET view_count=$5, updated_at=now()
            WHERE account_id=$1 AND execution_target=$2
              AND definition_id=$3 AND definition_version=$4`,
          [input.accountId, this.executionTarget, FACEBOOK_RULE_DEFINITION_ID, FACEBOOK_RULE_DEFINITION_VERSION, nextCount],
        );
        await client.query('COMMIT');
        return { kind: 'counted', viewCount: nextCount };
      }
      const batchId = randomUUID();
      const created = await client.query<BatchDbRow>(
        `INSERT INTO facebook_rule_batch
           (batch_id, account_id, execution_target, definition_id, definition_version,
            sequence, trigger_content_key)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (account_id, execution_target, definition_id, definition_version, sequence)
         DO UPDATE SET trigger_content_key=facebook_rule_batch.trigger_content_key
         RETURNING batch_id, sequence, trigger_content_key, like_state, join_state,
                   comment_state, terminal, blocker, created_at, updated_at`,
        [
          batchId,
          input.accountId,
          this.executionTarget,
          FACEBOOK_RULE_DEFINITION_ID,
          FACEBOOK_RULE_DEFINITION_VERSION,
          sequence,
          input.contentKey,
        ],
      );
      const actualBatch = created.rows[0]!;
      await client.query(
        `UPDATE facebook_rule_progress
            SET collecting_sequence=$5, view_count=0, active_batch_id=$6, updated_at=now()
          WHERE account_id=$1 AND execution_target=$2
            AND definition_id=$3 AND definition_version=$4`,
        [
          input.accountId,
          this.executionTarget,
          FACEBOOK_RULE_DEFINITION_ID,
          FACEBOOK_RULE_DEFINITION_VERSION,
          sequence + 1,
          actualBatch.batch_id,
        ],
      );
      await client.query('COMMIT');
      return { kind: 'batch_created', batch: batchFromDb(actualBatch) };
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
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
          RETURNING batch_id, sequence, trigger_content_key, like_state, join_state,
                    comment_state, terminal, blocker, created_at, updated_at`,
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
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  async close(): Promise<void> {
    await Promise.all([...this.ownedPools].map((pool) => pool.end()));
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
          `UPDATE facebook_rule_progress p
              SET active_batch_id=NULL, updated_at=now()
            WHERE execution_target=$1
              AND active_batch_id = ANY($2::uuid[])`,
          [this.executionTarget, recovered.rows.map((row) => row.batch_id)],
        );
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  private configFromDb(row: ConfigDbRow): FacebookRuleModeConfig {
    return {
      accountId: row.account_id,
      enabled: row.enabled === true,
      definitionId: FACEBOOK_RULE_DEFINITION_ID,
      definitionVersion: FACEBOOK_RULE_DEFINITION_VERSION,
      updatedAt: row.updated_at ? new Date(row.updated_at).toISOString() : null,
      updatedBy: row.updated_by ?? null,
    };
  }

  private async assertSchema(
    pool: pg.Pool,
    capability: string,
    sinceVersion: string,
    required: {
      tables: Map<string, Set<string>>;
      indexes: Map<string, string>;
    },
  ): Promise<void> {
    const shape = await this.schemaProber(pool, [...required.tables.keys()]);
    const verdict = classifySchemaCapability(required, shape);
    if (verdict.status !== 'ready') {
      throw new SchemaCapabilityError(
        { capability, sinceVersion, ddl: [] },
        verdict,
      );
    }
  }
}
