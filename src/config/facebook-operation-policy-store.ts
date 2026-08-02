import pg from 'pg';
import { DEFAULT_PG_CONFIG } from '../kernel/pg-config.js';
import {
  SchemaCapabilityError,
  classifySchemaCapability,
  type SchemaProber,
} from '../kernel/schema-capability-contract.js';
import { normalizePlatformId } from '../kernel/platform-types.js';
import type { ActionQuota } from '../kernel/risk-contract.js';
import type { DeploymentTarget } from '../deployment-target.js';
import { shanghaiDayStartMs } from '../time/shanghai-day.js';
import type { MirrorVersionBumper } from './mirror-version-store.js';
import {
  cloneFacebookReelCadence,
  resolveFacebookOperationAccountDecision,
  resolveFacebookOperationBase,
  type FacebookEffectiveOperationMode,
  type FacebookOperationPolicyAccountDecision,
  type FacebookSlowStartResolution,
  type FacebookSlowStartViewFacts,
  type FacebookBaseOperationMode,
  type FacebookCadenceSource,
  type FacebookConsumptionOperationParameters,
  type FacebookGlobalReelCadenceParameters,
  type FacebookOperationPolicyBaseProjection,
  type FacebookOperationPolicyBaseResolution,
  type FacebookOperationPolicyEnvironmentResolver,
  type FacebookPrimaryBrowseSurface,
  type FacebookRuleOperationParameters,
} from '../kernel/facebook-operation-policy-resolution.js';

const { Pool } = pg;

export const FACEBOOK_OPERATION_POLICY_SCHEMA_VERSION = 'facebook_operation_policy@1';
export const FACEBOOK_OPERATION_GLOBAL_POLICY_SCHEMA_VERSION =
  'facebook_operation_global_policy@3';

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

export const FACEBOOK_OPERATION_GLOBAL_POLICY_BOUNDS = {
  ...FACEBOOK_OPERATION_POLICY_BOUNDS,
  reels: {
    persona: {
      viewsPerLike: { min: 1, max: 100, default: 4 },
      viewsPerFollow: { min: 1, max: 100, default: 10 },
    },
    slowStart: {
      viewsPerLike: { min: 1, max: 100, default: 15 },
      viewsPerFollow: { min: 1, max: 100, default: 15 },
    },
    rule: {
      viewsPerFollow: { min: 1, max: 100, default: 15 },
    },
    consumption: {
      viewsPerFollow: { min: 1, max: 100, default: 15 },
    },
  },
  slowStart: {
    totalDays: { min: 1, max: 30, default: 7 },
    dailyCaps: {
      view: { min: 0, max: 300 },
      like: { min: 0, max: 100 },
      comment: { min: 0, max: 15 },
      follow: { min: 0, max: 30 },
      publish: { min: 0, max: 2 },
      search: { min: 0, max: 20 },
      joinGroup: { min: 0, max: 5 },
    },
  },
} as const;

export interface FacebookSlowStartDailyCaps {
  day: number;
  view: number;
  like: number;
  comment: number;
  follow: number;
  publish: number;
  search: number;
  joinGroup: number;
}

export const DEFAULT_FACEBOOK_SLOW_START_DAILY_CAPS: FacebookSlowStartDailyCaps[] = [
  { day: 1, view: 20, like: 2, comment: 0, follow: 1, publish: 0, search: 1, joinGroup: 0 },
  { day: 2, view: 25, like: 3, comment: 0, follow: 1, publish: 0, search: 1, joinGroup: 0 },
  { day: 3, view: 35, like: 6, comment: 1, follow: 2, publish: 0, search: 2, joinGroup: 1 },
  { day: 4, view: 40, like: 8, comment: 2, follow: 2, publish: 0, search: 2, joinGroup: 1 },
  { day: 5, view: 50, like: 12, comment: 3, follow: 3, publish: 1, search: 3, joinGroup: 2 },
  { day: 6, view: 60, like: 15, comment: 4, follow: 4, publish: 1, search: 4, joinGroup: 2 },
  { day: 7, view: 70, like: 18, comment: 5, follow: 5, publish: 1, search: 5, joinGroup: 3 },
];

// 基线取用的判定与纯数据契约已抬入 kernel（拆进程后两个进程都要问同一个问题）；
// 此处等值再导出，既有消费方一行不改。
export type {
  FacebookBaseOperationMode,
  FacebookPrimaryBrowseSurface,
  FacebookCadenceSource,
  FacebookRuleOperationParameters,
  FacebookConsumptionOperationParameters,
  FacebookGlobalReelCadenceParameters,
  FacebookOperationPolicyBaseProjection,
  FacebookOperationPolicyBaseResolution,
  FacebookOperationPolicyEnvironmentResolver,
  // 账号最终模式那一段同样已抬入 kernel（批 G 第四片）：自动化进程要按同步读快照
  // + 自己的风控注册表算同一个决策，两侧各写一份的现形方式不是报错、而是档位悄悄不一致。
  FacebookEffectiveOperationMode,
  FacebookSlowStartResolution,
  FacebookSlowStartViewFacts,
  FacebookOperationPolicyAccountDecision,
};
export type FacebookRequestedOperationMode = FacebookBaseOperationMode | 'slow_start';

export interface FacebookOperationPolicyView {
  envKey: string;
  primarySurface: FacebookPrimaryBrowseSurface;
  surfaceRevision: number;
  surfaceUpdatedAt: string | null;
  surfaceUpdatedBy: string | null;
  baseMode: FacebookBaseOperationMode;
  effectiveMode: FacebookEffectiveOperationMode | null;
  policyRevision: number;
  schemaVersion: string;
  cadenceSource: FacebookCadenceSource;
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

export interface FacebookOperationGlobalPolicyView {
  executionTarget: DeploymentTarget;
  revision: number;
  schemaVersion: string;
  rule: FacebookRuleOperationParameters;
  consumption: FacebookConsumptionOperationParameters;
  reels: FacebookGlobalReelCadenceParameters;
  slowStart: {
    totalDays: number;
    dailyCaps: FacebookSlowStartDailyCaps[];
  };
  bounds: typeof FACEBOOK_OPERATION_GLOBAL_POLICY_BOUNDS;
  updatedAt: string | null;
  updatedBy: string | null;
}

export interface FacebookSlowStartRuntimePolicy {
  totalDays: number;
  dailyCaps: ActionQuota[];
}

export type FacebookOperationGlobalPolicyWriteResult =
  | { ok: true; view: FacebookOperationGlobalPolicyView }
  | {
      ok: false;
      reason: 'invalid_value' | 'revision_conflict' | 'policy_unavailable';
      current?: FacebookOperationGlobalPolicyView;
    };

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

export type FacebookPrimaryBrowseSurfaceWriteResult = FacebookOperationPolicyWriteResult;

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

/** 回执形状取 kernel 那一份：拆进程后自动化侧要按同一个形状喂同一个判定。 */
export type FacebookOperationPolicySlowStartResolver = (
  accountId: string,
) => Promise<FacebookSlowStartResolution>;

export type FacebookOperationPolicyEnvironmentSlowStartResolver = (input: {
  envKey: string;
  accountId: string | null;
  since: number;
  completedAt: number | null;
  totalDays: number;
}) => Promise<'active' | 'off' | 'graduated' | 'unknown'>;

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
  cadence_source: FacebookCadenceSource;
  updated_at: Date | string;
  updated_by: string;
}

