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

function harness(platform = 'facebook') {
  const enqueued: Array<{ accountId: string; action: string; dedupeKey: string }> = [];
  const interactions: Array<{
    accountId?: string;
    action: string;
    noteId?: string;
    targetId?: string;
  }> = [];
  const completions: Array<{ ok: boolean; reason?: string }> = [];
  const eventBus = new EventBus();
  eventBus.on('interaction.occurred', (event) => {
    interactions.push(event);
  });
  eventBus.on('action.completed', (event) => {
    completions.push({ ok: event.ok, reason: event.reason });
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
  const session: EdgeSession = {
    sessionId: `like-accounting-${platform}`,
    edgeId: `edge-like-${platform}`,
    accountId: 'acc-like',
    platform,
    currentNoteId: 'https://www.facebook.com/posts/current',
  };
  return { handler, session, enqueued, interactions, completions };
}

for (const reason of ['verify_indeterminate', 'state_unchanged'] as const) {
  test(`Facebook like ${reason} consumes risk without projecting liked target lineage`, async () => {
    const { handler, session, enqueued, interactions, completions } = harness();
    await handler.handle(makeEnvelope('action.completed', `like-${reason}`, 1_000, {
      action: 'like',
      ok: false,
      reason,
      noteId: 'https://www.facebook.com/posts/echoed',
    }), session);

    assert.deepEqual(enqueued, [{
      accountId: 'acc-like',
      action: 'like',
      dedupeKey: `edge-risk:acc-like:edge-like-facebook:1000:like-${reason}:like`,
    }]);
    assert.deepEqual(interactions, [{ accountId: 'acc-like', action: 'like' }]);
    assert.equal(Object.hasOwn(interactions[0]!, 'noteId'), false);
    assert.equal(Object.hasOwn(interactions[0]!, 'targetId'), false);
    assert.deepEqual(
      completions,
      [{ ok: false, reason }],
      'risk accounting must not promote an unknown write to platform success',
    );
  });
}

test('the conservative unknown accounting exception remains Facebook-only', async () => {
  const { handler, session, enqueued, interactions } = harness('xiaohongshu');
  await handler.handle(makeEnvelope('action.completed', 'xhs-state-unchanged', 1_000, {
    action: 'like',
    ok: false,
    reason: 'state_unchanged',
    noteId: 'xhs-note',
  }), session);

  assert.deepEqual(enqueued, []);
  assert.deepEqual(interactions, []);
});
