import { test } from 'node:test';
import assert from 'node:assert/strict';
import type pg from 'pg';
import {
  FACEBOOK_GROUP_JOIN_AUDIT_SCHEMA_SQL,
  FACEBOOK_GROUP_MEMBERSHIP_SCHEMA_SQL,
  FACEBOOK_GROUP_TARGET_SCHEMA_SQL,
  FacebookGroupJoinAuditStore,
  FacebookGroupMembershipStore,
  FacebookGroupScopeError,
  FacebookGroupTargetStore,
  canonicalFacebookGroupUrl,
  normalizeFacebookAccountGroupLabels,
} from '../../src/comment-agent/facebook-group-store.js';

function targetRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    group_url: 'https://www.facebook.com/groups/group-a',
    group_name: 'Group A',
    region: null,
    park: null,
    direction: null,
    join_gating: 'unknown',
    priority: 0,
    enabled: true,
    import_batch: null,
    created_at: new Date('2026-07-09T00:00:00.000Z'),
    updated_at: new Date('2026-07-09T00:00:00.000Z'),
    ...overrides,
  };
}

test('canonicalFacebookGroupUrl normalizes supported Facebook group URLs', () => {
  assert.equal(
    canonicalFacebookGroupUrl('https://m.facebook.com/groups/my.group_123?sorting_setting=CHRONOLOGICAL'),
    'https://www.facebook.com/groups/my.group_123',
  );
  assert.equal(
    canonicalFacebookGroupUrl('facebook.com/groups/123456789/posts/42'),
    'https://www.facebook.com/groups/123456789',
  );
  assert.equal(
    canonicalFacebookGroupUrl('https://www.facebook.com/groups/322376783153364/?__cft__[0]=abc&__tn__=-UC'),
    'https://www.facebook.com/groups/322376783153364',
  );
  assert.equal(canonicalFacebookGroupUrl('https://example.com/groups/123'), null);
  assert.equal(canonicalFacebookGroupUrl('https://www.facebook.com/profile.php?id=1'), null);
});

test('account group scopes trim/dedupe/sort and reject empty or overlong labels', () => {
  assert.deepEqual(normalizeFacebookAccountGroupLabels([' 招聘组 ', '华东组', '招聘组']), ['华东组', '招聘组']);
  assert.equal(normalizeFacebookAccountGroupLabels(['']), null);
  assert.equal(normalizeFacebookAccountGroupLabels(['x'.repeat(65)]), null);
});

test('FacebookGroupTargetStore.importTargets stores metadata and deduplicates canonical URLs before insert', async () => {
  const inserted = new Set<string>();
  const pool = {
    query: async (_sql: string, params: unknown[]) => {
      const groupUrl = params[0] as string;
      if (inserted.has(groupUrl)) return { rows: [] };
      inserted.add(groupUrl);
      return {
        rows: [
          targetRow({
            group_url: groupUrl,
            group_name: params[1] ?? null,
            region: params[2] ?? null,
            park: params[3] ?? null,
            direction: params[4] ?? null,
            import_batch: params[5] ?? null,
          }),
        ],
      };
    },
  } as unknown as pg.Pool;
  const store = new FacebookGroupTargetStore({ pool });
  const result = await store.importTargets(
    [
      {
        url: 'https://www.facebook.com/groups/group-a?ref=share',
        name: 'Group A',
        region: '河南区域',
        park: '同文1工业区',
        direction: '机械和电气',
      },
      { url: 'https://m.facebook.com/groups/group-a/posts/123' },
      { url: 'https://not-facebook.test/groups/group-b' },
    ],
    'batch-1',
  );

  assert.equal(result.imported, 1);
  assert.equal(result.updated, 0);
  assert.equal(result.duplicate, 1);
  assert.equal(result.invalid, 1);
  assert.equal(result.rows[0].groupUrl, 'https://www.facebook.com/groups/group-a');
  assert.equal(result.rows[0].groupName, 'Group A');
  assert.equal(result.rows[0].region, '河南区域');
  assert.equal(result.rows[0].park, '同文1工业区');
  assert.equal(result.rows[0].direction, '机械和电气');
  assert.equal(result.rows[0].importBatch, 'batch-1');
  assert.deepEqual(result.rows[0].accountGroupLabels, [], '未携带范围的新目标保持无范围');
});

