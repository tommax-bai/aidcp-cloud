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

test('ACCOUNTS_SCHEMA_SQL seed 一个 default 行（幂等）', () => {
  assert.match(ACCOUNTS_SCHEMA_SQL, /INSERT INTO accounts.*'default'/s);
  assert.match(ACCOUNTS_SCHEMA_SQL, /ON CONFLICT \(account_id\) DO NOTHING/);
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
