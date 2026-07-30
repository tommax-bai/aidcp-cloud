/**
 * 期1-2 持久层单元测试（无库）：
 *   1. 迁移 SQL 契约断言（0106–0109）：expand-only、execution_target 第一业务列 +
 *      CHECK、两条不变式的库侧 CHECK、对象声明头；
 *   2. store 层纪律（fake pool 捕获 SQL）：不变式违规在 SQL 之前拒绝、CAS 谓词形状、
 *      claim 走 FOR UPDATE SKIP LOCKED、decision trace 仅 INSERT/SELECT、
 *      executionTarget 显式入参并进谓词、init 探测 fail-closed。
 * 真实 PG 行为（并发 CAS / claim 互斥 / 租约接管 / 23514 兜底）在
 * stores-pg.integration.test.ts（npm run test:pg 通道）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
  DecisionTraceStore,
  ExecutionLedgerStore,
  ManagedAutomationInvariantError,
  RunStateStore,
  TaskAuthorityStore,
} from '../../src/managed-automation/stores/index.js';
import { isSchemaCapabilityError } from '../../src/kernel/schema-capability-contract.js';
import type { TaskRunInsert } from '../../src/managed-automation/stores/index.js';

const MIGRATION_FILES = [
  '0106_managed_automation_task_authority.sql',
  '0107_managed_automation_run_state.sql',
  '0108_managed_automation_execution_ledger.sql',
  '0109_managed_automation_decision_traces.sql',
];

const EXPECTED_TABLES = [
  'tasks', 'task_revisions', 'execution_plans', 'task_runs', 'step_runs',
  'execution_intents', 'execution_attempts', 'decision_traces',
];

async function readMigration(name: string): Promise<string> {
  return readFile(new URL(`../../migrations/${name}`, import.meta.url), 'utf8');
}

/** 剥掉 -- 注释（注释里会提到「不写 REFERENCES / 不 DROP」字样，不能算进语句断言）。 */
function stripSqlComments(sql: string): string {
  return sql
    .split('\n')
    .map((line) => line.replace(/--.*$/, ''))
    .join('\n');
}

test('迁移 0106–0109：expand-only、无 ALTER/DROP、对象声明头齐全', async () => {
  const declaredTables: string[] = [];
  for (const name of MIGRATION_FILES) {
    const sql = await readMigration(name);
    const statements = stripSqlComments(sql);
    assert.match(sql, /^-- aidcp:kind=expand/, `${name} 缺 expand 声明`);
    assert.doesNotMatch(statements, /\bALTER\b/i, `${name} 不得 ALTER 既有表`);
    assert.doesNotMatch(statements, /\bDROP\b/i, `${name} 不得 DROP`);
    assert.doesNotMatch(statements, /\bREFERENCES\b/i, `${name} 刻意不引外键（0077 先例）`);
    for (const match of sql.matchAll(/table:([a-z_]+)/g)) declaredTables.push(match[1]!);
  }
  assert.deepEqual(declaredTables.sort(), [...EXPECTED_TABLES].sort());
});

test('迁移：8 张表 execution_target 都是第一业务列并带 dev/ol CHECK', async () => {
  const createBlocks: string[] = [];
  for (const name of MIGRATION_FILES) {
    const sql = await readMigration(name);
    for (const match of sql.matchAll(/CREATE TABLE IF NOT EXISTS [a-z_]+ \(([\s\S]*?)\n\);/g)) {
      createBlocks.push(match[1]!);
    }
  }
  assert.equal(createBlocks.length, 8, '应恰好建 8 张表');
  for (const block of createBlocks) {
    const columns = block.split('\n').map((line) => line.trim()).filter((line) => line.length > 0);
    // 第 1 列是主键 ID，第 2 列（第一业务列）必须是带 CHECK 的 execution_target。
    assert.match(
      columns[1] ?? '',
      /^execution_target\s+TEXT NOT NULL CHECK \(execution_target IN \('dev','ol'\)\),$/,
      `第一业务列必须是 execution_target：${columns[1]}`,
    );
  }
});

test('迁移 0107：两条不变式在 task_runs 与 step_runs 都有库侧 CHECK 兜底', async () => {
  const sql = await readMigration('0107_managed_automation_run_state.sql');
  for (const constraint of [
    'task_runs_wait_reason_iff_waiting',
    'task_runs_terminal_outcome_iff_terminal',
    'step_runs_wait_reason_iff_waiting',
    'step_runs_terminal_outcome_iff_terminal',
  ]) {
    assert.match(sql, new RegExp(`CONSTRAINT ${constraint}`), `缺 ${constraint}`);
  }
  assert.match(sql, /CHECK \(\(wait_reason IS NOT NULL\) = \(status = 'waiting'\)\)/);
  assert.match(sql, /CHECK \(\(terminal_outcome IS NOT NULL\) = \(status = 'terminal'\)\)/);
});

