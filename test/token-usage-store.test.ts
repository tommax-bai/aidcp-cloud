import { test } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { TokenUsageStore } from '../src/metrics/token-usage-store.js';

/**
 * change llm-token-usage-stats：内存累加 + flush upsert 的记账逻辑（无需真实 PG，注入桩池）。
 */

interface RecordedUpsert {
  bucketMs: number;
  accountId: string;
  role: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  calls: number;
  okCalls: number;
}

/** 桩 pg.Pool：SCHEMA/查询忽略，记录 upsert 参数。可选让 upsert 抛错以测失败隔离。 */
function fakePool(opts: { failUpsert?: boolean } = {}) {
  const upserts: RecordedUpsert[] = [];
  const pool = {
    query: async (sql: string, params?: unknown[]) => {
      if (sql.includes('INSERT INTO llm_token_usage')) {
        if (opts.failUpsert) throw new Error('pg down');
        const p = params as unknown[];
        upserts.push({
          bucketMs: Number(p[0]),
          accountId: String(p[1]),
          role: String(p[2]),
          model: String(p[3]),
          promptTokens: Number(p[4]),
          completionTokens: Number(p[5]),
          totalTokens: Number(p[6]),
          calls: Number(p[7]),
          okCalls: Number(p[8]),
        });
      }
      return { rows: [], rowCount: 0 };
    },
  } as unknown as pg.Pool;
  return { pool, upserts };
}

test('同维度多次 add → flush 累加为一行（calls/okCalls/tokens 相加）', async () => {
  const { pool, upserts } = fakePool();
  const store = new TokenUsageStore({ pool });
  store.add({ accountId: 'acc-x', role: 'browse:content_evaluator', model: 'qwen-plus', ok: true, promptTokens: 10, completionTokens: 5, totalTokens: 15 });
  store.add({ accountId: 'acc-x', role: 'browse:content_evaluator', model: 'qwen-plus', ok: false, promptTokens: 4, completionTokens: 0, totalTokens: 4 });
  await store.flush();
  assert.equal(upserts.length, 1);
  const u = upserts[0];
  assert.equal(u.promptTokens, 14);
  assert.equal(u.completionTokens, 5);
  assert.equal(u.totalTokens, 19);
  assert.equal(u.calls, 2);
  assert.equal(u.okCalls, 1, '失败那次不计入 okCalls');
  assert.equal(u.bucketMs % 600_000, 0, 'bucketMs 对齐 10 分钟');
});

test('honest-fail：无 accountId → 丢弃不记（retire-default-account：绝不回落 default）；有账号无 role → untagged，token 缺失 → 0', async () => {
  const { pool, upserts } = fakePool();
  const store = new TokenUsageStore({ pool });
  // 无 accountId：honest-fail 丢弃，绝不回落 default。
  store.add({ model: 'qwen-turbo', ok: true });
  await store.flush();
  assert.equal(upserts.length, 0, '缺 accountId 的用量被丢弃，不记到 default');
  // 有账号、无 role / 无 token：role 回落 untagged、token 缺失计 0（这些诚实标签保留）。
  store.add({ accountId: 'acc-x', model: 'qwen-turbo', ok: true });
  await store.flush();
  assert.equal(upserts.length, 1);
  assert.equal(upserts[0].accountId, 'acc-x');
  assert.equal(upserts[0].role, 'untagged');
  assert.equal(upserts[0].totalTokens, 0);
  assert.equal(upserts[0].calls, 1);
});

test('不同维度 → 分行', async () => {
  const { pool, upserts } = fakePool();
  const store = new TokenUsageStore({ pool });
  store.add({ accountId: 'acc-x', role: 'browse:a', model: 'm1', ok: true, totalTokens: 1 });
  store.add({ accountId: 'acc-x', role: 'browse:b', model: 'm1', ok: true, totalTokens: 2 });
  store.add({ accountId: 'acc-x', role: 'browse:a', model: 'm2', ok: true, totalTokens: 3 });
  await store.flush();
  assert.equal(upserts.length, 3);
});

test('flush 失败被隔离：不抛出、buffer 已清不重试累加', async () => {
  const { pool } = fakePool({ failUpsert: true });
  const store = new TokenUsageStore({ pool });
  store.add({ accountId: 'acc-x', role: 'browse:a', model: 'm', ok: true, totalTokens: 9 });
  await assert.doesNotReject(() => store.flush(), 'flush 失败绝不抛出');
  // 失败的增量被丢弃（不重试累加）：再 flush 一次无任何新 upsert 尝试也不抛。
  await assert.doesNotReject(() => store.flush());
});

test('flush 后再 add 同桶 → 第二次 flush 只带增量（加法 upsert，由 PG 累加）', async () => {
  const { pool, upserts } = fakePool();
  const store = new TokenUsageStore({ pool });
  store.add({ accountId: 'acc-x', role: 'browse:a', model: 'm', ok: true, totalTokens: 5 });
  await store.flush();
  store.add({ accountId: 'acc-x', role: 'browse:a', model: 'm', ok: true, totalTokens: 7 });
  await store.flush();
  assert.equal(upserts.length, 2);
  assert.equal(upserts[0].totalTokens, 5);
  assert.equal(upserts[1].totalTokens, 7, '第二次只带新增量，不重复已 flush 的 5');
});
