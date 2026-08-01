import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type pg from 'pg';
import type { SchemaProber } from '../../src/kernel/schema-capability-contract.js';
import type { MirrorVersionBumper } from '../../src/config/mirror-version-store.js';
import { FacebookOperationPolicyStore } from '../../src/config/facebook-operation-policy-store.js';

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
      ...(withGlobal ? [
        'facebook_operation_global_policy.execution_target',
        'facebook_operation_global_policy.persona_reel_views_per_like',
        'facebook_operation_global_policy.persona_reel_views_per_follow',
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
  let globalRow: GlobalPolicyRow = {
    execution_target: options.executionTarget ?? 'dev',
    persona_reel_views_per_like: 4,
    persona_reel_views_per_follow: 10,
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
        slow_start_reel_views_per_follow: Number(params[3]),
        rule_reel_views_per_follow: Number(params[4]),
        consumption_reel_views_per_follow: Number(params[5]),
        rule_views_per_like: Number(params[6]),
        rule_join_every_n_rounds: Number(params[7]),
        consumption_views_per_like: Number(params[8]),
        consumption_confirmed_likes_per_join: Number(params[9]),
        consumption_confirmed_joins_per_comment: Number(params[10]),
        slow_start_total_days: Number(params[11]),
        slow_start_daily_caps: JSON.parse(String(params[12])),
        revision: Number(params[13]),
        updated_at: new Date(),
        updated_by: String(params[14]),
      };
      return { rows: [{ ...globalRow }], rowCount: 1 };
    }
    if (sql.startsWith('INSERT INTO facebook_operation_global_policy_audit')) {
      globalAudits.push(params);
      return { rows: [], rowCount: 1 };
    }
    if (sql.startsWith('INSERT INTO facebook_environment_slow_start_completion')) {
      graduationMarks.push(params);
      return { rows: [], rowCount: 0 };
    }
    if (sql.startsWith('SELECT env_key,base_mode') && !sql.includes('WHERE env_key=')) {
      const rows = sql.includes("WHERE cadence_source='global'")
        ? [...policies.values()].filter((row) => row.cadence_source === 'global')
        : [...policies.values()];
      return { rows, rowCount: rows.length };
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
      env.slowStartSince = params[1] === true
        ? env.slowStartSince ?? (params[2] instanceof Date ? params[2] : null)
        : null;
      return { rows: [], rowCount: 1 };
    }
    if (sql.startsWith('INSERT INTO facebook_operation_policy_audit')) {
      if (auditFailure) throw new Error('audit failed');
      audits.push(params);
      return { rows: [], rowCount: 1 };
    }
    if (sql.startsWith('DELETE FROM facebook_environment_slow_start_completion')) {
      return { rows: [], rowCount: 0 };
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
            slow: Map<string, Date | null>;
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
              slow: new Map([...environments].map(([key, env]) => [key, env.slowStartSince])),
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
              globalRow = snapshot.globalRow;
              globalAudits = snapshot.globalAudits;
              graduationMarks = snapshot.graduationMarks;
              for (const [key, since] of snapshot.slow) {
                environments.get(key)!.slowStartSince = since;
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
    environmentSlowStartResolver: async () => 'active',
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
          slowStart: { viewsPerFollow: 16 },
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
        slowStart: { viewsPerFollow: 16 },
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
    assert.deepEqual(db.bumps.slice(-2), [
      'content_schedule',
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
    for (const invalidViewsPerLike of [1.5, 101]) {
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
            persona: {
              ...current.reels.persona,
              viewsPerLike: invalidViewsPerLike,
            },
          },
          slowStart: current.slowStart,
          requestId: `bad-reel-cadence-${invalidViewsPerLike}`,
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
});
