import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  PgRiskCommandService,
  createRiskCommandApplyHandler,
  type RiskCommandController,
} from '../../src/risk/risk-command-service.js';
import type { RiskState } from '../../src/risk/types.js';

interface RecoveryRow {
  command_id: number;
  execution_target: string;
  env_key: string | null;
  account_id: string;
  command_kind: string;
  state: string;
  status: string | null;
  quota_level: string | null;
  signal_count: number | null;
  last_signal_at: number | null;
  status_since: number | null;
  state_updated_at: number | null;
  recovery_changed: boolean | null;
  recovery_refusal: string | null;
  resumed_edges: number | null;
  resume_failure: string | null;
  resume_state: string | null;
  reason: string | null;
  decided_at: Date;
}

function emptyRow(id: number, target: string, accountId: string): RecoveryRow {
  return {
    command_id: id,
    execution_target: target,
    env_key: null,
    account_id: accountId,
    command_kind: 'recoverRestricted',
    state: 'submitted',
    status: null,
    quota_level: null,
    signal_count: null,
    last_signal_at: null,
    status_since: null,
    state_updated_at: null,
    recovery_changed: null,
    recovery_refusal: null,
    resumed_edges: null,
    resume_failure: null,
    resume_state: null,
    reason: null,
    decided_at: new Date(0),
  };
}

