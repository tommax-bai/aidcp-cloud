import { test } from 'node:test';
import { ensureCapabilitySchema } from '../src/schema/schema-capability.js';
import assert from 'node:assert/strict';
import pg from 'pg';
import { RoleConfigStore, ROLE_CONFIG_SCHEMA_SQL, ROLE_CONFIG_ALTER_SQL } from '../src/config/role-config-store.js';
import { fakeSchemaProbe } from './fixtures/schema-probe.js';

/** 假 pool 的 schema 探测应答：存储 init() 现在只探测、不建表（change cloud-schema-migration-executor 第 5 节）。 */
const schemaProbe = fakeSchemaProbe(ROLE_CONFIG_SCHEMA_SQL, ROLE_CONFIG_ALTER_SQL);

/** 内存假 pool：路由 role_config 的建表 / SELECT / upsert(RETURNING)；可注入写失败。provider 随 0018 加列。 */
function fakePool(seed: Record<string, { model: string | null; provider?: string | null; temperature: number | null; thinkingMode?: string | null }> = {}) {
  const rows = new Map<
    string,
    { role_id: string; model: string | null; provider: string | null; temperature: number | null; thinking_mode: string | null; updated_at: string; updated_by: string }
  >();
  for (const [roleId, v] of Object.entries(seed)) {
    rows.set(roleId, { role_id: roleId, model: v.model, provider: v.provider ?? null, temperature: v.temperature, thinking_mode: v.thinkingMode ?? null, updated_at: '2026-06-21T00:00:00.000Z', updated_by: 'seed' });
  }
  let failWrite = false;
  const pool = {
    query: async (sql: string, params?: unknown[]) => {
      const __probe = schemaProbe(sql);
      if (__probe) return __probe;
      if (sql.includes('CREATE TABLE') || sql.trimStart().startsWith('ALTER')) return { rows: [] };
      if (sql.trimStart().startsWith('SELECT')) return { rows: [...rows.values()] };
      if (sql.includes('INSERT INTO role_config')) {
        if (failWrite) throw new Error('db down');
        // change role-thinking-mode-config：thinking_mode 排在 temperature 之后、updated_by 之前（6 参数）。
        const [roleId, model, provider, temperature, thinkingMode, updatedBy] = params as [string, string | null, string | null, number | null, string | null, string];
        const row = { role_id: roleId, model, provider, temperature, thinking_mode: thinkingMode, updated_at: '2026-06-21T01:00:00.000Z', updated_by: updatedBy };
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
  const store = new RoleConfigStore({ schemaEnsurer: ensureCapabilitySchema, pool });
  await store.init();
  assert.deepEqual(store.getForRole('browse:content_evaluator'), { model: null, provider: null, temperature: null, thinkingMode: null });
});

test('set 后 getForRole 即时热加载（无需重启）', async () => {
  const { pool } = fakePool();
  const store = new RoleConfigStore({ schemaEnsurer: ensureCapabilitySchema, pool });
  await store.init();
  const row = await store.set('publish:ContentCreator', { model: 'qwen-max', provider: 'volcengine', temperature: 0.7 }, 'alice');
  assert.equal(row.model, 'qwen-max');
  assert.equal(row.provider, 'volcengine');
  assert.equal(row.temperature, 0.7);
  assert.equal(row.updatedBy, 'alice');
  assert.deepEqual(store.getForRole('publish:ContentCreator'), { model: 'qwen-max', provider: 'volcengine', temperature: 0.7, thinkingMode: null });
});

test('思考模式独立读写 + 不动模型行（change role-thinking-mode-config）', async () => {
  const { pool } = fakePool();
  const store = new RoleConfigStore({ schemaEnsurer: ensureCapabilitySchema, pool });
  await store.init();
  // 先设模型（含 provider/温度）
  await store.set('publish:ContentCreator', { model: 'qwen-max', provider: 'dashscope', temperature: 0.7 }, 'a');
  // 只设思考模式：模型行不受影响
  await store.set('publish:ContentCreator', { thinkingMode: 'on' }, 'b');
  let v = store.getForRole('publish:ContentCreator');
  assert.equal(v.thinkingMode, 'on');
  assert.equal(v.model, 'qwen-max'); // 未被思考模式写入清掉
  assert.equal(v.temperature, 0.7);
  // 'default'/脏串清除思考模式（回落），且不动模型
  await store.set('publish:ContentCreator', { thinkingMode: 'default' }, 'c');
  v = store.getForRole('publish:ContentCreator');
  assert.equal(v.thinkingMode, null);
  assert.equal(v.model, 'qwen-max');
  // 只改模型：思考模式保持（此处已为 null）
  await store.set('publish:ContentCreator', { thinkingMode: 'off' }, 'd');
  await store.set('publish:ContentCreator', { model: 'qwen-plus' }, 'e');
  assert.equal(store.getForRole('publish:ContentCreator').thinkingMode, 'off');
});

test('越界温度归一为 null（不落非法值）', async () => {
  const { pool } = fakePool();
  const store = new RoleConfigStore({ schemaEnsurer: ensureCapabilitySchema, pool });
  await store.init();
  const row = await store.set('publish:ContentCreator', { temperature: 9 }, 'a');
  assert.equal(row.temperature, null);
});

test('空模型名清除覆盖（回落）', async () => {
  const { pool } = fakePool({ 'browse:comment_composer': { model: 'qwen-max', temperature: null } });
  const store = new RoleConfigStore({ schemaEnsurer: ensureCapabilitySchema, pool });
  await store.init();
  assert.equal(store.getForRole('browse:comment_composer').model, 'qwen-max');
  await store.set('browse:comment_composer', { model: '' }, 'a');
  assert.equal(store.getForRole('browse:comment_composer').model, null);
});

test('写库失败 → 内存镜像不变（绝不镜像/库不一致）', async () => {
  const { pool, setFailWrite } = fakePool({ 'browse:comment_composer': { model: 'qwen-plus', temperature: null } });
  const store = new RoleConfigStore({ schemaEnsurer: ensureCapabilitySchema, pool });
  await store.init();
  setFailWrite(true);
  await assert.rejects(store.set('browse:comment_composer', { model: 'qwen-max' }, 'a'));
  assert.equal(store.getForRole('browse:comment_composer').model, 'qwen-plus');
});

test('getAll 暴露审计字段（updatedAt/By）', async () => {
  const { pool } = fakePool();
  const store = new RoleConfigStore({ schemaEnsurer: ensureCapabilitySchema, pool });
  await store.init();
  await store.set('publish:ContentCreator', { model: 'qwen-max' }, 'bob');
  const row = store.getAll().get('publish:ContentCreator');
  assert.equal(row?.updatedBy, 'bob');
  assert.ok(row?.updatedAt);
});
