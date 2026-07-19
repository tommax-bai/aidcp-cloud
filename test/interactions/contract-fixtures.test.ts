import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { DefaultMessageHandler, makeEnvelope, parseEnvelope } from '../../src/comm/index.js';
import type { AnchorStore } from '../../src/comm/handler.js';
import type { EdgeSession } from '../../src/comm/ws-server.js';
import { EventBus } from '../../src/event-bus/index.js';
import { SimplePlanner } from '../../src/planner/index.js';
import {
  parseAuthStatusPayload,
  parseOffboardResultPayload,
  parseReplyReconcileResultPayload,
  parseReplyResultPayload,
  parseSyncBatchPayload,
} from '../../src/interactions/contract.js';
import type {
  InteractionAuthStatusPayload,
  InteractionReplyResultPayload,
  InteractionSyncAckPayload,
  InteractionSyncBatchPayload,
} from '../../src/interactions/types.js';

const fixtureRoot = new URL('../fixtures/wechat-channels-interaction/v1/ws/', import.meta.url);

async function fixture(name: string) {
  const raw = await readFile(new URL(name, fixtureRoot), 'utf8');
  const envelope = parseEnvelope(raw);
  assert.ok(envelope, `${name} 必须是 WS v2 envelope`);
  assert.equal(envelope.v, 2);
  return envelope;
}

function cache(): AnchorStore {
  return {
    get: async () => null,
    recordHit: async () => {},
    recordFailure: async () => {},
    stage: async () => {},
    confirmStaged: async () => ({ promoted: false, successes: 1, needed: 2 }),
    dropStaged: async () => {},
  };
}

test('frozen v1 WS fixtures are accepted by strict Cloud consumers', async () => {
  const auth = await fixture('auth-status-active.json');
  const occupiedAuth = await fixture('auth-status-profile-in-use.json');
  const batch = await fixture('comment-sync-batch.json');
  const confirmed = await fixture('comment-reply-result-confirmed.json');
  const ambiguous = await fixture('dm-reply-result-ambiguous.json');
  const dmBatch = await fixture('dm-sync-batch.json');
  const reconcileResult = await fixture('reply-reconcile-result.json');
  const offboardResult = await fixture('offboard-result.json');

  assert.ok(parseAuthStatusPayload(auth.payload));
  const parsedOccupiedAuth = parseAuthStatusPayload(occupiedAuth.payload);
  assert.ok(parsedOccupiedAuth);
  assert.equal(parsedOccupiedAuth.status, 'reauth_required');
  assert.equal(parsedOccupiedAuth.browserState, 'unavailable');
  assert.equal(parsedOccupiedAuth.reasonCode, 'INTERACTION_BROWSER_PROFILE_IN_USE');
  assert.equal('ownerHint' in (occupiedAuth.payload as Record<string, unknown>), false);
  assert.ok(parseSyncBatchPayload(batch.payload));
  assert.ok(parseReplyResultPayload(confirmed.payload));
  assert.ok(parseReplyResultPayload(ambiguous.payload));
  assert.ok(parseSyncBatchPayload(dmBatch.payload));
  assert.ok(parseReplyReconcileResultPayload(reconcileResult.payload));
  assert.ok(parseOffboardResultPayload(offboardResult.payload));

  assert.equal(parseSyncBatchPayload({ ...(batch.payload as object), unexpected: true }), null,
    '冻结 payload 对额外字段 fail closed');
  assert.equal(parseReplyResultPayload({ ...(confirmed.payload as object), errorCategory: 'invented' }), null);
  assert.equal(parseAuthStatusPayload({ ...(auth.payload as object), reasonCode: 'invented' }), null);

  const expectedTypes: Record<string, string> = {
    'hello.json': 'hello', 'welcome.json': 'welcome', 'auth-status-active.json': 'interaction.auth.status',
    'auth-status-profile-in-use.json': 'interaction.auth.status',
    'auth-reopen.json': 'interaction.auth.reopen', 'sync-request.json': 'interaction.sync.request',
    'test-reset-sync-request.json': 'interaction.sync.request',
    'browser-control-open.json': 'interaction.browser.control',
    'comment-sync-batch.json': 'interaction.sync.batch', 'dm-sync-batch.json': 'interaction.sync.batch',
    'comment-sync-ack.json': 'interaction.sync.ack', 'dm-sync-ack.json': 'interaction.sync.ack',
    'comment-reply-send.json': 'interaction.reply.send', 'dm-reply-send.json': 'interaction.reply.send',
    'comment-reply-result-confirmed.json': 'interaction.reply.result',
    'dm-reply-result-ambiguous.json': 'interaction.reply.result',
    'comment-reply-result-ack.json': 'interaction.reply.result.ack',
    'reply-reconcile.json': 'interaction.reply.reconcile',
    'reply-reconcile-result.json': 'interaction.reply.reconcile.result',
    'offboard-command.json': 'interaction.offboard.command',
    'offboard-result.json': 'interaction.offboard.result',
    'offboard-ack.json': 'interaction.offboard.ack',
  };
  for (const [name, type] of Object.entries(expectedTypes)) {
    const envelope = await fixture(name);
    assert.equal(envelope.type, type, name);
    if (type.startsWith('interaction.')) {
      assert.equal((envelope.payload as { platform?: string }).platform, 'wechat_channels', name);
    }
  }
});

