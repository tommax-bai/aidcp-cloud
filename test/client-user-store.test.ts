import { test } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { CLIENT_USERS_SCHEMA_SQL, ClientUserStore } from '../src/client-auth/client-user-store.js';

/**
 * client-user-env-picker：`listAllEnvironments` 的**映射逻辑**单测（行 → ClientEnvironmentView）。
 *
 * 真 SQL 聚合（json_agg / array_agg … FILTER / GROUP BY）与「多分只动当前 user_id」的 WHERE 语义靠
 * 真库核（本仓 store 测试用手写假 pool、非真 SQL 引擎，桩不了聚合正确性）→ 真机 backlog 簇 61。
 * 这里只锁我自己那段映射：assigneeCount = assignees.length、null assignees 回落空、缺表 fail-closed。
 */
function fakePool(handler: (sql: string, params?: unknown[]) => { rows: unknown[] }) {
  const pool = {
    query: async (sql: string, params?: unknown[]) => handler(sql, params),
  };
  return pool as unknown as pg.Pool;
}

test('listAllEnvironments: 行映射为视图，assigneeCount = assignees 长度', async () => {
  const pool = fakePool((sql) => {
    assert.match(sql, /FROM client_env_scope/); // 命中聚合 SELECT
    return {
      rows: [
        { env_key: 'p1', label: '大白', platform: 'xiaohongshu', assignees: [{ userId: 'u1', name: 'A' }] },
        {
          env_key: 'p2',
          label: null,
          platform: null,
          assignees: [{ userId: 'u2', name: 'B' }],
        },
      ],
    };
  });
  const store = new ClientUserStore({ pool });
  const envs = await store.listAllEnvironments();
  assert.equal(envs.length, 2);
  assert.deepEqual(envs[0], {
    envKey: 'p1',
    label: '大白',
    platform: 'xiaohongshu',
    assignees: [{ userId: 'u1', name: 'A' }],
    assigneeCount: 1,
  });
  assert.equal(envs[1].assigneeCount, 1); // 全局唯一 active owner
  assert.deepEqual(
    envs[1].assignees.map((a) => a.name),
    ['B'],
  );
});

test('listAllEnvironments: json_agg 为 null 时回落空 assignees（count 0）', async () => {
  const pool = fakePool(() => ({ rows: [{ env_key: 'p3', label: null, platform: null, assignees: null }] }));
  const store = new ClientUserStore({ pool });
  const [env] = await store.listAllEnvironments();
  assert.deepEqual(env.assignees, []);
  assert.equal(env.assigneeCount, 0);
});

test('listAllEnvironments: 缺表(42P01)fail-closed 回落空数组，不抛', async () => {
  const pool = fakePool(() => {
    const err = new Error('relation "client_env_scope" does not exist') as Error & { code: string };
    err.code = '42P01';
    throw err;
  });
  const store = new ClientUserStore({ pool });
  assert.deepEqual(await store.listAllEnvironments(), []);
});

test('listAllEnvironments: 非缺表错误照常抛出（不吞真故障）', async () => {
  const pool = fakePool(() => {
    const err = new Error('connection refused') as Error & { code: string };
    err.code = 'ECONNREFUSED';
    throw err;
  });
  const store = new ClientUserStore({ pool });
  await assert.rejects(() => store.listAllEnvironments(), /connection refused/);
});

/**
 * client-user-env-registry：`registerEnvironments`（环境注册表写路径）。锁我这段映射逻辑——
 * 去空白 / 去重 / 跳空 envKey / 空串归 null / source 透传 / 每条一次 upsert / 返回去重条数。
 * 真 upsert 的 COALESCE 不覆盖既有非空值、并集 listAllEnvironments 列出未分配环境等 SQL 语义靠真库核（簇 61）。
 */
function recordingPool() {
  const calls: { sql: string; params?: unknown[] }[] = [];
  const pool = {
    query: async (sql: string, params?: unknown[]) => {
      calls.push({ sql, params });
      return { rows: [] };
    },
  } as unknown as pg.Pool;
  return { pool, calls };
}

test('registerEnvironments: 去空白 + 去重 + 跳空，每条一次 upsert，返回去重条数', async () => {
  const { pool, calls } = recordingPool();
  const store = new ClientUserStore({ pool });
  const n = await store.registerEnvironments([
    { envKey: ' k1 ', label: ' 大白 ', platform: 'xiaohongshu' },
    { envKey: 'k1', label: '重复应被去重' }, // 同 envKey → 去重
    { envKey: '', label: '空跳过' }, // 空 envKey → 跳过
    { envKey: 'k2', label: '', platform: '' }, // 空串 label/platform → null
  ]);
  assert.equal(n, 2);
  assert.equal(calls.length, 2);
  assert.match(calls[0].sql, /INSERT INTO client_environments/);
  assert.deepEqual(calls[0].params, ['k1', '大白', 'xiaohongshu', 'import']); // trim + 默认 source=import
  assert.deepEqual(calls[1].params, ['k2', null, null, 'import']); // 空串归一为 null
});

