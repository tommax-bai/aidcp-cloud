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
    alertStore: { record: async (a) => { alerts.push(a as unknown as Record<string, unknown>); return null; } },
    notify: (n) => { notices.push(n as unknown as Record<string, unknown>); },
    thresholdMs: 60_000,
    clock: () => 1_000_000,
    logger: silent,
  });

  assert.equal(await watchdog.sweep(), 1);
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].type, 'publish_pending_dispatch');
  assert.equal(notices.length, 1);
  assert.equal(notices[0].requestId, 'publish-42');

  // 第二轮同一条仍在候选集内 → 不重复 ping 运维。
  assert.equal(await watchdog.sweep(), 0);
  assert.equal(alerts.length, 1);
});

test('有阻塞原因的行不进候选集 → 不告警（已解释的等待不是噪声源）', async () => {
  const alerts: unknown[] = [];
  const watchdog = new PendingDispatchWatchdog({
    executionTarget: 'dev',
    // 查询侧已按 dispatch_blocked_reason IS NULL 过滤；此处返回空表示「全都有原因」。
    listStalePendingDispatch: async () => [],
    alertStore: { record: async (a) => { alerts.push(a); return null; } },
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
    alertStore: { record: async (a) => { alerts.push(a); return null; } },
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
