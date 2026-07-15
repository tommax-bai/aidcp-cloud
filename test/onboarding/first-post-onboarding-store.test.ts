import { test } from 'node:test';
import assert from 'node:assert/strict';
import type pg from 'pg';
import {
  FIRST_POST_ONBOARDING_SCHEMA_SQL,
  FirstPostOnboardingStore,
} from '../../src/onboarding/first-post-onboarding-store.js';

test('首作状态使用账号级唯一行，并以条件 UPDATE 防止重复 claim/陈旧回写', async () => {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const results = [
    { rows: [], rowCount: 1 },
    { rows: [], rowCount: 0 },
    { rows: [], rowCount: 1 },
    { rows: [], rowCount: 0 },
    { rows: [], rowCount: 1 },
    { rows: [], rowCount: 1 },
  ];
  const pool = {
    query: async (sql: string, params: unknown[] = []) => {
      calls.push({ sql, params });
      return results.shift() ?? { rows: [], rowCount: 0 };
    },
    end: async () => {},
  } as unknown as pg.Pool;
  const store = new FirstPostOnboardingStore({ pool });

  assert.equal(await store.armFirstBind('acc-1'), true);
  assert.equal(await store.armFirstBind('acc-1'), false);
  assert.equal(await store.claim('acc-1', 'note-1'), true);
  assert.equal(await store.claim('acc-1', 'note-2'), false);
  assert.equal(await store.release('acc-1', 'note-1', 'retry'), true);
  assert.equal(await store.complete('acc-1', 'note-1'), true);

  assert.match(calls[0].sql, /ON CONFLICT \(account_id\) DO NOTHING/);
  assert.match(calls[2].sql, /state = 'searching'/);
  assert.match(calls[4].sql, /state = 'generating' AND source_id = \$2/);
  assert.match(calls[5].sql, /state = 'generating' AND source_id = \$2/);
});

test('首作 schema 固定三态并绑定账号生命周期', () => {
  assert.match(FIRST_POST_ONBOARDING_SCHEMA_SQL, /account_id\s+TEXT PRIMARY KEY REFERENCES accounts\(account_id\)/);
  assert.match(FIRST_POST_ONBOARDING_SCHEMA_SQL, /searching.*generating.*generated/s);
});
