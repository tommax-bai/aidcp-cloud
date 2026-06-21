import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRoleConfigPanel } from '../src/config/role-config-facade.js';
import type { RoleConfigStore } from '../src/config/role-config-store.js';

/** 内存假 store：只实现 facade 用到的 getAll / set。 */
function fakeStore() {
  const rows = new Map<string, { roleId: string; model: string | null; temperature: number | null; updatedAt: string | null; updatedBy: string | null }>();
  return {
    getAll: () => rows,
    getForRole: (id: string) => {
      const r = rows.get(id);
      return r ? { model: r.model, temperature: r.temperature } : { model: null, temperature: null };
    },
    set: async (roleId: string, patch: { model?: string | null; temperature?: number | null }, by: string) => {
      const prev = rows.get(roleId) ?? { roleId, model: null, temperature: null, updatedAt: null, updatedBy: null };
      const model = patch.model === undefined ? prev.model : patch.model?.trim() ? patch.model.trim() : null;
      const temperature = patch.temperature === undefined ? prev.temperature : patch.temperature;
      const row = { roleId, model, temperature, updatedAt: '2026-06-21T00:00:00.000Z', updatedBy: by };
      rows.set(roleId, row);
      return row;
    },
  } as unknown as RoleConfigStore;
}

function makePanel(probeOk = true) {
  const store = fakeStore();
  const probed: string[] = [];
  const panel = createRoleConfigPanel({
    store,
    getGlobalTextModel: () => 'qwen-turbo',
    getGlobalImageModel: () => 'wan2.7-image-pro',
    probeModel: async (m) => {
      probed.push(m);
      if (!probeOk) throw new Error('invalid');
    },
  });
  return { panel, store, probed: () => probed };
}

test('getCatalog：白名单 + 区分 text/image + 生效值回落全局', () => {
  const { panel } = makePanel();
  const view = panel.getCatalog();
  assert.ok(view.roles.length >= 16);
  const ev = view.roles.find((r) => r.roleId === 'browse:content_evaluator')!;
  assert.equal(ev.llmKind, 'text');
  assert.equal(ev.effectiveModel, 'qwen-turbo');
  assert.equal(ev.tunableTemperature, false);
  const img = view.roles.find((r) => r.roleId === 'publish:ImageGenerator')!;
  assert.equal(img.llmKind, 'image');
  assert.equal(img.effectiveModel, 'wan2.7-image-pro');
  // 纯规则/遗留角色不出现
  assert.equal(view.roles.find((r) => r.roleId === 'browse:feed_scroller'), undefined);
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
  assert.equal(probed()[0], 'qwen-max');
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
