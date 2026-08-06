import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DefaultMessageHandler, type AnchorStore } from '@automation/comm/handler.js';
import {
  SEARCH_ACTIVITY_RECEIPT_CAPABILITY,
  makeEnvelope,
  type ActionCompletedPayload,
} from '@automation/comm/protocol.js';
import type { EdgeSession } from '@automation/comm/ws-server.js';
import { EventBus } from '@automation/event-bus/index.js';
import { SimplePlanner } from '@automation/planner/index.js';
import type { LlmClient } from '@content/llm/qwen.js';

const cache = {
  get: async () => null,
  recordHit: async () => {},
  recordFailure: async () => {},
  stage: async () => {},
  confirmStaged: async () => ({ promoted: false, successes: 0, needed: 1 }),
  dropStaged: async () => {},
} as unknown as AnchorStore;
const llm: LlmClient = { complete: async () => '0' };

async function collect(payload: ActionCompletedPayload, capable = true, repeats = 1, known = true) {
  const bus = new EventBus();
  const facts: Array<{ activityId: string; outcome: string; resultCount?: number }> = [];
  bus.on('search.occurred', (event) => {
    facts.push(event);
  });
  const handler = new DefaultMessageHandler({ planner: new SimplePlanner(), llm, cache, eventBus: bus, clock: () => 1000 });
  const session: EdgeSession = {
    sessionId: 's',
    accountId: 'acc-search',
    capabilities: capable ? [SEARCH_ACTIVITY_RECEIPT_CAPABILITY] : [],
    ...(capable && known && payload.activityId
      ? {
        pendingSearchActivities: new Map([[
          payload.activityId,
          {
            purpose: payload.purpose === 'operator' || payload.purpose === 'task_targeting' ? payload.purpose : 'discovery',
            scope: payload.scope === 'container' ? 'container' : 'global',
          },
        ]]),
      }
      : {}),
  };
  for (let i = 0; i < repeats; i += 1) {
    await handler.handle(makeEnvelope('action.completed', `env-${i}`, i, payload), session);
  }
  return facts;
}

test('actuated search emits one account fact with visible result count', async () => {
  const facts = await collect({
    action: 'search', ok: true, activityId: 'activity-1', purpose: 'discovery', scope: 'global',
    actuated: true, searchOutcome: 'results_ready', resultCount: 3,
  });
  assert.deepEqual(facts, [{
    accountId: 'acc-search', activityId: 'activity-1', purpose: 'discovery', scope: 'global',
    outcome: 'results_ready', resultCount: 3,
  }]);
});

test('post-submit failure is still a fact, pre-submit failure is not', async () => {
  const actuated = await collect({
    action: 'search', ok: false, activityId: 'activity-2', purpose: 'task_targeting', scope: 'container',
    actuated: true, searchOutcome: 'failed_after_submit', reason: 'not_on_search_page',
  });
  assert.equal(actuated.length, 1);
  assert.equal(actuated[0].outcome, 'failed_after_submit');

  const unsubmitted = await collect({
    action: 'search', ok: false, activityId: 'activity-3', purpose: 'operator', scope: 'global',
    actuated: false, searchOutcome: 'not_submitted', reason: 'search_box_missing',
  });
  assert.equal(unsubmitted.length, 0);
});

test('duplicate terminal and old Edge never fabricate extra search facts', async () => {
  const payload: ActionCompletedPayload = {
    action: 'search', ok: true, activityId: 'activity-4', purpose: 'discovery', scope: 'global',
    actuated: true, searchOutcome: 'no_results', resultCount: 0,
  };
  assert.equal((await collect(payload, true, 2)).length, 1);
  assert.equal((await collect(payload, false)).length, 0);
});

test('unknown correlation and contradictory terminal are consumed without facts', async () => {
  const valid: ActionCompletedPayload = {
    action: 'search', ok: true, activityId: 'activity-unknown', purpose: 'discovery', scope: 'global',
    actuated: true, searchOutcome: 'results_ready', resultCount: 1,
  };
  assert.equal((await collect(valid, true, 1, false)).length, 0);

  assert.equal((await collect({
    ...valid,
    activityId: 'activity-contradictory',
    ok: false,
  })).length, 0);
});
