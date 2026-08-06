import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DefaultMessageHandler } from '@automation/comm/index.js';
import type { AnchorStore } from '@automation/comm/handler.js';
import type { EdgeSession } from '@automation/comm/ws-server.js';
import { makeEnvelope, type WelcomePayload } from '@automation/comm/index.js';
import { SimplePlanner } from '@automation/planner/index.js';
import type { LlmClient } from '@content/llm/index.js';
import { EventBus } from '@automation/event-bus/index.js';
import { BUILTIN_FLOOR, PACING_OPS, type PacingFloorProvider } from '@automation/risk/pacing.js';
import type { PacingOp, PacingFloorPayload } from '@automation/comm/protocol.js';

/** 最小 AnchorStore 桩（onHello 不触及）。 */
const noopStore: AnchorStore = {
  async get() {
    return null;
  },
  async recordHit() {},
  async recordFailure() {},
  async stage() {},
  async confirmStaged() {
    return { promoted: false, successes: 0, needed: 2 };
  },
  async dropStaged() {},
};

const dummyLlm: LlmClient = { complete: async () => '0' };

function makeHandler(pacingFloors?: PacingFloorProvider) {
  return new DefaultMessageHandler({
    planner: new SimplePlanner(),
    llm: dummyLlm,
    cache: noopStore,
    clock: () => 1000,
    eventBus: new EventBus(),
    pacingFloors,
  });
}

test('onHello：注入 pacingFloors → welcome 带 pacing 快照（tempo + 四类操作 floor）', async () => {
  const provider: PacingFloorProvider = { floorFor: (op: PacingOp): PacingFloorPayload => ({ ...BUILTIN_FLOOR[op] }) };
  const h = makeHandler(provider);
  const s: EdgeSession = { sessionId: 'sP', accountId: 'acc-1' };
  const res = await h.handle(makeEnvelope('hello', 'h1', 1, { edgeId: 'edge-1', app: 'xhs', accountId: 'acc-1' }), s);
  assert.equal(res?.type, 'welcome');
  const p = (res!.payload as WelcomePayload).pacing;
  assert.ok(p, 'welcome 应带 pacing 快照');
  assert.equal(p!.tempo, 1.0, '握手早于风控态 → 回落 normal(tempo=1.0)');
  for (const op of PACING_OPS) {
    assert.deepEqual(p!.opFloorsMs[op], { minMs: BUILTIN_FLOOR[op].minMs, maxMs: BUILTIN_FLOOR[op].maxMs }, `${op} 应在快照内`);
  }
});

test('onHello：pacingFloors 抛错 → 握手仍成功（welcome 返回，pacing 省略，绝不 brick）', async () => {
  const throwing: PacingFloorProvider = {
    floorFor: () => {
      throw new Error('store down');
    },
  };
  const h = makeHandler(throwing);
  const s: EdgeSession = { sessionId: 'sT', accountId: 'acc-1' };
  const res = await h.handle(makeEnvelope('hello', 'h2', 1, { edgeId: 'edge-2', app: 'xhs', accountId: 'acc-1' }), s);
  assert.equal(res?.type, 'welcome', '即便 provider 抛错，握手也 MUST 成功回 welcome');
  const p = (res!.payload as WelcomePayload).pacing;
  assert.equal(p, undefined, 'provider 抛错 → pacing 字段省略（total 函数回退 undefined）');
});

test('onHello：未注入 pacingFloors → welcome 省略 pacing（向后兼容）', async () => {
  const h = makeHandler(undefined);
  const s: EdgeSession = { sessionId: 'sN', accountId: 'acc-1' };
  const res = await h.handle(makeEnvelope('hello', 'h3', 1, { edgeId: 'edge-3', app: 'xhs', accountId: 'acc-1' }), s);
  assert.equal(res?.type, 'welcome');
  assert.equal((res!.payload as WelcomePayload).pacing, undefined);
});

test('onSessionBudgetRequest：session.budget 回执不含 pacing 字段（pacing-fallback-hardening 移除死通道）', async () => {
  const h = makeHandler();
  const s: EdgeSession = { sessionId: 'sB', accountId: 'acc-1' };
  const res = await h.handle(makeEnvelope('session.budget.request', 'b1', 1, {}), s);
  assert.equal(res?.type, 'session.budget');
  const payload = res!.payload as Record<string, unknown>;
  assert.ok(!('pacing' in payload), 'session.budget 回执不应再含 pacing 字段（双死通道已移除）');
  // 其余字段仍在（预算 + viewOnly），不受影响。
  assert.equal(typeof payload.viewOnly, 'boolean');
  assert.equal(typeof payload.maxActions, 'number');
});
