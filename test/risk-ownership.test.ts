/**
 * 归属跟随当次连接（change risk-target-follows-active-session）。
 *
 * 语义：accounts.execution_target 每次握手更新为当前接入的 target；同一账号分时接入 dev / ol 是正常的。
 *
 * **测得到的**：握手把归属改写为本 target、切换时重放计数、归属没变时不重放、条件写在并发接管瞬间
 * 作废先写方（rowCount=0 → 抛 + 驱逐 + 从库重读）。
 *
 * **测不到的**（真机验收项）：属主谓词那条 SQL 在真 PostgreSQL 上「另一连接接管后先写方影响 0 行」的
 * 行为——那是数据库给的保证，用桩断言它只是在断言我自己写的桩。见 change 的真机项。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PgRiskStore } from '../src/risk/pg-risk-store.js';
import { RiskControllerRegistry } from '../src/risk/risk-controller-registry.js';
import { RiskStateNotOwnedError } from '../src/risk/ownership.js';
import { ConnectionRuntimeRegistry } from '../src/orchestrator/connection-runtime.js';
import type { EdgeSession } from '../src/comm/ws-server.js';
import type { SchemaEnsurer } from '../src/kernel/schema-capability-contract.js';
import type { RiskState, RiskStore } from '../src/risk/types.js';

const silent = { log() {}, warn() {}, error() {} };
const readySchemaEnsurer: SchemaEnsurer = async () => 'ready';

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

// ── PgRiskStore.saveState 的属主谓词：先经端口问归属，命中才在本域内写 ──────────────
//
// change risk-ownership-via-port：原先是一条 join `accounts` 的单语句条件写。`accounts` 属 api 域，
// 物理拆库后 automation 库里没有它 ⇒ dev / ol 上 saveState 全数报 relation "accounts" does not exist。
// 现在属主谓词经 AccountOwnershipPort 的三态读取值，写回到本域内的无谓词 upsert。

/** 本域池：只认 risk_state 的写。**任何提到 accounts 的 SQL 都当场炸**——那正是要根除的形态。 */
function fakePool() {
  const queries: string[] = [];
  return {
    queries,
    pool: {
      query: async (sql: string) => {
        queries.push(sql);
        if (/\baccounts\b/.test(sql)) {
          // 拆库后 automation 库里真的没有这张表，PG 就是这么报的。桩逐字复刻，防回归。
          throw new Error('relation "accounts" does not exist');
        }
        return { rowCount: 1, rows: [] };
      },
    } as never,
  };
}

/** 归属读口的桩：三态照实回答，并记录被问了几次。 */
function fakeOwnershipReader(resolution: { outcome: 'owned'; target: 'dev' | 'ol' } | { outcome: 'unowned' } | { outcome: 'account_not_found' }) {
  const asked: string[] = [];
  return {
    asked,
    reader: {
      resolveExecutionTarget: async (accountId: string) => {
        asked.push(accountId);
        return resolution;
      },
    },
  };
}

test('归属命中 → 本域内一次 upsert；**全程不对本域池发任何 accounts 查询**', async () => {
  const { pool, queries } = fakePool();
  const { reader, asked } = fakeOwnershipReader({ outcome: 'owned', target: 'dev' });
  const store = new PgRiskStore({
    pool,
    schemaEnsurer: readySchemaEnsurer,
    executionTarget: 'dev',
    ownershipReader: reader,
  });
  await store.saveState(stateOf('acc-1', 'restricted'));
  assert.deepEqual(asked, ['acc-1'], '属主谓词经端口取值，问且只问一次');
  assert.equal(queries.filter((q) => q.includes('INSERT INTO risk_state')).length, 1, '本域内写且只写一次');
  assert.equal(queries.filter((q) => /\baccounts\b/.test(q)).length, 0, '绝不在 automation 池上碰 api 属主表');
});