function makeFakePool() {
  let nextId = 0;
  const outcomes = new Map<number, RecoveryRow>();
  const outbox: Array<{ id: number; topic: string; target: string; payload: Record<string, unknown> }> = [];
  const failures = {
    appliedDomainWrites: 0,
    resumeResultWrites: 0,
  };

  const pool = {
    async query(sql: string, params: unknown[] = []) {
      if (sql.includes('INSERT INTO event_outbox')) {
        const id = ++nextId;
        outbox.push({
          id,
          topic: String(params[0]),
          payload: JSON.parse(String(params[1])) as Record<string, unknown>,
          target: String(params[2]),
        });
        return { rows: [{ id }], rowCount: 1 };
      }
      if (sql.includes('pg_notify')) return { rows: [], rowCount: 0 };

      if (sql.includes('INSERT INTO risk_command_outcome') && sql.includes("'submitted', $6")) {
        const id = Number(params[0]);
        if (!outcomes.has(id)) {
          const row = emptyRow(id, String(params[1]), String(params[3]));
          row.env_key = params[2] === null ? null : String(params[2]);
          row.command_kind = String(params[4]);
          outcomes.set(id, row);
        }
        return { rows: [], rowCount: 1 };
      }

      if (sql.includes("'recoverRestricted', 'applying'")) {
        const id = Number(params[0]);
        const target = String(params[1]);
        const envKey = String(params[2]);
        const accountId = String(params[3]);
        const existing = outcomes.get(id);
        if (
          existing &&
          (existing.execution_target !== target ||
            (existing.env_key !== null && existing.env_key !== envKey) ||
            existing.account_id !== accountId ||
            existing.command_kind !== 'recoverRestricted' ||
            existing.state !== 'submitted')
        ) {
          return { rows: [], rowCount: 0 };
        }
        const row = existing ?? emptyRow(id, target, accountId);
        row.env_key = envKey;
        row.state = 'applying';
        outcomes.set(id, row);
        return { rows: [{ command_id: id }], rowCount: 1 };
      }

      if (sql.includes("'recoverRestricted', 'applied'")) {
        if (failures.appliedDomainWrites > 0) {
          failures.appliedDomainWrites -= 1;
          throw new Error('pg_applied_domain_write_failed:relation=risk_command_outcome');
        }
        const id = Number(params[0]);
        const target = String(params[1]);
        const envKey = String(params[2]);
        const accountId = String(params[3]);
        const existing = outcomes.get(id);
        if (
          existing &&
          (existing.execution_target !== target ||
            existing.env_key !== envKey ||
            existing.account_id !== accountId ||
            existing.command_kind !== 'recoverRestricted' ||
            existing.state !== 'applying')
        ) {
          return { rows: [], rowCount: 0 };
        }
        const row = existing ?? emptyRow(id, target, accountId);
        row.env_key = envKey;
        Object.assign(row, {
          state: 'applied',
          status: String(params[4]),
          quota_level: String(params[5]),
          signal_count: Number(params[6]),
          last_signal_at: params[7] === null ? null : Number(params[7]),
          status_since: Number(params[8]),
          state_updated_at: Number(params[9]),
          recovery_changed: Boolean(params[10]),
          recovery_refusal: null,
          resumed_edges: null,
          resume_failure: null,
          resume_state: 'pending',
          reason: null,
          decided_at: new Date(1000),
        });
        outcomes.set(id, row);
        return { rows: [{ command_id: id }], rowCount: 1 };
      }

      if (sql.includes("'recoverRestricted', 'refused'")) {
        const id = Number(params[0]);
        const target = String(params[1]);
        const envKey = String(params[2]);
        const accountId = String(params[3]);
        const existing = outcomes.get(id);
        if (
          existing &&
          (existing.execution_target !== target ||
            existing.env_key !== envKey ||
            existing.account_id !== accountId ||
            existing.command_kind !== 'recoverRestricted' ||
            existing.state !== 'applying')
        ) {
          return { rows: [], rowCount: 0 };
        }
        const row = existing ?? emptyRow(id, target, accountId);
        row.env_key = envKey;
        Object.assign(row, {
          state: 'refused',
          status: String(params[4]),
          quota_level: String(params[5]),
          signal_count: Number(params[6]),
          last_signal_at: params[7] === null ? null : Number(params[7]),
          status_since: Number(params[8]),
          state_updated_at: Number(params[9]),
          recovery_changed: false,
          recovery_refusal: String(params[10]),
          resumed_edges: null,
          resume_failure: null,
          resume_state: null,
          reason: null,
          decided_at: new Date(1000),
        });
        outcomes.set(id, row);
        return { rows: [{ command_id: id }], rowCount: 1 };
      }

      if (sql.includes("'recoverRestricted', 'failed'")) {
        const id = Number(params[0]);
        const target = String(params[1]);
        const envKey = String(params[2]);
        const accountId = String(params[3]);
        const existing = outcomes.get(id);
        if (
          existing &&
          (existing.execution_target !== target ||
            existing.env_key !== envKey ||
            existing.account_id !== accountId ||
            existing.command_kind !== 'recoverRestricted' ||
            existing.state === 'applied')
        ) {
          return { rows: [], rowCount: 0 };
        }
        const row = existing ?? emptyRow(id, target, accountId);
        row.env_key = envKey;
        Object.assign(row, {
          state: 'failed',
          status: null,
          quota_level: null,
          reason: String(params[4]),
          decided_at: new Date(1000),
        });
        outcomes.set(id, row);
        return { rows: [{ command_id: id }], rowCount: 1 };
      }

      if (sql.includes("SET resume_state = 'claimed'")) {
        const row = outcomes.get(Number(params[0]));
        const matches =
          row?.execution_target === String(params[1]) &&
          row.env_key === String(params[2]) &&
          row.account_id === String(params[3]) &&
          row.state === 'applied' &&
          row.resume_state === 'pending';
        if (!matches || !row) return { rows: [], rowCount: 0 };
        row.resume_state = 'claimed';
        return { rows: [{ command_id: row.command_id }], rowCount: 1 };
      }

      if (sql.includes("SET resume_state = 'completed'")) {
        if (failures.resumeResultWrites > 0) {
          failures.resumeResultWrites -= 1;
          throw new Error('pg_resume_receipt_write_failed:relation=risk_command_outcome');
        }
        const row = outcomes.get(Number(params[0]));
        const matches =
          row?.execution_target === String(params[1]) &&
          row.env_key === String(params[2]) &&
          row.account_id === String(params[3]) &&
          row.state === 'applied' &&
          row.resume_state === 'claimed';
        if (!matches || !row) return { rows: [], rowCount: 0 };
        row.resume_state = 'completed';
        row.resumed_edges = Number(params[4]);
        row.resume_failure = params[5] === null ? null : String(params[5]);
        return { rows: [{ command_id: row.command_id }], rowCount: 1 };
      }

      if (sql.includes("command_kind = 'recoverRestricted'") && sql.includes('LIMIT 1')) {
        const row = outcomes.get(Number(params[0]));
        const matches =
          row?.execution_target === String(params[1]) &&
          row.command_kind === 'recoverRestricted';
        return { rows: matches ? [{ command_id: row.command_id }] : [], rowCount: matches ? 1 : 0 };
      }

      if (sql.includes("command_kind = 'recoverRestricted'") && sql.includes('FROM risk_command_outcome')) {
        const row = outcomes.get(Number(params[0]));
        const matches =
          row?.execution_target === String(params[1]) &&
          row.env_key === String(params[2]) &&
          row.account_id === String(params[3]) &&
          row.command_kind === 'recoverRestricted';
        return { rows: matches ? [row] : [], rowCount: matches ? 1 : 0 };
      }

      if (sql.includes('FROM event_outbox')) {
        const row = outbox.find(
          (candidate) =>
            candidate.id === Number(params[0]) &&
            candidate.topic === String(params[1]) &&
            candidate.target === String(params[2]) &&
            candidate.payload.envKey === params[3] &&
            candidate.payload.accountId === params[4] &&
            candidate.payload.kind === 'recoverRestricted',
        );
        return { rows: row ? [{ id: row.id }] : [], rowCount: row ? 1 : 0 };
      }

      throw new Error(`unexpected SQL: ${sql.replace(/\s+/g, ' ').slice(0, 140)}`);
    },
  };
  return { pool: pool as never, outbox, outcomes, failures };
}

