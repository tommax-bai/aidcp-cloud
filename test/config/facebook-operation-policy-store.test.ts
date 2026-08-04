import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type pg from 'pg';
import type { SchemaProber } from '../../src/kernel/schema-capability-contract.js';
import type { MirrorVersionBumper } from '../../src/config/mirror-version-store.js';
import { FacebookOperationPolicyStore } from '../../src/config/facebook-operation-policy-store.js';
import { isSyncReadFactPayload } from '../../src/kernel/sync-read-facts.js';
import { RISK_ACTIONS } from '../../src/kernel/risk-contract.js';

interface PolicyRow {
  env_key: string;
  base_mode: 'persona' | 'rule' | 'consumption';
  rule_views_per_like: number;
  rule_join_every_n_rounds: number;
  consumption_views_per_like: number;
  consumption_confirmed_likes_per_join: number;
  consumption_confirmed_joins_per_comment: number;
  policy_schema_version: number;
  policy_revision: number;
  cadence_source: 'global' | 'environment';
  updated_at: Date;
  updated_by: string;
}

interface GlobalPolicyRow {
  execution_target: 'dev' | 'ol';
  persona_reel_views_per_like: number;
  persona_reel_views_per_follow: number;
  slow_start_reel_views_per_like: number;
  slow_start_reel_views_per_follow: number;
  rule_reel_views_per_follow: number;
  consumption_reel_views_per_follow: number;
  rule_views_per_like: number;
  rule_join_every_n_rounds: number;
  consumption_views_per_like: number;
  consumption_confirmed_likes_per_join: number;
  consumption_confirmed_joins_per_comment: number;
  slow_start_total_days: number;
  slow_start_daily_caps: unknown[];
  revision: number;
  updated_at: Date;
  updated_by: string;
}

interface SurfaceRow {
  env_key: string;
  primary_surface: 'feed' | 'reels';
  revision: number;
  updated_at: Date;
  updated_by: string;
}

function readySchema(withGlobal = false): SchemaProber {
  return async (_pool, tables) => ({
    tables: new Set(tables),
    columns: new Set([
      'facebook_operation_policy.env_key',
      'facebook_operation_policy.base_mode',
      'facebook_operation_policy.rule_views_per_like',
      'facebook_operation_policy.rule_join_every_n_rounds',
      'facebook_operation_policy.consumption_views_per_like',
      'facebook_operation_policy.consumption_confirmed_likes_per_join',
      'facebook_operation_policy.consumption_confirmed_joins_per_comment',
      'facebook_operation_policy.policy_schema_version',
      'facebook_operation_policy.policy_revision',
      'facebook_operation_policy.cadence_source',
      'facebook_operation_policy.updated_at',
      'facebook_operation_policy.updated_by',
      'facebook_operation_policy_audit.audit_id',
      'facebook_operation_policy_audit.env_key',
      'facebook_operation_policy_audit.prior_revision',
      'facebook_operation_policy_audit.new_revision',
      'facebook_operation_policy_audit.before_policy',
      'facebook_operation_policy_audit.after_policy',
      'facebook_operation_policy_audit.actor_class',
      'facebook_operation_policy_audit.actor_id',
      'facebook_operation_policy_audit.request_id',
      'facebook_operation_policy_audit.reason',
      'facebook_operation_policy_audit.created_at',
      'facebook_primary_browse_surface_policy.env_key',
      'facebook_primary_browse_surface_policy.primary_surface',
      'facebook_primary_browse_surface_policy.revision',
      'facebook_primary_browse_surface_policy.updated_at',
      'facebook_primary_browse_surface_policy.updated_by',
      'facebook_primary_browse_surface_policy_audit.audit_id',
      'facebook_primary_browse_surface_policy_audit.env_key',
      'facebook_primary_browse_surface_policy_audit.prior_revision',
      'facebook_primary_browse_surface_policy_audit.new_revision',
      'facebook_primary_browse_surface_policy_audit.before_policy',
      'facebook_primary_browse_surface_policy_audit.after_policy',
      'facebook_primary_browse_surface_policy_audit.actor_class',
      'facebook_primary_browse_surface_policy_audit.actor_id',
      'facebook_primary_browse_surface_policy_audit.request_id',
      'facebook_primary_browse_surface_policy_audit.reason',
      'facebook_primary_browse_surface_policy_audit.created_at',
      ...(withGlobal ? [
        'facebook_operation_global_policy.execution_target',
        'facebook_operation_global_policy.persona_reel_views_per_like',
        'facebook_operation_global_policy.persona_reel_views_per_follow',
        'facebook_operation_global_policy.slow_start_reel_views_per_like',
        'facebook_operation_global_policy.slow_start_reel_views_per_follow',
        'facebook_operation_global_policy.rule_reel_views_per_follow',
        'facebook_operation_global_policy.consumption_reel_views_per_follow',
        'facebook_operation_global_policy.rule_views_per_like',
        'facebook_operation_global_policy.rule_join_every_n_rounds',
        'facebook_operation_global_policy.consumption_views_per_like',
        'facebook_operation_global_policy.consumption_confirmed_likes_per_join',
        'facebook_operation_global_policy.consumption_confirmed_joins_per_comment',
        'facebook_operation_global_policy.slow_start_total_days',
        'facebook_operation_global_policy.slow_start_daily_caps',
        'facebook_operation_global_policy.revision',
        'facebook_operation_global_policy.updated_at',
        'facebook_operation_global_policy.updated_by',
        'facebook_operation_global_policy_audit.audit_id',
        'facebook_operation_global_policy_audit.execution_target',
        'facebook_operation_global_policy_audit.prior_revision',
        'facebook_operation_global_policy_audit.new_revision',
        'facebook_operation_global_policy_audit.before_policy',
        'facebook_operation_global_policy_audit.after_policy',
        'facebook_operation_global_policy_audit.actor_class',
        'facebook_operation_global_policy_audit.actor_id',
        'facebook_operation_global_policy_audit.request_id',
        'facebook_operation_global_policy_audit.reason',
        'facebook_operation_global_policy_audit.created_at',
        'facebook_environment_slow_start_completion.env_key',
        'facebook_environment_slow_start_completion.execution_target',
        'facebook_environment_slow_start_completion.completed_at',
      ] : []),
    ]),
    indexes: new Set([
      'idx_facebook_operation_policy_audit_env_revision',
      'uq_facebook_operation_policy_audit_revision',
      'idx_facebook_primary_browse_surface_audit_env_revision',
      ...(withGlobal ? [
        'idx_facebook_operation_global_policy_audit_target_revision',
        'idx_facebook_environment_slow_start_completion_target',
      ] : []),
    ]),
  });
}

