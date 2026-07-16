import assert from 'node:assert/strict';
import http from 'node:http';
import { test } from 'node:test';
import type { ClientUserStore } from '../../src/client-auth/client-user-store.js';
import { InteractionCustomerApi } from '../../src/interactions/interaction-customer-api.js';
import type { InteractionStore } from '../../src/interactions/interaction-store.js';
import type { InteractionSendOrchestrator } from '../../src/interactions/send-orchestrator.js';
import type { ReplyWorkflow } from '../../src/interactions/reply-workflow.js';
import type { ReplyJobView } from '../../src/interactions/types.js';

const job: ReplyJobView = {
  id: 'job-a', inboundMessageId: 'message-a', state: 'ignored', version: 2, matchedRuleId: null,
  configVersion: null, template: { templateId: null, templateVersion: null }, renderedText: null,
  polishedText: null, finalText: null, riskLevel: 'unknown', riskReasons: [], approvalActor: null,
  approvedAt: null, idempotencyKey: null, updatedAt: 1784044800000,
};

test('customer API transactionally binds enabled user + owned env + account on every read/action', async () => {
  let mutationCalls = 0;
  let listCalls = 0;
  let authorizedOperations = 0;
  const users = {
    withAuthorizedInteractionScope: async <T>(
      userId: string,
      envKey: string,
      operation: (scope: { accountId: string }) => Promise<T>,
    ) => {
      if (userId === 'disabled-user') return { ok: false as const, reason: 'disabled' as const };
      const accountId = userId === 'user-a' && envKey === 'env-a' ? 'acct-a'
        : userId === 'user-b' && envKey === 'env-b' ? 'acct-b' : null;
      if (!accountId) return { ok: false as const, reason: 'not_authorized' as const };
      authorizedOperations += 1;
      return { ok: true as const, accountId, value: await operation({ accountId }) };
    },
  } as unknown as ClientUserStore;
  const store = {
    transitionMessageJob: async (input: { messageId: string }) => {
      mutationCalls += 1;
      assert.equal(input.messageId, 'message-a');
      return job;
    },
    listInteractions: async () => { listCalls += 1; return { items: [], next: null }; },
    getAuth: async () => ({
      envKey: 'env-a', accountId: 'acct-a', platform: 'wechat_channels', status: 'active', browserState: 'closed',
      capabilities: { commentsRead: true, commentsReply: true, dmRead: true, dmSendText: true, dmSendImage: false },
      identity: null, runtimeControlsVersion: 0, checkedAt: 1, reasonCode: null,
    }),
    getRuntimeControls: async () => ({
      accountId: 'acct-a', platform: 'wechat_channels', envKey: 'env-a', version: 1,
      commentsReadEnabled: true, commentsReplyEnabled: true, dmReadEnabled: true,
      dmSendTextEnabled: true, dmSendImageEnabled: false, writePaused: false,
      consecutiveFailures: 0, circuitOpenedAt: null, lastConfirmedAt: null,
      updatedAt: 1, updatedBy: 'admin',
    }),
  } as unknown as InteractionStore;
  const api = new InteractionCustomerApi({ users, store, workflow: {} as ReplyWorkflow,
    sender: {} as InteractionSendOrchestrator, cursorSecret: 'test-cursor-secret', clock: () => 1784044800000 });
  const server = http.createServer((req, res) => {
    const actor = typeof req.headers['x-test-user'] === 'string' ? req.headers['x-test-user'] : 'user-b';
    void api.handle(req, res, actor).then((handled) => {
      if (!handled && !res.headersSent) { res.writeHead(404); res.end(); }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    const base = `http://127.0.0.1:${address.port}`;
    const denied = await fetch(`${base}/environments/env-a/interactions/message-a/ignore`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-test-user': 'user-b' },
      body: JSON.stringify({ expectedVersion: 1 }),
    });
    assert.equal(denied.status, 404);
    assert.equal(mutationCalls, 0);
    assert.equal(authorizedOperations, 0, 'denied ownership must not enter the business operation');

    const crossTenantRead = await fetch(`${base}/environments/env-b/interactions`, {
      headers: { 'x-test-user': 'user-a' },
    });
    assert.equal(crossTenantRead.status, 404);
    assert.equal(listCalls, 0);
    const crossTenantAct = await fetch(`${base}/environments/env-b/interactions/message-b/ignore`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-test-user': 'user-a' },
      body: JSON.stringify({ expectedVersion: 1 }),
    });
    assert.equal(crossTenantAct.status, 404);
    assert.equal(mutationCalls, 0);

    const disabled = await fetch(`${base}/environments/env-a/interactions`, {
      headers: { 'x-test-user': 'disabled-user' },
    });
    assert.equal(disabled.status, 401);
    assert.equal(listCalls, 0);

    const invalid = await fetch(`${base}/environments/env-a/interactions/message-a/ignore`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-test-user': 'user-a' },
      body: JSON.stringify({ expectedVersion: 1, unexpected: true }),
    });
    assert.equal(invalid.status, 422);
    assert.equal(mutationCalls, 0);

    const accepted = await fetch(`${base}/environments/env-a/interactions/message-a/ignore`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-test-user': 'user-a' },
      body: JSON.stringify({ expectedVersion: 1 }),
    });
    assert.equal(accepted.status, 200);
    const acceptedBody = await accepted.json() as { data: { envKey: string; accountId: string; job: ReplyJobView }; meta: { asOf: number } };
    assert.equal(acceptedBody.data.envKey, 'env-a');
    assert.equal(acceptedBody.data.accountId, 'acct-a');
    assert.equal(acceptedBody.data.job.state, 'ignored');
    assert.equal(acceptedBody.meta.asOf, 1784044800000);
    assert.equal(mutationCalls, 1);

    const list = await fetch(`${base}/environments/env-a/interactions`, { headers: { 'x-test-user': 'user-a' } });
    assert.equal(list.status, 200);
    const listBody = await list.json() as { data: { envKey: string; accountId: string; auth: {
      runtimeControls: { storedVersion: number; edgeAppliedVersion: number | null; applicationStatus: string };
    } }; meta: { asOf: number } };
    assert.deepEqual([listBody.data.envKey, listBody.data.accountId, listBody.meta.asOf],
      ['env-a', 'acct-a', 1784044800000]);
    assert.equal(listCalls, 1);
    assert.deepEqual(listBody.data.auth.runtimeControls,
      { storedVersion: 1, edgeAppliedVersion: 0, applicationStatus: 'pending', stored: {
        commentsReadEnabled: true, commentsReplyEnabled: true, dmReadEnabled: true,
        dmSendTextEnabled: true, dmSendImageEnabled: false, writePaused: false,
      } });

    const unknownQuery = await fetch(`${base}/environments/env-a/interactions?unexpected=1`,
      { headers: { 'x-test-user': 'user-a' } });
    assert.equal(unknownQuery.status, 422);
    const malformedPath = await fetch(`${base}/environments/%ZZ/interactions`,
      { headers: { 'x-test-user': 'user-a' } });
    assert.equal(malformedPath.status, 422);
    const unknownInteractionRoute = await fetch(`${base}/environments/env-a/interactions/not-a-route`,
      { method: 'POST', headers: { 'x-test-user': 'user-a' } });
    assert.equal(unknownInteractionRoute.status, 404);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