function riskState(accountId: string, status: RiskState['status'] = 'normal'): RiskState {
  return {
    accountId,
    status,
    quotaLevel: 'normal',
    signalCount: 3,
    lastSignalAt: 120,
    statusSince: 200,
    updatedAt: 300,
  };
}

function controllerFor(
  state: RiskState,
  recovery:
    | { accepted: true; changed: boolean }
    | { accepted: false; refusal: 'state_not_restricted'; changed: false },
  events: string[] = [],
): RiskCommandController {
  return {
    async applySignal() {
      return state;
    },
    async setQuotaLevel() {
      return state;
    },
    async recoverRestricted() {
      events.push('recover');
      return { ...recovery, state };
    },
    getState() {
      return state;
    },
  };
}

const silent = { warn() {} };

test('restricted recovery 提交使用专用命令，结果按 target + env + account 隔离', async () => {
  const { pool, outbox, outcomes } = makeFakePool();
  const dev = new PgRiskCommandService({ pool, executionTarget: 'dev', logger: silent });
  const ol = new PgRiskCommandService({ pool, executionTarget: 'ol', logger: silent });

  const accepted = await dev.submitRestrictedRecovery({
    envKey: 'env-1',
    accountId: 'acc-1',
    reason: 'customer recovery',
    requestedBy: 'customer:env-1',
  });

  assert.deepEqual(outbox[0]?.payload, {
    kind: 'recoverRestricted',
    envKey: 'env-1',
    accountId: 'acc-1',
    reason: 'customer recovery',
  });
  assert.deepEqual(await dev.restrictedRecoveryOutcomeOf(accepted.commandId, 'env-1', 'acc-1'), {
    commandId: accepted.commandId,
    state: 'processing',
  });
  assert.equal((await dev.restrictedRecoveryOutcomeOf(accepted.commandId, 'env-2', 'acc-1')).state, 'unknown');
  assert.equal((await dev.restrictedRecoveryOutcomeOf(accepted.commandId, 'env-1', 'acc-2')).state, 'unknown');
  assert.equal((await ol.restrictedRecoveryOutcomeOf(accepted.commandId, 'env-1', 'acc-1')).state, 'unknown');

  outcomes.get(Number(accepted.commandId))!.env_key = null;
  assert.equal(
    (await dev.restrictedRecoveryOutcomeOf(accepted.commandId, 'env-1', 'acc-1')).state,
    'unknown',
    '缺 envKey 的旧账本行不得借 outbox payload 猜成 processing',
  );
});

