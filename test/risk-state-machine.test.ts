import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RESTRICTED_RECOVERY_MS, RiskStateMachine, WARNED_RECOVERY_MS, createRiskState } from '../src/risk/index.js';

test('状态机支持 normal → warned → restricted → frozen', () => {
  const machine = new RiskStateMachine();
  let state = createRiskState('acct', 0);
  state = machine.transition(state, { kind: 'light', at: 1000 });
  assert.equal(state.status, 'warned');
  state = machine.transition(state, { kind: 'quota_exceeded', at: 2000 });
  assert.equal(state.status, 'restricted');
  state = machine.transition(state, { kind: 'fatal', at: 3000 });
  assert.equal(state.status, 'frozen');
});

test('warned 连续 7 天无新信号可恢复 normal', () => {
  const machine = new RiskStateMachine();
  let state = machine.transition(createRiskState('acct', 0), { kind: 'light', at: 1000 });
  state = machine.transition(state, { kind: 'recovered', at: 1000 + WARNED_RECOVERY_MS - 1 });
  assert.equal(state.status, 'warned');
  state = machine.transition(state, { kind: 'recovered', at: 1000 + WARNED_RECOVERY_MS });
  assert.equal(state.status, 'normal');
  assert.equal(state.signalCount, 1);
});

test('restricted 纯浏览观察 3 天无新信号回到 warned', () => {
  const machine = new RiskStateMachine();
  let state = machine.transition(createRiskState('acct', 0), { kind: 'confirmed', at: 1000 });
  state = machine.transition(state, { kind: 'recovered', at: 1000 + RESTRICTED_RECOVERY_MS });
  assert.equal(state.status, 'warned');
});

test('frozen 人工恢复后进入 restricted', () => {
  const machine = new RiskStateMachine();
  let state = machine.transition(createRiskState('acct', 0), { kind: 'fatal', at: 1000 });
  state = machine.transition(state, { kind: 'manual_unfreeze', at: 2000 });
  assert.equal(state.status, 'restricted');
});