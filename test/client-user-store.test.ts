import { test } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { ClientUserStore } from '../src/client-auth/client-user-store.js';

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
          assignees: [
            { userId: 'u1', name: 'A' },
            { userId: 'u2', name: 'B' },
          ],
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
  assert.equal(envs[1].assigneeCount, 2); // 多人
  assert.deepEqual(
    envs[1].assignees.map((a) => a.name),
    ['A', 'B'],
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
