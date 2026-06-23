import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCategoryConfigPanel } from '../src/config/category-config-facade.js';
import type { CategoryConfigStore } from '../src/config/category-config-store.js';

/** 内存假 store：只实现 facade 用到的 getAll / getForCategory / set。 */
function fakeStore() {
  const rows = new Map<string, { categoryId: string; model: string | null; updatedAt: string | null; updatedBy: string | null }>();
  return {
    getAll: () => rows,
    getForCategory: (id: string) => {
      const r = rows.get(id);
      return r ? { model: r.model } : { model: null };
    },
    set: async (categoryId: string, model: string | null, by: string) => {
      const next = model?.trim() ? model.trim() : null;
      const row = { categoryId, model: next, updatedAt: '2026-06-23T00:00:00.000Z', updatedBy: by };
      rows.set(categoryId, row);
      return row;
    },
  } as unknown as CategoryConfigStore;
}

function makePanel(probeOk = true) {
  const store = fakeStore();
  const probed: string[] = [];
  const panel = createCategoryConfigPanel({
    store,
    getGlobalTextModel: () => 'qwen-turbo',
    probeModel: async (m) => {
      probed.push(m);
      if (!probeOk) throw new Error('invalid');
    },
  });
  return { panel, store, probed: () => probed };
}

test('getCatalog：只列可设默认的分类（纯图像分类 image 不出现）+ 生效值回落全局默认', () => {
  const { panel } = makePanel();
  const view = panel.getCatalog();
  assert.ok(view.categories.length >= 1);
  // 纯图像分类不可设文本默认
  assert.equal(view.categories.find((c) => c.categoryId === 'image'), undefined);
  const judge = view.categories.find((c) => c.categoryId === 'browse_judge')!;
  assert.equal(judge.effectiveModel, 'qwen-turbo'); // 无覆盖 → 回落全局默认
  assert.equal(judge.modelOverridden, false);
});

test('未知分类 → unknown_category，绝不落库', async () => {
  const { panel, store } = makePanel();
  const r = await panel.setCategoryConfig('nope_category', 'qwen-max', 'a');
  assert.deepEqual(r, { ok: false, reason: 'unknown_category' });
  assert.equal(store.getAll().size, 0);
});

test('纯图像分类设文本默认 → category_not_configurable，且未探活', async () => {
  const { panel, probed } = makePanel();
  const r = await panel.setCategoryConfig('image', 'qwen-max', 'a');
  assert.equal(r.ok, false);
  assert.equal((r as { reason: string }).reason, 'category_not_configurable');
  assert.equal(probed().length, 0);
});

test('无效模型名探活失败 → model_invalid，绝不落库', async () => {
  const { panel, store } = makePanel(false);
  const r = await panel.setCategoryConfig('browse_judge', 'nope-model', 'a');
  assert.equal((r as { reason: string }).reason, 'model_invalid');
  assert.equal(store.getAll().get('browse_judge'), undefined);
});

test('有效模型名探活通过 → 写入 + 回真态视图（含覆盖）', async () => {
  const { panel, store, probed } = makePanel(true);
  const r = await panel.setCategoryConfig('browse_judge', 'qwen-plus', 'alice');
  assert.equal(r.ok, true);
  assert.equal(probed()[0], 'qwen-plus');
  assert.equal(store.getAll().get('browse_judge')?.model, 'qwen-plus');
  const view = (r as { ok: true; view: { categories: Array<{ categoryId: string; effectiveModel: string; modelOverridden: boolean }> } }).view;
  const judge = view.categories.find((c) => c.categoryId === 'browse_judge')!;
  assert.equal(judge.effectiveModel, 'qwen-plus');
  assert.equal(judge.modelOverridden, true);
});

test('空/ null 模型名清除覆盖（不探活，回落全局）', async () => {
  const { panel, probed } = makePanel(true);
  const r = await panel.setCategoryConfig('browse_judge', null, 'a');
  assert.equal(r.ok, true);
  assert.equal(probed().length, 0);
});
