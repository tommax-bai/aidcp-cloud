import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { startPanelApi } from '../src/panel/panel-server.js';
import { parsePanelUsers } from '../src/panel/auth.js';
import type { PanelConfig, PanelDeps } from '../src/panel/types.js';
import type { PanelAccount, PanelStoreReader } from '../src/panel/panel-store.js';
import { RiskController } from '../src/risk/index.js';

const silentLogger = { log() {}, warn() {}, error() {} };

const acct: PanelAccount = {
  accountId: 'default',
  label: 'default',
  nickname: null,
  platform: 'xiaohongshu',
  groupLabel: null,
  machineLabel: null,
  operatorStatus: 'active',
  pausedAt: null,
  riskStatus: 'normal',
  riskQuotaLevel: 'normal',
  signalCount: 0,
  personaBound: true,
  needsPersonaSetup: false,
};

const mockPanelStore: PanelStoreReader = {
  todayTotals: async () => ({ like: 10, collect: 2, comment: 1, follow: 0, publish: 1, view: 40, comment_like: 0 }),
  todayTotalsByAccount: async () => [
    { accountId: 'default', totals: { like: 10, collect: 2, comment: 1, follow: 0, publish: 1, view: 40, comment_like: 0 } },
  ],
  todayPublishCount: async () => 1,
  likeRate: async () => ({ likes: 10, views: 40, rate: 0.25, healthy: true }),
  listAccounts: async () => [acct],
  getAccount: async (id) => (id === 'default' ? acct : null),
  publishedHistory: async (_limit, accountId) => [
    {
      id: 1,
      title: 't',
      status: 'published',
      platformPostId: 'p1',
      publishedAt: 123,
      accountId: accountId ?? 'default',
      accountLabel: accountId ?? 'default',
      content: '正文全文',
      postUrl: 'https://www.xiaohongshu.com/explore/p1?xsec_token=tok',
    },
  ],
  listAlerts: async () => [
    { id: 1, severity: 'P0', type: 'captcha', accountId: 'default', title: '验证码弹出', detail: null, createdAt: 100, resolvedAt: null },
  ],
  listInteractions: async (opts) => [
    { accountId: opts?.accountId ?? 'default', targetId: 'note-1', action: 'like', title: '一篇笔记', url: 'https://www.xiaohongshu.com/explore/note-1?xsec_token=x', interactedAt: 200 },
  ],
};

