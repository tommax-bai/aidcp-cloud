import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCategoryConfigPanel } from '../src/config/category-config-facade.js';
import type { CategoryConfigStore } from '../src/config/category-config-store.js';

type FakeRow = { categoryId: string; model: string | null; provider: string | null; thinkingMode: 'off' | 'on' | null; updatedAt: string | null; updatedBy: string | null };

/** 内存假 store：只实现 facade 用到的 getAll / getForCategory / set（provider 跟 model 同行 + thinkingMode 独立）。 */
function fakeStore() {
  const rows = new Map<string, FakeRow>();
  return {
    getAll: () => rows,
    getForCategory: (id: string) => {
      const r = rows.get(id);
      return r
        ? { model: r.model, provider: r.provider, thinkingMode: r.thinkingMode }
        : { model: null, provider: null, thinkingMode: null };
    },
    set: async (
      categoryId: string,
      patch: { model?: string | null; provider?: string | null; thinkingMode?: string | null },
      by: string,
    ) => {
      const prev = rows.get(categoryId);
      const next = patch.model === undefined ? prev?.model ?? null : patch.model?.trim() ? patch.model.trim() : null;
      let nextProvider: string | null;
      if (patch.model === undefined) nextProvider = prev?.provider ?? null;
      else if (next === null) nextProvider = null;
      else nextProvider = patch.provider?.trim() || 'dashscope';
      const nt = patch.thinkingMode?.trim().toLowerCase();
      const nextThinking =
        patch.thinkingMode === undefined ? prev?.thinkingMode ?? null : nt === 'off' || nt === 'on' ? nt : null;
      const row: FakeRow = { categoryId, model: next, provider: nextProvider, thinkingMode: nextThinking, updatedAt: '2026-06-23T00:00:00.000Z', updatedBy: by };
      rows.set(categoryId, row);
      return row;
    },
  } as unknown as CategoryConfigStore;
}

function makePanel(probeOk = true, opts: { keyMissing?: boolean } = {}) {
  const store = fakeStore();
  const probed: Array<{ provider: string; model: string }> = [];
  const panel = createCategoryConfigPanel({
    store,
    getGlobalTextModel: () => 'qwen-turbo',
    getGlobalTextProvider: () => 'dashscope',
    thinkingOnAvailable: () => false,
    // P4-4：探活改结果型后，桩直接回结果（分类现在发生在组合根，不在外观里）。
    probeModel: async (provider, m) => {
      probed.push({ provider, model: m });
      if (opts.keyMissing) return { ok: false as const, reason: 'provider_key_missing' as const };
      if (!probeOk) return { ok: false as const, reason: 'model_unavailable' as const };
      return { ok: true as const };
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
  const r = await panel.setCategoryConfig('nope_category', { model: 'qwen-max', provider: 'dashscope' }, 'a');
  assert.deepEqual(r, { ok: false, reason: 'unknown_category' });
  assert.equal(store.getAll().size, 0);
});

test('纯图像分类设文本默认 → category_not_configurable，且未探活', async () => {
  const { panel, probed } = makePanel();
  const r = await panel.setCategoryConfig('image', { model: 'qwen-max', provider: 'dashscope' }, 'a');
  assert.equal(r.ok, false);
  assert.equal((r as { reason: string }).reason, 'category_not_configurable');
  assert.equal(probed().length, 0);
});

test('无效模型名探活失败 → model_invalid，绝不落库', async () => {
  const { panel, store } = makePanel(false);
  const r = await panel.setCategoryConfig('browse_judge', { model: 'nope-model', provider: 'dashscope' }, 'a');
  assert.equal((r as { reason: string }).reason, 'model_invalid');
  assert.equal(store.getAll().get('browse_judge'), undefined);
});

test('有效模型名探活通过 → 写入 + 回真态视图（含覆盖 + provider）', async () => {
  const { panel, store, probed } = makePanel(true);
  const r = await panel.setCategoryConfig('browse_judge', { model: 'qwen-plus', provider: 'dashscope' }, 'alice');
  assert.equal(r.ok, true);
  assert.deepEqual(probed()[0], { provider: 'dashscope', model: 'qwen-plus' });
  assert.equal(store.getAll().get('browse_judge')?.model, 'qwen-plus');
  const view = (r as { ok: true; view: { categories: Array<{ categoryId: string; effectiveModel: string; effectiveProvider: string; modelOverridden: boolean }> } }).view;
  const judge = view.categories.find((c) => c.categoryId === 'browse_judge')!;
  assert.equal(judge.effectiveModel, 'qwen-plus');
  assert.equal(judge.effectiveProvider, 'dashscope');
  assert.equal(judge.modelOverridden, true);
});

test('火山分类默认：按 provider 探活并落库，effectiveProvider 跟同行', async () => {
  const { panel, store, probed } = makePanel(true);
  const r = await panel.setCategoryConfig('browse_judge', { model: 'doubao-seed-1-6', provider: 'volcengine' }, 'alice');
  assert.equal(r.ok, true);
  assert.deepEqual(probed()[0], { provider: 'volcengine', model: 'doubao-seed-1-6' });
  assert.equal(store.getAll().get('browse_judge')?.provider, 'volcengine');
  const judge = (r as { ok: true; view: { categories: Array<{ categoryId: string; effectiveProvider: string }> } }).view.categories.find(
    (c) => c.categoryId === 'browse_judge',
  )!;
  assert.equal(judge.effectiveProvider, 'volcengine');
});

test('分类厂商密钥缺失 → provider_key_missing，绝不落库', async () => {
  const { panel, store } = makePanel(true, { keyMissing: true });
  const r = await panel.setCategoryConfig('browse_judge', { model: 'doubao-seed-1-6', provider: 'volcengine' }, 'a');
  assert.equal((r as { reason: string }).reason, 'provider_key_missing');
  assert.equal(store.getAll().get('browse_judge'), undefined);
});

test('空/ null 模型名清除覆盖（不探活，回落全局）', async () => {
  const { panel, probed } = makePanel(true);
  const r = await panel.setCategoryConfig('browse_judge', { model: null, provider: null }, 'a');
  assert.equal(r.ok, true);
  assert.equal(probed().length, 0);
});
