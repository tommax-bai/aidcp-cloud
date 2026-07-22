import { test } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import {
  APPROVAL_POLICY_SCHEMA_SQL,
  ApprovalPolicyStore,
} from '../src/config/approval-policy-store.js';

function fakePool(handler: (sql: string, params: unknown[]) => { rows: any[] }) {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  return {
    calls,
    pool: {
      query: async (sql: string, params: unknown[] = []) => {
        calls.push({ sql, params });
        return handler(sql, params);
      },
    } as unknown as pg.Pool,
  };
}

test('approval policy schema uses narrow constrained tables', () => {
  assert.match(APPROVAL_POLICY_SCHEMA_SQL, /account_comment_approval_policy/);
  assert.match(APPROVAL_POLICY_SCHEMA_SQL, /source_rules','auto_approve_all/);
  assert.match(APPROVAL_POLICY_SCHEMA_SQL, /group_publish_approval_policy/);
  assert.match(APPROVAL_POLICY_SCHEMA_SQL, /client_and_feishu','client_only/);
});

test('missing account/group policy rows preserve legacy defaults', async () => {
  const { pool } = fakePool((sql) => {
    if (sql.includes('account_comment_approval_policy')) return { rows: [] };
    return { rows: [{ group_label: 'team-a', delivery: null }] };
  });
  const store = new ApprovalPolicyStore({ pool });
  assert.equal(await store.getAccountCommentMode('acc-1'), 'source_rules');
  assert.deepEqual(await store.getGroupPublishPolicyForAccount('acc-1'), {
    groupLabel: 'team-a',
    delivery: 'client_and_feishu',
  });
});

test('account auto_approve_all write validates existence and returns database truth', async () => {
  const { pool, calls } = fakePool((sql) => {
    if (sql.startsWith('SELECT 1 FROM accounts')) return { rows: [{ '?column?': 1 }] };
    if (sql.includes('INSERT INTO account_comment_approval_policy')) {
      return { rows: [{ account_id: 'acc-1', mode: 'auto_approve_all', updated_by: 'alice', updated_at: new Date(0) }] };
    }
    return { rows: [] };
  });
  const result = await new ApprovalPolicyStore({ pool }).setAccountCommentMode('acc-1', 'auto_approve_all', 'alice');
  assert.deepEqual(result, {
    ok: true,
    row: { accountId: 'acc-1', mode: 'auto_approve_all', configured: true, updatedBy: 'alice', updatedAt: 0 },
  });
  assert.ok(calls.some((call) => call.sql.includes('ON CONFLICT(account_id) DO UPDATE')));
});

test('group client_only write rejects unknown groups', async () => {
  const { pool } = fakePool(() => ({ rows: [] }));
  assert.deepEqual(
    await new ApprovalPolicyStore({ pool }).setGroupPublishDelivery('missing', 'client_only', 'alice'),
    { ok: false, reason: 'group_not_found' },
  );
});

test('missing policy table fails safe to source_rules and dual-channel', async () => {
  const error = Object.assign(new Error('missing'), { code: '42P01' });
  const { pool } = fakePool(() => { throw error; });
  const store = new ApprovalPolicyStore({ pool });
  assert.equal(await store.getAccountCommentMode('acc-1'), 'source_rules');
  assert.deepEqual(await store.getGroupPublishPolicyForAccount('acc-1'), {
    groupLabel: null,
    delivery: 'client_and_feishu',
  });
});
