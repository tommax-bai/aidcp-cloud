import { test } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { ModelConfigStore, MODEL_CONFIG_DEFAULTS, MODEL_CONFIG_SCHEMA_SQL, MODEL_CONFIG_ALTER_SQL } from '../src/config/model-config-store.js';
import { fakeSchemaProbe } from './fixtures/schema-probe.js';

/** 假 pool 的 schema 探测应答：存储 init() 现在只探测、不建表（change cloud-schema-migration-executor 第 5 节）。 */
const schemaProbe = fakeSchemaProbe(MODEL_CONFIG_SCHEMA_SQL, MODEL_CONFIG_ALTER_SQL);

/** 内存假 pool：路由 model_config 的建表 / 自愈 ALTER / SELECT / upsert（单行）。text_provider 随 0018 加列。 */
function fakeModelPool(seed?: { text_model: string | null; text_provider?: string | null; image_model: string | null }) {
  let row: { text_model: string | null; text_provider: string | null; image_model: string | null } | null = seed
    ? { text_model: seed.text_model, text_provider: seed.text_provider ?? null, image_model: seed.image_model }
    : null;
  return {
    query: async (sql: string, params?: unknown[]) => {
      const __probe = schemaProbe(sql);
      if (__probe) return __probe;
      if (sql.includes('CREATE TABLE') || sql.trimStart().startsWith('ALTER')) return { rows: [] };
      if (sql.includes('SELECT text_model')) return { rows: row ? [row] : [] };
      if (sql.includes('INSERT INTO model_config')) {
        row = {
          text_model: params![0] as string,
          text_provider: params![1] as string,
          image_model: params![2] as string,
        };
        return { rows: [] };
      }
      return { rows: [] };
    },
  };
}

test('缺行 → 回退代码默认（qwen3.7-plus / wan2.7-image-pro；qwen-turbo 2026-07-13 下架不再作兜底）', async () => {
  const store = new ModelConfigStore({ pool: fakeModelPool() as unknown as pg.Pool });
  await store.init();
  assert.deepEqual(store.getCached(), MODEL_CONFIG_DEFAULTS);
});

test('set 后 getCached 即时热加载（无需重启）', async () => {
  const store = new ModelConfigStore({ pool: fakeModelPool() as unknown as pg.Pool });
  await store.init();
  const after = await store.set({ textModel: 'qwen-plus' }, 'admin');
  assert.equal(after.textModel, 'qwen-plus');
  assert.equal(after.imageModel, MODEL_CONFIG_DEFAULTS.imageModel); // 未传保持原值
  assert.equal(store.getCached().textModel, 'qwen-plus');
});

test('空 / 空白字段不覆盖原值', async () => {
  const store = new ModelConfigStore({ pool: fakeModelPool() as unknown as pg.Pool });
  await store.init();
  await store.set({ textModel: 'qwen-max' }, 'a');
  await store.set({ textModel: '   ' }, 'a'); // 空白忽略
  assert.equal(store.getCached().textModel, 'qwen-max');
});

test('已有行 → init 载入库内值而非默认', async () => {
  const store = new ModelConfigStore({
    pool: fakeModelPool({ text_model: 'qwen-max', image_model: 'wan2.5' }) as unknown as pg.Pool,
  });
  await store.init();
  assert.equal(store.getCached().textModel, 'qwen-max');
  assert.equal(store.getCached().imageModel, 'wan2.5');
});

test('textProvider 缺省 dashscope；set 后热加载 + 持久化（含火山）', async () => {
  const store = new ModelConfigStore({ pool: fakeModelPool() as unknown as pg.Pool });
  await store.init();
  assert.equal(store.getCached().textProvider, 'dashscope'); // 缺省零回归基准
  const after = await store.set({ textModel: 'doubao-seed-1-6', textProvider: 'volcengine' }, 'admin');
  assert.equal(after.textProvider, 'volcengine');
  assert.equal(store.getCached().textProvider, 'volcengine');
  assert.equal(store.getCached().textModel, 'doubao-seed-1-6');
  assert.equal(store.getCached().imageModel, MODEL_CONFIG_DEFAULTS.imageModel); // 图片不动
});

test('已有 text_provider 行 → init 载入库内厂商', async () => {
  const store = new ModelConfigStore({
    pool: fakeModelPool({ text_model: 'doubao-seed-1-6', text_provider: 'volcengine', image_model: 'wan2.5' }) as unknown as pg.Pool,
  });
  await store.init();
  assert.equal(store.getCached().textProvider, 'volcengine');
});