function database(options: { executionTarget?: 'dev' | 'ol' } = {}) {
  const environments = new Map<string, {
    platform: string;
    accountId: string | null;
    slowStartSince: Date | null;
    slowStartCompletedAt?: Date | null;
  }>([
    ['env-fb', { platform: 'facebook', accountId: 'fb-1', slowStartSince: null as Date | null }],
    ['env-fb-alias', { platform: 'fb', accountId: 'fb-alias', slowStartSince: null as Date | null }],
    ['env-unbound', { platform: 'facebook', accountId: null, slowStartSince: null as Date | null }],
    ['env-legacy', { platform: 'facebook', accountId: 'fb-legacy', slowStartSince: null as Date | null }],
    ['env-duplicate-a', { platform: 'facebook', accountId: 'fb-duplicate', slowStartSince: null as Date | null }],
    ['env-duplicate-b', { platform: 'facebook', accountId: 'fb-duplicate', slowStartSince: null as Date | null }],
    ['env-owner-conflict', { platform: 'facebook', accountId: 'fb-owner-conflict', slowStartSince: null as Date | null }],
    ['env-xhs', { platform: 'xiaohongshu', accountId: 'xhs-1', slowStartSince: null as Date | null }],
  ]);
  const ownerCounts = new Map<string, number>([['env-owner-conflict', 2]]);
  const owners = new Map<string, string>([
    ['env-fb', 'customer-a'],
    ['env-fb-alias', 'customer-a'],
    ['env-unbound', 'customer-a'],
    ['env-legacy', 'customer-a'],
  ]);
  const legacyRuleModes = new Map([
    ['env-legacy', {
      env_key: 'env-legacy',
      enabled: true,
      updated_at: new Date('2026-07-29T00:00:00.000Z'),
      updated_by: 'client:legacy',
    }],
  ]);
  let policies = new Map<string, PolicyRow>();
  let audits: unknown[][] = [];
  let surfaces = new Map<string, SurfaceRow>(
    [...environments]
      .filter(([, environment]) => environment.platform === 'facebook' || environment.platform === 'fb')
      .map(([envKey]) => [envKey, {
        env_key: envKey,
        primary_surface: 'reels' as const,
        revision: 1,
        updated_at: new Date('2026-08-01T00:00:00.000Z'),
        updated_by: 'migration:0105',
      }]),
  );
  let surfaceAudits: unknown[][] = [];
  let globalRow: GlobalPolicyRow = {
    execution_target: options.executionTarget ?? 'dev',
    persona_reel_views_per_like: 4,
    persona_reel_views_per_follow: 10,
    slow_start_reel_views_per_like: 15,
    slow_start_reel_views_per_follow: 15,
    rule_reel_views_per_follow: 15,
    consumption_reel_views_per_follow: 15,
    rule_views_per_like: 5,
    rule_join_every_n_rounds: 2,
    consumption_views_per_like: 5,
    consumption_confirmed_likes_per_join: 2,
    consumption_confirmed_joins_per_comment: 2,
    slow_start_total_days: 7,
    slow_start_daily_caps: Array.from({ length: 7 }, (_, index) => ({
      day: index + 1,
      view: 20 + index * 5,
      like: 2 + index,
      comment: index,
      follow: 1 + index,
      publish: 0,
      search: 1 + index,
      joinGroup: index > 1 ? 1 : 0,
    })),
    revision: 1,
    updated_at: new Date('2026-07-30T00:00:00.000Z'),
    updated_by: 'migration:0103',
  };
  let globalAudits: unknown[][] = [];
  let graduationMarks: unknown[][] = [];
  let auditFailure = false;
  let lockTail = Promise.resolve();
  let slowStartRefreshes = 0;
  let nextPolicyRevision = 1;
  let revisionAllocations = 0;
  const bumps: string[] = [];
  const notifications: string[] = [];

  const query = async (text: string, params: unknown[] = []) => {
    const sql = text.replace(/\s+/g, ' ').trim();
    if (sql.startsWith('SELECT execution_target,persona_reel_views_per_like')) {
      const matchesTarget = params.length === 0
        || String(params[0]) === globalRow.execution_target;
      return {
        rows: matchesTarget ? [{ ...globalRow }] : [],
        rowCount: matchesTarget ? 1 : 0,
      };
    }
    if (sql.startsWith('UPDATE facebook_operation_global_policy')) {
      globalRow = {
        ...globalRow,
        execution_target: String(params[0]) as GlobalPolicyRow['execution_target'],
        persona_reel_views_per_like: Number(params[1]),
        persona_reel_views_per_follow: Number(params[2]),
        slow_start_reel_views_per_like: Number(params[3]),
        slow_start_reel_views_per_follow: Number(params[4]),
        rule_reel_views_per_follow: Number(params[5]),
        consumption_reel_views_per_follow: Number(params[6]),
        rule_views_per_like: Number(params[7]),
        rule_join_every_n_rounds: Number(params[8]),
        consumption_views_per_like: Number(params[9]),
        consumption_confirmed_likes_per_join: Number(params[10]),
        consumption_confirmed_joins_per_comment: Number(params[11]),
        slow_start_total_days: Number(params[12]),
        slow_start_daily_caps: JSON.parse(String(params[13])),
        revision: Number(params[14]),
        updated_at: new Date(),
        updated_by: String(params[15]),
      };
      return { rows: [{ ...globalRow }], rowCount: 1 };
    }
    if (sql.startsWith('INSERT INTO facebook_operation_global_policy_audit')) {
      globalAudits.push(params);
      return { rows: [], rowCount: 1 };
    }
    if (sql.startsWith('INSERT INTO facebook_environment_slow_start_completion')) {
      if (sql.includes('VALUES')) {
        const env = environments.get(String(params[0]));
        if (env) env.slowStartCompletedAt = new Date();
      } else {
        graduationMarks.push(params);
      }
      return { rows: [], rowCount: 0 };
    }
    if (sql.startsWith('SELECT env_key,base_mode') && !sql.includes('WHERE env_key=')) {
      const rows = sql.includes("WHERE cadence_source='global'")
        ? [...policies.values()].filter((row) => row.cadence_source === 'global')
        : [...policies.values()];
      return { rows, rowCount: rows.length };
    }
    if (sql.startsWith('SELECT env_key,primary_surface') && !sql.includes('WHERE env_key=')) {
      return { rows: [...surfaces.values()], rowCount: surfaces.size };
    }
    if (sql.startsWith('SELECT env_key,primary_surface') && sql.includes('WHERE env_key=')) {
      const row = surfaces.get(String(params[0]));
      return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
    }
    if (sql.startsWith('UPDATE facebook_primary_browse_surface_policy')) {
      const prior = surfaces.get(String(params[0]))!;
      const row: SurfaceRow = {
        ...prior,
        primary_surface: params[1] as SurfaceRow['primary_surface'],
        revision: prior.revision + 1,
        updated_at: new Date(),
        updated_by: String(params[2]),
      };
      surfaces.set(row.env_key, row);
      return { rows: [row], rowCount: 1 };
    }
    if (sql.startsWith('INSERT INTO facebook_primary_browse_surface_policy_audit')) {
      surfaceAudits.push(params);
      return { rows: [], rowCount: 1 };
    }
    if (sql.startsWith('SELECT env_key,enabled,updated_at,updated_by')) {
      if (sql.includes('WHERE env_key=')) {
        const row = legacyRuleModes.get(String(params[0]));
        return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
      }
      return {
        rows: [...legacyRuleModes.values()],
        rowCount: legacyRuleModes.size,
      };
    }
    if (sql.startsWith("SELECT nextval('facebook_operation_policy_revision_seq')")) {
      revisionAllocations += 1;
      const revision = nextPolicyRevision++;
      return { rows: [{ revision }], rowCount: 1 };
    }
    if (sql.startsWith('SELECT 1 AS owned FROM client_env_scope')) {
      const userId = String(params[0]);
      const envKey = String(params[1]);
      const owned = owners.get(envKey) === userId;
      return {
        rows: owned ? [{ env_key: envKey }] : [],
        rowCount: owned ? 1 : 0,
      };
    }
    if (sql.startsWith('SELECT e.platform,') && sql.includes('AS account_display_name')) {
      const env = environments.get(String(params[0]));
      if (!env) return { rows: [], rowCount: 0 };
      const duplicateCount = env.accountId === null
        ? 0
        : [...environments.values()].filter((candidate) => candidate.accountId === env.accountId).length;
      return {
        rows: [{
          platform: env.platform,
          account_id: env.accountId,
          account_display_name: env.accountId ? `Display ${env.accountId}` : null,
          account_exists: env.accountId !== null,
          slow_start_since: env.slowStartSince,
          slow_start_completed_at: env.slowStartCompletedAt ?? null,
          duplicate_count: duplicateCount,
          owner_count: ownerCounts.get(String(params[0])) ?? 1,
        }],
        rowCount: 1,
      };
    }
    if (sql.startsWith('SELECT e.platform, e.account_id, e.slow_start_since')) {
      const env = environments.get(String(params[0]));
      const duplicateCount = env?.accountId == null
        ? 0
        : [...environments.values()].filter(
            (candidate) => candidate.accountId === env.accountId,
          ).length;
      return {
        rows: env
          ? [{
              platform: env.platform,
              account_id: env.accountId,
              slow_start_since: env.slowStartSince,
              slow_start_completed_at: env.slowStartCompletedAt ?? null,
              duplicate_count: duplicateCount,
              owner_count: ownerCounts.get(String(params[0])) ?? 1,
            }]
          : [],
        rowCount: env ? 1 : 0,
      };
    }
    if (sql.startsWith('SELECT env_key,base_mode') && sql.includes('WHERE env_key=')) {
      const row = policies.get(String(params[0]));
      return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
    }
    if (sql.startsWith('UPDATE client_environments SET slow_start_since=')) {
      const env = environments.get(String(params[0]))!;
      if (sql.includes('slow_start_since=$2')) {
        env.slowStartSince = params[1] instanceof Date ? params[1] : null;
      } else {
        env.slowStartSince = params[1] === true
          ? env.slowStartSince ?? (params[2] instanceof Date ? params[2] : null)
          : null;
      }
      return { rows: [], rowCount: 1 };
    }
    if (sql.startsWith('INSERT INTO facebook_operation_policy_audit')) {
      if (auditFailure) throw new Error('audit failed');
      audits.push(params);
      return { rows: [], rowCount: 1 };
    }
    if (sql.startsWith('DELETE FROM facebook_environment_slow_start_completion')) {
      const env = environments.get(String(params[0]));
      if (env) env.slowStartCompletedAt = null;
      return { rows: [], rowCount: 0 };
    }
    if (
      sql.startsWith('UPDATE facebook_operation_policy')
      && sql.includes('SET policy_revision=')
    ) {
      const prior = policies.get(String(params[0]))!;
      const row: PolicyRow = {
        ...prior,
        policy_revision: Number(params[1]),
        updated_at: new Date(),
        updated_by: String(params[2]),
      };
      policies.set(row.env_key, row);
      return { rows: [row], rowCount: 1 };
    }
    if (
      sql.startsWith('UPDATE facebook_operation_policy')
      && !sql.includes('base_mode=')
    ) {
      const prior = policies.get(String(params[0]))!;
      const row: PolicyRow = {
        ...prior,
        rule_views_per_like: Number(params[1]),
        rule_join_every_n_rounds: Number(params[2]),
        consumption_views_per_like: Number(params[3]),
        consumption_confirmed_likes_per_join: Number(params[4]),
        consumption_confirmed_joins_per_comment: Number(params[5]),
        policy_revision: Number(params[6]),
        updated_at: new Date(),
        updated_by: String(params[7]),
      };
      policies.set(row.env_key, row);
      return { rows: [row], rowCount: 1 };
    }
    if (
      sql.startsWith('INSERT INTO facebook_operation_policy')
      || sql.startsWith('UPDATE facebook_operation_policy')
    ) {
      const row: PolicyRow = {
        env_key: String(params[0]),
        base_mode: params[1] as PolicyRow['base_mode'],
        rule_views_per_like: Number(params[2]),
        rule_join_every_n_rounds: Number(params[3]),
        consumption_views_per_like: Number(params[4]),
        consumption_confirmed_likes_per_join: Number(params[5]),
        consumption_confirmed_joins_per_comment: Number(params[6]),
        policy_schema_version: 1,
        policy_revision: Number(params[7]),
        cadence_source: (params[8] ?? 'environment') as PolicyRow['cadence_source'],
        updated_at: new Date(),
        updated_by: String(params[9] ?? params[8]),
      };
      policies.set(row.env_key, row);
      return { rows: [row], rowCount: 1 };
    }
    throw new Error(`unhandled query: ${sql}`);
  };

  const pool = {
    query,
    connect: async () => {
      let releaseLock: (() => void) | null = null;
      let snapshot:
        | {
            policies: Map<string, PolicyRow>;
            audits: unknown[][];
            surfaces: Map<string, SurfaceRow>;
            surfaceAudits: unknown[][];
            slow: Map<string, Date | null>;
            completed: Map<string, Date | null>;
            globalRow: GlobalPolicyRow;
            globalAudits: unknown[][];
            graduationMarks: unknown[][];
          }
        | null = null;
      return {
        query: async (text: string, params?: unknown[]) => {
          const sql = text.replace(/\s+/g, ' ').trim();
          if (sql === 'BEGIN') {
            let unlock!: () => void;
            const prior = lockTail;
            lockTail = new Promise<void>((resolve) => { unlock = resolve; });
            await prior;
            releaseLock = unlock;
            snapshot = {
              policies: new Map([...policies].map(([key, row]) => [key, { ...row }])),
              audits: audits.map((row) => [...row]),
              surfaces: new Map([...surfaces].map(([key, row]) => [key, { ...row }])),
              surfaceAudits: surfaceAudits.map((row) => [...row]),
              slow: new Map([...environments].map(([key, env]) => [key, env.slowStartSince])),
              completed: new Map(
                [...environments].map(([key, env]) => [key, env.slowStartCompletedAt ?? null]),
              ),
              globalRow: { ...globalRow },
              globalAudits: globalAudits.map((row) => [...row]),
              graduationMarks: graduationMarks.map((row) => [...row]),
            };
            return { rows: [], rowCount: 0 };
          }
          if (sql === 'COMMIT') {
            releaseLock?.();
            releaseLock = null;
            snapshot = null;
            return { rows: [], rowCount: 0 };
          }
          if (sql === 'ROLLBACK') {
            if (snapshot) {
              policies = snapshot.policies;
              audits = snapshot.audits;
              surfaces = snapshot.surfaces;
              surfaceAudits = snapshot.surfaceAudits;
              globalRow = snapshot.globalRow;
              globalAudits = snapshot.globalAudits;
              graduationMarks = snapshot.graduationMarks;
              for (const [key, since] of snapshot.slow) {
                environments.get(key)!.slowStartSince = since;
              }
              for (const [key, completedAt] of snapshot.completed) {
                environments.get(key)!.slowStartCompletedAt = completedAt;
              }
            }
            releaseLock?.();
            releaseLock = null;
            snapshot = null;
            return { rows: [], rowCount: 0 };
          }
          return query(text, params);
        },
        release: () => releaseLock?.(),
      };
    },
  } as unknown as pg.Pool;

  const mirrorVersionBumper: MirrorVersionBumper = {
    bumpDomain: 'api',
    async bumpInTx(_client, mirrorKey) {
      bumps.push(mirrorKey);
    },
    notifyAfterCommit(mirrorKey) {
      notifications.push(mirrorKey);
    },
  };

  const store = new FacebookOperationPolicyStore({
    pool,
    schemaProber: readySchema(options.executionTarget !== undefined),
    executionTarget: options.executionTarget,
    mirrorVersionBumper,
    environmentResolver: (accountId) => ({
      ok: true,
      envKey: accountId === 'fb-1'
        ? 'env-fb'
        : accountId === 'fb-legacy'
          ? 'env-legacy'
          : 'env-unbound',
    }),
    slowStartResolver: async (accountId) => {
      const since = [...environments.values()].find(
        (environment) => environment.accountId === accountId,
      )?.slowStartSince ?? null;
      return since
        ? { state: 'active' as const, since: since.getTime(), globallyDisabled: false }
        : { state: 'off' as const, since: null, globallyDisabled: false };
    },
    environmentSlowStartResolver: async ({ completedAt }) => completedAt == null
      ? 'active'
      : 'graduated',
    slowStartRefresh: async () => {
      slowStartRefreshes += 1;
    },
  });

  return {
    pool,
    store,
    environments,
    get policies() { return policies; },
    get audits() { return audits; },
    get surfaces() { return surfaces; },
    get surfaceAudits() { return surfaceAudits; },
    get globalRow() { return globalRow; },
    get globalAudits() { return globalAudits; },
    get graduationMarks() { return graduationMarks; },
    get slowStartRefreshes() { return slowStartRefreshes; },
    get revisionAllocations() { return revisionAllocations; },
    get bumps() { return bumps; },
    get notifications() { return notifications; },
    ownerCounts,
    failAudit() { auditFailure = true; },
  };
}