test('recovery 账本分别保留 applied/refused/failed 与 Edge resume failure', async () => {
  const { pool } = makeFakePool();
  const service = new PgRiskCommandService({ pool, executionTarget: 'dev', logger: silent });
  const applied = await service.submitRestrictedRecovery({
    envKey: 'env-applied',
    accountId: 'acc-applied',
    reason: 'recover',
    requestedBy: 'customer:env',
  });
  await service.markRestrictedRecoveryApplying(
    Number(applied.commandId),
    'env-applied',
    'acc-applied',
  );
  await service.recordRestrictedRecoveryAppliedDomain(
    Number(applied.commandId),
    'env-applied',
    'acc-applied',
    riskState('acc-applied'),
    true,
  );
  await service.claimRestrictedRecoveryResume(Number(applied.commandId), 'env-applied', 'acc-applied');
  await service.recordRestrictedRecoveryResumeResult(
    Number(applied.commandId),
    'env-applied',
    'acc-applied',
    { resumedEdges: 0, resumeError: 'edge_resume_failed' },
  );
  assert.deepEqual(await service.restrictedRecoveryOutcomeOf(applied.commandId, 'env-applied', 'acc-applied'), {
    commandId: applied.commandId,
    state: 'applied',
    risk: riskState('acc-applied'),
    changed: true,
    resumedEdges: 0,
    resumeError: 'edge_resume_failed',
  });

  const refused = await service.submitRestrictedRecovery({
    envKey: 'env-refused',
    accountId: 'acc-refused',
    reason: 'recover',
    requestedBy: 'customer:env',
  });
  await service.markRestrictedRecoveryApplying(Number(refused.commandId), 'env-refused', 'acc-refused');
  await service.recordRestrictedRecoveryRefused(
    Number(refused.commandId),
    'env-refused',
    'acc-refused',
    riskState('acc-refused', 'warned'),
    'state_not_restricted',
  );
  assert.deepEqual(await service.restrictedRecoveryOutcomeOf(refused.commandId, 'env-refused', 'acc-refused'), {
    commandId: refused.commandId,
    state: 'refused',
    reason: 'state_not_restricted',
    risk: riskState('acc-refused', 'warned'),
  });

  const failed = await service.submitRestrictedRecovery({
    envKey: 'env-failed',
    accountId: 'acc-failed',
    reason: 'recover',
    requestedBy: 'customer:env',
  });
  await service.markRestrictedRecoveryApplying(Number(failed.commandId), 'env-failed', 'acc-failed');
  await service.recordRestrictedRecoveryFailed(
    Number(failed.commandId),
    'env-failed',
    'acc-failed',
    'recovery_application_failed',
  );
  assert.deepEqual(await service.restrictedRecoveryOutcomeOf(failed.commandId, 'env-failed', 'acc-failed'), {
    commandId: failed.commandId,
    state: 'failed',
    reason: 'recovery_application_failed',
  });
});

test('consumer 应用器只在写后 normal 恢复 Edge；refused 正常返回且不堵 cursor', async () => {
  const { pool } = makeFakePool();
  const service = new PgRiskCommandService({ pool, executionTarget: 'dev', logger: silent });
  const events: string[] = [];
  const controllers = new Map<string, RiskCommandController>([
    ['acc-ok', controllerFor(riskState('acc-ok'), { accepted: true, changed: true }, events)],
    [
      'acc-refused',
      controllerFor(
        riskState('acc-refused', 'frozen'),
        { accepted: false, refusal: 'state_not_restricted', changed: false },
        events,
      ),
    ],
  ]);
  const apply = createRiskCommandApplyHandler({
    service,
    async getController(accountId) {
      const controller = controllers.get(accountId);
      if (!controller) throw new Error('missing_controller');
      return controller;
    },
    resumeEdgesForAccount(accountId) {
      events.push(`resume:${accountId}`);
      return 2;
    },
  });

  const ok = await service.submitRestrictedRecovery({
    envKey: 'env-ok',
    accountId: 'acc-ok',
    reason: 'recover',
    requestedBy: 'customer:env',
  });
  await apply(
    { kind: 'recoverRestricted', envKey: 'env-ok', accountId: 'acc-ok', reason: 'recover' },
    Number(ok.commandId),
  );
  assert.deepEqual(events, ['recover', 'resume:acc-ok']);
  assert.equal((await service.restrictedRecoveryOutcomeOf(ok.commandId, 'env-ok', 'acc-ok')).state, 'applied');

  events.length = 0;
  const refused = await service.submitRestrictedRecovery({
    envKey: 'env-refused',
    accountId: 'acc-refused',
    reason: 'recover',
    requestedBy: 'customer:env',
  });
  await apply(
    { kind: 'recoverRestricted', envKey: 'env-refused', accountId: 'acc-refused', reason: 'recover' },
    Number(refused.commandId),
  );
  assert.deepEqual(events, ['recover']);
  assert.equal(
    (await service.restrictedRecoveryOutcomeOf(refused.commandId, 'env-refused', 'acc-refused')).state,
    'refused',
  );
});

