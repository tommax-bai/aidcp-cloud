import { test } from 'node:test';
import assert from 'node:assert/strict';
import type pg from 'pg';
import { PersonaAutoFillStore, PERSONA_AUTO_FILL_SCHEMA_SQL } from '../src/config/persona-auto-fill-store.js';

const runRow = {
  run_id: '11111111-1111-4111-8111-111111111111',
  user_id: 'customer-a',
  idempotency_key: 'batch-1',
  platform: 'facebook' as const,
  strategy: 'facebook_auto_v1' as const,
  writing_language: 'zh-CN' as const,
  state: 'running' as const,
};

test('schema 固化 run 幂等键、目标快照与有界状态', () => {
  assert.match(PERSONA_AUTO_FILL_SCHEMA_SQL, /UNIQUE \(user_id, idempotency_key\)/);
  assert.match(PERSONA_AUTO_FILL_SCHEMA_SQL, /PRIMARY KEY \(run_id, env_key\)/);
  assert.match(PERSONA_AUTO_FILL_SCHEMA_SQL, /waiting_binding/);
  assert.match(PERSONA_AUTO_FILL_SCHEMA_SQL, /skipped_existing/);
});

test('createRun 仅以 customer 身份快照 Facebook 环境；同幂等键复用原 run', async () => {
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
  const store = new PersonaAutoFillStore({ pool });

  const first = await store.createRun({ userId: 'customer-a', idempotencyKey: 'batch-1', writingLanguage: 'zh-CN' });
  const second = await store.createRun({ userId: 'customer-a', idempotencyKey: 'batch-1', writingLanguage: 'zh-CN' });
  assert.equal(first.created, true);
  assert.equal(second.created, false);
  assert.equal(first.run.runId, second.run.runId);

  const snapshot = calls.find((call) => call.sql.includes('INSERT INTO persona_auto_fill_targets'))!;
  assert.deepEqual(snapshot.params, [runRow.run_id, 'customer-a']);
  assert.match(snapshot.sql, /client_env_scope/);
  assert.match(snapshot.sql, /s\.user_id=\$2/);
  assert.match(snapshot.sql, /facebook','fb/);
  assert.doesNotMatch(snapshot.sql, /account_id/);
});