test('FacebookGroupTargetStore.importTargets validates explicit scopes before target writes and applies one common multi-scope set atomically', async () => {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  let rolledBack = false;
  const client = {
    query: async (sql: string, params: unknown[] = []) => {
      calls.push({ sql, params: [...params] });
      if (sql === 'BEGIN' || sql === 'COMMIT') return { rows: [] };
      if (sql === 'ROLLBACK') {
        rolledBack = true;
        return { rows: [] };
      }
      if (sql.includes('SELECT DISTINCT group_label')) {
        return { rows: [{ group_label: '招聘组' }, { group_label: '华东组' }] };
      }
      if (sql.includes('INSERT INTO facebook_group_target')) {
        return { rows: [targetRow({ group_url: params[0] })] };
      }
      if (sql.includes('SELECT t.group_url') && sql.includes('account_group_labels')) {
        const groupUrls = params[0] as string[];
        return { rows: [{ group_url: groupUrls[0], account_group_labels: ['招聘组', '华东组'] }] };
      }
      return { rows: [] };
    },
    release() {},
  };
  const pool = { connect: async () => client } as unknown as pg.Pool;
  const store = new FacebookGroupTargetStore({ pool });
  const result = await store.importTargets(
    [{ url: 'https://www.facebook.com/groups/group-a' }],
    'batch-scope',
    { accountGroupLabels: [' 华东组 ', '招聘组'], updatedBy: 'panel:alice' },
  );
  assert.equal(rolledBack, false);
  assert.deepEqual(result.rows[0].accountGroupLabels, ['招聘组', '华东组']);
  const validationIndex = calls.findIndex((call) => call.sql.includes('SELECT DISTINCT group_label'));
  const targetWriteIndex = calls.findIndex((call) => call.sql.includes('INSERT INTO facebook_group_target'));
  assert.ok(validationIndex >= 0 && validationIndex < targetWriteIndex, '范围必须在任何目标写之前验证');
  assert.ok(calls.some((call) => call.sql.includes('DELETE FROM facebook_group_target_scope')));
  assert.ok(calls.some((call) => call.sql.includes('CROSS JOIN unnest($2::text[])')));

  calls.length = 0;
  const rejectingClient = {
    ...client,
    query: async (sql: string, params: unknown[] = []) => {
      calls.push({ sql, params: [...params] });
      if (sql === 'BEGIN' || sql === 'ROLLBACK') return { rows: [] };
      if (sql.includes('SELECT DISTINCT group_label')) return { rows: [] };
      throw new Error(`非法范围验证后不应继续执行: ${sql}`);
    },
  };
  const rejectingStore = new FacebookGroupTargetStore({
    pool: { connect: async () => rejectingClient } as unknown as pg.Pool,
  });
  await assert.rejects(
    rejectingStore.importTargets(
      [{ url: 'https://www.facebook.com/groups/group-b' }],
      null,
      { accountGroupLabels: ['非 Facebook 分组'], updatedBy: 'panel:alice' },
    ),
    (error: unknown) => error instanceof FacebookGroupScopeError && error.reason === 'invalid_account_group',
  );
  assert.equal(calls.some((call) => call.sql.includes('INSERT INTO facebook_group_target')), false);
  assert.ok(calls.some((call) => call.sql === 'ROLLBACK'));
});

test('FacebookGroupTargetStore.importTargets enriches existing targets without resetting join fields', async () => {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const pool = {
    query: async (sql: string, params: unknown[]) => {
      calls.push({ sql, params: [...params] });
      if (sql.includes('INSERT INTO facebook_group_target')) return { rows: [] };
      if (sql.includes('UPDATE facebook_group_target')) {
        return {
          rows: [
            targetRow({
              group_url: params[0],
              group_name: params[1],
              region: params[2],
              park: params[3],
              direction: params[4],
              import_batch: params[5],
              join_gating: 'gated',
              priority: 7,
              enabled: false,
            }),
          ],
        };
      }
      return { rows: [] };
    },
  } as unknown as pg.Pool;
  const store = new FacebookGroupTargetStore({ pool });
  const result = await store.importTargets(
    [{ url: 'https://www.facebook.com/groups/group-a?locale=vi_VN', name: 'Group A', region: '北宁区域', park: '周山工业区/VSIP 1' }],
    'batch-2',
  );

  assert.equal(result.imported, 0);
  assert.equal(result.updated, 1);
  assert.equal(result.duplicate, 0);
  assert.equal(result.rows[0].region, '北宁区域');
  assert.equal(result.rows[0].park, '周山工业区/VSIP 1');
  assert.equal(result.rows[0].joinGating, 'gated');
  assert.equal(result.rows[0].priority, 7);
  assert.equal(result.rows[0].enabled, false);
  assert.doesNotMatch(calls[1].sql, /SET\s+enabled/i);
  assert.doesNotMatch(calls[1].sql, /SET\s+priority/i);
  assert.equal(
    calls.some((call) => call.sql.includes('DELETE FROM facebook_group_target_scope')),
    false,
    '范围字段缺省时必须保留既有映射',
  );
});