test('归属不是本进程 → 抛 RiskStateNotOwnedError，三种原因可区分', async () => {
  for (const [scenario, resolution, cause, owner] of [
    ['已被别的 target 接管', { outcome: 'owned', target: 'ol' }, 'owned_by_other', 'ol'],
    ['归属被清空', { outcome: 'unowned' }, 'unowned', null],
    ['账号不存在', { outcome: 'account_not_found' }, 'account_not_found', undefined],
  ] as const) {
    const { pool } = fakePool();
    const { reader } = fakeOwnershipReader(resolution);
    const store = new PgRiskStore({
      pool,
      schemaEnsurer: readySchemaEnsurer,
      executionTarget: 'dev',
      ownershipReader: reader,
    });
    await assert.rejects(
      () => store.saveState(stateOf('acc-1', 'normal')),
      (err: unknown) => {
        assert.ok(err instanceof RiskStateNotOwnedError, scenario);
        assert.equal(err.cause2, cause, scenario);
        assert.equal(err.actualTarget, owner, scenario);
        assert.equal(err.expectedTarget, 'dev');
        return true;
      },
    );
  }
});

test('被接管后 MUST NOT 回落无谓词写——那正是「先写方盖回接管方」的原路', async () => {
  const { pool, queries } = fakePool();
  const { reader } = fakeOwnershipReader({ outcome: 'owned', target: 'ol' });
  const store = new PgRiskStore({
    pool,
    schemaEnsurer: readySchemaEnsurer,
    executionTarget: 'dev',
    ownershipReader: reader,
  });
  await assert.rejects(() => store.saveState(stateOf('acc-1', 'normal')));
  assert.equal(
    queries.filter((q) => q.includes('INSERT INTO risk_state')).length,
    0,
    '作废先写方即作废，绝不回落到历史无谓词 upsert',
  );
});

test('未配置 executionTarget → 归属模式恒 off，走历史无谓词 upsert（回滚/零回归）', async () => {
  const { pool, queries } = fakePool();
  const store = new PgRiskStore({ pool, schemaEnsurer: readySchemaEnsurer });
  assert.deepEqual(store.ownership(), { mode: 'off', target: null });
  await store.saveState(stateOf('acc-1', 'normal'));
  assert.equal(queries.filter((q) => q.includes('INSERT INTO risk_state')).length, 1);
});

test('有 target 但未注入归属读口 → 降级为 off 并响亮告警（MUST NOT 静默）', async () => {
  const { pool, queries } = fakePool();
  const warnings: string[] = [];
  const realWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map(String).join(' '));
  };
  try {
    const store = new PgRiskStore({ pool, schemaEnsurer: readySchemaEnsurer, executionTarget: 'dev' });
    assert.deepEqual(store.ownership(), { mode: 'off', target: 'dev' }, '缺读口即降级，绝不假装 enforce');
    await store.saveState(stateOf('acc-1', 'normal'));
    assert.equal(queries.filter((q) => q.includes('INSERT INTO risk_state')).length, 1, '降级后状态照常持久化');
  } finally {
    console.warn = realWarn;
  }
  assert.equal(warnings.filter((w) => w.includes('ownershipReader')).length, 1, '降级必须留下可检索的告警');
});

// ── 注册表：物化、驱逐、驱逐后从库重读 ─────────────────────────────────────────

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

function registryWith(store = new MemoryRiskStore()) {
  const alerts: { kind: string; accountId: string }[] = [];
  const registry = new RiskControllerRegistry(store, undefined, undefined, {
    executionTarget: 'dev',
    onOwnershipAlert: (info) => alerts.push({ kind: info.kind, accountId: info.accountId }),
    logger: silent,
  });
  return { registry, alerts, store };
}

test('归属跟随连接后：可写 controller 直接物化，不再有「非属主拒绝」这道闸', async () => {
  const { registry } = registryWith();
  const controller = await registry.getWritableController('acc-1');
  assert.ok(controller);
  assert.deepEqual(registry.materializedAccountIds(), ['acc-1']);
});

test('controller 创建失败后驱逐 rejected Promise，下一次真实请求可重新物化', async () => {
  class FlakyInitStore extends MemoryRiskStore {
    initCalls = 0;

    async init(): Promise<void> {
      this.initCalls += 1;
      if (this.initCalls === 1) throw new Error('schema probe interrupted');
    }
  }

  const store = new FlakyInitStore();
  const { registry } = registryWith(store);
  await assert.rejects(() => registry.getWritableController('acc-1'), /schema probe interrupted/);
  assert.deepEqual(registry.materializedAccountIds(), [], 'rejected Promise MUST NOT 留在账号缓存');

  const controller = await registry.getWritableController('acc-1');
  assert.ok(controller);
  assert.equal(store.initCalls, 2);
  assert.deepEqual(registry.materializedAccountIds(), ['acc-1']);
});

