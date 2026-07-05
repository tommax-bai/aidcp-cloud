import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBillingPriceRefresh } from '../src/metrics/billing-price-refresh.js';
import type { LlmBillingPriceSnapshotInput, LlmBillingPriceTarget } from '../src/metrics/token-usage-store.js';

function target(overrides: Partial<LlmBillingPriceTarget> = {}): LlmBillingPriceTarget {
  return {
    usageDay: '2026-07-04',
    provider: 'dashscope',
    model: 'deepseek-v4-flash',
    promptTokens: 1000,
    completionTokens: 1000,
    totalTokens: 2000,
    ...overrides,
  };
}

test('manual billing refresh derives total-token price from Aliyun bill detail', async () => {
  const written: LlmBillingPriceSnapshotInput[][] = [];
  const urls: string[] = [];
  const refresh = createBillingPriceRefresh({
    nowMs: () => Date.parse('2026-07-05T03:30:00.000Z'),
    env: {
      ALIYUN_BILLING_ACCESS_KEY_ID: 'ak',
      ALIYUN_BILLING_ACCESS_KEY_SECRET: 'sk',
    } as NodeJS.ProcessEnv,
    tokenUsage: {
      billingPriceTargets: async (days) => {
        assert.deepEqual(days, ['2026-07-04', '2026-07-03']);
        return [target()];
      },
      upsertBillingPrices: async (prices) => {
        written.push(prices);
        return prices.length;
      },
    },
    fetch: async (url) => {
      urls.push(String(url));
      return new Response(
        JSON.stringify({
          Data: {
            Items: [
              {
                ProductDetail: 'DashScope deepseek-v4-flash',
                BillingItem: 'token',
                Usage: '2000',
                UsageUnit: 'Tokens',
                PretaxAmount: 1.2,
                Currency: 'CNY',
              },
            ],
          },
        }),
        { status: 200 },
      );
    },
  });

  const result = await refresh.refresh();
  assert.equal(result.written, 1);
  assert.equal(result.prices[0].pricingBasis, 'total_tokens');
  assert.equal(written[0][0].provider, 'dashscope');
  assert.equal(written[0][0].model, 'deepseek-v4-flash');
  assert.equal(written[0][0].totalCostPer1k, 0.6);
  assert.equal(written[0][0].source, 'billing:aliyun:DescribeInstanceBill');
  assert.match(urls[0], /MaxResults=300/);
  assert.doesNotMatch(urls[0], /PageNum|PageSize/);
});

test('manual billing refresh reads generic platform AccessKey credentials from store', async () => {
  const written: LlmBillingPriceSnapshotInput[][] = [];
  const requestedSecrets: string[] = [];
  const refresh = createBillingPriceRefresh({
    nowMs: () => Date.parse('2026-07-05T03:30:00.000Z'),
    env: {} as NodeJS.ProcessEnv,
    credentials: {
      getSecretForRuntime: async (provider, field) => {
        requestedSecrets.push(`${provider}/${field}`);
        if (provider === 'aliyun' && field === 'access_key_id') return 'ak';
        if (provider === 'aliyun' && field === 'access_key_secret') return 'sk';
        return null;
      },
    },
    tokenUsage: {
      billingPriceTargets: async () => [target()],
      upsertBillingPrices: async (prices) => {
        written.push(prices);
        return prices.length;
      },
    },
    fetch: async () =>
      new Response(
        JSON.stringify({
          Data: {
            Items: [
              {
                ProductDetail: 'DashScope deepseek-v4-flash',
                BillingItem: 'token',
                Usage: '2000',
                UsageUnit: 'Tokens',
                PretaxAmount: 1.2,
                Currency: 'CNY',
              },
            ],
          },
        }),
        { status: 200 },
      ),
  });

  const result = await refresh.refresh();
  assert.equal(result.written, 1);
  assert.deepEqual(result.missingCredentials, []);
  assert.equal(written[0][0].totalCostPer1k, 0.6);
  assert.ok(requestedSecrets.includes('aliyun/billing_access_key_id'));
  assert.ok(requestedSecrets.includes('aliyun/access_key_id'));
  assert.ok(requestedSecrets.includes('aliyun/billing_access_key_secret'));
  assert.ok(requestedSecrets.includes('aliyun/access_key_secret'));
});

test('manual billing refresh reports missing credentials without writing fallback prices', async () => {
  const refresh = createBillingPriceRefresh({
    nowMs: () => Date.parse('2026-07-05T03:30:00.000Z'),
    env: {} as NodeJS.ProcessEnv,
    tokenUsage: {
      billingPriceTargets: async () => [target({ provider: 'volcengine', model: 'doubao-seed-character-260628' })],
      upsertBillingPrices: async () => {
        throw new Error('must_not_write');
      },
    },
  });

  const result = await refresh.refresh();
  assert.equal(result.written, 0);
  assert.deepEqual(result.missingCredentials, ['volcengine']);
  assert.equal(result.skipped[0].reason, 'missing_credentials');
});

test('manual billing refresh reports missing Aliyun billing credentials as aliyun', async () => {
  const refresh = createBillingPriceRefresh({
    nowMs: () => Date.parse('2026-07-05T03:30:00.000Z'),
    env: {} as NodeJS.ProcessEnv,
    tokenUsage: {
      billingPriceTargets: async () => [target()],
      upsertBillingPrices: async () => {
        throw new Error('must_not_write');
      },
    },
  });

  const result = await refresh.refresh();
  assert.equal(result.written, 0);
  assert.deepEqual(result.missingCredentials, ['aliyun']);
  assert.equal(result.skipped[0].provider, 'dashscope');
  assert.equal(result.skipped[0].reason, 'missing_credentials');
});