test('FacebookGroupTargetStore.replaceTargetScopes bulk-replaces and reads database truth in one transaction', async () => {
  const urls = [
    'https://www.facebook.com/groups/group-a',
    'https://www.facebook.com/groups/group-b',
  ];
  const calls: string[] = [];
  const client = {
    query: async (sql: string) => {
      calls.push(sql);
      if (sql.includes('SELECT DISTINCT group_label')) return { rows: [{ group_label: '华东组' }, { group_label: '招聘组' }] };
      if (sql.includes('SELECT group_url FROM facebook_group_target')) return { rows: urls.map((group_url) => ({ group_url })) };
      if (sql.includes('scope_updated_at, t.scope_updated_by')) {
        return { rows: urls.map((group_url) => ({
          group_url,
          account_group_labels: ['华东组', '招聘组'],
          scope_updated_at: '2026-07-22T08:00:00.000Z',
          scope_updated_by: 'alice',
        })) };
      }
      return { rows: [] };
    },
    release() {},
  };
  const store = new FacebookGroupTargetStore({
    pool: { connect: async () => client } as unknown as pg.Pool,
  });
  const result = await store.replaceTargetScopes(urls, ['招聘组', '华东组'], 'alice');
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.items.length, 2);
  assert.ok(result.items.every((row) => row.accountGroupLabels.length === 2 && row.updatedBy === 'alice'));
  assert.ok(calls.some((sql) => sql.includes('DELETE FROM facebook_group_target_scope')));
  assert.ok(calls.some((sql) => sql.includes('CROSS JOIN unnest($2::text[])')));
  assert.ok(calls.includes('COMMIT'));
});

test('FacebookGroupTargetStore.importTargets explicit empty scopes clears mappings', async () => {
  const calls: string[] = [];
  const client = {
    query: async (sql: string, params: unknown[] = []) => {
      calls.push(sql);
      if (sql.includes('INSERT INTO facebook_group_target')) return { rows: [targetRow({ group_url: params[0] })] };
      if (sql.includes('SELECT t.group_url') && sql.includes('account_group_labels')) {
        const groupUrls = params[0] as string[];
        return { rows: [{ group_url: groupUrls[0], account_group_labels: [] }] };
      }
      return { rows: [] };
    },
    release() {},
  };
  const store = new FacebookGroupTargetStore({ pool: { connect: async () => client } as unknown as pg.Pool });
  const result = await store.importTargets(
    [{ url: 'https://www.facebook.com/groups/group-a' }],
    null,
    { accountGroupLabels: [], updatedBy: 'alice' },
  );
  assert.deepEqual(result.rows[0].accountGroupLabels, []);
  assert.ok(calls.some((sql) => sql.includes('DELETE FROM facebook_group_target_scope')));
  assert.equal(calls.some((sql) => sql.includes('INSERT INTO facebook_group_target_scope')), false);
});

test('FacebookGroupTargetStore.listTargets applies metadata filters with existing filters', async () => {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const pool = {
    query: async (sql: string, params: unknown[]) => {
      calls.push({ sql, params: [...params] });
      if (sql.startsWith('SELECT count')) return { rows: [{ total: '1' }] };
      return {
        rows: [
          {
            ...targetRow({ region: '北宁区域', park: '周山工业区/VSIP 1', direction: '机械和电气' }),
            account_group_labels: ['招聘组', '华东组'],
            account_id: 'acc-1',
            membership_status: 'joined',
            joined_at: null,
            last_attempt_at: null,
            last_reason: null,
            last_commented_at: null,
            comments_total: 0,
          },
        ],
      };
    },
  } as unknown as pg.Pool;
  const store = new FacebookGroupTargetStore({ pool });
  const result = await store.listTargets({
    limit: 50,
    offset: 10,
    enabled: true,
    status: 'joined',
    region: ' 北宁区域 ',
    park: '周山工业区/VSIP 1',
    direction: '机械和电气',
    accountGroupLabel: '华东组',
  });

  assert.equal(result.total, 1);
  assert.equal(result.items[0].region, '北宁区域');
  assert.equal(result.items[0].park, '周山工业区/VSIP 1');
  assert.equal(result.items[0].direction, '机械和电气');
  assert.deepEqual(result.items[0].accountGroupLabels, ['招聘组', '华东组']);
  assert.deepEqual(calls[0].params, [true, 'joined', '北宁区域', '周山工业区/VSIP 1', '机械和电气', '华东组']);
  assert.deepEqual(calls[1].params, [true, 'joined', '北宁区域', '周山工业区/VSIP 1', '机械和电气', '华东组', 50, 10]);
  assert.match(calls[1].sql, /t\.region = \$3/);
  assert.match(calls[1].sql, /t\.park = \$4/);
  assert.match(calls[1].sql, /t\.direction = \$5/);
  assert.match(calls[1].sql, /sf\.account_group_label = \$6/);
});

