import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Pool } from 'pg';
import { InteractionStore } from '../../src/interactions/interaction-store.js';
import type { InteractionSyncBatchPayload } from '../../src/interactions/types.js';

test('pending list filter expands to all actionable reply job states', async () => {
  let capturedSql = '';
  let capturedParams: unknown[] = [];
  const pool = {
    query: async (sql: string, params: unknown[]) => {
      capturedSql = sql;
      capturedParams = params;
      return { rows: [] };
    },
  } as unknown as Pool;
  const store = new InteractionStore({ pool });

  const result = await store.listInteractions({
    accountId: 'acct-a', envKey: 'env-a', asOf: 1_784_044_800_000, limit: 30, state: 'pending',
  });

  assert.deepEqual(result, { items: [], next: null });
  assert.match(capturedSql, /j\.state=ANY\(\$5::text\[\]\)/);
  assert.deepEqual(capturedParams[4], [
    'new', 'classifying', 'draft_ready', 'approval_required', 'approved',
    'queued', 'sending', 'failed', 'ambiguous',
  ]);
});

test('sync freshness is account/env scoped and preserves per-channel observed/received time', async () => {
  let capturedSql = '';
  let capturedParams: unknown[] = [];
  const pool = {
    query: async (sql: string, params: unknown[]) => {
      capturedSql = sql;
      capturedParams = params;
      return { rows: [
        { channel: 'comment', observed_at: new Date(1_784_044_802_000), received_at: new Date(1_784_044_802_100) },
      ] };
    },
  } as unknown as Pool;
  const store = new InteractionStore({ pool });

  const result = await store.getSyncFreshness('acct-a', 'env-a');

  assert.deepEqual(result, {
    comment: { observedAt: 1_784_044_802_000, receivedAt: 1_784_044_802_100 },
    dm: null,
  });
  assert.deepEqual(capturedParams, ['wechat_channels', 'acct-a', 'env-a']);
  assert.match(capturedSql, /account_id=\$2 AND env_key=\$3/);
  assert.match(capturedSql, /ORDER BY channel,observed_at DESC,received_at DESC,id DESC/);
});

test('a newer observation of an unchanged empty batch advances evidence but an older replay does not', async () => {
  let observedAt = 1_784_044_800_000;
  let receivedAt = 1_784_044_800_100;
  let evidenceUpdates = 0;
  let cursorUpdates = 0;
  const client = {
    query: async (sql: string, params: unknown[] = []) => {
      if (sql.includes('SELECT platform FROM accounts')) return { rows: [{ platform: 'wechat_channels' }] };
      if (sql.includes('FROM interaction_auth_state') && sql.includes('FOR SHARE')) {
        return { rows: [{ account_id: 'acct-a', env_key: 'env-a' }] };
      }
      if (sql.includes('FROM interaction_sync_batches')) {
        return { rows: [{
          env_key: 'env-a', channel: 'comment', scope_external_id: null, cursor_after: 'cursor-a',
          persisted_threads: 0, persisted_messages: 0,
          observed_at: new Date(observedAt), received_at: new Date(receivedAt),
        }] };
      }
      if (sql.includes('UPDATE interaction_sync_batches')) {
        evidenceUpdates += 1;
        observedAt = params[3] as number;
        receivedAt = params[4] as number;
      }
      if (sql.includes('INSERT INTO interaction_sync_cursors')) cursorUpdates += 1;
      if (/INSERT INTO interaction_(threads|messages|reply_jobs)/.test(sql)) {
        throw new Error('duplicate evidence refresh must not write business rows');
      }
      return { rows: [] };
    },
    release: () => {},
  };
  const pool = { connect: async () => client } as unknown as Pool;
  const store = new InteractionStore({ pool, clock: () => 1_784_044_800_200 });
  const payload: InteractionSyncBatchPayload = {
    batchId: 'batch-a', requestId: 'request-a', envKey: 'env-a', accountId: 'acct-a',
    platform: 'wechat_channels', channel: 'comment', scopeExternalId: null,
    cursorBefore: null, cursorAfter: 'cursor-a', hasMore: false, threads: [], messages: [],
    observedAt: 1_784_044_800_500,
  };

  const newer = await store.ingestBatch(payload);
  assert.equal(newer.ack.status, 'duplicate');
  assert.equal(newer.ack.receivedAt, 1_784_044_800_200);
  assert.deepEqual([observedAt, receivedAt, evidenceUpdates, cursorUpdates],
    [1_784_044_800_500, 1_784_044_800_200, 1, 1]);

  const older = await store.ingestBatch({ ...payload, observedAt: 1_784_044_800_400 });
  assert.equal(older.ack.receivedAt, 1_784_044_800_200);
  assert.deepEqual([observedAt, receivedAt, evidenceUpdates, cursorUpdates],
    [1_784_044_800_500, 1_784_044_800_200, 1, 1]);
});