test('Edge resume 抛错仍记录 applied normal 与具名失败，不倒写领域失败', async () => {
  const { pool } = makeFakePool();
  const service = new PgRiskCommandService({ pool, executionTarget: 'dev', logger: silent });
  const apply = createRiskCommandApplyHandler({
    service,
    async getController() {
      return controllerFor(riskState('acc-1'), { accepted: true, changed: true });
    },
    resumeEdgesForAccount() {
      throw new Error('edge_resume_broken');
    },
  });
  const accepted = await service.submitRestrictedRecovery({
    envKey: 'env-1',
    accountId: 'acc-1',
    reason: 'recover',
    requestedBy: 'customer:env',
  });

  await apply(
    { kind: 'recoverRestricted', envKey: 'env-1', accountId: 'acc-1', reason: 'recover' },
    Number(accepted.commandId),
  );
  const outcome = await service.restrictedRecoveryOutcomeOf(accepted.commandId, 'env-1', 'acc-1');
  assert.equal(outcome.state, 'applied');
  assert.equal(outcome.state === 'applied' && outcome.risk.status, 'normal');
  assert.equal(outcome.state === 'applied' && outcome.resumeError, 'edge_resume_failed');
});

test('domain applied outcome 落账失败时记录稳定 failed，绝不恢复 Edge', async () => {
  const { pool, failures } = makeFakePool();
  failures.appliedDomainWrites = 1;
  const service = new PgRiskCommandService({ pool, executionTarget: 'dev', logger: silent });
  const events: string[] = [];
  const warnings: string[] = [];
  const apply = createRiskCommandApplyHandler({
    service,
    async getController() {
      return controllerFor(riskState('acc-1'), { accepted: true, changed: true }, events);
    },
    resumeEdgesForAccount() {
      events.push('resume');
      return 1;
    },
    logger: { warn: (line) => warnings.push(String(line)) },
  });
  const accepted = await service.submitRestrictedRecovery({
    envKey: 'env-1',
    accountId: 'acc-1',
    reason: 'recover',
    requestedBy: 'customer:env-1',
  });

  await apply(
    { kind: 'recoverRestricted', envKey: 'env-1', accountId: 'acc-1', reason: 'recover' },
    Number(accepted.commandId),
  );

  assert.deepEqual(events, ['recover']);
  assert.deepEqual(await service.restrictedRecoveryOutcomeOf(accepted.commandId, 'env-1', 'acc-1'), {
    commandId: accepted.commandId,
    state: 'failed',
    reason: 'recovery_result_recording_failed',
  });
  assert.ok(warnings.some((line) => line.includes('pg_applied_domain_write_failed')));
});

test('resume 回执落账失败后重放不再次 resume，以稳定 unknown 结果收口', async () => {
  const { pool, failures } = makeFakePool();
  failures.resumeResultWrites = 1;
  const service = new PgRiskCommandService({ pool, executionTarget: 'dev', logger: silent });
  const events: string[] = [];
  const apply = createRiskCommandApplyHandler({
    service,
    async getController() {
      return controllerFor(riskState('acc-1'), { accepted: true, changed: true }, events);
    },
    resumeEdgesForAccount() {
      events.push('resume');
      return 2;
    },
    logger: silent,
  });
  const accepted = await service.submitRestrictedRecovery({
    envKey: 'env-1',
    accountId: 'acc-1',
    reason: 'recover',
    requestedBy: 'customer:env-1',
  });
  const command = {
    kind: 'recoverRestricted' as const,
    envKey: 'env-1',
    accountId: 'acc-1',
    reason: 'recover',
  };

  await assert.rejects(apply(command, Number(accepted.commandId)), /pg_resume_receipt_write_failed/);
  assert.deepEqual(events, ['recover', 'resume']);
  assert.equal(
    await service.restrictedRecoveryStageOf(Number(accepted.commandId), 'env-1', 'acc-1'),
    'applied_resume_claimed',
  );

  await apply(command, Number(accepted.commandId));
  assert.deepEqual(events, ['recover', 'resume'], 'claimed 重放不得再次恢复 Edge');
  assert.deepEqual(await service.restrictedRecoveryOutcomeOf(accepted.commandId, 'env-1', 'acc-1'), {
    commandId: accepted.commandId,
    state: 'applied',
    risk: riskState('acc-1'),
    changed: true,
    resumedEdges: 0,
    resumeError: 'edge_resume_result_unknown',
  });
});

