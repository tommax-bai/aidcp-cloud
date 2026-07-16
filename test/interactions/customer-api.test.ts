import assert from 'node:assert/strict';
import http from 'node:http';
import { test } from 'node:test';
import type { ClientUserStore } from '../../src/client-auth/client-user-store.js';
import { InteractionCustomerApi } from '../../src/interactions/interaction-customer-api.js';
import type { InteractionStore, ListQuery } from '../../src/interactions/interaction-store.js';
import type { InteractionSendOrchestrator } from '../../src/interactions/send-orchestrator.js';
import type { ReplyConfigStore } from '../../src/interactions/reply-config-store.js';
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
  let lastListState: ListQuery['state'];
  let authorizedOperations = 0;
  let browserDispatchCalls = 0;
  let browserClaimCalls = 0;
  let completedBrowserResponse: unknown = null;
  let authStatus = 'active';
  let controlsVersion = 1;
  let controlsState = {
    commentsReadEnabled: true, commentsReplyEnabled: true, dmReadEnabled: true,
    dmSendTextEnabled: true, dmSendImageEnabled: false as const, writePaused: false,
  };
  let readControlUpdates = 0;
  let runtimeDeliveries = 0;
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
    listInteractions: async (query: ListQuery) => {
      listCalls += 1;
      lastListState = query.state;
      return { items: [], next: null };
    },
    getAuth: async () => ({
      envKey: 'env-a', accountId: 'acct-a', platform: 'wechat_channels', status: authStatus, browserState: 'closed',
      capabilities: { commentsRead: true, commentsReply: true, dmRead: true, dmSendText: true, dmSendImage: false },
      identity: null, runtimeControlsVersion: 0, checkedAt: 1, reasonCode: null,
    }),
    getRuntimeControls: async () => ({
      accountId: 'acct-a', platform: 'wechat_channels', envKey: 'env-a', version: controlsVersion, ...controlsState,
      consecutiveFailures: 0, circuitOpenedAt: null, lastConfirmedAt: null,
      updatedAt: 1, updatedBy: 'admin',
    }),
    updateRuntimeControls: async (input: Record<string, unknown>) => {
      readControlUpdates += 1;
      assert.equal(input.expectedVersion, controlsVersion);
      assert.equal(input.commentsReplyEnabled, true, 'customer update must preserve comment write');
      assert.equal(input.dmSendTextEnabled, true, 'customer update must preserve dm write');
      assert.equal(input.writePaused, false, 'customer update must preserve write pause');
      controlsVersion += 1;
      controlsState = {
        ...controlsState,
        commentsReadEnabled: input.commentsReadEnabled as boolean,
        dmReadEnabled: input.dmReadEnabled as boolean,
      };
      return {
        accountId: 'acct-a', platform: 'wechat_channels' as const, envKey: 'env-a', version: controlsVersion,
        ...controlsState, consecutiveFailures: 0, circuitOpenedAt: null, lastConfirmedAt: null,
        updatedAt: 2, updatedBy: 'client:user-a',
      };
    },
    claimApiRequest: async (input: { action: string; idempotencyKey: string; accountId: string; envKey: string; resourceId?: string }) => {
      browserClaimCalls += 1;
      assert.deepEqual(input, {
        actor: 'client:user-a', action: 'browser_control', idempotencyKey: 'browser-key',
        accountId: 'acct-a', envKey: 'env-a', resourceId: 'open',
      });
      return { requestId: 'browser-claim-1', fresh: completedBrowserResponse === null, response: completedBrowserResponse };
    },
    completeApiRequest: async (_requestId: string, response: unknown) => { completedBrowserResponse = response; },
  } as unknown as InteractionStore;
  const sender = {
    requestBrowserControl: (input: { accountId: string; envKey: string; action: string }) => {
      browserDispatchCalls += 1;
      assert.deepEqual(input, { accountId: 'acct-a', envKey: 'env-a', action: 'open' });
      return 'browser-control-request-1';
    },
  } as unknown as InteractionSendOrchestrator;
  let replyConfigHead: {
    accountId: string; platform: 'wechat_channels'; currentVersion: number;
    draftVersion: number | null; publishedVersion: number | null; updatedAt: number; updatedBy: string;
  } | null | 'error' = {
    accountId: 'acct-a', platform: 'wechat_channels', currentVersion: 4,
    draftVersion: null, publishedVersion: 4, updatedAt: 1, updatedBy: 'admin',
  };
  const configs = {
    getHead: async () => {
      if (replyConfigHead === 'error') throw new Error('reply config unavailable');
      return replyConfigHead;
    },
  } as unknown as ReplyConfigStore;
  const api = new InteractionCustomerApi({ users, store, configs, workflow: {} as ReplyWorkflow,
    sender, onRuntimeControlsUpdated: async (controls) => {
      runtimeDeliveries += 1;
      assert.equal(controls.version, controlsVersion);
      return { delivered: 1 };
    }, cursorSecret: 'test-cursor-secret', clock: () => 1784044800000 });
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
    const listBody = await list.json() as { data: { envKey: string; accountId: string; replyConfig: {
      status: string; currentVersion: number | null; draftVersion: number | null; publishedVersion: number | null;
    }; auth: {
      runtimeControls: { storedVersion: number; edgeAppliedVersion: number | null; applicationStatus: string };
    } }; meta: { asOf: number } };
    assert.deepEqual([listBody.data.envKey, listBody.data.accountId, listBody.meta.asOf],
      ['env-a', 'acct-a', 1784044800000]);
    assert.equal(listCalls, 1);
    const pendingList = await fetch(`${base}/environments/env-a/interactions?state=pending`, {
      headers: { 'x-test-user': 'user-a' },
    });
    assert.equal(pendingList.status, 200);
    assert.equal(lastListState, 'pending');
    assert.deepEqual(listBody.data.replyConfig,
      { status: 'published', currentVersion: 4, draftVersion: null, publishedVersion: 4 });
    assert.deepEqual(listBody.data.auth.runtimeControls,
      { storedVersion: 1, edgeAppliedVersion: 0, applicationStatus: 'pending', stored: {
        commentsReadEnabled: true, commentsReplyEnabled: true, dmReadEnabled: true,
        dmSendTextEnabled: true, dmSendImageEnabled: false, writePaused: false,
      } });

    replyConfigHead = null;
    const missingConfigList = await fetch(`${base}/environments/env-a/interactions`, {
      headers: { 'x-test-user': 'user-a' },
    });
    const missingConfigBody = await missingConfigList.json() as { data: { replyConfig: Record<string, unknown> } };
    assert.deepEqual(missingConfigBody.data.replyConfig,
      { status: 'missing', currentVersion: null, draftVersion: null, publishedVersion: null });

    replyConfigHead = {
      accountId: 'acct-a', platform: 'wechat_channels', currentVersion: 5,
      draftVersion: 5, publishedVersion: null, updatedAt: 2, updatedBy: 'admin',
    };
    const draftConfigList = await fetch(`${base}/environments/env-a/interactions`, {
      headers: { 'x-test-user': 'user-a' },
    });
    const draftConfigBody = await draftConfigList.json() as { data: { replyConfig: Record<string, unknown> } };
    assert.deepEqual(draftConfigBody.data.replyConfig,
      { status: 'draft_only', currentVersion: 5, draftVersion: 5, publishedVersion: null });

    replyConfigHead = 'error';
    const unknownConfigList = await fetch(`${base}/environments/env-a/interactions`, {
      headers: { 'x-test-user': 'user-a' },
    });
    const unknownConfigBody = await unknownConfigList.json() as { data: { replyConfig: Record<string, unknown> } };
    assert.deepEqual(unknownConfigBody.data.replyConfig,
      { status: 'unknown', currentVersion: null, draftVersion: null, publishedVersion: null });
    replyConfigHead = {
      accountId: 'acct-a', platform: 'wechat_channels', currentVersion: 4,
      draftVersion: null, publishedVersion: 4, updatedAt: 1, updatedBy: 'admin',
    };

    const invalidReadControls = await fetch(`${base}/environments/env-a/interactions/read-controls`, {
      method: 'PUT', headers: { 'content-type': 'application/json', 'x-test-user': 'user-a' },
      body: JSON.stringify({ expectedVersion: 1, commentsReadEnabled: true, dmReadEnabled: true, writePaused: false }),
    });
    assert.equal(invalidReadControls.status, 422);
    assert.equal(readControlUpdates, 0);

    const deniedReadControls = await fetch(`${base}/environments/env-a/interactions/read-controls`, {
      method: 'PUT', headers: { 'content-type': 'application/json', 'x-test-user': 'user-b' },
      body: JSON.stringify({ expectedVersion: 1, commentsReadEnabled: false, dmReadEnabled: false }),
    });
    assert.equal(deniedReadControls.status, 404);
    assert.equal(readControlUpdates, 0);

    const readControls = await fetch(`${base}/environments/env-a/interactions/read-controls`, {
      method: 'PUT', headers: { 'content-type': 'application/json', 'x-test-user': 'user-a' },
      body: JSON.stringify({ expectedVersion: 1, commentsReadEnabled: false, dmReadEnabled: true }),
    });
    assert.equal(readControls.status, 200);
    const readControlsBody = await readControls.json() as { data: {
      auth: { runtimeControls: { storedVersion: number; applicationStatus: string; stored: Record<string, boolean> } };
      edgeDelivery: { status: string; delivered: number }; replyConfig: { status: string };
    } };
    assert.equal(readControlsBody.data.auth.runtimeControls.storedVersion, 2);
    assert.equal(readControlsBody.data.auth.runtimeControls.applicationStatus, 'pending');
    assert.equal(readControlsBody.data.auth.runtimeControls.stored.commentsReadEnabled, false);
    assert.equal(readControlsBody.data.auth.runtimeControls.stored.commentsReplyEnabled, true);
    assert.equal(readControlsBody.data.auth.runtimeControls.stored.dmSendTextEnabled, true);
    assert.deepEqual(readControlsBody.data.edgeDelivery, { status: 'enqueued', delivered: 1 });
    assert.equal(readControlsBody.data.replyConfig.status, 'published');
    assert.equal(readControlUpdates, 1);
    assert.equal(runtimeDeliveries, 1);

    const unknownQuery = await fetch(`${base}/environments/env-a/interactions?unexpected=1`,
      { headers: { 'x-test-user': 'user-a' } });
    assert.equal(unknownQuery.status, 422);
    const malformedPath = await fetch(`${base}/environments/%ZZ/interactions`,
      { headers: { 'x-test-user': 'user-a' } });
    assert.equal(malformedPath.status, 422);

    const deniedBrowser = await fetch(`${base}/environments/env-a/interactions/browser`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-test-user': 'user-b', 'idempotency-key': 'browser-key' },
      body: JSON.stringify({ action: 'open' }),
    });
    assert.equal(deniedBrowser.status, 404);
    assert.equal(browserDispatchCalls, 0);

    const invalidBrowser = await fetch(`${base}/environments/env-a/interactions/browser`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-test-user': 'user-a', 'idempotency-key': 'browser-key' },
      body: JSON.stringify({ action: 'focus' }),
    });
    assert.equal(invalidBrowser.status, 422);
    assert.equal(browserDispatchCalls, 0);

    authStatus = 'reauth_required';
    const inactiveBrowser = await fetch(`${base}/environments/env-a/interactions/browser`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-test-user': 'user-a', 'idempotency-key': 'browser-key' },
      body: JSON.stringify({ action: 'open' }),
    });
    assert.equal(inactiveBrowser.status, 409);
    assert.equal(browserDispatchCalls, 0);
    authStatus = 'active';

    const acceptedBrowser = await fetch(`${base}/environments/env-a/interactions/browser`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-test-user': 'user-a', 'idempotency-key': 'browser-key' },
      body: JSON.stringify({ action: 'open' }),
    });
    assert.equal(acceptedBrowser.status, 200);
    const acceptedBrowserBody = await acceptedBrowser.json() as { data: {
      envKey: string; accountId: string; action: string; browserAction: string; actionRequestId: string; status: string;
    } };
    assert.deepEqual(acceptedBrowserBody.data, {
      envKey: 'env-a', accountId: 'acct-a', action: 'browser_control', browserAction: 'open',
      actionRequestId: 'browser-control-request-1', status: 'accepted',
    });
    assert.equal(browserDispatchCalls, 1);

    const duplicateBrowser = await fetch(`${base}/environments/env-a/interactions/browser`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-test-user': 'user-a', 'idempotency-key': 'browser-key' },
      body: JSON.stringify({ action: 'open' }),
    });
    assert.equal(duplicateBrowser.status, 200);
    assert.deepEqual(await duplicateBrowser.json(), acceptedBrowserBody);
    assert.equal(browserDispatchCalls, 1, '同一幂等键不得重复派发浏览器控制');
    assert.equal(browserClaimCalls, 2);

    const unknownInteractionRoute = await fetch(`${base}/environments/env-a/interactions/not-a-route`,
      { method: 'POST', headers: { 'x-test-user': 'user-a' } });
    assert.equal(unknownInteractionRoute.status, 404);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
