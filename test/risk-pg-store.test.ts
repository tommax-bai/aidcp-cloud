import { test } from 'node:test';
import assert from 'node:assert/strict';
import type pg from 'pg';
import { RISK_SCHEMA_SQL, PgRiskStore, pgRiskConfigFromEnv } from '../src/risk/index.js';

test('RISK_SCHEMA_SQL 含 risk_counters / risk_state 表', () => {
  assert.match(RISK_SCHEMA_SQL, /CREATE TABLE IF NOT EXISTS risk_counters/);
  assert.match(RISK_SCHEMA_SQL, /CREATE TABLE IF NOT EXISTS risk_state/);
  assert.match(RISK_SCHEMA_SQL, /idx_risk_counters_account_action_time/);
});

test('pgRiskConfigFromEnv 读取 AIDCP_PG_* 并兼容 AIDCP_PG_DB', () => {
  const config = pgRiskConfigFromEnv({
    AIDCP_PG_HOST: 'pg.local',
    AIDCP_PG_PORT: '15432',
    AIDCP_PG_DB: 'aidcp_test',
    AIDCP_PG_USER: 'bot',
    AIDCP_PG_PASSWORD: 'secret',
  });
  assert.deepEqual(config, {
    host: 'pg.local',
    port: 15432,
    database: 'aidcp_test',
    user: 'bot',
    password: 'secret',
  });
});

test('RISK_SCHEMA_SQL 补 occurred_at 打头索引服务面板全局时间窗查询（#21）', () => {
  assert.match(RISK_SCHEMA_SQL, /idx_risk_counters_time ON risk_counters \(occurred_at DESC\)/);
});

test('purgeCountersOlderThan 按 occurred_at 删过期计数、回传删除行数（走索引不全表扫描）', async () => {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const pool = {
    query: async (sql: string, params: unknown[]) => {
      calls.push({ sql, params });
      return { rowCount: 4 };
    },
  } as unknown as pg.Pool;
  const store = new PgRiskStore({ pool });
  const n = await store.purgeCountersOlderThan(7);
  assert.equal(n, 4);
  assert.match(calls[0].sql, /DELETE FROM risk_counters WHERE occurred_at </);
  assert.deepEqual(calls[0].params, [7]);
});