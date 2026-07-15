import { makeEnvelope } from '../comm/protocol.js';
import type { EdgePusher } from '../comm/ws-server.js';
import { INTERACTION_PLATFORM } from './types.js';
import type { InteractionStore } from './interaction-store.js';
import type { InteractionMetrics } from './metrics.js';

export class InteractionOffboardingService {
  constructor(private readonly deps: {
    store: InteractionStore;
    pusher: EdgePusher;
    metrics: InteractionMetrics;
    clock?: () => number;
  }) {}

  async dispatchPending(accountId: string, edgeId: string): Promise<number> {
    const pending = await this.deps.store.pendingOffboards(accountId, 100);
    let sentCount = 0;
    for (const item of pending) {
      const now = (this.deps.clock ?? Date.now)();
      const sent = this.deps.pusher.pushToEdges(makeEnvelope('interaction.offboard.command', item.offboardId, now, {
        offboardId: item.offboardId, envKey: item.envKey, accountId: item.accountId,
        platform: INTERACTION_PLATFORM, reason: item.reason, requestedAt: item.requestedAt,
        expiresAt: item.purgeDueAt,
      }), edgeId);
      if (sent === 1) {
        await this.deps.store.markOffboardDispatched(item.offboardId, item.accountId, item.envKey);
        sentCount++;
      }
      this.deps.metrics.increment('interaction_offboard_dispatch_total', {
        status: sent === 1 ? 'dispatched' : 'deferred', reason: item.reason,
      });
    }
    return sentCount;
  }

  /** Periodic retry for offline/failed/lost-command recovery; command identity is durable and Edge is idempotent. */
  async retryPending(): Promise<number> {
    const pending = await this.deps.store.pendingOffboards(undefined, 100);
    const accounts = [...new Set(pending.map((item) => item.accountId))];
    let dispatched = 0;
    for (const accountId of accounts) {
      const edgeId = this.deps.pusher.resolveEdgeIdForAccount?.(accountId);
      if (!edgeId) continue;
      dispatched += await this.dispatchPending(accountId, edgeId);
    }
    return dispatched;
  }

  async purgeDue(): Promise<number> {
    const purged = await this.deps.store.purgeDueOffboards((this.deps.clock ?? Date.now)());
    if (purged) this.deps.metrics.increment('interaction_offboard_purge_total', { status: 'purged', count: String(purged) });
    return purged;
  }
}
