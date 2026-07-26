/**
 * 厂商密钥窄读的跨进程往返 + **「读不到 ≠ 没配」**。
 *
 * 这条口没有镜像（只在启动期被调几次），也不 fail-open：
 * 把一次读失败吞成 `null`，调用方会当成「这个厂商没配」于是静默少构造一个出口——
 * 表现为某条链路悄悄不工作、且没有任何报错。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { InternalHttpClient, InternalHttpServer } from '../../src/transport/internal-http.js';
import {
  PROVIDER_SECRET_ROUTES,
  ProviderSecretHttpClient,
  registerProviderSecretRoutes,
} from '../../src/transport/provider-secret-http.js';
import type { ProviderSecretReader } from '../../src/kernel/provider-secret-port.js';

async function withServer(
  local: ProviderSecretReader,
  run: (client: ProviderSecretReader) => Promise<void>,
): Promise<void> {
  const server = new InternalHttpServer();
  registerProviderSecretRoutes(server, local);
  const port = await server.listen(0);
  try {
    await run(new ProviderSecretHttpClient(new InternalHttpClient(`http://127.0.0.1:${port}`)));
  } finally {
    await server.close();
  }
}

test('往返：厂商与字段原样送达；缺凭据回 null（不是空串）', async () => {
  const seen: unknown[] = [];
  await withServer(
    {
      getSecretForRuntime: async (provider, field) => {
        seen.push({ provider, field });
        return provider === 'dashscope' ? 'sk-live' : null;
      },
    },
    async (client) => {
      assert.equal(await client.getSecretForRuntime('dashscope', 'dashscope_api_key'), 'sk-live');
      assert.equal(
        await client.getSecretForRuntime('volcengine', 'ark_api_key'),
        null,
        '缺凭据 MUST 是 null —— 空串会让调用方构造一个必然 401 的出口',
      );
      assert.deepEqual(seen, [
        { provider: 'dashscope', field: 'dashscope_api_key' },
        { provider: 'volcengine', field: 'ark_api_key' },
      ]);
    },
  );
});

test('读失败 MUST 抛，绝不吞成「这个厂商没配」', async () => {
  await withServer(
    {
      getSecretForRuntime: async () => {
        throw new Error('credential table unreachable');
      },
    },
    async (client) => {
      await assert.rejects(() => client.getSecretForRuntime('dashscope', 'dashscope_api_key'));
    },
  );
});

test('对端没起同样抛：静默少构造一个出口是无声故障', async () => {
  const client = new ProviderSecretHttpClient(new InternalHttpClient('http://127.0.0.1:1'));
  await assert.rejects(() => client.getSecretForRuntime('dashscope', 'dashscope_api_key'));
});

test('路由名两侧共用同一常量', () => {
  assert.equal(PROVIDER_SECRET_ROUTES.getSecretForRuntime, 'provider-secret/get-for-runtime');
});
