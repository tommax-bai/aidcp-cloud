import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { EdgePusher } from '../../src/comm/ws-server.js';
import type { ReplyConfigStore } from '../../src/interactions/reply-config-store.js';
import type { InteractionStore } from '../../src/interactions/interaction-store.js';
import { InteractionInboxService } from '../../src/interactions/interaction-inbox-service.js';
import { InteractionMetrics } from '../../src/interactions/metrics.js';
import type { ReplyWorkflow } from '../../src/interactions/reply-workflow.js';
import { InteractionSendOrchestrator } from '../../src/interactions/send-orchestrator.js';
import type { InteractionSyncBatchPayload } from '../../src/interactions/types.js';

const auth = {
  envKey: 'env-a', accountId: 'acct-a', platform: 'wechat_channels' as const, status: 'active' as const,
  browserState: 'closed' as const,
  capabilities: { commentsRead: true, commentsReply: true, dmRead: true, dmSendText: true, dmSendImage: false as const },
  identity: { externalId: 'finder-a', displayName: '账号 A', identityHash: `sha256:${'a'.repeat(64)}` },
  checkedAt: 1, reasonCode: null,
};
const controls = {
  accountId: 'acct-a', platform: 'wechat_channels' as const, envKey: 'env-a', version: 1,
  commentsReadEnabled: true, commentsReplyEnabled: false, dmReadEnabled: true, dmSendTextEnabled: false,
  dmSendImageEnabled: false as const, writePaused: true, consecutiveFailures: 0, circuitOpenedAt: null,
  lastConfirmedAt: null, updatedAt: 1, updatedBy: 'admin',
};
const batch: InteractionSyncBatchPayload = {
  batchId: 'batch-a', requestId: null, envKey: 'env-a', accountId: 'acct-a', platform: 'wechat_channels',
  channel: 'comment', scopeExternalId: null, cursorBefore: null, cursorAfter: 'cursor-a', hasMore: false,
  threads: [], messages: [], observedAt: 1,
};

test('inbound sync uses read/auth gates but remains independent of reply config validity', async () => {
  let ingested = 0;
  const store = {
    getRuntimeControls: async () => controls,
    getAuth: async () => auth,
    ingestBatch: async () => {
      ingested += 1;
      return { ack: { batchId: 'batch-a', envKey: 'env-a', accountId: 'acct-a', platform: 'wechat_channels' as const,
        channel: 'comment' as const, scopeExternalId: null, status: 'accepted' as const, cursorAfter: 'cursor-a',
        persisted: { threads: 0, messages: 0 }, errorCode: null, receivedAt: 1 }, newJobIds: [] };
    },
  } as unknown as InteractionStore;
  const service = new InteractionInboxService({ store, workflow: {} as ReplyWorkflow,
    configs: new Proxy({}, { get() { throw new Error('sync_must_not_read_reply_config'); } }) as ReplyConfigStore,
    controllerFor: () => undefined, metrics: new InteractionMetrics() });
  assert.equal((await service.onSyncBatch(batch)).status, 'accepted');
  assert.equal(ingested, 1);

  const disabled = new InteractionInboxService({
    store: { ...store, getRuntimeControls: async () => ({ ...controls, commentsReadEnabled: false }) } as unknown as InteractionStore,
    workflow: {} as ReplyWorkflow, configs: {} as ReplyConfigStore,
    controllerFor: () => undefined, metrics: new InteractionMetrics(),
  });
  await assert.rejects(disabled.onSyncBatch(batch),
    (error: unknown) => (error as { code?: string }).code === 'INTERACTION_FEATURE_DISABLED');
  assert.equal(ingested, 1);
});

test('manual sync request checks read capability before emitting a WS command', async () => {
  let pushes = 0;
  const pusher = {
    resolveEdgeIdForAccount: () => 'edge-a',
    pushToEdges: () => { pushes += 1; return 1; },
  } as unknown as EdgePusher;
  const make = (capable: boolean) => new InteractionSendOrchestrator({
    store: {
      getRuntimeControls: async () => controls,
      getAuth: async () => ({ ...auth, capabilities: { ...auth.capabilities, commentsRead: capable } }),
    } as unknown as InteractionStore,
    configs: {} as ReplyConfigStore, pusher, controllerFor: () => undefined,
    metrics: new InteractionMetrics(), clock: () => 10,
  });
  await assert.rejects(make(false).requestSync({ accountId: 'acct-a', envKey: 'env-a', channel: 'comment',
    scopeExternalId: null, reason: 'user_requested' }),
  (error: unknown) => (error as { code?: string }).code === 'INTERACTION_PERMISSION_DENIED');
  assert.equal(pushes, 0);
  const requestId = await make(true).requestSync({ accountId: 'acct-a', envKey: 'env-a', channel: 'comment',
    scopeExternalId: null, reason: 'user_requested' });
  assert.ok(requestId);
  assert.equal(pushes, 1);
});
