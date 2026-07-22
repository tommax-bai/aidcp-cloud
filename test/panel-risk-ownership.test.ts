/**
 * 面板风控写口的归属闸（change risk-state-cross-process-integrity，task 7.4）。
 *
 * 守的是 design D7 那两句：非属主 MUST 返回可区分拒绝（409 + 真实归属），
 * MUST NOT 返回 200、MUST NOT 返回一个看起来成功的 `changed:false`；
 * 首页汇总对非属主账号 MUST NOT 物化可写 controller。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startPanelApi } from '../src/panel/panel-server.js';
import { parsePanelUsers } from '../src/panel/auth.js';
import { RiskController } from '../src/risk/risk-controller.js';
import type { PanelConfig, PanelDeps } from '../src/panel/types.js';

const silentLogger = { log() {}, warn() {}, error() {} };

function account(accountId: string, executionTarget: 'dev' | 'ol' | null) {
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
    executionTarget,
    riskWritable: executionTarget === 'dev',
    riskStatus: 'normal' as const,
    riskQuotaLevel: 'normal' as const,
    signalCount: 0,
    personaBound: true,
    needsPersonaSetup: false,
  };
}

function makeDeps(over: Partial<Record<string, unknown>> = {}) {
  const materialized: string[] = [];
  const owners: Record<string, 'dev' | 'ol' | null> = { mine: 'dev', theirs: 'ol', orphan: null };
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
    publishOrchestrator: { getStatus: () => ({ status: 'idle', snapshot: null }) },
    commandActions: {},
    riskRegistry: {
      getController: async (id: string) => {
        materialized.push(id);
        return new RiskController({ accountId: id });
      },
    },
    riskOwnership: {
      executionTarget: 'dev' as const,
      mode: 'enforce' as const,
      ownerOf: async (accountId: string) => owners[accountId] ?? null,
      changeOwner: async () => ({ ok: false as const, reason: 'blocked_by_active_session' as const, owner: 'ol' as const }),
    },
    ...over,
  } as unknown as PanelDeps;
  return { deps, materialized };
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

// 注：change 文档里称这条口为 `/risk/signal`，代码里的真实路径是 `/risk/status`（写的是风控信号）。
// 以代码为准。
test('非属主账号的 /risk/status 与 /risk/quota 返回 409 + 真实归属，绝不 200', async () => {
  const { deps, materialized } = makeDeps();
  await withPanel(deps, async (base, auth) => {
    for (const [path, body] of [
      ['/api/accounts/theirs/risk/status', { kind: 'manual_restrict' }],
      ['/api/accounts/theirs/risk/quota', { level: 'conservative' }],
    ] as const) {
      const res = await fetch(`${base}${path}`, { method: 'POST', headers: auth, body: JSON.stringify(body) });
      assert.equal(res.status, 409, path);
      const payload = (await res.json()) as Record<string, unknown>;
      assert.equal(payload.error, 'risk_state_not_owned');
      assert.equal(payload.owner, 'ol', '拒绝里 MUST 带真实归属，否则运营不知道该去哪');
      assert.equal(payload.executionTarget, 'dev');
      assert.equal('changed' in payload, false, 'MUST NOT 返回看起来成功的 changed:false');
    }
    assert.equal(materialized.includes('theirs'), false, '非属主 MUST NOT 物化可写 controller');
  });
});

test('属主账号的写口照常放行（归属闸不误伤本 target）', async () => {
  const { deps } = makeDeps();
  await withPanel(deps, async (base, auth) => {
    const res = await fetch(`${base}/api/accounts/mine/risk/quota`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ level: 'conservative' }),
    });
    assert.equal(res.status, 200);
  });
});

test('未归属账号也被拒，且说明与「归属别人」可区分', async () => {
  const { deps } = makeDeps();
  await withPanel(deps, async (base, auth) => {
    const res = await fetch(`${base}/api/accounts/orphan/risk/status`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ kind: 'manual_restrict' }),
    });
    assert.equal(res.status, 409);
    const payload = (await res.json()) as Record<string, unknown>;
    assert.equal(payload.owner, null);
    assert.match(String(payload.message), /尚未归属/);
  });
});

test('首页汇总只为属主账号带上限，非属主保持「不带上限」的诚实缺省', async () => {
  const { deps, materialized } = makeDeps();
  await withPanel(deps, async (base, auth) => {
    const res = await fetch(`${base}/api/dashboard/summary`, { headers: auth });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { totalsByAccount: { accountId: string; quotas?: unknown }[] };
    const mine = body.totalsByAccount.find((e) => e.accountId === 'mine');
    const theirs = body.totalsByAccount.find((e) => e.accountId === 'theirs');
    assert.ok(mine?.quotas, '属主账号照常带上限');
    assert.equal(theirs?.quotas, undefined, '非属主账号不带上限（前端只显数字）');
    assert.equal(materialized.includes('theirs'), false);
  });
});

test('改归属：旧属主仍有活跃会话 → 409 owner_change_blocked_by_active_session，绝不强改', async () => {
  const { deps } = makeDeps();
  await withPanel(deps, async (base, auth) => {
    const res = await fetch(`${base}/api/accounts/theirs/risk-owner`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ target: 'dev' }),
    });
    assert.equal(res.status, 409);
    const payload = (await res.json()) as Record<string, unknown>;
    assert.equal(payload.error, 'owner_change_blocked_by_active_session');
    assert.equal(payload.owner, 'ol');
  });
});

test('归属闸未注入 → 全部写口行为与改动前逐位一致', async () => {
  const { deps } = makeDeps({ riskOwnership: undefined });
  await withPanel(deps, async (base, auth) => {
    const res = await fetch(`${base}/api/accounts/theirs/risk/quota`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ level: 'conservative' }),
    });
    assert.equal(res.status, 200);
  });
});
