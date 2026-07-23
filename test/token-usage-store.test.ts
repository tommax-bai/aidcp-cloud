import { test } from 'node:test';
import { ensureCapabilitySchema } from '../src/schema/schema-capability.js';
import assert from 'node:assert/strict';
import pg from 'pg';
import { inferBillingProvider, TokenUsageStore, TOKEN_USAGE_SCHEMA_SQL } from '../src/metrics/token-usage-store.js';

test('schema keeps provider dimension and billing-derived price snapshots', () => {
  assert.match(TOKEN_USAGE_SCHEMA_SQL, /provider\s+TEXT\s+NOT NULL DEFAULT 'unknown'/);
  assert.match(TOKEN_USAGE_SCHEMA_SQL, /PRIMARY KEY \(bucket_start, account_id, role, provider, model\)/);
  assert.match(TOKEN_USAGE_SCHEMA_SQL, /CREATE TABLE IF NOT EXISTS llm_billing_price_snapshot/);
  assert.match(TOKEN_USAGE_SCHEMA_SQL, /idx_llm_token_usage_provider_model_bucket/);
  assert.doesNotMatch(TOKEN_USAGE_SCHEMA_SQL, /qwen-turbo|doubao|public price/i);
});

test('inferBillingProvider maps legacy unknown rows by model name', () => {
  assert.equal(inferBillingProvider('unknown', 'qwen3.7-plus'), 'dashscope');
  assert.equal(inferBillingProvider('unknown', 'deepseek-v4-flash'), 'dashscope');
  assert.equal(inferBillingProvider('unknown', 'doubao-seed-character-260628'), 'volcengine');
  assert.equal(inferBillingProvider('unknown', 'ep-abc'), 'volcengine');
  assert.equal(inferBillingProvider('dashscope', 'doubao-seed'), 'dashscope');
  assert.equal(inferBillingProvider('unknown', 'other-model'), 'unknown');
});

