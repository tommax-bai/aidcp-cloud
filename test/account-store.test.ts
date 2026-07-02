import { test } from 'node:test';
import assert from 'node:assert/strict';
import type pg from 'pg';
import { ACCOUNTS_SCHEMA_SQL, PgAccountStore } from '../src/account-store.js';

test('ACCOUNTS_SCHEMA_SQL 建 accounts 表（account_id PK + 关键列）', () => {
  assert.match(ACCOUNTS_SCHEMA_SQL, /CREATE TABLE IF NOT EXISTS accounts/);
  assert.match(ACCOUNTS_SCHEMA_SQL, /account_id\s+TEXT PRIMARY KEY/);
  assert.match(ACCOUNTS_SCHEMA_SQL, /persona_ref/);
  assert.match(ACCOUNTS_SCHEMA_SQL, /machine_label/);
  assert.match(ACCOUNTS_SCHEMA_SQL, /group_label/);
});

test('ACCOUNTS_SCHEMA_SQL status/quota_level 有 CHECK 约束（status 非空、无默认 active 歧义）', () => {
  assert.match(ACCOUNTS_SCHEMA_SQL, /status\s+TEXT NOT NULL DEFAULT 'active'/);
  assert.match(ACCOUNTS_SCHEMA_SQL, /CHECK \(status IN \('active','paused'\)\)/);
  assert.match(ACCOUNTS_SCHEMA_SQL, /CHECK \(quota_level IN \('conservative','normal','aggressive'\)\)/);
});

test('ACCOUNTS_SCHEMA_SQL 不再 seed 任何占位账号（retire-default-account：default 已退役，绝不建占位行）', () => {
  // 建表 SQL 不得含任何 INSERT（不 seed 占位行）；账号父行由真实账号握手时 ensureAccount 登记。
  assert.doesNotMatch(ACCOUNTS_SCHEMA_SQL, /INSERT INTO accounts/);
});

// ── change account-real-nickname：nickname 列自愈 DDL + setNickname 单写 ──

test('ACCOUNTS_SCHEMA_SQL 含 nickname 列 + 幂等自愈 ALTER（本仓无迁移执行器，靠 init() DDL 自愈）', () => {
  assert.match(ACCOUNTS_SCHEMA_SQL, /nickname\s+TEXT/);
  assert.match(ACCOUNTS_SCHEMA_SQL, /ALTER TABLE accounts ADD COLUMN IF NOT EXISTS nickname TEXT/);
});

function fakePool(): { calls: { text: string; params: unknown[] }[]; pool: pg.Pool } {
  const calls: { text: string; params: unknown[] }[] = [];
  const pool = {
    query: async (text: string, params: unknown[]) => {
      calls.push({ text, params });
      return { rows: [], rowCount: 0 };
    },
  } as unknown as pg.Pool;
  return { calls, pool };
}

test('setNickname: 非空昵称 trim 后 upsert（按 account_id，ON CONFLICT 自愈）', async () => {
  const { calls, pool } = fakePool();
  const store = new PgAccountStore({ pool });
  await store.setNickname('acc-1', '  工程师大白  ');
  assert.equal(calls.length, 1);
  assert.match(calls[0].text, /INSERT INTO accounts[\s\S]*nickname[\s\S]*ON CONFLICT \(account_id\) DO UPDATE SET nickname/);
  assert.deepEqual(calls[0].params, ['acc-1', '工程师大白']);
});

test('setNickname: 拒空白 → no-op（绝不用空覆盖已有真名）', async () => {
  const { calls, pool } = fakePool();
  const store = new PgAccountStore({ pool });
  await store.setNickname('acc-1', '   ');
  await store.setNickname('acc-1', '');
  assert.equal(calls.length, 0);
});

// ── change editable-account-group-label：setGroupLabel 单写、UPDATE-only、诚实可区分 ──

/** 可配 RETURNING 行的 fake pool（setGroupLabel 靠 RETURNING 回读真态 / 判 not-found）。 */
function fakePoolReturning(rows: unknown[]): { calls: { text: string; params: unknown[] }[]; pool: pg.Pool } {
  const calls: { text: string; params: unknown[] }[] = [];
  const pool = {
    query: async (text: string, params: unknown[]) => {
      calls.push({ text, params });
      return { rows, rowCount: rows.length };
    },
  } as unknown as pg.Pool;
  return { calls, pool };
}

test('setGroupLabel: 非空 trim 后 UPDATE-only + RETURNING，回读真态（不 seed 造行）', async () => {
  const { calls, pool } = fakePoolReturning([{ group_label: '矩阵A' }]);
  const store = new PgAccountStore({ pool });
  const res = await store.setGroupLabel('acc-1', '  矩阵A  ');
  assert.deepEqual(res, { ok: true, groupLabel: '矩阵A' });
  assert.equal(calls.length, 1);
  assert.match(calls[0].text, /UPDATE accounts SET group_label = \$2 WHERE account_id = \$1 RETURNING group_label/);
  assert.doesNotMatch(calls[0].text, /INSERT INTO accounts/); // UPDATE-only：绝不 seed 幽灵行
  assert.deepEqual(calls[0].params, ['acc-1', '矩阵A']);
});

test('setGroupLabel: 空 / 纯空白 / null → 写 NULL（清空分组）', async () => {
  const { calls, pool } = fakePoolReturning([{ group_label: null }]);
  const store = new PgAccountStore({ pool });
  const r1 = await store.setGroupLabel('acc-1', '   ');
  assert.deepEqual(r1, { ok: true, groupLabel: null });
  assert.equal(calls[0].params[1], null);
  await store.setGroupLabel('acc-1', null);
  assert.equal(calls[1].params[1], null);
});

test('setGroupLabel: 无对应行（0 rows）→ account_not_found，可区分、不 seed', async () => {
  const { calls, pool } = fakePoolReturning([]); // UPDATE 影响 0 行
  const store = new PgAccountStore({ pool });
  const res = await store.setGroupLabel('ghost', '矩阵B');
  assert.deepEqual(res, { ok: false, reason: 'account_not_found' });
  assert.match(calls[0].text, /UPDATE accounts/);
  assert.doesNotMatch(calls[0].text, /INSERT/);
});

test('setGroupLabel: 退役保留账号 default 被拒，绝不落库', async () => {
  const { calls, pool } = fakePoolReturning([{ group_label: 'x' }]);
  const store = new PgAccountStore({ pool });
  const res = await store.setGroupLabel('default', '矩阵C');
  assert.deepEqual(res, { ok: false, reason: 'retired_account' });
  assert.equal(calls.length, 0); // 绝不发 SQL
});
