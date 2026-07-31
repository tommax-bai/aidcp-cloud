import pg from 'pg';
import { DEFAULT_PG_CONFIG } from '../kernel/pg-config.js';
import {
  SchemaCapabilityError,
  classifySchemaCapability,
  type SchemaProber,
} from '../kernel/schema-capability-contract.js';
import { normalizePlatformId } from '../kernel/platform-types.js';
import { shanghaiDayStartMs } from '../time/shanghai-day.js';
import type { MirrorVersionBumper } from './mirror-version-store.js';

const { Pool } = pg;

export const FACEBOOK_OPERATION_POLICY_SCHEMA_VERSION = 'facebook_operation_policy@1';

export const FACEBOOK_OPERATION_POLICY_BOUNDS = {
  rule: {
    viewsPerLike: { min: 1, max: 100, default: 5 },
    joinEveryNRounds: { min: 1, max: 20, default: 2 },
  },
  consumption: {
    viewsPerLike: { min: 1, max: 100, default: 5 },
    confirmedLikesPerJoin: { min: 1, max: 20, default: 2 },
    confirmedJoinsPerComment: { min: 1, max: 20, default: 2 },
  },
} as const;

export type FacebookBaseOperationMode = 'persona' | 'rule' | 'consumption';
export type FacebookRequestedOperationMode = FacebookBaseOperationMode | 'slow_start';
export type FacebookEffectiveOperationMode =
  | FacebookBaseOperationMode
  | 'slow_start'
  | 'blocked';

export interface FacebookRuleOperationParameters {
  viewsPerLike: number;
  joinEveryNRounds: number;
}

export interface FacebookConsumptionOperationParameters {
  viewsPerLike: number;
  confirmedLikesPerJoin: number;
  confirmedJoinsPerComment: number;
}

export interface FacebookOperationPolicyView {
  envKey: string;
  baseMode: FacebookBaseOperationMode;
  effectiveMode: FacebookEffectiveOperationMode | null;
  policyRevision: number;
  schemaVersion: string;
  rule: FacebookRuleOperationParameters;
  consumption: FacebookConsumptionOperationParameters;
  bounds: typeof FACEBOOK_OPERATION_POLICY_BOUNDS;
  slowStart: {
    state: 'active' | 'off' | 'graduated' | 'unknown';
    since: number | null;
    globallyDisabled: boolean;
  };
  binding: {
    state: 'bound' | 'unbound' | 'conflict' | 'unknown';
    accountId: string | null;
    accountDisplayName: string | null;
  };
  blocker: string | null;
  updatedAt: string | null;
  updatedBy: string | null;
}

export type FacebookOperationPolicyWriteResult =
  | { ok: true; view: FacebookOperationPolicyView }
  | {
      ok: false;
      reason:
        | 'environment_not_found'
        | 'environment_not_owned'
        | 'binding_conflict'
        | 'unsupported_platform'
        | 'invalid_value'
        | 'revision_conflict'
        | 'policy_unavailable';
      current?: FacebookOperationPolicyView;
    };

export type FacebookOperationPolicyLegacySlowStartWriteResult =
  | (Extract<FacebookOperationPolicyWriteResult, { ok: true }> & {
      slowStartSince: number | null;
    })
  | Extract<FacebookOperationPolicyWriteResult, { ok: false }>
  | { ok: false; reason: 'environment_not_owned' };

export type FacebookOperationPolicyLegacyRuleWriteResult =
  | {
      ok: true;
      view: FacebookOperationPolicyView;
      changed: boolean;
    }
  | Extract<FacebookOperationPolicyWriteResult, { ok: false }>
  | {
      ok: false;
      reason: 'mode_conflict';
      current?: FacebookOperationPolicyView;
    };

export type FacebookOperationPolicyEnvironmentResolver = (accountId: string) =>
  | { ok: true; envKey: string }
  | {
      ok: false;
      reason: 'binding_unknown' | 'binding_conflict' | 'binding_unavailable';
    };

export type FacebookOperationPolicySlowStartResolver = (
  accountId: string,
) => Promise<
  | {
      state: 'active' | 'off' | 'graduated';
      since: number | null;
      globallyDisabled: boolean;
    }
  | {
      state: 'unknown';
      since: number | null;
      globallyDisabled: boolean;
      blocker: string;
  }
>;

export type FacebookOperationPolicyEnvironmentSlowStartResolver = (input: {
  envKey: string;
  accountId: string | null;
  since: number;
}) => Promise<'active' | 'off' | 'graduated' | 'unknown'>;

export interface FacebookOperationPolicyAccountDecision {
  mode: FacebookEffectiveOperationMode;
  baseMode: FacebookBaseOperationMode | null;
  policyRevision: number | null;
  envKey: string | null;
  blocker: string | null;
  rule: FacebookRuleOperationParameters | null;
  consumption: FacebookConsumptionOperationParameters | null;
}

export interface FacebookOperationPolicyBaseProjection {
  envKey: string;
  baseMode: FacebookBaseOperationMode;
  policyRevision: number;
  rule: FacebookRuleOperationParameters;
  consumption: FacebookConsumptionOperationParameters;
  updatedAt: string | null;
  updatedBy: string | null;
}

export type FacebookOperationPolicyBaseResolution =
  | ({ ok: true } & FacebookOperationPolicyBaseProjection)
  | { ok: false; blocker: string };

interface OperationPolicyDbRow {
  env_key: string;
  base_mode: FacebookBaseOperationMode;
  rule_views_per_like: number | string;
  rule_join_every_n_rounds: number | string;
  consumption_views_per_like: number | string;
  consumption_confirmed_likes_per_join: number | string;
  consumption_confirmed_joins_per_comment: number | string;
  policy_schema_version: number | string;
  policy_revision: number | string;
  updated_at: Date | string;
  updated_by: string;
}

interface EnvironmentDbRow {
  platform: string | null;
  account_id: string | null;
  account_display_name: string | null;
  account_exists: boolean;
  slow_start_since: Date | string | null;
  duplicate_count: number | string;
  owner_count: number | string;
}

interface LockedEnvironmentDbRow {
  platform: string | null;
  account_id: string | null;
  slow_start_since: Date | string | null;
  duplicate_count: number | string;
  owner_count: number | string;
}

interface LegacyRuleModeDbRow {
  env_key: string;
  enabled: boolean;
  updated_at: Date | string;
  updated_by: string;
}

type CachedPolicy = FacebookOperationPolicyBaseProjection;

