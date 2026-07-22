/**
 * 账号归属 target 与非属主诚实拒绝（change risk-state-cross-process-integrity，tasks 3.5 / 4.5）。
 *
 * **测得到的**：条件写 0 行之后的分支（enforce 抛 / observe 告警后按历史语义写）、注册表的驱逐与
 * 驱逐后从库重读、握手闸的三态（占位 / 放行 / 拒绝）、观察模式不拒绝但留告警。
 *
 * **测不到的**（真机验收项）：属主谓词那条 SQL 在真 PostgreSQL 上的行为——「非属主写影响 0 行」
 * 是数据库给的保证，用桩断言它只是在断言我自己写的桩。见 change 的真机项。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PgRiskStore } from '../src/risk/pg-risk-store.js';
import { RiskControllerRegistry } from '../src/risk/risk-controller-registry.js';
import { RiskStateNotOwnedError } from '../src/risk/ownership.js';
import { ConnectionRuntimeRegistry } from '../src/orchestrator/connection-runtime.js';
import type { EdgeSession } from '../src/comm/ws-server.js';
import type { RiskState, RiskStore } from '../src/risk/types.js';

const silent = { log() {}, warn() {}, error() {} };

function stateOf(accountId: string, status: RiskState['status']): RiskState {
  return {
    accountId,
    status,
    quotaLevel: 'normal',
    signalCount: 0,
    lastSignalAt: null,
    statusSince: 0,
    updatedAt: 0,
  };
}

// ── PgRiskStore.saveState 的 0 行分支 ─────────────────────────────────────────

/** 只回答两种查询：条件写（rowCount 由用例给）与归属回读。 */
function fakePool(opts: { conditionalRowCount: number; owner: string | null; accountExists?: boolean }) {
  const queries: string[] = [];
  return {
    queries,
    pool: {
      query: async (sql: string) => {
        queries.push(sql);
        if (sql.includes('WITH owner AS')) return { rowCount: opts.conditionalRowCount, rows: [] };
        if (sql.startsWith('SELECT execution_target')) {
          return opts.accountExists === false
            ? { rowCount: 0, rows: [] }
            : { rowCount: 1, rows: [{ execution_target: opts.owner }] };
        }
        return { rowCount: 1, rows: [] };
      },
    } as never,
  };
}

test('enforce：条件写 0 行 → 抛 RiskStateNotOwnedError，且三种原因可区分', async () => {
  for (const [scenario, opts, cause, owner] of [
    ['归属是别人', { conditionalRowCount: 0, owner: 'ol' }, 'owned_by_other', 'ol'],
    ['归属为空', { conditionalRowCount: 0, owner: null }, 'unowned', null],
    ['账号不存在', { conditionalRowCount: 0, owner: null, accountExists: false }, 'account_not_found', undefined],
  ] as const) {
    const { pool } = fakePool(opts);
    const store = new PgRiskStore({ pool, executionTarget: 'dev', ownershipMode: 'enforce' });
    await assert.rejects(
      () => store.saveState(stateOf('acc-1', 'normal')),
      (err: unknown) => {
        assert.ok(err instanceof RiskStateNotOwnedError, scenario);
        assert.equal(err.code, 'risk_state_not_owned');
        assert.equal(err.cause2, cause, scenario);
        assert.equal(err.actualTarget, owner, scenario);
        assert.equal(err.expectedTarget, 'dev');
        return true;
      },
    );
  }
});

test('enforce：条件写 0 行后 MUST NOT 再来一次无谓词写（绝不换谓词绕过）', async () => {
  const { pool, queries } = fakePool({ conditionalRowCount: 0, owner: 'ol' });
  const store = new PgRiskStore({ pool, executionTarget: 'dev', ownershipMode: 'enforce' });
  await assert.rejects(() => store.saveState(stateOf('acc-1', 'normal')));
  assert.equal(
    queries.filter((q) => q.includes('INSERT INTO risk_state') && !q.includes('WITH owner AS')).length,
    0,
    '被拒之后不得回落到历史无谓词 upsert——那正是「后写方盖回先写方」的原路',
  );
});

