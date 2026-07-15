import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { DefaultMessageHandler, parseEnvelope } from '../../src/comm/index.js';
import type { AnchorStore } from '../../src/comm/handler.js';
import type { EdgeSession } from '../../src/comm/ws-server.js';
import { EventBus } from '../../src/event-bus/index.js';
import { SimplePlanner } from '../../src/planner/index.js';
import { parseAuthStatusPayload, parseReplyResultPayload, parseSyncBatchPayload } from '../../src/interactions/contract.js';
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
  const batch = await fixture('comment-sync-batch.json');
  const confirmed = await fixture('comment-reply-result-confirmed.json');
  const ambiguous = await fixture('dm-reply-result-ambiguous.json');
  const dmBatch = await fixture('dm-sync-batch.json');

  assert.ok(parseAuthStatusPayload(auth.payload));
  assert.ok(parseSyncBatchPayload(batch.payload));
  assert.ok(parseReplyResultPayload(confirmed.payload));
  assert.ok(parseReplyResultPayload(ambiguous.payload));
  assert.ok(parseSyncBatchPayload(dmBatch.payload));

  assert.equal(parseSyncBatchPayload({ ...(batch.payload as object), unexpected: true }), null,
    '冻结 payload 对额外字段 fail closed');
  assert.equal(parseReplyResultPayload({ ...(confirmed.payload as object), errorCategory: 'invented' }), null);
  assert.equal(parseAuthStatusPayload({ ...(auth.payload as object), reasonCode: 'invented' }), null);

  const expectedTypes: Record<string, string> = {
    'hello.json': 'hello', 'welcome.json': 'welcome', 'auth-status-active.json': 'interaction.auth.status',
    'auth-reopen.json': 'interaction.auth.reopen', 'sync-request.json': 'interaction.sync.request',
    'comment-sync-batch.json': 'interaction.sync.batch', 'dm-sync-batch.json': 'interaction.sync.batch',
    'comment-sync-ack.json': 'interaction.sync.ack', 'dm-sync-ack.json': 'interaction.sync.ack',
    'comment-reply-send.json': 'interaction.reply.send', 'dm-reply-send.json': 'interaction.reply.send',
    'comment-reply-result-confirmed.json': 'interaction.reply.result',
    'dm-reply-result-ambiguous.json': 'interaction.reply.result',
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
      onReplyResult: async (payload: InteractionReplyResultPayload) => { seen.push('result'); result = payload; },
    },
  });
  const session: EdgeSession = { sessionId: 'mock-edge-session' };
  const hello = await handler.handle(await fixture('hello.json'), session);
  assert.equal(hello?.type, 'welcome');
  assert.deepEqual((hello?.payload as { capabilities?: string[] }).capabilities, ['interaction_inbox_v1']);

  const auth = await handler.handle(await fixture('auth-status-active.json'), session);
  assert.equal(auth, null);
  const ack = await handler.handle(await fixture('comment-sync-batch.json'), session);
  assert.equal(ack?.type, 'interaction.sync.ack');
  assert.equal((ack?.payload as InteractionSyncAckPayload).status, 'accepted');
  assert.equal((ack?.payload as InteractionSyncAckPayload).persisted.messages, 1);
  const confirmed = await handler.handle(await fixture('comment-reply-result-confirmed.json'), session);
  assert.equal(confirmed, null);
  assert.equal(persisted!.batchId, 'batch-comment-001');
  assert.equal(result!.status, 'confirmed');
  assert.deepEqual(seen, ['auth', 'batch', 'result']);
});

test('mock Edge scope mismatch is rejected without persisting batch', async () => {
  let called = false;
  const handler = new DefaultMessageHandler({
    planner: new SimplePlanner(), llm: { complete: async () => '0' }, cache: cache(),
    clock: () => 1, eventBus: new EventBus(),
    interactionInbox: {
      onAuthStatus: async () => {},
      onSyncBatch: async () => { called = true; throw new Error('must not run'); },
      onReplyResult: async () => {},
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
