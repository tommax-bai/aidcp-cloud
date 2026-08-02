import assert from 'node:assert/strict';
import { test } from 'node:test';
import type {
  ClaimPendingMaterializationsOutcome,
  OffboardAdmissionLedgerPort,
  ReconcileActiveOffboardSnapshotInput,
  RecordMaterializationReceiptInput,
  RecordMaterializationReceiptOutcome,
} from '../../src/kernel/api-direct-port.js';
import type { OffboardProjection } from '../../src/kernel/client-env-automation-types.js';
import type {
  MaterializeEnvironmentOffboardInput,
  MaterializeEnvironmentOffboardOutcome,
} from '../../src/kernel/offboard-materialization-types.js';
import {
  AutomationOffboardAdmissionReconciler,
  OffboardAdmissionReconcileIncompleteError,
} from '../../src/interactions/offboard-admission-reconciler.js';

const ACTIVE: OffboardProjection = {
  offboardId: 'active-offboard',
  envKey: 'active-env',
  accountId: 'active-account',
  state: 'pending_edge',
  reason: 'admin_revoked',
  requestedAt: 1_000,
  purgeDueAt: 3_000,
};

const CANDIDATES: ClaimPendingMaterializationsOutcome['candidates'] = [
  {
    revocationId: 'rev-1',
    offboardId: 'offboard-1',
    envKey: 'env-1',
    userId: 'user-1',
    reason: 'admin_revoked',
    actor: 'admin',
    unboundTerminalAllowed: false,
    requestedAt: 1_100,
    claimToken: 'claim-1',
    revision: 2,
    claimExpiresAt: 32_000,
  },
  {
    revocationId: 'rev-2',
    offboardId: 'offboard-2',
    envKey: 'env-2',
    userId: null,
    reason: 'customer_terminated',
    actor: null,
    unboundTerminalAllowed: false,
    requestedAt: 1_200,
    claimToken: 'claim-2',
    revision: 4,
    claimExpiresAt: 32_000,
  },
];

interface HarnessOptions {
  active?: () => Promise<OffboardProjection[]>;
  snapshot?: (
    input: ReconcileActiveOffboardSnapshotInput,
  ) => Promise<Awaited<ReturnType<OffboardAdmissionLedgerPort['reconcileActiveOffboardSnapshot']>>>;
  claim?: ClaimPendingMaterializationsOutcome;
  claimCall?: (
    input: Parameters<OffboardAdmissionLedgerPort['claimPendingMaterializations']>[0],
  ) => Promise<ClaimPendingMaterializationsOutcome>;
  materialize?: (
    input: MaterializeEnvironmentOffboardInput,
  ) => Promise<MaterializeEnvironmentOffboardOutcome>;
  receipt?: (
    input: RecordMaterializationReceiptInput,
  ) => Promise<RecordMaterializationReceiptOutcome>;
}

function harness(options: HarnessOptions = {}) {
  const calls: string[] = [];
  const snapshots: ReconcileActiveOffboardSnapshotInput[] = [];
  const claims: Parameters<OffboardAdmissionLedgerPort['claimPendingMaterializations']>[0][] = [];
  const receipts: RecordMaterializationReceiptInput[] = [];
  const materializations: MaterializeEnvironmentOffboardInput[] = [];
  // 只实现写面：对账循环从不问撤权 hold，依赖声明也已按 `Omit` 收窄
  // —— 伪造一个永远不会被调到的方法，只会让「看着接好了」多一处来源。
  const ledger: Omit<OffboardAdmissionLedgerPort, 'hasPendingRevocationHold'> = {
    async reconcileActiveOffboardSnapshot(input) {
      calls.push('snapshot');
      snapshots.push(input);
      return options.snapshot?.(input) ?? { outcome: 'applied', adopted: 2, released: 1 };
    },
    async claimPendingMaterializations(input) {
      calls.push('claim');
      claims.push(input);
      return options.claimCall?.(input)
        ?? options.claim
        ?? { outcome: 'applied', candidates: CANDIDATES };
    },
    async recordMaterializationReceipt(input) {
      calls.push(`receipt:${input.revocationId}`);
      receipts.push(input);
      return options.receipt?.(input) ?? { outcome: 'applied', revision: input.expectedRevision + 1 };
    },
  };
  const reconciler = new AutomationOffboardAdmissionReconciler({
    workerId: 'offboard-reconcile-dev',
    automationRead: {
      async activeWechatOffboards() {
        calls.push('active');
        return options.active?.() ?? [ACTIVE];
      },
    },
    materializationOps: {
      async materializeEnvironmentOffboard(input) {
        calls.push(`materialize:${input.offboardId}`);
        materializations.push(input);
        return options.materialize?.(input) ?? (
          input.offboardId === 'offboard-1'
            ? {
                materialized: true,
                offboard: {
                  offboardId: input.offboardId,
                  envKey: input.envKey,
                  accountId: 'account-1',
                  state: 'pending_edge',
                  reason: input.reason,
                  requestedAt: 2_000,
                  purgeDueAt: 4_000,
                },
              }
            : { materialized: false, reason: 'binding_missing' }
        );
      },
    },
    admissionLedger: ledger,
  });
  return {
    reconciler,
    calls,
    snapshots,
    claims,
    receipts,
    materializations,
  };
}

