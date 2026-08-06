/**
 * 离场清理（`purgeDueOffboards`）的正确性回归 —— 纯逻辑级（内存假 pool，无数据库连接）。
 *
 * 存在理由：第一条 `purge_due_at` 到期日是 2026-08-14，这条链路**生涯至今删了 0 行**，
 * 到期那天才第一次真的删生产数据（DEV/OL 共用同一台物理库），且删除不可逆。这里把
 * 「删哪些行 / 什么条件下不删 / 崩溃重入 / 双机竞争 / 实删行数如实回报」逐条钉成机械断言。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Pool } from 'pg';
import { PgInteractionApiWrites } from '@api/interactions/interaction-api-writes.js';
import { InteractionStore } from '@automation/interactions/interaction-store.js';

const NOW = 1_784_044_900_000;

interface FakeOffboard {
  offboard_id: string;
  account_id: string;
  env_key: string;
  user_id: string | null;
  edge_result_status: string | null;
  state: 'pending_edge' | 'dispatched' | 'tombstoned' | 'purged';
  purge_due_at: number;
}

interface FakeWorld {
  offboards: FakeOffboard[];
  /** account_id -> 当前绑定的 env_key（interaction_auth_state 的 (platform,account_id) 唯一行）。 */
  bindings: Map<string, string>;
  /** 每张表被删掉的「行数」，按表名累计；键存在即代表这张表被执行过 DELETE。 */
  deletes: Array<{ table: string; params: unknown[] }>;
  audits: Array<{ event: string; status: string }>;
  /** Step C 的 UPDATE 命中前的钩子：模拟另一台在这一刻把同一行清完并翻了 purged。 */
  beforeFlip?: (offboardId: string) => void;
}

function fakePool(world: FakeWorld): Pool {
  const rowsPerDelete = 1;
  const client = {
    query: async (sql: string, params: unknown[] = []) => {
      if (/^(BEGIN|COMMIT|ROLLBACK)$/.test(sql.trim())) return { rows: [], rowCount: 0 };
      if (sql.includes('FROM interaction_offboards') && sql.includes('FOR UPDATE SKIP LOCKED')) {
        const due = world.offboards
          .filter((row) => ['pending_edge', 'dispatched', 'tombstoned'].includes(row.state))
          .filter((row) => row.purge_due_at <= (params[0] as number))
          .sort((a, b) => a.purge_due_at - b.purge_due_at || a.offboard_id.localeCompare(b.offboard_id));
        return { rows: due.slice(0, 1), rowCount: Math.min(due.length, 1) };
      }
      if (sql.includes('SELECT env_key FROM interaction_auth_state')) {
        const bound = world.bindings.get(params[1] as string);
        return bound ? { rows: [{ env_key: bound }], rowCount: 1 } : { rows: [], rowCount: 0 };
      }
      const deleted = sql.match(/DELETE FROM (\w+)/);
      if (deleted) {
        world.deletes.push({ table: deleted[1], params });
        if (deleted[1] === 'interaction_auth_state') {
          const [, accountId, envKey] = params as [string, string, string];
          if (world.bindings.get(accountId) === envKey) {
            world.bindings.delete(accountId);
            return { rows: [], rowCount: 1 };
          }
          return { rows: [], rowCount: 0 };
        }
        return { rows: [], rowCount: rowsPerDelete };
      }
      if (sql.includes("UPDATE interaction_offboards SET state='purged'")) {
        const offboardId = params[0] as string;
        world.beforeFlip?.(offboardId);
        const row = world.offboards.find((item) => item.offboard_id === offboardId);
        if (!row || row.state === 'purged') return { rows: [], rowCount: 0 };
        row.state = 'purged';
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes('INSERT INTO interaction_offboard_audit')) {
        world.audits.push({
          event: sql.match(/'(cloud_purge[a-z_]*)'/)?.[1] ?? 'unknown',
          status: params[5] as string,
        });
        return { rows: [], rowCount: 1 };
      }
      throw new Error(`unexpected SQL: ${sql}`);
    },
    release: () => {},
  };
  return { connect: async () => client } as unknown as Pool;
}

