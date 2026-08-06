import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DefaultMessageHandler, type AnchorStore } from '@automation/comm/handler.js';
import { makeEnvelope } from '@automation/comm/protocol.js';
import type { EdgeSession } from '@automation/comm/ws-server.js';
import { EventBus } from '@automation/event-bus/index.js';
import type { LlmClient } from '@content/llm/qwen.js';
import { SimplePlanner } from '@automation/planner/index.js';

const cache = {
  get: async () => null,
  recordHit: async () => {},
  recordFailure: async () => {},
  stage: async () => {},
  confirmStaged: async () => ({ promoted: false, successes: 0, needed: 1 }),
  dropStaged: async () => {},
} as unknown as AnchorStore;

const llm: LlmClient = { complete: async () => '0' };
const session: EdgeSession = {
  sessionId: 'fb-comment-accounting',
  edgeId: 'edge-fb-comment',
  accountId: 'acc-fb',
  platform: 'facebook',
  currentNoteId: 'note-1',
};

function harness() {
  const enqueued: Array<{ accountId: string; action: string; dedupeKey: string }> = [];
  const emitted: Array<{ accountId?: string; action: string; targetId?: string }> = [];
  const eventBus = new EventBus();
  eventBus.on('interaction.occurred', (event) => {
    emitted.push({
      accountId: event.accountId,
      action: event.action,
      ...(event.targetId ? { targetId: event.targetId } : {}),
    });
  });
  const handler = new DefaultMessageHandler({
    planner: new SimplePlanner(),
    llm,
    cache,
    eventBus,
    clock: () => 1_000,
    riskAccounting: {
      enqueue: async (input) => {
        enqueued.push({
          accountId: input.accountId,
          action: input.action,
          dedupeKey: input.dedupeKey,
        });
      },
      record: async () => ({ allowed: true }),
    },
  });
  return { handler, enqueued, emitted };
}

test('Facebook verification_ambiguous enters the existing comment accounting funnel without becoming ok', async () => {
  const { handler, enqueued, emitted } = harness();

  await handler.handle(makeEnvelope('action.completed', 'ambiguous-1', 1_000, {
    action: 'comment',
    ok: false,
    reason: 'verification_ambiguous',
  }), session);

  assert.deepEqual(enqueued, [{
    accountId: 'acc-fb',
    action: 'comment',
    dedupeKey: 'edge-risk:acc-fb:edge-fb-comment:1000:ambiguous-1:comment',
  }]);
  assert.deepEqual(emitted, [{ accountId: 'acc-fb', action: 'comment' }]);
});

test('confirmed comment keeps the same accounting path', async () => {
  const { handler, enqueued, emitted } = harness();

  await handler.handle(makeEnvelope('action.completed', 'confirmed-1', 1_000, {
    action: 'comment',
    ok: true,
  }), session);

  assert.deepEqual(
    enqueued.map((fact) => fact.dedupeKey),
    ['edge-risk:acc-fb:edge-fb-comment:1000:confirmed-1:comment'],
  );
  assert.deepEqual(emitted, [{ accountId: 'acc-fb', action: 'comment', targetId: 'note-1' }]);
});

test('known-not-live and pre-submit comment failures do not consume comment accounting', async () => {
  for (const [index, reason] of [
    'pending_group_approval',
    'comment_rejected',
    'editor_not_found',
    'marker_not_accepted',
  ].entries()) {
    const { handler, enqueued, emitted } = harness();
    await handler.handle(makeEnvelope('action.completed', `not-counted-${index}`, 1_000, {
      action: 'comment',
      ok: reason === 'pending_group_approval' || reason === 'comment_rejected',
      reason,
    }), session);
    assert.deepEqual(enqueued, [], `${reason} MUST NOT enter risk accounting`);
    assert.deepEqual(emitted, [], `${reason} MUST NOT project as consumed comment usage`);
  }
});