test('记账口照常物化：飞在半路的回执照样记进同一本账（append-only 不按 target 分裂）', async () => {
  const { registry } = registryWith();
  const controller = await registry.getControllerForAccounting('acc-1');
  assert.ok(controller);
});

test('并发接管致条件写被拒 → 驱逐缓存 + 告警；下次解析从库重读接管方写下的 restricted', async () => {
  const store = new MemoryRiskStore();
  store.states.set('acc-1', stateOf('acc-1', 'normal'));
  const { registry, alerts } = registryWith(store);

  const before = await registry.getWritableController('acc-1');
  assert.equal(before.getState().status, 'normal');

  // 另一个连接接管后把它写成了 restricted；本进程手上那份内存快照已经过时。
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

test('跨 target 切换（onClaimed 路径）MUST 驱逐缓存：陈旧 normal 不得盖回接管方写下的 restricted', async () => {
  const store = new MemoryRiskStore();
  store.states.set('acc-1', stateOf('acc-1', 'normal'));
  const { registry } = registryWith(store);

  // 本进程此前为 acc-1 物化过 controller（面板汇总删了属主跳过后，会为每个账号物化），缓存 status=normal。
  const cached = await registry.getWritableController('acc-1');
  assert.equal(cached.getState().status, 'normal');

  // 另一个 target 驱动 acc-1，把它写成 restricted；本进程内存快照仍是 normal。
  store.states.set('acc-1', stateOf('acc-1', 'restricted'));
  assert.equal(cached.getState().status, 'normal', '内存快照不自更新——只 reloadCounters 会把它留着');

  // acc-1 的边缘切回本 target → onClaimed 的实际动作 MUST 是 evict（不是 peek+reloadCounters）。
  // 切换后归属已是本 target、条件写谓词会通过，handleNotOwned 那道最后闸不再触发，只能靠这里主动驱逐。
  assert.equal(registry.evict('acc-1'), true);
  assert.deepEqual(registry.materializedAccountIds(), [], '切换 MUST 驱逐陈旧缓存');

  // 下次物化从库重读，拿到接管方写下的 restricted，绝不用陈旧 normal 覆盖。
  const fresh = await registry.getWritableController('acc-1');
  assert.equal(fresh.getState().status, 'restricted', '切换后 state MUST 从库刷新，绝不复用陈旧内存态');
});

test('handleNotOwned 只认自己的错误类型，别的错误不吞', () => {
  const { registry } = registryWith();
  assert.equal(registry.handleNotOwned(new Error('pg down')), false);
});

test('条件写被库拒 → 由 controller 自己触发驱逐 + 告警（MUST NOT 指望调用侧逐处 catch）', async () => {
  // 走真实链路：store.saveState 抛（并发接管）→ controller.persistState → onStateWriteRejected → registry。
  const store = new MemoryRiskStore();
  store.states.set('acc-1', stateOf('acc-1', 'normal'));
  const rejecting = {
    ...store,
    loadCounters: (id: string) => store.loadCounters(id),
    appendCounter: () => store.appendCounter(),
    loadState: (id: string) => store.loadState(id),
    saveState: async () => {
      throw new RiskStateNotOwnedError('acc-1', 'dev', 'ol', 'owned_by_other');
    },
  } as unknown as RiskStore;
  const { registry, alerts } = registryWith(rejecting as never);

  const controller = await registry.getWritableController('acc-1');
  assert.deepEqual(registry.materializedAccountIds(), ['acc-1']);

  await assert.rejects(
    () => controller.applySignal({ kind: 'platform_warning', at: 1_000 } as never),
    RiskStateNotOwnedError,
    '写失败 MUST 照常抛给发起方，绝不吞成成功',
  );

  assert.deepEqual(registry.materializedAccountIds(), [], '被拒 MUST 驱逐本地缓存 controller');
  assert.equal(alerts.at(-1)?.kind, 'evicted_not_owned', '被拒 MUST 出 P1 告警，不能只剩一行日志');
});

// ── 握手：归属跟随当次连接 ──────────────────────────────────────────────────────

function handshakeSession(accountId: string): EdgeSession {
  return { sessionId: 's1', edgeId: 'e1', accountId, platform: 'xiaohongshu' } as unknown as EdgeSession;
}

function runtimeRegistry(opts: {
  owner: 'dev' | 'ol' | null;
  setResult?: { outcome: 'claimed'; target: 'dev' } | { outcome: 'account_not_found' };
}) {
  const configErrors: string[] = [];
  const events: { kind: string; accountId: string; previousTarget: 'dev' | 'ol' | null }[] = [];
  const sets: string[] = [];
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
      port: {
        getExecutionTarget: async () => opts.owner,
        resolveExecutionTarget: async () =>
          opts.owner ? ({ outcome: 'owned', target: opts.owner } as const) : ({ outcome: 'unowned' } as const),
        setExecutionTarget: async (accountId) => {
          sets.push(accountId);
          return opts.setResult ?? { outcome: 'claimed', target: 'dev' };
        },
      },
      onEvent: (info) =>
        events.push({ kind: info.kind, accountId: info.accountId, previousTarget: info.previousTarget }),
      onClaimed: async (accountId) => {
        replayed.push(accountId);
      },
    },
  });
  return { registry, configErrors, events, sets, replayed };
}