test('controller 原始错误仅进 server log，客户 outcome 只保留稳定公共码', async () => {
  const { pool } = makeFakePool();
  const service = new PgRiskCommandService({ pool, executionTarget: 'dev', logger: silent });
  const warnings: string[] = [];
  const apply = createRiskCommandApplyHandler({
    service,
    async getController() {
      return {
        ...controllerFor(riskState('acc-1'), { accepted: true, changed: true }),
        async recoverRestricted() {
          throw new Error('relation aidcp_automation.risk_state does not exist');
        },
      };
    },
    resumeEdgesForAccount() {
      throw new Error('must_not_resume');
    },
    logger: { warn: (line) => warnings.push(String(line)) },
  });
  const accepted = await service.submitRestrictedRecovery({
    envKey: 'env-1',
    accountId: 'acc-1',
    reason: 'recover',
    requestedBy: 'customer:env-1',
  });

  await apply(
    { kind: 'recoverRestricted', envKey: 'env-1', accountId: 'acc-1', reason: 'recover' },
    Number(accepted.commandId),
  );

  const outcome = await service.restrictedRecoveryOutcomeOf(accepted.commandId, 'env-1', 'acc-1');
  assert.deepEqual(outcome, {
    commandId: accepted.commandId,
    state: 'failed',
    reason: 'recovery_application_failed',
  });
  assert.ok(warnings.some((line) => line.includes('aidcp_automation.risk_state')));
  assert.doesNotMatch(JSON.stringify(outcome), /aidcp_automation|relation/);
});

test('applied recovery 的 NULL/非法 resume_state 稳定失败，不递归 claim 或恢复 Edge', async () => {
  for (const resumeState of [null, 'legacy_invalid']) {
    const { pool, outcomes } = makeFakePool();
    const service = new PgRiskCommandService({ pool, executionTarget: 'dev', logger: silent });
    const accepted = await service.submitRestrictedRecovery({
      envKey: 'env-1',
      accountId: 'acc-1',
      reason: 'recover',
      requestedBy: 'customer:env-1',
    });
    const row = outcomes.get(Number(accepted.commandId))!;
    const state = riskState('acc-1');
    Object.assign(row, {
      state: 'applied',
      status: state.status,
      quota_level: state.quotaLevel,
      signal_count: state.signalCount,
      last_signal_at: state.lastSignalAt,
      status_since: state.statusSince,
      state_updated_at: state.updatedAt,
      recovery_changed: true,
      resume_state: resumeState,
    });
    let controllerReads = 0;
    let resumeCalls = 0;
    const apply = createRiskCommandApplyHandler({
      service,
      async getController() {
        controllerReads += 1;
        return controllerFor(state, { accepted: true, changed: false });
      },
      resumeEdgesForAccount() {
        resumeCalls += 1;
        return 1;
      },
      logger: silent,
    });

    assert.equal(
      await service.restrictedRecoveryStageOf(Number(accepted.commandId), 'env-1', 'acc-1'),
      'applied_resume_incomplete',
    );
    assert.deepEqual(await service.restrictedRecoveryOutcomeOf(accepted.commandId, 'env-1', 'acc-1'), {
      commandId: accepted.commandId,
      state: 'failed',
      reason: 'recovery_outcome_incomplete',
    });
    await apply(
      { kind: 'recoverRestricted', envKey: 'env-1', accountId: 'acc-1', reason: 'recover' },
      Number(accepted.commandId),
    );
    assert.equal(controllerReads, 0);
    assert.equal(resumeCalls, 0);
  }
});

test('非法 execution target 在任何 outbox/owner 写前失败', () => {
  const { pool } = makeFakePool();
  assert.throws(
    () => new PgRiskCommandService({ pool, executionTarget: 'staging', logger: silent }),
    /risk_command_invalid_execution_target:staging/,
  );
});
