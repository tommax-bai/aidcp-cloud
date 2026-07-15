import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Envelope } from '../../src/comm/protocol.js';
import type { EdgePusher } from '../../src/comm/ws-server.js';
import type { InteractionStore } from '../../src/interactions/interaction-store.js';
import { InteractionMetrics } from '../../src/interactions/metrics.js';
import { InteractionOffboardingService } from '../../src/interactions/offboarding-service.js';

test('offboarding dispatch is scope-bound, body-free and remains pending while Edge is offline', async () => {
  const pushed: Envelope[] = [];
  const marked: string[] = [];
  let online = false;
  const store = {
    pendingOffboards: async () => [{ offboardId: 'offboard-1', accountId: 'acct-1', envKey: 'env-1',
      reason: 'environment_unbind', state: 'pending_edge', requestedAt: 10, purgeDueAt: 20 }],
    markOffboardDispatched: async (offboardId: string) => { marked.push(offboardId); },
  } as unknown as InteractionStore;
  const service = new InteractionOffboardingService({ store, metrics: new InteractionMetrics(), clock: () => 11,
    pusher: { pushToEdges: (envelope: Envelope, edgeId?: string) => {
      assert.equal(edgeId, 'edge-1');
      if (!online) return 0;
      pushed.push(envelope);
      return 1;
    } } as EdgePusher });
  assert.equal(await service.dispatchPending('acct-1', 'edge-1'), 0);
  assert.deepEqual(marked, []);
  online = true;
  assert.equal(await service.dispatchPending('acct-1', 'edge-1'), 1);
  assert.deepEqual(marked, ['offboard-1']);
  assert.equal(pushed[0].type, 'interaction.offboard.command');
  assert.deepEqual(pushed[0].payload, { offboardId: 'offboard-1', envKey: 'env-1', accountId: 'acct-1',
    platform: 'wechat_channels', reason: 'environment_unbind', requestedAt: 10, expiresAt: 20 });
  assert.doesNotMatch(JSON.stringify(pushed[0]), /content|cookie|credential|template/i);
});

test('offboarding retry resolves only the account-bound Edge and replays the same durable command identity', async () => {
  const pushed: Array<{ edgeId?: string; envelope: Envelope }> = [];
  const store = {
    pendingOffboards: async (accountId?: string) => {
      const all = [{ offboardId: 'offboard-retry-1', accountId: 'acct-1', envKey: 'env-1',
        reason: 'customer_terminated', state: 'dispatched', requestedAt: 10, purgeDueAt: 20 }];
      return accountId ? all.filter((item) => item.accountId === accountId) : all;
    },
    markOffboardDispatched: async () => {},
  } as unknown as InteractionStore;
  const service = new InteractionOffboardingService({ store, metrics: new InteractionMetrics(), clock: () => 12,
    pusher: {
      resolveEdgeIdForAccount: (accountId: string) => accountId === 'acct-1' ? 'edge-1' : null,
      pushToEdges: (envelope: Envelope, edgeId?: string) => { pushed.push({ edgeId, envelope }); return 1; },
    } as EdgePusher });
  assert.equal(await service.retryPending(), 1);
  assert.equal(pushed[0].edgeId, 'edge-1');
  assert.equal(pushed[0].envelope.type, 'interaction.offboard.command');
  assert.equal((pushed[0].envelope.payload as { offboardId: string }).offboardId, 'offboard-retry-1');
});