let dispatchActiveState = true;
const deps = {
  edgeServer: { edgeCount: () => 3, onlineEdgeCount: () => 3 },
  eventBus: { onAny: () => () => {} }, // panel WS attach 需要；返回 unsub
  panelStore: mockPanelStore,
  publishOrchestrator: { getStatus: () => ({ status: 'idle', snapshot: null }) },
  writeApprovalSignal: async (_requestId: string, _approved: boolean) => ({ written: true }),
  commandActions: {
    pause: async (id: string) => ({ accountId: id, status: 'paused' }),
    resume: async (id: string) => ({ accountId: id, status: 'active', resumedEdges: 2 }),
    dispatch: async (id: string, action: 'start' | 'stop') => {
      const want = action === 'start';
      const changed = dispatchActiveState !== want;
      dispatchActiveState = want;
      return { accountId: id, dispatch: want ? ('started' as const) : ('stopped' as const), changed, edgesOnline: 3 };
    },
    dispatchActive: () => dispatchActiveState,
  },
  riskRegistry: { getController: async (id: string) => new RiskController({ accountId: id }) },
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

    // dashboard summary：totals + edgesOnline + likeRate + accounts + 按账号切片 + 告警 + 调度态
    const sum = await fetch(`${base}/api/dashboard/summary`, { headers: auth });
    assert.equal(sum.status, 200);
    const sumBody = (await sum.json()) as {
      edgesOnline: number;
      totals: { like: number; publish: number };
      totalsByAccount: { accountId: string; totals: { like: number } }[];
      likeRate: { rate: number };
      accounts: unknown[];
      alerts: { severity: string }[];
      attributionPending: boolean;
      dispatchActive: boolean | null;
    };
    assert.equal(sumBody.edgesOnline, 3);
    assert.equal(sumBody.totals.like, 10);
    assert.equal(sumBody.totals.publish, 1);
    assert.equal(sumBody.likeRate.rate, 0.25);
    assert.equal(sumBody.accounts.length, 1);
    // V1 task 9.6：归因已流通，去「归因待补」，上真按账号切片
    assert.equal(sumBody.attributionPending, false);
    assert.equal(sumBody.totalsByAccount[0].accountId, 'default');
    assert.equal(sumBody.totalsByAccount[0].totals.like, 10);
    // V1 task 9.5：真告警
    assert.equal(sumBody.alerts[0].severity, 'P0');
    // V1 task 9.4：调度引擎态
    assert.equal(sumBody.dispatchActive, true);

    // /api/version 暴露告警分级枚举（task 5.4 follow-up）
    const ver2 = (await (await fetch(`${base}/api/version`)).json()) as { enums: { alertSeverity: string[] } };
    assert.deepEqual(ver2.enums.alertSeverity, ['P0', 'P1', 'P2', 'P3']);

    // V1 task 9.5：/api/alerts 只读流
    const al = (await (await fetch(`${base}/api/alerts`, { headers: auth })).json()) as { alerts: unknown[] };
    assert.equal(al.alerts.length, 1);

    // V1 task 9.2 / change interaction-feed-enrichment：/api/monitor/interactions（按账号过滤；目标=targetId + 标题/链接）
    const it = (await (
      await fetch(`${base}/api/monitor/interactions?accountId=default`, { headers: auth })
    ).json()) as { interactions: { accountId: string; targetId: string; title?: string; url?: string }[] };
    assert.equal(it.interactions[0].targetId, 'note-1');
    assert.equal(it.interactions[0].accountId, 'default');
    assert.equal(it.interactions[0].title, '一篇笔记');

    // change publish-history-account-and-detail：已发布历史带账号/正文/详情链接 + ?accountId 透传过滤。
    const pubFiltered = (await (
      await fetch(`${base}/api/content/published?accountId=acc-7`, { headers: auth })
    ).json()) as { items: { accountId: string; accountLabel: string; content: string; postUrl: string }[] };
    assert.equal(pubFiltered.items[0].accountId, 'acc-7', '?accountId 透传到 store');
    assert.equal(pubFiltered.items[0].content, '正文全文', '返回正文全文');
    assert.ok(pubFiltered.items[0].postUrl.includes('xsec_token'), '返回带 token 的详情页链接');

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

test('HTTP 写路由：审批返 written 非 published；命令返真实结果；鉴权', async () => {
  const h = await startPanelApi(deps, makeConfig());
  assert.equal(h.started, true);
  const base = `http://127.0.0.1:${h.port}`;
  try {
    const login = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'alice', password: 'pw1' }),
    });
    const { token } = (await login.json()) as { token: string };
    const auth = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };

    // 审批：返回 written，绝不 published（红线）
    const ap = await fetch(`${base}/api/publish/req-1/approve`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ approved: true }),
    });
    assert.equal(ap.status, 200);
    const apBody = (await ap.json()) as Record<string, unknown>;
    assert.equal(apBody.written, true);
    assert.equal('published' in apBody, false);

    // 审批缺 approved → 400
    const bad = await fetch(`${base}/api/publish/req-1/approve`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({}),
    });
    assert.equal(bad.status, 400);

    // 命令 pause / resume → 真实结果
    const pb = (await (
      await fetch(`${base}/api/accounts/default/command`, {
        method: 'POST',
        headers: auth,
        body: JSON.stringify({ command: 'pause' }),
      })
    ).json()) as { status: string };
    assert.equal(pb.status, 'paused');

    const rb = (await (
      await fetch(`${base}/api/accounts/default/command`, {
        method: 'POST',
        headers: auth,
        body: JSON.stringify({ command: 'resume' }),
      })
    ).json()) as { resumedEdges: number };
    assert.equal(rb.resumedEdges, 2);

    // 未知命令 → 400
    const unk = await fetch(`${base}/api/accounts/default/command`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ command: 'bogus' }),
    });
    assert.equal(unk.status, 400);

    // 写路由无 token → 401
    const noTok = await fetch(`${base}/api/accounts/default/command`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ command: 'pause' }),
    });
    assert.equal(noTok.status, 401);
  } finally {
    await h.close();
  }
});

