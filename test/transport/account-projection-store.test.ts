/**
 * automation 域账号守卫投影的关键不变量（change automation-accounts-projection）。零数据库依赖。
 *
 * 只覆盖三件真正会伤人的事：
 * ① 同步是**原样搬列 + 只增不删**（归一或差集删除都会静默改守卫语义）；
 * ② 新鲜期只在**真读到东西**时才推进（空花名册 / 来源报错都不许冒充新鲜）；
 * ③ 读不到新鲜期一律当**不新鲜**（fail-closed）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type pg from 'pg';

import { PgAccountProjectionStore } from '../../src/transport/account-projection-store.js';
import type { AccountIdentityProjectionRow } from '../../src/kernel/account-projection-types.js';
import { makeSyncReadFactEnvelope } from '../../src/kernel/sync-read-facts.js';
import { syncReadPayloadDigest } from '../../src/kernel/sync-read-snapshot.js';

interface Call {
  sql: string;
  params: unknown[];
}

function fakePool(calls: Call[], onQuery?: (sql: string) => { rows: Record<string, unknown>[] } | undefined) {
  const client = {
    query: async (sql: string, params: unknown[] = []) => {
      calls.push({ sql, params });
      return onQuery?.(sql) ?? { rows: [] };
    },
    release() {},
  };
  return {
    connect: async () => client,
    query: async (sql: string, params: unknown[] = []) => {
      calls.push({ sql, params });
      return onQuery?.(sql) ?? { rows: [] };
    },
  } as unknown as pg.Pool;
}

const silent = { log() {}, warn() {}, error() {} };

test('refresh 原样搬三列、只 upsert 不删除，并在同一事务里推进新鲜期', async () => {
  const calls: Call[] = [];
  const roster: AccountIdentityProjectionRow[] = [
    // 刻意带上大小写 / 空白 / 空标签：投影 MUST 原样存，守卫的谓词才可能逐字等价。
    {
      accountId: 'acc-1',
      platform: ' FaceBook ',
      groupLabel: '华东组',
      createdAt: 1_700_000_000_000,
      status: 'paused',
    },
    {
      accountId: 'acc-2',
      platform: 'xiaohongshu',
      groupLabel: null,
      createdAt: null,
      status: 'active',
    },
  ];
  const store = new PgAccountProjectionStore({
    pool: fakePool(calls),
    source: { listAccountIdentities: async () => roster },
    maxStalenessMs: 300_000,
    logger: silent,
  });

  const result = await store.refresh();
  assert.deepEqual(result, { ok: true, rows: 2 });

  const sqls = calls.map((c) => c.sql);
  assert.equal(sqls[0], 'BEGIN');
  assert.equal(sqls.at(-1), 'COMMIT');
  assert.equal(
    sqls.some((sql) => /\bDELETE\b/i.test(sql)),
    false,
    '账号从不物理删除；刷新 MUST NOT 按快照做差集删除（否则一次读失败就能清空整张投影）',
  );

  const upsert = calls.find((c) => c.sql.includes('INSERT INTO automation_account_projection'))!;
  assert.match(upsert.sql, /ON CONFLICT \(account_id\) DO UPDATE/);
  assert.deepEqual(upsert.params[0], ['acc-1', 'acc-2']);
  assert.deepEqual(upsert.params[1], [' FaceBook ', 'xiaohongshu'], 'platform MUST 原样，不 trim 不小写');
  assert.deepEqual(upsert.params[2], ['华东组', null], 'group_label MUST 原样，NULL 不折成空串');
  assert.deepEqual(
    (upsert.params[3] as Array<Date | null>).map((value) => value?.getTime() ?? null),
    [1_700_000_000_000, null],
  );
  assert.deepEqual(upsert.params[4], ['paused', 'active']);

  const state = calls.find((c) => c.sql.includes('INSERT INTO automation_account_projection_state'))!;
  assert.deepEqual(state.params, [300_000, 2]);
  assert.match(state.sql, /fresh_until\s*=\s*EXCLUDED\.fresh_until/);
});

test('空花名册与来源报错都不推进新鲜期（绝不让静默的读失败冒充新鲜）', async () => {
  for (const [label, source] of [
    ['empty_roster', { listAccountIdentities: async () => [] }],
    ['source_failed', { listAccountIdentities: async () => { throw new Error('api unreachable'); } }],
  ] as const) {
    const calls: Call[] = [];
    const store = new PgAccountProjectionStore({
      pool: fakePool(calls),
      source,
      logger: silent,
    });
    const result = await store.refresh();
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.reason, label);
    assert.equal(
      calls.some((c) => c.sql.includes('automation_account_projection_state')),
      false,
      '新鲜期 MUST NOT 被推进——守卫会因此在到期后一律拒绝，这正是 fail-closed 要的方向',
    );
  }
});

test('写入失败回滚，且不推进新鲜期', async () => {
  const calls: Call[] = [];
  const client = {
    query: async (sql: string, params: unknown[] = []) => {
      calls.push({ sql, params });
      if (sql.includes('INSERT INTO automation_account_projection')) throw new Error('disk full');
      return { rows: [] };
    },
    release() {},
  };
  const store = new PgAccountProjectionStore({
    pool: { connect: async () => client } as unknown as pg.Pool,
    source: {
      listAccountIdentities: async () => [{
        accountId: 'a',
        platform: 'facebook',
        groupLabel: null,
        createdAt: null,
        status: 'active',
      }],
    },
    logger: silent,
  });
  const result = await store.refresh();
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, 'apply_failed');
  assert.ok(calls.some((c) => c.sql === 'ROLLBACK'));
  assert.equal(calls.some((c) => c.sql.includes('automation_account_projection_state')), false);
});

test('isFresh：无状态行 / 读失败一律判不新鲜（fail-closed）', async () => {
  const cases: Array<[string, () => { rows: Record<string, unknown>[] }]> = [
    ['状态表为空', () => ({ rows: [] })],
    ['已过期', () => ({ rows: [{ fresh: false }] })],
  ];
  for (const [, rows] of cases) {
    const store = new PgAccountProjectionStore({
      pool: { query: async () => rows() } as unknown as pg.Pool,
      source: { listAccountIdentities: async () => [] },
      logger: silent,
    });
    assert.equal(await store.isFresh(), false);
  }

  const throwing = new PgAccountProjectionStore({
    pool: { query: async () => { throw new Error('relation does not exist'); } } as unknown as pg.Pool,
    source: { listAccountIdentities: async () => [] },
    logger: silent,
  });
  assert.equal(await throwing.isFresh(), false, '连表都不在时 MUST 判不新鲜，绝不当成校验通过');

  const fresh = new PgAccountProjectionStore({
    pool: { query: async () => ({ rows: [{ fresh: true }] }) } as unknown as pg.Pool,
    source: { listAccountIdentities: async () => [] },
    logger: silent,
  });
  assert.equal(await fresh.isFresh(), true);
});

test('B4 init fails closed when the 0087 shared cursor columns are missing', async () => {
  const baseColumns: Record<string, string[]> = {
    automation_account_projection: [
      'account_id',
      'platform',
      'group_label',
      'created_at',
      'status',
      'projected_at',
    ],
    automation_account_projection_state: [
      'singleton',
      'refreshed_at',
      'fresh_until',
      'source_rows',
    ],
    automation_sync_read_consumer_checkpoint: [
      'execution_target',
      'consumer',
      'stream',
      'applied_cursor',
      'payload_digest',
      'source_as_of_ms',
      'last_observed_at_ms',
      'fresh_until_ms',
      'last_applied_at_ms',
      'state',
      'last_error',
      'updated_at',
    ],
  };
  const pool = {
    async query(sql: string, params: unknown[]) {
      if (sql.includes('FROM pg_class')) {
        const tables = params[1] as string[];
        return {
          rows: tables.flatMap((table) =>
            baseColumns[table]!.map((column) => ({
              table_name: table,
              column_name: column,
            }))),
        };
      }
      if (sql.includes('FROM pg_indexes')) {
        return {
          rows: [
            {
              indexname:
                'idx_automation_account_projection_platform_label',
            },
          ],
        };
      }
      throw new Error(`unexpected SQL: ${sql}`);
    },
  };
  const store = new PgAccountProjectionStore({
    pool: pool as unknown as pg.Pool,
    source: { listAccountIdentities: async () => [] },
    executionTarget: 'dev',
    logger: silent,
  });
  await assert.rejects(
    store.init(),
    (error: unknown) => {
      assert.match(String(error), /0087_automation_account_projection_shared_cursor/);
      assert.match(String(error), /sync_read_cursor/);
      return true;
    },
  );
});

test('B4 owner snapshot atomically advances projection rows, freshness and target checkpoint', async () => {
  const calls: Call[] = [];
  const store = new PgAccountProjectionStore({
    pool: fakePool(calls),
    source: { listAccountIdentities: async () => [] },
    executionTarget: 'dev',
    logger: silent,
  });
  const envelope = accountSnapshot('7', 1_000, 6_000);
  const result = await store.applyOwnerSnapshot(envelope, 1_100);
  assert.equal(result.outcome, 'applied');

  const sqls = calls.map((call) => call.sql);
  assert.equal(sqls[0], 'BEGIN');
  assert.equal(sqls.at(-1), 'COMMIT');
  const projection = calls.find((call) =>
    call.sql.includes('INSERT INTO automation_account_projection\n'));
  assert.ok(projection);
  assert.deepEqual(projection.params[0], ['a']);
  assert.deepEqual(projection.params[4], ['paused']);
  const sharedStateWrites = calls.filter((call) =>
    call.sql.includes('INSERT INTO automation_account_projection_state'));
  assert.equal(sharedStateWrites.length, 1);
  assert.match(
    sharedStateWrites[0]!.sql,
    /to_timestamp\(0\)/,
    'independent B4 may materialize the shared mutex row but MUST NOT renew legacy freshness',
  );
  const sharedCursor = calls.find((call) =>
    call.sql.includes('UPDATE automation_account_projection_state'));
  assert.ok(sharedCursor);
  assert.deepEqual(sharedCursor.params, [
    '7',
    syncReadPayloadDigest(envelope.value),
    1_000,
  ]);
  const materializeIndex = calls.findIndex((call) =>
    call.sql.includes('INSERT INTO automation_sync_read_consumer_checkpoint'));
  const sharedLockIndex = calls.findIndex((call) =>
    call.sql.includes('FROM automation_account_projection_state') &&
    call.sql.includes('FOR UPDATE'));
  const lockIndex = calls.findIndex((call) =>
    call.sql.includes('FROM automation_sync_read_consumer_checkpoint') &&
    call.sql.includes('FOR UPDATE'));
  const projectionIndex = calls.findIndex((call) =>
    call.sql.includes('INSERT INTO automation_account_projection\n'));
  assert.ok(sharedLockIndex > 0 && sharedLockIndex < materializeIndex);
  assert.ok(
    materializeIndex < lockIndex && lockIndex < projectionIndex,
    'missing checkpoint must be materialized and locked before first projection mutation',
  );
  const checkpoint = calls.find((call) =>
    call.sql.includes('UPDATE automation_sync_read_consumer_checkpoint'));
  assert.ok(checkpoint);
  assert.deepEqual(
    [checkpoint.params[0], checkpoint.params[1], checkpoint.params[3], checkpoint.params[4]],
    ['dev', '7', 1_000, 1_100],
  );
});

test('B4 freshness reads only the current target checkpoint', async () => {
  const calls: Call[] = [];
  const store = new PgAccountProjectionStore({
    pool: {
      async query(sql: string, params: unknown[]) {
        calls.push({ sql, params });
        return { rows: [{ fresh: true }] };
      },
    } as unknown as pg.Pool,
    source: { listAccountIdentities: async () => [] },
    executionTarget: 'ol',
    logger: silent,
  });
  assert.equal(await store.isFresh(), true);
  assert.match(calls[0]!.sql, /automation_sync_read_consumer_checkpoint/);
  assert.match(calls[0]!.sql, /execution_target = \$1/);
  assert.deepEqual(calls[0]!.params, ['ol']);
  assert.doesNotMatch(calls[0]!.sql, /automation_account_projection_state/);
});

test('B4 complete snapshot removes absent rows and empty snapshot clears the projection', async () => {
  for (const envelope of [
    accountSnapshot('10', 5_000, 10_000),
    makeSyncReadFactEnvelope({
      executionTarget: 'dev',
      stream: 'automation_account_projection',
      cursor: '11',
      asOf: 6_000,
      freshUntil: 11_000,
      value: { accounts: [] },
    }),
  ]) {
    const calls: Call[] = [];
    const store = new PgAccountProjectionStore({
      pool: fakePool(calls),
      source: { listAccountIdentities: async () => [] },
      executionTarget: 'dev',
      logger: silent,
    });
    assert.equal(
      (await store.applyOwnerSnapshot(envelope, envelope.asOf + 1)).outcome,
      'applied',
    );
    const removal = calls.find((call) =>
      call.sql.includes('DELETE FROM automation_account_projection'));
    assert.ok(removal);
    assert.deepEqual(
      removal.params,
      [envelope.value.accounts.map((account) => account.accountId)],
    );
    const update = calls.find((call) =>
      call.sql.includes('UPDATE automation_sync_read_consumer_checkpoint'));
    assert.ok(update);
  }
});

test('B4 replacement failure rolls back removals and does not advance checkpoint', async () => {
  const calls: Call[] = [];
  const client = {
    async query(sql: string, params: unknown[] = []) {
      calls.push({ sql, params });
      if (sql.includes('DELETE FROM automation_account_projection')) {
        throw new Error('projection_delete_failed');
      }
      return { rows: [] };
    },
    release() {},
  };
  const store = new PgAccountProjectionStore({
    pool: { connect: async () => client } as unknown as pg.Pool,
    source: { listAccountIdentities: async () => [] },
    executionTarget: 'dev',
    logger: silent,
  });
  await assert.rejects(
    store.applyOwnerSnapshot(accountSnapshot('12', 7_000, 12_000), 7_001),
    /projection_delete_failed/,
  );
  assert.equal(calls.at(-1)?.sql, 'ROLLBACK');
  assert.equal(
    calls.some((call) =>
      call.sql.includes('UPDATE automation_sync_read_consumer_checkpoint')),
    false,
  );
});

test('B4 shared cursor write failure rolls back projection replacement and target delivery', async () => {
  const calls: Call[] = [];
  const client = {
    async query(sql: string, params: unknown[] = []) {
      calls.push({ sql, params });
      if (sql.includes('UPDATE automation_account_projection_state')) {
        throw new Error('shared_cursor_write_failed');
      }
      return { rows: [] };
    },
    release() {},
  };
  const store = new PgAccountProjectionStore({
    pool: { connect: async () => client } as unknown as pg.Pool,
    source: { listAccountIdentities: async () => [] },
    executionTarget: 'dev',
    logger: silent,
  });
  await assert.rejects(
    store.applyOwnerSnapshot(accountSnapshot('13', 8_000, 13_000), 8_001),
    /shared_cursor_write_failed/,
  );
  assert.equal(calls.at(-1)?.sql, 'ROLLBACK');
  assert.equal(
    calls.some((call) =>
      call.sql.includes('UPDATE automation_sync_read_consumer_checkpoint')),
    false,
  );
});

test('B4 checkpoint write failure rolls back the projection transaction', async () => {
  const calls: Call[] = [];
  const client = {
    async query(sql: string, params: unknown[] = []) {
      calls.push({ sql, params });
      if (sql.includes('UPDATE automation_sync_read_consumer_checkpoint')) {
        throw new Error('checkpoint disk full');
      }
      return { rows: [] };
    },
    release() {},
  };
  const store = new PgAccountProjectionStore({
    pool: { connect: async () => client } as unknown as pg.Pool,
    source: { listAccountIdentities: async () => [] },
    executionTarget: 'dev',
    logger: silent,
  });
  await assert.rejects(
    store.applyOwnerSnapshot(accountSnapshot('8', 2_000, 7_000), 2_100),
    /checkpoint disk full/,
  );
  assert.ok(calls.some((call) => call.sql === 'ROLLBACK'));
  assert.equal(calls.some((call) => call.sql === 'COMMIT'), false);
});

test('B4 same cursor payload drift is rejected before projection mutation', async () => {
  const calls: Call[] = [];
  const original = accountSnapshot('9', 3_000, 8_000);
  const store = new PgAccountProjectionStore({
    pool: fakePool(calls, (sql) =>
      sql.includes('FROM automation_account_projection_state')
        ? {
            rows: [
              {
                sync_read_cursor: '9',
                sync_read_payload_digest: syncReadPayloadDigest(original.value),
                sync_read_source_as_of_ms: 3_000,
              },
            ],
          }
        : undefined),
    source: { listAccountIdentities: async () => [] },
    executionTarget: 'dev',
    logger: silent,
  });
  const drifted = accountSnapshot('9', 4_000, 9_000, 'active');
  const result = await store.applyOwnerSnapshot(drifted, 4_100);
  assert.equal(result.outcome, 'rejected');
  if (result.outcome !== 'rejected') return;
  assert.equal(result.reason, 'same_cursor_payload_drift');
  assert.equal(
    calls.some((call) => call.sql.includes('INSERT INTO automation_account_projection\n')),
    false,
  );
  assert.equal(calls.at(-1)?.sql, 'ROLLBACK');
});

test('B4 shared projection cannot be rolled back by an older snapshot from another target', async () => {
  const calls: Call[] = [];
  const devFive = accountSnapshot('5', 5_000, 10_000, 'paused');
  const store = new PgAccountProjectionStore({
    pool: fakePool(calls, (sql) =>
      sql.includes('FROM automation_account_projection_state')
        ? {
            rows: [
              {
                sync_read_cursor: '5',
                sync_read_payload_digest: syncReadPayloadDigest(devFive.value),
                sync_read_source_as_of_ms: 5_000,
              },
            ],
          }
        : undefined),
    source: { listAccountIdentities: async () => [] },
    executionTarget: 'ol',
    logger: silent,
  });
  const olFour = makeSyncReadFactEnvelope({
    executionTarget: 'ol',
    stream: 'automation_account_projection',
    cursor: '4',
    asOf: 4_000,
    freshUntil: 9_000,
    value: {
      accounts: [
        {
          accountId: 'a',
          platform: 'facebook',
          groupLabel: 'old',
          createdAt: 123,
          status: 'active' as const,
        },
      ],
    },
  });
  const result = await store.applyOwnerSnapshot(olFour, 4_100);
  assert.deepEqual(result, {
    outcome: 'rejected',
    reason: 'old_cursor',
    currentCursor: '5',
    message: 'out_of_order cursor=4 current=5',
  });
  assert.equal(
    calls.some((call) =>
      call.sql.includes('INSERT INTO automation_account_projection\n')),
    false,
  );
  assert.equal(
    calls.some((call) =>
      call.sql.includes('UPDATE automation_account_projection_state')),
    false,
  );
  assert.ok(
    calls.some((call) =>
      call.sql.includes('FROM automation_account_projection_state') &&
      call.sql.includes('FOR UPDATE')),
  );
  assert.equal(calls.at(-1)?.sql, 'ROLLBACK');
});

function accountSnapshot(
  cursor: string,
  asOf: number,
  freshUntil: number,
  status: 'active' | 'paused' = 'paused',
) {
  return makeSyncReadFactEnvelope({
    executionTarget: 'dev',
    stream: 'automation_account_projection',
    cursor,
    asOf,
    freshUntil,
    value: {
      accounts: [
        {
          accountId: 'a',
          platform: 'facebook',
          groupLabel: 'group',
          createdAt: 123,
          status,
        },
      ],
    },
  });
}
