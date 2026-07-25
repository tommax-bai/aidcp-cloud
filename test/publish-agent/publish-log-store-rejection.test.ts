import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PublishLogStore } from '../../src/publish-agent/publish-log-store.js';
import { hasUserRejectionEvidence, type PublishMetadata } from '../../src/publish-agent/types.js';
import { ensureCapabilitySchema, probeSchemaShape } from '../../src/schema/schema-capability.js';

test('candidate snapshot rejection evidence is true only for the durable explicit marker', () => {
  const evidenced = { approvalDecision: { kind: 'user_rejected', decidedAt: 1 } } as PublishMetadata;
  assert.equal(hasUserRejectionEvidence(evidenced), true);
  assert.equal(hasUserRejectionEvidence({} as PublishMetadata), false);
  assert.equal(hasUserRejectionEvidence(null), false);
});

test('rejectPendingApproval atomically records durable user rejection evidence', async () => {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const decidedAt = Date.parse('2026-07-21T11:30:00+08:00');
  const pool = {
    async query(sql: string, params: unknown[]) {
      calls.push({ sql, params });
      return { rows: [], rowCount: 1 };
    },
  };
  const store = new PublishLogStore({ schemaEnsurer: ensureCapabilitySchema, schemaProber: probeSchemaShape, pool: pool as never, clock: () => decidedAt });

  assert.equal(await store.rejectPendingApproval(175), true);
  // change publish-log-split-prep：命中后还会 fail-safe 双写执行态影子（needs_review），故共 2 条调用；
  // 权威的 publish_log reject 仍是第一条、谓词与语义一字未改。
  assert.equal(calls.length, 2);
  assert.match(calls[0].sql, /SET status = 'needs_review'/);
  assert.match(calls[0].sql, /COALESCE\(publish_metadata, '\{\}'::jsonb\)/);
  assert.match(calls[0].sql, /'\{approvalDecision\}'/);
  assert.match(calls[0].sql, /'kind', 'user_rejected'/);
  assert.match(calls[0].sql, /WHERE id = \$1 AND status = 'pending_approval'/);
  assert.deepEqual(calls[0].params, [175, decidedAt]);
  assert.match(calls[1].sql, /INSERT INTO publish_execution_state/);
  assert.deepEqual(calls[1].params, [175, 'needs_review', null, null]);
});

test('rejectPendingApproval reports no transition when the draft is no longer pending', async () => {
  const pool = { query: async () => ({ rows: [], rowCount: 0 }) };
  const store = new PublishLogStore({ schemaEnsurer: ensureCapabilitySchema, schemaProber: probeSchemaShape, pool: pool as never, clock: () => 1 });
  assert.equal(await store.rejectPendingApproval(175), false);
});
