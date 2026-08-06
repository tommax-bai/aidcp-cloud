import { test } from 'node:test';
import assert from 'node:assert/strict';
import { InternalHttpClient, InternalHttpServer } from '@automation/transport/internal-http.js';
import {
  RISK_READ_ROUTES,
  RiskReadHttpClient,
  registerRiskReadRoutes,
} from '@automation/transport/risk-read-http.js';
import type {
  RiskReadPort,
  RiskStateView,
  WindowQuotasView,
  SlowStartViewData,
} from '@kernel/kernel/risk-read-types.js';

function sampleState(accountId: string): RiskStateView {
  return {
    accountId,
    status: 'warned',
    quotaLevel: 'normal',
    signalCount: 2,
    lastSignalAt: 1_700_000_000_000,
    statusSince: 1_699_000_000_000,
    updatedAt: 1_700_000_500_000,
  };
}

function sampleQuotas(): WindowQuotasView {
  const acts = {
    like: 1,
    collect: 1,
    comment: 1,
    follow: 1,
    publish: 1,
    view: 1,
    search: 1,
    comment_like: 1,
    join_group: 1,
    dm_reply: 1,
  };
  return { minute: { ...acts }, hour: { ...acts }, day: { ...acts, view: 20 } };
}

function sampleSlowStart(): SlowStartViewData {
  return { state: 'active', day: 3, totalDays: 7, since: 1_699_000_000_000, binding: true, eligible: true };
}

/** 捕获入参的本地端口桩，结构上满足只读 RiskReadPort。 */
function stubPort(seen: { calls: unknown[] }): RiskReadPort {
  return {
    getState: async (accountId) => {
      seen.calls.push({ m: 'getState', accountId });
      return sampleState(accountId);
    },
    effectiveQuotas: async (accountId) => {
      seen.calls.push({ m: 'effectiveQuotas', accountId });
      return sampleQuotas();
    },
    slowStartView: async (accountId) => {
      seen.calls.push({ m: 'slowStartView', accountId });
      return sampleSlowStart();
    },
  };
}

async function withPortServer(
  run: (port: RiskReadPort, seen: { calls: unknown[] }) => Promise<void>,
): Promise<void> {
  const seen = { calls: [] as unknown[] };
  const server = new InternalHttpServer();
  registerRiskReadRoutes(server, stubPort(seen));
  const listenPort = await server.listen(0);
  const client: RiskReadPort = new RiskReadHttpClient(
    new InternalHttpClient(`http://127.0.0.1:${listenPort}`),
  );
  try {
    await run(client, seen);
  } finally {
    await server.close();
  }
}

test('RiskReadHttpClient 满足 kernel 只读端口形状（方法齐全，无写方法）', async () => {
  await withPortServer(async (port) => {
    for (const m of ['getState', 'effectiveQuotas', 'slowStartView'] as const) {
      assert.equal(typeof port[m], 'function', `missing method: ${m}`);
    }
    // 只读端口绝不带写方法：结构上不该冒出任何风控写口。
    for (const w of ['applySignal', 'recoverRestricted', 'setQuotaLevel', 'record'] as const) {
      assert.equal((port as unknown as Record<string, unknown>)[w], undefined, `unexpected write method: ${w}`);
    }
  });
});

test('getState：accountId 原样送达，回状态快照', async () => {
  await withPortServer(async (port, seen) => {
    const out = await port.getState('acc-7');
    assert.equal(out.accountId, 'acc-7');
    assert.equal(out.status, 'warned');
    assert.equal(out.quotaLevel, 'normal');
    assert.deepEqual(seen.calls[0], { m: 'getState', accountId: 'acc-7' });
  });
});

test('effectiveQuotas：accountId 送达，回三窗口配额结构', async () => {
  await withPortServer(async (port, seen) => {
    const out = await port.effectiveQuotas('acc-3');
    assert.equal(out.day.view, 20);
    assert.equal(out.minute.like, 1);
    assert.deepEqual(seen.calls[0], { m: 'effectiveQuotas', accountId: 'acc-3' });
  });
});

test('slowStartView：accountId 送达，回慢启动投影', async () => {
  await withPortServer(async (port, seen) => {
    const out = await port.slowStartView('acc-5');
    assert.equal(out.state, 'active');
    assert.equal(out.day, 3);
    assert.equal(out.binding, true);
    assert.deepEqual(seen.calls[0], { m: 'slowStartView', accountId: 'acc-5' });
  });
});

test('路由名两侧共用同一常量（防漂移）', () => {
  assert.equal(RISK_READ_ROUTES.getState, 'risk-read/get-state');
  assert.equal(RISK_READ_ROUTES.effectiveQuotas, 'risk-read/effective-quotas');
  assert.equal(RISK_READ_ROUTES.slowStartView, 'risk-read/slow-start-view');
});
