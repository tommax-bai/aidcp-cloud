/**
 * 期1-2 typed stores 的 PostgreSQL 合约测试（真实并发语义只能在真库验证）：
 *   - CAS 竞争：两个并发 transitionRun 只有一个赢家；
 *   - claim 互斥：同一条 queued 只能被一个 worker 认领（FOR UPDATE SKIP LOCKED）；
 *   - 租约过期接管：过期回收回 queued，新 worker 接管，旧 token 续租失效；
 *   - 不变式违规拒绝：store 层抛 ManagedAutomationInvariantError，绕过 store 直写被 23514 兜底；
 *   - executionTarget 隔离：dev 行对 ol 谓词不可见；
 *   - intent 幂等红线、修订指针 CAS、trace 仅 append。
 * 仅在 `npm run test:pg`（AIDCP_PG_INTEGRATION=1）通道运行，由 pg-test-database-guard
 * 拒绝生产目标；每个用例独立临时 schema，跑真实迁移文件 0106–0109。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import pg from 'pg';

import {
  DecisionTraceStore,
  ExecutionLedgerStore,
  ManagedAutomationInvariantError,
  RunStateStore,
  TaskAuthorityStore,
  type TaskRunInsert,
} from '../../src/managed-automation/stores/index.js';
import { probeSchemaShape } from '../../src/schema/schema-capability.js';
import { OUTBOX_URL_ENV, resolveIntegrationDatabase } from '../helpers/pg-test-database-guard.js';

const target = resolveIntegrationDatabase(OUTBOX_URL_ENV);
const connectionString = target.enabled ? target.connectionString : undefined;
const skipReason = target.enabled ? (false as const) : target.skipReason;

const MIGRATIONS = [
  '0106_managed_automation_task_authority.sql',
  '0107_managed_automation_run_state.sql',
  '0108_managed_automation_execution_ledger.sql',
  '0109_managed_automation_decision_traces.sql',
];

interface Harness {
  pool: pg.Pool;
  adminPool: pg.Pool;
  schema: string;
  prober: typeof probeSchemaShape;
  dispose(): Promise<void>;
}

async function setupSchema(prefix: string): Promise<Harness> {
  const adminPool = new pg.Pool({ connectionString });
  const schema = `${prefix}_${process.pid}_${Date.now()}`;
  assert.match(schema, /^[a-z0-9_]+$/);
  await adminPool.query(`CREATE SCHEMA "${schema}"`);
  const pool = new pg.Pool({ connectionString, options: `-c search_path=${schema}` });
  for (const name of MIGRATIONS) {
    await pool.query(await readFile(new URL(`../../migrations/${name}`, import.meta.url), 'utf8'));
  }
  // 探测口固定到本用例的临时 schema（生产走 runtimeSchemaName 默认）。
  const prober: typeof probeSchemaShape = (client, tables) => probeSchemaShape(client, tables, schema);
  return {
    pool, adminPool, schema, prober,
    async dispose() {
      await pool.end();
      await adminPool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await adminPool.end();
    },
  };
}

function runInsert(overrides: Partial<TaskRunInsert>): TaskRunInsert {
  return {
    runId: randomUUID(), taskId: randomUUID(), taskRevisionId: randomUUID(),
    executionPlanId: randomUUID(), cycleId: null, executionTarget: 'dev',
    correlationId: `corr-${randomUUID()}`, planId: null, planVersion: null,
    taskDefinitionId: 'facebook_browse_5_like_1_join_contact_every_2', taskDefinitionVersion: 2,
    personaVersion: null, accountId: 'acc-1', envKey: 'env-1', platform: 'facebook' as never,
    accountBindingRevision: 'bind-1', candidateVersionId: null, contentVersion: null,
    approvalRevision: null, schedule: { scheduledAt: Date.now(), latestStartAt: Date.now() + 60_000, missPolicy: 'skip' },
    budgets: { platformRisk: null, executionResource: null, aiContent: null },
    idempotencyKey: `idem-${randomUUID()}`, status: 'queued', waitReason: null,
    terminalOutcome: null, reasonCode: null,
    ...overrides,
  };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test(
  'PostgreSQL: task_runs CAS 竞争、claim 互斥、租约过期接管、target 隔离、不变式兜底',
  { skip: skipReason },
  async () => {
    const h = await setupSchema('ma_run_state');
    try {
      const store = new RunStateStore({ pool: h.pool, schemaProber: h.prober });
      await store.init();

      // 幂等创建：run_id / (target, idempotency_key) 任一命中都不覆盖。
      const runA = runInsert({});
      assert.equal(await store.insertRun('dev', runA), true);
      assert.equal(await store.insertRun('dev', runA), false, 'run_id 重放不覆盖');
      assert.equal(
        await store.insertRun('dev', runInsert({ idempotencyKey: runA.idempotencyKey })),
        false,
        '同 target 幂等键重放不建第二行',
      );

      // executionTarget 隔离：dev 行对 ol 谓词不可见。
      assert.equal(await store.getRun('ol', runA.runId), null);
      assert.equal(await store.claimNextQueued('ol', 'w-ol', 30_000), null);
      assert.equal((await store.listRunsByStatus('ol', 'queued')).length, 0);

      // CAS 竞争：两个并发 queued→running 恰好一个赢。
      const race = await Promise.all([
        store.transitionRun('dev', runA.runId, 'queued', {
          status: 'running', waitReason: null, terminalOutcome: null, reasonCode: null,
        }),
        store.transitionRun('dev', runA.runId, 'queued', {
          status: 'running', waitReason: null, terminalOutcome: null, reasonCode: null,
        }),
      ]);
      assert.deepEqual([...race].sort(), [false, true], 'CAS 必须恰好一个赢家');

      // 终态迁移 + 不变式：terminal 必带 outcome；随后 stale CAS 未命中。
      assert.equal(
        await store.transitionRun('dev', runA.runId, 'running', {
          status: 'terminal', waitReason: null, terminalOutcome: 'succeeded', reasonCode: null,
        }),
        true,
      );
      assert.equal(
        await store.transitionRun('dev', runA.runId, 'running', {
          status: 'terminal', waitReason: null, terminalOutcome: 'failed', reasonCode: null,
        }),
        false,
        '已终态的行不接受基于旧态的 CAS',
      );
      const terminalRun = await store.getRun('dev', runA.runId);
      assert.equal(terminalRun?.status, 'terminal');
      assert.equal(terminalRun?.terminalOutcome, 'succeeded');
      assert.ok(terminalRun?.finishedAt, 'terminal 必落 finished_at');

      // claim 互斥：单条 queued，两个并发 worker 只有一个拿到。
      const runB = runInsert({});
      assert.equal(await store.insertRun('dev', runB), true);
      const [claim1, claim2] = await Promise.all([
        store.claimNextQueued('dev', 'worker-1', 50),
        store.claimNextQueued('dev', 'worker-2', 50),
      ]);
      const claims = [claim1, claim2].filter((claim) => claim !== null);
      assert.equal(claims.length, 1, 'claim 必须互斥');
      const winner = claims[0]!;
      assert.equal(winner.run.runId, runB.runId);
      assert.equal(winner.run.status, 'running');

      // 续租：持有者续成功；随后让租约过期。
      assert.equal(await store.renewLease('dev', runB.runId, winner.claimToken, 50), true);
      assert.equal(await store.renewLease('dev', runB.runId, 'wrong-token', 50), false);
      await sleep(150);
      assert.equal(
        await store.renewLease('dev', runB.runId, winner.claimToken, 30_000),
        false,
        '过期租约不可续',
      );

      // 过期回收 → 新 worker 接管；旧 token 的进度写被拒。
      assert.deepEqual(await store.reclaimExpiredLeases('dev'), [runB.runId]);
      assert.equal((await store.getRun('dev', runB.runId))?.status, 'queued');
      const takeover = await store.claimNextQueued('dev', 'worker-3', 30_000);
      assert.equal(takeover?.run.runId, runB.runId);
      assert.equal(
        await store.recordRunProgress('dev', runB.runId, winner.claimToken, {
          confirmedCount: 1, targetCount: 5, attemptCount: 1, skippedCount: 0, failureCount: 0,
        }, 'node-1'),
        false,
        '被接管后旧 token 不得再写进度',
      );
      assert.equal(
        await store.recordRunProgress('dev', runB.runId, 'worker-3', {
          confirmedCount: 1, targetCount: 5, attemptCount: 1, skippedCount: 0, failureCount: 0,
        }, 'node-1'),
        true,
      );

      // 不变式违规：store 层先拒；绕过 store 直写由库侧 CHECK 兜底（23514）。
      await assert.rejects(
        store.insertRun('dev', runInsert({ status: 'queued', waitReason: 'waiting_for_edge' })),
        ManagedAutomationInvariantError,
      );
      await assert.rejects(
        h.pool.query(
          `UPDATE task_runs SET wait_reason='waiting_for_edge' WHERE run_id=$1`,
          [runB.runId],
        ),
        (err: unknown) => (err as { code?: string }).code === '23514',
        '绕过 store 的直写必须被库侧不变式 CHECK 拒绝',
      );

      // step_runs：同 (target, run, node) 唯一；不变式同样兜底。
      const stepRunId = randomUUID();
      assert.equal(
        await store.insertStepRun('dev', {
          stepRunId, runId: runB.runId, nodeId: 'node-1', capabilityId: 'browse.feed' as never,
          capabilityVersion: 1, executionTarget: 'dev', status: 'queued', waitReason: null,
          terminalOutcome: null, reasonCode: null, inputRef: null,
        }),
        true,
      );
      assert.equal(
        await store.insertStepRun('dev', {
          stepRunId: randomUUID(), runId: runB.runId, nodeId: 'node-1',
          capabilityId: 'browse.feed' as never, capabilityVersion: 1, executionTarget: 'dev',
          status: 'queued', waitReason: null, terminalOutcome: null, reasonCode: null, inputRef: null,
        }),
        false,
        '同 (target, run, node) 只有一行（恢复=续写同行）',
      );
      assert.equal(
        await store.transitionStep('dev', stepRunId, 'queued', {
          status: 'waiting', waitReason: 'waiting_for_edge', terminalOutcome: null,
          reasonCode: 'waiting_for_edge',
        }),
        true,
      );
      assert.equal((await store.getStepRun('dev', stepRunId))?.waitReason, 'waiting_for_edge');
    } finally {
      await h.dispose();
    }
  },
);

test(
  'PostgreSQL: 授权面——修订指针 CAS、不可变修订链/编译产物、target 隔离',
  { skip: skipReason },
  async () => {
    const h = await setupSchema('ma_authority');
    try {
      const store = new TaskAuthorityStore({ pool: h.pool, schemaProber: h.prober });
      await store.init();

      const taskId = randomUUID();
      const rev1 = randomUUID();
      const scope = { allow: [], deny: [] };
      const budgets = { platformRisk: null, executionResource: null, aiContent: null };
      const schedule = { scheduledAt: Date.now(), latestStartAt: Date.now() + 60_000, missPolicy: 'skip' as const };
      const baseRevision = {
        taskId, executionTarget: 'dev' as const, cause: 'create' as const,
        capabilityScope: scope, actionAuthorization: {} as never, constraints: {},
        budgets, schedule, authorizationRef: 'auth-1', supersedesRevisionId: null, proposalRef: null,
      };
      const created = await store.createTask('dev', {
        taskId, executionTarget: 'dev', planId: null, cycleId: null, accountId: 'acc-1',
        envKey: 'env-1', platform: 'facebook' as never, taskDefinitionId: 'def-1',
        taskDefinitionVersion: 1, currentRevisionId: rev1, capabilityScope: scope,
        actionAuthorization: {} as never, constraints: {}, budgets, schedule,
        completionConditionRef: 'cond-1', status: 'active', conversationMessageId: null,
        correlationId: 'corr-1',
      }, { ...baseRevision, revisionId: rev1, revisionOrdinal: 1 });
      assert.equal(created, true);
      assert.equal(await store.createTask('dev', {
        taskId, executionTarget: 'dev', planId: null, cycleId: null, accountId: 'acc-1',
        envKey: 'env-1', platform: 'facebook' as never, taskDefinitionId: 'def-1',
        taskDefinitionVersion: 1, currentRevisionId: rev1, capabilityScope: scope,
        actionAuthorization: {} as never, constraints: {}, budgets, schedule,
        completionConditionRef: 'cond-1', status: 'active', conversationMessageId: null,
        correlationId: 'corr-1',
      }, { ...baseRevision, revisionId: randomUUID(), revisionOrdinal: 1 }), false, '重放不覆盖');

      // target 隔离。
      assert.equal(await store.getTask('ol', taskId), null);

      // 修订指针 CAS：正确的 expected 赢，stale 的 expected 输且不写修订行。
      const rev2 = randomUUID();
      assert.equal(
        await store.appendRevision('dev', {
          ...baseRevision, revisionId: rev2, revisionOrdinal: 2, cause: 'revise',
          supersedesRevisionId: rev1,
        }, rev1),
        true,
      );
      assert.equal(
        await store.appendRevision('dev', {
          ...baseRevision, revisionId: randomUUID(), revisionOrdinal: 3, cause: 'revise',
          supersedesRevisionId: rev1,
        }, rev1),
        false,
        '基于旧指针的 Revise 必须整体失败',
      );
      const revisions = await store.listRevisions('dev', taskId);
      assert.deepEqual(revisions.map((rev) => rev.revisionOrdinal), [1, 2]);
      assert.equal((await store.getTask('dev', taskId))?.currentRevisionId, rev2);

      // 生命周期 CAS。
      assert.equal(await store.casSetTaskStatus('dev', taskId, 'active', 'cancelled'), true);
      assert.equal(await store.casSetTaskStatus('dev', taskId, 'active', 'completed'), false);

      // 编译产物不可变：重放不覆盖。
      const planId = randomUUID();
      const plan = {
        executionPlanId: planId, taskId, taskRevisionId: rev2, executionTarget: 'dev' as const,
        taskDefinitionId: 'def-1', taskDefinitionVersion: 1, planId: null, planVersion: null,
        authorizationRef: 'auth-1',
        nodes: [{ nodeId: 'n1', capabilityId: 'browse.feed' as never, capabilityVersion: 1, inputBindingRef: null, enabled: true }],
        edges: [], entryNodeId: 'n1',
        bounds: { maxNodes: 1, maxLoopIterations: 1, maxDerivationDepth: 1, maxExecutionAttempts: 1, maxWallClockMs: 1000 },
        completionConditionRef: 'cond-1',
      };
      assert.equal(await store.insertExecutionPlan('dev', plan), true);
      assert.equal(await store.insertExecutionPlan('dev', plan), false);
      assert.equal((await store.listExecutionPlansByTask('dev', taskId)).length, 1);
      assert.equal(await store.getExecutionPlan('ol', planId), null);
    } finally {
      await h.dispose();
    }
  },
);

test(
  'PostgreSQL: Ledger——intent 幂等红线、Attempt CAS 与 Reconciler 改判、字段耦合兜底',
  { skip: skipReason },
  async () => {
    const h = await setupSchema('ma_ledger');
    try {
      const store = new ExecutionLedgerStore({ pool: h.pool, schemaProber: h.prober });
      await store.init();

      const intent = {
        intentId: randomUUID(), accountId: 'acc-1', envKey: 'env-1',
        executionTarget: 'dev' as const, bindingRevision: 'bind-1',
        actionType: 'interaction.like' as never, actionDomain: 'interaction' as never,
        executionClass: 'read_only' as const, targetStableId: 'post-1', contentVersion: null,
        approvalRevision: null, scheduledAt: Date.now(), latestStartAt: Date.now() + 60_000,
        missPolicy: 'skip' as const, requiredCapability: 'interaction.like' as never,
        protocolVersion: 'v1', idempotencyKey: `like:${randomUUID()}`,
        correlationId: 'corr-1', runId: randomUUID(), stepId: randomUUID(),
      };
      const first = await store.insertIntent('dev', intent);
      assert.equal(first.created, true);
      // 幂等红线：同 target 同幂等键，不建第二个 intent，返回既有行。
      const replay = await store.insertIntent('dev', { ...intent, intentId: randomUUID() });
      assert.equal(replay.created, false);
      assert.equal(replay.intent.intentId, intent.intentId);
      // target 隔离：ol 下同幂等键可独立成行，且 dev 行不可见。
      assert.equal(await store.getIntent('ol', intent.intentId), null);
      const olIntent = await store.insertIntent('ol', { ...intent, intentId: randomUUID(), executionTarget: 'ol' });
      assert.equal(olIntent.created, true);

      // Attempt：ordinal 唯一、CAS 迁移、submitted_unknown 只交 Reconciler。
      const attemptId = randomUUID();
      const attemptInsert = {
        attemptId, intentId: intent.intentId, runId: intent.runId, stepId: intent.stepId, ordinal: 1,
      };
      assert.equal(await store.insertAttempt('dev', attemptInsert), true);
      assert.equal(
        await store.insertAttempt('dev', { ...attemptInsert, attemptId: randomUUID() }),
        false,
        '同 intent 下 ordinal 唯一',
      );
      assert.equal(
        await store.transitionAttempt('dev', attemptId, 'prepared', { status: 'dispatched' }),
        true,
      );
      assert.equal(
        await store.transitionAttempt('dev', attemptId, 'prepared', { status: 'dispatched' }),
        false,
        'stale CAS 未命中',
      );
      assert.equal(
        await store.transitionAttempt('dev', attemptId, 'dispatched', {
          status: 'submitted_unknown', strongestProgressEvidenceRef: 'evidence-1',
        }),
        true,
      );
      // 无结论对账：计数 +1、保持 unknown；随后改判 platform_confirmed。
      assert.equal(await store.reconcileSubmittedUnknown('dev', attemptId, null), true);
      assert.equal(
        await store.reconcileSubmittedUnknown('dev', attemptId, {
          status: 'platform_confirmed', evidenceRef: 'receipt-1',
        }),
        true,
      );
      const settled = await store.getAttempt('dev', attemptId);
      assert.equal(settled?.status, 'platform_confirmed');
      assert.equal(settled?.reconciliationCount, 2);
      assert.ok(settled?.settledAt);
      assert.equal(settled?.strongestProgressEvidenceRef, 'evidence-1');

      // 字段耦合兜底：绕过 store 的直写被 23514 拒绝。
      await assert.rejects(
        h.pool.query(
          `UPDATE execution_attempts SET confirmed_not_applied_kind='never_applied' WHERE attempt_id=$1`,
          [attemptId],
        ),
        (err: unknown) => (err as { code?: string }).code === '23514',
      );
    } finally {
      await h.dispose();
    }
  },
);

test(
  'PostgreSQL: decision_traces——仅 append、seq 稳定追加序、subject 查询、target 隔离',
  { skip: skipReason },
  async () => {
    const h = await setupSchema('ma_traces');
    try {
      const store = new DecisionTraceStore({ pool: h.pool, schemaProber: h.prober });
      await store.init();

      const runId = randomUUID();
      const versions = {
        planVersion: null, taskDefinitionVersion: 2, personaVersion: null,
        policyRevision: null, approvalRevision: null,
      };
      const base = {
        correlationId: 'corr-1', causationId: null, executionTarget: 'dev' as const,
        versions, runId, stepId: null, attemptId: null,
        inputRefs: ['ref-1'], candidates: [], snapshotRefs: [],
      };
      const traceIds = [randomUUID(), randomUUID(), randomUUID()];
      assert.equal(await store.append('dev', {
        ...base, traceId: traceIds[0]!, decisionType: 'admission', outcome: 'allowed',
        reasonCode: 'duplicate_trigger',
      }), true);
      assert.equal(await store.append('dev', {
        ...base, traceId: traceIds[1]!, decisionType: 'dispatch', outcome: 'selected',
        reasonCode: 'no_qualified_target',
        candidates: [{ candidateRef: 'post-1', reasonCode: null, selected: true }],
      }), true);
      assert.equal(await store.append('dev', {
        ...base, traceId: traceIds[2]!, runId: randomUUID(), decisionType: 'skip',
        outcome: 'skipped', reasonCode: 'window_missed',
      }), true);
      // append-only：trace_id 重放被忽略，不覆盖。
      assert.equal(await store.append('dev', {
        ...base, traceId: traceIds[0]!, decisionType: 'denial', outcome: 'denied',
        reasonCode: 'risk_denied',
      }), false);

      const byRun = await store.listByRun('dev', runId);
      assert.deepEqual(byRun.map((trace) => trace.traceId), [traceIds[0], traceIds[1]], 'seq 追加序回放');
      assert.equal(byRun[1]?.candidates[0]?.candidateRef, 'post-1');
      assert.equal((await store.listByCorrelation('dev', 'corr-1')).length, 3);
      assert.equal((await store.listByRun('ol', runId)).length, 0, 'target 隔离');
    } finally {
      await h.dispose();
    }
  },
);
