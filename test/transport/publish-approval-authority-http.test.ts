import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PUBLISH_APPROVAL_AUTHORITY_CONTRACT_VERSION,
  PublishApprovalAuthorityError,
  type PublishApprovalView,
} from '../../src/kernel/publish-approval-contract.js';
import { createPublishApprovalAuthorityService } from '../../src/publish-agent/publish-approval-api.js';
import type { ApprovalDecisionRow } from '../../src/publish-agent/publish-approval-store.js';
import {
  InternalHttpClient,
  InternalHttpError,
  InternalHttpServer,
} from '../../src/transport/internal-http.js';
import {
  PUBLISH_APPROVAL_AUTHORITY_ROUTES,
  PublishApprovalAuthorityHttpClient,
  registerPublishApprovalAuthorityRoutes,
} from '../../src/transport/publish-approval-authority-http.js';

const CALLER_TOKEN = 'approval-authority-test-token';

function row(overrides: Partial<ApprovalDecisionRow> = {}): ApprovalDecisionRow {
  return {
    requestId: 'publish-42',
    revision: 3,
    subjectKind: 'publish',
    candidateRef: '42',
    contentVersion: 7,
    approved: true,
    decidedBy: 'ou_operator',
    decidedVia: 'feishu',
    decidedAt: 1,
    envKey: 'env-1',
    executionTarget: 'dev',
    frozenPayload: {},
    dispatchState: 'pending_dispatch',
    dispatchBlockedReason: null,
    dispatchStateAt: 1,
    voidReason: null,
    ...overrides,
  };
}

async function withLoopback(
  store: Record<string, (...args: any[]) => Promise<any>>,
  run: (
    client: PublishApprovalAuthorityHttpClient,
    rawClient: InternalHttpClient,
  ) => Promise<void>,
): Promise<void> {
  const server = new InternalHttpServer();
  registerPublishApprovalAuthorityRoutes(
    server,
    createPublishApprovalAuthorityService(store as never, 'dev'),
    CALLER_TOKEN,
  );
  const port = await server.listen(0);
  try {
    const rawClient = new InternalHttpClient(`http://127.0.0.1:${port}`);
    await run(
      new PublishApprovalAuthorityHttpClient(
        rawClient,
        CALLER_TOKEN,
      ),
      rawClient,
    );
  } finally {
    await server.close();
  }
}

test('authority HTTP: 缺失或错误 caller token 在 owner 前被拒绝', async () => {
  let reads = 0;
  await withLoopback(
    {
      async readActiveForTarget() {
        reads += 1;
        return row();
      },
    },
    async (client, rawClient) => {
      const args = {
        version: PUBLISH_APPROVAL_AUTHORITY_CONTRACT_VERSION,
        input: { requestId: 'publish-42', executionTarget: 'dev' },
      };
      for (const invoke of [
        () => rawClient.call(PUBLISH_APPROVAL_AUTHORITY_ROUTES.getApproval, args),
        () =>
          rawClient.callBearer(
            PUBLISH_APPROVAL_AUTHORITY_ROUTES.getApproval,
            args,
            'wrong-token',
          ),
      ]) {
        await assert.rejects(
          invoke,
          (err: unknown) =>
            err instanceof InternalHttpError && err.code === 'internal_http_unauthorized',
        );
      }
      assert.equal(reads, 0);
      assert.equal(
        (await client.getApproval({ requestId: 'publish-42', executionTarget: 'dev' }))?.revision,
        3,
      );
      assert.equal(reads, 1);
    },
  );
});