const OPERATION_POLICY_REQUIREMENT = {
  tables: new Map([
    ['facebook_operation_policy', new Set([
      'env_key',
      'base_mode',
      'rule_views_per_like',
      'rule_join_every_n_rounds',
      'consumption_views_per_like',
      'consumption_confirmed_likes_per_join',
      'consumption_confirmed_joins_per_comment',
      'policy_schema_version',
      'policy_revision',
      'updated_at',
      'updated_by',
    ])],
    ['facebook_operation_policy_audit', new Set([
      'audit_id',
      'env_key',
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
      'idx_facebook_operation_policy_audit_env_revision',
      'facebook_operation_policy_audit',
    ],
    [
      'uq_facebook_operation_policy_audit_revision',
      'facebook_operation_policy_audit',
    ],
  ]),
};

export interface FacebookOperationPolicyStoreOptions {
  pool?: pg.Pool;
  host?: string;
  port?: number;
  database?: string;
  user?: string;
  password?: string;
  schemaProber: SchemaProber;
  mirrorVersionBumper?: MirrorVersionBumper;
  environmentResolver?: FacebookOperationPolicyEnvironmentResolver;
  slowStartResolver?: FacebookOperationPolicySlowStartResolver;
  environmentSlowStartResolver?: FacebookOperationPolicyEnvironmentSlowStartResolver;
  slowStartRefresh?: () => Promise<void>;
}

function asIso(value: Date | string | null): string | null {
  if (value == null) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function asEpochMillis(value: Date | string | null): number | null {
  if (value == null) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date.getTime() : null;
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

function defaultCachedPolicy(envKey: string): CachedPolicy {
  return {
    envKey,
    baseMode: 'persona',
    policyRevision: 0,
    rule: {
      viewsPerLike: FACEBOOK_OPERATION_POLICY_BOUNDS.rule.viewsPerLike.default,
      joinEveryNRounds: FACEBOOK_OPERATION_POLICY_BOUNDS.rule.joinEveryNRounds.default,
    },
    consumption: {
      viewsPerLike: FACEBOOK_OPERATION_POLICY_BOUNDS.consumption.viewsPerLike.default,
      confirmedLikesPerJoin:
        FACEBOOK_OPERATION_POLICY_BOUNDS.consumption.confirmedLikesPerJoin.default,
      confirmedJoinsPerComment:
        FACEBOOK_OPERATION_POLICY_BOUNDS.consumption.confirmedJoinsPerComment.default,
    },
    updatedAt: null,
    updatedBy: null,
  };
}

function inIntegerBound(
  value: unknown,
  bound: { readonly min: number; readonly max: number },
): value is number {
  return Number.isInteger(value) && Number(value) >= bound.min && Number(value) <= bound.max;
}

function normalizedWrite(
  input: {
    expectedRevision: number;
    mode: FacebookRequestedOperationMode;
    rule?: FacebookRuleOperationParameters;
    consumption?: FacebookConsumptionOperationParameters;
    requestId: string;
    reason?: string | null;
    requiredOwnerUserId?: string;
  },
): { ok: true } | { ok: false; reason: 'invalid_value' } {
  if (!Number.isInteger(input.expectedRevision) || input.expectedRevision < 0) {
    return { ok: false, reason: 'invalid_value' };
  }
  if (!['persona', 'rule', 'consumption', 'slow_start'].includes(input.mode)) {
    return { ok: false, reason: 'invalid_value' };
  }
  if (!String(input.requestId || '').trim()) return { ok: false, reason: 'invalid_value' };
  if (input.reason !== undefined && input.reason !== null && typeof input.reason !== 'string') {
    return { ok: false, reason: 'invalid_value' };
  }
  if (
    (input.mode === 'persona' || input.mode === 'slow_start')
    && (input.rule !== undefined || input.consumption !== undefined)
  ) {
    return { ok: false, reason: 'invalid_value' };
  }
  if (input.mode === 'rule') {
    if (input.consumption !== undefined) return { ok: false, reason: 'invalid_value' };
    if (input.rule && (
      !inIntegerBound(input.rule.viewsPerLike, FACEBOOK_OPERATION_POLICY_BOUNDS.rule.viewsPerLike)
      || !inIntegerBound(
        input.rule.joinEveryNRounds,
        FACEBOOK_OPERATION_POLICY_BOUNDS.rule.joinEveryNRounds,
      )
    )) return { ok: false, reason: 'invalid_value' };
  }
  if (input.mode === 'consumption') {
    if (input.rule !== undefined) return { ok: false, reason: 'invalid_value' };
    if (input.consumption && (
      !inIntegerBound(
        input.consumption.viewsPerLike,
        FACEBOOK_OPERATION_POLICY_BOUNDS.consumption.viewsPerLike,
      )
      || !inIntegerBound(
        input.consumption.confirmedLikesPerJoin,
        FACEBOOK_OPERATION_POLICY_BOUNDS.consumption.confirmedLikesPerJoin,
      )
      || !inIntegerBound(
        input.consumption.confirmedJoinsPerComment,
        FACEBOOK_OPERATION_POLICY_BOUNDS.consumption.confirmedJoinsPerComment,
      )
    )) return { ok: false, reason: 'invalid_value' };
  }
  return { ok: true };
}

function normalizedLegacySlowStartWrite(
  input: {
    enabled: boolean;
    requestId: string;
    reason?: string | null;
  },
): { ok: true } | { ok: false; reason: 'invalid_value' } {
  if (typeof input.enabled !== 'boolean') return { ok: false, reason: 'invalid_value' };
  if (!String(input.requestId || '').trim()) return { ok: false, reason: 'invalid_value' };
  if (input.reason !== undefined && input.reason !== null && typeof input.reason !== 'string') {
    return { ok: false, reason: 'invalid_value' };
  }
  return { ok: true };
}

function normalizedLegacyRuleWrite(
  input: {
    enabled: boolean;
    expectedRevision: number;
    requestId: string;
    reason?: string | null;
  },
): { ok: true } | { ok: false; reason: 'invalid_value' } {
  if (typeof input.enabled !== 'boolean') return { ok: false, reason: 'invalid_value' };
  if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0) {
    return { ok: false, reason: 'invalid_value' };
  }
  if (!String(input.requestId || '').trim()) return { ok: false, reason: 'invalid_value' };
  if (input.reason !== undefined && input.reason !== null && typeof input.reason !== 'string') {
    return { ok: false, reason: 'invalid_value' };
  }
  return { ok: true };
}

export class FacebookOperationPolicyStore {
  private readonly pool: pg.Pool;
  private readonly ownedPool?: pg.Pool;
  private readonly schemaProber: SchemaProber;
  private readonly mirrorVersionBumper?: MirrorVersionBumper;
  private environmentResolver?: FacebookOperationPolicyEnvironmentResolver;
  private slowStartResolver?: FacebookOperationPolicySlowStartResolver;
  private environmentSlowStartResolver?: FacebookOperationPolicyEnvironmentSlowStartResolver;
  private slowStartRefresh?: () => Promise<void>;
  private cache = new Map<string, CachedPolicy>();
  private legacyFallbackCache = new Map<string, CachedPolicy>();
  private ready = false;

  constructor(options: FacebookOperationPolicyStoreOptions) {
    this.schemaProber = options.schemaProber;
    this.mirrorVersionBumper = options.mirrorVersionBumper;
    this.environmentResolver = options.environmentResolver;
    this.slowStartResolver = options.slowStartResolver;
    this.environmentSlowStartResolver = options.environmentSlowStartResolver;
    this.slowStartRefresh = options.slowStartRefresh;
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

  bindEnvironmentResolver(resolver: FacebookOperationPolicyEnvironmentResolver): void {
    this.environmentResolver = resolver;
  }

  bindSlowStartResolver(resolver: FacebookOperationPolicySlowStartResolver): void {
    this.slowStartResolver = resolver;
  }

  bindEnvironmentSlowStartResolver(
    resolver: FacebookOperationPolicyEnvironmentSlowStartResolver,
  ): void {
    this.environmentSlowStartResolver = resolver;
  }

  bindSlowStartRefresh(refresh: () => Promise<void>): void {
    this.slowStartRefresh = refresh;
  }

  async init(): Promise<void> {
    const shape = await this.schemaProber(
      this.pool,
      [...OPERATION_POLICY_REQUIREMENT.tables.keys()],
    );
    const verdict = classifySchemaCapability(OPERATION_POLICY_REQUIREMENT, shape);
    if (verdict.status !== 'ready') {
      throw new SchemaCapabilityError(
        {
          capability: 'facebook_operation_policy',
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
    const [policyResult, legacyResult] = await Promise.all([
      this.pool.query<OperationPolicyDbRow>(
        `SELECT env_key,base_mode,rule_views_per_like,rule_join_every_n_rounds,
                consumption_views_per_like,consumption_confirmed_likes_per_join,
                consumption_confirmed_joins_per_comment,policy_schema_version,
                policy_revision,updated_at,updated_by
           FROM facebook_operation_policy`,
      ),
      this.pool.query<LegacyRuleModeDbRow>(
        `SELECT env_key,enabled,updated_at,updated_by
           FROM facebook_rule_mode_environment_config`,
      ),
    ]);
    this.cache = new Map(
      policyResult.rows.map((row) => [row.env_key, this.cachedFromRow(row)]),
    );
    this.legacyFallbackCache = new Map(
      legacyResult.rows.map((row) => {
        const policy = defaultCachedPolicy(row.env_key);
        policy.baseMode = row.enabled === true ? 'rule' : 'persona';
        policy.updatedAt = asIso(row.updated_at);
        policy.updatedBy = row.updated_by ?? null;
        return [row.env_key, policy];
      }),
    );
  }

  isReady(): boolean {
    return this.ready;
  }

  getBaseForEnv(envKey: string): FacebookOperationPolicyBaseProjection | null {
    const key = String(envKey || '').trim();
    if (!this.ready || !key) return null;
    return this.policyForEnv(key);
  }

  resolveBaseForAccount(accountId: string): FacebookOperationPolicyBaseResolution {
    if (!this.ready) {
      return { ok: false, blocker: 'facebook_operation_policy_unavailable' };
    }
    const resolved = this.environmentResolver?.(String(accountId || '').trim());
    if (!resolved?.ok) {
      return {
        ok: false,
        blocker: `operation_environment_${resolved?.reason ?? 'binding_unavailable'}`,
      };
    }
    const policy = this.policyForEnv(resolved.envKey);
    return {
      ok: true,
      ...policy,
      rule: { ...policy.rule },
      consumption: { ...policy.consumption },
    };
  }

  async getForEnv(envKey: string): Promise<FacebookOperationPolicyView | null> {
    const key = String(envKey || '').trim();
    if (!this.ready || !key) return null;
    const environment = await this.readEnvironment(key);
    if (!environment) return null;
    try {
      if (normalizePlatformId(environment.platform) !== 'facebook') return null;
    } catch {
      return null;
    }
    const policy = this.policyForEnv(key);
    const duplicate = Number(environment.duplicate_count) > 1;
    const contended = Number(environment.owner_count) > 1;
    if (duplicate || contended) {
      return this.project(policy, {
        bindingState: 'conflict',
        accountId: environment.account_id,
        accountDisplayName: environment.account_display_name,
        slowStart: {
          state: 'unknown',
          since: null,
          globallyDisabled: false,
        },
        effectiveMode: 'blocked',
        blocker: 'operation_environment_binding_conflict',
      });
    }
    if (!environment.account_id || !environment.account_exists) {
      const slowStart = await this.resolveEnvironmentSlowStart(
        key,
        null,
        environment.slow_start_since,
      );
      return this.project(policy, {
        bindingState: 'unbound',
        accountId: null,
        accountDisplayName: null,
        slowStart,
        effectiveMode: null,
        blocker: null,
      });
    }
    return this.projectWithSlowStart(
      policy,
      environment.account_id,
      environment.account_display_name,
      'bound',
    );
  }

  async resolveForAccount(accountId: string): Promise<FacebookOperationPolicyAccountDecision> {
    if (!this.ready) {
      return {
        mode: 'blocked',
        baseMode: null,
        policyRevision: null,
        envKey: null,
        blocker: 'facebook_operation_policy_unavailable',
        rule: null,
        consumption: null,
      };
    }
    const resolved = this.resolveBaseForAccount(accountId);
    if (!resolved.ok) {
      return {
        mode: 'blocked',
        baseMode: null,
        policyRevision: null,
        envKey: null,
        blocker: resolved.blocker,
        rule: null,
        consumption: null,
      };
    }
    const policy = resolved;
    const slowStart = await this.resolveSlowStart(accountId);
    if (slowStart.state === 'unknown') {
      return {
        mode: 'blocked',
        baseMode: policy.baseMode,
        policyRevision: policy.policyRevision,
        envKey: resolved.envKey,
        blocker: slowStart.blocker,
        rule: policy.rule,
        consumption: policy.consumption,
      };
    }
    return {
      mode: slowStart.state === 'active' ? 'slow_start' : policy.baseMode,
      baseMode: policy.baseMode,
      policyRevision: policy.policyRevision,
      envKey: resolved.envKey,
      blocker: null,
      rule: policy.rule,
      consumption: policy.consumption,
    };
  }

  async writeEnvironment(
    envKey: string,
    input: {
      expectedRevision: number;
      mode: FacebookRequestedOperationMode;
      rule?: FacebookRuleOperationParameters;
      consumption?: FacebookConsumptionOperationParameters;
      requestId: string;
      reason?: string | null;
      requiredOwnerUserId?: string;
    },
    actor: string,
  ): Promise<FacebookOperationPolicyWriteResult> {
    if (!this.ready) return { ok: false, reason: 'policy_unavailable' };
    const key = String(envKey || '').trim();
    if (!key) return { ok: false, reason: 'environment_not_found' };
    const validation = normalizedWrite(input);
    if (!validation.ok) return validation;
    const requiredOwnerUserId = input.requiredOwnerUserId?.trim();
    if (input.requiredOwnerUserId !== undefined && !requiredOwnerUserId) {
      return { ok: false, reason: 'invalid_value' };
    }

    const client = await this.pool.connect();
    let committed = false;
    try {
      await client.query('BEGIN');
      const environment = await this.lockEnvironmentForWrite(client, key);
      if (!environment) {
        await client.query('ROLLBACK');
        return { ok: false, reason: 'environment_not_found' };
      }
      if (
        requiredOwnerUserId
        && !(await this.environmentOwnedBy(client, requiredOwnerUserId, key))
      ) {
        await client.query('ROLLBACK');
        return { ok: false, reason: 'environment_not_owned' };
      }
      try {
        if (normalizePlatformId(environment.platform) !== 'facebook') {
          await client.query('ROLLBACK');
          return { ok: false, reason: 'unsupported_platform' };
        }
      } catch {
        await client.query('ROLLBACK');
        return { ok: false, reason: 'unsupported_platform' };
      }
      if (this.hasBindingConflict(environment)) {
        await client.query('ROLLBACK');
        return { ok: false, reason: 'binding_conflict' };
      }

      const currentResult = await client.query<OperationPolicyDbRow>(
        `SELECT env_key,base_mode,rule_views_per_like,rule_join_every_n_rounds,
                consumption_views_per_like,consumption_confirmed_likes_per_join,
                consumption_confirmed_joins_per_comment,policy_schema_version,
                policy_revision,updated_at,updated_by
           FROM facebook_operation_policy
          WHERE env_key=$1
          FOR UPDATE`,
        [key],
      );
      const currentRow = currentResult.rows[0];
      const current = currentRow
        ? this.cachedFromRow(currentRow)
        : await this.readLegacyFallback(client, key);
      if (current.policyRevision !== input.expectedRevision) {
        await client.query('ROLLBACK');
        await this.refreshFromAuthority();
        const projection = await this.getForEnv(key);
        return {
          ok: false,
          reason: 'revision_conflict',
          ...(projection ? { current: projection } : {}),
        };
      }

      const nextRule = input.mode === 'rule' && input.rule ? input.rule : current.rule;
      const nextConsumption =
        input.mode === 'consumption' && input.consumption
          ? input.consumption
          : current.consumption;
      const nextBaseMode: FacebookBaseOperationMode =
        input.mode === 'slow_start' ? 'persona' : input.mode;
      const revisionResult = await client.query<{ revision: number | string }>(
        `SELECT nextval('facebook_operation_policy_revision_seq') AS revision`,
      );
      const nextRevision = Number(revisionResult.rows[0]?.revision);
      if (!Number.isSafeInteger(nextRevision) || nextRevision < 1) {
        throw new Error('facebook_operation_policy_revision_unavailable');
      }
      await client.query(
        `UPDATE client_environments
            SET slow_start_since=CASE
                  WHEN $2 THEN COALESCE(slow_start_since,$3)
                  ELSE NULL
                END,
                slow_start_initialized=true,
                updated_at=now()
          WHERE env_key=$1`,
        [
          key,
          input.mode === 'slow_start',
          new Date(shanghaiDayStartMs(Date.now())),
        ],
      );
      const written = currentRow
        ? await client.query<OperationPolicyDbRow>(
            `UPDATE facebook_operation_policy
                SET base_mode=$2,
                    rule_views_per_like=$3,
                    rule_join_every_n_rounds=$4,
                    consumption_views_per_like=$5,
                    consumption_confirmed_likes_per_join=$6,
                    consumption_confirmed_joins_per_comment=$7,
                    policy_schema_version=1,
                    policy_revision=$8,
                    updated_at=now(),
                    updated_by=$9
              WHERE env_key=$1
              RETURNING env_key,base_mode,rule_views_per_like,rule_join_every_n_rounds,
                        consumption_views_per_like,consumption_confirmed_likes_per_join,
                        consumption_confirmed_joins_per_comment,policy_schema_version,
                        policy_revision,updated_at,updated_by`,
            [
              key,
              nextBaseMode,
              nextRule.viewsPerLike,
              nextRule.joinEveryNRounds,
              nextConsumption.viewsPerLike,
              nextConsumption.confirmedLikesPerJoin,
              nextConsumption.confirmedJoinsPerComment,
              nextRevision,
              actor,
            ],
          )
        : await client.query<OperationPolicyDbRow>(
            `INSERT INTO facebook_operation_policy
               (env_key,base_mode,rule_views_per_like,rule_join_every_n_rounds,
                consumption_views_per_like,consumption_confirmed_likes_per_join,
                consumption_confirmed_joins_per_comment,policy_schema_version,
                policy_revision,updated_at,updated_by)
             VALUES ($1,$2,$3,$4,$5,$6,$7,1,$8,now(),$9)
             RETURNING env_key,base_mode,rule_views_per_like,rule_join_every_n_rounds,
                       consumption_views_per_like,consumption_confirmed_likes_per_join,
                       consumption_confirmed_joins_per_comment,policy_schema_version,
                       policy_revision,updated_at,updated_by`,
            [
              key,
              nextBaseMode,
              nextRule.viewsPerLike,
              nextRule.joinEveryNRounds,
              nextConsumption.viewsPerLike,
              nextConsumption.confirmedLikesPerJoin,
              nextConsumption.confirmedJoinsPerComment,
              nextRevision,
              actor,
            ],
          );
      const next = this.cachedFromRow(written.rows[0]);
      const actorInfo = actorParts(actor);
      await client.query(
        `INSERT INTO facebook_operation_policy_audit
           (env_key,prior_revision,new_revision,before_policy,after_policy,
            actor_class,actor_id,request_id,reason,created_at)
         VALUES ($1,$2,$3,$4::jsonb,$5::jsonb,$6,$7,$8,$9,now())`,
        [
          key,
          current.policyRevision,
          next.policyRevision,
          currentRow ? JSON.stringify(this.auditSnapshot(current)) : null,
          JSON.stringify(this.auditSnapshot(next)),
          actorInfo.actorClass,
          actorInfo.actorId,
          input.requestId,
          input.reason ?? null,
        ],
      );
      await this.mirrorVersionBumper?.bumpInTx(client, 'content_schedule');
      await this.mirrorVersionBumper?.bumpInTx(client, 'client_environment_slow_start');
      await client.query('COMMIT');
      committed = true;
      this.cache.set(key, next);
      this.mirrorVersionBumper?.notifyAfterCommit?.('content_schedule');
      this.mirrorVersionBumper?.notifyAfterCommit?.('client_environment_slow_start');
      await this.slowStartRefresh?.();
      const view = await this.getForEnv(key);
      if (!view) return { ok: false, reason: 'policy_unavailable' };
      return { ok: true, view };
    } catch (error) {
      if (!committed) await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async writeLegacyRuleMode(
    envKey: string,
    input: {
      enabled: boolean;
      expectedRevision: number;
      requestId: string;
      reason?: string | null;
      requiredOwnerUserId?: string;
    },
    actor: string,
  ): Promise<FacebookOperationPolicyLegacyRuleWriteResult> {
    if (!this.ready) return { ok: false, reason: 'policy_unavailable' };
    const key = String(envKey || '').trim();
    if (!key) return { ok: false, reason: 'environment_not_found' };
    const validation = normalizedLegacyRuleWrite(input);
    if (!validation.ok) return validation;
    const requiredOwnerUserId = input.requiredOwnerUserId?.trim();
    if (input.requiredOwnerUserId !== undefined && !requiredOwnerUserId) {
      return { ok: false, reason: 'invalid_value' };
    }

    const client = await this.pool.connect();
    let committed = false;
    try {
      await client.query('BEGIN');
      const environment = await this.lockEnvironmentForWrite(client, key);
      if (!environment) {
        await client.query('ROLLBACK');
        return { ok: false, reason: 'environment_not_found' };
      }
      if (
        requiredOwnerUserId
        && !(await this.environmentOwnedBy(client, requiredOwnerUserId, key))
      ) {
        await client.query('ROLLBACK');
        return { ok: false, reason: 'environment_not_owned' };
      }
      try {
        if (normalizePlatformId(environment.platform) !== 'facebook') {
          await client.query('ROLLBACK');
          return { ok: false, reason: 'unsupported_platform' };
        }
      } catch {
        await client.query('ROLLBACK');
        return { ok: false, reason: 'unsupported_platform' };
      }
      // The released rule toggle is environment-scoped and deliberately does
      // not require a unique account binding. A duplicate account may block
      // execution, but it must not create a second configuration authority.
      // Cross-customer ownership contention remains a hard write conflict.
      if (Number(environment.owner_count) > 1) {
        await client.query('ROLLBACK');
        return { ok: false, reason: 'binding_conflict' };
      }

      const currentResult = await client.query<OperationPolicyDbRow>(
        `SELECT env_key,base_mode,rule_views_per_like,rule_join_every_n_rounds,
                consumption_views_per_like,consumption_confirmed_likes_per_join,
                consumption_confirmed_joins_per_comment,policy_schema_version,
                policy_revision,updated_at,updated_by
           FROM facebook_operation_policy
          WHERE env_key=$1
          FOR UPDATE`,
        [key],
      );
      const currentRow = currentResult.rows[0];
      const current = currentRow
        ? this.cachedFromRow(currentRow)
        : await this.readLegacyFallback(client, key);
      if (current.policyRevision !== input.expectedRevision) {
        await client.query('ROLLBACK');
        await this.refreshFromAuthority();
        const currentView = await this.getForEnv(key);
        return {
          ok: false,
          reason: 'revision_conflict',
          ...(currentView ? { current: currentView } : {}),
        };
      }
      const slowStartConflict = await this.legacyRuleSlowStartConflict(key, environment);
      if (slowStartConflict === 'unknown') {
        await client.query('ROLLBACK');
        await this.refreshFromAuthority();
        const currentView = await this.getForEnv(key);
        return {
          ok: false,
          reason: 'policy_unavailable',
          ...(currentView ? { current: currentView } : {}),
        };
      }
      if (slowStartConflict === 'active' || current.baseMode === 'consumption') {
        await client.query('ROLLBACK');
        await this.refreshFromAuthority();
        const currentView = await this.getForEnv(key);
        return {
          ok: false,
          reason: 'mode_conflict',
          ...(currentView ? { current: currentView } : {}),
        };
      }

      const nextBaseMode: FacebookBaseOperationMode = input.enabled ? 'rule' : 'persona';
      const nextRule = input.enabled && current.baseMode === 'persona'
        ? {
            viewsPerLike: FACEBOOK_OPERATION_POLICY_BOUNDS.rule.viewsPerLike.default,
            joinEveryNRounds: FACEBOOK_OPERATION_POLICY_BOUNDS.rule.joinEveryNRounds.default,
          }
        : current.rule;
      if (currentRow && current.baseMode === nextBaseMode) {
        await client.query('COMMIT');
        committed = true;
        this.cache.set(key, current);
        const view = await this.getForEnv(key);
        if (!view) return { ok: false, reason: 'policy_unavailable' };
        return { ok: true, view, changed: false };
      }

      const revisionResult = await client.query<{ revision: number | string }>(
        `SELECT nextval('facebook_operation_policy_revision_seq') AS revision`,
      );
      const nextRevision = Number(revisionResult.rows[0]?.revision);
      if (!Number.isSafeInteger(nextRevision) || nextRevision < 1) {
        throw new Error('facebook_operation_policy_revision_unavailable');
      }
      const written = currentRow
        ? await client.query<OperationPolicyDbRow>(
            `UPDATE facebook_operation_policy
                SET base_mode=$2,
                    rule_views_per_like=$3,
                    rule_join_every_n_rounds=$4,
                    consumption_views_per_like=$5,
                    consumption_confirmed_likes_per_join=$6,
                    consumption_confirmed_joins_per_comment=$7,
                    policy_schema_version=1,
                    policy_revision=$8,
                    updated_at=now(),
                    updated_by=$9
              WHERE env_key=$1
              RETURNING env_key,base_mode,rule_views_per_like,rule_join_every_n_rounds,
                        consumption_views_per_like,consumption_confirmed_likes_per_join,
                        consumption_confirmed_joins_per_comment,policy_schema_version,
                        policy_revision,updated_at,updated_by`,
            [
              key,
              nextBaseMode,
              nextRule.viewsPerLike,
              nextRule.joinEveryNRounds,
              current.consumption.viewsPerLike,
              current.consumption.confirmedLikesPerJoin,
              current.consumption.confirmedJoinsPerComment,
              nextRevision,
              actor,
            ],
          )
        : await client.query<OperationPolicyDbRow>(
            `INSERT INTO facebook_operation_policy
               (env_key,base_mode,rule_views_per_like,rule_join_every_n_rounds,
                consumption_views_per_like,consumption_confirmed_likes_per_join,
                consumption_confirmed_joins_per_comment,policy_schema_version,
                policy_revision,updated_at,updated_by)
             VALUES ($1,$2,$3,$4,$5,$6,$7,1,$8,now(),$9)
             RETURNING env_key,base_mode,rule_views_per_like,rule_join_every_n_rounds,
                       consumption_views_per_like,consumption_confirmed_likes_per_join,
                       consumption_confirmed_joins_per_comment,policy_schema_version,
                       policy_revision,updated_at,updated_by`,
            [
              key,
              nextBaseMode,
              nextRule.viewsPerLike,
              nextRule.joinEveryNRounds,
              current.consumption.viewsPerLike,
              current.consumption.confirmedLikesPerJoin,
              current.consumption.confirmedJoinsPerComment,
              nextRevision,
              actor,
            ],
          );
      const next = this.cachedFromRow(written.rows[0]);
      const actorInfo = actorParts(actor);
      await client.query(
        `INSERT INTO facebook_operation_policy_audit
           (env_key,prior_revision,new_revision,before_policy,after_policy,
            actor_class,actor_id,request_id,reason,created_at)
         VALUES ($1,$2,$3,$4::jsonb,$5::jsonb,$6,$7,$8,$9,now())`,
        [
          key,
          current.policyRevision,
          next.policyRevision,
          currentRow ? JSON.stringify(this.auditSnapshot(current)) : null,
          JSON.stringify(this.auditSnapshot(next)),
          actorInfo.actorClass,
          actorInfo.actorId,
          input.requestId,
          input.reason
            ?? (input.enabled
              ? 'legacy_rule_mode_enabled'
              : 'legacy_rule_mode_disabled'),
        ],
      );
      await this.mirrorVersionBumper?.bumpInTx(client, 'content_schedule');
      await client.query('COMMIT');
      committed = true;
      this.cache.set(key, next);
      this.mirrorVersionBumper?.notifyAfterCommit?.('content_schedule');
      const view = await this.getForEnv(key);
      if (!view) return { ok: false, reason: 'policy_unavailable' };
      return { ok: true, view, changed: true };
    } catch (error) {
      if (!committed) await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async writeLegacySlowStart(
    envKey: string,
    input: {
      enabled: boolean;
      requestId: string;
      reason?: string | null;
      requiredOwnerUserId?: string;
    },
    actor: string,
  ): Promise<FacebookOperationPolicyLegacySlowStartWriteResult> {
    if (!this.ready) return { ok: false, reason: 'policy_unavailable' };
    const key = String(envKey || '').trim();
    if (!key) return { ok: false, reason: 'environment_not_found' };
    const validation = normalizedLegacySlowStartWrite(input);
    if (!validation.ok) return validation;
    const requiredOwnerUserId = input.requiredOwnerUserId?.trim();
    if (input.requiredOwnerUserId !== undefined && !requiredOwnerUserId) {
      return { ok: false, reason: 'invalid_value' };
    }

    const client = await this.pool.connect();
    let committed = false;
    try {
      await client.query('BEGIN');
      const environment = await this.lockEnvironmentForWrite(client, key);
      if (!environment) {
        await client.query('ROLLBACK');
        return { ok: false, reason: 'environment_not_found' };
      }
      if (
        requiredOwnerUserId
        && !(await this.environmentOwnedBy(client, requiredOwnerUserId, key))
      ) {
        await client.query('ROLLBACK');
        return { ok: false, reason: 'environment_not_owned' };
      }
      try {
        if (normalizePlatformId(environment.platform) !== 'facebook') {
          await client.query('ROLLBACK');
          return { ok: false, reason: 'unsupported_platform' };
        }
      } catch {
        await client.query('ROLLBACK');
        return { ok: false, reason: 'unsupported_platform' };
      }
      if (this.hasBindingConflict(environment)) {
        await client.query('ROLLBACK');
        return { ok: false, reason: 'binding_conflict' };
      }

      const currentResult = await client.query<OperationPolicyDbRow>(
        `SELECT env_key,base_mode,rule_views_per_like,rule_join_every_n_rounds,
                consumption_views_per_like,consumption_confirmed_likes_per_join,
                consumption_confirmed_joins_per_comment,policy_schema_version,
                policy_revision,updated_at,updated_by
           FROM facebook_operation_policy
          WHERE env_key=$1
          FOR UPDATE`,
        [key],
      );
      const currentRow = currentResult.rows[0];
      const current = currentRow
        ? this.cachedFromRow(currentRow)
        : await this.readLegacyFallback(client, key);
      const currentSlowStartSince = asEpochMillis(environment.slow_start_since);
      const currentlyEnabled = currentSlowStartSince !== null;
      if (currentRow && currentlyEnabled === input.enabled) {
        await client.query('COMMIT');
        committed = true;
        this.cache.set(key, current);
        const view = await this.getForEnv(key);
        if (!view) return { ok: false, reason: 'policy_unavailable' };
        return { ok: true, view, slowStartSince: currentSlowStartSince };
      }

      const revisionResult = await client.query<{ revision: number | string }>(
        `SELECT nextval('facebook_operation_policy_revision_seq') AS revision`,
      );
      const nextRevision = Number(revisionResult.rows[0]?.revision);
      if (!Number.isSafeInteger(nextRevision) || nextRevision < 1) {
        throw new Error('facebook_operation_policy_revision_unavailable');
      }
      const slowStartAnchor = new Date(shanghaiDayStartMs(Date.now()));
      await client.query(
        `UPDATE client_environments
            SET slow_start_since=CASE
                  WHEN $2 THEN COALESCE(slow_start_since,$3)
                  ELSE NULL
                END,
                slow_start_initialized=true,
                updated_at=now()
          WHERE env_key=$1`,
        [key, input.enabled, slowStartAnchor],
      );
      const written = currentRow
        ? await client.query<OperationPolicyDbRow>(
            `UPDATE facebook_operation_policy
                SET base_mode=$2,
                    rule_views_per_like=$3,
                    rule_join_every_n_rounds=$4,
                    consumption_views_per_like=$5,
                    consumption_confirmed_likes_per_join=$6,
                    consumption_confirmed_joins_per_comment=$7,
                    policy_schema_version=1,
                    policy_revision=$8,
                    updated_at=now(),
                    updated_by=$9
              WHERE env_key=$1
              RETURNING env_key,base_mode,rule_views_per_like,rule_join_every_n_rounds,
                        consumption_views_per_like,consumption_confirmed_likes_per_join,
                        consumption_confirmed_joins_per_comment,policy_schema_version,
                        policy_revision,updated_at,updated_by`,
            [
              key,
              current.baseMode,
              current.rule.viewsPerLike,
              current.rule.joinEveryNRounds,
              current.consumption.viewsPerLike,
              current.consumption.confirmedLikesPerJoin,
              current.consumption.confirmedJoinsPerComment,
              nextRevision,
              actor,
            ],
          )
        : await client.query<OperationPolicyDbRow>(
            `INSERT INTO facebook_operation_policy
               (env_key,base_mode,rule_views_per_like,rule_join_every_n_rounds,
                consumption_views_per_like,consumption_confirmed_likes_per_join,
                consumption_confirmed_joins_per_comment,policy_schema_version,
                policy_revision,updated_at,updated_by)
             VALUES ($1,$2,$3,$4,$5,$6,$7,1,$8,now(),$9)
             RETURNING env_key,base_mode,rule_views_per_like,rule_join_every_n_rounds,
                       consumption_views_per_like,consumption_confirmed_likes_per_join,
                       consumption_confirmed_joins_per_comment,policy_schema_version,
                       policy_revision,updated_at,updated_by`,
            [
              key,
              current.baseMode,
              current.rule.viewsPerLike,
              current.rule.joinEveryNRounds,
              current.consumption.viewsPerLike,
              current.consumption.confirmedLikesPerJoin,
              current.consumption.confirmedJoinsPerComment,
              nextRevision,
              actor,
            ],
          );
      const next = this.cachedFromRow(written.rows[0]);
      const actorInfo = actorParts(actor);
      const auditReason = input.reason
        ?? (currentlyEnabled === input.enabled
          ? 'legacy_slow_start_policy_materialized'
          : input.enabled
            ? 'legacy_slow_start_enabled'
            : 'legacy_slow_start_disabled');
      await client.query(
        `INSERT INTO facebook_operation_policy_audit
           (env_key,prior_revision,new_revision,before_policy,after_policy,
            actor_class,actor_id,request_id,reason,created_at)
         VALUES ($1,$2,$3,$4::jsonb,$5::jsonb,$6,$7,$8,$9,now())`,
        [
          key,
          current.policyRevision,
          next.policyRevision,
          currentRow ? JSON.stringify(this.auditSnapshot(current)) : null,
          JSON.stringify(this.auditSnapshot(next)),
          actorInfo.actorClass,
          actorInfo.actorId,
          input.requestId,
          auditReason,
        ],
      );
      await this.mirrorVersionBumper?.bumpInTx(client, 'content_schedule');
      await this.mirrorVersionBumper?.bumpInTx(client, 'client_environment_slow_start');
      await client.query('COMMIT');
      committed = true;
      this.cache.set(key, next);
      this.mirrorVersionBumper?.notifyAfterCommit?.('content_schedule');
      this.mirrorVersionBumper?.notifyAfterCommit?.('client_environment_slow_start');
      await this.slowStartRefresh?.();
      const view = await this.getForEnv(key);
      if (!view) return { ok: false, reason: 'policy_unavailable' };
      return {
        ok: true,
        view,
        slowStartSince: input.enabled
          ? currentSlowStartSince ?? slowStartAnchor.getTime()
          : null,
      };
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

  private policyForEnv(envKey: string): CachedPolicy {
    return this.cache.get(envKey)
      ?? this.legacyFallbackCache.get(envKey)
      ?? defaultCachedPolicy(envKey);
  }

  private async readLegacyFallback(
    client: pg.PoolClient,
    envKey: string,
  ): Promise<CachedPolicy> {
    const { rows } = await client.query<LegacyRuleModeDbRow>(
      `SELECT env_key,enabled,updated_at,updated_by
         FROM facebook_rule_mode_environment_config
        WHERE env_key=$1`,
      [envKey],
    );
    const row = rows[0];
    if (!row) return defaultCachedPolicy(envKey);
    const policy = defaultCachedPolicy(envKey);
    policy.baseMode = row.enabled === true ? 'rule' : 'persona';
    policy.updatedAt = asIso(row.updated_at);
    policy.updatedBy = row.updated_by ?? null;
    return policy;
  }

  private async lockEnvironmentForWrite(
    client: pg.PoolClient,
    envKey: string,
  ): Promise<LockedEnvironmentDbRow | null> {
    const { rows } = await client.query<LockedEnvironmentDbRow>(
      `SELECT e.platform,
              e.account_id,
              e.slow_start_since,
              CASE WHEN e.account_id IS NULL THEN 0
                   ELSE (SELECT count(*) FROM client_environments e2
                          WHERE e2.account_id=e.account_id
                            AND COALESCE(e2.lifecycle_state,'active')='active') END
                AS duplicate_count,
              (SELECT count(DISTINCT s.user_id)
                 FROM client_env_scope s
                WHERE s.env_key=e.env_key AND s.source='admin') AS owner_count
         FROM client_environments e
        WHERE e.env_key=$1
          AND COALESCE(e.lifecycle_state,'active')='active'
        FOR UPDATE OF e`,
      [envKey],
    );
    return rows[0] ?? null;
  }

  private async environmentOwnedBy(
    client: pg.PoolClient,
    userId: string,
    envKey: string,
  ): Promise<boolean> {
    // client_env_scope mutations also lock the environment row. Taking that
    // common serialization lock first makes this plain MVCC read atomic with
    // ownership transfer without introducing the scope→env / env→scope
    // deadlock that a second FOR UPDATE would create.
    const { rows } = await client.query(
      `SELECT 1 AS owned
         FROM client_env_scope
        WHERE user_id=$1 AND env_key=$2 AND source='admin'`,
      [userId, envKey],
    );
    return Boolean(rows[0]);
  }

  private hasBindingConflict(environment: LockedEnvironmentDbRow): boolean {
    return Number(environment.duplicate_count) > 1 || Number(environment.owner_count) > 1;
  }

  private cachedFromRow(row: OperationPolicyDbRow): CachedPolicy {
    return {
      envKey: row.env_key,
      baseMode: row.base_mode,
      policyRevision: Number(row.policy_revision),
      rule: {
        viewsPerLike: Number(row.rule_views_per_like),
        joinEveryNRounds: Number(row.rule_join_every_n_rounds),
      },
      consumption: {
        viewsPerLike: Number(row.consumption_views_per_like),
        confirmedLikesPerJoin: Number(row.consumption_confirmed_likes_per_join),
        confirmedJoinsPerComment: Number(row.consumption_confirmed_joins_per_comment),
      },
      updatedAt: asIso(row.updated_at),
      updatedBy: row.updated_by ?? null,
    };
  }

  private auditSnapshot(policy: CachedPolicy): Record<string, unknown> {
    return {
      baseMode: policy.baseMode,
      rule: policy.rule,
      consumption: policy.consumption,
      policySchemaVersion: 1,
      policyRevision: policy.policyRevision,
    };
  }

  private async readEnvironment(envKey: string): Promise<EnvironmentDbRow | null> {
    const { rows } = await this.pool.query<EnvironmentDbRow>(
      `SELECT e.platform,
              e.account_id,
              e.slow_start_since,
              (SELECT COALESCE(
                        NULLIF(btrim(a.operator_alias), ''),
                        NULLIF(btrim(a.nickname), ''),
                        NULLIF(btrim(a.label), ''),
                        a.account_id
                       )
                 FROM accounts a
                WHERE a.account_id=e.account_id) AS account_display_name,
              CASE WHEN e.account_id IS NULL THEN false
                   ELSE EXISTS(SELECT 1 FROM accounts a WHERE a.account_id=e.account_id) END
                AS account_exists,
              CASE WHEN e.account_id IS NULL THEN 0
                   ELSE (SELECT count(*) FROM client_environments e2
                          WHERE e2.account_id=e.account_id
                            AND COALESCE(e2.lifecycle_state,'active')='active') END
                AS duplicate_count,
              (SELECT count(DISTINCT s.user_id)
                 FROM client_env_scope s
                WHERE s.env_key=e.env_key AND s.source='admin') AS owner_count
         FROM client_environments e
        WHERE e.env_key=$1
          AND COALESCE(e.lifecycle_state,'active')='active'`,
      [envKey],
    );
    return rows[0] ?? null;
  }

  private async resolveSlowStart(
    accountId: string,
  ): Promise<Awaited<ReturnType<FacebookOperationPolicySlowStartResolver>>> {
    if (!this.slowStartResolver) {
      return {
        state: 'unknown',
        since: null,
        globallyDisabled: false,
        blocker: 'slow_start_projection_unavailable',
      };
    }
    try {
      return await this.slowStartResolver(accountId);
    } catch {
      return {
        state: 'unknown',
        since: null,
        globallyDisabled: false,
        blocker: 'slow_start_projection_unavailable',
      };
    }
  }

  private async resolveEnvironmentSlowStart(
    envKey: string,
    accountId: string | null,
    rawSince: Date | string | null,
  ): Promise<FacebookOperationPolicyView['slowStart']> {
    const since = asEpochMillis(rawSince);
    if (since === null) {
      return { state: 'off', since: null, globallyDisabled: false };
    }
    if (this.environmentSlowStartResolver) {
      try {
        const state = await this.environmentSlowStartResolver({ envKey, accountId, since });
        if (state === 'unknown') {
          return { state, since: null, globallyDisabled: false };
        }
        return {
          state,
          since: state === 'off' ? null : since,
          globallyDisabled: state === 'off',
        };
      } catch {
        return { state: 'unknown', since: null, globallyDisabled: false };
      }
    }
    // Narrow embedders without the exact-environment resolver retain the
    // historical unbound behavior: a persisted anchor means active slow start.
    if (!accountId) {
      return { state: 'active', since, globallyDisabled: false };
    }
    const slowStart = await this.resolveSlowStart(accountId);
    if (slowStart.state === 'unknown') return slowStart;
    if (slowStart.globallyDisabled) {
      return { state: 'off', since: null, globallyDisabled: true };
    }
    if (slowStart.since !== since) {
      return { state: 'unknown', since: null, globallyDisabled: false };
    }
    return slowStart;
  }

  private async legacyRuleSlowStartConflict(
    envKey: string,
    environment: LockedEnvironmentDbRow,
  ): Promise<'active' | 'inactive' | 'unknown'> {
    const accountId = environment.account_id?.trim();
    const slowStart = await this.resolveEnvironmentSlowStart(
      envKey,
      accountId || null,
      environment.slow_start_since,
    );
    if (slowStart.state === 'unknown') return 'unknown';
    return slowStart.state === 'active' ? 'active' : 'inactive';
  }

  private async projectWithSlowStart(
    policy: CachedPolicy,
    accountId: string,
    accountDisplayName: string | null,
    bindingState: 'bound',
  ): Promise<FacebookOperationPolicyView> {
    const slowStart = await this.resolveSlowStart(accountId);
    if (slowStart.state === 'unknown') {
      return this.project(policy, {
        bindingState,
        accountId,
        accountDisplayName,
        slowStart,
        effectiveMode: 'blocked',
        blocker: slowStart.blocker,
      });
    }
    return this.project(policy, {
      bindingState,
      accountId,
      accountDisplayName,
      slowStart,
      effectiveMode: slowStart.state === 'active' ? 'slow_start' : policy.baseMode,
      blocker: null,
    });
  }

  private project(
    policy: CachedPolicy,
    input: {
      bindingState: 'bound' | 'unbound' | 'conflict' | 'unknown';
      accountId: string | null;
      accountDisplayName: string | null;
      slowStart: FacebookOperationPolicyView['slowStart'];
      effectiveMode: FacebookEffectiveOperationMode | null;
      blocker: string | null;
    },
  ): FacebookOperationPolicyView {
    return {
      envKey: policy.envKey,
      baseMode: policy.baseMode,
      effectiveMode: input.effectiveMode,
      policyRevision: policy.policyRevision,
      schemaVersion: FACEBOOK_OPERATION_POLICY_SCHEMA_VERSION,
      rule: { ...policy.rule },
      consumption: { ...policy.consumption },
      bounds: FACEBOOK_OPERATION_POLICY_BOUNDS,
      slowStart: input.slowStart,
      binding: {
        state: input.bindingState,
        accountId: input.accountId,
        accountDisplayName: input.accountDisplayName,
      },
      blocker: input.blocker,
      updatedAt: policy.updatedAt,
      updatedBy: policy.updatedBy,
    };
  }
}
