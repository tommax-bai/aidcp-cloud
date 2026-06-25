import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSessionLimitPanel } from '../src/config/session-config-facade.js';
import type { SessionConfigRow, SessionConfigStore } from '../src/config/session-config-store.js';
import {
  DEFAULT_SESSION_BUDGET,
  DEFAULT_SESSION_DURATION_MIN,
  SESSION_BUDGET_KEYS,
  SESSION_LIMIT_MAX,
  defaultSessionBudget,
  type SessionInteractionBudget,
} from '../src/risk/session-limits.js';

/** 内存假 store：实现 facade 用到的 getRow / getAll / 提供者口 / set，记录 set 调用。 */
function fakeStore() {
  const rows = new Map<string, SessionConfigRow>();
  const setCalls: Array<{ accountId: string }> = [];
  const store = {
    getRow: (accountId: string) => rows.get(accountId),
    getAll: () => rows,
    sessionDurationMsFor: (accountId: string) => {
      const min = rows.get(accountId)?.maxDurationMin;
      if (min === undefined || !Number.isInteger(min) || min < 1) return DEFAULT_SESSION_DURATION_MIN * 60_000;
      return min * 60_000;
    },
    sessionBudgetFor: (accountId: string): SessionInteractionBudget => {
      const r = rows.get(accountId);
      const out = defaultSessionBudget();
      if (r) {
        for (const k of SESSION_BUDGET_KEYS) {
          const v = r.budget[k];
          if (Number.isInteger(v) && v >= 0) out[k] = v;
        }
      }
      return out;
    },
    set: async (accountId: string, patch: Record<string, number | undefined>, by: string): Promise<SessionConfigRow> => {
      setCalls.push({ accountId });
      const prev = rows.get(accountId);
      const budget = { ...DEFAULT_SESSION_BUDGET, ...(prev?.budget ?? {}) } as SessionInteractionBudget;
      for (const k of SESSION_BUDGET_KEYS) {
        if (patch[k] !== undefined) budget[k] = patch[k]!;
      }
      const row: SessionConfigRow = {
        accountId,
        maxDurationMin: patch.maxDurationMin ?? prev?.maxDurationMin ?? DEFAULT_SESSION_DURATION_MIN,
        budget,
        updatedAt: '2026-06-25T01:00:00.000Z',
        updatedBy: by,
      };
      rows.set(accountId, row);
      return row;
    },
  } as unknown as SessionConfigStore;
  return { store, rows, setCalls };
}

test('getCatalog：default 账号恒列 + 空库显示写死默认 + overridden=false', () => {
  const { store } = fakeStore();
  const panel = createSessionLimitPanel({ store });
  const view = panel.getCatalog();
  const def = view.limits.find((l) => l.accountId === 'default')!;
  assert.ok(def, 'default 账号应恒在目录中');
  assert.equal(def.overridden, false);
  assert.equal(def.maxDurationMin, DEFAULT_SESSION_DURATION_MIN);
  assert.deepEqual(def.budget, { ...DEFAULT_SESSION_BUDGET });
});

test('set 合法 → 落库 + 回真态(overridden=true) + 仅写 session_config', async () => {
  const { store, setCalls } = fakeStore();
  const panel = createSessionLimitPanel({ store });
  const r = await panel.set({ accountId: 'acc1', maxDurationMin: 20, likes: 7 }, 'bob');
  assert.equal(r.ok, true);
  assert.deepEqual(setCalls, [{ accountId: 'acc1' }]); // 只动 session_config
  const row = (r as { ok: true; view: { limits: Array<{ accountId: string; maxDurationMin: number; budget: SessionInteractionBudget; overridden: boolean }> } }).view.limits.find((l) => l.accountId === 'acc1')!;
  assert.equal(row.maxDurationMin, 20);
  assert.equal(row.budget.likes, 7);
  assert.equal(row.overridden, true);
});

test('非法数字（负 / 非整 / 超上限）→ invalid_value，整块拒不落库', async () => {
  const { store, setCalls } = fakeStore();
  const panel = createSessionLimitPanel({ store });
  for (const bad of [-1, 1.5, SESSION_LIMIT_MAX + 1]) {
    const r = await panel.set({ accountId: 'acc1', likes: bad }, 'a');
    assert.equal((r as { reason: string }).reason, 'invalid_value', `值 ${bad} 应拒`);
  }
  assert.equal(setCalls.length, 0, '任一非法整块拒，绝不落库');
});

test('时长 < 1 → invalid_value，绝不落库', async () => {
  const { store, setCalls } = fakeStore();
  const panel = createSessionLimitPanel({ store });
  const r = await panel.set({ accountId: 'acc1', maxDurationMin: 0 }, 'a');
  assert.equal((r as { reason: string }).reason, 'invalid_value');
  assert.equal(setCalls.length, 0);
});

test('时长 >= 1 合法 → ok', async () => {
  const { store } = fakeStore();
  const panel = createSessionLimitPanel({ store });
  const r = await panel.set({ accountId: 'acc1', maxDurationMin: 1 }, 'a');
  assert.equal(r.ok, true);
});

test('无任何可改字段 → no_valid_fields', async () => {
  const { store, setCalls } = fakeStore();
  const panel = createSessionLimitPanel({ store });
  const r = await panel.set({ accountId: 'acc1' }, 'a');
  assert.equal((r as { reason: string }).reason, 'no_valid_fields');
  assert.equal(setCalls.length, 0);
});

test('预算 0 是合法值（= 该项禁止）', async () => {
  const { store } = fakeStore();
  const panel = createSessionLimitPanel({ store });
  const r = await panel.set({ accountId: 'acc1', comments: 0 }, 'a');
  assert.equal(r.ok, true);
});

test('空 accountId → invalid_value，绝不落库', async () => {
  const { store, setCalls } = fakeStore();
  const panel = createSessionLimitPanel({ store });
  const r = await panel.set({ accountId: '', likes: 5 }, 'a');
  assert.equal((r as { reason: string }).reason, 'invalid_value');
  assert.equal(setCalls.length, 0);
});
