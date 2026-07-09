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

test('canonicalFacebookGroupUrl normalizes supported Facebook group URLs', () => {
  assert.equal(
    canonicalFacebookGroupUrl('https://m.facebook.com/groups/my.group_123?sorting_setting=CHRONOLOGICAL'),
    'https://www.facebook.com/groups/my.group_123',
  );
  assert.equal(
    canonicalFacebookGroupUrl('facebook.com/groups/123456789/posts/42'),
    'https://www.facebook.com/groups/123456789',
  );
  assert.equal(canonicalFacebookGroupUrl('https://example.com/groups/123'), null);
  assert.equal(canonicalFacebookGroupUrl('https://www.facebook.com/profile.php?id=1'), null);
});

test('FacebookGroupTargetStore.importTargets deduplicates canonical URLs before insert', async () => {
  const inserted = new Set<string>();
  const pool = {
    query: async (_sql: string, params: unknown[]) => {
      const groupUrl = params[0] as string;
      if (inserted.has(groupUrl)) return { rows: [] };
      inserted.add(groupUrl);
      return {
        rows: [
          {
            group_url: groupUrl,
            group_name: params[1] ?? null,
            join_gating: 'unknown',
            priority: 0,
            enabled: true,
            import_batch: params[2] ?? null,
            created_at: new Date('2026-07-09T00:00:00.000Z'),
            updated_at: new Date('2026-07-09T00:00:00.000Z'),
          },
        ],
      };
    },
  } as unknown as pg.Pool;
  const store = new FacebookGroupTargetStore({ pool });
  const result = await store.importTargets(
    [
      { url: 'https://www.facebook.com/groups/group-a?ref=share', name: 'Group A' },
      { url: 'https://m.facebook.com/groups/group-a/posts/123' },
      { url: 'https://not-facebook.test/groups/group-b' },
    ],
    'batch-1',
  );

  assert.equal(result.imported, 1);
  assert.equal(result.duplicate, 1);
  assert.equal(result.invalid, 1);
  assert.equal(result.rows[0].groupUrl, 'https://www.facebook.com/groups/group-a');
  assert.equal(result.rows[0].groupName, 'Group A');
  assert.equal(result.rows[0].importBatch, 'batch-1');
});

test('facebook group schemas include one-group-one-account lock, coverage indexes, and audit table', () => {
  assert.match(FACEBOOK_GROUP_TARGET_SCHEMA_SQL, /CREATE TABLE IF NOT EXISTS facebook_group_target/);
  assert.match(FACEBOOK_GROUP_TARGET_SCHEMA_SQL, /join_gating IN \('unknown','instant','gated'\)/);
  assert.match(FACEBOOK_GROUP_TARGET_SCHEMA_SQL, /idx_fb_group_target_enabled_gating/);
  assert.match(FACEBOOK_GROUP_MEMBERSHIP_SCHEMA_SQL, /CREATE TABLE IF NOT EXISTS facebook_group_membership/);
  assert.match(FACEBOOK_GROUP_MEMBERSHIP_SCHEMA_SQL, /UNIQUE \(group_url\)/);
  assert.match(FACEBOOK_GROUP_MEMBERSHIP_SCHEMA_SQL, /idx_fb_group_membership_account_status/);
  assert.match(FACEBOOK_GROUP_MEMBERSHIP_SCHEMA_SQL, /idx_fb_group_membership_coverage/);
  assert.match(FACEBOOK_GROUP_JOIN_AUDIT_SCHEMA_SQL, /CREATE TABLE IF NOT EXISTS facebook_group_join_audit/);
  assert.match(FACEBOOK_GROUP_JOIN_AUDIT_SCHEMA_SQL, /observation JSONB/);
});
