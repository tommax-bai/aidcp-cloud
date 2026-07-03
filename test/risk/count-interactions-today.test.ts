import { test } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { PgRiskStore } from '../../src/risk/pg-risk-store.js';

/**
 * countInteractionsTodayForAccount（change content-schedule-comments）：
 * 供排期评论日上限判定的持久计数——按账号 + action + 服务器本地当日（date_trunc('day', now())）过滤。
 * pool 桩验证参数传递（账号 / action 落到 $1/$2）、SQL 含当日过滤、返回数值解析（text count → number）。
 */
function makeStore(n: string) {
  const seen: Array<{ sql: string; params: unknown[] }> = [];
  const pool = {
    query: async (sql: string, params: unknown[] = []) => {
      seen.push({ sql, params });
      return { rows: [{ n }] };
    },
    end: async () => {},
  } as unknown as pg.Pool;
  return { store: new PgRiskStore({ pool }), seen };
}

test('countInteractionsTodayForAccount: 按账号+action 过滤、含当日下界、count 文本解析为数字', async () => {
  const { store, seen } = makeStore('3');
  const n = await store.countInteractionsTodayForAccount('acc-1', 'comment');
  assert.equal(n, 3);
  assert.equal(seen.length, 1);
  const { sql, params } = seen[0];
  assert.deepEqual(params, ['acc-1', 'comment'], '账号与 action 走参数化，不拼串');
  assert.match(sql, /FROM risk_interactions/);
  assert.match(sql, /account_id = \$1/);
  assert.match(sql, /action = \$2/);
  assert.match(sql, /interacted_at >= date_trunc\('day', now\(\)\)/, '服务器本地当日下界（对齐 publish 侧口径）');
});

test('countInteractionsTodayForAccount: 空结果回 0（不为 NaN）', async () => {
  const seen: Array<unknown> = [];
  const pool = {
    query: async () => {
      seen.push(1);
      return { rows: [] };
    },
    end: async () => {},
  } as unknown as pg.Pool;
  const store = new PgRiskStore({ pool });
  assert.equal(await store.countInteractionsTodayForAccount('acc-x', 'comment'), 0);
});
