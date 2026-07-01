import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { SeedreamClient } from '../../src/publish-agent/seedream-client.js';

const silentLogger = { log() {}, warn() {}, error() {} };

function mockFetch(
  responses: Array<{ ok: boolean; status?: number; json?: () => Promise<any>; text?: () => Promise<string> }>,
  capture?: { bodies: string[]; urls: string[] },
) {
  let callIndex = 0;
  return async (url: string | URL | Request, init?: RequestInit) => {
    if (capture) {
      if (init?.body) capture.bodies.push(String(init.body));
      capture.urls.push(String(url));
    }
    const resp = responses[callIndex++] ?? responses[responses.length - 1];
    return {
      ok: resp.ok,
      status: resp.status ?? (resp.ok ? 200 : 500),
      json: resp.json ?? (async () => ({})),
      text: resp.text ?? (async () => ''),
    } as Response;
  };
}

describe('SeedreamClient', () => {
  test('同步请求成功 → url 有值（Ark OpenAI 形状 data[].url + 锁定请求形状）', async () => {
    const capture = { bodies: [] as string[], urls: [] as string[] };
    const fetchImpl = mockFetch(
      [{ ok: true, json: async () => ({ data: [{ url: 'https://ark.example.com/seed.png' }] }) }],
      capture,
    );
    const client = new SeedreamClient({
      apiKey: 'ark-key',
      baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
      logger: silentLogger,
      fetchImpl: fetchImpl as any,
    });

    const result = await client.generate('小红书封面：技术科普', '扁平插画');
    assert.equal(result.url, 'https://ark.example.com/seed.png');
    assert.equal(result.error, undefined);
    // 同步端点：{baseUrl}/images/generations，单次请求（无轮询）。
    assert.equal(capture.urls.length, 1);
    assert.match(capture.urls[0], /\/images\/generations$/);
    const body = JSON.parse(capture.bodies[0]);
    assert.equal(body.model, 'doubao-seedream-4-5-251128');
    assert.equal(body.response_format, 'url');
    assert.equal(body.watermark, false);
    // style 并入提示词。
    assert.match(body.prompt, /技术科普/);
    assert.match(body.prompt, /扁平插画/);
  });

  test('getModel 解析器优先于构造 model', async () => {
    const capture = { bodies: [] as string[], urls: [] as string[] };
    const fetchImpl = mockFetch([{ ok: true, json: async () => ({ data: [{ url: 'https://x/y.png' }] }) }], capture);
    const client = new SeedreamClient({
      apiKey: 'ark-key',
      getModel: () => 'doubao-seedream-4-0-250828',
      logger: silentLogger,
      fetchImpl: fetchImpl as any,
    });
    await client.generate('p');
    assert.equal(JSON.parse(capture.bodies[0]).model, 'doubao-seedream-4-0-250828');
  });

  test('非 200 → url=null, error 有值', async () => {
    const fetchImpl = mockFetch([{ ok: false, status: 400, text: async () => 'InvalidParameter' }]);
    const client = new SeedreamClient({ apiKey: 'ark-key', logger: silentLogger, fetchImpl: fetchImpl as any });
    const result = await client.generate('p');
    assert.equal(result.url, null);
    assert.ok(result.error);
    assert.match(result.error, /HTTP 400/);
  });

  test('响应体带 error → url=null, error 有值', async () => {
    const fetchImpl = mockFetch([
      { ok: true, json: async () => ({ error: { code: 'SensitiveContent', message: '内容违规' } }) },
    ]);
    const client = new SeedreamClient({ apiKey: 'ark-key', logger: silentLogger, fetchImpl: fetchImpl as any });
    const result = await client.generate('p');
    assert.equal(result.url, null);
    assert.ok(result.error);
    assert.match(result.error, /内容违规|SensitiveContent/);
  });

  test('成功但缺 URL → url=null, error 有值（诚实、不伪造）', async () => {
    const fetchImpl = mockFetch([{ ok: true, json: async () => ({ data: [{ b64_json: 'x' }] }) }]);
    const client = new SeedreamClient({ apiKey: 'ark-key', logger: silentLogger, fetchImpl: fetchImpl as any });
    const result = await client.generate('p');
    assert.equal(result.url, null);
    assert.match(result.error!, /缺少图片 URL/);
  });

  test('无 API key → 发请求前诚实失败（绝不发空 Bearer）', async () => {
    const capture = { bodies: [] as string[], urls: [] as string[] };
    const fetchImpl = mockFetch([{ ok: true, json: async () => ({ data: [{ url: 'x' }] }) }], capture);
    const client = new SeedreamClient({ apiKey: '', logger: silentLogger, fetchImpl: fetchImpl as any });
    const result = await client.generate('p');
    assert.equal(result.url, null);
    assert.match(result.error!, /key 缺失|Seedream/);
    // 绝不发起请求。
    assert.equal(capture.urls.length, 0);
  });
});
