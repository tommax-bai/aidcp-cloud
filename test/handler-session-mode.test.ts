/**
 * 会话模式登记（期1-3 任务模式通道）handler 单测。
 *
 * 验证 onHello 的权威登记：
 * - 不带 mode（旧 Edge）→ 归一为 'orchestration'，welcome 正常返回（行为与今天一致）；
 * - mode='task' → 登记 'task'（后续调度排除据此判定）；
 * - 模式随会话（EdgeSession）生命周期，无跨连接残留（新 session 对象天然为空）。
 * 另验证总开关纯归一：只认字面 'true'，默认关闭。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DefaultMessageHandler } from '../src/comm/index.js';
import type { AnchorStore } from '../src/comm/handler.js';
import type { EdgeSession } from '../src/comm/ws-server.js';
import { makeEnvelope } from '../src/comm/index.js';
import { SimplePlanner } from '../src/planner/index.js';
import type { LlmClient } from '../src/llm/index.js';
import { EventBus } from '../src/event-bus/index.js';
import { resolveSessionMode } from '../src/managed-automation/contracts/session-mode.js';
import { resolveTaskModeSchedulingExclusionEnabled } from '../src/managed-automation/task-mode-exclusion.js';

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
const silent = { log() {}, warn() {}, error() {} };

function makeHandler() {
  return new DefaultMessageHandler({
    planner: new SimplePlanner(),
    llm: dummyLlm,
    cache: noopStore,
    clock: () => 1000,
    eventBus: new EventBus(),
    logger: silent,
  });
}

test('onHello 不带 mode（旧 Edge）→ 会话登记为 orchestration，welcome 正常返回', async () => {
  const h = makeHandler();
  const s: EdgeSession = { sessionId: 'sm-1', accountId: 'acc-legacy' };
  const res = await h.handle(makeEnvelope('hello', 'h1', 1, { edgeId: 'edge-legacy', accountId: 'acc-legacy' }), s);
  assert.equal(res?.type, 'welcome');
  assert.equal(s.mode, 'orchestration', '缺字段必须归一为 orchestration（滚动兼容缺省）');
});

test('onHello mode=task → 会话权威登记为 task', async () => {
  const h = makeHandler();
  const s: EdgeSession = { sessionId: 'sm-2', accountId: 'acc-task' };
  const res = await h.handle(
    makeEnvelope('hello', 'h2', 1, { edgeId: 'ads-env-t', accountId: 'acc-task', mode: 'task' }),
    s,
  );
  assert.equal(res?.type, 'welcome');
  assert.equal(s.mode, 'task');
});

test('onHello mode=orchestration 显式声明 → 登记 orchestration（与缺省等价）', async () => {
  const h = makeHandler();
  const s: EdgeSession = { sessionId: 'sm-3', accountId: 'acc-orch' };
  const res = await h.handle(
    makeEnvelope('hello', 'h3', 1, { edgeId: 'edge-orch', accountId: 'acc-orch', mode: 'orchestration' }),
    s,
  );
  assert.equal(res?.type, 'welcome');
  assert.equal(s.mode, 'orchestration');
});

test('契约缺省归一与总开关解析：undefined→orchestration；开关只认字面 true、默认关闭', () => {
  assert.equal(resolveSessionMode(undefined), 'orchestration');
  assert.equal(resolveSessionMode('task'), 'task');
  assert.equal(resolveTaskModeSchedulingExclusionEnabled(undefined), false, '缺省必须关闭（行为与主干一致）');
  assert.equal(resolveTaskModeSchedulingExclusionEnabled('true'), true);
  assert.equal(resolveTaskModeSchedulingExclusionEnabled('TRUE'), false, '只认字面 true');
  assert.equal(resolveTaskModeSchedulingExclusionEnabled('1'), false);
  assert.equal(resolveTaskModeSchedulingExclusionEnabled('false'), false);
});
