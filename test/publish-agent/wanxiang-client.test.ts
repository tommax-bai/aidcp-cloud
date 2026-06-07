import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { WanxiangClient } from '../../src/publish-agent/wanxiang-client.js';

const silentLogger = { log() {}, warn() {}, error() {} };

function mockFetch(responses: Array<{ ok: boolean; status?: number; json?: () => Promise<any>; text?: () => Promise<string> }>) {
  let callIndex = 0;
  return async (_url: string | URL | Request, _init?: RequestInit) => {
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
  test('提交成功 + 轮询返回 SUCCEEDED → url 有值', async () => {
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
      // 第二次轮询 - SUCCEEDED
      {
        ok: true,
        json: async () => ({ output: { task_id: 'task-123', task_status: 'SUCCEEDED', results: [{ url: 'https://cdn.example.com/img.png' }] } }),
      },
    ]);

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
