/**
 * 面板侧的验收面（change report-host-standby-decisions task 3.2）。
 *
 * 本 change 的验收判据是「**在运营所在的另一处**能看出某台机器上的环境卡住了」，
 * 不是「消息发出去了」。一条只被接收后丢弃的新消息，复刻的正是它要修的那个病：有事实、无人可见。
 *
 * 同时钉死另一条：**读不到 MUST NOT 被呈现成「没有环境卡住」**。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startPanelApi } from '../src/panel/panel-server.js';
import { parsePanelUsers } from '../src/panel/auth.js';
import type { PanelConfig, PanelDeps } from '../src/panel/types.js';
import type { HostStandbyDecisionRecord } from '../src/kernel/host-standby-decision-port.js';

const silentLogger = { log() {}, warn() {}, error() {} };
const now = 1_700_000_000_000;

const baseDeps = {
  edgeServer: { edgeCount: () => 0, onlineEdgeCount: () => 0 },
  eventBus: { onAny: () => () => {} },
  panelStore: {},
  botChatStore: { listActive: async () => [] },
};

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

async function login(base: string): Promise<{ authorization: string }> {
  const r = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'alice', password: 'pw1' }),
  });
  const { token } = (await r.json()) as { token: string };
  return { authorization: `Bearer ${token}` };
}

function stuckRow(): HostStandbyDecisionRecord {
  return {
    edgeId: 'edge-1',
    accountId: 'acct-1',
    machineLabel: 'win-aliyun-3',
    envId: 'env-7',
    verdict: 'refused',
    reason: 'task_lease_active',
    refusedCount: 32,
    refusedSince: Date.now() - 32 * 60_000,
    hintGeneratedAt: now,
    decidedAt: now,
    receivedAt: Date.now() - 5_000,
  };
}

test('host-standby-decisions：运营在面板上看得出「哪台机器的哪个环境卡了多久」', async () => {
  const deps = {
    ...baseDeps,
    hostStandbyDecisions: { listHostStandbyDecisions: async () => [stuckRow()] },
  } as unknown as PanelDeps;
  const h = await startPanelApi(deps, makeConfig());
  const base = `http://127.0.0.1:${h.port}`;
  try {
    const auth = await login(base);
    const r = await fetch(`${base}/api/host-standby-decisions`, { headers: auth });
    assert.equal(r.status, 200);
    const body = (await r.json()) as {
      decisions: Array<Record<string, unknown>>;
      asOf: number;
    };
    assert.equal(body.decisions.length, 1);
    const row = body.decisions[0];
    assert.equal(row.machineLabel, 'win-aliyun-3');
    assert.equal(row.envId, 'env-7');
    assert.equal(row.reason, 'task_lease_active');
    assert.equal(row.refusedCount, 32);
    assert.equal(row.stuck, true, '连续拒绝必须一眼可辨，别和「刚好拒了一次」长得一样');
    assert.ok((row.refusedForMs as number) >= 32 * 60_000, '卡了多久必须读得出来');
    assert.ok((row.ageMs as number) >= 0 && (row.ageMs as number) < 60_000, '陈旧度按云端收下的时刻算');
  } finally {
    await h.close();
  }
});

test('host-standby-decisions：单次拒绝不算卡住（单次是正常运行的一部分）', async () => {
  const deps = {
    ...baseDeps,
    hostStandbyDecisions: {
      listHostStandbyDecisions: async () => [
        { ...stuckRow(), refusedCount: 1 },
        { ...stuckRow(), edgeId: 'edge-2', verdict: 'yielded' as const, reason: 'ok', refusedCount: 0, refusedSince: null },
      ],
    },
  } as unknown as PanelDeps;
  const h = await startPanelApi(deps, makeConfig());
  const base = `http://127.0.0.1:${h.port}`;
  try {
    const auth = await login(base);
    const body = (await (await fetch(`${base}/api/host-standby-decisions`, { headers: auth })).json()) as {
      decisions: Array<{ stuck: boolean; refusedForMs: number | null }>;
    };
    assert.deepEqual(body.decisions.map((d) => d.stuck), [false, false]);
    assert.equal(body.decisions[1].refusedForMs, null, '让位那条不得携带连续拒绝时长');
  } finally {
    await h.close();
  }
});

test('host-standby-decisions：读不到时回 503，MUST NOT 用空列表冒充「没有环境卡住」', async () => {
  const h = await startPanelApi(baseDeps as unknown as PanelDeps, makeConfig());
  const base = `http://127.0.0.1:${h.port}`;
  try {
    const auth = await login(base);
    const r = await fetch(`${base}/api/host-standby-decisions`, { headers: auth });
    assert.equal(r.status, 503);
    assert.equal((await r.json() as { error: string }).error, 'host_standby_decisions_unavailable');
  } finally {
    await h.close();
  }
});

test('host-standby-decisions：只有读，没有任何写侧对应物（可见性不是否决权）', async () => {
  const deps = {
    ...baseDeps,
    hostStandbyDecisions: { listHostStandbyDecisions: async () => [stuckRow()] },
  } as unknown as PanelDeps;
  const h = await startPanelApi(deps, makeConfig());
  const base = `http://127.0.0.1:${h.port}`;
  try {
    const auth = await login(base);
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      const r = await fetch(`${base}/api/host-standby-decisions`, { method, headers: auth });
      assert.notEqual(r.status, 200, `${method} 不得存在——云端 MUST NOT 下发强制让位 / 禁止让位`);
    }
  } finally {
    await h.close();
  }
});
