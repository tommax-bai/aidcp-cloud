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

/** 内存假 store（全局单例）：实现 facade 用到的 getRow / 提供者口 / set，记录 set 调用次数。 */
function fakeStore() {
  let row: SessionConfigRow | null = null;
  const setCalls: Array<Record<string, number | undefined>> = [];
  const store = {
    getRow: () => row ?? undefined,
    sessionDurationMs: () => {
      const min = row?.maxDurationMin;
      if (min === undefined || !Number.isInteger(min) || min < 1) return DEFAULT_SESSION_DURATION_MIN * 60_000;
      return min * 60_000;
    },
    sessionBudget: (): SessionInteractionBudget => {
      const out = defaultSessionBudget();
      if (row) {
        for (const k of SESSION_BUDGET_KEYS) {
          const v = row.budget[k];
          if (Number.isInteger(v) && v >= 0) out[k] = v;
        }
      }
      return out;
    },
    set: async (patch: Record<string, number | undefined>, by: string): Promise<SessionConfigRow> => {
      setCalls.push(patch);
      const prev = row;
      const budget = { ...DEFAULT_SESSION_BUDGET, ...(prev?.budget ?? {}) } as SessionInteractionBudget;
      for (const k of SESSION_BUDGET_KEYS) {
        if (patch[k] !== undefined) budget[k] = patch[k]!;
      }
      row = {
        maxDurationMin: patch.maxDurationMin ?? prev?.maxDurationMin ?? DEFAULT_SESSION_DURATION_MIN,
        budget,
        updatedAt: '2026-06-25T01:00:00.000Z',
        updatedBy: by,
      };
      return row;
    },
  } as unknown as SessionConfigStore;
  return { store, setCalls };
}

test('getView：空库显示写死默认 + overridden=false', () => {
  const { store } = fakeStore();
  const panel = createSessionLimitPanel({ store });
  const view = panel.getView();
  assert.equal(view.overridden, false);
  assert.equal(view.maxDurationMin, DEFAULT_SESSION_DURATION_MIN);
  assert.deepEqual(view.budget, { ...DEFAULT_SESSION_BUDGET });
});

test('set 合法 → 落库 + 回真态(overridden=true) + 仅写 session_config_global', async () => {
  const { store, setCalls } = fakeStore();
  const panel = createSessionLimitPanel({ store });
  const r = await panel.set({ maxDurationMin: 20, likes: 7 }, 'bob');
  assert.equal(r.ok, true);
  assert.equal(setCalls.length, 1, '只动 session_config_global 一次');
  const view = (r as { ok: true; view: { maxDurationMin: number; budget: SessionInteractionBudget; overridden: boolean } }).view;
  assert.equal(view.maxDurationMin, 20);
  assert.equal(view.budget.likes, 7);
  assert.equal(view.overridden, true);
});

test('非法数字（负 / 非整 / 超上限）→ invalid_value，整块拒不落库', async () => {
  const { store, setCalls } = fakeStore();
  const panel = createSessionLimitPanel({ store });
  for (const bad of [-1, 1.5, SESSION_LIMIT_MAX + 1]) {
    const r = await panel.set({ likes: bad }, 'a');
    assert.equal((r as { reason: string }).reason, 'invalid_value', `值 ${bad} 应拒`);
  }
  assert.equal(setCalls.length, 0, '任一非法整块拒，绝不落库');
});

test('时长 < 1 → invalid_value，绝不落库', async () => {
  const { store, setCalls } = fakeStore();
  const panel = createSessionLimitPanel({ store });
  const r = await panel.set({ maxDurationMin: 0 }, 'a');
  assert.equal((r as { reason: string }).reason, 'invalid_value');
  assert.equal(setCalls.length, 0);
});

test('时长 >= 1 合法 → ok', async () => {
  const { store } = fakeStore();
  const panel = createSessionLimitPanel({ store });
  const r = await panel.set({ maxDurationMin: 1 }, 'a');
  assert.equal(r.ok, true);
});

test('无任何可改字段 → no_valid_fields', async () => {
  const { store, setCalls } = fakeStore();
  const panel = createSessionLimitPanel({ store });
  const r = await panel.set({}, 'a');
  assert.equal((r as { reason: string }).reason, 'no_valid_fields');
  assert.equal(setCalls.length, 0);
});

test('预算 0 是合法值（= 该项禁止）', async () => {
  const { store } = fakeStore();
  const panel = createSessionLimitPanel({ store });
  const r = await panel.set({ comments: 0 }, 'a');
  assert.equal(r.ok, true);
});
