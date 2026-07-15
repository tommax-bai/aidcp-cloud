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

test('customer API keeps env ownership, frozen interaction routes and env/account/asOf response context', async () => {
  let mutationCalls = 0;
  let accountLookupCalls = 0;
  const users = {
    ownsEnv: async (userId: string, envKey: string) => userId === 'user-a' && envKey === 'env-a',
  } as unknown as ClientUserStore;
  const store = {
    accountForEnv: async () => { accountLookupCalls += 1; return { accountId: 'acct-a', envKey: 'env-a' }; },
    transitionMessageJob: async (input: { messageId: string }) => {
      mutationCalls += 1;
      assert.equal(input.messageId, 'message-a');
      return job;
    },
    listInteractions: async () => ({ items: [], next: null }),
    getAuth: async () => ({
      envKey: 'env-a', accountId: 'acct-a', platform: 'wechat_channels', status: 'active', browserState: 'closed',
      capabilities: { commentsRead: true, commentsReply: true, dmRead: true, dmSendText: true, dmSendImage: false },
      identity: null, checkedAt: 1, reasonCode: null,
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
    assert.equal(accountLookupCalls, 0, 'ownership must be checked before env→account resolution');
    assert.equal(mutationCalls, 0);

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
    const listBody = await list.json() as { data: { envKey: string; accountId: string }; meta: { asOf: number } };
    assert.deepEqual([listBody.data.envKey, listBody.data.accountId, listBody.meta.asOf],
      ['env-a', 'acct-a', 1784044800000]);

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