test('observe：0 行不拒绝，但每一次都留告警（观察模式 MUST NOT 静默）', async () => {
  const { pool, queries } = fakePool({ conditionalRowCount: 0, owner: 'ol' });
  const seen: unknown[] = [];
  const store = new PgRiskStore({
    pool,
    executionTarget: 'dev',
    ownershipMode: 'observe',
    onOwnershipViolation: (info) => seen.push(info),
  });
  await store.saveState(stateOf('acc-1', 'normal'));
  assert.equal(seen.length, 1);
  assert.deepEqual(seen[0], {
    accountId: 'acc-1',
    writerTarget: 'dev',
    ownerTarget: 'ol',
    cause: 'owned_by_other',
  });
  assert.equal(
    queries.filter((q) => q.includes('INSERT INTO risk_state') && !q.includes('WITH owner AS')).length,
    1,
    '观察阶段行为与改动前逐位一致：照写，但留痕',
  );
});

test('未配置 executionTarget → 归属模式恒 off，走历史无谓词 upsert（零回归）', async () => {
  const { pool, queries } = fakePool({ conditionalRowCount: 1, owner: null });
  const store = new PgRiskStore({ pool, ownershipMode: 'enforce' });
  assert.deepEqual(store.ownership(), { mode: 'off', target: null });
  await store.saveState(stateOf('acc-1', 'normal'));
  assert.equal(queries.filter((q) => q.includes('WITH owner AS')).length, 0);
});

// ── 注册表：非属主拒绝、驱逐、驱逐后从库重读 ───────────────────────────────────

class MemoryRiskStore implements RiskStore {
  states = new Map<string, RiskState>();
  counters: { accountId: string; action: string; occurredAt: number; count: number }[] = [];
  async loadCounters(accountId: string) {
    return this.counters
      .filter((c) => c.accountId === accountId)
      .map((c) => ({ action: c.action as never, occurredAt: c.occurredAt, count: c.count }));
  }
  async appendCounter() {}
  async loadState(accountId: string) {
    return this.states.get(accountId) ?? null;
  }
  async saveState(state: RiskState) {
    this.states.set(state.accountId, { ...state });
  }
}

function registryWith(owner: 'dev' | 'ol' | null, mode: 'enforce' | 'observe', store = new MemoryRiskStore()) {
  const alerts: { kind: string; accountId: string }[] = [];
  const registry = new RiskControllerRegistry(store, undefined, undefined, {
    executionTarget: 'dev',
    ownershipMode: mode,
    ownershipPort: {
      getExecutionTarget: async () => owner,
      claimExecutionTarget: async () => ({ outcome: 'claimed', target: 'dev' }),
    },
    onOwnershipAlert: (info) => alerts.push({ kind: info.kind, accountId: info.accountId }),
    logger: silent,
  });
  return { registry, alerts, store };
}

test('enforce：非属主账号取不到可写 controller，且不物化', async () => {
  const { registry, alerts } = registryWith('ol', 'enforce');
  await assert.rejects(() => registry.getWritableController('acc-1'), RiskStateNotOwnedError);
  assert.deepEqual(registry.materializedAccountIds(), [], '非属主 MUST NOT 物化可写 controller');
  assert.equal(alerts.length, 1);
});

test('observe：非属主不拒绝但留告警（占位与观察期行为）', async () => {
  const { registry, alerts } = registryWith('ol', 'observe');
  const controller = await registry.getWritableController('acc-1');
  assert.ok(controller);
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].kind, 'read_only_denied');
});

test('记账口刻意不过归属闸：飞在半路的回执照样记进同一本账', async () => {
  const { registry } = registryWith('ol', 'enforce');
  const controller = await registry.getControllerForAccounting('acc-1');
  assert.ok(controller, 'risk_counters 是既成事实账本，不按 target 分裂写权');
});

test('写被拒 → 驱逐缓存 + 告警；下次解析从库重读到另一 target 写下的 restricted', async () => {
  const store = new MemoryRiskStore();
  store.states.set('acc-1', stateOf('acc-1', 'normal'));
  const { registry, alerts } = registryWith('dev', 'enforce', store);

  const before = await registry.getWritableController('acc-1');
  assert.equal(before.getState().status, 'normal');

  // 另一个 target 把它写成了 restricted；本进程手上那份内存快照已经过时。
  store.states.set('acc-1', stateOf('acc-1', 'restricted'));
  assert.equal(before.getState().status, 'normal', '内存快照不会自己更新——这正是缺陷的形状');

  const handled = registry.handleNotOwned(
    new RiskStateNotOwnedError('acc-1', 'dev', 'ol', 'owned_by_other'),
  );
  assert.equal(handled, true);
  assert.deepEqual(registry.materializedAccountIds(), [], '被拒 MUST 驱逐，MUST NOT 重试覆盖');
  assert.equal(alerts.at(-1)?.kind, 'evicted_not_owned');

  const after = await registry.getWritableController('acc-1');
  assert.equal(after.getState().status, 'restricted', '重建 MUST 从库读最新，绝不复用陈旧内存态');
});