test('迁移 0108：Attempt 字段耦合与 intent 幂等唯一索引在库侧钉死', async () => {
  const sql = await readMigration('0108_managed_automation_execution_ledger.sql');
  assert.match(sql, /CHECK \(\(confirmed_not_applied_kind IS NOT NULL\) = \(status = 'confirmed_not_applied'\)\)/);
  assert.match(sql, /CHECK \(non_start_reason IS NULL OR status IN \('blocked','cancelled'\)\)/);
  assert.match(sql, /CREATE UNIQUE INDEX IF NOT EXISTS uq_execution_intents_target_idempotency\s+ON execution_intents \(execution_target, idempotency_key\)/);
  assert.match(sql, /CREATE UNIQUE INDEX IF NOT EXISTS uq_execution_attempts_intent_ordinal\s+ON execution_attempts \(intent_id, ordinal\)/);
});

// —— fake pool：捕获 SQL 与参数，默认返回未命中 ——

interface CapturedCall { text: string; values: unknown[] }

class FakePool {
  calls: CapturedCall[] = [];
  results: { rows: unknown[]; rowCount: number }[] = [];

  async query(text: string, values: unknown[] = []) {
    this.calls.push({ text, values });
    return this.results.shift() ?? { rows: [], rowCount: 0 };
  }

  async connect() {
    return {
      query: (text: string, values: unknown[] = []) => this.query(text, values),
      release: () => {},
    };
  }
}

const emptyShapeProber = async () => ({
  tables: new Set<string>(),
  columns: new Set<string>(),
  indexes: new Set<string>(),
});

function makeRunStore(pool: FakePool): RunStateStore {
  return new RunStateStore({ pool: pool as never, schemaProber: emptyShapeProber });
}

const baseRunInsert: TaskRunInsert = {
  runId: 'run-1', taskId: 'task-1', taskRevisionId: 'rev-1', executionPlanId: 'plan-1',
  cycleId: null, executionTarget: 'dev', correlationId: 'corr-1', planId: null, planVersion: null,
  taskDefinitionId: 'def-1', taskDefinitionVersion: 1, personaVersion: null,
  accountId: 'acc-1', envKey: 'env-1', platform: 'facebook' as never,
  accountBindingRevision: 'bind-1', candidateVersionId: null, contentVersion: null,
  approvalRevision: null, schedule: { scheduledAt: 1, latestStartAt: 2, missPolicy: 'skip' },
  budgets: { platformRisk: null, executionResource: null, aiContent: null },
  idempotencyKey: 'idem-1', status: 'queued', waitReason: null, terminalOutcome: null,
  reasonCode: null,
};

test('store 不变式：waitReason 非空但非 waiting → SQL 之前拒绝', async () => {
  const pool = new FakePool();
  const store = makeRunStore(pool);
  await assert.rejects(
    store.insertRun('dev', { ...baseRunInsert, waitReason: 'waiting_for_edge' }),
    ManagedAutomationInvariantError,
  );
  await assert.rejects(
    store.transitionRun('dev', 'run-1', 'running', {
      status: 'waiting', waitReason: null, terminalOutcome: null, reasonCode: null,
    }),
    ManagedAutomationInvariantError,
  );
  await assert.rejects(
    store.transitionRun('dev', 'run-1', 'running', {
      status: 'terminal', waitReason: null, terminalOutcome: null, reasonCode: null,
    }),
    ManagedAutomationInvariantError,
  );
  await assert.rejects(
    store.transitionRun('dev', 'run-1', 'running', {
      status: 'running', waitReason: null, terminalOutcome: 'succeeded', reasonCode: null,
    }),
    ManagedAutomationInvariantError,
  );
  assert.equal(pool.calls.length, 0, '不变式违规不得发出任何 SQL');
});

test('store CAS：谓词校验当前态 + executionTarget，未命中返回 false', async () => {
  const pool = new FakePool();
  const store = makeRunStore(pool);
  const hit = await store.transitionRun('dev', 'run-1', 'queued', {
    status: 'running', waitReason: null, terminalOutcome: null, reasonCode: null,
  });
  assert.equal(hit, false, 'rowCount=0 必须报未命中');
  const call = pool.calls[0]!;
  assert.match(call.text, /WHERE run_id=\$1 AND execution_target=\$2 AND status=\$3/);
  assert.equal(call.values[1], 'dev');
  assert.equal(call.values[2], 'queued');
});

test('store claim：认领走 FOR UPDATE SKIP LOCKED 且只扫本 target 的 queued', async () => {
  const pool = new FakePool();
  const store = makeRunStore(pool);
  const claimed = await store.claimNextQueued('ol', 'worker-token', 30_000);
  assert.equal(claimed, null);
  const call = pool.calls[0]!;
  assert.match(call.text, /FOR UPDATE SKIP LOCKED/);
  assert.match(call.text, /execution_target=\$1 AND status='queued'/);
  assert.equal(call.values[0], 'ol');
});

