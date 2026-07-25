/**
 * 面板侧的归属跟随当次连接（change risk-target-follows-active-session）。
 *
 * 归属跟随连接后，面板不再有「非属主只读 / 改归属」这回事：
 * - 风控写（/risk/status、/risk/quota）改回**账号级**，对任意账号都放行（不按归属禁用）。
 * - 首页汇总为**所有**账号带上限（不再按归属跳过——物化只为读展示，真正的止血在条件写那一层）。
 * - 账号 DTO 用只读展示字段 `currentDriverTarget`（最近一次握手的驱动目标）。
 * - `POST /api/accounts/:id/risk-owner` 端点已删（没有手动改归属这回事）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startPanelApi } from '../src/panel/panel-server.js';
import { parsePanelUsers } from '../src/panel/auth.js';
import type { PanelConfig, PanelDeps } from '../src/panel/types.js';

const silentLogger = { log() {}, warn() {}, error() {} };

function account(accountId: string, currentDriverTarget: 'dev' | 'ol' | null) {
  return {
    accountId,
    label: accountId,
    nickname: null,
    operatorAlias: null,
    displayName: accountId,
    displayNameSource: 'account_id' as const,
    platform: 'xiaohongshu',
    groupLabel: null,
    machineLabel: null,
    contactInfo: null,
    operatorStatus: 'active' as const,
    pausedAt: null,
    currentDriverTarget,
    riskStatus: 'normal' as const,
    riskQuotaLevel: 'normal' as const,
    signalCount: 0,
    personaBound: true,
    needsPersonaSetup: false,
  };
}

const ZERO_QUOTA = {
  like: 0, collect: 0, comment: 0, follow: 0, publish: 0,
  view: 0, search: 0, comment_like: 0, join_group: 0, dm_reply: 0,
};

function makeDeps(over: Partial<Record<string, unknown>> = {}) {
  const materialized: string[] = [];
  const submitted: string[] = [];
  const deps = {
    edgeServer: { edgeCount: () => 0, onlineEdgeCount: () => 0 },
    eventBus: { onAny: () => () => {} },
    panelStore: {
      todayTotals: async () => ({ like: 0, collect: 0, comment: 0, follow: 0, view: 0, search: 0, comment_like: 0, join_group: 0, dm_reply: 0, publish: 0 }),
      todayTotalsByAccount: async () => [
        { accountId: 'mine', totals: { like: 1, collect: 0, comment: 0, follow: 0, publish: 0, view: 0, search: 0, comment_like: 0, join_group: 0, dm_reply: 0 } },
        { accountId: 'theirs', totals: { like: 1, collect: 0, comment: 0, follow: 0, publish: 0, view: 0, search: 0, comment_like: 0, join_group: 0, dm_reply: 0 } },
      ],
      todayPublishCount: async () => 0,
      likeRate: async () => ({ likes: 0, views: 0, rate: null, healthy: null }),
      listAccounts: async () => [account('mine', 'dev'), account('theirs', 'ol'), account('orphan', null)],
      getAccount: async () => null,
      publishedHistory: async () => [],
      listAlerts: async () => [],
      listInteractions: async () => [],
    },
    publishStatus: { getStatus: () => Promise.resolve({ status: 'idle', snapshot: null }) },
    commandActions: {},
    // change cloud-coupling-phase5 P5-1：面板不再物化 RiskController。
    // 写走异步命令端口（提交即回 commandId），读走只读投影端口。
    riskCommands: {
      submitSignal: async (input: { accountId: string }) => {
        submitted.push(input.accountId);
        return { commandId: `cmd-${submitted.length}` };
      },
      submitQuotaLevel: async (input: { accountId: string }) => {
        submitted.push(input.accountId);
        return { commandId: `cmd-${submitted.length}` };
      },
      outcomeOf: async (commandId: string) => ({ commandId, state: 'processing' as const }),
    },
    riskRead: {
      getState: async () => ({ status: 'normal', quotaLevel: 'normal' }),
      effectiveQuotas: async (id: string) => {
        materialized.push(id);
        return {
          minute: ZERO_QUOTA,
          hour: ZERO_QUOTA,
          day: { ...ZERO_QUOTA, like: 30 },
        };
      },
      slowStartView: async () => ({ state: 'off' as const, totalDays: 0, eligible: false }),
    },
    ...over,
  } as unknown as PanelDeps;
  return { deps, materialized, submitted };
}

function makeConfig(): PanelConfig {
  return {
    port: 0,
    jwtSecret: 'test-secret',
    users: parsePanelUsers('alice:pw1'),
    jwtTtlSeconds: 3600,
    forbiddenPorts: [8787, 5432, 8788],
    logger: silentLogger,
  };
}

async function withPanel(deps: PanelDeps, fn: (base: string, auth: Record<string, string>) => Promise<void>) {
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
    await fn(base, { authorization: `Bearer ${token}`, 'content-type': 'application/json' });
  } finally {
    await h.close();
  }
}

// 注：change 文档里称这条口为 `/risk/signal`，代码里的真实路径是 `/risk/status`（写的是风控信号）。以代码为准。
test('风控写改回账号级：任意账号（含由别的 target 驱动的）/risk/status 与 /risk/quota 都受理', async () => {
  const { deps, submitted } = makeDeps();
  await withPanel(deps, async (base, auth) => {
    for (const accountId of ['mine', 'theirs', 'orphan']) {
      for (const [path, body] of [
        [`/api/accounts/${accountId}/risk/status`, { kind: 'manual_restrict' }],
        [`/api/accounts/${accountId}/risk/quota`, { level: 'conservative' }],
      ] as const) {
        const res = await fetch(`${base}${path}`, { method: 'POST', headers: auth, body: JSON.stringify(body) });
        // change cloud-coupling-phase5 P5-1：改异步后是 202 受理，不再是 200 写后真态。
        assert.equal(res.status, 202, `${path} MUST 账号级放行、不按归属禁用`);
      }
    }
    assert.ok(submitted.includes('theirs'), '由别的 target 驱动的账号也照常提交（不再拦）');
  });
});

test('账号 DTO 用只读展示字段 currentDriverTarget（服务端权威，dev/ol/null）', async () => {
  const { deps } = makeDeps();
  await withPanel(deps, async (base, auth) => {
    const res = await fetch(`${base}/api/accounts`, { headers: auth });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { accounts: { accountId: string; currentDriverTarget: unknown }[] };
    const byId = Object.fromEntries(body.accounts.map((a) => [a.accountId, a.currentDriverTarget]));
    assert.equal(byId.mine, 'dev');
    assert.equal(byId.theirs, 'ol');
    assert.equal(byId.orphan, null, '从未驱动过 MUST 显示 null，不伪装成当前 target');
    assert.equal('riskWritable' in body.accounts[0], false, '已删的 riskWritable MUST NOT 再出现');
    assert.equal('executionTarget' in body.accounts[0], false, '已改名，旧字段 MUST NOT 再出现');
  });
});

test('首页汇总为所有账号带上限（不再按归属跳过非本 target 驱动的账号）', async () => {
  const { deps, materialized } = makeDeps();
  await withPanel(deps, async (base, auth) => {
    const res = await fetch(`${base}/api/dashboard/summary`, { headers: auth });
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      totalsByAccount: { accountId: string; quotas?: unknown }[];
      accounts: { accountId: string; currentDriverTarget: unknown }[];
    };
    const mine = body.totalsByAccount.find((e) => e.accountId === 'mine');
    const theirs = body.totalsByAccount.find((e) => e.accountId === 'theirs');
    assert.ok(mine?.quotas, '本 target 驱动的账号带上限');
    assert.ok(theirs?.quotas, '由别的 target 驱动的账号同样带上限（物化只为读展示）');
    assert.ok(materialized.includes('theirs'));
    // 账号列表也携带 currentDriverTarget
    assert.equal(body.accounts.find((a) => a.accountId === 'theirs')?.currentDriverTarget, 'ol');
  });
});

test('改归属端点已删：POST /api/accounts/:id/risk-owner → 404', async () => {
  const { deps } = makeDeps();
  await withPanel(deps, async (base, auth) => {
    const res = await fetch(`${base}/api/accounts/theirs/risk-owner`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ target: 'dev' }),
    });
    assert.equal(res.status, 404, '没有「手动改归属」这回事，路由已移除');
  });
});