test('FacebookGroupTargetStore.listFacets groups parks under regions and omits null metadata', async () => {
  const pool = {
    query: async (sql: string) => {
      if (sql.includes('DISTINCT region, park')) {
        return {
          rows: [
            { region: '河南区域', park: '同文2工业区' },
            { region: '河南区域', park: '同文1工业区' },
            { region: '北宁区域', park: '周山工业区/VSIP 1' },
            { region: '北宁区域', park: null },
          ],
        };
      }
      if (sql.includes('DISTINCT direction')) {
        return { rows: [{ direction: '机械和电气' }, { direction: '全国机电' }, { direction: null }] };
      }
      if (sql.includes('group_label AS account_group_label')) {
        return { rows: [{ account_group_label: '华东组' }, { account_group_label: '招聘组' }] };
      }
      return { rows: [{ total: '2' }] };
    },
  } as unknown as pg.Pool;
  const store = new FacebookGroupTargetStore({ pool });

  assert.deepEqual(await store.listFacets(), {
    regions: [
      { region: '河南区域', parks: ['同文1工业区', '同文2工业区'] },
      { region: '北宁区域', parks: ['周山工业区/VSIP 1'] },
    ],
    directions: ['机械和电气', '全国机电'],
    accountGroupLabels: ['华东组', '招聘组'],
    unscopedTargetCount: 2,
  });
});

test('facebook group schemas include one-group-one-account lock, coverage indexes, and audit table', () => {
  assert.match(FACEBOOK_GROUP_TARGET_SCHEMA_SQL, /CREATE TABLE IF NOT EXISTS facebook_group_target/);
  assert.match(FACEBOOK_GROUP_TARGET_SCHEMA_SQL, /region\s+TEXT/);
  assert.match(FACEBOOK_GROUP_TARGET_SCHEMA_SQL, /park\s+TEXT/);
  assert.match(FACEBOOK_GROUP_TARGET_SCHEMA_SQL, /direction\s+TEXT/);
  assert.match(FACEBOOK_GROUP_TARGET_SCHEMA_SQL, /join_gating IN \('unknown','instant','gated'\)/);
  assert.match(FACEBOOK_GROUP_TARGET_SCHEMA_SQL, /idx_fb_group_target_enabled_gating/);
  assert.match(FACEBOOK_GROUP_TARGET_SCHEMA_SQL, /idx_fb_group_target_region_park/);
  assert.match(FACEBOOK_GROUP_TARGET_SCHEMA_SQL, /idx_fb_group_target_direction/);
  assert.match(FACEBOOK_GROUP_TARGET_SCHEMA_SQL, /CREATE TABLE IF NOT EXISTS facebook_group_target_scope/);
  assert.match(FACEBOOK_GROUP_TARGET_SCHEMA_SQL, /PRIMARY KEY \(group_url, account_group_label\)/);
  assert.match(FACEBOOK_GROUP_MEMBERSHIP_SCHEMA_SQL, /CREATE TABLE IF NOT EXISTS facebook_group_membership/);
  assert.match(FACEBOOK_GROUP_MEMBERSHIP_SCHEMA_SQL, /UNIQUE \(group_url\)/);
  assert.match(FACEBOOK_GROUP_MEMBERSHIP_SCHEMA_SQL, /idx_fb_group_membership_account_status/);
  assert.match(FACEBOOK_GROUP_MEMBERSHIP_SCHEMA_SQL, /idx_fb_group_membership_coverage/);
  assert.match(FACEBOOK_GROUP_JOIN_AUDIT_SCHEMA_SQL, /CREATE TABLE IF NOT EXISTS facebook_group_join_audit/);
  assert.match(FACEBOOK_GROUP_JOIN_AUDIT_SCHEMA_SQL, /observation JSONB/);
  assert.match(FACEBOOK_GROUP_JOIN_AUDIT_SCHEMA_SQL, /trigger_source IN \('scheduled','manual_pool','manual_specific','shadow'\)/);
});

