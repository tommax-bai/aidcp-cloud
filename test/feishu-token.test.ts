import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FeishuTokenManager } from '../src/feishu/token.js';

/** 构造一个可控的 fake fetch，记录调用次数并返回指定 token */
function fakeFetch(token: string, expire = 7200) {
  let calls = 0;
  const impl = (async () => {
    calls++;
    return {
      ok: true,
      status: 200,
      json: async () => ({ code: 0, msg: 'ok', tenant_access_token: token, expire }),
    } as Response;
  }) as unknown as typeof fetch;
  return { impl, getCalls: () => calls };
}

test('FeishuTokenManager: 首次获取 token 调用一次飞书 API', async () => {
  const { impl, getCalls } = fakeFetch('t-abc');
  const mgr = new FeishuTokenManager({
    appId: 'app',
    appSecret: 'secret',
    fetchImpl: impl,
    clock: () => 0,
  });
  const token = await mgr.getToken();
  assert.equal(token, 't-abc');
  assert.equal(getCalls(), 1);
});

test('FeishuTokenManager: 有效期内复用缓存，不重复请求', async () => {
  const { impl, getCalls } = fakeFetch('t-cached');
  let now = 0;
  const mgr = new FeishuTokenManager({
    appId: 'app',
    appSecret: 'secret',
    fetchImpl: impl,
    clock: () => now,
  });
  await mgr.getToken();
  now = 60 * 60 * 1000; // 1 小时后，仍在有效期（2h - 5min）内
  await mgr.getToken();
  assert.equal(getCalls(), 1);
});

test('FeishuTokenManager: 临近过期（提前 5 分钟）自动续期', async () => {
  const { impl, getCalls } = fakeFetch('t-refresh');
  let now = 0;
  const mgr = new FeishuTokenManager({
    appId: 'app',
    appSecret: 'secret',
    fetchImpl: impl,
    clock: () => now,
  });
  await mgr.getToken();
  // 7200s 有效期，提前 5min 刷新 → 在 7200-300 = 6900s 后应重新拉取
  now = 6901 * 1000;
  await mgr.getToken();
  assert.equal(getCalls(), 2);
});

test('FeishuTokenManager: 缺少凭证时抛错', async () => {
  const mgr = new FeishuTokenManager({ appId: '', appSecret: '' });
  await assert.rejects(() => mgr.getToken(), /凭证缺失/);
});

test('FeishuTokenManager: 飞书返回非 0 code 抛错', async () => {
  const impl = (async () => ({
    ok: true,
    status: 200,
    json: async () => ({ code: 99991663, msg: 'app ticket invalid' }),
  })) as unknown as typeof fetch;
  const mgr = new FeishuTokenManager({ appId: 'a', appSecret: 's', fetchImpl: impl });
  await assert.rejects(() => mgr.getToken(), /获取失败/);
});

test('FeishuTokenManager: 并发 getToken 只发一次请求', async () => {
  const { impl, getCalls } = fakeFetch('t-concurrent');
  const mgr = new FeishuTokenManager({
    appId: 'app',
    appSecret: 'secret',
    fetchImpl: impl,
    clock: () => 0,
  });
  const [a, b] = await Promise.all([mgr.getToken(), mgr.getToken()]);
  assert.equal(a, 't-concurrent');
  assert.equal(b, 't-concurrent');
  assert.equal(getCalls(), 1);
});
