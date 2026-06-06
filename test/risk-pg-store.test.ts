import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RISK_SCHEMA_SQL, pgRiskConfigFromEnv } from '../src/risk/index.js';

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