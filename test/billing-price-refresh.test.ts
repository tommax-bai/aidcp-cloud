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
  assert.match(urls[0], /IsHideZeroCharge=false/);
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

test('manual billing refresh derives DashScope split price from Aliyun gross amount when discounted amount is zero', async () => {
  const written: LlmBillingPriceSnapshotInput[][] = [];
  const urls: string[] = [];
  const refresh = createBillingPriceRefresh({
    nowMs: () => Date.parse('2026-07-05T03:30:00.000Z'),
    env: {
      ALIYUN_BILLING_ACCESS_KEY_ID: 'ak',
      ALIYUN_BILLING_ACCESS_KEY_SECRET: 'sk',
    } as NodeJS.ProcessEnv,
    tokenUsage: {
      billingPriceTargets: async () => [
        target({
          provider: 'dashscope',
          model: 'qwen3.7-plus',
          promptTokens: 223_644,
          completionTokens: 25_708,
          totalTokens: 249_352,
        }),
      ],
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
                ProductCode: 'sfm',
                ProductName: '大模型服务平台百炼',
                ProductDetail: '百炼大模型推理',
                InstanceID: '4766633;ws-pzw5gks2odi3rsxq;qwen3.7-plus;context_0-256k_input_token;;0',
                BillingItem: '大模型文本消耗量',
                BillingItemCode: 'token_number',
                Usage: '223.644',
                UsageUnit: '千tokens',
                PretaxAmount: 0,
                PretaxGrossAmount: 0.447288,
                Currency: 'CNY',
              },
              {
                ProductCode: 'sfm',
                ProductName: '大模型服务平台百炼',
                ProductDetail: '百炼大模型推理',
                InstanceID: '4766633;ws-pzw5gks2odi3rsxq;qwen3.7-plus;context_0-256k_output_token;;0',
                BillingItem: '大模型文本消耗量',
                BillingItemCode: 'token_number',
                Usage: '25.708',
                UsageUnit: '千tokens',
                PretaxAmount: 0,
                PretaxGrossAmount: 0.205664,
                Currency: 'CNY',
              },
              {
                ProductCode: 'sfm',
                ProductName: '大模型服务平台百炼',
                ProductDetail: '百炼大模型推理',
                InstanceID: '4766633;ws-pzw5gks2odi3rsxq;qwen3.7-max;input_token;;0',
                BillingItem: '大模型文本消耗量',
                BillingItemCode: 'token_number',
                Usage: '0',
                UsageUnit: '千tokens',
                PretaxAmount: 0,
                PretaxGrossAmount: 0,
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
  assert.equal(result.skipped.length, 0);
  assert.equal(result.prices[0].pricingBasis, 'input_output_tokens');
  assert.match(urls[0], /IsHideZeroCharge=false/);
  const price = written[0][0];
  assert.equal(price.model, 'qwen3.7-plus');
  assert.ok(Math.abs((price.promptCostPer1k ?? 0) - 0.002) < 1e-12);
  assert.ok(Math.abs((price.completionCostPer1k ?? 0) - 0.008) < 1e-12);
});

test('manual billing refresh matches Volcengine billing labels to runtime model ids', async () => {
  const written: LlmBillingPriceSnapshotInput[][] = [];
  const refresh = createBillingPriceRefresh({
    nowMs: () => Date.parse('2026-07-05T03:30:00.000Z'),
    env: {
      VOLCENGINE_BILLING_ACCESS_KEY_ID: 'ak',
      VOLCENGINE_BILLING_ACCESS_KEY_SECRET: 'sk',
    } as NodeJS.ProcessEnv,
    tokenUsage: {
      billingPriceTargets: async () => [
        target({
          provider: 'volcengine',
          model: 'doubao-seed-2-0-pro-260215',
          promptTokens: 2000,
          completionTokens: 3000,
          totalTokens: 5000,
        }),
        target({
          provider: 'volcengine',
          model: 'doubao-seed-character-260628',
          promptTokens: 500,
          completionTokens: 500,
          totalTokens: 1000,
        }),
      ],
      upsertBillingPrices: async (prices) => {
        written.push(prices);
        return prices.length;
      },
    },
    fetch: async () =>
      new Response(
        JSON.stringify({
          Result: {
            List: [
              {
                Product: 'ark_bd',
                ProductZh: '字节跳动大模型服务（豆包大模型）',
                ConfigName: 'Doubao-Seed-2.0-pro',
                ChargeItemCode: 'Doubao_Seed_2.0_pro_32k_infer_input_cn-beijing_realtime',
                Unit: '千tokens',
                Usage: '2',
                PretaxAmount: '0.4',
                Currency: 'CNY',
              },
              {
                Product: 'ark_bd',
                ProductZh: '字节跳动大模型服务（豆包大模型）',
                ConfigName: 'Doubao-Seed-2.0-pro',
                ChargeItemCode: 'Doubao_Seed_2.0_pro_32k_infer_output_cn-beijing_realtime',
                Unit: '千tokens',
                Usage: '3',
                PretaxAmount: '0.9',
                Currency: 'CNY',
              },
              {
                Product: 'ark_bd',
                ProductZh: '字节跳动大模型服务（豆包大模型）',
                ConfigName: 'Doubao-Seed-Character',
                ChargeItemCode: 'Doubao-Seed-Character_32k_infer_cn-beijing_realtime',
                Unit: '千tokens',
                Usage: '1',
                PretaxAmount: '0.5',
                Currency: 'CNY',
              },
            ],
          },
        }),
        { status: 200 },
      ),
  });

  const result = await refresh.refresh();
  assert.equal(result.written, 2);
  assert.equal(result.skipped.length, 0);
  assert.equal(result.prices.find((p) => p.model === 'doubao-seed-2-0-pro-260215')?.pricingBasis, 'input_output_tokens');
  assert.equal(result.prices.find((p) => p.model === 'doubao-seed-character-260628')?.pricingBasis, 'total_tokens');
  const pro = written[0].find((p) => p.model === 'doubao-seed-2-0-pro-260215');
  const character = written[0].find((p) => p.model === 'doubao-seed-character-260628');
  assert.equal(pro?.promptCostPer1k, 0.2);
  assert.ok(Math.abs((pro?.completionCostPer1k ?? 0) - 0.3) < 1e-9);
  assert.equal(character?.totalCostPer1k, 0.5);
});

test('manual billing refresh derives Volcengine token price from rounded bill amount and unit price', async () => {
  const written: LlmBillingPriceSnapshotInput[][] = [];
  const refresh = createBillingPriceRefresh({
    nowMs: () => Date.parse('2026-07-05T03:30:00.000Z'),
    env: {
      VOLCENGINE_BILLING_ACCESS_KEY_ID: 'ak',
      VOLCENGINE_BILLING_ACCESS_KEY_SECRET: 'sk',
    } as NodeJS.ProcessEnv,
    tokenUsage: {
      billingPriceTargets: async () => [
        target({
          provider: 'volcengine',
          model: 'doubao-seed-character-260628',
          promptTokens: 860,
          completionTokens: 120,
          totalTokens: 980,
        }),
      ],
      upsertBillingPrices: async (prices) => {
        written.push(prices);
        return prices.length;
      },
    },
    fetch: async () =>
      new Response(
        JSON.stringify({
          Result: {
            List: [
              {
                Product: 'ark_bd',
                ProductZh: '字节跳动大模型服务（豆包大模型）',
                ConfigName: 'Doubao-Seed-Character',
                Element: 'Doubao-Seed-Character-32k以内推理（输入）',
                ExpandField: 'doubao-seed-character',
                Price: '0.000800',
                PriceUnit: '千tokens',
                Count: '0.86',
                Unit: '千tokens',
                PretaxAmount: '0.00',
                Currency: 'CNY',
                ChargeItemCode: 'Doubao-Seed-Character_32k_infer_input_cn-beijing_realtime',
              },
              {
                Product: 'ark_bd',
                ProductZh: '字节跳动大模型服务（豆包大模型）',
                ConfigName: 'Doubao-Seed-Character',
                Element: 'Doubao-Seed-Character-32k以内推理（输出）',
                ExpandField: 'doubao-seed-character',
                Price: '0.002000',
                PriceUnit: '千tokens',
                Count: '0.12',
                Unit: '千tokens',
                PretaxAmount: '0.00',
                Currency: 'CNY',
                ChargeItemCode: 'Doubao-Seed-Character_32k_infer_output_cn-beijing_realtime',
              },
              {
                Product: 'Doubao-Seedream',
                ProductZh: '豆包图像创作模型',
                ConfigName: 'Doubao-Seedream-5.0-Lite',
                Price: '0.02',
                PriceUnit: '张',
                Count: '1',
                Unit: '张',
                PretaxAmount: '0.02',
                Currency: 'CNY',
                ChargeItemCode: 'Doubao_Seedream_5.0_t2i_cn-beijing_realtime',
              },
            ],
          },
        }),
        { status: 200 },
      ),
  });

  const result = await refresh.refresh();
  assert.equal(result.written, 1);
  assert.equal(result.skipped.length, 0);
  assert.equal(result.prices[0].pricingBasis, 'input_output_tokens');
  const price = written[0][0];
  assert.equal(price.model, 'doubao-seed-character-260628');
  assert.ok(Math.abs((price.promptCostPer1k ?? 0) - 0.0008) < 1e-12);
  assert.ok(Math.abs((price.completionCostPer1k ?? 0) - 0.002) < 1e-12);
});

test('manual billing refresh keeps DashScope target skipped when Aliyun bill has no model sample', async () => {
  const refresh = createBillingPriceRefresh({
    nowMs: () => Date.parse('2026-07-05T03:30:00.000Z'),
    env: {
      ALIYUN_BILLING_ACCESS_KEY_ID: 'ak',
      ALIYUN_BILLING_ACCESS_KEY_SECRET: 'sk',
    } as NodeJS.ProcessEnv,
    tokenUsage: {
      billingPriceTargets: async () => [target()],
      upsertBillingPrices: async () => {
        throw new Error('must_not_write');
      },
    },
    fetch: async () =>
      new Response(
        JSON.stringify({
          Data: {
            Items: [
              {
                ProductName: '对象存储',
                ProductDetail: '对象存储OSS标准存储包-套餐内',
                BillingItem: '标准存储包定价',
                Usage: '20',
                UsageUnit: 'GB',
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
  assert.equal(result.written, 0);
  assert.deepEqual(result.missingCredentials, []);
  assert.equal(result.skipped.length, 1);
  assert.equal(result.skipped[0].provider, 'dashscope');
  assert.equal(result.skipped[0].reason, 'no_billing_sample');
});

test('manual billing refresh keeps DashScope target skipped when Aliyun token rows have no positive billing-derived amount', async () => {
  const refresh = createBillingPriceRefresh({
    nowMs: () => Date.parse('2026-07-05T03:30:00.000Z'),
    env: {
      ALIYUN_BILLING_ACCESS_KEY_ID: 'ak',
      ALIYUN_BILLING_ACCESS_KEY_SECRET: 'sk',
    } as NodeJS.ProcessEnv,
    tokenUsage: {
      billingPriceTargets: async () => [target({ model: 'qwen3.7-max' })],
      upsertBillingPrices: async () => {
        throw new Error('must_not_write');
      },
    },
    fetch: async () =>
      new Response(
        JSON.stringify({
          Data: {
            Items: [
              {
                ProductCode: 'sfm',
                ProductName: '大模型服务平台百炼',
                ProductDetail: '百炼大模型推理',
                InstanceID: '4766633;ws-pzw5gks2odi3rsxq;qwen3.7-max;input_token;;0',
                BillingItem: '大模型文本消耗量',
                BillingItemCode: 'token_number',
                Usage: '1',
                UsageUnit: '千tokens',
                PretaxAmount: 0,
                PretaxGrossAmount: 0,
                Currency: 'CNY',
              },
            ],
          },
        }),
        { status: 200 },
      ),
  });

  const result = await refresh.refresh();
  assert.equal(result.written, 0);
  assert.equal(result.skipped.length, 1);
  assert.equal(result.skipped[0].reason, 'no_billing_sample');
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
