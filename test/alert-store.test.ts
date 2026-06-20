import { test } from 'node:test';
import assert from 'node:assert/strict';
import type pg from 'pg';
import { PgAlertStore } from '../src/alerts/index.js';

/** fake pool：捕获 SQL+params，返回预置 result。 */
function fakePool(result: { rows?: unknown[]; rowCount?: number }) {
  const calls: { sql: string; params: unknown[] }[] = [];
  const pool = {
    query: async (sql: string, params: unknown[] = []) => {
      calls.push({ sql, params });
      return { rows: result.rows ?? [], rowCount: result.rowCount ?? 0 };
    },
  } as unknown as pg.Pool;
  return { pool, calls };
}

test('raise 写入并返回 alertId（含 at 时用 to_timestamp）', async () => {
  const { pool, calls } = fakePool({ rows: [{ alert_id: '42' }] });
  const store = new PgAlertStore({ pool });
  const { alertId } = await store.raise(
    { severity: 'P0', type: 'captcha', accountId: 'acc-1', edgeId: 'edge-1', title: '验证码弹出', detail: '页面：x' },
    1234,
  );
  assert.equal(alertId, 42);
  assert.match(calls[0].sql, /INSERT INTO alerts/);
  assert.match(calls[0].sql, /to_timestamp/); // 带 at → to_timestamp
  assert.equal(calls[0].params[0], 'P0');
  assert.equal(calls[0].params[6], 1234);
});

test('raise 不带 at 用 now()，accountId/detail 缺为 null', async () => {
  const { pool, calls } = fakePool({ rows: [{ alert_id: 7 }] });
  const store = new PgAlertStore({ pool });
  await store.raise({ severity: 'P1', type: 'block', title: '阻断' });
  assert.match(calls[0].sql, /now\(\)/);
  assert.equal(calls[0].params[2], null); // accountId
  assert.equal(calls[0].params[5], null); // detail
});

test('resolveByEdge 返回受影响行数', async () => {
  const { pool, calls } = fakePool({ rowCount: 3 });
  const store = new PgAlertStore({ pool });
  const n = await store.resolveByEdge('edge-1', 9999);
  assert.equal(n, 3);
  assert.match(calls[0].sql, /UPDATE alerts SET resolved_at/);
  assert.match(calls[0].sql, /resolved_at IS NULL/); // 只解决未解决的
  assert.equal(calls[0].params[0], 'edge-1');
});

test('list 默认仅未解决；includeResolved 含全部', async () => {
  const { pool, calls } = fakePool({
    rows: [
      { alert_id: '1', severity: 'P0', type: 'captcha', account_id: 'a', edge_id: 'e', title: 't', detail: null, created_at: new Date(100), resolved_at: null },
    ],
  });
  const store = new PgAlertStore({ pool });
  const def = await store.list();
  assert.match(calls[0].sql, /WHERE resolved_at IS NULL/);
  assert.equal(def[0].alertId, 1);
  assert.equal(def[0].createdAt, 100);
  assert.equal(def[0].resolvedAt, null);

  await store.list({ includeResolved: true });
  assert.doesNotMatch(calls[1].sql, /WHERE resolved_at IS NULL/);
});