test('authority HTTP: 七方法保持 route/client parity，状态写原样携带 revision CAS 与 target', async () => {
  const calls: Array<{ method: string; input: unknown }> = [];
  const current = row();
  const store = {
    async readActiveForTarget(requestId: string, target: string) {
      calls.push({ method: 'getApproval', input: { requestId, target } });
      return current;
    },
    async listPendingDispatch(target: string, limit: number, subjectKind?: string) {
      calls.push({ method: 'listPendingDispatch', input: { target, limit, subjectKind } });
      return [current];
    },
    async voidActive(input: unknown) {
      calls.push({ method: 'voidApproval', input });
      return row({ dispatchState: 'void', voidReason: 'version_stale' });
    },
    async markDispatching(input: unknown) {
      calls.push({ method: 'markDispatching', input });
      return row({ dispatchState: 'dispatching' });
    },
    async markConsumed(input: unknown) {
      calls.push({ method: 'markConsumed', input });
      return row({ dispatchState: 'consumed' });
    },
    async releaseToPending(input: unknown) {
      calls.push({ method: 'releaseToPending', input });
      return row({ dispatchBlockedReason: 'browser_slot_waiting' });
    },
    async setBlockedReason(input: unknown) {
      calls.push({ method: 'setBlockedReason', input });
      return row({ dispatchBlockedReason: 'breaker_open' });
    },
  };

  await withLoopback(store, async (client) => {
    assert.equal((await client.getApproval({ requestId: 'publish-42', executionTarget: 'dev' }))?.revision, 3);
    assert.equal(
      (await client.listPendingDispatch({ executionTarget: 'dev', limit: 10, subjectKind: 'publish' })).length,
      1,
    );
    await client.voidApproval({
      requestId: 'publish-42',
      expectedRevision: 3,
      executionTarget: 'dev',
      reason: 'version_stale',
    });
    await client.markDispatching({ requestId: 'publish-42', expectedRevision: 3, executionTarget: 'dev' });
    await client.markConsumed({ requestId: 'publish-42', expectedRevision: 3, executionTarget: 'dev' });
    await client.releaseToPending({
      requestId: 'publish-42',
      expectedRevision: 3,
      executionTarget: 'dev',
      blockedReason: 'browser_slot_waiting',
    });
    await client.setBlockedReason({
      requestId: 'publish-42',
      expectedRevision: 3,
      executionTarget: 'dev',
      reason: 'breaker_open',
    });
  });

  assert.deepEqual(
    calls.map((call) => call.method),
    [
      'getApproval',
      'listPendingDispatch',
      'voidApproval',
      'markDispatching',
      'markConsumed',
      'releaseToPending',
      'setBlockedReason',
    ],
  );
  for (const call of calls.slice(2)) {
    const input = call.input as Record<string, unknown>;
    assert.equal(input.requestId, 'publish-42');
    assert.equal(input.expectedRevision, 3);
    assert.equal(input.executionTarget, 'dev');
  }
});

test('authority HTTP: stale revision、not-found 与 target mismatch 保持具名失败', async () => {
  const store = {
    async readActiveForTarget() {
      return row({ revision: 4 });
    },
    async listPendingDispatch() {
      return [];
    },
    async voidActive() {
      return null;
    },
    async markDispatching() {
      return null;
    },
    async markConsumed() {
      return null;
    },
    async releaseToPending() {
      return null;
    },
    async setBlockedReason() {
      return null;
    },
  };
  await withLoopback(store, async (client) => {
    await assert.rejects(
      () => client.markDispatching({ requestId: 'publish-42', expectedRevision: 3, executionTarget: 'dev' }),
      (err: unknown) =>
        err instanceof PublishApprovalAuthorityError && err.code === 'approval_revision_conflict',
    );
    await assert.rejects(
      () => client.getApproval({ requestId: 'publish-42', executionTarget: 'ol' }),
      (err: unknown) =>
        err instanceof PublishApprovalAuthorityError && err.code === 'approval_target_mismatch',
    );
  });

  await withLoopback(
    { ...store, readActiveForTarget: async () => null },
    async (client) => {
      await assert.rejects(
        () => client.markConsumed({ requestId: 'publish-404', expectedRevision: 1, executionTarget: 'dev' }),
        (err: unknown) =>
          err instanceof PublishApprovalAuthorityError && err.code === 'approval_not_found',
      );
    },
  );
});

test('authority HTTP: read transport failure 是 unavailable，write transport failure 是 result_unknown', async () => {
  const client = new PublishApprovalAuthorityHttpClient(
    new InternalHttpClient('http://127.0.0.1:1', { timeoutMs: 50 }),
    CALLER_TOKEN,
  );
  await assert.rejects(
    () => client.getApproval({ requestId: 'publish-42', executionTarget: 'dev' }),
    (err: unknown) =>
      err instanceof PublishApprovalAuthorityError && err.code === 'approval_authority_unavailable',
  );
  await assert.rejects(
    () => client.markConsumed({ requestId: 'publish-42', expectedRevision: 3, executionTarget: 'dev' }),
    (err: unknown) =>
      err instanceof PublishApprovalAuthorityError && err.code === 'approval_authority_result_unknown',
  );
});

test('authority response view does not expose frozen payload', async () => {
  let view: PublishApprovalView | null = null;
  const current = row({ frozenPayload: { secret: 'not-wire-data' } });
  await withLoopback(
    {
      async readActiveForTarget() {
        return current;
      },
      async listPendingDispatch() {
        return [];
      },
      async voidActive() {
        return current;
      },
      async markDispatching() {
        return current;
      },
      async markConsumed() {
        return current;
      },
      async releaseToPending() {
        return current;
      },
      async setBlockedReason() {
        return current;
      },
    },
    async (client) => {
      view = await client.getApproval({ requestId: 'publish-42', executionTarget: 'dev' });
    },
  );
  assert.equal(Object.hasOwn(view ?? {}, 'frozenPayload'), false);
});
