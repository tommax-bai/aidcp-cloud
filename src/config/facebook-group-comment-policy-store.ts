import pg from 'pg';
import { DEFAULT_PG_CONFIG } from '../kernel/pg-config.js';
import {
  SchemaCapabilityError,
  classifySchemaCapability,
  type SchemaProber,
} from '../kernel/schema-capability-contract.js';
import type { MirrorVersionBumper } from './mirror-version-store.js';

const { Pool } = pg;

export const FACEBOOK_GROUP_COMMENT_POLICY_BOUNDS = {
  joinToFirstCommentHours: { min: 1, max: 168, default: 24 },
} as const;
export const FACEBOOK_GROUP_RECOMMENT_DEFAULT_HOURS = 72;

export interface FacebookGroupCommentPolicyView {
  joinToFirstCommentHours: number;
  revision: number | null;
  source: 'db' | 'legacy_env' | 'default';
  bounds: typeof FACEBOOK_GROUP_COMMENT_POLICY_BOUNDS;
  sameGroupRecommentCooldownHours: number | null;
  sameGroupRecommentCooldownSource?: 'legacy_env' | 'default' | 'unavailable';
  updatedAt: string | null;
  updatedBy: string | null;
}

export type FacebookGroupCommentPolicyWriteResult =
  | { ok: true; view: FacebookGroupCommentPolicyView }
  | {
      ok: false;
      reason: 'invalid_value' | 'revision_conflict' | 'policy_unavailable';
      current?: FacebookGroupCommentPolicyView;
    };

interface GroupCommentPolicyDbRow {
  execution_target: 'dev' | 'ol';
  join_to_first_comment_hours: number | string;
  revision: number | string;
  updated_at: Date | string;
  updated_by: string;
}

const GROUP_COMMENT_POLICY_REQUIREMENT = {
  tables: new Map([
    ['facebook_group_comment_policy', new Set([
      'execution_target',
      'join_to_first_comment_hours',
      'revision',
      'updated_at',
      'updated_by',
    ])],
    ['facebook_group_comment_policy_audit', new Set([
      'audit_id',
      'execution_target',
      'prior_revision',
      'new_revision',
      'before_policy',
      'after_policy',
      'actor_class',
      'actor_id',
      'request_id',
      'reason',
      'created_at',
    ])],
  ]),
  indexes: new Map([
    [
      'idx_facebook_group_comment_policy_audit_target_revision',
      'facebook_group_comment_policy_audit',
    ],
  ]),
};

export interface FacebookGroupCommentPolicyStoreOptions {
  pool?: pg.Pool;
  host?: string;
  port?: number;
  database?: string;
  user?: string;
  password?: string;
  executionTarget: 'dev' | 'ol';
  schemaProber: SchemaProber;
  mirrorVersionBumper?: MirrorVersionBumper;
  legacyWarmupHours?: () => unknown;
  legacyRecommentCooldownHours?: () => unknown;
}

