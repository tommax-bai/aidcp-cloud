import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RiskStateMachine, createRiskState, RiskController } from '../src/risk/index.js';
import type { RiskState, RiskStore } from '../src/risk/index.js';

// ── 状态机：运营信号种类（task 8.2）──────────────────────────────────────
test('manual_restrict: normal/warned → restricted', () => {
  const m = new RiskStateMachine();
  assert.equal(m.transition(createRiskState('a', 1000), { kind: 'manual_restrict' }, 2000).status, 'restricted');
  const warned: RiskState = { ...createRiskState('a'), status: 'warned' };
  assert.equal(m.transition(warned, { kind: 'manual_restrict' }).status, 'restricted');
});

test('manual_restrict: 已 frozen 不降级（不变）', () => {
  const m = new RiskStateMachine();
  const frozen: RiskState = { ...createRiskState('a'), status: 'frozen' };
  assert.equal(m.transition(frozen, { kind: 'manual_restrict' }).status, 'frozen');
});

test('manual_freeze: any → frozen', () => {
  const m = new RiskStateMachine();
  assert.equal(m.transition(createRiskState('a'), { kind: 'manual_freeze' }).status, 'frozen');
});

test('operator_override_recover: 强制 normal + 清零信号/窗口（绕过恢复窗口）', () => {
  const m = new RiskStateMachine();
  const restricted: RiskState = { ...createRiskState('a'), status: 'restricted', signalCount: 5, lastSignalAt: 1000 };
  const r = m.transition(restricted, { kind: 'operator_override_recover', reason: 'manual review' }, 2000);
  assert.equal(r.status, 'normal');
  assert.equal(r.signalCount, 0);
  assert.equal(r.lastSignalAt, null);
});

// ── controller: setQuotaLevel（task 8.3）+ mutation queue（task 8.1）──────
function memStore(): RiskStore & { saves: RiskState[]; saveDelayMs: number } {
  const o = {
    saves: [] as RiskState[],
    saveDelayMs: 0,
    async loadState() {
      return null;
    },
    async saveState(s: RiskState) {
      if (o.saveDelayMs) await new Promise((r) => setTimeout(r, o.saveDelayMs));
      o.saves.push({ ...s });
    },
    async loadCounters() {
      return [];
    },
    async appendCounter() {},
  };
  return o;
}

test('setQuotaLevel: 单写改档位 + 持久（状态机不碰 quotaLevel）', async () => {
  const store = memStore();
  const c = await RiskController.create({ accountId: 'a', store });
  const r = await c.setQuotaLevel('aggressive');
  assert.equal(r.quotaLevel, 'aggressive');
  assert.equal(c.getState().quotaLevel, 'aggressive');
  assert.equal(store.saves[store.saves.length - 1].quotaLevel, 'aggressive');
});

test('mutation queue: 并发 light + manual_freeze 串行组合、无丢更新（最终 frozen）', async () => {
  const store = memStore();
  store.saveDelayMs = 5; // 制造 read-modify-write 窗口
  const c = await RiskController.create({ accountId: 'a', store });
  await Promise.all([
    c.applySignal({ kind: 'light' }), // normal→warned
    c.applySignal({ kind: 'manual_freeze' }), // →frozen
  ]);
  assert.equal(store.saves.length, 2, '两个写都 saveState（无丢）');
  // 串行：light→warned 再 manual_freeze→frozen，或 manual_freeze→frozen 再 light(对 frozen no-op)；两序最终都 frozen
  assert.equal(c.getState().status, 'frozen');
});

test('recoverRestricted: restricted 原子恢复为 normal、清信号窗并持久', async () => {
  const store = memStore();
  const initial: RiskState = {
    ...createRiskState('a', 1000),
    status: 'restricted',
    signalCount: 4,
    lastSignalAt: 1500,
  };
  const c = await RiskController.create({ accountId: 'a', initialState: initial, store, clock: () => 2000 });
  const result = await c.recoverRestricted('client environment recovery');
  assert.equal(result.accepted, true);
  assert.equal(result.statusBefore, 'restricted');
  assert.equal(result.changed, true);
  assert.equal(result.state.status, 'normal');
  assert.equal(result.state.signalCount, 0);
  assert.equal(result.state.lastSignalAt, null);
  assert.equal(store.saves.length, 1);
  assert.equal(store.saves[0].status, 'normal');
});

test('recoverRestricted: normal 幂等不写；warned/frozen 拒绝且不降级', async () => {
  for (const status of ['normal', 'warned', 'frozen'] as const) {
    const store = memStore();
    const c = await RiskController.create({
      accountId: status,
      initialState: { ...createRiskState(status), status },
      store,
    });
    const result = await c.recoverRestricted('manual confirmation');
    assert.equal(result.accepted, status === 'normal', status);
    assert.equal(result.changed, false, status);
    assert.equal(result.state.status, status, status);
    assert.equal(store.saves.length, 0, `${status} 不应写库`);
  }
});

test('recoverRestricted: 空审计理由在入队前拒绝且不写', async () => {
  const store = memStore();
  const c = await RiskController.create({
    accountId: 'a',
    initialState: { ...createRiskState('a'), status: 'restricted' },
    store,
  });
  await assert.rejects(() => c.recoverRestricted('   '), /restricted_recovery_requires_reason/);
  assert.equal(c.getState().status, 'restricted');
  assert.equal(store.saves.length, 0);
});
