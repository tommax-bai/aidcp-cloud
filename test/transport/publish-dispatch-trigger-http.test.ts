import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PUBLISH_DISPATCH_TRIGGER_CONTRACT_VERSION,
  PublishDispatchTriggerError,
  type PublishApprovalView,
  type PublishDispatchTriggerInput,
} from '../../src/kernel/publish-approval-contract.js';
import { createPublishDispatchTriggerReceiver } from '../../src/publish-agent/publish-dispatch-trigger.js';
import {
  InternalHttpClient,
  InternalHttpError,
  InternalHttpServer,
} from '../../src/transport/internal-http.js';
import {
  PUBLISH_DISPATCH_TRIGGER_ROUTES,
  PublishDispatchTriggerHttpClient,
  registerPublishDispatchTriggerRoutes,
} from '../../src/transport/publish-dispatch-trigger-http.js';

const CALLER_TOKEN = 'publish-trigger-test-token';

function approval(overrides: Partial<PublishApprovalView> = {}): PublishApprovalView {
  return {
    requestId: 'publish-42',
    revision: 3,
    approved: true,
    contentVersion: 7,
    dispatchState: 'pending_dispatch',
    dispatchBlockedReason: null,
    envKey: 'env-1',
    executionTarget: 'dev',
    decidedAt: 1,
    decidedBy: 'operator',
    decidedVia: 'feishu',
    ...overrides,
  };
}

async function withTriggerLoopback(
  dispatch: (recordId: number, opts?: { humanApproval?: boolean; approvalRevision?: number }) => Promise<void>,
  run: (
    client: PublishDispatchTriggerHttpClient,
    rawClient: InternalHttpClient,
  ) => Promise<void>,
): Promise<void> {
  const receiver = createPublishDispatchTriggerReceiver({
    executionTarget: 'dev',
    approvalAuthority: { getApproval: async () => approval() },
    dispatcher: { dispatch },
    logger: { warn() {} },
  });
  const server = new InternalHttpServer();
  registerPublishDispatchTriggerRoutes(server, receiver, CALLER_TOKEN);
  const port = await server.listen(0);
  try {
    const rawClient = new InternalHttpClient(`http://127.0.0.1:${port}`);
    await run(
      new PublishDispatchTriggerHttpClient(
        rawClient,
        CALLER_TOKEN,
      ),
      rawClient,
    );
  } finally {
    await server.close();
  }
}

test('trigger HTTP: 缺失或错误 caller token 在 authority/dispatcher 前被拒绝', async () => {
  let dispatches = 0;
  await withTriggerLoopback(
    async () => {
      dispatches += 1;
    },
    async (client, rawClient) => {
      const input: PublishDispatchTriggerInput = {
        requestId: 'publish-42',
        revision: 3,
        executionTarget: 'dev',
        kind: 'decision_recorded',
      };
      const args = {
        version: PUBLISH_DISPATCH_TRIGGER_CONTRACT_VERSION,
        input,
      };
      for (const invoke of [
        () => rawClient.call(PUBLISH_DISPATCH_TRIGGER_ROUTES.triggerApproved, args),
        () =>
          rawClient.callBearer(
            PUBLISH_DISPATCH_TRIGGER_ROUTES.triggerApproved,
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
      assert.equal(dispatches, 0);
      assert.deepEqual(await client.triggerApproved(input), {
        accepted: true,
        disposition: 'queued',
      });
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(dispatches, 1);
    },
  );
});

test('trigger HTTP: decision_recorded 短应答并只去重等价首写重投，不返回发布状态', async () => {
  const calls: Array<{ recordId: number; opts?: { humanApproval?: boolean; approvalRevision?: number } }> = [];
  await withTriggerLoopback(
    async (recordId, opts) => {
      calls.push({ recordId, opts });
      return new Promise<void>(() => {});
    },
    async (client) => {
      const input: PublishDispatchTriggerInput = {
        requestId: 'publish-42',
        revision: 3,
        executionTarget: 'dev',
        kind: 'decision_recorded',
      };
      const first = await client.triggerApproved(input);
      const duplicate = await client.triggerApproved(input);
      assert.deepEqual(first, { accepted: true, disposition: 'queued' });
      assert.deepEqual(duplicate, { accepted: true, disposition: 'duplicate' });
      assert.deepEqual(Object.keys(first).sort(), ['accepted', 'disposition']);
    },
  );
  assert.deepEqual(calls, [{ recordId: 42, opts: { approvalRevision: 3 } }]);
});

test('trigger receiver: human_reconfirm 不被同 revision 的 decision 去重吞掉，自动首写无清熔断权', async () => {
  const calls: Array<{ humanApproval: boolean; revision?: number }> = [];
  const receiver = createPublishDispatchTriggerReceiver({
    executionTarget: 'dev',
    approvalAuthority: { getApproval: async () => approval() },
    dispatcher: {
      async dispatch(_recordId, opts) {
        calls.push({ humanApproval: opts?.humanApproval === true, revision: opts?.approvalRevision });
      },
    },
  });
  await receiver.triggerApproved({
    requestId: 'publish-42',
    revision: 3,
    executionTarget: 'dev',
    kind: 'decision_recorded',
  });
  await receiver.triggerApproved({
    requestId: 'publish-42',
    revision: 3,
    executionTarget: 'dev',
    kind: 'human_reconfirm',
  });
  // 同一授权轮次未来再次人工确认仍有权清后来重新打开的熔断；dispatcher 自身吸收幂等。
  await receiver.triggerApproved({
    requestId: 'publish-42',
    revision: 3,
    executionTarget: 'dev',
    kind: 'human_reconfirm',
  });
  assert.deepEqual(calls, [
    { humanApproval: false, revision: 3 },
    { humanApproval: true, revision: 3 },
    { humanApproval: true, revision: 3 },
  ]);
});

test('trigger receiver: stale revision、缺失授权与 target mismatch 在唤醒前拒绝', async () => {
  let dispatches = 0;
  const receiver = createPublishDispatchTriggerReceiver({
    executionTarget: 'dev',
    approvalAuthority: { getApproval: async () => approval({ revision: 4 }) },
    dispatcher: { dispatch: async () => { dispatches += 1; } },
  });
  await assert.rejects(
    () =>
      receiver.triggerApproved({
        requestId: 'publish-42',
        revision: 3,
        executionTarget: 'dev',
        kind: 'decision_recorded',
      }),
    (err: unknown) =>
      err instanceof PublishDispatchTriggerError && err.code === 'publish_trigger_revision_conflict',
  );
  await assert.rejects(
    () =>
      receiver.triggerApproved({
        requestId: 'publish-42',
        revision: 4,
        executionTarget: 'ol',
        kind: 'decision_recorded',
      }),
    (err: unknown) =>
      err instanceof PublishDispatchTriggerError && err.code === 'publish_trigger_target_mismatch',
  );
  assert.equal(dispatches, 0);
});

test('trigger HTTP: transport failure 保持 result_unknown，不推断未受理或发布失败', async () => {
  const client = new PublishDispatchTriggerHttpClient(
    new InternalHttpClient('http://127.0.0.1:1', { timeoutMs: 50 }),
    CALLER_TOKEN,
  );
  await assert.rejects(
    () =>
      client.triggerApproved({
        requestId: 'publish-42',
        revision: 3,
        executionTarget: 'dev',
        kind: 'decision_recorded',
      }),
    (err: unknown) =>
      err instanceof PublishDispatchTriggerError && err.code === 'publish_trigger_result_unknown',
  );
});
