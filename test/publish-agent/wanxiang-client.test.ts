import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { WanxiangClient } from '../../src/publish-agent/wanxiang-client.js';

const silentLogger = { log() {}, warn() {}, error() {} };

function mockFetch(
  responses: Array<{ ok: boolean; status?: number; json?: () => Promise<any>; text?: () => Promise<string> }>,
  capture?: { bodies: string[] },
) {
  let callIndex = 0;
  return async (_url: string | URL | Request, _init?: RequestInit) => {
    if (capture && _init?.body) capture.bodies.push(String(_init.body));
    const resp = responses[callIndex++] ?? responses[responses.length - 1];
    return {
      ok: resp.ok,
      status: resp.status ?? (resp.ok ? 200 : 500),
      json: resp.json ?? (async () => ({})),
      text: resp.text ?? (async () => ''),
    } as Response;
  };
}

describe('WanxiangClient', () => {
  test('提交成功 + 轮询返回 SUCCEEDED → url 有值（wan2.7 messages 入参 + choices 出参）', async () => {
    const capture = { bodies: [] as string[] };
    const fetchImpl = mockFetch([
      // 提交任务响应
      {
        ok: true,
        json: async () => ({ output: { task_id: 'task-123', task_status: 'PENDING' } }),
      },
      // 第一次轮询 - RUNNING
      {
        ok: true,
        json: async () => ({ output: { task_id: 'task-123', task_status: 'RUNNING' } }),
      },
      // 第二次轮询 - SUCCEEDED（wan2.7：结果在 choices[].message.content[].image）
      {
        ok: true,
        json: async () => ({
          output: {
            task_id: 'task-123',
            task_status: 'SUCCEEDED',
            choices: [{ message: { content: [{ image: 'https://cdn.example.com/img.png', type: 'image' }] } }],
          },
        }),
      },
    ], capture);

    const client = new WanxiangClient({
      apiKey: 'test-key',
      pollIntervalMs: 10,
      maxPollAttempts: 5,
      logger: silentLogger,
      fetchImpl: fetchImpl as any,
    });

    const result = await client.generate('cute cat illustration');
    assert.equal(result.url, 'https://cdn.example.com/img.png');
    assert.equal(result.taskId, 'task-123');
    assert.equal(result.error, undefined);
    // 锁定 wan2.7 请求形状：model + messages 入参。
    const submitBody = JSON.parse(capture.bodies[0]);
    assert.equal(submitBody.model, 'wan2.7-image-pro');
    assert.equal(submitBody.input.messages[0].content[0].text, 'cute cat illustration');
    assert.equal(submitBody.parameters.watermark, false);
    assert.equal(result.referenceStatus, undefined);
    assert.equal(result.referenceUsed, undefined);
  });

  test('携带 referenceImages 时按 Wan 2.7 多模态图片输入提交，成功标记 used', async () => {
    const capture = { bodies: [] as string[] };
    const fetchImpl = mockFetch([
      {
        ok: true,
        json: async () => ({ output: { task_id: 'task-ref', task_status: 'PENDING' } }),
      },
      {
        ok: true,
        json: async () => ({
          output: {
            task_id: 'task-ref',
            task_status: 'SUCCEEDED',
            choices: [{ message: { content: [{ image: 'https://cdn.example.com/ref-out.png', type: 'image' }] } }],
          },
        }),
      },
    ], capture);

    const client = new WanxiangClient({
      apiKey: 'test-key',
      pollIntervalMs: 10,
      maxPollAttempts: 5,
      logger: silentLogger,
      fetchImpl: fetchImpl as any,
    });

    const result = await client.generate('保持原图黑白文字卡片版式，改写成新的标题和要点', undefined, {
      referenceImages: [' https://oss.example.com/original-1.webp ', '', 'https://oss.example.com/original-2.webp'],
    });

    assert.equal(result.url, 'https://cdn.example.com/ref-out.png');
    assert.equal(result.referenceStatus, 'used');
    assert.equal(result.referenceUsed, true);
    const submitBody = JSON.parse(capture.bodies[0]);
    assert.deepEqual(submitBody.input.messages[0].content, [
      { image: 'https://oss.example.com/original-1.webp' },
      { image: 'https://oss.example.com/original-2.webp' },
      { text: '保持原图黑白文字卡片版式，改写成新的标题和要点' },
    ]);
    assert.equal(submitBody.parameters.size, '2K');
    assert.equal(submitBody.parameters.watermark, false);
  });

  test('referenceImages 路径提交失败时标记 unavailable，不伪装 used', async () => {
    const fetchImpl = mockFetch([
      {
        ok: false,
        status: 400,
        text: async () => 'Invalid image URL',
      },
    ]);

    const client = new WanxiangClient({
      apiKey: 'test-key',
      pollIntervalMs: 10,
      logger: silentLogger,
      fetchImpl: fetchImpl as any,
    });

    const result = await client.generate('p', undefined, { referenceImages: ['https://oss.example.com/a.webp'] });
    assert.equal(result.url, null);
    assert.equal(result.referenceStatus, 'unavailable');
    assert.equal(result.referenceUsed, false);
    assert.match(result.error!, /HTTP 400/);
  });

  test('referenceImages 路径轮询无 URL 时标记 unavailable', async () => {
    const fetchImpl = mockFetch([
      {
        ok: true,
        json: async () => ({ output: { task_id: 'task-empty', task_status: 'PENDING' } }),
      },
      {
        ok: true,
        json: async () => ({
          output: {
            task_id: 'task-empty',
            task_status: 'SUCCEEDED',
            choices: [{ message: { content: [] } }],
          },
        }),
      },
    ]);

    const client = new WanxiangClient({
      apiKey: 'test-key',
      pollIntervalMs: 10,
      maxPollAttempts: 5,
      logger: silentLogger,
      fetchImpl: fetchImpl as any,
    });

    const result = await client.generate('p', undefined, { referenceImages: ['https://oss.example.com/a.webp'] });
    assert.equal(result.url, null);
    assert.equal(result.referenceStatus, 'unavailable');
    assert.equal(result.referenceUsed, false);
    assert.match(result.error!, /缺少 URL/);
  });

  test('提交成功 + 轮询返回 FAILED → url=null, error 有值', async () => {
    const fetchImpl = mockFetch([
      // 提交任务响应
      {
        ok: true,
        json: async () => ({ output: { task_id: 'task-456', task_status: 'PENDING' } }),
      },
      // 轮询 - FAILED
      {
        ok: true,
        json: async () => ({ output: { task_id: 'task-456', task_status: 'FAILED' }, message: '内容违规' }),
      },
    ]);

    const client = new WanxiangClient({
      apiKey: 'test-key',
      pollIntervalMs: 10,
      maxPollAttempts: 5,
      logger: silentLogger,
      fetchImpl: fetchImpl as any,
    });

    const result = await client.generate('test prompt');
    assert.equal(result.url, null);
    assert.equal(result.taskId, 'task-456');
    assert.ok(result.error);
    assert.match(result.error, /失败/);
  });

  test('提交失败 → url=null, error 有值', async () => {
    const fetchImpl = mockFetch([
      // 提交失败 HTTP 500
      {
        ok: false,
        status: 500,
        text: async () => 'Internal Server Error',
      },
    ]);

    const client = new WanxiangClient({
      apiKey: 'test-key',
      pollIntervalMs: 10,
      logger: silentLogger,
      fetchImpl: fetchImpl as any,
    });

    const result = await client.generate('test prompt');
    assert.equal(result.url, null);
    assert.ok(result.error);
    assert.match(result.error, /HTTP 500/);
  });

  test('无 API key → 返回错误', async () => {
    const fetchImpl = mockFetch([]);

    const client = new WanxiangClient({
      apiKey: '',
      pollIntervalMs: 10,
      logger: silentLogger,
      fetchImpl: fetchImpl as any,
    });

    const result = await client.generate('test prompt');
    assert.equal(result.url, null);
    assert.ok(result.error);
    assert.match(result.error, /API_KEY/);
  });

  test('referenceImages 路径无 API key 时标记 unavailable 且不发请求', async () => {
    const fetchImpl = mockFetch([]);

    const client = new WanxiangClient({
      apiKey: '',
      pollIntervalMs: 10,
      logger: silentLogger,
      fetchImpl: fetchImpl as any,
    });

    const result = await client.generate('test prompt', undefined, { referenceImages: ['https://oss.example.com/a.webp'] });
    assert.equal(result.url, null);
    assert.equal(result.referenceStatus, 'unavailable');
    assert.equal(result.referenceUsed, false);
    assert.ok(result.error);
    assert.match(result.error, /API_KEY/);
  });

  test('轮询超时（全部 PENDING）→ url=null, error 有值', async () => {
    const fetchImpl = mockFetch([
      // 提交任务
      {
        ok: true,
        json: async () => ({ output: { task_id: 'task-timeout', task_status: 'PENDING' } }),
      },
      // 所有轮询都返回 PENDING
      {
        ok: true,
        json: async () => ({ output: { task_id: 'task-timeout', task_status: 'PENDING' } }),
      },
    ]);

    const client = new WanxiangClient({
      apiKey: 'test-key',
      pollIntervalMs: 5,
      maxPollAttempts: 3,
      logger: silentLogger,
      fetchImpl: fetchImpl as any,
    });

    const result = await client.generate('test prompt');
    assert.equal(result.url, null);
    assert.ok(result.error);
    assert.match(result.error, /超时/);
  });
});
