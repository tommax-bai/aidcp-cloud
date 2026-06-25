import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  QwenClient,
  DEFAULT_BASE_URL,
  ProviderKeyMissingError,
  normProvider,
  isAllowedCredential,
  resolveProviderBaseUrl,
  resolveProviderEnvKey,
  TEXT_PROVIDERS,
} from '../src/llm/index.js';

type Rec = { calls: number; url?: string; auth?: string; model?: string };

/** 假 fetch：记录 URL / Authorization / model，返回一条合法 chat 补全。 */
function fakeFetch(rec: Rec): typeof fetch {
  return (async (url: string, init: { headers: Record<string, string>; body: string }) => {
    rec.calls++;
    rec.url = url;
    rec.auth = init.headers.Authorization;
    rec.model = JSON.parse(init.body).model;
    return {
      ok: true,
      json: async () => ({
        choices: [{ message: { content: 'pong' } }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }),
    } as unknown as Response;
  }) as unknown as typeof fetch;
}

const DS = { baseUrl: DEFAULT_BASE_URL, apiKey: 'sk-ds' };
const ARK = { baseUrl: 'https://ark.cn-beijing.volces.com/api/v3', apiKey: 'ark-key' };

test('零回归：未注入 providerRuntime → 用构造 baseUrl+key，请求与改造前逐字一致', async () => {
  const rec: Rec = { calls: 0 };
  const c = new QwenClient({ apiKey: 'sk-ds', model: 'qwen-turbo', fetchImpl: fakeFetch(rec) });
  const out = await c.complete('hi');
  assert.equal(out, 'pong');
  assert.equal(rec.url, 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions');
  assert.equal(rec.auth, 'Bearer sk-ds');
  assert.equal(rec.model, 'qwen-turbo');
});

test('多厂商路由：dashscope 角色走百炼、volcengine 角色走方舟（各自 baseUrl+key）', async () => {
  const rec: Rec = { calls: 0 };
  const c = new QwenClient({
    apiKey: 'sk-ds',
    providerRuntime: { dashscope: DS, volcengine: ARK },
    getModel: (role) => (role === 'v' ? 'doubao-seed-1-6' : 'qwen-turbo'),
    getProvider: (role) => (role === 'v' ? 'volcengine' : 'dashscope'),
    fetchImpl: fakeFetch(rec),
  });
  await c.complete('hi', { role: 'd' });
  assert.ok(rec.url!.startsWith('https://dashscope.aliyuncs.com/compatible-mode/v1'));
  assert.equal(rec.auth, 'Bearer sk-ds');
  assert.equal(rec.model, 'qwen-turbo');

  await c.complete('hi', { role: 'v' });
  assert.equal(rec.url, 'https://ark.cn-beijing.volces.com/api/v3/chat/completions');
  assert.equal(rec.auth, 'Bearer ark-key');
  assert.equal(rec.model, 'doubao-seed-1-6');
});

test('诚实失败：选中厂商缺密钥 → 发请求前抛 ProviderKeyMissingError，绝不用别厂商 key/baseUrl', async () => {
  const rec: Rec = { calls: 0 };
  const c = new QwenClient({
    apiKey: 'sk-ds',
    providerRuntime: { dashscope: DS, volcengine: { baseUrl: ARK.baseUrl, apiKey: '' } },
    fetchImpl: fakeFetch(rec),
  });
  await assert.rejects(
    () => c.complete('hi', { provider: 'volcengine', model: 'doubao-seed-1-6' }),
    (e) => e instanceof ProviderKeyMissingError && (e as ProviderKeyMissingError).provider === 'volcengine',
  );
  assert.equal(rec.calls, 0); // 发 fetch 前就抛，绝不退回 dashscope key/baseUrl
});

test('onCall 带 provider（日志/记账可区分同名模型来自哪个厂商）', async () => {
  let info: { provider?: string; model: string; ok: boolean } | undefined;
  const c = new QwenClient({
    apiKey: 'sk-ds',
    providerRuntime: { dashscope: DS, volcengine: ARK },
    getProvider: () => 'volcengine',
    getModel: () => 'doubao-seed-1-6',
    onCall: (i) => {
      info = i;
    },
    fetchImpl: fakeFetch({ calls: 0 }),
  });
  await c.complete('hi', { role: 'x' });
  assert.equal(info?.provider, 'volcengine');
  assert.equal(info?.model, 'doubao-seed-1-6');
  assert.equal(info?.ok, true);
});

test('注册表/归一/白名单/baseUrl 覆盖', () => {
  // normProvider
  assert.equal(normProvider('volcengine'), 'volcengine');
  assert.equal(normProvider('dashscope'), 'dashscope');
  assert.equal(normProvider('bogus'), 'dashscope');
  assert.equal(normProvider(''), 'dashscope');
  assert.equal(normProvider(null), 'dashscope');
  assert.equal(normProvider(undefined), 'dashscope');
  // 凭据白名单（注册表派生）
  assert.equal(isAllowedCredential('volcengine', 'volcengine_api_key'), true);
  assert.equal(isAllowedCredential('dashscope', 'dashscope_api_key'), true);
  assert.equal(isAllowedCredential('volcengine', 'dashscope_api_key'), false); // 厂商/字段错配
  assert.equal(isAllowedCredential('bogus', 'x'), false);
  // baseUrl env 覆盖（区域/自定义端点）
  assert.equal(resolveProviderBaseUrl('volcengine', {}), 'https://ark.cn-beijing.volces.com/api/v3');
  assert.equal(resolveProviderBaseUrl('volcengine', { ARK_BASE_URL: 'https://ark.ap-southeast.volces.com/api/v3' }), 'https://ark.ap-southeast.volces.com/api/v3');
  assert.equal(resolveProviderBaseUrl('dashscope', {}), DEFAULT_BASE_URL);
  // key env 回退（按 envKeys 顺序）
  assert.equal(resolveProviderEnvKey('volcengine', { ARK_API_KEY: 'k1' }), 'k1');
  assert.equal(resolveProviderEnvKey('volcengine', { VOLCENGINE_API_KEY: 'k2' }), 'k2');
  assert.equal(resolveProviderEnvKey('volcengine', {}), undefined);
  // 火山方舟注册项坐实
  assert.equal(TEXT_PROVIDERS.volcengine.baseUrlDefault, 'https://ark.cn-beijing.volces.com/api/v3');
  assert.equal(TEXT_PROVIDERS.volcengine.credentialField, 'volcengine_api_key');
});
