import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { startPanelApi } from '../src/panel/panel-server.js';
import { parsePanelUsers } from '../src/panel/auth.js';
import type { PanelConfig, PanelDeps } from '../src/panel/types.js';

const silentLogger = { log() {}, warn() {}, error() {} };

// task 1 路由只触达 edgeServer；其余依赖造空桩。
const deps = { edgeServer: { edgeCount: () => 3 } } as unknown as PanelDeps;

function makeConfig(over: Partial<PanelConfig> = {}): PanelConfig {
  return {
    port: 0, // OS 分配
    jwtSecret: 'test-secret',
    users: parsePanelUsers('alice:pw1'),
    jwtTtlSeconds: 3600,
    forbiddenPorts: [8787, 5432, 8788],
    logger: silentLogger,
    ...over,
  };
}

test('自检拒绝保留端口（forbidden_port）', async () => {
  const h = await startPanelApi(deps, makeConfig({ port: 8787 }));
  assert.equal(h.started, false);
  assert.equal(h.reason, 'forbidden_port');
  await h.close();
});

test('缺 JWT 密钥不启动（missing_secret）', async () => {
  const h = await startPanelApi(deps, makeConfig({ jwtSecret: '' }));
  assert.equal(h.started, false);
  assert.equal(h.reason, 'missing_secret');
  await h.close();
});

test('无用户不启动（no_users）', async () => {
  const h = await startPanelApi(deps, makeConfig({ users: [] }));
  assert.equal(h.started, false);
  assert.equal(h.reason, 'no_users');
  await h.close();
});

test('端口占用非致命（listen_error，不抛出）', async () => {
  const blocker = net.createServer();
  await new Promise<void>((r) => blocker.listen(0, '127.0.0.1', () => r()));
  const busyPort = (blocker.address() as net.AddressInfo).port;
  const h = await startPanelApi(deps, makeConfig({ port: busyPort }));
  assert.equal(h.started, false);
  assert.equal(h.reason, 'listen_error');
  await h.close();
  await new Promise<void>((r) => blocker.close(() => r()));
});

test('HTTP 集成：version 公开、登录签发 JWT、受保护路由鉴权、summary 读注入', async () => {
  const h = await startPanelApi(deps, makeConfig());
  assert.equal(h.started, true);
  const base = `http://127.0.0.1:${h.port}`;
  try {
    // /api/version 公开
    const ver = await fetch(`${base}/api/version`);
    assert.equal(ver.status, 200);
    const verBody = (await ver.json()) as { panelApiVersion: number; enums: { riskStatus: string[] } };
    assert.equal(verBody.panelApiVersion, 1);
    assert.deepEqual(verBody.enums.riskStatus, ['normal', 'warned', 'restricted', 'frozen']);

    // 受保护路由无 token → 401
    const noTok = await fetch(`${base}/api/me`);
    assert.equal(noTok.status, 401);

    // 登录错误凭据 → 401
    const badLogin = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'alice', password: 'wrong' }),
    });
    assert.equal(badLogin.status, 401);

    // 登录正确凭据 → 200 + token
    const login = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'alice', password: 'pw1' }),
    });
    assert.equal(login.status, 200);
    const { token } = (await login.json()) as { token: string };
    assert.ok(token && token.split('.').length === 3);

    // 带 token → /api/me 200
    const me = await fetch(`${base}/api/me`, { headers: { authorization: `Bearer ${token}` } });
    assert.equal(me.status, 200);
    const meBody = (await me.json()) as { sub: string };
    assert.equal(meBody.sub, 'alice');

    // summary 骨架读到注入的 edgeServer.edgeCount()
    const sum = await fetch(`${base}/api/dashboard/summary`, { headers: { authorization: `Bearer ${token}` } });
    assert.equal(sum.status, 200);
    const sumBody = (await sum.json()) as { edgesOnline: number; partial: boolean };
    assert.equal(sumBody.edgesOnline, 3);
    assert.equal(sumBody.partial, true);

    // 篡改 token → 401
    const forged = await fetch(`${base}/api/me`, { headers: { authorization: 'Bearer a.b.c' } });
    assert.equal(forged.status, 401);

    // 未知 /api 路由 → 404
    const nf = await fetch(`${base}/api/does-not-exist`, { headers: { authorization: `Bearer ${token}` } });
    assert.equal(nf.status, 404);
  } finally {
    await h.close();
  }
});