test('claimNext is scope-bound, fails closed for ungrouped/unmapped accounts, and retains the global atomic group lock', async () => {
  let capturedSql = '';
  let capturedParams: unknown[] = [];
  const pool = {
    query: async (sql: string, params: unknown[]) => {
      capturedSql = sql;
      capturedParams = params;
      return { rows: [] };
    },
  } as unknown as pg.Pool;
  const store = new FacebookGroupMembershipStore({ pool });
  assert.equal(await store.claimNext('acc-fb'), null);
  assert.deepEqual(capturedParams, ['acc-fb']);
  assert.match(capturedSql, /FROM accounts a/);
  assert.match(capturedSql, /JOIN facebook_group_target_scope s ON s\.account_group_label = a\.group_label/);
  assert.match(capturedSql, /a\.group_label IS NOT NULL AND btrim\(a\.group_label\) <> ''/);
  assert.match(capturedSql, /NOT EXISTS \(\s*SELECT 1 FROM facebook_group_membership m WHERE m\.group_url = t\.group_url/);
  assert.match(capturedSql, /FOR UPDATE OF t SKIP LOCKED/);
  assert.match(capturedSql, /ON CONFLICT \(group_url\) DO NOTHING/);
  assert.doesNotMatch(capturedSql, /LEFT JOIN facebook_group_target_scope/, '不得回退全局目录');
});

test('revalidateScopedAssignment releases only unfinished mismatches and preserves terminal facts', async () => {
  const calls: string[] = [];
  const mismatchPool = {
    query: async (sql: string) => {
      calls.push(sql);
      if (sql.startsWith('DELETE')) return { rows: [], rowCount: 1 };
      throw new Error('scope mismatch 删除后不应再查状态');
    },
  } as unknown as pg.Pool;
  const mismatchStore = new FacebookGroupMembershipStore({ pool: mismatchPool });
  assert.equal(await mismatchStore.revalidateScopedAssignment('acc-fb', 'https://facebook.com/groups/group-a'), 'scope_mismatch');
  assert.match(calls[0], /m\.status IN \('assigned','joining'\)/);
  assert.match(calls[0], /facebook_group_target_scope/);

  const terminalPool = {
    query: async (sql: string) => sql.startsWith('DELETE')
      ? { rows: [], rowCount: 0 }
      : { rows: [{ status: 'joined' }] },
  } as unknown as pg.Pool;
  const terminalStore = new FacebookGroupMembershipStore({ pool: terminalPool });
  assert.equal(await terminalStore.revalidateScopedAssignment('acc-fb', 'https://facebook.com/groups/group-a'), 'terminal');
});

test('join audit persists trigger source and latestScheduledResult ignores newer manual rows by SQL contract', async () => {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const pool = {
    query: async (sql: string, params: unknown[] = []) => {
      calls.push({ sql, params });
      if (sql.startsWith('SELECT outcome')) {
        return { rows: [{ outcome: 'joined', reason: null, group_url: 'https://www.facebook.com/groups/group-a', created_at: '2026-07-22T08:00:00.000Z' }] };
      }
      return { rows: [] };
    },
  } as unknown as pg.Pool;
  const store = new FacebookGroupJoinAuditStore({ pool });
  await store.append({ accountId: 'acc-fb', outcome: 'joined', triggerSource: 'manual_specific' });
  assert.equal(calls[0].params[8], 'manual_specific');
  const latest = await store.latestScheduledResult('acc-fb');
  assert.equal(latest?.outcome, 'joined');
  assert.match(calls[1].sql, /trigger_source = 'scheduled'/);
  assert.match(calls[1].sql, /ORDER BY created_at DESC, id DESC/);
});

test('FacebookGroupMembershipStore.markTransientRetry: status=assigned + attempts 回退一格 + 短冷却（P1-5，不计尝试上限）', async () => {
  let capturedSql = '';
  let capturedParams: unknown[] = [];
  const pool = {
    query: async (sql: string, params: unknown[]) => {
      capturedSql = sql;
      capturedParams = params;
      return { rows: [] };
    },
  } as unknown as pg.Pool;
  const store = new FacebookGroupMembershipStore({ pool });
  await store.markTransientRetry('acc-fb', 'https://www.facebook.com/groups/123', 'not_ready', { backoffMs: 120_000 });
  // status 永远 assigned（可重试、绝不永久 failed）；attempts 回退抵消 markJoining 的 +1（瞬态不消耗 cap）；短冷却按 backoff。
  assert.match(capturedSql, /status = 'assigned'/);
  assert.match(capturedSql, /attempts = GREATEST\(0, attempts - 1\)/);
  assert.match(capturedSql, /cooldown_until = now\(\) \+ \(\$4::double precision \* interval '1 second'\)/);
  assert.equal(capturedParams[0], 'acc-fb');
  assert.equal(capturedParams[1], 'https://www.facebook.com/groups/123');
  assert.equal(capturedParams[2], 'not_ready');
  assert.equal(capturedParams[3], 120); // backoffSeconds = 120_000ms / 1000
});

test('reclaimStaleAssignments releases only bounded idle assigned/joining rows', async () => {
  let capturedSql = '';
  let capturedParams: unknown[] = [];
  const pool = {
    query: async (sql: string, params: unknown[]) => {
      capturedSql = sql;
      capturedParams = params;
      return { rows: [], rowCount: 2 };
    },
  } as unknown as pg.Pool;
  const store = new FacebookGroupMembershipStore({ pool });
  assert.equal(await store.reclaimStaleAssignments(15 * 60_000), 2);
  assert.match(capturedSql, /status IN \('assigned','joining'\)/);
  assert.match(capturedSql, /assigned_at < now\(\) -/);
  assert.deepEqual(capturedParams, [900]);
});

test('coverageCandidates: 正常查询保留预热/冷却/cooldown_until 三重时限闸', async () => {
  let capturedSql = '';
  let capturedParams: unknown[] = [];
  const pool = {
    query: async (sql: string, params: unknown[]) => {
      capturedSql = sql;
      capturedParams = params;
      return { rows: [] };
    },
  } as unknown as pg.Pool;
  const store = new FacebookGroupMembershipStore({ pool });
  await store.coverageCandidates('acc-fb', { limit: 5, cooldownMs: 72 * 3600_000, warmupMs: 24 * 3600_000 });
  // 三重时限闸都在：预热（joined_at）、cooldown_until、冷却（last_commented_at）。
  assert.match(capturedSql, /joined_at <= now\(\)/);
  assert.match(capturedSql, /cooldown_until IS NULL OR cooldown_until <= now\(\)/);
  assert.match(capturedSql, /last_commented_at IS NULL OR last_commented_at <= now\(\)/);
  assert.match(capturedSql, /ORDER BY last_commented_at ASC NULLS FIRST/);
  assert.equal(capturedParams[0], 'acc-fb');
});

test('coverageCandidates: relaxed=true 放开时限——丢弃预热/冷却/cooldown_until 三闸、只留 status=joined + 最久没评排序', async () => {
  let capturedSql = '';
  let capturedParams: unknown[] = [];
  const pool = {
    query: async (sql: string, params: unknown[]) => {
      capturedSql = sql;
      capturedParams = params;
      return { rows: [] };
    },
  } as unknown as pg.Pool;
  const store = new FacebookGroupMembershipStore({ pool });
  await store.coverageCandidates('acc-fb', { limit: 5, relaxed: true });
  // 放开时限：三重时限闸（WHERE 子句）全部消失，坏群仍靠 status='joined' 排除（已降级为 left 的群 status≠joined）。
  // 注：cooldown_until / last_commented_at 仍作为 SELECT 列名 / ORDER BY 出现，这里只断言它们不再作为时限过滤闸。
  assert.doesNotMatch(capturedSql, /joined_at <= now\(\)/);
  assert.doesNotMatch(capturedSql, /cooldown_until <= now\(\)/);
  assert.doesNotMatch(capturedSql, /last_commented_at <= now\(\)/);
  // 仍只选加入群，仍按「最久没评优先」排序取窗口。
  assert.match(capturedSql, /status = 'joined'/);
  assert.match(capturedSql, /ORDER BY last_commented_at ASC NULLS FIRST/);
  assert.deepEqual(capturedParams, ['acc-fb', 5]);
});