test('HTTP risk 写路由：枚举 kind / override 需 reason / quota / 真态写回（V1 8.4）', async () => {
  const h = await startPanelApi(deps, makeConfig());
  const base = `http://127.0.0.1:${h.port}`;
  try {
    const login = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'alice', password: 'pw1' }),
    });
    const { token } = (await login.json()) as { token: string };
    const auth = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
    const post = (path: string, body: unknown) =>
      fetch(`${base}${path}`, { method: 'POST', headers: auth, body: JSON.stringify(body) });

    // manual_restrict: normal → restricted, changed
    const r1 = (await (await post('/api/accounts/default/risk/status', { kind: 'manual_restrict' })).json()) as {
      state: { status: string };
      changed: boolean;
    };
    assert.equal(r1.state.status, 'restricted');
    assert.equal(r1.changed, true);

    // manual_freeze → frozen
    const r2 = (await (await post('/api/accounts/default/risk/status', { kind: 'manual_freeze' })).json()) as {
      state: { status: string };
    };
    assert.equal(r2.state.status, 'frozen');

    // override 缺 reason → 400；带 reason → 200
    assert.equal((await post('/api/accounts/default/risk/status', { kind: 'operator_override_recover' })).status, 400);
    assert.equal(
      (await post('/api/accounts/default/risk/status', { kind: 'operator_override_recover', reason: 'manual review' })).status,
      200,
    );

    // 枚举外 kind → 400
    assert.equal((await post('/api/accounts/default/risk/status', { kind: 'light' })).status, 400);

    // quota: aggressive；枚举外 → 400
    const q = (await (await post('/api/accounts/default/risk/quota', { level: 'aggressive' })).json()) as {
      state: { quotaLevel: string };
    };
    assert.equal(q.state.quotaLevel, 'aggressive');
    assert.equal((await post('/api/accounts/default/risk/quota', { level: 'mega' })).status, 400);
  } finally {
    await h.close();
  }
});

test('HTTP dispatch 写路由：start/stop 回报真态 + changed + 真实在线 edge 数（V1 9.4）', async () => {
  const h = await startPanelApi(deps, makeConfig());
  const base = `http://127.0.0.1:${h.port}`;
  try {
    const login = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'alice', password: 'pw1' }),
    });
    const { token } = (await login.json()) as { token: string };
    const auth = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
    const post = (path: string, body: unknown) =>
      fetch(`${base}${path}`, { method: 'POST', headers: auth, body: JSON.stringify(body) });

    // stop：从 active → stopped, changed=true, 真实在线数
    const s1 = (await (await post('/api/accounts/default/dispatch', { action: 'stop' })).json()) as {
      dispatch: string;
      changed: boolean;
      edgesOnline: number;
    };
    assert.equal(s1.dispatch, 'stopped');
    assert.equal(s1.changed, true);
    assert.equal(s1.edgesOnline, 3);

    // 再 stop：已 stopped, changed=false（诚实：no-op 可辨）
    const s2 = (await (await post('/api/accounts/default/dispatch', { action: 'stop' })).json()) as {
      changed: boolean;
    };
    assert.equal(s2.changed, false);

    // start：回到 started
    const s3 = (await (await post('/api/accounts/default/dispatch', { action: 'start' })).json()) as {
      dispatch: string;
      changed: boolean;
    };
    assert.equal(s3.dispatch, 'started');
    assert.equal(s3.changed, true);

    // 未知 action → 400
    assert.equal((await post('/api/accounts/default/dispatch', { action: 'bogus' })).status, 400);
  } finally {
    await h.close();
  }
});
