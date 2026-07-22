/**
 * 待下发看门狗（change publish-approval-signal-to-database，task 4.4 / 8.4）。
 *
 * 判据只有一条：**没有原因的长时间待下发 = 执行侧静默失联**。
 * 有阻塞原因的是已解释的等待，对它们告警只制造噪声；无原因的必须响。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PendingDispatchWatchdog } from '../../src/publish-agent/pending-dispatch-watchdog.js';
import type { ApprovalDecisionRow } from '../../src/publish-agent/publish-approval-store.js';

const silent = { log: () => {}, warn: () => {}, error: () => {} };

function row(overrides: Partial<ApprovalDecisionRow> = {}): ApprovalDecisionRow {
  return {
    requestId: 'publish-42',
    revision: 1,
    subjectKind: 'publish',
    candidateRef: '42',
    contentVersion: 3,
    approved: true,
    decidedBy: 'ou_operator',
    decidedVia: 'feishu',
    decidedAt: 1_000,
    envKey: 'env-1',
    executionTarget: 'dev',
    frozenPayload: {},
    dispatchState: 'pending_dispatch',
    dispatchBlockedReason: null,
    dispatchStateAt: 1_000,
    voidReason: null,
    ...overrides,
  };
}

test('无阻塞原因且超阈值 → 告警（落库 + 飞书），且同一条只响一次', async () => {
  const alerts: Array<Record<string, unknown>> = [];
  const notices: Array<Record<string, unknown>> = [];
  const watchdog = new PendingDispatchWatchdog({
    executionTarget: 'dev',
    listStalePendingDispatch: async () => [row()],
    alertStore: { raise: async (a) => { alerts.push(a as unknown as Record<string, unknown>); return null; } },
    resolveAccountId: async () => 'acct-A',
    notify: (n) => { notices.push(n as unknown as Record<string, unknown>); },
    thresholdMs: 60_000,
    clock: () => 1_000_000,
    logger: silent,
  });

  assert.equal(await watchdog.sweep(), 1);
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].type, 'publish_pending_dispatch');
  // 告警必须指明是哪个号：运营收到 P1 才知道去查谁（spec：指明该记录与其账号）。
  assert.equal(alerts[0].accountId, 'acct-A');
  assert.match(String(alerts[0].detail), /account=acct-A/);
  assert.equal(notices.length, 1);
  assert.equal(notices[0].requestId, 'publish-42');
  assert.equal(notices[0].accountId, 'acct-A');
  assert.equal(notices[0].envKey, 'env-1');

  // 第二轮同一条仍在候选集内 → 不重复 ping 运维。
  assert.equal(await watchdog.sweep(), 0);
  assert.equal(alerts.length, 1);
});

test('飞书无接收端（notify 抛错）且未接 alerts → MUST NOT 计成已送达，如实记「告警无接收端」', async () => {
  const errors: string[] = [];
  const watchdog = new PendingDispatchWatchdog({
    executionTarget: 'dev',
    listStalePendingDispatch: async () => [row()],
    // 真实接线里「无可用飞书群」走的就是这条：MUST 抛错，绝不静默 return（return 会被记成已送达）。
    notify: async () => { throw new Error('pending_dispatch_alert_chat_not_configured'); },
    thresholdMs: 60_000,
    clock: () => 1_000_000,
    logger: { ...silent, error: (m: string) => errors.push(String(m)) },
  });
  assert.equal(await watchdog.sweep(), 0, '一个接收端都没有，MUST NOT 计成已送达');
  assert.match(errors.join('\n'), /告警无接收端/);
});

test('候选窗口被打满本身要响：更晚决定的稿件进不来 = 本探测器对它们失明', async () => {
  const errors: string[] = [];
  const watchdog = new PendingDispatchWatchdog({
    executionTarget: 'dev',
    listStalePendingDispatch: async () => [row({ requestId: 'publish-1' }), row({ requestId: 'publish-2' })],
    candidateLimit: 2,
    alertStore: { raise: async () => null },
    thresholdMs: 60_000,
    clock: () => 1_000_000,
    logger: { ...silent, error: (m: string) => errors.push(String(m)) },
  });
  assert.equal(await watchdog.sweep(), 2);
  assert.match(errors.join('\n'), /候选窗口已打满/);
});

test('有阻塞原因的行不进候选集 → 不告警（已解释的等待不是噪声源）', async () => {
  const alerts: unknown[] = [];
  const watchdog = new PendingDispatchWatchdog({
    executionTarget: 'dev',
    // 查询侧已按 dispatch_blocked_reason IS NULL 过滤；此处返回空表示「全都有原因」。
    listStalePendingDispatch: async () => [],
    alertStore: { raise: async (a) => { alerts.push(a); return null; } },
    thresholdMs: 60_000,
    clock: () => 1_000_000,
    logger: silent,
  });
  assert.equal(await watchdog.sweep(), 0);
  assert.deepEqual(alerts, []);
});

test('扫描失败不当作「无异常」：本轮不告警、只诚实记日志', async () => {
  const warns: string[] = [];
  const alerts: unknown[] = [];
  const watchdog = new PendingDispatchWatchdog({
    executionTarget: 'dev',
    listStalePendingDispatch: async () => { throw new Error('pg_down'); },
    alertStore: { raise: async (a) => { alerts.push(a); return null; } },
    logger: { ...silent, warn: (m: string) => warns.push(String(m)) },
  });
  assert.equal(await watchdog.sweep(), 0);
  assert.deepEqual(alerts, []);
  assert.match(warns.join('\n'), /绝不当作无异常/);
});

test('只扫本机 execution_target（DEV/OL 共库异步隔离）', async () => {
  const targets: string[] = [];
  const watchdog = new PendingDispatchWatchdog({
    executionTarget: 'ol',
    listStalePendingDispatch: async (target) => { targets.push(target); return []; },
    logger: silent,
  });
  await watchdog.sweep();
  assert.deepEqual(targets, ['ol']);
});
