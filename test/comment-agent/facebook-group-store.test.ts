import { test } from 'node:test';
import assert from 'node:assert/strict';
import type pg from 'pg';
import {
  FACEBOOK_GROUP_JOIN_AUDIT_SCHEMA_SQL,
  FACEBOOK_GROUP_MEMBERSHIP_SCHEMA_SQL,
  FACEBOOK_GROUP_TARGET_SCHEMA_SQL,
  FacebookGroupTargetStore,
  canonicalFacebookGroupUrl,
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
  });

  assert.equal(result.total, 1);
  assert.equal(result.items[0].region, '北宁区域');
  assert.equal(result.items[0].park, '周山工业区/VSIP 1');
  assert.equal(result.items[0].direction, '机械和电气');
  assert.deepEqual(calls[0].params, [true, 'joined', '北宁区域', '周山工业区/VSIP 1', '机械和电气']);
  assert.deepEqual(calls[1].params, [true, 'joined', '北宁区域', '周山工业区/VSIP 1', '机械和电气', 50, 10]);
  assert.match(calls[1].sql, /t\.region = \$3/);
  assert.match(calls[1].sql, /t\.park = \$4/);
  assert.match(calls[1].sql, /t\.direction = \$5/);
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
      return { rows: [{ direction: '机械和电气' }, { direction: '全国机电' }, { direction: null }] };
    },
  } as unknown as pg.Pool;
  const store = new FacebookGroupTargetStore({ pool });

  assert.deepEqual(await store.listFacets(), {
    regions: [
      { region: '河南区域', parks: ['同文1工业区', '同文2工业区'] },
      { region: '北宁区域', parks: ['周山工业区/VSIP 1'] },
    ],
    directions: ['机械和电气', '全国机电'],
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
  assert.match(FACEBOOK_GROUP_MEMBERSHIP_SCHEMA_SQL, /CREATE TABLE IF NOT EXISTS facebook_group_membership/);
  assert.match(FACEBOOK_GROUP_MEMBERSHIP_SCHEMA_SQL, /UNIQUE \(group_url\)/);
  assert.match(FACEBOOK_GROUP_MEMBERSHIP_SCHEMA_SQL, /idx_fb_group_membership_account_status/);
  assert.match(FACEBOOK_GROUP_MEMBERSHIP_SCHEMA_SQL, /idx_fb_group_membership_coverage/);
  assert.match(FACEBOOK_GROUP_JOIN_AUDIT_SCHEMA_SQL, /CREATE TABLE IF NOT EXISTS facebook_group_join_audit/);
  assert.match(FACEBOOK_GROUP_JOIN_AUDIT_SCHEMA_SQL, /observation JSONB/);
});