test('完整快照 → API reconcile/claim → 逐条本地物化 → API receipt，返回真实计数与可派发投影', async () => {
  const h = harness({
    receipt: async (input) => (
      input.revocationId === 'rev-1'
        ? { outcome: 'applied', revision: 3 }
        : { outcome: 'duplicate', revision: 5 }
    ),
  });
  const result = await h.reconciler.reconcile({ commandId: 'round-1', now: 2_000 });

  assert.deepEqual(h.calls, [
    'active',
    'snapshot',
    'claim',
    'materialize:offboard-1',
    'receipt:rev-1',
    'materialize:offboard-2',
    'receipt:rev-2',
  ]);
  assert.deepEqual(result, {
    outcome: 'completed',
    snapshotOutcome: 'applied',
    claimOutcome: 'applied',
    counts: {
      adopted: 2,
      released: 1,
      claimed: 2,
      ownerMaterialized: 1,
      bindingMissing: 1,
      receiptsApplied: 1,
      receiptsDuplicate: 1,
      receiptsStale: 0,
      receiptsCollision: 0,
    },
    materializedOffboards: [{
      offboardId: 'offboard-1',
      envKey: 'env-1',
      accountId: 'account-1',
      state: 'pending_edge',
      reason: 'admin_revoked',
      requestedAt: 2_000,
      purgeDueAt: 4_000,
    }],
  });
  assert.equal(h.snapshots[0].complete, true);
  assert.deepEqual(h.snapshots[0].rows, [{
    offboardId: ACTIVE.offboardId,
    envKey: ACTIVE.envKey,
    reason: ACTIVE.reason,
    requestedAt: ACTIVE.requestedAt,
  }]);
  assert.equal(h.claims[0].workerId, 'offboard-reconcile-dev');
  assert.equal(h.claims[0].limit, 50);
  assert.equal(h.claims[0].leaseMs, 30_000);
  assert.equal(h.claims[0].now, 2_000);
  assert.equal(h.materializations[1].userId, '', 'adopted admission 不编造客户');
  assert.deepEqual(h.receipts.map((receipt) => receipt.result), [
    { kind: 'materialized', offboardId: 'offboard-1', materializedAt: 2_000 },
    { kind: 'binding_missing' },
  ]);
});

test('本地 active snapshot 读取失败时整轮停止，绝不向 API 提交空快照', async () => {
  const h = harness({
    active: async () => {
      throw new Error('automation_read_down');
    },
  });
  await assert.rejects(
    () => h.reconciler.reconcile({ commandId: 'round-read-fails', now: 2_000 }),
    (error: unknown) => {
      assert.ok(error instanceof OffboardAdmissionReconcileIncompleteError);
      assert.equal(error.stage, 'active_snapshot');
      assert.equal(error.progress.snapshotOutcome, null);
      assert.equal(error.progress.counts.claimed, 0);
      return true;
    },
  );
  assert.deepEqual(h.calls, ['active']);
});

test('本地快照 malformed/重复环境也在 API 前 fail closed', async () => {
  const malformed = { ...ACTIVE, state: 'purged' as const };
  const h = harness({ active: async () => [malformed, malformed] });
  await assert.rejects(
    () => h.reconciler.reconcile({ commandId: 'round-malformed', now: 2_000 }),
    (error: unknown) =>
      error instanceof OffboardAdmissionReconcileIncompleteError
      && error.stage === 'active_snapshot',
  );
  assert.deepEqual(h.calls, ['active']);
});

test('API snapshot reconcile 结果未知时不 claim，写调用不自动重试', async () => {
  let snapshotCalls = 0;
  const h = harness({
    snapshot: async () => {
      snapshotCalls += 1;
      throw new Error('api_authority_result_unknown');
    },
  });
  await assert.rejects(
    () => h.reconciler.reconcile({ commandId: 'round-snapshot-unknown', now: 2_000 }),
    (error: unknown) => {
      assert.ok(error instanceof OffboardAdmissionReconcileIncompleteError);
      assert.equal(error.stage, 'snapshot_reconcile');
      assert.equal(error.progress.snapshotOutcome, null);
      return true;
    },
  );
  assert.equal(snapshotCalls, 1);
  assert.deepEqual(h.calls, ['active', 'snapshot']);
});