test('store Attempt：字段耦合违规与 submitted_unknown 改判越权都在 SQL 之前拒绝', async () => {
  const pool = new FakePool();
  const store = new ExecutionLedgerStore({ pool: pool as never, schemaProber: emptyShapeProber });
  await assert.rejects(
    store.transitionAttempt('dev', 'att-1', 'dispatched', {
      status: 'platform_confirmed', confirmedNotAppliedKind: 'never_applied',
    }),
    ManagedAutomationInvariantError,
  );
  await assert.rejects(
    store.transitionAttempt('dev', 'att-1', 'dispatched', {
      status: 'dispatched', nonStartReason: 'executor_unavailable',
    }),
    ManagedAutomationInvariantError,
  );
  await assert.rejects(
    store.transitionAttempt('dev', 'att-1', 'submitted_unknown', { status: 'platform_confirmed' }),
    ManagedAutomationInvariantError,
  );
  await assert.rejects(
    store.reconcileSubmittedUnknown('dev', 'att-1', { status: 'dispatched' }),
    ManagedAutomationInvariantError,
  );
  assert.equal(pool.calls.length, 0);
});

test('store DecisionTrace：仅 append + 查询，全部 SQL 只有 INSERT/SELECT', async () => {
  const pool = new FakePool();
  const store = new DecisionTraceStore({ pool: pool as never, schemaProber: emptyShapeProber });
  await store.append('dev', {
    traceId: 't-1', correlationId: 'corr-1', causationId: null, executionTarget: 'dev',
    versions: { planVersion: null, taskDefinitionVersion: null, personaVersion: null, policyRevision: null, approvalRevision: null },
    runId: 'run-1', stepId: null, attemptId: null, decisionType: 'admission',
    inputRefs: [], candidates: [], outcome: 'allowed', reasonCode: 'duplicate_trigger',
    snapshotRefs: [],
  });
  await store.listByRun('dev', 'run-1');
  await store.listByStep('dev', 'step-1');
  await store.listByAttempt('dev', 'att-1');
  await store.listByCorrelation('dev', 'corr-1');
  assert.equal(pool.calls.length, 5);
  for (const call of pool.calls) {
    assert.match(call.text.trim(), /^(INSERT INTO decision_traces|SELECT )/);
    assert.doesNotMatch(call.text, /\b(UPDATE|DELETE)\b/i, 'decision_traces 仅 append');
    assert.equal(call.values[0] === 'dev' || call.values[1] === 'dev', true, '每条 SQL 都按 target 过滤');
  }
});

test('store init：探测缺表即 fail-closed（SchemaCapabilityError，禁止自建）', async () => {
  for (const store of [
    new TaskAuthorityStore({ pool: new FakePool() as never, schemaProber: emptyShapeProber }),
    new RunStateStore({ pool: new FakePool() as never, schemaProber: emptyShapeProber }),
    new ExecutionLedgerStore({ pool: new FakePool() as never, schemaProber: emptyShapeProber }),
    new DecisionTraceStore({ pool: new FakePool() as never, schemaProber: emptyShapeProber }),
  ]) {
    await assert.rejects(store.init(), (err: unknown) => {
      assert.equal(isSchemaCapabilityError(err), true);
      assert.match((err as Error).message, /schema_missing_managed_automation/);
      return true;
    });
  }
});

test('store TaskAuthority：修订/编译产物只 INSERT，推进指针是 CAS', async () => {
  const pool = new FakePool();
  const store = new TaskAuthorityStore({ pool: pool as never, schemaProber: emptyShapeProber });
  const advanced = await store.appendRevision('dev', {
    revisionId: 'rev-2', taskId: 'task-1', executionTarget: 'dev', revisionOrdinal: 2,
    cause: 'revise',
    capabilityScope: { allow: [], deny: [] },
    actionAuthorization: {} as never,
    constraints: {}, budgets: { platformRisk: null, executionResource: null, aiContent: null },
    schedule: { scheduledAt: 1, latestStartAt: 2, missPolicy: 'skip' },
    authorizationRef: 'auth-1', supersedesRevisionId: 'rev-1', proposalRef: null,
  }, 'rev-1');
  assert.equal(advanced, false, '指针 CAS 未命中必须整体放弃');
  const update = pool.calls.find((call) => call.text.includes('UPDATE tasks'));
  assert.ok(update);
  assert.match(update.text, /WHERE task_id=\$1 AND execution_target=\$2 AND current_revision_id=\$3/);
  assert.equal(
    pool.calls.some((call) => call.text.includes('INSERT INTO task_revisions')),
    false,
    'CAS 输家不得写入修订行',
  );
});