function makeStore(world: FakeWorld): InteractionStore {
  const pool = fakePool(world);
  return new InteractionStore({
    pool,
    idGen: (prefix) => `${prefix}-test`,
    apiPurge: new PgInteractionApiWrites(pool),
  });
}

const ACCOUNT_SCOPED_TABLES = [
  'interaction_runtime_controls', 'reply_templates', 'reply_rules',
  'account_reply_profiles', 'interaction_reply_config_versions', 'interaction_reply_configs',
];
const ENV_SCOPED_TABLES = [
  'interaction_threads', 'interaction_sync_batches', 'interaction_sync_cursors', 'interaction_api_requests',
];

function world(overrides: Partial<FakeOffboard> = {}, bindings: Array<[string, string]> = [['acct-1', 'env-1']]): FakeWorld {
  return {
    offboards: [{ offboard_id: 'off-1', account_id: 'acct-1', env_key: 'env-1', user_id: 'user-1',
      edge_result_status: null, state: 'tombstoned', purge_due_at: NOW - 1, ...overrides }],
    bindings: new Map(bindings),
    deletes: [],
    audits: [],
  };
}

const deletedTables = (w: FakeWorld): string[] => [...new Set(w.deletes.map((d) => d.table))].sort();

test('到期即清：环境级 + 账号级两类表都清，绑定行随翻 purged 一起删，实删行数写进审计', async () => {
  const w = world();
  assert.equal(await makeStore(w).purgeDueOffboards(NOW), 1);
  for (const table of [...ENV_SCOPED_TABLES, ...ACCOUNT_SCOPED_TABLES, 'interaction_auth_state']) {
    assert.ok(deletedTables(w).includes(table), `应清: ${table}`);
  }
  // 环境级表的谓词必须同时带 account_id 与 env_key（只带其一都会跨客户误删）。
  for (const table of ENV_SCOPED_TABLES) {
    assert.deepEqual(w.deletes.find((d) => d.table === table)?.params, ['acct-1', 'env-1'], `${table} 必须按 (账号, 环境) 双条件删`);
  }
  assert.equal(w.offboards[0].state, 'purged');
  assert.deepEqual(w.audits, [
    { event: 'cloud_purged', status: 'purged_edge_unconfirmed' },
    { event: 'cloud_purge_rows', status: 'scope=account+env;api_requests=1,auth_state=1,reply_config=5,'
      + 'runtime_controls=1,sync_batches=1,sync_cursors=1,threads=1' },
  ]);
});

test('未到期一行不删', async () => {
  const w = world({ purge_due_at: NOW + 1 });
  assert.equal(await makeStore(w).purgeDueOffboards(NOW), 0);
  assert.deepEqual(w.deletes, []);
  assert.deepEqual(w.audits, []);
  assert.equal(w.offboards[0].state, 'tombstoned');
});

test('状态机四态各归其位：三个未了结态都清，purged 永不再入选、不重复删', async () => {
  for (const state of ['pending_edge', 'dispatched', 'tombstoned'] as const) {
    const w = world({ state });
    assert.equal(await makeStore(w).purgeDueOffboards(NOW), 1, `${state} 到期应被清`);
    assert.equal(w.offboards[0].state, 'purged');
  }
  const done = world({ state: 'purged' });
  assert.equal(await makeStore(done).purgeDueOffboards(NOW), 0, 'purged 不得被二次清理');
  assert.deepEqual(done.deletes, []);
  assert.deepEqual(done.audits, []);
});

