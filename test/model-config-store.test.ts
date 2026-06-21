import { test } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { ModelConfigStore, MODEL_CONFIG_DEFAULTS } from '../src/config/model-config-store.js';

/** 内存假 pool：路由 model_config 的建表 / SELECT / upsert（单行）。 */
function fakeModelPool(seed?: { text_model: string | null; image_model: string | null }) {
  let row: { text_model: string | null; image_model: string | null } | null = seed ?? null;
  return {
    query: async (sql: string, params?: unknown[]) => {
      if (sql.includes('CREATE TABLE')) return { rows: [] };
      if (sql.includes('SELECT text_model')) return { rows: row ? [row] : [] };
      if (sql.includes('INSERT INTO model_config')) {
        row = { text_model: params![0] as string, image_model: params![1] as string };
        return { rows: [] };
      }
      return { rows: [] };
    },
  };
}

test('缺行 → 回退代码默认（qwen-turbo / wan2.7-image-pro）', async () => {
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
