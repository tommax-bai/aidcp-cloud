import { test } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { RoleConfigStore } from '../src/config/role-config-store.js';

/** 内存假 pool：路由 role_config 的建表 / SELECT / upsert(RETURNING)；可注入写失败。provider 随 0018 加列。 */
function fakePool(seed: Record<string, { model: string | null; provider?: string | null; temperature: number | null }> = {}) {
  const rows = new Map<
    string,
    { role_id: string; model: string | null; provider: string | null; temperature: number | null; updated_at: string; updated_by: string }
  >();
  for (const [roleId, v] of Object.entries(seed)) {
    rows.set(roleId, { role_id: roleId, model: v.model, provider: v.provider ?? null, temperature: v.temperature, updated_at: '2026-06-21T00:00:00.000Z', updated_by: 'seed' });
  }
  let failWrite = false;
  const pool = {
    query: async (sql: string, params?: unknown[]) => {
      if (sql.includes('CREATE TABLE') || sql.trimStart().startsWith('ALTER')) return { rows: [] };
      if (sql.trimStart().startsWith('SELECT')) return { rows: [...rows.values()] };
      if (sql.includes('INSERT INTO role_config')) {
        if (failWrite) throw new Error('db down');
        const [roleId, model, provider, temperature, updatedBy] = params as [string, string | null, string | null, number | null, string];
        const row = { role_id: roleId, model, provider, temperature, updated_at: '2026-06-21T01:00:00.000Z', updated_by: updatedBy };
        rows.set(roleId, row);
        return { rows: [row] };
      }
      return { rows: [] };
    },
  };
  return { pool: pool as unknown as pg.Pool, setFailWrite: (v: boolean) => { failWrite = v; } };
}

test('缺行 → getForRole 回落空（model/temperature 均 null）', async () => {
  const { pool } = fakePool();
  const store = new RoleConfigStore({ pool });
  await store.init();
  assert.deepEqual(store.getForRole('browse:content_evaluator'), { model: null, provider: null, temperature: null });
});

test('set 后 getForRole 即时热加载（无需重启）', async () => {
  const { pool } = fakePool();
  const store = new RoleConfigStore({ pool });
  await store.init();
  const row = await store.set('publish:ContentCreator', { model: 'qwen-max', provider: 'volcengine', temperature: 0.7 }, 'alice');
  assert.equal(row.model, 'qwen-max');
  assert.equal(row.provider, 'volcengine');
  assert.equal(row.temperature, 0.7);
  assert.equal(row.updatedBy, 'alice');
  assert.deepEqual(store.getForRole('publish:ContentCreator'), { model: 'qwen-max', provider: 'volcengine', temperature: 0.7 });
});

test('越界温度归一为 null（不落非法值）', async () => {
  const { pool } = fakePool();
  const store = new RoleConfigStore({ pool });
  await store.init();
  const row = await store.set('publish:ContentCreator', { temperature: 9 }, 'a');
  assert.equal(row.temperature, null);
});

test('空模型名清除覆盖（回落）', async () => {
  const { pool } = fakePool({ 'browse:comment_composer': { model: 'qwen-max', temperature: null } });
  const store = new RoleConfigStore({ pool });
  await store.init();
  assert.equal(store.getForRole('browse:comment_composer').model, 'qwen-max');
  await store.set('browse:comment_composer', { model: '' }, 'a');
  assert.equal(store.getForRole('browse:comment_composer').model, null);
});

test('写库失败 → 内存镜像不变（绝不镜像/库不一致）', async () => {
  const { pool, setFailWrite } = fakePool({ 'browse:comment_composer': { model: 'qwen-plus', temperature: null } });
  const store = new RoleConfigStore({ pool });
  await store.init();
  setFailWrite(true);
  await assert.rejects(store.set('browse:comment_composer', { model: 'qwen-max' }, 'a'));
  assert.equal(store.getForRole('browse:comment_composer').model, 'qwen-plus');
});

test('getAll 暴露审计字段（updatedAt/By）', async () => {
  const { pool } = fakePool();
  const store = new RoleConfigStore({ pool });
  await store.init();
  await store.set('publish:ContentCreator', { model: 'qwen-max' }, 'bob');
  const row = store.getAll().get('publish:ContentCreator');
  assert.equal(row?.updatedBy, 'bob');
  assert.ok(row?.updatedAt);
});