test('未归属账号首次握手 → 无条件写归属 + 强制重放计数 + driver_switched(previous=null)', async () => {
  const h = runtimeRegistry({ owner: null });
  const outcome = await h.registry.onHandshake(handshakeSession('acc-1'));
  assert.deepEqual(outcome, { ok: true });
  assert.deepEqual(h.sets, ['acc-1'], '首次握手把归属设为本 target');
  assert.deepEqual(h.replayed, ['acc-1'], '首次驱动 MUST 从库重放计数');
  assert.equal(h.events.at(-1)?.kind, 'driver_switched');
  assert.equal(h.events.at(-1)?.previousTarget, null);
  assert.equal(h.configErrors.length, 0, '握手不因归属而被拒');
});

test('换客户端：归属属于别的 target → 更新为本 target + 重放，握手照常放行（不再被拒）', async () => {
  const h = runtimeRegistry({ owner: 'ol' });
  const outcome = await h.registry.onHandshake(handshakeSession('acc-1'));
  assert.deepEqual(outcome, { ok: true }, '接 dev 客户端就归 dev，分时切换是正常的');
  assert.deepEqual(h.sets, ['acc-1'], '归属改写为当前连接的 target');
  assert.deepEqual(h.replayed, ['acc-1'], '从另一 target 切过来 MUST 重放计数（内存计数按账号级从库回放）');
  assert.equal(h.events.at(-1)?.kind, 'driver_switched');
  assert.equal(h.events.at(-1)?.previousTarget, 'ol');
  assert.equal(h.configErrors.length, 0, 'MUST NOT 走 onConfigError 拒绝握手');
});

test('归属本来就是本 target（没变）→ 不改写、不重放、不发事件', async () => {
  const h = runtimeRegistry({ owner: 'dev' });
  const outcome = await h.registry.onHandshake(handshakeSession('acc-1'));
  assert.deepEqual(outcome, { ok: true });
  assert.deepEqual(h.sets, [], '没变就不必写');
  assert.deepEqual(h.replayed, [], '没变就不必重放——重放只在真正切换时做');
  assert.equal(h.events.length, 0);
});

test('账号行不存在（setExecutionTarget 报 account_not_found）→ 不重放、不发事件，握手照常放行', async () => {
  const h = runtimeRegistry({ owner: null, setResult: { outcome: 'account_not_found' } });
  const outcome = await h.registry.onHandshake(handshakeSession('acc-1'));
  assert.deepEqual(outcome, { ok: true });
  assert.deepEqual(h.sets, ['acc-1']);
  assert.deepEqual(h.replayed, [], '没有归属可写就不重放，绝不 seed 造行');
  assert.equal(h.events.length, 0);
});