interface PrimaryBrowseSurfaceDbRow {
  env_key: string;
  primary_surface: FacebookPrimaryBrowseSurface;
  revision: number | string;
  updated_at: Date | string;
  updated_by: string;
}

interface CachedPrimaryBrowseSurface {
  primarySurface: FacebookPrimaryBrowseSurface;
  surfaceRevision: number;
  surfaceUpdatedAt: string | null;
  surfaceUpdatedBy: string | null;
}

interface EnvironmentDbRow {
  platform: string | null;
  account_id: string | null;
  account_display_name: string | null;
  account_exists: boolean;
  slow_start_since: Date | string | null;
  slow_start_completed_at: Date | string | null;
  duplicate_count: number | string;
  owner_count: number | string;
}

interface LockedEnvironmentDbRow {
  platform: string | null;
  account_id: string | null;
  slow_start_since: Date | string | null;
  slow_start_completed_at: Date | string | null;
  duplicate_count: number | string;
  owner_count: number | string;
}

interface GlobalOperationPolicyDbRow {
  execution_target: DeploymentTarget;
  persona_reel_views_per_like: number | string;
  persona_reel_views_per_follow: number | string;
  slow_start_reel_views_per_like: number | string;
  slow_start_reel_views_per_follow: number | string;
  rule_reel_views_per_follow: number | string;
  consumption_reel_views_per_follow: number | string;
  rule_views_per_like: number | string;
  rule_join_every_n_rounds: number | string;
  consumption_views_per_like: number | string;
  consumption_confirmed_likes_per_join: number | string;
  consumption_confirmed_joins_per_comment: number | string;
  slow_start_total_days: number | string;
  slow_start_daily_caps: unknown;
  revision: number | string;
  updated_at: Date | string;
  updated_by: string;
}

interface LegacyRuleModeDbRow {
  env_key: string;
  enabled: boolean;
  updated_at: Date | string;
  updated_by: string;
}

type CachedPolicy = Omit<
  FacebookOperationPolicyBaseProjection,
  'primarySurface' | 'surfaceRevision'
