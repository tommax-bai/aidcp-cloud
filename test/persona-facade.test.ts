import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPersonaPanel } from '../src/config/persona-facade.js';
import type { PersonaStore, PersonaRow, PersonaAccount } from '../src/config/persona-store.js';

const soulYaml = (name: string) => `
identity:
  name: "${name}"
  role: "美妆博主"
  background: "三年护肤经验"
  tone: "亲切"
interests:
  primary:
    - "护肤"
  secondary:
    - "彩妆"
  seed_keywords:
    - "成分党"
`;

/** 内存假 store：实现 facade 用到的 getRow / listAccounts / accountExists / set / clear。 */
function fakeStore(opts: { accounts?: PersonaAccount[]; override?: Record<string, string> } = {}) {
  const accounts = opts.accounts ?? [{ accountId: 'default', label: 'default' }];
  const rows = new Map<string, PersonaRow>();
  for (const [id, persona] of Object.entries(opts.override ?? {})) {
    rows.set(id, { accountId: id, persona, updatedAt: '2026-06-24T00:00:00.000Z', updatedBy: 'seed' });
  }
  const store = {
    getRow: (id: string) => rows.get(id),
    listAccounts: async () => accounts,
    accountExists: async (id: string) => accounts.some((a) => a.accountId === id),
    set: async (id: string, persona: string, by: string) => {
      const row: PersonaRow = { accountId: id, persona, updatedAt: '2026-06-24T01:00:00.000Z', updatedBy: by };
      rows.set(id, row);
      return row;
    },
    clear: async (id: string) => { rows.delete(id); },
  } as unknown as PersonaStore;
  return { store, rows };
}

test('getCatalog：无覆盖账号 source=fallback + 身份摘要取打包默认（小林），无审计', async () => {
  const { store } = fakeStore();
  const panel = createPersonaPanel({ store });
  const view = await panel.getCatalog();
  const row = view.accounts.find((a) => a.accountId === 'default')!;
  assert.equal(row.source, 'fallback');
  assert.equal(row.identityName, '小林'); // 来自打包 soul.yaml
  assert.equal(row.updatedAt, null);
  assert.equal(row.updatedBy, null);
});

test('getCatalog：有覆盖账号 source=override + 身份摘要取覆盖 + 带审计', async () => {
  const { store } = fakeStore({ override: { default: soulYaml('账号A') } });
  const panel = createPersonaPanel({ store });
  const row = (await panel.getCatalog()).accounts.find((a) => a.accountId === 'default')!;
  assert.equal(row.source, 'override');
  assert.equal(row.identityName, '账号A');
  assert.equal(row.updatedBy, 'seed');
});

test('getDetail：覆盖→返回该账号文本；回落→返回打包默认原文（含小林）；未知账号→null', async () => {
  const { store } = fakeStore({ accounts: [{ accountId: 'default', label: 'D' }, { accountId: 'acc2', label: null }], override: { default: soulYaml('账号A') } });
  const panel = createPersonaPanel({ store });
  const overridden = await panel.getDetail('default');
  assert.ok(overridden!.persona.includes('账号A'));
  assert.equal(overridden!.source, 'override');
  const fallback = await panel.getDetail('acc2');
  assert.equal(fallback!.source, 'fallback');
  assert.ok(fallback!.persona.includes('小林')); // 打包默认原文作为编辑起点
  assert.equal(await panel.getDetail('ghost'), null);
});

test('setPersona：未知账号 → unknown_account，绝不落库（FK 守护）', async () => {
  const { store, rows } = fakeStore();
  const panel = createPersonaPanel({ store });
  const r = await panel.setPersona('ghost', soulYaml('x'), 'a');
  assert.deepEqual(r, { ok: false, reason: 'unknown_account' });
  assert.equal(rows.size, 0);
});

test('setPersona：非法人设 → persona_invalid，绝不落库、绝不假成功（红线）', async () => {
  const { store, rows } = fakeStore();
  const panel = createPersonaPanel({ store });
  const r = await panel.setPersona('default', 'identity: {}\ninterests: nope', 'a');
  assert.equal((r as { ok: false; reason: string }).reason, 'persona_invalid');
  assert.equal(rows.has('default'), false);
});

test('setPersona：合法人设 → 落库 + 回真态目录（source=override）', async () => {
  const { store, rows } = fakeStore();
  const panel = createPersonaPanel({ store });
  const r = await panel.setPersona('default', soulYaml('新人设'), 'bob');
  assert.equal(r.ok, true);
  assert.equal(rows.get('default')?.updatedBy, 'bob');
  const row = (r as { ok: true; view: { accounts: Array<{ accountId: string; source: string; identityName: string }> } }).view.accounts.find((a) => a.accountId === 'default')!;
  assert.equal(row.source, 'override');
  assert.equal(row.identityName, '新人设');
});

test('setPersona：空文本 → 清除覆盖（回落），回真态 source=fallback', async () => {
  const { store, rows } = fakeStore({ override: { default: soulYaml('旧') } });
  const panel = createPersonaPanel({ store });
  const r = await panel.setPersona('default', '   ', 'a');
  assert.equal(r.ok, true);
  assert.equal(rows.has('default'), false);
  const row = (r as { ok: true; view: { accounts: Array<{ accountId: string; source: string }> } }).view.accounts.find((a) => a.accountId === 'default')!;
  assert.equal(row.source, 'fallback');
});

test('setPersona：仅真绑定成功触发 onBound（清除 / 非法 / 未知账号均不触发）— auto-start-on-persona-bind', async () => {
  const { store } = fakeStore({ accounts: [{ accountId: 'acc1', label: null }], override: { acc1: soulYaml('旧') } });
  const bound: string[] = [];
  const panel = createPersonaPanel({ store, onBound: (id) => bound.push(id) });
  await panel.setPersona('acc1', soulYaml('新'), 'a'); // 真绑定 → 触发
  assert.deepEqual(bound, ['acc1'], '真绑定成功 → onBound(accountId)');
  await panel.setPersona('acc1', 'identity: {}\ninterests: nope', 'a'); // 非法 → 不触发
  await panel.setPersona('acc1', '   ', 'a'); // 清除（空文本回落）→ 不触发
  await panel.setPersona('ghost', soulYaml('x'), 'a'); // 未知账号 → 不触发
  assert.deepEqual(bound, ['acc1'], '清除/非法/未知账号均不触发 onBound（绝不误唤醒）');
});
