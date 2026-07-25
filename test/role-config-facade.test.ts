import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRoleConfigPanel } from '../src/config/role-config-facade.js';
import type { RoleConfigStore } from '../src/config/role-config-store.js';

type FakeRow = {
  roleId: string;
  model: string | null;
  provider: string | null;
  temperature: number | null;
  updatedAt: string | null;
  updatedBy: string | null;
};

/** 内存假 store：只实现 facade 用到的 getAll / getForRole / set（provider 跟 model 同行）。 */
function fakeStore() {
  const rows = new Map<string, FakeRow>();
  return {
    getAll: () => rows,
    getForRole: (id: string) => {
      const r = rows.get(id);
      return r
        ? { model: r.model, provider: r.provider, temperature: r.temperature }
        : { model: null, provider: null, temperature: null };
    },
    set: async (
      roleId: string,
      patch: { model?: string | null; provider?: string | null; temperature?: number | null },
      by: string,
    ) => {
      const prev = rows.get(roleId) ?? {
        roleId,
        model: null,
        provider: null,
        temperature: null,
        updatedAt: null,
        updatedBy: null,
      };
      const model = patch.model === undefined ? prev.model : patch.model?.trim() ? patch.model.trim() : null;
      let provider: string | null;
      if (patch.model === undefined) provider = prev.provider;
      else if (model === null) provider = null;
      else provider = patch.provider?.trim() || 'dashscope';
      const temperature = patch.temperature === undefined ? prev.temperature : patch.temperature;
      const row: FakeRow = { roleId, model, provider, temperature, updatedAt: '2026-06-21T00:00:00.000Z', updatedBy: by };
      rows.set(roleId, row);
      return row;
    },
  } as unknown as RoleConfigStore;
}