test('registerEnvironments: 全空输入 → 0 次写、返回 0（绝不误发空 upsert）', async () => {
  const { pool, calls } = recordingPool();
  const store = new ClientUserStore({ pool });
  const n = await store.registerEnvironments([{ envKey: '  ' }, { envKey: '' }]);
  assert.equal(n, 0);
  assert.equal(calls.length, 0);
});

test('registerEnvironments: source 显式传 auto 透传到参数（自动登记路径）', async () => {
  const { pool, calls } = recordingPool();
  const store = new ClientUserStore({ pool });
  await store.registerEnvironments([{ envKey: 'k9' }], 'auto');
  assert.deepEqual(calls[0].params, ['k9', null, null, 'auto']);
});

test('ownsEnv: user A only owns rows explicitly scoped to user A', async () => {
  const pool = fakePool((sql, params) => {
    assert.match(sql, /WHERE user_id = \$1 AND env_key = \$2/);
    assert.match(sql, /source = 'admin'/);
    return { rows: [{ owned: params?.[0] === 'user-a' && params?.[1] === 'env-a' }] };
  });
  const store = new ClientUserStore({ pool });
  assert.equal(await store.ownsEnv('user-a', 'env-a'), true);
  assert.equal(await store.ownsEnv('user-a', 'env-b'), false);
  assert.equal(await store.ownsEnv('user-b', 'env-a'), false);
});

test('ownsEnv: missing ownership table fails closed', async () => {
  const pool = fakePool(() => {
    const err = new Error('relation "client_env_scope" does not exist') as Error & { code: string };
    err.code = '42P01';
    throw err;
  });
  const store = new ClientUserStore({ pool });
  assert.equal(await store.ownsEnv('user-a', 'env-a'), false);
});

test('schema archives and removes legacy customer claims, then enforces one authoritative owner per env', () => {
  assert.match(CLIENT_USERS_SCHEMA_SQL, /INSERT INTO client_env_scope_audit[\s\S]*legacy_self_claim/);
  assert.match(CLIENT_USERS_SCHEMA_SQL, /DELETE FROM client_env_scope WHERE source = 'client'/);
  assert.match(CLIENT_USERS_SCHEMA_SQL, /client_env_scope_authoritative_source[\s\S]*CHECK \(source = 'admin'\)/);
  assert.match(CLIENT_USERS_SCHEMA_SQL, /CREATE UNIQUE INDEX IF NOT EXISTS uq_client_env_scope_active_env/);
  assert.match(CLIENT_USERS_SCHEMA_SQL, /ON client_env_scope \(env_key\)/);
});

test('listEnvScope ignores client self-claims and revoked assignments', async () => {
  const pool = fakePool((sql) => {
    assert.match(sql, /user_id = \$1 AND source = 'admin'/);
    return { rows: [] };
  });
  const store = new ClientUserStore({ pool });
  assert.deepEqual(await store.listEnvScope('user-a'), []);
});

test('withAuthorizedInteractionScope holds complete authorization locks through operation and commit', async () => {
  const calls: string[] = [];
  let released = false;
  const client = {
    query: async (sql: string) => {
      calls.push(sql);
      if (/SELECT status FROM client_users/.test(sql)) return { rows: [{ status: 'enabled' }] };
      if (/FROM client_env_scope s/.test(sql)) return { rows: [{ account_id: 'acct-a' }] };
      return { rows: [] };
    },
    release: () => { released = true; },
  };
  const pool = { connect: async () => client } as unknown as pg.Pool;
  const store = new ClientUserStore({ pool });
  const result = await store.withAuthorizedInteractionScope('user-a', 'env-a', async ({ accountId }) => {
    assert.equal(accountId, 'acct-a');
    assert.equal(calls.at(-1)?.includes('FOR SHARE OF s, e, a, acc'), true);
    assert.equal(calls.some((sql) => sql === 'COMMIT'), false, 'operation runs before transaction commit');
    return 'done';
  });
  assert.deepEqual(result, { ok: true, accountId: 'acct-a', value: 'done' });
  assert.equal(calls[0], 'BEGIN');
  assert.match(calls[1], /client_users[\s\S]*FOR SHARE/);
  assert.equal(calls.at(-1), 'COMMIT');
  assert.equal(released, true);
});

test('withAuthorizedInteractionScope fails closed on env/account binding mismatch without running operation', async () => {
  let operationCalls = 0;
  const calls: string[] = [];
  const client = {
    query: async (sql: string) => {
      calls.push(sql);
      if (/SELECT status FROM client_users/.test(sql)) return { rows: [{ status: 'enabled' }] };
      return { rows: [] };
    },
    release() {},
  };
  const pool = { connect: async () => client } as unknown as pg.Pool;
  const store = new ClientUserStore({ pool });
  const result = await store.withAuthorizedInteractionScope('user-a', 'env-b', async () => {
    operationCalls += 1;
  });
  assert.deepEqual(result, { ok: false, reason: 'not_authorized' });
  assert.equal(operationCalls, 0);
  assert.equal(calls.at(-1), 'ROLLBACK');
});