test('账号已改派到别的环境：只做环境级清理，账号级数据（在用客户的活数据）一行不动', async () => {
  const w = world({}, [['acct-1', 'env-2']]);
  assert.equal(await makeStore(w).purgeDueOffboards(NOW), 1);
  for (const table of ENV_SCOPED_TABLES) assert.ok(deletedTables(w).includes(table), `环境级仍清: ${table}`);
  for (const table of ACCOUNT_SCOPED_TABLES) {
    assert.equal(deletedTables(w).includes(table), false, `账号已改派，MUST NOT 删账号级表: ${table}`);
  }
  // 绑定行按 (账号, 旧环境) 删 → 命中 0 行，新绑定原样保留。
  assert.equal(w.bindings.get('acct-1'), 'env-2');
  assert.deepEqual(w.audits[1], { event: 'cloud_purge_rows',
    status: 'scope=env_only;api_requests=1,auth_state=0,sync_batches=1,sync_cursors=1,threads=1' });
});

test('占位离场（account_id 即 env_key、从无绑定）：不拿捏造的账号号去删账号级表', async () => {
  const w = world({ offboard_id: 'off-unbound', account_id: 'env-unbound', env_key: 'env-unbound' }, []);
  assert.equal(await makeStore(w).purgeDueOffboards(NOW), 1);
  for (const table of ACCOUNT_SCOPED_TABLES) {
    assert.equal(deletedTables(w).includes(table), false, `无绑定可证归属，MUST NOT 删: ${table}`);
  }
  assert.match(w.audits[1].status, /^scope=env_only;/);
});

test('双机竞争：另一台先翻了 purged 时不计数、不写审计、不删绑定行', async () => {
  const w = world();
  w.beforeFlip = () => { w.offboards[0].state = 'purged'; };
  assert.equal(await makeStore(w).purgeDueOffboards(NOW), 0, '没做成 MUST NOT 记成做成');
  assert.deepEqual(w.audits, []);
  assert.equal(deletedTables(w).includes('interaction_auth_state'), false);
  assert.equal(w.bindings.get('acct-1'), 'env-1', '绑定行由赢家在它自己的 Step C 里删，输家不得越俎代庖');
});

test('崩溃重入：Step B 失败后绑定行仍在，重入重算出同一归属结论并清完剩余', async () => {
  const w = world();
  let replyCalls = 0;
  const pool = fakePool(w);
  const real = new PgInteractionApiWrites(pool);
  const store = new InteractionStore({
    pool, idGen: (prefix) => `${prefix}-test`,
    apiPurge: {
      purgeReplyConfigForAccount: async (accountId: string) => {
        replyCalls += 1;
        if (replyCalls === 1) throw new Error('simulated crash between steps');
        return real.purgeReplyConfigForAccount(accountId);
      },
      purgeExpiredAuditEvents: (now: number) =>
        real.purgeExpiredAuditEvents(now),
    },
  });
  await assert.rejects(store.purgeDueOffboards(NOW), /simulated crash between steps/);
  assert.equal(w.offboards[0].state, 'tombstoned', '未翻 purged ⇒ 下一轮还能取到');
  assert.equal(w.bindings.get('acct-1'), 'env-1', '绑定行必须活到 Step C，否则重入无法再判定账号级清理是否放行');
  assert.equal(await store.purgeDueOffboards(NOW), 1);
  for (const table of ACCOUNT_SCOPED_TABLES) assert.ok(deletedTables(w).includes(table), `重入补清: ${table}`);
  assert.equal(w.offboards[0].state, 'purged');
});

test('单次调用有上限：一次到期一大批时按批收工，其余留给下一轮', async () => {
  const w = world();
  w.offboards = [1, 2, 3].map((n) => ({ offboard_id: `off-${n}`, account_id: `acct-${n}`, env_key: `env-${n}`,
    user_id: null, edge_result_status: null, state: 'tombstoned' as const, purge_due_at: NOW - n }));
  w.bindings = new Map([['acct-1', 'env-1'], ['acct-2', 'env-2'], ['acct-3', 'env-3']]);
  const store = makeStore(w);
  assert.equal(await store.purgeDueOffboards(NOW, 2), 2);
  assert.equal(w.offboards.filter((row) => row.state === 'purged').length, 2);
  assert.equal(await store.purgeDueOffboards(NOW, 2), 1);
  assert.equal(w.offboards.filter((row) => row.state === 'purged').length, 3);
});
