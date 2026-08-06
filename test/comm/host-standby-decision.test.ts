/**
 * 宿主层让位判决遥测的云端一侧（change report-host-standby-decisions）。
 *
 * 这条通道要修的病是「有事实、无人可见」：2026-08-05 真机上一个环境连续 32 分钟拒绝让出浏览器
 * 槽位，运营在另一处零证据。因此本文件的验收判据是**在另一处读得到**，不是「消息收下了」。
 *
 * 同时钉死那条最容易被悄悄越过的边界：**可见性 MUST NOT 转化为否决权**。
 *
 * 环境层级：离线 / 逻辑级（无外部依赖）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DefaultMessageHandler, type AnchorStore } from '../../src/comm/handler.js';
import type { EdgeSession } from '../../src/comm/ws-server.js';
import {
  HOST_STANDBY_DECISION_TELEMETRY_CAPABILITY,
  makeEnvelope,
  type StandbyDecisionPayload,
  type WelcomePayload,
} from '../../src/comm/protocol.js';
import { HostStandbyDecisionStore } from '../../src/comm/host-standby-decision-store.js';
import { buildBrowserStandbyHint } from '../../src/comm/browser-standby.js';
import { EventBus } from '../../src/event-bus/index.js';
import { SimplePlanner } from '../../src/planner/index.js';
import type { LlmClient } from '../../src/llm/qwen.js';

const noopCache = {
  get: async () => null,
  recordHit: async () => {},
  recordFailure: async () => {},
  stage: async () => {},
  confirmStaged: async () => ({ promoted: false, successes: 0, needed: 1 }),
  dropStaged: async () => {},
} as unknown as AnchorStore;

const llm: LlmClient = { complete: async () => '0' };
const now = 1_700_000_000_000;

function makeHandler(store?: HostStandbyDecisionStore) {
  return new DefaultMessageHandler({
    planner: new SimplePlanner(),
    llm,
    cache: noopCache,
    eventBus: new EventBus(),
    clock: () => now,
    ...(store ? { hostStandbyDecisions: store } : {}),
  });
}

function decision(overrides: Partial<StandbyDecisionPayload> = {}): StandbyDecisionPayload {
  return {
    verdict: 'refused',
    reason: 'task_lease_active',
    refusedCount: 32,
    refusedSince: now - 32 * 60_000,
    hintGeneratedAt: now - 60_000,
    decidedAt: now,
    envId: 'env-7',
    ...overrides,
  };
}

function session(overrides: Partial<EdgeSession> = {}): EdgeSession {
  return {
    sessionId: 's1',
    edgeId: 'edge-1',
    accountId: 'acct-1',
    machineLabel: 'win-aliyun-3',
    ...overrides,
  } as EdgeSession;
}

// ── 3.1 / 3.2：收下、留存、在另一处读得到 ────────────────────────────────────

test('standby-decision: 收下一条拒绝回执后，运营在另一处读得到「哪台机器上的哪个环境卡住了」', async () => {
  const store = new HostStandbyDecisionStore({ clock: () => now + 500 });
  const reply = await makeHandler(store).handle(
    makeEnvelope('standby.decision', 'd1', now, decision()),
    session(),
  );
  assert.equal(reply, null, '遥测是 fire-and-forget，合法载荷不回任何帧');

  const rows = await store.listHostStandbyDecisions();
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0], {
    edgeId: 'edge-1',
    accountId: 'acct-1',
    machineLabel: 'win-aliyun-3',   // ← 「哪台机器」
    envId: 'env-7',                 // ← 「哪个环境」
    verdict: 'refused',
    reason: 'task_lease_active',    // ← 「为什么没让」
    refusedCount: 32,               // ← 「连续多少次」
    refusedSince: now - 32 * 60_000, // ← 「卡了多久」
    hintGeneratedAt: now - 60_000,
    decidedAt: now,
    receivedAt: now + 500,
  });
});

test('standby-decision: 同一连接只留最近一条当前态（本 change 不做历史留档）', async () => {
  const store = new HostStandbyDecisionStore({ clock: () => now });
  const handler = makeHandler(store);
  await handler.handle(makeEnvelope('standby.decision', 'd1', now, decision({ refusedCount: 1 })), session());
  await handler.handle(makeEnvelope('standby.decision', 'd2', now, decision({ refusedCount: 6 })), session());
  const rows = await store.listHostStandbyDecisions();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].refusedCount, 6);
});

test('standby-decision: 多台机器并存，卡得最久的排在最前（纯呈现顺序）', async () => {
  const store = new HostStandbyDecisionStore({ clock: () => now });
  const handler = makeHandler(store);
  await handler.handle(
    makeEnvelope('standby.decision', 'd1', now, decision({ refusedCount: 2 })),
    session({ edgeId: 'edge-a', accountId: 'acct-a' } as Partial<EdgeSession>),
  );
  await handler.handle(
    makeEnvelope('standby.decision', 'd2', now, decision({ verdict: 'yielded', reason: 'ok', refusedCount: 0 })),
    session({ edgeId: 'edge-b', accountId: 'acct-b' } as Partial<EdgeSession>),
  );
  await handler.handle(
    makeEnvelope('standby.decision', 'd3', now, decision({ refusedCount: 32 })),
    session({ edgeId: 'edge-c', accountId: 'acct-c' } as Partial<EdgeSession>),
  );
  const rows = await store.listHostStandbyDecisions();
  assert.deepEqual(rows.map((r) => r.edgeId), ['edge-c', 'edge-a', 'edge-b']);
});

test('standby-decision: 握手没带账号 ⇒ 记 null，绝不回落默认账号', async () => {
  const store = new HostStandbyDecisionStore({ clock: () => now });
  await makeHandler(store).handle(
    makeEnvelope('standby.decision', 'd1', now, decision()),
    { sessionId: 's9', edgeId: 'edge-9' } as EdgeSession,
  );
  const [row] = await store.listHostStandbyDecisions();
  assert.equal(row.accountId, null);
  assert.equal(row.machineLabel, null);
});

// ── 载荷校验：坏帧具名拒收，MUST NOT 半填一条 ────────────────────────────────

test('standby-decision: 残缺载荷回具名 error，且一条都不留存', async () => {
  const store = new HostStandbyDecisionStore({ clock: () => now });
  const handler = makeHandler(store);
  for (const broken of [
    { ...decision(), verdict: 'maybe' },
    { ...decision(), reason: '   ' },
    { ...decision(), refusedCount: -1 },
    { ...decision(), decidedAt: 'now' },
    null,
  ]) {
    const reply = await handler.handle(
      makeEnvelope('standby.decision', 'bad', now, broken as never),
      session(),
    );
    assert.equal((reply?.payload as { code?: string })?.code, 'invalid_standby_decision');
  }
  assert.deepEqual(await store.listHostStandbyDecisions(), []);
});

// ── 2.5 / 3.4：能力位协商与缺席路径 ──────────────────────────────────────────

test('standby-decision: 双向都具备才回该能力位（边缘声明 + 云端真接了消费方）', async () => {
  const withStore = await makeHandler(new HostStandbyDecisionStore()).handle(
    makeEnvelope('hello', 'h1', now, { edgeId: 'e1', capabilities: [HOST_STANDBY_DECISION_TELEMETRY_CAPABILITY] }),
    session(),
  );
  assert.ok(
    (withStore?.payload as WelcomePayload).capabilities?.includes(HOST_STANDBY_DECISION_TELEMETRY_CAPABILITY),
    '两侧都有 ⇒ 协商成功',
  );

  const noConsumer = await makeHandler().handle(
    makeEnvelope('hello', 'h2', now, { edgeId: 'e1', capabilities: [HOST_STANDBY_DECISION_TELEMETRY_CAPABILITY] }),
    session(),
  );
  assert.equal(
    (noConsumer?.payload as WelcomePayload).capabilities?.includes(HOST_STANDBY_DECISION_TELEMETRY_CAPABILITY),
    undefined,
    '云端没接消费方就不该让边缘发——否则长成「一直在发、没人接」的静默黑洞',
  );

  const oldEdge = await makeHandler(new HostStandbyDecisionStore()).handle(
    makeEnvelope('hello', 'h3', now, { edgeId: 'e1', capabilities: [] }),
    session(),
  );
  assert.equal(
    (oldEdge?.payload as WelcomePayload).capabilities?.includes(HOST_STANDBY_DECISION_TELEMETRY_CAPABILITY),
    undefined,
    '旧客户端不声明 ⇒ 云端不期待',
  );
});

test('standby-decision: 未接消费方时收到回执也不报错（灰度中途换端是正常态，不是故障）', async () => {
  const reply = await makeHandler().handle(
    makeEnvelope('standby.decision', 'd1', now, decision()),
    session(),
  );
  assert.equal(reply, null, '合法载荷 + 无消费方 ⇒ 静默丢弃，MUST NOT 回 error');
});

// ── 3.3 / 4.5 结构断言：可见性 MUST NOT 转化为否决权 ─────────────────────────

test('standby-decision: 消费方 MUST NOT 出现在任何下发决策路径上', () => {
  // 这是本 change 最需要防的失败模式：它「看起来只是多读一个字段」。
  const dispatchPaths = [
    'src/comm/browser-standby.ts',       // 待机提示的产出
    'src/orchestrator/role-dispatcher.ts', // 命令下发
    'src/risk/risk-controller.ts',       // 风控裁决
    'src/risk/risk-state-machine.ts',
    'src/comm/ui-snapshot.ts',           // 提示推送
  ];
  for (const file of dispatchPaths) {
    const source = readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8');
    for (const forbidden of ['host-standby-decision', 'HostStandbyDecision', 'hostStandbyDecisions']) {
      assert.equal(
        source.includes(forbidden),
        false,
        `${file} MUST NOT 读让位判决遥测——云端读得到，但绝不据此否决宿主层`,
      );
    }
  }
});

test('standby-decision: 处理分支只做「校验 + 留存」，不 emit、不改会话状态', () => {
  const source = readFileSync(new URL('../../src/comm/handler.ts', import.meta.url), 'utf8');
  const at = source.indexOf("case 'standby.decision': {");
  assert.notEqual(at, -1, '未找到 standby.decision 处理分支');
  const branch = source.slice(at, source.indexOf('\n      }', at));
  assert.equal(branch.includes('.emit('), false, '遥测 MUST NOT 进事件总线（那是下发决策的入口）');
  assert.equal(branch.includes('session.'), true, '需要从会话补齐身份');
  assert.equal(/session\.\w+\s*=/.test(branch), false, '遥测 MUST NOT 改写任何会话状态');
  assert.equal(branch.includes('pusher'), false, '遥测 MUST NOT 反向下发任何命令');
});

test('standby-decision: 只读端口没有写侧路由（没有强制让位 / 禁止让位这种东西）', () => {
  const source = readFileSync(new URL('../../src/transport/host-standby-decision-http.ts', import.meta.url), 'utf8');
  const routes = source.slice(source.indexOf('HOST_STANDBY_DECISION_ROUTES'), source.indexOf('} as const;'));
  assert.equal(routes.split(':').length - 1, 1, '本通道只该有一条读路由');
  assert.ok(routes.includes('list'));
  assert.equal(/register\w*\(server[^)]*\)\s*{[^}]*local\.(?!listHostStandbyDecisions)/.test(source), false);
});

// ── 4.6 兼容红线：待机提示载荷字段只增不减 ──────────────────────────────────

test('standby-decision: 云端下发的待机提示字段一个都不少（删字段会让全部客户端停止让位）', () => {
  // 0.3 的基线快照。边缘对提示做**格式先验**：「是否够格让位」不是布尔、或门槛值 < 1s ⇒ 整条判无效
  // 并丢弃。因此任何字段删减都不是降级，而是让所有在跑的客户端一起停止让出浏览器槽位；
  // 而且不能靠版本号灰度——客户端会被从源码重新编译装机而不抬版本号。
  const BASELINE_HINT_FIELDS = [
    'enabled', 'eligible', 'reason', 'waitMs', 'wakeAt', 'generatedAt', 'source', 'minWaitMs', 'warmupMs',
  ] as const;
  const hint = buildBrowserStandbyHint(
    {
      explain: () => ({ allowed: false, reason: 'quota:hour' }),
      quotaReleaseAfterMs: (_a, window) => (window === 'hour' ? 30 * 60_000 : 0),
      getState: () => ({ status: 'normal' }),
    },
    { now: 1_000, config: { enabled: true, minWaitMs: 5 * 60_000, warmupMs: 90_000 } },
  );
  for (const field of BASELINE_HINT_FIELDS) {
    assert.ok(field in hint, `待机提示 MUST NOT 删字段：缺 ${field} 会让边缘判整条提示无效`);
  }
});

// ── 上限与淘汰：静默截断会让「没卡住」与「记录被挤掉了」长得一样 ──────────────

test('standby-decision: 达上限时淘汰最旧一条并响亮记一行', async () => {
  const warned: string[] = [];
  let tick = now;
  const store = new HostStandbyDecisionStore({
    capacity: 2,
    clock: () => (tick += 1_000),
    logger: { warn: (m: string) => warned.push(m) },
  });
  const handler = makeHandler(store);
  for (const edgeId of ['edge-1', 'edge-2', 'edge-3']) {
    await handler.handle(
      makeEnvelope('standby.decision', edgeId, now, decision()),
      session({ edgeId, accountId: edgeId } as Partial<EdgeSession>),
    );
  }
  const rows = await store.listHostStandbyDecisions();
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((r) => r.edgeId).sort(), ['edge-2', 'edge-3']);
  assert.equal(warned.length, 1);
  assert.match(warned[0], /edge-1/);
});
