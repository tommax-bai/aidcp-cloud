import assert from 'node:assert/strict';
import { test } from 'node:test';
import type pg from 'pg';
import {
  OffboardAdmissionLedgerError,
  PgOffboardAdmissionLedger,
} from '../src/client-auth/offboard-admission-ledger.js';

interface StoredCommand {
  capability: string;
  payload_hash: string;
  receipt: unknown;
}

interface StoredSnapshot {
  observed_at_ms: number;
  snapshot_digest: string;
  receipt: unknown;
}

function ledgerPool(options: {
  adopted?: number;
  released?: number;
  claimRows?: unknown[];
  admissionRow?: unknown;
  updatedRevision?: number;
  unassignedEnvKey?: string;
} = {}): {
  pool: pg.Pool;
  statements: Array<{ sql: string; params: unknown[] }>;
  commands: Map<string, StoredCommand>;
  snapshots: Map<string, StoredSnapshot>;
} {
  const statements: Array<{ sql: string; params: unknown[] }> = [];
  const commands = new Map<string, StoredCommand>();
  const snapshots = new Map<string, StoredSnapshot>();
  const client = {
    query: async (sql: string, params: unknown[] = []) => {
      statements.push({ sql, params });
      if (
        sql.includes('FROM client_env_revocation_holds')
        && sql.includes('WHERE execution_target IS NULL')
      ) {
        return {
          rows: options.unassignedEnvKey ? [{ env_key: options.unassignedEnvKey }] : [],
          rowCount: options.unassignedEnvKey ? 1 : 0,
        };
      }
      if (sql.includes('FROM client_env_admission_command_receipts')) {
        const row = commands.get(`${String(params[0])}:${String(params[1])}`);
        return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
      }
      if (sql.includes('INSERT INTO client_env_admission_command_receipts')) {
        commands.set(`${String(params[0])}:${String(params[1])}`, {
          capability: String(params[2]),
          payload_hash: String(params[3]),
          receipt: JSON.parse(String(params[4])),
        });
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes('FROM client_env_admission_snapshot_state')) {
        const row = snapshots.get(String(params[0]));
        return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
      }
      if (sql.includes('INSERT INTO client_env_admission_snapshot_state')) {
        snapshots.set(String(params[0]), {
          observed_at_ms: Number(params[1]),
          snapshot_digest: String(params[2]),
          receipt: JSON.parse(String(params[3])),
        });
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes('INSERT INTO client_env_revocation_holds')) {
        return { rows: [], rowCount: options.adopted ?? 0 };
      }
      if (sql.includes('DELETE FROM client_env_revocation_holds')) {
        return { rows: [], rowCount: options.released ?? 0 };
      }
      if (sql.includes('WITH due AS')) {
        return { rows: options.claimRows ?? [], rowCount: options.claimRows?.length ?? 0 };
      }
      if (sql.includes('SELECT offboard_id,materialized_at,claim_token,admission_revision')) {
        return {
          rows: options.admissionRow ? [options.admissionRow] : [],
          rowCount: options.admissionRow ? 1 : 0,
        };
      }
      if (sql.includes('UPDATE client_env_revocation_holds') && sql.includes('RETURNING admission_revision')) {
        return options.updatedRevision === undefined
          ? { rows: [], rowCount: 0 }
          : { rows: [{ admission_revision: options.updatedRevision }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    },
    release: () => undefined,
  };
  return {
    pool: { connect: async () => client } as unknown as pg.Pool,
    statements,
    commands,
    snapshots,
  };
}

test('offboard snapshot: complete 真快照原子 adopt/release，同 commandId 返回原 counts', async () => {
  const db = ledgerPool({ adopted: 1, released: 2 });
  const ledger = new PgOffboardAdmissionLedger(db.pool, 'dev');
  const input = {
    commandId: 'snapshot-1',
    complete: true as const,
    observedAt: 1_000,
    rows: [{
      offboardId: 'offboard-1',
      envKey: 'env-1',
      reason: 'admin_revoked' as const,
      requestedAt: 500,
    }],
  };

  assert.deepEqual(await ledger.reconcileActiveOffboardSnapshot(input), {
    outcome: 'applied',
    adopted: 1,
    released: 2,
  });
  assert.deepEqual(await ledger.reconcileActiveOffboardSnapshot(input), {
    outcome: 'duplicate',
    adopted: 1,
    released: 2,
  });
  assert.equal(
    db.statements.filter((entry) => entry.sql.includes('INSERT INTO client_env_revocation_holds')).length,
    1,
    'duplicate command must not adopt twice',
  );
  await assert.rejects(
    () => ledger.reconcileActiveOffboardSnapshot({
      ...input,
      rows: [{ ...input.rows[0], offboardId: 'different' }],
    }),
    (error: unknown) =>
      error instanceof OffboardAdmissionLedgerError
      && error.code === 'offboard_admission_command_collision',
  );
});

test('offboard snapshot: 不接受未证明完整的快照，避免假空释放全部 admission', async () => {
  const db = ledgerPool();
  const ledger = new PgOffboardAdmissionLedger(db.pool, 'dev');
  await assert.rejects(
    () => ledger.reconcileActiveOffboardSnapshot({
      commandId: 'snapshot-incomplete',
      complete: false,
      observedAt: 1_000,
      rows: [],
    } as never),
    /explicitly complete/,
  );
  assert.ok(!db.statements.some((entry) => entry.sql.includes('DELETE FROM client_env_revocation_holds')));
});

test('offboard snapshot: target/capability cursor 单调，旧空快照拒绝、同 cursor 异 digest collision', async () => {
  const db = ledgerPool({ adopted: 1, released: 2 });
  const ledger = new PgOffboardAdmissionLedger(db.pool, 'dev');
  const current = {
    commandId: 'snapshot-current',
    complete: true as const,
    observedAt: 2_000,
    rows: [{
      offboardId: 'offboard-1',
      envKey: 'env-1',
      reason: 'admin_revoked' as const,
      requestedAt: 500,
    }],
  };

  assert.equal((await ledger.reconcileActiveOffboardSnapshot(current)).outcome, 'applied');
  assert.deepEqual(
    await ledger.reconcileActiveOffboardSnapshot({
      ...current,
      commandId: 'snapshot-current-reordered-equivalent',
      rows: [...current.rows].reverse(),
    }),
    { outcome: 'duplicate', adopted: 1, released: 2 },
  );
  const deletesBeforeRejectedSnapshots = db.statements.filter(
    (entry) => entry.sql.includes('DELETE FROM client_env_revocation_holds'),
  ).length;

  await assert.rejects(
    () => ledger.reconcileActiveOffboardSnapshot({
      commandId: 'snapshot-old-empty',
      complete: true,
      observedAt: 1_999,
      rows: [],
    }),
    (error: unknown) =>
      error instanceof OffboardAdmissionLedgerError
      && error.code === 'offboard_admission_stale_snapshot',
  );
  await assert.rejects(
    () => ledger.reconcileActiveOffboardSnapshot({
      ...current,
      commandId: 'snapshot-collision',
      rows: [{ ...current.rows[0], offboardId: 'different' }],
    }),
    (error: unknown) =>
      error instanceof OffboardAdmissionLedgerError
      && error.code === 'offboard_admission_snapshot_collision',
  );
  assert.equal(
    db.statements.filter(
      (entry) => entry.sql.includes('DELETE FROM client_env_revocation_holds'),
    ).length,
    deletesBeforeRejectedSnapshots,
    'rejected stale/colliding snapshots must not release holds',
  );
  assert.ok(
    db.statements.some(
      (entry) =>
        entry.sql.includes('pg_advisory_xact_lock')
        && entry.params[0]
          === 'offboard-admission-capability|dev|reconcile_snapshot',
    ),
    'all complete snapshots must serialize on the target/capability key',
  );
});

test('offboard command receipt 与 advisory lock 按 execution_target 隔离', async () => {
  const db = ledgerPool();
  const dev = new PgOffboardAdmissionLedger(db.pool, 'dev');
  const ol = new PgOffboardAdmissionLedger(db.pool, 'ol');
  const input = {
    commandId: 'same-command',
    complete: true as const,
    observedAt: 1_000,
    rows: [],
  };
  assert.equal((await dev.reconcileActiveOffboardSnapshot(input)).outcome, 'applied');
  assert.equal((await ol.reconcileActiveOffboardSnapshot(input)).outcome, 'applied');
  assert.equal(db.commands.size, 2);
  const advisoryKeys = db.statements
    .filter((entry) => entry.sql.includes('pg_advisory_xact_lock'))
    .map((entry) => entry.params[0]);
  assert.deepEqual(advisoryKeys, [
    'offboard-admission-capability|dev|reconcile_snapshot',
    'offboard-admission-command|dev|same-command',
    'offboard-admission-capability|ol|reconcile_snapshot',
    'offboard-admission-command|ol|same-command',
  ]);
  const releases = db.statements.filter((entry) => entry.sql.includes('DELETE FROM client_env_revocation_holds'));
  assert.deepEqual(releases.map((entry) => entry.params[1]), ['dev', 'ol']);
});

test('offboard claim: 持久 revision/token/expiry，并在 ACK 重放时返回原 candidate', async () => {
  const requestedAt = new Date(900);
  const claimExpiresAt = new Date(6_000);
  const db = ledgerPool({
    claimRows: [{
      revocation_id: 'rev-1',
      offboard_id: 'offboard-1',
      env_key: 'env-1',
      user_id: null,
      reason: 'environment_unbind',
      revoked_by: 'operator',
      unbound_terminal_ok: false,
      requested_at: requestedAt,
      claim_token: 'claim-token-1',
      admission_revision: '2',
      claim_expires_at: claimExpiresAt,
    }],
  });
  const ledger = new PgOffboardAdmissionLedger(db.pool, 'dev');
  const input = {
    commandId: 'claim-command-1',
    workerId: 'automation-dev-1',
    limit: 10,
    now: 1_000,
    leaseMs: 5_000,
  };
  const expected = {
    outcome: 'applied' as const,
    candidates: [{
      revocationId: 'rev-1',
      offboardId: 'offboard-1',
      envKey: 'env-1',
      userId: null,
      reason: 'environment_unbind' as const,
      actor: 'operator',
      unboundTerminalAllowed: false,
      requestedAt: 900,
      claimToken: 'claim-token-1',
      revision: 2,
      claimExpiresAt: 6_000,
    }],
  };
  assert.deepEqual(await ledger.claimPendingMaterializations(input), expected);
  assert.deepEqual(await ledger.claimPendingMaterializations(input), {
    ...expected,
    outcome: 'duplicate',
  });
  const claimSql = db.statements.find((entry) => entry.sql.includes('WITH due AS'))?.sql ?? '';
  assert.match(claimSql, /FOR UPDATE SKIP LOCKED/);
  assert.match(claimSql, /admission_revision=h\.admission_revision\+1/);
  assert.match(claimSql, /claim_expires_at IS NULL OR claim_expires_at <= clock_timestamp\(\)/);
  assert.match(claimSql, /claim_expires_at=clock_timestamp\(\) \+ \(\$4 \* interval '1 millisecond'\)/);
  const claimStatement = db.statements.find((entry) => entry.sql.includes('WITH due AS'));
  assert.deepEqual(
    claimStatement?.params,
    [10, 'automation-dev-1', 'claim-command-1', 30_000, 'dev'],
    'caller now/leaseMs must not control server claim timing',
  );
});

test('offboard reconcile/claim: 遗留 NULL target 具名阻断，绝不静默跳过或写 command receipt', async () => {
  const db = ledgerPool({ unassignedEnvKey: 'env-legacy-null-target' });
  const ledger = new PgOffboardAdmissionLedger(db.pool, 'dev');

  await assert.rejects(
    () => ledger.reconcileActiveOffboardSnapshot({
      commandId: 'snapshot-after-legacy-row',
      complete: true,
      observedAt: 1_000,
      rows: [],
    }),
    (error: unknown) =>
      error instanceof OffboardAdmissionLedgerError
      && error.code === 'offboard_admission_execution_target_unassigned'
      && error.message.includes('env-legacy-null-target'),
  );
  await assert.rejects(
    () => ledger.claimPendingMaterializations({
      commandId: 'claim-after-legacy-row',
      workerId: 'automation-dev-1',
      limit: 10,
      now: 1_000,
      leaseMs: 5_000,
    }),
    (error: unknown) =>
      error instanceof OffboardAdmissionLedgerError
      && error.code === 'offboard_admission_execution_target_unassigned',
  );

  assert.ok(!db.statements.some((entry) => entry.sql.includes('DELETE FROM client_env_revocation_holds')));
  assert.ok(!db.statements.some((entry) => entry.sql.includes('WITH due AS')));
  assert.equal(db.commands.size, 0);
});

test('offboard receipt: claim token + revision CAS；materialized 与 stale/collision 保持可区分', async () => {
  const db = ledgerPool({
    admissionRow: {
      offboard_id: 'offboard-1',
      materialized_at: null,
      claim_token: 'claim-token-1',
      admission_revision: 2,
    },
    updatedRevision: 3,
  });
  const ledger = new PgOffboardAdmissionLedger(db.pool, 'dev');
  const appliedInput = {
    commandId: 'receipt-command-1',
    revocationId: 'rev-1',
    claimToken: 'claim-token-1',
    expectedRevision: 2,
    result: {
      kind: 'materialized' as const,
      offboardId: 'offboard-1',
      materializedAt: 2_000,
    },
  };
  assert.deepEqual(await ledger.recordMaterializationReceipt(appliedInput), {
    outcome: 'applied',
    revision: 3,
  });
  assert.deepEqual(await ledger.recordMaterializationReceipt(appliedInput), {
    outcome: 'duplicate',
    revision: 3,
  });

  const stale = new PgOffboardAdmissionLedger(ledgerPool({
    admissionRow: {
      offboard_id: 'offboard-1',
      materialized_at: null,
      claim_token: 'another-token',
      admission_revision: 4,
    },
  }).pool, 'dev');
  assert.deepEqual(await stale.recordMaterializationReceipt({
    ...appliedInput,
    commandId: 'receipt-stale',
  }), { outcome: 'stale', revision: 4 });

  const collision = new PgOffboardAdmissionLedger(ledgerPool({
    admissionRow: {
      offboard_id: 'offboard-original',
      materialized_at: null,
      claim_token: 'claim-token-1',
      admission_revision: 2,
    },
  }).pool, 'dev');
  assert.deepEqual(await collision.recordMaterializationReceipt({
    ...appliedInput,
    commandId: 'receipt-collision',
  }), { outcome: 'collision', revision: 2 });
});

test('offboard binding_missing: admission 保持 pending，CAS 后立即释放 claim 三元组', async () => {
  const db = ledgerPool({
    admissionRow: {
      offboard_id: 'offboard-1',
      materialized_at: null,
      claim_token: 'claim-token-1',
      admission_revision: 2,
    },
    updatedRevision: 3,
  });
  const ledger = new PgOffboardAdmissionLedger(db.pool, 'dev');
  assert.deepEqual(await ledger.recordMaterializationReceipt({
    commandId: 'receipt-binding-missing',
    revocationId: 'rev-1',
    claimToken: 'claim-token-1',
    expectedRevision: 2,
    result: { kind: 'binding_missing' },
  }), { outcome: 'applied', revision: 3 });

  const update = db.statements.find(
    (entry) =>
      entry.sql.includes('UPDATE client_env_revocation_holds')
      && entry.sql.includes('RETURNING admission_revision'),
  );
  assert.ok(update);
  assert.equal(update!.params[1], null, 'binding_missing 不写 materialized_at');
  assert.equal(update!.params[4], 'binding_missing');
  assert.equal(update!.params[5], 'dev');
  assert.match(update!.sql, /claim_token=NULL/);
  assert.match(update!.sql, /claimed_by=NULL/);
  assert.match(update!.sql, /claim_expires_at=NULL/);
  assert.ok(
    !db.statements.some((entry) => entry.sql.includes('DELETE FROM client_env_revocation_holds')),
    'binding_missing 不删除 admission',
  );
});