test('mock Edge hello → sync batch/ack → confirmed result uses frozen v1 mapping', async () => {
  const seen: Array<'auth' | 'batch' | 'result'> = [];
  let persisted: InteractionSyncBatchPayload | null = null;
  let result: InteractionReplyResultPayload | null = null;
  const handler = new DefaultMessageHandler({
    planner: new SimplePlanner(),
    llm: { complete: async () => '0' },
    cache: cache(),
    clock: () => 1784044802100,
    eventBus: new EventBus(),
    interactionInbox: {
      onAuthStatus: async (_payload: InteractionAuthStatusPayload) => { seen.push('auth'); },
      onSyncBatch: async (payload: InteractionSyncBatchPayload): Promise<InteractionSyncAckPayload> => {
        seen.push('batch');
        persisted = payload;
        return {
          batchId: payload.batchId, envKey: payload.envKey, accountId: payload.accountId,
          platform: payload.platform, channel: payload.channel, scopeExternalId: payload.scopeExternalId,
          status: 'accepted', cursorAfter: payload.cursorAfter,
          persisted: { threads: payload.threads.length, messages: payload.messages.length },
          errorCode: null, receivedAt: 1784044802100,
        };
      },
      onReplyResult: async (payload: InteractionReplyResultPayload) => {
        seen.push('result'); result = payload; return { duplicate: false };
      },
      onReplyReconcileResult: async () => {},
      onOffboardResult: async () => ({ duplicate: false }),
      hasPendingOffboard: async () => false,
    },
  });
  const session: EdgeSession = { sessionId: 'mock-edge-session' };
  const hello = await handler.handle(await fixture('hello.json'), session);
  assert.equal(hello?.type, 'welcome');
  assert.deepEqual((hello?.payload as { capabilities?: string[] }).capabilities,
    ['interaction_inbox_v1', 'interaction_reply_recovery_v1', 'interaction_offboarding_v1',
      'interaction_browser_control_v1', 'interaction_test_data_reset_v1']);
  assert.deepEqual((hello?.payload as { interactionRecovery?: unknown }).interactionRecovery,
    { offboardPending: false });

  const auth = await handler.handle(await fixture('auth-status-active.json'), session);
  assert.equal(auth, null);
  const ack = await handler.handle(await fixture('comment-sync-batch.json'), session);
  assert.equal(ack?.type, 'interaction.sync.ack');
  assert.equal((ack?.payload as InteractionSyncAckPayload).status, 'accepted');
  assert.equal((ack?.payload as InteractionSyncAckPayload).persisted.messages, 1);
  const confirmed = await handler.handle(await fixture('comment-reply-result-confirmed.json'), session);
  assert.equal(confirmed?.type, 'interaction.reply.result.ack');
  assert.equal(persisted!.batchId, 'batch-comment-001');
  assert.equal(result!.status, 'confirmed');
  assert.deepEqual(seen, ['auth', 'batch', 'result']);
});

test('runtime-controls negotiation includes a scoped welcome snapshot and provider failure is all-off', async () => {
  const makeHandler = (fails: boolean) => new DefaultMessageHandler({
    planner: new SimplePlanner(), llm: { complete: async () => '0' }, cache: cache(),
    clock: () => 1784044802100, eventBus: new EventBus(),
    interactionInbox: {
      onAuthStatus: async () => {}, onSyncBatch: async () => { throw new Error('unused'); },
      onReplyResult: async () => ({ duplicate: false }), onReplyReconcileResult: async () => {},
      onOffboardResult: async () => ({ duplicate: false }), hasPendingOffboard: async () => false,
    },
    interactionRuntimeControls: {
      getSnapshot: async (accountId) => {
        if (fails) throw new Error('pg unavailable');
        return {
          accountId, envKey: 'env_wc_demo', version: 7,
          commentsReadEnabled: true, commentsReplyEnabled: false,
          dmReadEnabled: true, dmSendTextEnabled: false, dmSendImageEnabled: false,
        };
      },
    },
  });
  const ok = await makeHandler(false).handle(await fixture('hello.json'), { sessionId: 'controls-ok' });
  assert.deepEqual((ok?.payload as { interactionRuntime?: unknown }).interactionRuntime, {
    accountId: 'acct_wc_demo', envKey: 'env_wc_demo', version: 7,
    commentsReadEnabled: true, commentsReplyEnabled: false,
    dmReadEnabled: true, dmSendTextEnabled: false, dmSendImageEnabled: false,
  });
  const failed = await makeHandler(true).handle(await fixture('hello.json'), { sessionId: 'controls-failed' });
  assert.deepEqual((failed?.payload as { interactionRuntime?: unknown }).interactionRuntime, {
    accountId: 'acct_wc_demo', envKey: 'acct_wc_demo', version: 0,
    commentsReadEnabled: false, commentsReplyEnabled: false,
    dmReadEnabled: false, dmSendTextEnabled: false, dmSendImageEnabled: false,
  });
});