function asIso(value: Date | string | null): string | null {
  if (value == null) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function actorParts(actor: string): { actorClass: string; actorId: string } {
  const normalized = String(actor || '').trim();
  const separator = normalized.indexOf(':');
  if (separator <= 0) return { actorClass: 'system', actorId: normalized || 'unknown' };
  return {
    actorClass: normalized.slice(0, separator),
    actorId: normalized.slice(separator + 1) || 'unknown',
  };
}

function boundedInteger(
  value: unknown,
  bound: { readonly min: number; readonly max: number },
): number | null {
  if (typeof value === 'string' && value.trim() !== '') value = Number(value);
  if (!Number.isInteger(value)) return null;
  const number = Number(value);
  return number >= bound.min && number <= bound.max ? number : null;
}

function positiveNumber(value: unknown): number | null {
  if (typeof value === 'string' && value.trim() !== '') value = Number(value);
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

export class FacebookGroupCommentPolicyStore {
  private readonly pool: pg.Pool;
  private readonly ownedPool?: pg.Pool;
  private readonly executionTarget: 'dev' | 'ol';
  private readonly schemaProber: SchemaProber;
  private readonly mirrorVersionBumper?: MirrorVersionBumper;
  private readonly legacyWarmupHours?: () => unknown;
  private readonly legacyRecommentCooldownHours?: () => unknown;
  private row: GroupCommentPolicyDbRow | null = null;
  private ready = false;

  constructor(options: FacebookGroupCommentPolicyStoreOptions) {
    this.executionTarget = options.executionTarget;
    this.schemaProber = options.schemaProber;
    this.mirrorVersionBumper = options.mirrorVersionBumper;
    this.legacyWarmupHours = options.legacyWarmupHours;
    this.legacyRecommentCooldownHours = options.legacyRecommentCooldownHours;
    let pool = options.pool;
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
    this.pool = pool;
  }

  async init(): Promise<void> {
    const shape = await this.schemaProber(
      this.pool,
      [...GROUP_COMMENT_POLICY_REQUIREMENT.tables.keys()],
    );
    const verdict = classifySchemaCapability(GROUP_COMMENT_POLICY_REQUIREMENT, shape);
    if (verdict.status !== 'ready') {
      throw new SchemaCapabilityError(
        {
          capability: 'facebook_group_comment_policy',
          sinceVersion: '0100_facebook_operation_and_group_comment_policy',
          ddl: [],
        },
        verdict,
      );
    }
    await this.refreshFromAuthority();
    this.ready = true;
  }

  async refreshFromAuthority(): Promise<void> {
    const { rows } = await this.pool.query<GroupCommentPolicyDbRow>(
      `SELECT execution_target,join_to_first_comment_hours,revision,updated_at,updated_by
         FROM facebook_group_comment_policy
        WHERE execution_target=$1`,
      [this.executionTarget],
    );
    this.row = rows[0] ?? null;
  }

  isReady(): boolean {
    return this.ready;
  }

  get(): FacebookGroupCommentPolicyView | null {
    if (!this.ready) return null;
    const recomment = positiveNumber(this.legacyRecommentCooldownHours?.());
    if (this.row) {
      return {
        joinToFirstCommentHours: Number(this.row.join_to_first_comment_hours),
        revision: Number(this.row.revision),
        source: 'db',
        bounds: FACEBOOK_GROUP_COMMENT_POLICY_BOUNDS,
        sameGroupRecommentCooldownHours: recomment ?? FACEBOOK_GROUP_RECOMMENT_DEFAULT_HOURS,
        sameGroupRecommentCooldownSource: recomment === null ? 'default' : 'legacy_env',
        updatedAt: asIso(this.row.updated_at),
        updatedBy: this.row.updated_by ?? null,
      };
    }
    const legacy = boundedInteger(
      this.legacyWarmupHours?.(),
      FACEBOOK_GROUP_COMMENT_POLICY_BOUNDS.joinToFirstCommentHours,
    );
    return {
      joinToFirstCommentHours:
        legacy ?? FACEBOOK_GROUP_COMMENT_POLICY_BOUNDS.joinToFirstCommentHours.default,
      revision: null,
      source: legacy === null ? 'default' : 'legacy_env',
      bounds: FACEBOOK_GROUP_COMMENT_POLICY_BOUNDS,
      sameGroupRecommentCooldownHours: recomment ?? FACEBOOK_GROUP_RECOMMENT_DEFAULT_HOURS,
      sameGroupRecommentCooldownSource: recomment === null ? 'default' : 'legacy_env',
      updatedAt: null,
      updatedBy: null,
    };
  }

  joinToFirstCommentMs(): number | null {
    const view = this.get();
    return view ? view.joinToFirstCommentHours * 60 * 60 * 1000 : null;
  }

  async write(
    input: {
      expectedRevision: number;
      joinToFirstCommentHours: number;
      requestId: string;
      reason?: string | null;
    },
    actor: string,
  ): Promise<FacebookGroupCommentPolicyWriteResult> {
    if (!this.ready) return { ok: false, reason: 'policy_unavailable' };
    if (
      !Number.isInteger(input.expectedRevision)
      || input.expectedRevision < 0
      || boundedInteger(
        input.joinToFirstCommentHours,
        FACEBOOK_GROUP_COMMENT_POLICY_BOUNDS.joinToFirstCommentHours,
      ) === null
      || !String(input.requestId || '').trim()
      || (
        input.reason !== undefined
        && input.reason !== null
        && typeof input.reason !== 'string'
      )
    ) {
      return { ok: false, reason: 'invalid_value' };
    }

    const client = await this.pool.connect();
    let committed = false;
    try {
      await client.query('BEGIN');
      const currentResult = await client.query<GroupCommentPolicyDbRow>(
        `SELECT execution_target,join_to_first_comment_hours,revision,updated_at,updated_by
           FROM facebook_group_comment_policy
          WHERE execution_target=$1
          FOR UPDATE`,
        [this.executionTarget],
      );
      const current = currentResult.rows[0];
      const currentRevision = current ? Number(current.revision) : 0;
      if (currentRevision !== input.expectedRevision) {
        await client.query('ROLLBACK');
        await this.refreshFromAuthority();
        return {
          ok: false,
          reason: 'revision_conflict',
          ...(this.get() ? { current: this.get()! } : {}),
        };
      }
      const newRevision = currentRevision + 1;
      const written = current
        ? await client.query<GroupCommentPolicyDbRow>(
            `UPDATE facebook_group_comment_policy
                SET join_to_first_comment_hours=$2,
                    revision=$3,
                    updated_at=now(),
                    updated_by=$4
              WHERE execution_target=$1
              RETURNING execution_target,join_to_first_comment_hours,revision,updated_at,updated_by`,
            [
              this.executionTarget,
              input.joinToFirstCommentHours,
              newRevision,
              actor,
            ],
          )
        : await client.query<GroupCommentPolicyDbRow>(
            `INSERT INTO facebook_group_comment_policy
               (execution_target,join_to_first_comment_hours,revision,updated_at,updated_by)
             VALUES ($1,$2,$3,now(),$4)
             RETURNING execution_target,join_to_first_comment_hours,revision,updated_at,updated_by`,
            [
              this.executionTarget,
              input.joinToFirstCommentHours,
              newRevision,
              actor,
            ],
          );
      const actorInfo = actorParts(actor);
      await client.query(
        `INSERT INTO facebook_group_comment_policy_audit
           (execution_target,prior_revision,new_revision,before_policy,after_policy,
            actor_class,actor_id,request_id,reason,created_at)
         VALUES ($1,$2,$3,$4::jsonb,$5::jsonb,$6,$7,$8,$9,now())`,
        [
          this.executionTarget,
          currentRevision,
          newRevision,
          current
            ? JSON.stringify({
                joinToFirstCommentHours: Number(current.join_to_first_comment_hours),
                revision: currentRevision,
              })
            : null,
          JSON.stringify({
            joinToFirstCommentHours: input.joinToFirstCommentHours,
            revision: newRevision,
          }),
          actorInfo.actorClass,
          actorInfo.actorId,
          input.requestId,
          input.reason ?? null,
        ],
      );
      await this.mirrorVersionBumper?.bumpInTx(client, 'content_schedule');
      await client.query('COMMIT');
      committed = true;
      this.row = written.rows[0];
      this.mirrorVersionBumper?.notifyAfterCommit?.('content_schedule');
      return { ok: true, view: this.get()! };
    } catch (error) {
      if (!committed) await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async close(): Promise<void> {
    if (this.ownedPool) await this.ownedPool.end();
  }
}
