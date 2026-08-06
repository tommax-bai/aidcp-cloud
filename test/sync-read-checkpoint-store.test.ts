import assert from 'node:assert/strict';
import { test } from 'node:test';
import type pg from 'pg';

import { createApiSyncReadConsumerCheckpointStore } from '@api/config/api-sync-read-checkpoint-store.js';
import { syncReadPayloadDigest, type SyncReadConsumerCheckpoint } from '@kernel/kernel/sync-read-snapshot.js';
import { createAutomationSyncReadConsumerCheckpointStore } from '@automation/transport/automation-sync-read-checkpoint-store.js';

interface Call {
  sql: string;
  params: unknown[];
}

function fakePool(calls: Call[]): pg.Pool {
  return {
    query: async (sql: string, params: unknown[] = []) => {
      calls.push({ sql, params });
      if (!sql.includes('INSERT INTO')) return { rows: [] };
      const consumer = sql.includes('api_sync_read_consumer_checkpoint')
        ? 'api'
        : 'automation';
      return {
        rows: [
          {
            execution_target: params[0],
            consumer,
            stream: params[1],
            applied_cursor: params[2],
            payload_digest: params[3],
            source_as_of_ms: params[4],
            last_observed_at_ms: params[5],
            fresh_until_ms: params[6],
            last_applied_at_ms: params[7],
            state: params[8],
            last_error: params[9],
          },
        ],
      };
    },
  } as unknown as pg.Pool;
}

function checkpoint(
  consumer: 'api' | 'automation',
): SyncReadConsumerCheckpoint {
  return {
    executionTarget: 'dev',
    consumer,
    stream:
      consumer === 'api' ? 'session_config_global' : 'account_persona',
    appliedCursor: '900719925474099312345',
    payloadDigest: syncReadPayloadDigest({ current: true }),
    sourceAsOf: 1_000,
    lastObservedAt: 1_100,
    freshUntil: 2_000,
    lastAppliedAt: 1_100,
    state: 'ready',
    lastError: null,
  };
}

test('api checkpoint adapter writes only the fixed api owner-local table and target key', async () => {
  const calls: Call[] = [];
  const store = createApiSyncReadConsumerCheckpointStore(fakePool(calls), 'dev');
  const result = await store.save(checkpoint('api'));
  assert.equal(result.outcome, 'stored');
  assert.equal(calls.length, 1);
  assert.match(calls[0]!.sql, /INSERT INTO api_sync_read_consumer_checkpoint/);
  assert.doesNotMatch(calls[0]!.sql, /automation_sync_read_consumer_checkpoint/);
  assert.match(
    calls[0]!.sql,
    /ON CONFLICT \(execution_target, consumer, stream\)/,
  );
  assert.match(
    calls[0]!.sql,
    /EXCLUDED\.applied_cursor > api_sync_read_consumer_checkpoint\.applied_cursor/,
  );
  assert.match(
    calls[0]!.sql,
    /EXCLUDED\.payload_digest = api_sync_read_consumer_checkpoint\.payload_digest/,
  );
  assert.deepEqual(calls[0]!.params.slice(0, 3), [
    'dev',
    'session_config_global',
    '900719925474099312345',
  ]);
});

test('automation checkpoint adapter writes only the fixed automation owner-local table', async () => {
  const calls: Call[] = [];
  const store = createAutomationSyncReadConsumerCheckpointStore(
    fakePool(calls),
    'ol',
  );
  const input = { ...checkpoint('automation'), executionTarget: 'ol' as const };
  const result = await store.save(input);
  assert.equal(result.outcome, 'stored');
  assert.equal(calls.length, 1);
  assert.match(
    calls[0]!.sql,
    /INSERT INTO automation_sync_read_consumer_checkpoint/,
  );
  assert.doesNotMatch(calls[0]!.sql, /INSERT INTO api_sync_read_consumer_checkpoint/);
  assert.match(
    calls[0]!.sql,
    /EXCLUDED\.applied_cursor > automation_sync_read_consumer_checkpoint\.applied_cursor/,
  );
  assert.deepEqual(calls[0]!.params.slice(0, 2), ['ol', 'account_persona']);
});

test('factory-bound target and consumer reject mismatched checkpoints before SQL', async () => {
  const calls: Call[] = [];
  const store = createApiSyncReadConsumerCheckpointStore(fakePool(calls), 'dev');
  const targetMismatch = await store.save({
    ...checkpoint('api'),
    executionTarget: 'ol',
  });
  assert.equal(targetMismatch.outcome, 'rejected');
  const consumerMismatch = await store.save({
    ...checkpoint('api'),
    consumer: 'automation',
  });
  assert.equal(consumerMismatch.outcome, 'rejected');
  const streamMismatch = await store.load('account_persona');
  assert.equal(streamMismatch.outcome, 'unknown');
  assert.deepEqual(calls, []);
});
