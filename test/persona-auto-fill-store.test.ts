import { test } from 'node:test';
import { ensureCapabilitySchema } from '../src/schema/schema-capability.js';
import assert from 'node:assert/strict';
import type pg from 'pg';
import { PersonaAutoFillStore, PERSONA_AUTO_FILL_SCHEMA_SQL } from '../src/config/persona-auto-fill-store.js';

const SELECTED_SOUL = `identity:\n  name: "模板"\n  role: "分享者"\n  background: "关注生活"\n  tone: "自然"\nwriting_language: "zh-CN"\ninterests:\n  primary:\n    - "生活"\n  secondary: []\n  seed_keywords:\n    - "生活"\n`;
const runRow = {
  run_id: '11111111-1111-4111-8111-111111111111',
  user_id: 'customer-a',
  idempotency_key: 'selected-1',
  platform: 'facebook' as const,
  strategy: 'selected_persona_v1' as const,
  writing_language: 'zh-CN' as const,
  persona_soul_yaml: SELECTED_SOUL,
  state: 'running' as const,
};

test('schema 持久化所选模板、兼容历史策略并保留幂等目标状态', () => {
  assert.match(PERSONA_AUTO_FILL_SCHEMA_SQL, /persona_soul_yaml TEXT/);
  assert.match(PERSONA_AUTO_FILL_SCHEMA_SQL, /selected_persona_v1/);
  assert.match(PERSONA_AUTO_FILL_SCHEMA_SQL, /facebook_auto_v1/);
  assert.match(PERSONA_AUTO_FILL_SCHEMA_SQL, /UNIQUE \(user_id, idempotency_key\)/);
  assert.match(PERSONA_AUTO_FILL_SCHEMA_SQL, /PRIMARY KEY \(run_id, env_key\)/);
  assert.match(PERSONA_AUTO_FILL_SCHEMA_SQL, /waiting_binding/);
  assert.match(PERSONA_AUTO_FILL_SCHEMA_SQL, /skipped_existing/);
});

test('createRun 只以 customer 身份快照 Facebook 环境，并逐字持久化所选模板', async () => {
  const calls: Array<{ sql: string; params?: unknown[] }> = [];
  let insertAttempt = 0;
  const query = async (sql: string, params?: unknown[]) => {
    calls.push({ sql, params });
    if (sql.includes('INSERT INTO persona_auto_fill_runs')) {
      insertAttempt += 1;
      return { rows: insertAttempt === 1 ? [runRow] : [] };
    }
    if (sql.includes('FROM persona_auto_fill_runs WHERE user_id=')) return { rows: [runRow] };
    if (sql.includes('UPDATE persona_auto_fill_runs')) return { rows: [{ state: 'running' }] };
    if (sql.includes('FROM persona_auto_fill_runs WHERE run_id=')) return { rows: [runRow] };
    return { rows: [] };
  };
  const client = { query, release: () => undefined };
  const pool = { connect: async () => client, query } as unknown as pg.Pool;
  const store = new PersonaAutoFillStore({ schemaEnsurer: ensureCapabilitySchema, pool });

  const input = { userId: 'customer-a', idempotencyKey: 'selected-1', writingLanguage: 'zh-CN' as const, soulYaml: SELECTED_SOUL };
  const first = await store.createRun(input);
  const second = await store.createRun(input);
  assert.equal(first.created, true);
  assert.equal(second.created, false);
  assert.equal(first.run.soulYaml, SELECTED_SOUL);

  const runInsert = calls.find((call) => call.sql.includes('INSERT INTO persona_auto_fill_runs'))!;
  assert.match(String(runInsert.params?.[0]), /^[0-9a-f-]{36}$/);
  assert.deepEqual(runInsert.params?.slice(1), ['customer-a', 'selected-1', 'zh-CN', SELECTED_SOUL]);
  assert.match(runInsert.sql, /selected_persona_v1/);
  const snapshot = calls.find((call) => call.sql.includes('INSERT INTO persona_auto_fill_targets'))!;
  assert.deepEqual(snapshot.params, [runRow.run_id, 'customer-a']);
  assert.match(snapshot.sql, /client_env_scope/);
  assert.match(snapshot.sql, /s\.user_id=\$2/);
  assert.match(snapshot.sql, /facebook','fb/);
  assert.doesNotMatch(snapshot.sql, /account_id/);
});
