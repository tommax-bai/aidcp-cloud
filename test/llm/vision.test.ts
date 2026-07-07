import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  OpenAiCompatVisionClient,
  ProviderKeyMissingError,
  type OpenAiCompatVisionClientOptions,
  type VisionChatMessage,
} from '../../src/llm/index.js';

type Rec = { calls: number; url?: string; auth?: string; body?: Record<string, unknown> };

/** 假 fetch：记录 URL / Authorization / 完整请求体，返回一条合法 chat 补全。 */
function fakeFetch(rec: Rec, content = '{"form":"text_card","confidence":0.9}'): typeof fetch {
  return (async (url: string, init: { headers: Record<string, string>; body: string }) => {
    rec.calls++;
    rec.url = url;
    rec.auth = init.headers.Authorization;
    rec.body = JSON.parse(init.body) as Record<string, unknown>;
    return {
      ok: true,
      json: async () => ({
        choices: [{ message: { content } }],
        usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
      }),
    } as unknown as Response;
  }) as unknown as typeof fetch;
}

const VISION_RT = { visionprov: { baseUrl: 'https://vision.example/v1', apiKey: 'vk-1' } };

const imageMessages: VisionChatMessage[] = [
  {
    role: 'user',
    content: [
      { type: 'text', text: '判断这张图的形态' },
      { type: 'image_url', image_url: { url: 'https://oss.test/cover.jpg' } },
    ],
  },
];

test('不变量锁死：含 image_url 的消息只发到注入 provider 的 baseUrl + 注入 model，绝无角色解析/文本模型回落', async () => {
  const rec: Rec = { calls: 0 };
  const c = new OpenAiCompatVisionClient({
    getModel: () => 'qwen-vl-test',
    getProvider: () => 'visionprov',
    providerRuntime: VISION_RT,
    fetchImpl: fakeFetch(rec),
  });
  // 即便传了 role，也只作记账归属——model/provider 不因 role 变化（无按角色解析层）。
  const out = await c.chatVision(imageMessages, { role: 'publish:CoverFormSensor' });
  assert.equal(out, '{"form":"text_card","confidence":0.9}');
  assert.equal(rec.calls, 1);
  assert.equal(rec.url, 'https://vision.example/v1/chat/completions');
  assert.equal(rec.auth, 'Bearer vk-1');
  assert.equal(rec.body!.model, 'qwen-vl-test');
  // content 数组（含 image_url part）原样进请求体。
  const sent = rec.body!.messages as VisionChatMessage[];
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].content, imageMessages[0].content);
});

test('构造必须显式注入 getModel/getProvider/providerRuntime（无隐式默认）', () => {
  assert.throws(
    () => new OpenAiCompatVisionClient({} as unknown as OpenAiCompatVisionClientOptions),
    /显式注入 getModel \/ getProvider \/ providerRuntime/,
  );
  assert.throws(
    () =>
      new OpenAiCompatVisionClient({
        getModel: () => 'm',
        getProvider: () => 'p',
      } as unknown as OpenAiCompatVisionClientOptions),
    /显式注入/,
  );
});

test('诚实失败：选中厂商缺密钥 → 发 fetch 前抛 ProviderKeyMissingError，绝不跨厂商兜底', async () => {
  const rec: Rec = { calls: 0 };
  const c = new OpenAiCompatVisionClient({
    getModel: () => 'qwen-vl-test',
    getProvider: () => 'visionprov',
    providerRuntime: { visionprov: { baseUrl: 'https://vision.example/v1', apiKey: '' } },
    fetchImpl: fakeFetch(rec),
  });
  await assert.rejects(
    () => c.chatVision(imageMessages),
    (e) => e instanceof ProviderKeyMissingError && e.provider === 'visionprov',
  );
  assert.equal(rec.calls, 0); // 请求前就抛，零 fetch。
});

test('厂商未注册进 providerRuntime → 同样发请求前诚实抛错', async () => {
  const rec: Rec = { calls: 0 };
  const c = new OpenAiCompatVisionClient({
    getModel: () => 'qwen-vl-test',
    getProvider: () => 'not-registered',
    providerRuntime: VISION_RT,
    fetchImpl: fakeFetch(rec),
  });
  await assert.rejects(() => c.chatVision(imageMessages), ProviderKeyMissingError);
  assert.equal(rec.calls, 0);
});

test('onCall 记账：带 provider/model/ok/账号 + 响应 usage 的 token 计数（与 qwen.ts 同语义）', async () => {
  let info:
    | { role?: string; provider?: string; model: string; ok: boolean; accountId?: string; promptTokens?: number; completionTokens?: number; totalTokens?: number }
    | undefined;
  const c = new OpenAiCompatVisionClient({
    getModel: () => 'qwen-vl-test',
    getProvider: () => 'visionprov',
    providerRuntime: VISION_RT,
    onCall: (i) => {
      info = i;
    },
    fetchImpl: fakeFetch({ calls: 0 }),
  });
  await c.chatVision(imageMessages, { role: 'publish:CoverFormSensor', accountId: 'acc-1' });
  assert.equal(info?.provider, 'visionprov');
  assert.equal(info?.model, 'qwen-vl-test');
  assert.equal(info?.ok, true);
  assert.equal(info?.role, 'publish:CoverFormSensor');
  assert.equal(info?.accountId, 'acc-1');
  assert.equal(info?.promptTokens, 100);
  assert.equal(info?.completionTokens, 20);
  assert.equal(info?.totalTokens, 120);
});

test('HTTP 错误（如模型下架 400）→ 抛统一格式错误且 onCall ok=false（error 归因显式，经 env 换名恢复）', async () => {
  let info: { ok: boolean } | undefined;
  const c = new OpenAiCompatVisionClient({
    getModel: () => 'qwen-vl-gone',
    getProvider: () => 'visionprov',
    providerRuntime: VISION_RT,
    onCall: (i) => {
      info = i;
    },
    fetchImpl: (async () => ({
      ok: false,
      status: 400,
      text: async () => JSON.stringify({ error: { code: 'InvalidModel', message: 'model not exist' } }),
    })) as unknown as typeof fetch,
  });
  await assert.rejects(
    () => c.chatVision(imageMessages),
    (e) => {
      const msg = (e as Error).message;
      assert.match(msg, /^LLM HTTP 400/);
      assert.match(msg, /provider=visionprov/);
      assert.match(msg, /model=qwen-vl-gone/);
      assert.match(msg, /code=InvalidModel/);
      return true;
    },
  );
  assert.equal(info?.ok, false);
});

test('响应缺 content → 形状错误（诚实失败，不默认成功）', async () => {
  const c = new OpenAiCompatVisionClient({
    getModel: () => 'qwen-vl-test',
    getProvider: () => 'visionprov',
    providerRuntime: VISION_RT,
    fetchImpl: (async () => ({
      ok: true,
      json: async () => ({ choices: [] }),
    })) as unknown as typeof fetch,
  });
  await assert.rejects(() => c.chatVision(imageMessages), /missing choices\[0\]\.message\.content/);
});