describe('FacebookOperationPolicyStore', () => {
  it('dual-reads a missing policy row from the released environment rule toggle', async () => {
    const db = database();
    await db.store.init();

    const view = await db.store.getForEnv('env-legacy');
    assert.equal(view?.baseMode, 'rule');
    assert.equal(view?.policyRevision, 0);
    assert.equal(view?.updatedBy, 'client:legacy');

    const resolved = db.store.resolveBaseForAccount('fb-legacy');
    assert.equal(resolved.ok, true);
    if (resolved.ok) {
      assert.equal(resolved.baseMode, 'rule');
      assert.equal(resolved.policyRevision, 0);
    }
  });

  it('propagates target-global cadence only to inheriting environments with CAS and audit', async () => {
    const db = database({ executionTarget: 'dev' });
    await db.store.init();
    assert.equal(db.store.getGlobal()?.executionTarget, 'dev');
    assert.equal(db.store.getGlobal()?.revision, 1);
    assert.deepEqual(db.store.getGlobal()?.reels.slowStart, {
      viewsPerLike: 15,
      viewsPerFollow: 15,
    });

    const inherited = await db.store.writeEnvironment(
      'env-fb',
      {
        expectedRevision: 0,
        mode: 'rule',
        cadenceSource: 'global',
        requestId: 'seed-inherited',
      },
      'panel:alice',
    );
    assert.equal(inherited.ok, true);
    const independent = await db.store.writeEnvironment(
      'env-fb-alias',
      {
        expectedRevision: 0,
        mode: 'consumption',
        cadenceSource: 'environment',
        rule: { viewsPerLike: 9, joinEveryNRounds: 4 },
        consumption: {
          viewsPerLike: 8,
          confirmedLikesPerJoin: 3,
          confirmedJoinsPerComment: 5,
        },
        requestId: 'seed-independent',
      },
      'panel:alice',
    );
    assert.equal(independent.ok, true);
    const independentRevision = db.policies.get('env-fb-alias')?.policy_revision;

    const currentGlobal = db.store.getGlobal()!;
    const last = currentGlobal.slowStart.dailyCaps.at(-1)!;
    const dailyCaps = [
      ...currentGlobal.slowStart.dailyCaps,
      ...Array.from({ length: 7 }, (_, index) => ({
        ...last,
        day: 8 + index,
      })),
    ];
    const updated = await db.store.writeGlobal(
      {
        expectedRevision: 1,
        rule: { viewsPerLike: 6, joinEveryNRounds: 3 },
        consumption: {
          viewsPerLike: 7,
          confirmedLikesPerJoin: 4,
          confirmedJoinsPerComment: 5,
        },
        reels: {
          persona: { viewsPerLike: 6, viewsPerFollow: 11 },
          slowStart: { viewsPerLike: 12, viewsPerFollow: 16 },
          rule: { viewsPerFollow: 17 },
          consumption: { viewsPerFollow: 18 },
        },
        slowStart: { totalDays: 14, dailyCaps },
        requestId: 'global-update',
        reason: 'operator tuning',
      },
      'panel:alice',
    );
    assert.equal(updated.ok, true);
    if (updated.ok) {
      assert.equal(updated.view.revision, 2);
      assert.equal(updated.view.slowStart.totalDays, 14);
      assert.deepEqual(updated.view.reels, {
        persona: { viewsPerLike: 6, viewsPerFollow: 11 },
        slowStart: { viewsPerLike: 12, viewsPerFollow: 16 },
        rule: { viewsPerFollow: 17 },
        consumption: { viewsPerFollow: 18 },
      });
    }
    assert.deepEqual(
      {
        source: db.policies.get('env-fb')?.cadence_source,
        ruleViews: db.policies.get('env-fb')?.rule_views_per_like,
        consumptionViews: db.policies.get('env-fb')?.consumption_views_per_like,
      },
      { source: 'global', ruleViews: 6, consumptionViews: 7 },
    );
    assert.deepEqual(
      {
        source: db.policies.get('env-fb-alias')?.cadence_source,
        revision: db.policies.get('env-fb-alias')?.policy_revision,
        ruleViews: db.policies.get('env-fb-alias')?.rule_views_per_like,
        consumptionViews: db.policies.get('env-fb-alias')?.consumption_views_per_like,
      },
      {
        source: 'environment',
        revision: independentRevision,
        ruleViews: 9,
        consumptionViews: 8,
      },
      'independent environment must not be mutated or revision-bumped',
    );
    assert.equal(db.globalAudits.length, 1);
    assert.equal(db.audits.length, 3, 'two direct writes plus one propagated audit');
    assert.deepEqual(db.graduationMarks, [['dev', 7], ['dev', 14]]);
    assert.deepEqual(db.bumps.slice(-3), [
      'content_schedule',
      // 批 E-2 步骤 2：运营基线自己的同步读游标靠它推进。少了它，
      // 自动化进程的基线副本在策略改动后**永远不会重取**，且不报错。
      'facebook_operation_policy',
      'client_environment_slow_start',
    ]);

    const stale = await db.store.writeGlobal(
      {
        expectedRevision: 1,
        rule: currentGlobal.rule,
        consumption: currentGlobal.consumption,
        reels: currentGlobal.reels,
        slowStart: currentGlobal.slowStart,
        requestId: 'stale-global-update',
      },
      'panel:bob',
    );
    assert.equal(stale.ok, false);
    if (!stale.ok) {
      assert.equal(stale.reason, 'revision_conflict');
      assert.equal(stale.current?.revision, 2);
    }
    assert.equal(db.globalAudits.length, 1, 'stale CAS must not create an audit row');
  });

  it('rejects malformed target-global daily caps before opening a transaction', async () => {
    const db = database({ executionTarget: 'dev' });
    await db.store.init();
    const current = db.store.getGlobal()!;
    const result = await db.store.writeGlobal(
      {
        expectedRevision: current.revision,
        rule: current.rule,
        consumption: current.consumption,
        reels: current.reels,
        slowStart: {
          totalDays: 8,
          dailyCaps: current.slowStart.dailyCaps,
        },
        requestId: 'bad-global-caps',
      },
      'panel:alice',
    );
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reason, 'invalid_value');
    assert.equal(db.globalAudits.length, 0);
    assert.equal(db.graduationMarks.length, 0);
  });

  it('rejects fractional and out-of-range global Reel cadence before writing audit', async () => {
    for (const [scope, invalidViewsPerLike] of [
      ['persona', 1.5],
      ['persona', 101],
      ['slowStart', 1.5],
      ['slowStart', 101],
    ] as const) {
      const db = database({ executionTarget: 'dev' });
      await db.store.init();
      const current = db.store.getGlobal()!;
      const result = await db.store.writeGlobal(
        {
          expectedRevision: current.revision,
          rule: current.rule,
          consumption: current.consumption,
          reels: {
            ...current.reels,
            [scope]: { ...current.reels[scope], viewsPerLike: invalidViewsPerLike },
          },
          slowStart: current.slowStart,
          requestId: `bad-reel-cadence-${scope}-${invalidViewsPerLike}`,
        },
        'panel:alice',
      );
      assert.equal(result.ok, false);
      if (!result.ok) assert.equal(result.reason, 'invalid_value');
      assert.equal(db.globalAudits.length, 0);
      assert.equal(db.graduationMarks.length, 0);
    }
  });

  it('allows unbound Facebook configuration and returns server defaults', async () => {
    const db = database();
    await db.store.init();
    const initial = await db.store.getForEnv('env-unbound');
    assert.equal(initial?.effectiveMode, null);
    assert.equal(initial?.policyRevision, 0);
    assert.deepEqual(initial?.rule, { viewsPerLike: 5, joinEveryNRounds: 2 });

    const saved = await db.store.writeEnvironment(
      'env-unbound',
      {
        expectedRevision: 0,
        mode: 'consumption',
        consumption: {
          viewsPerLike: 7,
          confirmedLikesPerJoin: 3,
          confirmedJoinsPerComment: 4,
        },
        requestId: 'request-unbound',
      },
      'panel:alice',
    );
    assert.equal(saved.ok, true);
    if (saved.ok) {
      assert.equal(saved.view.policyRevision, 1);
      assert.equal(saved.view.effectiveMode, null);
      assert.equal(saved.view.consumption.viewsPerLike, 7);
    }
    assert.equal(db.audits.length, 1);
  });

  /**
   * **这条是补回归，且它守的是「产出物与契约逐键一致」，不是「产出物长得对」。**
   *
   * 批 E-2 步骤 2 上线时单体在启动期挂掉：基线投影当时是两个 spread 合出来的
   * （`{ ...policyForEnv(env), ...surface }`），而浏览面缓存比契约多带
   * `surfaceUpdatedAt` / `surfaceUpdatedBy` 两个字段 ⇒ 跨进程载荷校验按精确键集判、
   * 当场 `invalid_envelope` ⇒ 自举流失败 ⇒ 进程起不来。
   *
   * **typecheck 抓不到**（TS 对 spread 结果不做多余属性检查），
   * **单测也抓不到**——kernel 那边的夹具是照类型手写的，恰好只有 11 个键。
   * 只有拿**真产出物**去过一遍**真校验器**才看得见。
   */
  it('基线投影的键集 MUST 与跨进程契约逐键一致，且能过真校验器', async () => {
    const db = database();
    await db.store.init();

    const baseline = db.store.getBaseForEnv('env-fb');
    assert.ok(baseline, '已配浏览面的环境必须给得出基线');
    assert.deepEqual(
      Object.keys(baseline).sort(),
      [
        'baseMode',
        'cadenceSource',
        'consumption',
        'envKey',
        'policyRevision',
        'primarySurface',
        'reels',
        'rule',
        'surfaceRevision',
        'updatedAt',
        'updatedBy',
      ],
      '多一个键就是 invalid_envelope，少一个键是消费方读到 undefined —— 两种都会静静停掉浏览',
    );
    // 慢启动曲线是同一条流上的全局兄弟字段（批 H 第 3 片）。这里连它一起过校验器，
    // 是因为「手写夹具证明的是契约自洽、不是真产出物合规」——夹具照类型抄，真产出物才会带出
    // 属主那边多出来 / 少掉的键。
    const slowStart = db.store.slowStartRuntimePolicy();
    assert.deepEqual(
      Object.keys(slowStart).sort(),
      ['dailyCaps', 'totalDays'],
      '慢启动曲线的键集也在同一份跨进程契约里',
    );
    assert.deepEqual(
      Object.keys(slowStart.dailyCaps[0]).sort(),
      [...RISK_ACTIONS].sort(),
      '逐日上限 MUST 覆盖全部风控动作 —— 少一项跨进程读到 undefined，'
        + '拿去取 min 得到 NaN，那个动作的配额从此没有意义且不报错',
    );
    assert.equal(
      isSyncReadFactPayload('facebook_operation_policy', {
        environments: db.store.baselineProjections(),
        slowStart,
      }),
      true,
      '发布口的真产出物 MUST 能过跨进程校验器（这正是当初挂在启动期的那一跳）',
    );
  });

  it('writes primary surface with an independent revision and audit', async () => {
    const db = database();
    await db.store.init();

    const written = await db.store.writePrimarySurface(
      'env-fb',
      {
        expectedRevision: 1,
        primarySurface: 'feed',
        requestId: 'surface-1',
        requiredOwnerUserId: 'customer-a',
      },
      'client:customer-a',
    );
    assert.equal(written.ok, true);
    if (written.ok) {
      assert.equal(written.view.primarySurface, 'feed');
      assert.equal(written.view.surfaceRevision, 2);
      assert.equal(written.view.policyRevision, 0);
    }
    assert.equal(db.surfaces.get('env-fb')?.primary_surface, 'feed');
    assert.equal(db.surfaceAudits.length, 1);
    assert.equal(db.revisionAllocations, 0);

    const stale = await db.store.writePrimarySurface(
      'env-fb',
      {
        expectedRevision: 1,
        primarySurface: 'reels',
        requestId: 'surface-stale',
      },
      'client:customer-a',
    );
    assert.equal(stale.ok, false);
    if (!stale.ok) {
      assert.equal(stale.reason, 'revision_conflict');
      assert.equal(stale.current?.primarySurface, 'feed');
    }
    assert.equal(db.surfaceAudits.length, 1);

    const unsupported = await db.store.writePrimarySurface(
      'env-xhs',
      {
        expectedRevision: 1,
        primarySurface: 'reels',
        requestId: 'surface-xhs',
      },
      'client:customer-a',
    );
    assert.deepEqual(unsupported, { ok: false, reason: 'unsupported_platform' });
  });

  it('reads an unbound slow-start selection from the environment anchor', async () => {
    const db = database();
    await db.store.init();

    const saved = await db.store.writeEnvironment(
      'env-unbound',
      {
        expectedRevision: 0,
        mode: 'slow_start',
        requestId: 'request-unbound-slow-start',
      },
      'client:customer-a',
    );

    assert.equal(saved.ok, true);
    if (saved.ok) {
      assert.equal(saved.view.baseMode, 'persona');
      assert.equal(saved.view.effectiveMode, null, 'unbound config has no execution object');
      assert.equal(saved.view.binding.state, 'unbound');
      assert.equal(saved.view.slowStart.state, 'active');
      assert.equal(
        saved.view.slowStart.since,
        db.environments.get('env-unbound')!.slowStartSince?.getTime(),
      );
    }
  });

  it('edits slow-start day and completion atomically without changing the base policy', async () => {
    const db = database({ executionTarget: 'dev' });
    await db.store.init();
    const enabled = await db.store.writeEnvironment(
      'env-unbound',
      {
        expectedRevision: 0,
        mode: 'slow_start',
        requestId: 'request-progress-enable',
        requiredOwnerUserId: 'customer-a',
      },
      'client:customer-a',
    );
    assert.equal(enabled.ok, true);
    assert.ok(enabled.ok);

    const initial = await db.store.getSlowStartProgressForEnv('env-unbound');
    assert.deepEqual(initial?.slowStartProgress, {
      day: 1,
      totalDays: 7,
      completed: false,
    });

    const completed = await db.store.writeSlowStartProgress(
      'env-unbound',
      {
        expectedRevision: enabled.view.policyRevision,
        day: 4,
        completed: true,
        requestId: 'request-progress-complete',
        requiredOwnerUserId: 'customer-a',
      },
      'client:customer-a',
    );
    assert.equal(completed.ok, true);
    assert.ok(completed.ok);
    assert.equal(completed.projection.operationPolicy.baseMode, 'persona');
    assert.equal(completed.projection.operationPolicy.slowStart.state, 'graduated');
    assert.deepEqual(completed.projection.slowStartProgress, {
      day: 4,
      totalDays: 7,
      completed: true,
    });
    assert.ok(db.environments.get('env-unbound')!.slowStartCompletedAt);
    const completedAudit = JSON.parse(String(db.audits.at(-1)?.[4])) as {
      slowStartProgress: { day: number; completed: boolean };
    };
    assert.deepEqual(completedAudit.slowStartProgress, {
      day: 4,
      totalDays: 7,
      completed: true,
    });

    const reopened = await db.store.writeSlowStartProgress(
      'env-unbound',
      {
        expectedRevision: completed.projection.operationPolicy.policyRevision,
        day: 2,
        completed: false,
        requestId: 'request-progress-reopen',
        requiredOwnerUserId: 'customer-a',
      },
      'client:customer-a',
    );
    assert.equal(reopened.ok, true);
    assert.ok(reopened.ok);
    assert.equal(reopened.projection.operationPolicy.slowStart.state, 'active');
    assert.deepEqual(reopened.projection.slowStartProgress, {
      day: 2,
      totalDays: 7,
      completed: false,
    });
    assert.equal(db.environments.get('env-unbound')!.slowStartCompletedAt, null);
    assert.equal(db.policies.get('env-unbound')?.base_mode, 'persona');
    assert.equal(db.slowStartRefreshes, 3);
    assert.deepEqual(db.bumps.slice(-3), [
      'content_schedule',
      'facebook_operation_policy',
      'client_environment_slow_start',
    ]);
  });

  it('rejects stale, out-of-range, and non-cold-start progress without mutation', async () => {
    const db = database({ executionTarget: 'dev' });
    await db.store.init();
    const enabled = await db.store.writeEnvironment(
      'env-fb',
      {
        expectedRevision: 0,
        mode: 'slow_start',
        requestId: 'request-progress-guard-enable',
      },
      'panel:alice',
    );
    assert.ok(enabled.ok);
    const auditCount = db.audits.length;

    const invalid = await db.store.writeSlowStartProgress(
      'env-fb',
      {
        expectedRevision: enabled.view.policyRevision,
        day: 8,
        completed: false,
        requestId: 'request-progress-invalid',
      },
      'panel:alice',
    );
    assert.deepEqual(invalid, { ok: false, reason: 'invalid_value' });
    assert.equal(db.audits.length, auditCount);

    const stale = await db.store.writeSlowStartProgress(
      'env-fb',
      {
        expectedRevision: enabled.view.policyRevision + 1,
        day: 2,
        completed: false,
        requestId: 'request-progress-stale',
      },
      'panel:alice',
    );
    assert.equal(stale.ok, false);
    if (!stale.ok) assert.equal(stale.reason, 'revision_conflict');
    assert.equal(db.audits.length, auditCount);

    const persona = await db.store.writeEnvironment(
      'env-fb',
      {
        expectedRevision: enabled.view.policyRevision,
        mode: 'persona',
        requestId: 'request-progress-persona',
      },
      'panel:alice',
    );
    assert.ok(persona.ok);
    const conflict = await db.store.writeSlowStartProgress(
      'env-fb',
      {
        expectedRevision: persona.view.policyRevision,
        day: 2,
        completed: false,
        requestId: 'request-progress-mode-conflict',
      },
      'panel:alice',
    );
    assert.equal(conflict.ok, false);
    if (!conflict.ok) assert.equal(conflict.reason, 'mode_conflict');
    assert.equal(db.environments.get('env-fb')!.slowStartSince, null);
  });

  it('allocates policy revisions globally across environments', async () => {
    const db = database();
    await db.store.init();
    const first = await db.store.writeEnvironment(
      'env-fb',
      {
        expectedRevision: 0,
        mode: 'rule',
        requestId: 'request-global-revision-a',
      },
      'panel:alice',
    );
    const second = await db.store.writeEnvironment(
      'env-unbound',
      {
        expectedRevision: 0,
        mode: 'consumption',
        requestId: 'request-global-revision-b',
      },
      'panel:alice',
    );

    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    if (first.ok && second.ok) {
      assert.equal(first.view.policyRevision, 1);
      assert.equal(second.view.policyRevision, 2);
      assert.notEqual(
        first.view.policyRevision,
        second.view.policyRevision,
        'runtime revision identity must not collide when an account moves between environments',
      );
    }
  });

  it('switches slow start and base policy atomically with CAS', async () => {
    const db = database();
    await db.store.init();
    const enabled = await db.store.writeEnvironment(
      'env-fb',
      {
        expectedRevision: 0,
        mode: 'slow_start',
        requestId: 'request-slow',
      },
      'panel:alice',
    );
    assert.equal(enabled.ok, true);
    assert.ok(db.environments.get('env-fb')!.slowStartSince);
    assert.equal(db.policies.get('env-fb')?.base_mode, 'persona');
    assert.equal(db.audits.length, 1);

    const rule = await db.store.writeEnvironment(
      'env-fb',
      {
        expectedRevision: 1,
        mode: 'rule',
        rule: { viewsPerLike: 9, joinEveryNRounds: 3 },
        requestId: 'request-rule',
      },
      'panel:alice',
    );
    assert.equal(rule.ok, true);
    assert.equal(db.environments.get('env-fb')!.slowStartSince, null);
    assert.equal(db.policies.get('env-fb')?.base_mode, 'rule');
    assert.equal(db.audits.length, 2);
    assert.equal(db.slowStartRefreshes, 2, 'each committed unified write refreshes the slow-start mirror');
  });

  it('legacy slow-start changes preserve the current consumption and rule policies', async () => {
    const db = database();
    await db.store.init();

    const consumption = await db.store.writeEnvironment(
      'env-fb',
      {
        expectedRevision: 0,
        mode: 'consumption',
        consumption: {
          viewsPerLike: 11,
          confirmedLikesPerJoin: 4,
          confirmedJoinsPerComment: 3,
        },
        requestId: 'request-consumption',
      },
      'panel:alice',
    );
    assert.equal(consumption.ok, true);

    const enabledOverConsumption = await db.store.writeLegacySlowStart(
      'env-fb',
      { enabled: true, requestId: 'legacy-enable-consumption' },
      'client:legacy',
    );
    assert.equal(enabledOverConsumption.ok, true);
    if (enabledOverConsumption.ok) {
      assert.ok(enabledOverConsumption.slowStartSince);
      assert.equal(enabledOverConsumption.view.baseMode, 'consumption');
      assert.deepEqual(enabledOverConsumption.view.consumption, {
        viewsPerLike: 11,
        confirmedLikesPerJoin: 4,
        confirmedJoinsPerComment: 3,
      });
    }

    const rule = await db.store.writeEnvironment(
      'env-fb',
      {
        expectedRevision: 2,
        mode: 'rule',
        rule: { viewsPerLike: 13, joinEveryNRounds: 5 },
        requestId: 'request-rule-after-consumption',
      },
      'panel:alice',
    );
    assert.equal(rule.ok, true);

    const enabledOverRule = await db.store.writeLegacySlowStart(
      'env-fb',
      { enabled: true, requestId: 'legacy-enable-rule' },
      'client:legacy',
    );
    assert.equal(enabledOverRule.ok, true);
    if (enabledOverRule.ok) {
      assert.equal(enabledOverRule.view.baseMode, 'rule');
      assert.deepEqual(enabledOverRule.view.rule, {
        viewsPerLike: 13,
        joinEveryNRounds: 5,
      });
      assert.deepEqual(enabledOverRule.view.consumption, {
        viewsPerLike: 11,
        confirmedLikesPerJoin: 4,
        confirmedJoinsPerComment: 3,
      });
    }

    const disabled = await db.store.writeLegacySlowStart(
      'env-fb',
      { enabled: false, requestId: 'legacy-disable-rule' },
      'client:legacy',
    );
    assert.equal(disabled.ok, true);
    if (disabled.ok) {
      assert.equal(disabled.slowStartSince, null);
      assert.equal(disabled.view.baseMode, 'rule');
      assert.deepEqual(disabled.view.rule, {
        viewsPerLike: 13,
        joinEveryNRounds: 5,
      });
    }
    assert.equal(db.policies.get('env-fb')?.policy_revision, 5);
  });

  it('legacy slow-start is idempotent only when the state and policy row already exist', async () => {
    const db = database();
    await db.store.init();
    const seeded = await db.store.writeEnvironment(
      'env-fb',
      {
        expectedRevision: 0,
        mode: 'persona',
        requestId: 'seed-idempotent-policy',
      },
      'panel:alice',
    );
    assert.equal(seeded.ok, true);
    const before = {
      revisions: db.revisionAllocations,
      audits: db.audits.length,
      bumps: db.bumps.length,
      notifications: db.notifications.length,
      refreshes: db.slowStartRefreshes,
    };

    const unchanged = await db.store.writeLegacySlowStart(
      'env-fb',
      { enabled: false, requestId: 'legacy-idempotent-off' },
      'client:legacy',
    );
    assert.equal(unchanged.ok, true);
    if (unchanged.ok) {
      assert.equal(unchanged.view.policyRevision, 1);
      assert.equal(unchanged.slowStartSince, null);
    }
    assert.deepEqual(
      {
        revisions: db.revisionAllocations,
        audits: db.audits.length,
        bumps: db.bumps.length,
        notifications: db.notifications.length,
        refreshes: db.slowStartRefreshes,
      },
      before,
    );

    const missingPolicy = database();
    await missingPolicy.store.init();
    const materialized = await missingPolicy.store.writeLegacySlowStart(
      'env-legacy',
      { enabled: false, requestId: 'legacy-materialize-off' },
      'client:legacy',
    );
    assert.equal(materialized.ok, true);
    if (materialized.ok) {
      assert.equal(materialized.view.baseMode, 'rule');
      assert.equal(materialized.view.policyRevision, 1);
      assert.equal(materialized.slowStartSince, null);
    }
    assert.equal(missingPolicy.revisionAllocations, 1);
    assert.equal(missingPolicy.audits.length, 1);
    assert.deepEqual(missingPolicy.bumps, [
      'content_schedule',
      'facebook_operation_policy',
      'client_environment_slow_start',
    ]);
  });

  it('legacy rule toggle writes the unified policy, defaults on first enable, and preserves custom cadence idempotently', async () => {
    const db = database();
    await db.store.init();

    const enabled = await db.store.writeLegacyRuleMode(
      'env-fb',
      {
        enabled: true,
        expectedRevision: 0,
        requestId: 'legacy-rule-enable',
        requiredOwnerUserId: 'customer-a',
      },
      'client_rule_compat:customer-a',
    );
    assert.equal(enabled.ok, true);
    if (enabled.ok) {
      assert.equal(enabled.changed, true);
      assert.equal(enabled.view.baseMode, 'rule');
      assert.deepEqual(enabled.view.rule, { viewsPerLike: 5, joinEveryNRounds: 2 });
      assert.equal(enabled.view.policyRevision, 1);
    }
    assert.deepEqual(
      {
        baseMode: db.policies.get('env-fb')?.base_mode,
        viewsPerLike: db.policies.get('env-fb')?.rule_views_per_like,
        joinEveryNRounds: db.policies.get('env-fb')?.rule_join_every_n_rounds,
      },
      { baseMode: 'rule', viewsPerLike: 5, joinEveryNRounds: 2 },
    );
    assert.equal(db.audits[0]?.[5], 'client_rule_compat');
    assert.equal(db.audits[0]?.[6], 'customer-a');

    const customized = await db.store.writeEnvironment(
      'env-fb',
      {
        expectedRevision: 1,
        mode: 'rule',
        rule: { viewsPerLike: 23, joinEveryNRounds: 7 },
        requestId: 'customize-rule-cadence',
      },
      'panel:alice',
    );
    assert.equal(customized.ok, true);
    const beforeIdempotent = {
      revisions: db.revisionAllocations,
      audits: db.audits.length,
      bumps: db.bumps.length,
    };
    const unchanged = await db.store.writeLegacyRuleMode(
      'env-fb',
      {
        enabled: true,
        expectedRevision: 2,
        requestId: 'legacy-rule-enable-again',
        requiredOwnerUserId: 'customer-a',
      },
      'client_rule_compat:customer-a',
    );
    assert.equal(unchanged.ok, true);
    if (unchanged.ok) {
      assert.equal(unchanged.changed, false);
      assert.deepEqual(unchanged.view.rule, {
        viewsPerLike: 23,
        joinEveryNRounds: 7,
      });
      assert.equal(unchanged.view.policyRevision, 2);
    }
    assert.deepEqual(
      {
        revisions: db.revisionAllocations,
        audits: db.audits.length,
        bumps: db.bumps.length,
      },
      beforeIdempotent,
    );

    const disabled = await db.store.writeLegacyRuleMode(
      'env-fb',
      {
        enabled: false,
        expectedRevision: 2,
        requestId: 'legacy-rule-disable',
        requiredOwnerUserId: 'customer-a',
      },
      'client_rule_compat:customer-a',
    );
    assert.equal(disabled.ok, true);
    if (disabled.ok) {
      assert.equal(disabled.changed, true);
      assert.equal(disabled.view.baseMode, 'persona');
      assert.deepEqual(disabled.view.rule, {
        viewsPerLike: 23,
        joinEveryNRounds: 7,
      });
      assert.equal(disabled.view.policyRevision, 3);
    }
  });

  it('legacy rule toggle rejects consumption, active slow start, stale revision, and ownership drift without mutation', async () => {
    const consumptionDb = database();
    await consumptionDb.store.init();
    const consumption = await consumptionDb.store.writeEnvironment(
      'env-fb',
      {
        expectedRevision: 0,
        mode: 'consumption',
        requestId: 'set-consumption',
      },
      'panel:alice',
    );
    assert.equal(consumption.ok, true);
    const beforeConsumptionConflict = {
      revisions: consumptionDb.revisionAllocations,
      audits: consumptionDb.audits.length,
      bumps: consumptionDb.bumps.length,
    };
    const consumptionConflict = await consumptionDb.store.writeLegacyRuleMode(
      'env-fb',
      {
        enabled: true,
        expectedRevision: 1,
        requestId: 'legacy-over-consumption',
        requiredOwnerUserId: 'customer-a',
      },
      'client_rule_compat:customer-a',
    );
    assert.equal(consumptionConflict.ok, false);
    if (!consumptionConflict.ok) {
      assert.equal(consumptionConflict.reason, 'mode_conflict');
      assert.equal(consumptionConflict.current?.baseMode, 'consumption');
    }
    assert.deepEqual(
      {
        revisions: consumptionDb.revisionAllocations,
        audits: consumptionDb.audits.length,
        bumps: consumptionDb.bumps.length,
      },
      beforeConsumptionConflict,
    );

    const slowDb = database();
    await slowDb.store.init();
    const slow = await slowDb.store.writeEnvironment(
      'env-fb',
      {
        expectedRevision: 0,
        mode: 'slow_start',
        requestId: 'set-slow-start',
      },
      'panel:alice',
    );
    assert.equal(slow.ok, true);
    const slowConflict = await slowDb.store.writeLegacyRuleMode(
      'env-fb',
      {
        enabled: true,
        expectedRevision: 1,
        requestId: 'legacy-over-slow-start',
        requiredOwnerUserId: 'customer-a',
      },
      'client_rule_compat:customer-a',
    );
    assert.equal(slowConflict.ok, false);
    if (!slowConflict.ok) {
      assert.equal(slowConflict.reason, 'mode_conflict');
      assert.equal(slowConflict.current?.effectiveMode, 'slow_start');
    }

    const stale = await slowDb.store.writeLegacyRuleMode(
      'env-fb',
      {
        enabled: false,
        expectedRevision: 0,
        requestId: 'legacy-stale',
        requiredOwnerUserId: 'customer-a',
      },
      'client_rule_compat:customer-a',
    );
    assert.equal(stale.ok, false);
    if (!stale.ok) {
      assert.equal(stale.reason, 'revision_conflict');
      assert.equal(stale.current?.policyRevision, 1);
    }

    const denied = await slowDb.store.writeLegacyRuleMode(
      'env-fb',
      {
        enabled: false,
        expectedRevision: 1,
        requestId: 'legacy-owner-drift',
        requiredOwnerUserId: 'customer-b',
      },
      'client_rule_compat:customer-b',
    );
    assert.deepEqual(denied, { ok: false, reason: 'environment_not_owned' });
  });

  it('legacy rule toggle follows effective slow-start state and ignores account-binding duplication', async () => {
    for (const inactiveSlowStart of [
      {
        state: 'graduated' as const,
        since: Date.now() - (8 * 86_400_000),
        globallyDisabled: false,
      },
      {
        state: 'off' as const,
        since: Date.now(),
        globallyDisabled: true,
      },
    ]) {
      const db = database();
      await db.store.init();
      const slow = await db.store.writeEnvironment(
        'env-fb',
        {
          expectedRevision: 0,
          mode: 'slow_start',
          requestId: `seed-${inactiveSlowStart.state}`,
        },
        'panel:alice',
      );
      assert.equal(slow.ok, true);
      assert.ok(db.environments.get('env-fb')?.slowStartSince);
      db.store.bindSlowStartResolver(async () => inactiveSlowStart);
      db.store.bindEnvironmentSlowStartResolver(async () => inactiveSlowStart.state);

      const enabled = await db.store.writeLegacyRuleMode(
        'env-fb',
        {
          enabled: true,
          expectedRevision: 1,
          requestId: `legacy-after-${inactiveSlowStart.state}`,
          requiredOwnerUserId: 'customer-a',
        },
        'client_rule_compat:customer-a',
      );
      assert.equal(enabled.ok, true);
      if (enabled.ok) {
        assert.equal(enabled.changed, true);
        assert.equal(enabled.view.baseMode, 'rule');
        assert.equal(enabled.view.effectiveMode, 'rule');
      }
    }

    const duplicate = database();
    await duplicate.store.init();
    const configured = await duplicate.store.writeLegacyRuleMode(
      'env-duplicate-a',
      {
        enabled: true,
        expectedRevision: 0,
        requestId: 'legacy-duplicate-binding',
      },
      'client_rule_compat:customer-a',
    );
    assert.equal(configured.ok, true);
    if (configured.ok) {
      assert.equal(configured.changed, true);
      assert.equal(configured.view.baseMode, 'rule');
      assert.equal(configured.view.binding.state, 'conflict');
      assert.equal(configured.view.effectiveMode, 'blocked');
    }

    const duplicateWithAnchor = database();
    await duplicateWithAnchor.store.init();
    duplicateWithAnchor.environments.get('env-duplicate-a')!.slowStartSince = new Date();
    const activeConflict = await duplicateWithAnchor.store.writeLegacyRuleMode(
      'env-duplicate-a',
      {
        enabled: true,
        expectedRevision: 0,
        requestId: 'legacy-duplicate-binding-active-anchor',
      },
      'client_rule_compat:customer-a',
    );
    assert.equal(activeConflict.ok, false);
    if (!activeConflict.ok) assert.equal(activeConflict.reason, 'mode_conflict');
    assert.equal(duplicateWithAnchor.revisionAllocations, 0);
    assert.equal(duplicateWithAnchor.audits.length, 0);
  });

  it('legacy slow-start accepts the fb alias and returns direct state for unbound envs', async () => {
    const db = database();
    await db.store.init();

    const alias = await db.store.writeLegacySlowStart(
      'env-fb-alias',
      { enabled: true, requestId: 'legacy-fb-alias' },
      'client:legacy',
    );
    assert.equal(alias.ok, true);
    if (alias.ok) assert.ok(alias.slowStartSince);

    const unbound = await db.store.writeLegacySlowStart(
      'env-unbound',
      { enabled: true, requestId: 'legacy-unbound' },
      'client:legacy',
    );
    assert.equal(unbound.ok, true);
    if (unbound.ok) {
      assert.equal(unbound.view.slowStart.state, 'active');
      assert.ok(
        unbound.slowStartSince,
        'unbound callers must receive the committed anchor and matching configured state',
      );
    }
  });

  it('customer unified policy writes revalidate ownership after locking the environment', async () => {
    const db = database();
    await db.store.init();

    const denied = await db.store.writeEnvironment(
      'env-fb',
      {
        expectedRevision: 0,
        mode: 'rule',
        requestId: 'unified-owner-denied',
        requiredOwnerUserId: 'customer-b',
      },
      'client:customer-b',
    );
    assert.deepEqual(denied, { ok: false, reason: 'environment_not_owned' });
    assert.equal(db.revisionAllocations, 0);
    assert.equal(db.audits.length, 0);

    const accepted = await db.store.writeEnvironment(
      'env-fb',
      {
        expectedRevision: 0,
        mode: 'rule',
        requestId: 'unified-owner-accepted',
        requiredOwnerUserId: 'customer-a',
      },
      'client:customer-a',
    );
    assert.equal(accepted.ok, true);
    assert.equal(db.revisionAllocations, 1);
    assert.equal(db.audits.length, 1);
  });

  it('legacy customer slow-start locks ownership in the policy transaction', async () => {
    const db = database();
    await db.store.init();

    const denied = await db.store.writeLegacySlowStart(
      'env-fb',
      {
        enabled: true,
        requestId: 'legacy-owner-denied',
        requiredOwnerUserId: 'customer-b',
      },
      'client:customer-b',
    );
    assert.deepEqual(denied, { ok: false, reason: 'environment_not_owned' });
    assert.equal(db.environments.get('env-fb')?.slowStartSince, null);
    assert.equal(db.revisionAllocations, 0);
    assert.equal(db.audits.length, 0);

    const accepted = await db.store.writeLegacySlowStart(
      'env-fb',
      {
        enabled: true,
        requestId: 'legacy-owner-accepted',
        requiredOwnerUserId: 'customer-a',
      },
      'client:customer-a',
    );
    assert.equal(accepted.ok, true);
    if (accepted.ok) assert.ok(accepted.slowStartSince);
    assert.equal(db.revisionAllocations, 1);
    assert.equal(db.audits.length, 1);
  });

  it('rejects duplicate-account and cross-customer binding conflicts before mutation', async () => {
    const db = database();
    await db.store.init();

    const duplicate = await db.store.writeEnvironment(
      'env-duplicate-a',
      {
        expectedRevision: 0,
        mode: 'rule',
        requestId: 'reject-duplicate-account',
      },
      'panel:alice',
    );
    const contended = await db.store.writeEnvironment(
      'env-owner-conflict',
      {
        expectedRevision: 0,
        mode: 'consumption',
        requestId: 'reject-owner-conflict',
      },
      'panel:alice',
    );
    const legacyContended = await db.store.writeLegacySlowStart(
      'env-owner-conflict',
      { enabled: true, requestId: 'reject-legacy-owner-conflict' },
      'client:legacy',
    );

    assert.deepEqual(duplicate, { ok: false, reason: 'binding_conflict' });
    assert.deepEqual(contended, { ok: false, reason: 'binding_conflict' });
    assert.deepEqual(legacyContended, { ok: false, reason: 'binding_conflict' });
    assert.equal(db.revisionAllocations, 0);
    assert.equal(db.audits.length, 0);
    assert.equal(db.bumps.length, 0);
    assert.equal(db.slowStartRefreshes, 0);
  });

  it('rejects stale and concurrent revisions without an audit side effect', async () => {
    const db = database();
    await db.store.init();
    const competingStore = new FacebookOperationPolicyStore({
      pool: db.pool,
      schemaProber: readySchema(),
      environmentResolver: () => ({ ok: true, envKey: 'env-fb' }),
      slowStartResolver: async () => {
        const since = db.environments.get('env-fb')!.slowStartSince;
        return since
          ? { state: 'active', since: since.getTime(), globallyDisabled: false }
          : { state: 'off', since: null, globallyDisabled: false };
      },
    });
    await competingStore.init();
    const [first, second] = await Promise.all([
      db.store.writeEnvironment(
        'env-fb',
        { expectedRevision: 0, mode: 'rule', requestId: 'request-a' },
        'panel:a',
      ),
      competingStore.writeEnvironment(
        'env-fb',
        { expectedRevision: 0, mode: 'consumption', requestId: 'request-b' },
        'panel:b',
      ),
    ]);
    assert.equal([first.ok, second.ok].filter(Boolean).length, 1);
    assert.equal(db.policies.get('env-fb')?.policy_revision, 1);
    assert.equal(db.audits.length, 1);
    const conflict = first.ok ? second : first;
    if (!conflict.ok) {
      assert.equal(conflict.reason, 'revision_conflict');
      assert.equal(conflict.current?.policyRevision, 1, 'conflict refreshes another process write');
    }
  });

  it('rolls back policy and slow-start anchor when audit insertion fails', async () => {
    const db = database();
    await db.store.init();
    db.failAudit();
    await assert.rejects(
      db.store.writeEnvironment(
        'env-fb',
        { expectedRevision: 0, mode: 'slow_start', requestId: 'request-fail' },
        'panel:alice',
      ),
      /audit failed/,
    );
    assert.equal(db.policies.size, 0);
    assert.equal(db.environments.get('env-fb')!.slowStartSince, null);
    assert.equal(db.audits.length, 0);
  });

  it('rejects unsupported platform before mutation', async () => {
    const db = database();
    await db.store.init();
    const result = await db.store.writeEnvironment(
      'env-xhs',
      { expectedRevision: 0, mode: 'rule', requestId: 'request-xhs' },
      'panel:alice',
    );
    assert.deepEqual(result, { ok: false, reason: 'unsupported_platform' });
    assert.equal(db.audits.length, 0);
  });

  it('api-mode wiring (no account slow-start resolver) still reports ramping for a bound environment', async () => {
    // getForEnv 是客户 HTTP 读写口的唯一取值处，而那个口跑在 api 进程：api 只跑 segA/segD，
    // `bindSlowStartResolver` 在 segCAutomation、根本不执行。这里刻意**不注入** slowStartResolver
    // 复现那个接线形态。若已绑账号的环境改回去问账号投影，它恒答 unknown ⇒ 凡跑过一次（因而绑了
    // 账号）的环境，客户端「运行方式」一律回落显示底模式、且设置冷启动后回读永远对不上。
    const db = database();
    await db.store.init();
    const seeded = await db.store.writeEnvironment(
      'env-fb',
      { expectedRevision: 0, mode: 'slow_start', requestId: 'api-mode-seed' },
      'panel:alice',
    );
    assert.equal(seeded.ok, true);
    assert.ok(db.environments.get('env-fb')?.accountId, '前置：该环境已绑账号（= 跑过至少一次）');

    const apiModeStore = new FacebookOperationPolicyStore({
      pool: db.pool,
      schemaProber: readySchema(),
      environmentResolver: () => ({ ok: true, envKey: 'env-fb' }),
      environmentSlowStartResolver: async ({ completedAt }) => (completedAt == null ? 'active' : 'graduated'),
    });
    await apiModeStore.init();
    const view = await apiModeStore.getForEnv('env-fb');
    assert.ok(view);
    assert.equal(view.binding.state, 'bound');
    assert.equal(view.slowStart.state, 'active');
    assert.equal(view.effectiveMode, 'slow_start');
    assert.equal(view.blocker, null);
  });
});