function makePanel(
  probeOk = true,
  categoryModels: Record<string, string | null> = {},
  opts: { keyMissing?: boolean; categoryProviders?: Record<string, string | null>; imageProvider?: string } = {},
) {
  const store = fakeStore();
  const probed: Array<{ provider: string; model: string }> = [];
  const panel = createRoleConfigPanel({
    store,
    getGlobalTextModel: () => 'qwen-turbo',
    getGlobalTextProvider: () => 'dashscope',
    getGlobalImageModel: () => 'wan2.7-image-pro',
    getGlobalImageProvider: () => opts.imageProvider ?? 'dashscope',
    getCategoryModel: (catId) => categoryModels[catId] ?? null,
    getCategoryProvider: (catId) => opts.categoryProviders?.[catId] ?? null,
    getCategoryThinking: () => null,
    thinkingOnAvailable: () => false,
    getVisionModel: () => 'qwen-vl-max',
    getVisionProvider: () => 'dashscope',
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

test('getCatalog：白名单 + 区分 text/image + 生效值回落全局 + 分类/来源标注', () => {
  const { panel } = makePanel();
  const view = panel.getCatalog();
  assert.ok(view.roles.length >= 16);
  const ev = view.roles.find((r) => r.roleId === 'browse:content_evaluator')!;
  assert.equal(ev.llmKind, 'text');
  assert.equal(ev.effectiveModel, 'qwen-turbo');
  assert.equal(ev.tunableTemperature, false);
  assert.equal(ev.category, 'browse_judge'); // 分类标注
  assert.equal(ev.effectiveSource, 'default'); // 无覆盖、无分类默认 → 继承全局默认
  const img = view.roles.find((r) => r.roleId === 'publish:ImageGenerator')!;
  assert.equal(img.llmKind, 'image');
  assert.equal(img.effectiveModel, 'wan2.7-image-pro');
  assert.equal(img.effectiveSource, 'image'); // 图像走全局 imageModel
  assert.equal(img.effectiveProvider, 'dashscope'); // #5：图像读真实图片厂商（默认万相 dashscope）
  // 纯规则/遗留角色不出现
  assert.equal(view.roles.find((r) => r.roleId === 'browse:feed_scroller'), undefined);
});

test('getCatalog：保真洗稿四角色进入后台目录，只有正文改写可调温度', () => {
  const { panel } = makePanel();
  const byId = new Map(panel.getCatalog().roles.map((r) => [r.roleId, r]));
  assert.equal(byId.get('publish:ReferenceAnalyzer')?.displayName, '保真洗稿·原稿分析');
  assert.equal(byId.get('publish:FaithfulRewritePlanner')?.tunableTemperature, false);
  assert.equal(byId.get('publish:FaithfulDraftWriter')?.tunableTemperature, true);
  assert.equal(byId.get('publish:FidelityAuditor')?.category, 'publish_gate');
  for (const id of ['publish:ReferenceAnalyzer', 'publish:FaithfulRewritePlanner', 'publish:FaithfulDraftWriter', 'publish:FidelityAuditor']) {
    assert.equal(byId.get(id)?.llmKind, 'text', `${id} 应为可配置文本模型角色`);
  }
});

test('图像角色 effectiveProvider 随全局图片厂商（#5：切火山即梦即如实显示，不再钉死文本默认）', () => {
  const { panel } = makePanel(true, {}, { imageProvider: 'volcengine' });
  const img = panel.getCatalog().roles.find((r) => r.roleId === 'publish:ImageGenerator')!;
  assert.equal(img.effectiveProvider, 'volcengine');
});

test('生效来源：分类有默认 → 同类无覆盖角色 effectiveSource=category；有覆盖 → override 压过分类', async () => {
  // browse_judge 分类设默认 qwen-plus；content_evaluator 无 per-role 覆盖 → 继承分类
  const { panel } = makePanel(true, { browse_judge: 'qwen-plus' });
  let ev = panel.getCatalog().roles.find((r) => r.roleId === 'browse:content_evaluator')!;
  assert.equal(ev.effectiveModel, 'qwen-plus');
  assert.equal(ev.effectiveSource, 'category');
  // 给该角色设 per-role 覆盖后，override 压过分类默认
  await panel.setRoleConfig('browse:content_evaluator', { model: 'qwen-max' }, 'a');
  ev = panel.getCatalog().roles.find((r) => r.roleId === 'browse:content_evaluator')!;
  assert.equal(ev.effectiveModel, 'qwen-max');
  assert.equal(ev.effectiveSource, 'override');
});

test('未知角色 → unknown_role，绝不落库', async () => {
  const { panel, store } = makePanel();
  const r = await panel.setRoleConfig('browse:nope', { model: 'qwen-max' }, 'a');
  assert.deepEqual(r, { ok: false, reason: 'unknown_role' });
  assert.equal(store.getAll().size, 0);
});

test('图像角色配模型 → model_not_configurable，且未探活', async () => {
  const { panel, probed } = makePanel();
  const r = await panel.setRoleConfig('publish:ImageGenerator', { model: 'qwen-max' }, 'a');
  assert.equal(r.ok, false);
  assert.equal((r as { reason: string }).reason, 'model_not_configurable');
  assert.equal(probed().length, 0);
});

test('判定类角色配温度 → temperature_not_tunable', async () => {
  const { panel } = makePanel();
  const r = await panel.setRoleConfig('browse:content_evaluator', { temperature: 0.5 }, 'a');
  assert.equal((r as { reason: string }).reason, 'temperature_not_tunable');
});

test('温度越界 → temperature_out_of_range', async () => {
  const { panel } = makePanel();
  const r = await panel.setRoleConfig('browse:comment_composer', { temperature: 2 }, 'a');
  assert.equal((r as { reason: string }).reason, 'temperature_out_of_range');
});

test('无效模型名探活失败 → model_invalid，绝不落库', async () => {
  const { panel, store } = makePanel(false);
  const r = await panel.setRoleConfig('browse:comment_composer', { model: 'nope-model' }, 'a');
  assert.equal((r as { reason: string }).reason, 'model_invalid');
  assert.equal(store.getAll().get('browse:comment_composer'), undefined);
});

test('有效模型名探活通过 → 写入 + 回真态视图（含覆盖）', async () => {
  const { panel, store, probed } = makePanel(true);
  const r = await panel.setRoleConfig('browse:comment_composer', { model: 'qwen-max', temperature: 0.7 }, 'alice');
  assert.equal(r.ok, true);
  assert.deepEqual(probed()[0], { provider: 'dashscope', model: 'qwen-max' });
  const row = store.getAll().get('browse:comment_composer');
  assert.equal(row?.model, 'qwen-max');
  assert.equal(row?.updatedBy, 'alice');
  const view = (r as { ok: true; view: { roles: Array<{ roleId: string; effectiveModel: string; modelOverridden: boolean; temperatureOverride: number | null }> } }).view;
  const cc = view.roles.find((x) => x.roleId === 'browse:comment_composer')!;
  assert.equal(cc.effectiveModel, 'qwen-max');
  assert.equal(cc.modelOverridden, true);
  assert.equal(cc.temperatureOverride, 0.7);
});

test('空模型名清除覆盖（不探活）', async () => {
  const { panel, probed } = makePanel(true);
  const r = await panel.setRoleConfig('browse:comment_composer', { model: '' }, 'a');
  assert.equal(r.ok, true);
  assert.equal(probed().length, 0);
});

test('火山覆盖：按所选 provider 探活并落库，effectiveProvider 跟同行', async () => {
  const { panel, store, probed } = makePanel(true);
  const r = await panel.setRoleConfig(
    'browse:comment_composer',
    { model: 'doubao-seed-1-6', provider: 'volcengine' },
    'alice',
  );
  assert.equal(r.ok, true);
  assert.deepEqual(probed()[0], { provider: 'volcengine', model: 'doubao-seed-1-6' });
  assert.equal(store.getAll().get('browse:comment_composer')?.provider, 'volcengine');
  const cc = (r as { ok: true; view: { roles: Array<{ roleId: string; effectiveProvider: string }> } }).view.roles.find(
    (x) => x.roleId === 'browse:comment_composer',
  )!;
  assert.equal(cc.effectiveProvider, 'volcengine');
});

test('选中厂商密钥缺失 → provider_key_missing（区别 model_invalid），绝不落库', async () => {
  const { panel, store } = makePanel(true, {}, { keyMissing: true });
  const r = await panel.setRoleConfig(
    'browse:comment_composer',
    { model: 'doubao-seed-1-6', provider: 'volcengine' },
    'a',
  );
  assert.equal((r as { reason: string }).reason, 'provider_key_missing');
  assert.equal(store.getAll().get('browse:comment_composer'), undefined);
});

test('未知 provider 归一 dashscope（绝不跨层混搭、绝不 brick）', async () => {
  const { panel, store, probed } = makePanel(true);
  const r = await panel.setRoleConfig('browse:comment_composer', { model: 'qwen-max', provider: 'bogus' }, 'a');
  assert.equal(r.ok, true);
  assert.deepEqual(probed()[0], { provider: 'dashscope', model: 'qwen-max' });
  assert.equal(store.getAll().get('browse:comment_composer')?.provider, 'dashscope');
});
