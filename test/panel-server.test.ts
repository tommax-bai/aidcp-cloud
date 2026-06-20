import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { startPanelApi } from '../src/panel/panel-server.js';
import { parsePanelUsers } from '../src/panel/auth.js';
import type { PanelConfig, PanelDeps } from '../src/panel/types.js';
import type { PanelAccount, PanelStoreReader } from '../src/panel/panel-store.js';

const silentLogger = { log() {}, warn() {}, error() {} };

const acct: PanelAccount = {
  accountId: 'default',
  label: 'default',
  platform: 'xiaohongshu',
  groupLabel: null,
  machineLabel: null,
  operatorStatus: 'active',
  pausedAt: null,
  riskStatus: 'normal',
  riskQuotaLevel: 'normal',
  signalCount: 0,
};

const mockPanelStore: PanelStoreReader = {
  todayTotals: async () => ({ like: 10, collect: 2, comment: 1, follow: 0, publish: 1, view: 40 }),
  todayPublishCount: async () => 1,
  likeRate: async () => ({ likes: 10, views: 40, rate: 0.25, healthy: true }),
  listAccounts: async () => [acct],
  getAccount: async (id) => (id === 'default' ? acct : null),
  publishedHistory: async () => [
    { id: 1, title: 't', status: 'published', platformPostId: 'p1', publishedAt: 123 },
  ],
};

const deps = {
  edgeServer: { edgeCount: () => 3, onlineEdgeCount: () => 3 },
  eventBus: { onAny: () => () => {} }, // panel WS attach 需要；返回 unsub
  panelStore: mockPanelStore,
  publishOrchestrator: { getStatus: () => ({ status: 'idle', snapshot: null }) },
} as unknown as PanelDeps;

function makeConfig(over: Partial<PanelConfig> = {}): PanelConfig {
  return {
    port: 0,
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

test('HTTP 集成：version 公开、登录签发 JWT、受保护读接口、404', async () => {
  const h = await startPanelApi(deps, makeConfig());
  assert.equal(h.started, true);
  const base = `http://127.0.0.1:${h.port}`;
  try {
    // /api/version 公开 + 枚举
    const ver = await fetch(`${base}/api/version`);
    assert.equal(ver.status, 200);
    const verBody = (await ver.json()) as { panelApiVersion: number; enums: { riskStatus: string[] } };
    assert.deepEqual(verBody.enums.riskStatus, ['normal', 'warned', 'restricted', 'frozen']);

    // 受保护无 token → 401
    assert.equal((await fetch(`${base}/api/me`)).status, 401);

    // 登录
    const login = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'alice', password: 'pw1' }),
    });
    assert.equal(login.status, 200);
    const { token } = (await login.json()) as { token: string };
    const auth = { authorization: `Bearer ${token}` };

    // dashboard summary：totals + edgesOnline + likeRate + accounts + attributionPending
    const sum = await fetch(`${base}/api/dashboard/summary`, { headers: auth });
    assert.equal(sum.status, 200);
    const sumBody = (await sum.json()) as {
      edgesOnline: number;
      totals: { like: number; publish: number };
      likeRate: { rate: number };
      accounts: unknown[];
      attributionPending: boolean;
    };
    assert.equal(sumBody.edgesOnline, 3);
    assert.equal(sumBody.totals.like, 10);
    assert.equal(sumBody.totals.publish, 1);
    assert.equal(sumBody.likeRate.rate, 0.25);
    assert.equal(sumBody.accounts.length, 1);
    assert.equal(sumBody.attributionPending, true);

    // accounts 列表 / 详情 / 404
    const accs = (await (await fetch(`${base}/api/accounts`, { headers: auth })).json()) as {
      accounts: unknown[];
    };
    assert.equal(accs.accounts.length, 1);
    assert.equal((await fetch(`${base}/api/accounts/default`, { headers: auth })).status, 200);
    assert.equal((await fetch(`${base}/api/accounts/nope`, { headers: auth })).status, 404);

    // content/published + content/queue + analytics/like-rate
    const pub = (await (await fetch(`${base}/api/content/published`, { headers: auth })).json()) as {
      items: unknown[];
    };
    assert.equal(pub.items.length, 1);
    const queue = (await (await fetch(`${base}/api/content/queue`, { headers: auth })).json()) as {
      status: string;
    };
    assert.equal(queue.status, 'idle');
    const lr = (await (await fetch(`${base}/api/analytics/like-rate`, { headers: auth })).json()) as {
      healthy: boolean;
    };
    assert.equal(lr.healthy, true);

    // 未知受保护路由 → 404
    assert.equal((await fetch(`${base}/api/nope`, { headers: auth })).status, 404);
  } finally {
    await h.close();
  }
});