test('handleNotOwned 只认自己的错误类型，别的错误不吞', () => {
  const { registry } = registryWith('dev', 'enforce');
  assert.equal(registry.handleNotOwned(new Error('pg down')), false);
});

// ── 握手闸 ────────────────────────────────────────────────────────────────────

function handshakeSession(accountId: string): EdgeSession {
  return { sessionId: 's1', edgeId: 'e1', accountId, platform: 'xiaohongshu' } as unknown as EdgeSession;
}

function runtimeRegistry(opts: {
  owner: 'dev' | 'ol' | null;
  mode: 'enforce' | 'observe';
  claimed?: { outcome: 'claimed'; target: 'dev' } | { outcome: 'already_owned_by'; target: 'ol' };
}) {
  const configErrors: string[] = [];
  const events: { kind: string; accountId: string }[] = [];
  const claims: string[] = [];
  const replayed: string[] = [];
  const registry = new ConnectionRuntimeRegistry({
    observerBus: { onAny: () => () => undefined, emitRaw: () => undefined } as never,
    getController: async () => ({}) as never,
    buildDispatcher: () => ({}) as never,
    ensureAccount: async () => undefined,
    getAccountPlatform: async () => 'xiaohongshu',
    onConfigError: (_session, message) => {
      configErrors.push(message);
    },
    closeEdge: () => undefined,
    logger: silent,
    ownership: {
      executionTarget: 'dev',
      mode: opts.mode,
      port: {
        getExecutionTarget: async () => opts.owner,
        claimExecutionTarget: async (accountId) => {
          claims.push(accountId);
          return opts.claimed ?? { outcome: 'claimed', target: 'dev' };
        },
      },
      onEvent: (info) => events.push({ kind: info.kind, accountId: info.accountId }),
      onClaimed: async (accountId) => {
        replayed.push(accountId);
      },
    },
  });
  return { registry, configErrors, events, claims, replayed };
}

test('未归属账号首次真实握手 → 原子占位 + 强制重放计数', async () => {
  const h = runtimeRegistry({ owner: null, mode: 'enforce' });
  const outcome = await h.registry.onHandshake(handshakeSession('acc-1'));
  assert.deepEqual(outcome, { ok: true });
  assert.deepEqual(h.claims, ['acc-1']);
  assert.deepEqual(h.replayed, ['acc-1'], '占位成功 MUST 重放，绝不复用可能陈旧的内存计数');
  assert.equal(h.events.at(-1)?.kind, 'claimed');
});

test('占位竞争落败方观察到已被占位并被拒（enforce），绝不覆盖', async () => {
  const h = runtimeRegistry({
    owner: null,
    mode: 'enforce',
    claimed: { outcome: 'already_owned_by', target: 'ol' },
  });
  const outcome = await h.registry.onHandshake(handshakeSession('acc-1'));
  assert.equal(outcome.ok, false);
  assert.equal(outcome.ok === false && outcome.code, 'execution_target_mismatch');
  assert.deepEqual(h.replayed, [], '没占到就不该重放——重放会把别人的账当成自己的起点');
});

test('归属对方 target → 拒绝码 execution_target_mismatch，说明里带真实归属与处理办法', async () => {
  const h = runtimeRegistry({ owner: 'ol', mode: 'enforce' });
  const outcome = await h.registry.onHandshake(handshakeSession('acc-1'));
  assert.equal(outcome.ok, false);
  assert.equal(outcome.ok === false && outcome.code, 'execution_target_mismatch');
  assert.match(outcome.ok === false ? outcome.message : '', /归属 ol/);
  assert.match(outcome.ok === false ? outcome.message : '', /改风控归属/);
  assert.equal(h.configErrors.length, 1, 'MUST 走既有 onConfigError 通道，与 platform_mismatch 同形');
  assert.equal(h.events.at(-1)?.kind, 'mismatch_rejected');
});

test('观察模式：本会被拒的握手照样放行，但 MUST 留一条可检索告警', async () => {
  const h = runtimeRegistry({ owner: 'ol', mode: 'observe' });
  const outcome = await h.registry.onHandshake(handshakeSession('acc-1'));
  assert.deepEqual(outcome, { ok: true });
  assert.equal(h.configErrors.length, 0);
  assert.equal(h.events.at(-1)?.kind, 'mismatch_observed', '观察模式 MUST NOT 静默');
});