>;

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
      'cadence_source',
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
    ['facebook_primary_browse_surface_policy', new Set([
      'env_key',
      'primary_surface',
      'revision',
      'updated_at',
      'updated_by',
    ])],
    ['facebook_primary_browse_surface_policy_audit', new Set([
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
    ['facebook_operation_global_policy', new Set([
      'execution_target',
      'persona_reel_views_per_like',
      'persona_reel_views_per_follow',
      'slow_start_reel_views_per_like',
      'slow_start_reel_views_per_follow',
      'rule_reel_views_per_follow',
      'consumption_reel_views_per_follow',
      'rule_views_per_like',
      'rule_join_every_n_rounds',
      'consumption_views_per_like',
      'consumption_confirmed_likes_per_join',
      'consumption_confirmed_joins_per_comment',
      'slow_start_total_days',
      'slow_start_daily_caps',
      'revision',
      'updated_at',
      'updated_by',
    ])],
    ['facebook_operation_global_policy_audit', new Set([
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
    ['facebook_environment_slow_start_completion', new Set([
      'env_key',
      'execution_target',
      'completed_at',
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
    [
      'idx_facebook_primary_browse_surface_audit_env_revision',
      'facebook_primary_browse_surface_policy_audit',
    ],
    [
      'idx_facebook_operation_global_policy_audit_target_revision',
      'facebook_operation_global_policy_audit',
    ],
    [
      'idx_facebook_environment_slow_start_completion_target',
      'facebook_environment_slow_start_completion',
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
  executionTarget?: DeploymentTarget;
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

/** 实现在 kernel 只此一份（基线投影跨进程传输时两端都要深拷贝）。 */
const cloneReelCadence = cloneFacebookReelCadence;

function defaultGlobalPolicy(executionTarget: DeploymentTarget): FacebookOperationGlobalPolicyView {
  return {
    executionTarget,
    revision: 1,
    schemaVersion: FACEBOOK_OPERATION_GLOBAL_POLICY_SCHEMA_VERSION,
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
    reels: {
      persona: {
        viewsPerLike:
          FACEBOOK_OPERATION_GLOBAL_POLICY_BOUNDS.reels.persona.viewsPerLike.default,
        viewsPerFollow:
          FACEBOOK_OPERATION_GLOBAL_POLICY_BOUNDS.reels.persona.viewsPerFollow.default,
      },
      slowStart: {
        viewsPerLike:
          FACEBOOK_OPERATION_GLOBAL_POLICY_BOUNDS.reels.slowStart.viewsPerLike.default,
        viewsPerFollow:
          FACEBOOK_OPERATION_GLOBAL_POLICY_BOUNDS.reels.slowStart.viewsPerFollow.default,
      },
      rule: {
        viewsPerFollow:
          FACEBOOK_OPERATION_GLOBAL_POLICY_BOUNDS.reels.rule.viewsPerFollow.default,
      },
      consumption: {
        viewsPerFollow:
          FACEBOOK_OPERATION_GLOBAL_POLICY_BOUNDS.reels.consumption.viewsPerFollow.default,
      },
    },
    slowStart: {
      totalDays: FACEBOOK_OPERATION_GLOBAL_POLICY_BOUNDS.slowStart.totalDays.default,
      dailyCaps: DEFAULT_FACEBOOK_SLOW_START_DAILY_CAPS.map((row) => ({ ...row })),
    },
    bounds: FACEBOOK_OPERATION_GLOBAL_POLICY_BOUNDS,
    updatedAt: null,
    updatedBy: null,
  };
}

function defaultCachedPolicy(
  envKey: string,
  globalPolicy?: FacebookOperationGlobalPolicyView,
  cadenceSource: FacebookCadenceSource = 'global',
): CachedPolicy {
  const defaults = globalPolicy ?? defaultGlobalPolicy('dev');
  return {
    envKey,
    baseMode: 'persona',
    policyRevision: 0,
    cadenceSource,
    rule: {
      ...defaults.rule,
    },
    consumption: {
      ...defaults.consumption,
    },
    reels: cloneReelCadence(defaults.reels),
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

function normalizedDailyCaps(
  value: unknown,
  totalDays: number,
): FacebookSlowStartDailyCaps[] | null {
  if (!Array.isArray(value) || value.length !== totalDays) return null;
  const keys = ['day', 'view', 'like', 'comment', 'follow', 'publish', 'search', 'joinGroup'];
  const result: FacebookSlowStartDailyCaps[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const row = value[index];
    if (!row || typeof row !== 'object' || Array.isArray(row)) return null;
    if (Object.keys(row).sort().join(',') !== [...keys].sort().join(',')) return null;
    const candidate = row as unknown as FacebookSlowStartDailyCaps;
    if (candidate.day !== index + 1) return null;
    const bounds = FACEBOOK_OPERATION_GLOBAL_POLICY_BOUNDS.slowStart.dailyCaps;
    if (
      !inIntegerBound(candidate.view, bounds.view)
      || !inIntegerBound(candidate.like, bounds.like)
      || !inIntegerBound(candidate.comment, bounds.comment)
      || !inIntegerBound(candidate.follow, bounds.follow)
      || !inIntegerBound(candidate.publish, bounds.publish)
      || !inIntegerBound(candidate.search, bounds.search)
      || !inIntegerBound(candidate.joinGroup, bounds.joinGroup)
    ) return null;
    result.push({ ...candidate });
  }
  return result;
}

function normalizedGlobalWrite(input: {
  expectedRevision: number;
  rule: FacebookRuleOperationParameters;
  consumption: FacebookConsumptionOperationParameters;
  reels: FacebookGlobalReelCadenceParameters;
  slowStart: {
    totalDays: number;
    dailyCaps: FacebookSlowStartDailyCaps[];
  };
  requestId: string;
  reason?: string | null;
}): { ok: true; dailyCaps: FacebookSlowStartDailyCaps[] }
  | { ok: false; reason: 'invalid_value' } {
  if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0) {
    return { ok: false, reason: 'invalid_value' };
  }
  if (
    !inIntegerBound(input.rule?.viewsPerLike, FACEBOOK_OPERATION_POLICY_BOUNDS.rule.viewsPerLike)
    || !inIntegerBound(
      input.rule?.joinEveryNRounds,
      FACEBOOK_OPERATION_POLICY_BOUNDS.rule.joinEveryNRounds,
    )
    || !inIntegerBound(
      input.consumption?.viewsPerLike,
      FACEBOOK_OPERATION_POLICY_BOUNDS.consumption.viewsPerLike,
    )
    || !inIntegerBound(
      input.consumption?.confirmedLikesPerJoin,
      FACEBOOK_OPERATION_POLICY_BOUNDS.consumption.confirmedLikesPerJoin,
    )
    || !inIntegerBound(
      input.consumption?.confirmedJoinsPerComment,
      FACEBOOK_OPERATION_POLICY_BOUNDS.consumption.confirmedJoinsPerComment,
    )
    || !inIntegerBound(
      input.reels?.persona?.viewsPerLike,
      FACEBOOK_OPERATION_GLOBAL_POLICY_BOUNDS.reels.persona.viewsPerLike,
    )
    || !inIntegerBound(
      input.reels?.persona?.viewsPerFollow,
      FACEBOOK_OPERATION_GLOBAL_POLICY_BOUNDS.reels.persona.viewsPerFollow,
    )
    || !inIntegerBound(
      input.reels?.slowStart?.viewsPerLike,
      FACEBOOK_OPERATION_GLOBAL_POLICY_BOUNDS.reels.slowStart.viewsPerLike,
    )
    || !inIntegerBound(
      input.reels?.slowStart?.viewsPerFollow,
      FACEBOOK_OPERATION_GLOBAL_POLICY_BOUNDS.reels.slowStart.viewsPerFollow,
    )
    || !inIntegerBound(
      input.reels?.rule?.viewsPerFollow,
      FACEBOOK_OPERATION_GLOBAL_POLICY_BOUNDS.reels.rule.viewsPerFollow,
    )
    || !inIntegerBound(
      input.reels?.consumption?.viewsPerFollow,
      FACEBOOK_OPERATION_GLOBAL_POLICY_BOUNDS.reels.consumption.viewsPerFollow,
    )
    || !inIntegerBound(
      input.slowStart?.totalDays,
      FACEBOOK_OPERATION_GLOBAL_POLICY_BOUNDS.slowStart.totalDays,
    )
    || !String(input.requestId || '').trim()
    || (
      input.reason !== undefined
      && input.reason !== null
      && typeof input.reason !== 'string'
    )
  ) return { ok: false, reason: 'invalid_value' };
  const dailyCaps = normalizedDailyCaps(
    input.slowStart?.dailyCaps,
    input.slowStart.totalDays,
  );
  return dailyCaps
    ? { ok: true, dailyCaps }
    : { ok: false, reason: 'invalid_value' };
}

function normalizedWrite(
  input: {
    expectedRevision: number;
    mode: FacebookRequestedOperationMode;
    cadenceSource?: FacebookCadenceSource;
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
  if (input.cadenceSource !== undefined && !['global', 'environment'].includes(input.cadenceSource)) {
    return { ok: false, reason: 'invalid_value' };
  }
  if (input.cadenceSource === 'global' && (
    input.rule !== undefined || input.consumption !== undefined
  )) {
    return { ok: false, reason: 'invalid_value' };
  }
  if (input.cadenceSource === 'environment') {
    if (!input.rule || !input.consumption) return { ok: false, reason: 'invalid_value' };
    if (
      !inIntegerBound(input.rule.viewsPerLike, FACEBOOK_OPERATION_POLICY_BOUNDS.rule.viewsPerLike)
      || !inIntegerBound(
        input.rule.joinEveryNRounds,
        FACEBOOK_OPERATION_POLICY_BOUNDS.rule.joinEveryNRounds,
      )
      || !inIntegerBound(
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
    ) return { ok: false, reason: 'invalid_value' };
    return { ok: true };
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

function normalizedPrimarySurfaceWrite(input: {
  primarySurface: FacebookPrimaryBrowseSurface;
  expectedRevision: number;
  requestId: string;
  reason?: string | null;
}): { ok: true } | { ok: false; reason: 'invalid_value' } {
  if (input.primarySurface !== 'feed' && input.primarySurface !== 'reels') {
    return { ok: false, reason: 'invalid_value' };
  }
  if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1) {
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
  private readonly executionTarget?: DeploymentTarget;
  private readonly mirrorVersionBumper?: MirrorVersionBumper;
  private environmentResolver?: FacebookOperationPolicyEnvironmentResolver;
  private slowStartResolver?: FacebookOperationPolicySlowStartResolver;
  private environmentSlowStartResolver?: FacebookOperationPolicyEnvironmentSlowStartResolver;
  private slowStartRefresh?: () => Promise<void>;
  private cache = new Map<string, CachedPolicy>();
  private surfaceCache = new Map<string, CachedPrimaryBrowseSurface>();
  private legacyFallbackCache = new Map<string, CachedPolicy>();
  private globalPolicy?: FacebookOperationGlobalPolicyView;
  private ready = false;

  constructor(options: FacebookOperationPolicyStoreOptions) {
    this.schemaProber = options.schemaProber;
    this.executionTarget = options.executionTarget;
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
    const requirement = this.executionTarget
      ? OPERATION_POLICY_REQUIREMENT
      : {
          tables: new Map(
            [...OPERATION_POLICY_REQUIREMENT.tables].filter(([table]) =>
              table === 'facebook_operation_policy'
              || table === 'facebook_operation_policy_audit'
              || table === 'facebook_primary_browse_surface_policy'
              || table === 'facebook_primary_browse_surface_policy_audit'),
          ),
          indexes: new Map(
            [...OPERATION_POLICY_REQUIREMENT.indexes].filter(([, table]) =>
              table === 'facebook_operation_policy_audit'
              || table === 'facebook_primary_browse_surface_policy_audit'),
          ),
        };
    const shape = await this.schemaProber(
      this.pool,
      [...requirement.tables.keys()],
    );
    const verdict = classifySchemaCapability(requirement, shape);
    if (verdict.status !== 'ready') {
      throw new SchemaCapabilityError(
        {
          capability: 'facebook_operation_policy',
          sinceVersion: '0105_facebook_primary_browse_surface',
          ddl: [],
        },
        verdict,
      );
    }
    await this.refreshFromAuthority();
    if (this.executionTarget && !this.globalPolicy) {
      throw new Error(`facebook_operation_global_policy_missing:${this.executionTarget}`);
    }
    this.ready = true;
  }

  async refreshFromAuthority(): Promise<void> {
    const [policyResult, surfaceResult, legacyResult, globalResult] = await Promise.all([
      this.pool.query<OperationPolicyDbRow>(
        `SELECT env_key,base_mode,rule_views_per_like,rule_join_every_n_rounds,
                consumption_views_per_like,consumption_confirmed_likes_per_join,
                consumption_confirmed_joins_per_comment,policy_schema_version,
                policy_revision,cadence_source,updated_at,updated_by
           FROM facebook_operation_policy`,
      ),
      this.pool.query<PrimaryBrowseSurfaceDbRow>(
        `SELECT env_key,primary_surface,revision,updated_at,updated_by
           FROM facebook_primary_browse_surface_policy`,
      ),
      this.pool.query<LegacyRuleModeDbRow>(
        `SELECT env_key,enabled,updated_at,updated_by
           FROM facebook_rule_mode_environment_config`,
      ),
      this.executionTarget
        ? this.pool.query<GlobalOperationPolicyDbRow>(
            `SELECT execution_target,persona_reel_views_per_like,
                    persona_reel_views_per_follow,slow_start_reel_views_per_like,
                    slow_start_reel_views_per_follow,
                    rule_reel_views_per_follow,consumption_reel_views_per_follow,
                    rule_views_per_like,rule_join_every_n_rounds,
                    consumption_views_per_like,consumption_confirmed_likes_per_join,
                    consumption_confirmed_joins_per_comment,slow_start_total_days,
                    slow_start_daily_caps,revision,updated_at,updated_by
               FROM facebook_operation_global_policy
              WHERE execution_target=$1`,
            [this.executionTarget],
          )
        : Promise.resolve({ rows: [] as GlobalOperationPolicyDbRow[] }),
    ]);
    const globalRow = globalResult.rows[0];
    this.globalPolicy = globalRow ? this.globalFromRow(globalRow) : undefined;
    this.cache = new Map(
      policyResult.rows.map((row) => [row.env_key, this.cachedFromRow(row)]),
    );
    this.surfaceCache = new Map(
      surfaceResult.rows.map((row) => [row.env_key, this.cachedSurfaceFromRow(row)]),
    );
    this.legacyFallbackCache = new Map(
      legacyResult.rows.map((row) => {
        const policy = defaultCachedPolicy(
          row.env_key,
          this.globalPolicy,
          'environment',
        );
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

  getGlobal(): FacebookOperationGlobalPolicyView | null {
    return this.ready && this.globalPolicy
      ? this.cloneGlobal(this.globalPolicy)
      : null;
  }

  slowStartRuntimePolicy(): FacebookSlowStartRuntimePolicy {
    const policy = this.globalPolicy
      ?? defaultGlobalPolicy(this.executionTarget ?? 'dev');
    return {
      totalDays: policy.slowStart.totalDays,
      dailyCaps: policy.slowStart.dailyCaps.map((row) => ({
        view: row.view,
        like: row.like,
        collect: 0,
        comment: row.comment,
        follow: row.follow,
        publish: row.publish,
        search: row.search,
        comment_like: 0,
        join_group: row.joinGroup,
        dm_reply: 0,
      })),
    };
  }

  getBaseForEnv(envKey: string): FacebookOperationPolicyBaseProjection | null {
    const key = String(envKey || '').trim();
    if (!this.ready || !key) return null;
    return this.baselineForEnv(key);
  }

  /**
   * 同步读快照发布用：所有**已配浏览面**的环境的基线投影。
   * 与 `resolveBaseForAccount` 取的是同一个合成口 —— 发布方另写一份合成的现形方式，
   * 是两个进程对同一个环境按不同节奏跑，而两侧都不报错。
   */
  baselineProjections(): FacebookOperationPolicyBaseProjection[] {
    if (!this.ready) return [];
    const out: FacebookOperationPolicyBaseProjection[] = [];
    for (const envKey of [...this.surfaceCache.keys()].sort()) {
      const baseline = this.baselineForEnv(envKey);
      if (baseline) out.push(baseline);
    }
    return out;
  }

  /**
   * 基线取用判定在 kernel 只此一份：自动化进程按同步读快照喂同一个函数。
   * 各写一份的现形方式不是报错，而是某一侧安静地永远答不出基线 —— 下游就是账号永远不开始浏览。
   */
  resolveBaseForAccount(accountId: string): FacebookOperationPolicyBaseResolution {
    return resolveFacebookOperationBase(
      {
        ready: this.ready,
        resolveEnvironment: (id) =>
          this.environmentResolver?.(id) ?? {
            ok: false,
            reason: 'binding_unavailable',
          },
        baselineForEnv: (envKey) => this.baselineForEnv(envKey),
      },
      accountId,
    );
  }

  /**
   * 环境键 → 基线投影；无浏览面配置即 null（**MUST NOT 给个默认面**）。快照发布方取同一份。
   *
   * **逐字段构造、不用两个 spread**：浏览面缓存比契约多带 `surfaceUpdatedAt` / `surfaceUpdatedBy`
   * 两个字段，spread 出来的对象在类型上仍算合法（TS 对 spread 结果不做多余属性检查），
   * 但跨进程载荷校验按精确键集判，多两个键当场 `invalid_envelope` ——
   * 实测就是这样让单体在启动期挂掉的，而 typecheck 与单测全绿（夹具是照类型手写的、恰好只有 11 个键）。
   */
  private baselineForEnv(
    envKey: string,
  ): FacebookOperationPolicyBaseProjection | null {
    const surface = this.surfaceCache.get(envKey);
    if (!surface) return null;
    const policy = this.policyForEnv(envKey);
    return {
      envKey: policy.envKey,
      primarySurface: surface.primarySurface,
      surfaceRevision: surface.surfaceRevision,
      baseMode: policy.baseMode,
      policyRevision: policy.policyRevision,
      cadenceSource: policy.cadenceSource,
      rule: policy.rule,
      consumption: policy.consumption,
      reels: policy.reels,
      updatedAt: policy.updatedAt,
      updatedBy: policy.updatedBy,
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
    const surface = this.surfaceCache.get(key);
    if (!surface) return null;
    const duplicate = Number(environment.duplicate_count) > 1;
    const contended = Number(environment.owner_count) > 1;
    if (duplicate || contended) {
      return this.project(policy, surface, {
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
        environment.slow_start_completed_at,
      );
      return this.project(policy, surface, {
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
      surface,
      environment.account_id,
      environment.account_display_name,
      'bound',
    );
  }

  /**
   * 账号最终模式。**判定本身已抬入 kernel**（批 G 第四片）——本方法只负责取两样输入：
   * 基线（本存储的缓存）与慢启动（注入的风控投影解析器）。
   *
   * 自动化进程会拿**另外两样输入**（同步读快照 + 它自己的风控注册表）喂同一个函数。
   * 原先「未就绪」那条早返也一并交给 kernel：`resolveBaseForAccount` 已经把 `ready`
   * 喂进去了，早返只是把同一个 blocker 又写了一遍。
   */
  async resolveForAccount(accountId: string): Promise<FacebookOperationPolicyAccountDecision> {
    const base = this.resolveBaseForAccount(accountId);
    // 基线拿不到就别去问慢启动了：那一问要物化风控控制器，而结论已经确定是 blocked。
    if (!base.ok) {
      return resolveFacebookOperationAccountDecision({
        base,
        slowStart: { state: 'off', since: null, globallyDisabled: false },
      });
    }
    return resolveFacebookOperationAccountDecision({
      base,
      slowStart: await this.resolveSlowStart(accountId),
    });
  }

  async writeGlobal(
    input: {
      expectedRevision: number;
      rule: FacebookRuleOperationParameters;
      consumption: FacebookConsumptionOperationParameters;
      reels: FacebookGlobalReelCadenceParameters;
      slowStart: {
        totalDays: number;
        dailyCaps: FacebookSlowStartDailyCaps[];
      };
      requestId: string;
      reason?: string | null;
    },
    actor: string,
  ): Promise<FacebookOperationGlobalPolicyWriteResult> {
    if (!this.ready || !this.executionTarget || !this.globalPolicy) {
      return { ok: false, reason: 'policy_unavailable' };
    }
    const validation = normalizedGlobalWrite(input);
    if (!validation.ok) return validation;

    const client = await this.pool.connect();
    let committed = false;
    try {
      await client.query('BEGIN');
      const currentResult = await client.query<GlobalOperationPolicyDbRow>(
        `SELECT execution_target,persona_reel_views_per_like,
                persona_reel_views_per_follow,slow_start_reel_views_per_like,
                slow_start_reel_views_per_follow,
                rule_reel_views_per_follow,consumption_reel_views_per_follow,
                rule_views_per_like,rule_join_every_n_rounds,
                consumption_views_per_like,consumption_confirmed_likes_per_join,
                consumption_confirmed_joins_per_comment,slow_start_total_days,
                slow_start_daily_caps,revision,updated_at,updated_by
           FROM facebook_operation_global_policy
          WHERE execution_target=$1
          FOR UPDATE`,
        [this.executionTarget],
      );
      const currentRow = currentResult.rows[0];
      if (!currentRow) {
        await client.query('ROLLBACK');
        return { ok: false, reason: 'policy_unavailable' };
      }
      const current = this.globalFromRow(currentRow);
      if (current.revision !== input.expectedRevision) {
        await client.query('ROLLBACK');
        await this.refreshFromAuthority();
        return {
          ok: false,
          reason: 'revision_conflict',
          ...(this.globalPolicy ? { current: this.cloneGlobal(this.globalPolicy) } : {}),
        };
      }

      // Materialize graduation under the old duration before replacing it, so
      // a later increase cannot revive an environment that already graduated.
      await this.markGraduatedInTx(client, current.slowStart.totalDays);

      const nextRevision = current.revision + 1;
      const writtenResult = await client.query<GlobalOperationPolicyDbRow>(
        `UPDATE facebook_operation_global_policy
            SET persona_reel_views_per_like=$2,
                persona_reel_views_per_follow=$3,
                slow_start_reel_views_per_like=$4,
                slow_start_reel_views_per_follow=$5,
                rule_reel_views_per_follow=$6,
                consumption_reel_views_per_follow=$7,
                rule_views_per_like=$8,
                rule_join_every_n_rounds=$9,
                consumption_views_per_like=$10,
                consumption_confirmed_likes_per_join=$11,
                consumption_confirmed_joins_per_comment=$12,
                slow_start_total_days=$13,
                slow_start_daily_caps=$14::jsonb,
                revision=$15,
                updated_at=now(),
                updated_by=$16
          WHERE execution_target=$1
          RETURNING execution_target,persona_reel_views_per_like,
                    persona_reel_views_per_follow,slow_start_reel_views_per_like,
                    slow_start_reel_views_per_follow,
                    rule_reel_views_per_follow,consumption_reel_views_per_follow,
                    rule_views_per_like,rule_join_every_n_rounds,
                    consumption_views_per_like,consumption_confirmed_likes_per_join,
                    consumption_confirmed_joins_per_comment,slow_start_total_days,
                    slow_start_daily_caps,revision,updated_at,updated_by`,
        [
          this.executionTarget,
          input.reels.persona.viewsPerLike,
          input.reels.persona.viewsPerFollow,
          input.reels.slowStart.viewsPerLike,
          input.reels.slowStart.viewsPerFollow,
          input.reels.rule.viewsPerFollow,
          input.reels.consumption.viewsPerFollow,
          input.rule.viewsPerLike,
          input.rule.joinEveryNRounds,
          input.consumption.viewsPerLike,
          input.consumption.confirmedLikesPerJoin,
          input.consumption.confirmedJoinsPerComment,
          input.slowStart.totalDays,
          JSON.stringify(validation.dailyCaps),
          nextRevision,
          actor,
        ],
      );
      const next = this.globalFromRow(writtenResult.rows[0]);
      const actorInfo = actorParts(actor);
      await client.query(
        `INSERT INTO facebook_operation_global_policy_audit
           (execution_target,prior_revision,new_revision,before_policy,after_policy,
            actor_class,actor_id,request_id,reason,created_at)
         VALUES ($1,$2,$3,$4::jsonb,$5::jsonb,$6,$7,$8,$9,now())`,
        [
          this.executionTarget,
          current.revision,
          next.revision,
          JSON.stringify(this.globalAuditSnapshot(current)),
          JSON.stringify(this.globalAuditSnapshot(next)),
          actorInfo.actorClass,
          actorInfo.actorId,
          input.requestId,
          input.reason ?? null,
        ],
      );

      const cadenceChanged =
        JSON.stringify(current.rule) !== JSON.stringify(next.rule)
        || JSON.stringify(current.consumption) !== JSON.stringify(next.consumption);
      if (cadenceChanged) {
        const inherited = await client.query<OperationPolicyDbRow>(
          `SELECT env_key,base_mode,rule_views_per_like,rule_join_every_n_rounds,
                  consumption_views_per_like,consumption_confirmed_likes_per_join,
                  consumption_confirmed_joins_per_comment,policy_schema_version,
                  policy_revision,cadence_source,updated_at,updated_by
             FROM facebook_operation_policy
            WHERE cadence_source='global'
            ORDER BY env_key
            FOR UPDATE`,
        );
        for (const row of inherited.rows) {
          const prior = this.cachedFromRow(row);
          const revisionResult = await client.query<{ revision: number | string }>(
            `SELECT nextval('facebook_operation_policy_revision_seq') AS revision`,
          );
          const environmentRevision = Number(revisionResult.rows[0]?.revision);
          if (!Number.isSafeInteger(environmentRevision) || environmentRevision < 1) {
            throw new Error('facebook_operation_policy_revision_unavailable');
          }
          const propagatedResult = await client.query<OperationPolicyDbRow>(
            `UPDATE facebook_operation_policy
                SET rule_views_per_like=$2,
                    rule_join_every_n_rounds=$3,
                    consumption_views_per_like=$4,
                    consumption_confirmed_likes_per_join=$5,
                    consumption_confirmed_joins_per_comment=$6,
                    policy_revision=$7,
                    updated_at=now(),
                    updated_by=$8
              WHERE env_key=$1
              RETURNING env_key,base_mode,rule_views_per_like,rule_join_every_n_rounds,
                        consumption_views_per_like,consumption_confirmed_likes_per_join,
                        consumption_confirmed_joins_per_comment,policy_schema_version,
                        policy_revision,cadence_source,updated_at,updated_by`,
            [
              row.env_key,
              next.rule.viewsPerLike,
              next.rule.joinEveryNRounds,
              next.consumption.viewsPerLike,
              next.consumption.confirmedLikesPerJoin,
              next.consumption.confirmedJoinsPerComment,
              environmentRevision,
              actor,
            ],
          );
          const propagated = this.cachedFromRow(propagatedResult.rows[0]);
          await client.query(
            `INSERT INTO facebook_operation_policy_audit
               (env_key,prior_revision,new_revision,before_policy,after_policy,
                actor_class,actor_id,request_id,reason,created_at)
             VALUES ($1,$2,$3,$4::jsonb,$5::jsonb,$6,$7,$8,$9,now())`,
            [
              row.env_key,
              prior.policyRevision,
              propagated.policyRevision,
              JSON.stringify(this.auditSnapshot(prior)),
              JSON.stringify(this.auditSnapshot(propagated)),
              actorInfo.actorClass,
              actorInfo.actorId,
              input.requestId,
              input.reason ?? 'global_cadence_propagated',
            ],
          );
        }
      }

      // A shorter duration takes effect in the same transaction.
      await this.markGraduatedInTx(client, next.slowStart.totalDays);
      await this.mirrorVersionBumper?.bumpInTx(client, 'content_schedule');
      await this.mirrorVersionBumper?.bumpInTx(client, 'facebook_operation_policy');
      await this.mirrorVersionBumper?.bumpInTx(client, 'client_environment_slow_start');
      await client.query('COMMIT');
      committed = true;
      await this.refreshFromAuthority();
      this.mirrorVersionBumper?.notifyAfterCommit?.('content_schedule');
      this.mirrorVersionBumper?.notifyAfterCommit?.('facebook_operation_policy');
      this.mirrorVersionBumper?.notifyAfterCommit?.('client_environment_slow_start');
      await this.slowStartRefresh?.();
      return this.globalPolicy
        ? { ok: true, view: this.cloneGlobal(this.globalPolicy) }
        : { ok: false, reason: 'policy_unavailable' };
    } catch (error) {
      if (!committed) await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async writeEnvironment(
    envKey: string,
    input: {
      expectedRevision: number;
      mode: FacebookRequestedOperationMode;
      cadenceSource?: FacebookCadenceSource;
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
                policy_revision,cadence_source,updated_at,updated_by
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

      const nextCadenceSource = input.cadenceSource ?? current.cadenceSource;
      if (nextCadenceSource === 'global' && !this.globalPolicy) {
        await client.query('ROLLBACK');
        return { ok: false, reason: 'policy_unavailable' };
      }
      const nextRule = nextCadenceSource === 'global'
        ? this.globalPolicy!.rule
        : input.cadenceSource === 'environment'
          ? input.rule!
          : input.mode === 'rule' && input.rule
            ? input.rule
            : current.rule;
      const nextConsumption = nextCadenceSource === 'global'
        ? this.globalPolicy!.consumption
        : input.cadenceSource === 'environment'
          ? input.consumption!
          : input.mode === 'consumption' && input.consumption
            ? input.consumption
            : current.consumption;
      const nextBaseMode: FacebookBaseOperationMode =
        input.mode === 'slow_start' ? 'persona' : input.mode;
      const shouldResetSlowStart = input.mode === 'slow_start'
        && (
          environment.slow_start_since == null
          || environment.slow_start_completed_at != null
        );
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
                  WHEN $2 AND $4 THEN $3
                  WHEN $2 THEN slow_start_since
                  ELSE NULL
                END,
                slow_start_initialized=true,
                updated_at=now()
          WHERE env_key=$1`,
        [
          key,
          input.mode === 'slow_start',
          new Date(shanghaiDayStartMs(Date.now())),
          shouldResetSlowStart,
        ],
      );
      if (shouldResetSlowStart) {
        await client.query(
          `DELETE FROM facebook_environment_slow_start_completion WHERE env_key=$1`,
          [key],
        );
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
                    cadence_source=$9,
                    updated_at=now(),
                    updated_by=$10
              WHERE env_key=$1
              RETURNING env_key,base_mode,rule_views_per_like,rule_join_every_n_rounds,
                        consumption_views_per_like,consumption_confirmed_likes_per_join,
                        consumption_confirmed_joins_per_comment,policy_schema_version,
                        policy_revision,cadence_source,updated_at,updated_by`,
            [
              key,
              nextBaseMode,
              nextRule.viewsPerLike,
              nextRule.joinEveryNRounds,
              nextConsumption.viewsPerLike,
              nextConsumption.confirmedLikesPerJoin,
              nextConsumption.confirmedJoinsPerComment,
              nextRevision,
              nextCadenceSource,
              actor,
            ],
          )
        : await client.query<OperationPolicyDbRow>(
            `INSERT INTO facebook_operation_policy
               (env_key,base_mode,rule_views_per_like,rule_join_every_n_rounds,
                consumption_views_per_like,consumption_confirmed_likes_per_join,
                consumption_confirmed_joins_per_comment,policy_schema_version,
                policy_revision,cadence_source,updated_at,updated_by)
             VALUES ($1,$2,$3,$4,$5,$6,$7,1,$8,$9,now(),$10)
             RETURNING env_key,base_mode,rule_views_per_like,rule_join_every_n_rounds,
                       consumption_views_per_like,consumption_confirmed_likes_per_join,
                       consumption_confirmed_joins_per_comment,policy_schema_version,
                       policy_revision,cadence_source,updated_at,updated_by`,
            [
              key,
              nextBaseMode,
              nextRule.viewsPerLike,
              nextRule.joinEveryNRounds,
              nextConsumption.viewsPerLike,
              nextConsumption.confirmedLikesPerJoin,
              nextConsumption.confirmedJoinsPerComment,
              nextRevision,
              nextCadenceSource,
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
      await this.mirrorVersionBumper?.bumpInTx(client, 'facebook_operation_policy');
      await this.mirrorVersionBumper?.bumpInTx(client, 'client_environment_slow_start');
      await client.query('COMMIT');
      committed = true;
      this.cache.set(key, next);
      this.mirrorVersionBumper?.notifyAfterCommit?.('content_schedule');
      this.mirrorVersionBumper?.notifyAfterCommit?.('facebook_operation_policy');
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

  async writePrimarySurface(
    envKey: string,
    input: {
      primarySurface: FacebookPrimaryBrowseSurface;
      expectedRevision: number;
      requestId: string;
      reason?: string | null;
      requiredOwnerUserId?: string;
    },
    actor: string,
  ): Promise<FacebookPrimaryBrowseSurfaceWriteResult> {
    if (!this.ready) return { ok: false, reason: 'policy_unavailable' };
    const key = String(envKey || '').trim();
    if (!key) return { ok: false, reason: 'environment_not_found' };
    const validation = normalizedPrimarySurfaceWrite(input);
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

      const currentResult = await client.query<PrimaryBrowseSurfaceDbRow>(
        `SELECT env_key,primary_surface,revision,updated_at,updated_by
           FROM facebook_primary_browse_surface_policy
          WHERE env_key=$1
          FOR UPDATE`,
        [key],
      );
      const currentRow = currentResult.rows[0];
      if (!currentRow) {
        await client.query('ROLLBACK');
        return { ok: false, reason: 'policy_unavailable' };
      }
      const current = this.cachedSurfaceFromRow(currentRow);
      if (current.surfaceRevision !== input.expectedRevision) {
        await client.query('ROLLBACK');
        await this.refreshFromAuthority();
        const projection = await this.getForEnv(key);
        return {
          ok: false,
          reason: 'revision_conflict',
          ...(projection ? { current: projection } : {}),
        };
      }
      if (current.primarySurface === input.primarySurface) {
        await client.query('ROLLBACK');
        const projection = await this.getForEnv(key);
        return projection
          ? { ok: true, view: projection }
          : { ok: false, reason: 'policy_unavailable' };
      }

      const written = await client.query<PrimaryBrowseSurfaceDbRow>(
        `UPDATE facebook_primary_browse_surface_policy
            SET primary_surface=$2,
                revision=revision + 1,
                updated_at=now(),
                updated_by=$3
          WHERE env_key=$1
          RETURNING env_key,primary_surface,revision,updated_at,updated_by`,
        [key, input.primarySurface, actor],
      );
      const next = this.cachedSurfaceFromRow(written.rows[0]);
      const actorInfo = actorParts(actor);
      await client.query(
        `INSERT INTO facebook_primary_browse_surface_policy_audit
           (env_key,prior_revision,new_revision,before_policy,after_policy,
            actor_class,actor_id,request_id,reason,created_at)
         VALUES ($1,$2,$3,$4::jsonb,$5::jsonb,$6,$7,$8,$9,now())`,
        [
          key,
          current.surfaceRevision,
          next.surfaceRevision,
          JSON.stringify(this.surfaceAuditSnapshot(current)),
          JSON.stringify(this.surfaceAuditSnapshot(next)),
          actorInfo.actorClass,
          actorInfo.actorId,
          input.requestId,
          input.reason ?? null,
        ],
      );
      await client.query('COMMIT');
      committed = true;
      this.surfaceCache.set(key, next);
      const view = await this.getForEnv(key);
      return view
        ? { ok: true, view }
        : { ok: false, reason: 'policy_unavailable' };
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
                policy_revision,cadence_source,updated_at,updated_by
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
      const nextRule = current.rule;
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
                    cadence_source=$9,
                    updated_at=now(),
                    updated_by=$10
              WHERE env_key=$1
              RETURNING env_key,base_mode,rule_views_per_like,rule_join_every_n_rounds,
                        consumption_views_per_like,consumption_confirmed_likes_per_join,
                        consumption_confirmed_joins_per_comment,policy_schema_version,
                        policy_revision,cadence_source,updated_at,updated_by`,
            [
              key,
              nextBaseMode,
              nextRule.viewsPerLike,
              nextRule.joinEveryNRounds,
              current.consumption.viewsPerLike,
              current.consumption.confirmedLikesPerJoin,
              current.consumption.confirmedJoinsPerComment,
              nextRevision,
              current.cadenceSource,
              actor,
            ],
          )
        : await client.query<OperationPolicyDbRow>(
            `INSERT INTO facebook_operation_policy
               (env_key,base_mode,rule_views_per_like,rule_join_every_n_rounds,
                consumption_views_per_like,consumption_confirmed_likes_per_join,
                consumption_confirmed_joins_per_comment,policy_schema_version,
                policy_revision,cadence_source,updated_at,updated_by)
             VALUES ($1,$2,$3,$4,$5,$6,$7,1,$8,$9,now(),$10)
             RETURNING env_key,base_mode,rule_views_per_like,rule_join_every_n_rounds,
                       consumption_views_per_like,consumption_confirmed_likes_per_join,
                       consumption_confirmed_joins_per_comment,policy_schema_version,
                       policy_revision,cadence_source,updated_at,updated_by`,
            [
              key,
              nextBaseMode,
              nextRule.viewsPerLike,
              nextRule.joinEveryNRounds,
              current.consumption.viewsPerLike,
              current.consumption.confirmedLikesPerJoin,
              current.consumption.confirmedJoinsPerComment,
              nextRevision,
              current.cadenceSource,
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
      await this.mirrorVersionBumper?.bumpInTx(client, 'facebook_operation_policy');
      await client.query('COMMIT');
      committed = true;
      this.cache.set(key, next);
      this.mirrorVersionBumper?.notifyAfterCommit?.('content_schedule');
      this.mirrorVersionBumper?.notifyAfterCommit?.('facebook_operation_policy');
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
                policy_revision,cadence_source,updated_at,updated_by
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
      const alreadyFreshlyActive = currentlyEnabled
        && environment.slow_start_completed_at == null;
      if (currentRow && (
        (!input.enabled && !currentlyEnabled)
        || (input.enabled && alreadyFreshlyActive)
      )) {
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
                  WHEN $2 THEN $3
                  ELSE NULL
                END,
                slow_start_initialized=true,
                updated_at=now()
          WHERE env_key=$1`,
        [key, input.enabled, slowStartAnchor],
      );
      if (input.enabled) {
        await client.query(
          `DELETE FROM facebook_environment_slow_start_completion WHERE env_key=$1`,
          [key],
        );
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
                    cadence_source=$9,
                    updated_at=now(),
                    updated_by=$10
              WHERE env_key=$1
              RETURNING env_key,base_mode,rule_views_per_like,rule_join_every_n_rounds,
                        consumption_views_per_like,consumption_confirmed_likes_per_join,
                        consumption_confirmed_joins_per_comment,policy_schema_version,
                        policy_revision,cadence_source,updated_at,updated_by`,
            [
              key,
              current.baseMode,
              current.rule.viewsPerLike,
              current.rule.joinEveryNRounds,
              current.consumption.viewsPerLike,
              current.consumption.confirmedLikesPerJoin,
              current.consumption.confirmedJoinsPerComment,
              nextRevision,
              current.cadenceSource,
              actor,
            ],
          )
        : await client.query<OperationPolicyDbRow>(
            `INSERT INTO facebook_operation_policy
               (env_key,base_mode,rule_views_per_like,rule_join_every_n_rounds,
                consumption_views_per_like,consumption_confirmed_likes_per_join,
                consumption_confirmed_joins_per_comment,policy_schema_version,
                policy_revision,cadence_source,updated_at,updated_by)
             VALUES ($1,$2,$3,$4,$5,$6,$7,1,$8,$9,now(),$10)
             RETURNING env_key,base_mode,rule_views_per_like,rule_join_every_n_rounds,
                       consumption_views_per_like,consumption_confirmed_likes_per_join,
                       consumption_confirmed_joins_per_comment,policy_schema_version,
                       policy_revision,cadence_source,updated_at,updated_by`,
            [
              key,
              current.baseMode,
              current.rule.viewsPerLike,
              current.rule.joinEveryNRounds,
              current.consumption.viewsPerLike,
              current.consumption.confirmedLikesPerJoin,
              current.consumption.confirmedJoinsPerComment,
              nextRevision,
              current.cadenceSource,
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
      await this.mirrorVersionBumper?.bumpInTx(client, 'facebook_operation_policy');
      await this.mirrorVersionBumper?.bumpInTx(client, 'client_environment_slow_start');
      await client.query('COMMIT');
      committed = true;
      this.cache.set(key, next);
      this.mirrorVersionBumper?.notifyAfterCommit?.('content_schedule');
      this.mirrorVersionBumper?.notifyAfterCommit?.('facebook_operation_policy');
      this.mirrorVersionBumper?.notifyAfterCommit?.('client_environment_slow_start');
      await this.slowStartRefresh?.();
      const view = await this.getForEnv(key);
      if (!view) return { ok: false, reason: 'policy_unavailable' };
      return {
        ok: true,
        view,
        slowStartSince: input.enabled
          ? alreadyFreshlyActive
            ? currentSlowStartSince
            : slowStartAnchor.getTime()
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
      ?? defaultCachedPolicy(
        envKey,
        this.globalPolicy,
        this.executionTarget ? 'global' : 'environment',
      );
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
    if (!row) {
      return defaultCachedPolicy(
        envKey,
        this.globalPolicy,
        this.executionTarget ? 'global' : 'environment',
      );
    }
    const policy = defaultCachedPolicy(envKey, this.globalPolicy, 'environment');
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
              (SELECT c.completed_at
                 FROM facebook_environment_slow_start_completion c
                WHERE c.env_key=e.env_key AND c.execution_target=$2)
                AS slow_start_completed_at,
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
      [envKey, this.executionTarget ?? 'dev'],
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
      cadenceSource: row.cadence_source ?? 'environment',
      rule: {
        viewsPerLike: Number(row.rule_views_per_like),
        joinEveryNRounds: Number(row.rule_join_every_n_rounds),
      },
      consumption: {
        viewsPerLike: Number(row.consumption_views_per_like),
        confirmedLikesPerJoin: Number(row.consumption_confirmed_likes_per_join),
        confirmedJoinsPerComment: Number(row.consumption_confirmed_joins_per_comment),
      },
      reels: cloneReelCadence(
        (this.globalPolicy ?? defaultGlobalPolicy(this.executionTarget ?? 'dev')).reels,
      ),
      updatedAt: asIso(row.updated_at),
      updatedBy: row.updated_by ?? null,
    };
  }

  private cachedSurfaceFromRow(row: PrimaryBrowseSurfaceDbRow): CachedPrimaryBrowseSurface {
    return {
      primarySurface: row.primary_surface,
      surfaceRevision: Number(row.revision),
      surfaceUpdatedAt: asIso(row.updated_at),
      surfaceUpdatedBy: row.updated_by ?? null,
    };
  }

  private surfaceAuditSnapshot(
    surface: CachedPrimaryBrowseSurface,
  ): Record<string, unknown> {
    return {
      primarySurface: surface.primarySurface,
      surfaceRevision: surface.surfaceRevision,
    };
  }

  private auditSnapshot(policy: CachedPolicy): Record<string, unknown> {
    return {
      baseMode: policy.baseMode,
      cadenceSource: policy.cadenceSource,
      rule: policy.rule,
      consumption: policy.consumption,
      policySchemaVersion: 1,
      policyRevision: policy.policyRevision,
    };
  }

  private globalFromRow(row: GlobalOperationPolicyDbRow): FacebookOperationGlobalPolicyView {
    const totalDays = Number(row.slow_start_total_days);
    const dailyCaps = normalizedDailyCaps(row.slow_start_daily_caps, totalDays);
    if (!dailyCaps) throw new Error('facebook_operation_global_policy_invalid_daily_caps');
    return {
      executionTarget: row.execution_target,
      revision: Number(row.revision),
      schemaVersion: FACEBOOK_OPERATION_GLOBAL_POLICY_SCHEMA_VERSION,
      rule: {
        viewsPerLike: Number(row.rule_views_per_like),
        joinEveryNRounds: Number(row.rule_join_every_n_rounds),
      },
      consumption: {
        viewsPerLike: Number(row.consumption_views_per_like),
        confirmedLikesPerJoin: Number(row.consumption_confirmed_likes_per_join),
        confirmedJoinsPerComment: Number(row.consumption_confirmed_joins_per_comment),
      },
      reels: {
        persona: {
          viewsPerLike: Number(row.persona_reel_views_per_like),
          viewsPerFollow: Number(row.persona_reel_views_per_follow),
        },
        slowStart: {
          viewsPerLike: Number(row.slow_start_reel_views_per_like),
          viewsPerFollow: Number(row.slow_start_reel_views_per_follow),
        },
        rule: {
          viewsPerFollow: Number(row.rule_reel_views_per_follow),
        },
        consumption: {
          viewsPerFollow: Number(row.consumption_reel_views_per_follow),
        },
      },
      slowStart: { totalDays, dailyCaps },
      bounds: FACEBOOK_OPERATION_GLOBAL_POLICY_BOUNDS,
      updatedAt: asIso(row.updated_at),
      updatedBy: row.updated_by ?? null,
    };
  }

  private cloneGlobal(
    policy: FacebookOperationGlobalPolicyView,
  ): FacebookOperationGlobalPolicyView {
    return {
      ...policy,
      rule: { ...policy.rule },
      consumption: { ...policy.consumption },
      reels: cloneReelCadence(policy.reels),
      slowStart: {
        totalDays: policy.slowStart.totalDays,
        dailyCaps: policy.slowStart.dailyCaps.map((row) => ({ ...row })),
      },
    };
  }

  private globalAuditSnapshot(
    policy: FacebookOperationGlobalPolicyView,
  ): Record<string, unknown> {
    return {
      executionTarget: policy.executionTarget,
      rule: policy.rule,
      consumption: policy.consumption,
      reels: policy.reels,
      slowStart: policy.slowStart,
      schemaVersion: policy.schemaVersion,
      revision: policy.revision,
    };
  }

  private async markGraduatedInTx(
    client: pg.PoolClient,
    totalDays: number,
  ): Promise<void> {
    if (!this.executionTarget) return;
    await client.query(
      `INSERT INTO facebook_environment_slow_start_completion
         (env_key,execution_target,completed_at)
       SELECT e.env_key,$1,now()
         FROM client_environments e
        WHERE e.slow_start_since IS NOT NULL
          AND lower(btrim(COALESCE(e.platform,''))) IN ('facebook','fb')
          AND now() >= e.slow_start_since + ($2 * interval '1 day')
       ON CONFLICT (env_key,execution_target) DO NOTHING`,
      [this.executionTarget, totalDays],
    );
  }

  private async readEnvironment(envKey: string): Promise<EnvironmentDbRow | null> {
    const { rows } = await this.pool.query<EnvironmentDbRow>(
      `SELECT e.platform,
              e.account_id,
              e.slow_start_since,
              (SELECT c.completed_at
                 FROM facebook_environment_slow_start_completion c
                WHERE c.env_key=e.env_key AND c.execution_target=$2)
                AS slow_start_completed_at,
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
      [envKey, this.executionTarget ?? 'dev'],
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
    rawCompletedAt: Date | string | null = null,
  ): Promise<FacebookOperationPolicyView['slowStart']> {
    const since = asEpochMillis(rawSince);
    if (since === null) {
      return { state: 'off', since: null, globallyDisabled: false };
    }
    if (this.environmentSlowStartResolver) {
      try {
        const state = await this.environmentSlowStartResolver({
          envKey,
          accountId,
          since,
          completedAt: asEpochMillis(rawCompletedAt),
          totalDays: this.slowStartRuntimePolicy().totalDays,
        });
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
      environment.slow_start_completed_at,
    );
    if (slowStart.state === 'unknown') return 'unknown';
    return slowStart.state === 'active' ? 'active' : 'inactive';
  }

  private async projectWithSlowStart(
    policy: CachedPolicy,
    surface: CachedPrimaryBrowseSurface,
    accountId: string,
    accountDisplayName: string | null,
    bindingState: 'bound',
  ): Promise<FacebookOperationPolicyView> {
    const slowStart = await this.resolveSlowStart(accountId);
    if (slowStart.state === 'unknown') {
      return this.project(policy, surface, {
        bindingState,
        accountId,
        accountDisplayName,
        slowStart,
        effectiveMode: 'blocked',
        blocker: slowStart.blocker,
      });
    }
    return this.project(policy, surface, {
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
    surface: CachedPrimaryBrowseSurface,
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
      primarySurface: surface.primarySurface,
      surfaceRevision: surface.surfaceRevision,
      surfaceUpdatedAt: surface.surfaceUpdatedAt,
      surfaceUpdatedBy: surface.surfaceUpdatedBy,
      baseMode: policy.baseMode,
      effectiveMode: input.effectiveMode,
      policyRevision: policy.policyRevision,
      schemaVersion: FACEBOOK_OPERATION_POLICY_SCHEMA_VERSION,
      cadenceSource: policy.cadenceSource,
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