test('default pool uses PG environment config', async () => {
  const original = {
    DATABASE_URL: process.env.DATABASE_URL,
    PGHOST: process.env.PGHOST,
    PGPORT: process.env.PGPORT,
    PGDATABASE: process.env.PGDATABASE,
    PGUSER: process.env.PGUSER,
    PGPASSWORD: process.env.PGPASSWORD,
  };
  let pool: pg.Pool | undefined;
  try {
    delete process.env.DATABASE_URL;
    process.env.PGHOST = '10.9.8.7';
    process.env.PGPORT = '15432';
    process.env.PGDATABASE = 'usage_db';
    process.env.PGUSER = 'usage_user';
    process.env.PGPASSWORD = 'usage_password';

    const store = new TokenUsageStore({ schemaEnsurer: ensureCapabilitySchema });
    pool = (store as unknown as { pool: pg.Pool }).pool;
    const options = pool.options as pg.PoolConfig;
    assert.equal(options.host, '10.9.8.7');
    assert.equal(options.port, 15432);
    assert.equal(options.database, 'usage_db');
    assert.equal(options.user, 'usage_user');
    assert.equal(options.password, 'usage_password');
    assert.equal(options.max, 4);
  } finally {
    await pool?.end();
    for (const [key, value] of Object.entries(original)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('purgeOlderThan deletes old buckets and returns row count', async () => {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const pool = {
    query: async (sql: string, params: unknown[]) => {
      calls.push({ sql, params });
      return { rowCount: 9 };
    },
  } as unknown as pg.Pool;
  const store = new TokenUsageStore({ schemaEnsurer: ensureCapabilitySchema, pool });
  const n = await store.purgeOlderThan(45);
  assert.equal(n, 9);
  assert.match(calls[0].sql, /DELETE FROM llm_token_usage WHERE bucket_start </);
  assert.deepEqual(calls[0].params, [45]);
});

interface RecordedUpsert {
  bucketMs: number;
  accountId: string;
  role: string;
  provider: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  calls: number;
  okCalls: number;
}

function fakePool(opts: { failUpsert?: boolean } = {}) {
  const upserts: RecordedUpsert[] = [];
  const priceUpserts: unknown[][] = [];
  const pool = {
    query: async (sql: string, params?: unknown[]) => {
      if (sql.includes('INSERT INTO llm_token_usage')) {
        if (opts.failUpsert) throw new Error('pg down');
        const p = params as unknown[];
        upserts.push({
          bucketMs: Number(p[0]),
          accountId: String(p[1]),
          role: String(p[2]),
          provider: String(p[3]),
          model: String(p[4]),
          promptTokens: Number(p[5]),
          completionTokens: Number(p[6]),
          totalTokens: Number(p[7]),
          calls: Number(p[8]),
          okCalls: Number(p[9]),
        });
      }
      if (sql.includes('INSERT INTO llm_billing_price_snapshot')) {
        priceUpserts.push(params ?? []);
      }
      return { rows: [], rowCount: 0 };
    },
  } as unknown as pg.Pool;
  return { pool, upserts, priceUpserts };
}

test('same provider/model dimension accumulates into one upsert row', async () => {
  const { pool, upserts } = fakePool();
  const store = new TokenUsageStore({ schemaEnsurer: ensureCapabilitySchema, pool });
  store.add({
    accountId: 'acc-x',
    role: 'browse:content_evaluator',
    provider: 'dashscope',
    model: 'qwen-plus',
    ok: true,
    promptTokens: 10,
    completionTokens: 5,
    totalTokens: 15,
  });
  store.add({
    accountId: 'acc-x',
    role: 'browse:content_evaluator',
    provider: 'dashscope',
    model: 'qwen-plus',
    ok: false,
    promptTokens: 4,
    completionTokens: 0,
    totalTokens: 4,
  });
  await store.flush();
  assert.equal(upserts.length, 1);
  assert.equal(upserts[0].provider, 'dashscope');
  assert.equal(upserts[0].promptTokens, 14);
  assert.equal(upserts[0].completionTokens, 5);
  assert.equal(upserts[0].totalTokens, 19);
  assert.equal(upserts[0].calls, 2);
  assert.equal(upserts[0].okCalls, 1);
  assert.equal(upserts[0].bucketMs % 600_000, 0);
});

test('different providers split rows even when model names match', async () => {
  const { pool, upserts } = fakePool();
  const store = new TokenUsageStore({ schemaEnsurer: ensureCapabilitySchema, pool });
  store.add({ accountId: 'acc-x', role: 'browse:a', provider: 'dashscope', model: 'same-model', ok: true, totalTokens: 1 });
  store.add({ accountId: 'acc-x', role: 'browse:a', provider: 'volcengine', model: 'same-model', ok: true, totalTokens: 2 });
  await store.flush();
  assert.equal(upserts.length, 2);
  assert.deepEqual(
    upserts.map((u) => u.provider).sort(),
    ['dashscope', 'volcengine'],
  );
});

test('missing accountId is dropped; missing role/provider/tokens keep honest labels', async () => {
  const { pool, upserts } = fakePool();
  const store = new TokenUsageStore({ schemaEnsurer: ensureCapabilitySchema, pool });
  store.add({ provider: 'dashscope', model: 'qwen-turbo', ok: true });
  await store.flush();
  assert.equal(upserts.length, 0);

  store.add({ accountId: 'acc-x', model: 'qwen-turbo', ok: true });
  await store.flush();
  assert.equal(upserts.length, 1);
  assert.equal(upserts[0].accountId, 'acc-x');
  assert.equal(upserts[0].role, 'untagged');
  assert.equal(upserts[0].provider, 'unknown');
  assert.equal(upserts[0].totalTokens, 0);
  assert.equal(upserts[0].calls, 1);
});

test('flush failure is isolated and does not retry additive increments', async () => {
  const { pool } = fakePool({ failUpsert: true });
  const store = new TokenUsageStore({ schemaEnsurer: ensureCapabilitySchema, pool });
  store.add({ accountId: 'acc-x', role: 'browse:a', provider: 'dashscope', model: 'm', ok: true, totalTokens: 9 });
  await assert.doesNotReject(() => store.flush());
  await assert.doesNotReject(() => store.flush());
});

test('upsertBillingPrices stores billing-derived snapshots and rejects empty prices', async () => {
  const { pool, priceUpserts } = fakePool();
  const store = new TokenUsageStore({ schemaEnsurer: ensureCapabilitySchema, pool });
  await assert.rejects(
    () =>
      store.upsertBillingPrices([
        { provider: 'dashscope', model: 'qwen-plus', usageDay: '2026-07-05', source: 'billing:aliyun' },
      ]),
    /billing_price_requires_split_or_total_cost/,
  );
  const written = await store.upsertBillingPrices([
    {
      provider: 'dashscope',
      model: 'qwen-plus',
      usageDay: '2026-07-05',
      totalCostPer1k: 0.0012,
      source: 'billing:aliyun:DescribeInstanceBill',
      sourcePeriod: '2026-07',
      sourceSyncedAtMs: 1783200000000,
    },
  ]);
  assert.equal(written, 1);
  assert.equal(priceUpserts.length, 1);
  assert.equal(priceUpserts[0][0], 'dashscope');
  assert.equal(priceUpserts[0][2], '2026-07-05');
  assert.equal(priceUpserts[0][6], 0.0012);
});

test('usage returns billing-backed cost estimate when snapshot joins', async () => {
  const seenSql: string[] = [];
  const pool = {
    query: async (sql: string) => {
      seenSql.push(sql);
      if (sql.includes('WITH usage_rows')) {
        return {
          rows: [
            {
              day: '2026-07-05',
              usage_day: '2026-07-05',
              account_id: 'acc-x',
              role: 'browse:a',
              provider: 'dashscope',
              model: 'qwen-plus',
              prompt_tokens: '1000',
              completion_tokens: '2000',
              total_tokens: '3000',
              calls: '3',
              ok_calls: '3',
              cost_amount: '0.12340000',
              cost_currency: 'CNY',
              cost_source: 'billing:aliyun:DescribeInstanceBill',
              cost_source_date: '2026-07',
              cost_synced_at_ms: '1783200000000',
              pricing_basis: 'input_output_tokens',
            },
          ],
        };
      }
      return {
        rows: [
          { bucket_ms: '1783200000000', prompt_tokens: '1000', completion_tokens: '2000', total_tokens: '3000', calls: '3' },
        ],
      };
    },
  } as unknown as pg.Pool;
  const store = new TokenUsageStore({ schemaEnsurer: ensureCapabilitySchema, pool });
  const payload = await store.usage({ fromMs: 1783200000000, toMs: 1783286400000 });
  assert.match(seenSql[0] + seenSql[1], /LEFT JOIN LATERAL/);
  assert.match(seenSql[0] + seenSql[1], /ORDER BY p\.usage_day DESC/);
  assert.equal(payload.rows[0].provider, 'dashscope');
  assert.deepEqual(payload.rows[0].costEstimate, {
    amount: 0.1234,
    currency: 'CNY',
    source: 'billing:aliyun:DescribeInstanceBill',
    sourceDate: '2026-07',
    syncedAtMs: 1783200000000,
    pricingBasis: 'input_output_tokens',
  });
});

test('billingPriceTargets groups T-1/T-2 usage with inferred provider', async () => {
  const seen: Array<{ sql: string; params: unknown[] | undefined }> = [];
  const pool = {
    query: async (sql: string, params?: unknown[]) => {
      seen.push({ sql, params });
      return {
        rows: [
          {
            usage_day: '2026-07-04',
            provider: 'dashscope',
            model: 'deepseek-v4-flash',
            prompt_tokens: '100',
            completion_tokens: '50',
            total_tokens: '150',
          },
        ],
      };
    },
  } as unknown as pg.Pool;
  const store = new TokenUsageStore({ schemaEnsurer: ensureCapabilitySchema, pool });
  const targets = await store.billingPriceTargets(['2026-07-04', '2026-07-03', '2026-07-04']);
  assert.match(seen[0].sql, /lower\(model\) LIKE 'deepseek%'/);
  assert.match(seen[0].sql, /provider <> 'unknown'/);
  assert.match(seen[0].sql, /HAVING SUM\(total_tokens\) > 0/);
  assert.deepEqual(seen[0].params, [['2026-07-04', '2026-07-03']]);
  assert.deepEqual(targets, [
    {
      usageDay: '2026-07-04',
      provider: 'dashscope',
      model: 'deepseek-v4-flash',
      promptTokens: 100,
      completionTokens: 50,
      totalTokens: 150,
    },
  ]);
});
