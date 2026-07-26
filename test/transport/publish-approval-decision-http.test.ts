import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  PUBLISH_APPROVAL_DECISION_WRITER_CONTRACT_VERSION,
  PublishApprovalDecisionWriterError,
  type PublishApprovalDecisionWriteInput,
  type PublishApprovalDecisionWriterPort,
} from '../../src/kernel/publish-approval-contract.js';
import { createPublishApprovalDecisionWriter } from '../../src/publish-agent/publish-approval-api.js';
import { ApprovalExecutionTargetError } from '../../src/publish-agent/publish-approval-store.js';
import { InternalHttpClient, InternalHttpError, InternalHttpServer } from '../../src/transport/internal-http.js';
import {
  PUBLISH_APPROVAL_DECISION_WRITER_ROUTES,
  PublishApprovalDecisionWriterHttpClient,
  registerPublishApprovalDecisionWriterRoutes,
} from '../../src/transport/publish-approval-decision-http.js';

const input: PublishApprovalDecisionWriteInput = {
  requestId: 'publish-42',
  approved: true,
  payload: {
    title: 'title',
    content: 'content',
    tags: ['one', 'two'],
    contentVersion: 7,
  },
  context: {
    decidedBy: 'account-7',
    decidedVia: 'delegated_task',
    envKey: 'env-9',
  },
  executionTarget: 'dev',
};
const callerToken = 'approval-test-token';

async function withLoopback(
  local: PublishApprovalDecisionWriterPort,
  run: (client: PublishApprovalDecisionWriterHttpClient, http: InternalHttpClient) => Promise<void>,
): Promise<void> {
  const server = new InternalHttpServer();
  registerPublishApprovalDecisionWriterRoutes(server, local, callerToken);
  const port = await server.listen(0);
  const http = new InternalHttpClient(`http://127.0.0.1:${port}`);
  try {
    await run(new PublishApprovalDecisionWriterHttpClient(http, callerToken), http);
  } finally {
    await server.close();
  }
}

test('decision writer HTTP 保留 decidedBy/decidedVia/envKey 与 target 的完整语义', async () => {
  const seen: unknown[] = [];
  const local = createPublishApprovalDecisionWriter(
    async (requestId, approved, payload, context) => {
      seen.push({ requestId, approved, payload, context });
      return { written: true, revision: 3 };
    },
    'dev',
  );
  await withLoopback(local, async (client) => {
    assert.deepEqual(await client.writeDecision(input), { written: true, revision: 3 });
  });
  assert.deepEqual(seen, [{
    requestId: 'publish-42',
    approved: true,
    payload: {
      title: 'title',
      content: 'content',
      tags: ['one', 'two'],
      contentVersion: 7,
    },
    context: {
      decidedBy: 'account-7',
      decidedVia: 'delegated_task',
      envKey: 'env-9',
    },
  }]);
});

test('decision writer owner adapter 拒绝 target mismatch 与不完整决策上下文', async () => {
  const local = createPublishApprovalDecisionWriter(
    async () => ({ written: true, revision: 1 }),
    'dev',
  );
  await assert.rejects(
    () => local.writeDecision({ ...input, executionTarget: 'ol' }),
    (err: unknown) =>
      err instanceof PublishApprovalDecisionWriterError &&
      err.code === 'approval_decision_target_mismatch',
  );
  await assert.rejects(
    () => local.writeDecision({
      ...input,
      context: { ...input.context, decidedBy: '' },
    }),
    (err: unknown) =>
      err instanceof PublishApprovalDecisionWriterError &&
      err.code === 'approval_decision_invalid_request',
  );
});

test('decision writer 将跨 target 全局唯一冲突稳定映射为 unavailable，不返回别域决定', async () => {
  const local = createPublishApprovalDecisionWriter(
    async () => {
      throw new ApprovalExecutionTargetError('execution_target_conflict_or_unavailable');
    },
    'dev',
  );
  await assert.rejects(
    () => local.writeDecision(input),
    (err: unknown) =>
      err instanceof PublishApprovalDecisionWriterError &&
      err.code === 'approval_decision_unavailable' &&
      err.message === 'execution_target_conflict_or_unavailable',
  );
  await withLoopback(local, async (client) => {
    await assert.rejects(
      () => client.writeDecision(input),
      (err: unknown) =>
        err instanceof PublishApprovalDecisionWriterError &&
        err.code === 'approval_decision_unavailable' &&
        err.message === 'execution_target_conflict_or_unavailable',
    );
  });
});

test('decision writer route 拒绝非 v1 envelope', async () => {
  await withLoopback(
    { writeDecision: async () => ({ written: true, revision: 1 }) },
    async (_client, http) => {
      await assert.rejects(
        () => http.callBearer(PUBLISH_APPROVAL_DECISION_WRITER_ROUTES.writeDecision, {
          version: PUBLISH_APPROVAL_DECISION_WRITER_CONTRACT_VERSION + 1,
          input,
        }, callerToken),
        (err: unknown) =>
          err instanceof InternalHttpError &&
          err.code === 'approval_decision_invalid_request',
      );
    },
  );
});

test('decision writer route 在 owner write 前拒绝 missing/wrong token', async () => {
  let writes = 0;
  await withLoopback(
    {
      writeDecision: async () => {
        writes += 1;
        return { written: true, revision: writes };
      },
    },
    async (client, http) => {
      const envelope = {
        version: PUBLISH_APPROVAL_DECISION_WRITER_CONTRACT_VERSION,
        input,
      };
      await assert.rejects(
        () => http.call(PUBLISH_APPROVAL_DECISION_WRITER_ROUTES.writeDecision, envelope),
        (err: unknown) =>
          err instanceof InternalHttpError &&
          err.code === 'internal_http_unauthorized',
      );
      await assert.rejects(
        () => new PublishApprovalDecisionWriterHttpClient(http, 'wrong-token').writeDecision(input),
        (err: unknown) =>
          err instanceof PublishApprovalDecisionWriterError &&
          err.code === 'approval_decision_result_unknown',
      );
      assert.equal(writes, 0);
      assert.deepEqual(await client.writeDecision(input), { written: true, revision: 1 });
      assert.equal(writes, 1);
    },
  );
});

test('decision writer mutation 的断链与畸形响应都报告 result_unknown', async () => {
  const unavailable = new PublishApprovalDecisionWriterHttpClient(
    new InternalHttpClient('http://127.0.0.1:1'),
    callerToken,
  );
  await assert.rejects(
    () => unavailable.writeDecision(input),
    (err: unknown) =>
      err instanceof PublishApprovalDecisionWriterError &&
      err.code === 'approval_decision_result_unknown',
  );

  await withLoopback(
    { writeDecision: async () => ({ written: true } as never) },
    async (client) => {
      await assert.rejects(
        () => client.writeDecision(input),
        (err: unknown) =>
          err instanceof PublishApprovalDecisionWriterError &&
          err.code === 'approval_decision_result_unknown',
      );
    },
  );
});
