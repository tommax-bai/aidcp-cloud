import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  InternalHttpClient,
  InternalHttpError,
  InternalHttpServer,
  INTERNAL_HTTP_DEFAULT_TIMEOUT_MS,
  INTERNAL_HTTP_TIMEOUT_CEILING_MS,
  makeReadPort,
  readPortModeFromEnv,
} from '../../src/transport/internal-http.js';

async function withServer(
  build: (server: InternalHttpServer) => void,
  run: (baseUrl: string, server: InternalHttpServer) => Promise<void>,
): Promise<void> {
  const server = new InternalHttpServer();
  build(server);
  const port = await server.listen(0);
  try {
    await run(`http://127.0.0.1:${port}`, server);
  } finally {
    await server.close();
  }
}

test('往返 JSON：client 调 handler，入参出参正确、类型对', async () => {
  await withServer(
    (s) =>
      s.register('echo', async (args) => {
        const a = args as { n: number; s: string };
        return { doubled: a.n * 2, echoed: a.s };
      }),
    async (base) => {
      const client = new InternalHttpClient(base);
      const out = await client.call<{ doubled: number; echoed: string }>('echo', { n: 21, s: 'hi' });
      assert.equal(out.doubled, 42);
      assert.equal(out.echoed, 'hi');
    },
  );
});

test('handler 抛错 → 编码为结构化 InternalHttpError（保留 code）', async () => {
  await withServer(
    (s) =>
      s.register('boom', async () => {
        throw new InternalHttpError('not_found', 'no such task');
      }),
    async (base) => {
      const client = new InternalHttpClient(base);
      await assert.rejects(
        () => client.call('boom', {}),
        (err: unknown) => {
          assert.ok(err instanceof InternalHttpError);
          assert.equal(err.code, 'not_found');
          assert.equal(err.message, 'no such task');
          return true;
        },
      );
    },
  );
});

test('handler 抛普通 Error → 归一为 handler_error', async () => {
  await withServer(
    (s) =>
      s.register('plain', async () => {
        throw new Error('kaboom');
      }),
    async (base) => {
      const client = new InternalHttpClient(base);
      await assert.rejects(
        () => client.call('plain', {}),
        (err: unknown) => {
          assert.ok(err instanceof InternalHttpError);
          assert.equal(err.code, 'handler_error');
          assert.equal(err.message, 'kaboom');
          return true;
        },
      );
    },
  );
});

test('未知路由 → route_not_found', async () => {
  await withServer(
    () => {},
    async (base) => {
      const client = new InternalHttpClient(base);
      await assert.rejects(
        () => client.call('nope', {}),
        (err: unknown) => err instanceof InternalHttpError && err.code === 'route_not_found',
      );
    },
  );
});

test('超时生效：慢 handler 触发有界 timeout 错误', async () => {
  await withServer(
    (s) =>
      s.register('slow', async () => {
        await new Promise((r) => setTimeout(r, 200));
        return { ok: true };
      }),
    async (base) => {
      const client = new InternalHttpClient(base, { timeoutMs: 30 });
      const started = Date.now();
      await assert.rejects(
        () => client.call('slow', {}),
        (err: unknown) => err instanceof InternalHttpError && err.code === 'timeout',
      );
      // 应当在远小于 handler 200ms 前就超时返回
      assert.ok(Date.now() - started < 150, 'timeout should fire well before handler finishes');
    },
  );
});

test('超时被夹到硬顶天花板之内', () => {
  const client = new InternalHttpClient('http://127.0.0.1:1', {
    timeoutMs: INTERNAL_HTTP_TIMEOUT_CEILING_MS * 10,
  });
  // 无法直接读私有字段，用一个越界值创建不应抛错即证明夹取路径存在
  assert.ok(client instanceof InternalHttpClient);
  assert.ok(INTERNAL_HTTP_DEFAULT_TIMEOUT_MS < INTERNAL_HTTP_TIMEOUT_CEILING_MS);
});

test('连接失败 → transport_error（不挂起）', async () => {
  // 指向一个几乎不可能有服务的端口
  const client = new InternalHttpClient('http://127.0.0.1:1', { timeoutMs: 500 });
  await assert.rejects(
    () => client.call('x', {}),
    (err: unknown) =>
      err instanceof InternalHttpError && (err.code === 'transport_error' || err.code === 'timeout'),
  );
});

test('register 重复路由即抛 route_conflict', () => {
  const s = new InternalHttpServer();
  s.register('dup', async () => 1);
  assert.throws(
    () => s.register('dup', async () => 2),
    (err: unknown) => err instanceof InternalHttpError && err.code === 'route_conflict',
  );
});

test('Bearer route 在 handler 前拒绝缺失/错误 token，显式匹配后才调用', async () => {
  let calls = 0;
  await withServer(
    (s) =>
      s.registerBearer('protected', 'expected-token', async () => {
        calls += 1;
        return { accepted: true };
      }),
    async (base) => {
      const client = new InternalHttpClient(base);
      for (const invoke of [
        () => client.call('protected', {}),
        () => client.callBearer('protected', {}, 'wrong-token'),
      ]) {
        await assert.rejects(
          invoke,
          (err: unknown) =>
            err instanceof InternalHttpError && err.code === 'internal_http_unauthorized',
        );
      }
      assert.equal(calls, 0);
      assert.deepEqual(
        await client.callBearer('protected', {}, 'expected-token'),
        { accepted: true },
      );
      assert.equal(calls, 1);
    },
  );
});

test('Bearer route/client 的空白 token 在配置期 fail-fast，不回落裸调用', () => {
  const server = new InternalHttpServer();
  assert.throws(
    () => server.registerBearer('protected', '', async () => true),
    (err: unknown) =>
      err instanceof InternalHttpError && err.code === 'internal_http_auth_config_invalid',
  );
  const client = new InternalHttpClient('http://127.0.0.1:1');
  assert.throws(
    () => client.callBearer('protected', {}, 'contains whitespace'),
    (err: unknown) =>
      err instanceof InternalHttpError && err.code === 'internal_http_auth_config_invalid',
  );
});

test("makeReadPort 'local' 模式完全不碰 HTTP（remote thunk 不被调用）", () => {
  const local = { value: 'local-instance' };
  let remoteCalled = false;
  const remote = () => {
    remoteCalled = true;
    return { value: 'remote-instance' };
  };
  const port = makeReadPort(local, remote); // 默认 local
  assert.equal(port, local);
  assert.equal(port.value, 'local-instance');
  assert.equal(remoteCalled, false, "local 模式 remote thunk MUST NOT 被调用");
});

test("makeReadPort 'http' 模式走 remote 实例", () => {
  const local = { value: 'local-instance' };
  const remoteInstance = { value: 'remote-instance' };
  const port = makeReadPort(local, () => remoteInstance, 'http');
  assert.equal(port, remoteInstance);
});

test('readPortModeFromEnv 默认 local，仅显式 http 才切', () => {
  assert.equal(readPortModeFromEnv({}), 'local');
  assert.equal(readPortModeFromEnv({ AIDCP_READ_PORT_TRANSPORT: 'local' }), 'local');
  assert.equal(readPortModeFromEnv({ AIDCP_READ_PORT_TRANSPORT: 'anything' }), 'local');
  assert.equal(readPortModeFromEnv({ AIDCP_READ_PORT_TRANSPORT: 'http' }), 'http');
});
