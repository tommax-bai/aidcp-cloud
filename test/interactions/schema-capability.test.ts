import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Pool } from 'pg';
import { InteractionStore } from '../../src/interactions/interaction-store.js';
import {
  classifyInteractionSchema,
  interactionWritesAllowed,
  type InteractionSchemaShape,
} from '../../src/interactions/schema-capability.js';

function storeFor(shape: InteractionSchemaShape, captureSql?: (sql: string) => void): InteractionStore {
  const pool = {
    query: async (sql: string) => {
      captureSql?.(sql);
      return {
        rows: [{
          base_present: shape.basePresent,
          active_attempt_index_present: shape.activeAttemptIndexPresent,
          legacy_retryable_column_present: shape.legacyRetryableColumnPresent,
        }],
      };
    },
  } as unknown as Pool;
  return new InteractionStore({ pool });
}

test('interaction store starts full mode only for the completed migration 0046 shape', async () => {
  const store = storeFor({
    basePresent: true,
    activeAttemptIndexPresent: true,
    legacyRetryableColumnPresent: false,
  });
  assert.equal(await store.init(), 'full');
  assert.equal(interactionWritesAllowed('full', true), true);
  assert.equal(interactionWritesAllowed('full', false), false);
});

test('interaction store starts legacy read-only mode without executing DDL', async () => {
  let inspectedSql = '';
  const store = storeFor({
    basePresent: true,
    activeAttemptIndexPresent: false,
    legacyRetryableColumnPresent: true,
  }, (sql) => { inspectedSql = sql; });

  assert.equal(await store.init(), 'legacy_read_only');
  assert.equal(interactionWritesAllowed('legacy_read_only', true), false);
  assert.match(inspectedSql.trimStart(), /^SELECT\b/);
  assert.doesNotMatch(inspectedSql, /\b(?:ALTER|CREATE|DROP)\b/i);
});

test('legacy writes use the existing global switch only in dev', () => {
  assert.equal(interactionWritesAllowed('legacy_read_only', true, 'dev'), true);
  assert.equal(interactionWritesAllowed('legacy_read_only', false, 'dev'), false);
  assert.equal(interactionWritesAllowed('legacy_read_only', true, 'ol'), false);
  assert.equal(interactionWritesAllowed('legacy_read_only', true), false);
  assert.equal(interactionWritesAllowed(undefined, true, 'dev'), false);
});

test('interaction store rejects a missing base schema', async () => {
  const store = storeFor({
    basePresent: false,
    activeAttemptIndexPresent: false,
    legacyRetryableColumnPresent: true,
  });
  await assert.rejects(store.init(), /interaction_schema_missing_run_0042/);
});

test('interaction schema classifier rejects both partial migration 0046 shapes', () => {
  assert.throws(() => classifyInteractionSchema({
    basePresent: true,
    activeAttemptIndexPresent: true,
    legacyRetryableColumnPresent: true,
  }), /interaction_schema_inconsistent_run_0046/);
  assert.throws(() => classifyInteractionSchema({
    basePresent: true,
    activeAttemptIndexPresent: false,
    legacyRetryableColumnPresent: false,
  }), /interaction_schema_inconsistent_run_0046/);
});