test('API claim 结果未知时不做本地物化，写调用不自动重试', async () => {
  let claimCalls = 0;
  const h = harness({
    claimCall: async () => {
      claimCalls += 1;
      throw new Error('api_authority_result_unknown');
    },
  });
  await assert.rejects(
    () => h.reconciler.reconcile({ commandId: 'round-claim-unknown', now: 2_000 }),
    (error: unknown) => {
      assert.ok(error instanceof OffboardAdmissionReconcileIncompleteError);
      assert.equal(error.stage, 'claim');
      assert.equal(error.progress.snapshotOutcome, 'applied');
      assert.equal(error.progress.claimOutcome, null);
      return true;
    },
  );
  assert.equal(claimCalls, 1);
  assert.deepEqual(h.calls, ['active', 'snapshot', 'claim']);
});

test('本地物化异常停止后继 candidate，不写失败 candidate 的 receipt', async () => {
  const h = harness({
    materialize: async (input) => {
      if (input.offboardId === 'offboard-1') throw new Error('automation_owner_write_failed');
      return { materialized: false, reason: 'binding_missing' };
    },
  });
  await assert.rejects(
    () => h.reconciler.reconcile({ commandId: 'round-owner-fails', now: 2_000 }),
    (error: unknown) => {
      assert.ok(error instanceof OffboardAdmissionReconcileIncompleteError);
      assert.equal(error.stage, 'materialize');
      assert.deepEqual(error.candidate, {
        revocationId: 'rev-1',
        offboardId: 'offboard-1',
      });
      assert.equal(error.progress.counts.ownerMaterialized, 0);
      return true;
    },
  );
  assert.deepEqual(h.calls, ['active', 'snapshot', 'claim', 'materialize:offboard-1']);
  assert.equal(h.receipts.length, 0);
});

test('本地已物化但 receipt ACK 未知：不重试、不产出可派发投影，并携带真实 partial progress', async () => {
  let receiptCalls = 0;
  const h = harness({
    receipt: async () => {
      receiptCalls += 1;
      throw new Error('api_authority_result_unknown');
    },
  });
  await assert.rejects(
    () => h.reconciler.reconcile({ commandId: 'round-ack-lost', now: 2_000 }),
    (error: unknown) => {
      assert.ok(error instanceof OffboardAdmissionReconcileIncompleteError);
      assert.equal(error.stage, 'record_receipt');
      assert.equal(error.progress.counts.ownerMaterialized, 1);
      assert.equal(error.progress.counts.receiptsApplied, 0);
      assert.deepEqual(error.progress.materializedOffboards, []);
      return true;
    },
  );
  assert.equal(receiptCalls, 1, '未知写绝不自动重试');
  assert.ok(!h.calls.includes('materialize:offboard-2'), '未知后整轮停止');
});

for (const outcome of ['stale', 'collision'] as const) {
  test(`receipt ${outcome} 具名停止，绝不计作 applied 或生成可派发投影`, async () => {
    const h = harness({
      receipt: async (input) => ({ outcome, revision: input.expectedRevision + 1 }),
    });
    await assert.rejects(
      () => h.reconciler.reconcile({ commandId: `round-${outcome}`, now: 2_000 }),
      (error: unknown) => {
        assert.ok(error instanceof OffboardAdmissionReconcileIncompleteError);
        assert.equal(error.stage, 'record_receipt');
        assert.equal(error.receiptOutcome, outcome);
        assert.equal(error.progress.counts.receiptsApplied, 0);
        assert.equal(error.progress.counts.receiptsStale, outcome === 'stale' ? 1 : 0);
        assert.equal(error.progress.counts.receiptsCollision, outcome === 'collision' ? 1 : 0);
        assert.deepEqual(error.progress.materializedOffboards, []);
        return true;
      },
    );
    assert.ok(!h.calls.includes('materialize:offboard-2'));
  });
}

test('同一 round 输入派生完全相同的 stable API command ids，后续 round 使用不同 ids', async () => {
  let reverse = false;
  const secondActive = {
    ...ACTIVE,
    offboardId: 'active-offboard-2',
    envKey: 'active-env-2',
  };
  const h = harness({
    active: async () => reverse ? [secondActive, ACTIVE] : [ACTIVE, secondActive],
    claim: { outcome: 'applied', candidates: [] },
  });
  await h.reconciler.reconcile({ commandId: 'stable-round', now: 2_000 });
  const first = {
    snapshot: h.snapshots[0].commandId,
    claim: h.claims[0].commandId,
  };
  reverse = true;
  await h.reconciler.reconcile({ commandId: 'stable-round', now: 2_000 });
  assert.equal(h.snapshots[1].commandId, first.snapshot);
  assert.equal(h.claims[1].commandId, first.claim);
  assert.deepEqual(h.snapshots[1].rows, h.snapshots[0].rows);
  await h.reconciler.reconcile({ commandId: 'next-round', now: 2_001 });
  assert.notEqual(h.snapshots[2].commandId, first.snapshot);
  assert.notEqual(h.claims[2].commandId, first.claim);
});