test('mock Edge scope mismatch is rejected without persisting batch', async () => {
  let called = false;
  const handler = new DefaultMessageHandler({
    planner: new SimplePlanner(), llm: { complete: async () => '0' }, cache: cache(),
    clock: () => 1, eventBus: new EventBus(),
    interactionInbox: {
      onAuthStatus: async () => {},
      onSyncBatch: async () => { called = true; throw new Error('must not run'); },
      onReplyResult: async () => ({ duplicate: false }),
      onReplyReconcileResult: async () => {},
      onOffboardResult: async () => ({ duplicate: false }),
    },
  });
  const session: EdgeSession = {
    sessionId: 'scope-mismatch', accountId: 'other-account', platform: 'wechat_channels',
    capabilities: ['interaction_inbox_v1'],
  };
  const ack = await handler.handle(await fixture('comment-sync-batch.json'), session);
  assert.equal((ack?.payload as InteractionSyncAckPayload).status, 'rejected');
  assert.equal((ack?.payload as InteractionSyncAckPayload).errorCode, 'INTERACTION_SCOPE_MISMATCH');
  assert.equal(called, false);
});

test('durable reply/offboard results receive scope-bound duplicate-safe acknowledgements', async () => {
  let replyCalls = 0;
  let reconcileCalls = 0;
  let offboardCalls = 0;
  const handler = new DefaultMessageHandler({
    planner: new SimplePlanner(), llm: { complete: async () => '0' }, cache: cache(),
    clock: () => 1784044900000, eventBus: new EventBus(),
    interactionInbox: {
      onAuthStatus: async () => {},
      onSyncBatch: async () => { throw new Error('unused'); },
      onReplyResult: async () => ({ duplicate: replyCalls++ > 0 }),
      onReplyReconcileResult: async () => { reconcileCalls++; },
      onOffboardResult: async () => ({ duplicate: offboardCalls++ > 0 }),
    },
  });
  const session: EdgeSession = { sessionId: 'recovery-edge', accountId: 'acct_wc_demo', platform: 'wechat_channels',
    capabilities: ['interaction_inbox_v1', 'interaction_reply_recovery_v1', 'interaction_offboarding_v1'] };
  const baseResult = (await fixture('comment-reply-result-confirmed.json')).payload as InteractionReplyResultPayload;
  const first = await handler.handle(makeEnvelope('interaction.reply.result', 'result-1', 1, baseResult), session);
  const duplicate = await handler.handle(makeEnvelope('interaction.reply.result', 'result-2', 2, baseResult), session);
  assert.equal(first?.type, 'interaction.reply.result.ack');
  assert.equal((first?.payload as { status: string }).status, 'accepted');
  assert.equal((duplicate?.payload as { status: string }).status, 'duplicate');
  assert.equal(first?.id, 'result-1');

  const reconcile = await handler.handle(makeEnvelope('interaction.reply.reconcile.result', 'reconcile-1', 3, {
    reconcileId: 'reconcile-1', envKey: baseResult.envKey, accountId: baseResult.accountId,
    platform: 'wechat_channels', attempts: [{ jobId: baseResult.jobId, attemptId: baseResult.attemptId,
      idempotencyKey: baseResult.idempotencyKey, state: 'result_replayed', observedAt: 3 }], finishedAt: 3,
  }), session);
  assert.equal(reconcile, null);
  assert.equal(reconcileCalls, 1);

  const offboardPayload = { offboardId: 'offboard-1', envKey: baseResult.envKey, accountId: baseResult.accountId,
    platform: 'wechat_channels' as const, status: 'cleared' as const, errorCode: null, finishedAt: 4 };
  const offboard = await handler.handle(makeEnvelope('interaction.offboard.result', 'offboard-result-1', 4,
    offboardPayload), session);
  const offboardDuplicate = await handler.handle(makeEnvelope('interaction.offboard.result', 'offboard-result-2', 5,
    offboardPayload), session);
  assert.equal(offboard?.type, 'interaction.offboard.ack');
  assert.equal((offboard?.payload as { status: string }).status, 'accepted');
  assert.equal((offboardDuplicate?.payload as { status: string }).status, 'duplicate');
});
