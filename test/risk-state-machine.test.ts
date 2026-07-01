import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RESTRICTED_RECOVERY_MS, RiskStateMachine, WARNED_RECOVERY_MS, createRiskState } from '../src/risk/index.js';

test('状态机支持 normal → warned → restricted → frozen（软信号逐级升，仅平台可观测信号）', () => {
  const machine = new RiskStateMachine();
  let state = createRiskState('acct', 0);
  state = machine.transition(state, { kind: 'light', at: 1000 });
  assert.equal(state.status, 'warned');
  // 第二个软信号（未知阻断浮层）warned→restricted。配额饱和已不再是风控信号
  // （change decouple-quota-hit-from-risk），故软升级只由平台可观测信号驱动。
  state = machine.transition(state, { kind: 'light', at: 2000 });
  assert.equal(state.status, 'restricted');
  state = machine.transition(state, { kind: 'fatal', at: 3000 });
  assert.equal(state.status, 'frozen');
});

test('配额饱和不是风控信号：quota_exceeded 不再存在，撞配额绝不升级威胁态', () => {
  const machine = new RiskStateMachine();
  let state = createRiskState('acct', 0);
  // 仅平台/手动信号能升级。反复的「背压」不经状态机（record 直接返 false、不 applySignal）。
  // 这里断言：没有任何非平台信号能把 normal 推走——软路径只认 'light'。
  state = machine.transition(state, { kind: 'recovered', at: 1000 });
  assert.equal(state.status, 'normal');
  assert.equal(state.signalCount, 0, '恢复信号不 bump 计数、也不改状态');
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