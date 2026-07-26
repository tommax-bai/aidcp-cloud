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
