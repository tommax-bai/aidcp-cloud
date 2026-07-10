import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSessionLimitPanel } from '../src/config/session-config-facade.js';
import type { SessionConfigRow, SessionConfigStore } from '../src/config/session-config-store.js';
import {
  DEFAULT_COLLECT_SAVE_LIKE_DENOM,
  DEFAULT_FOLLOW_FANS_DENOM,
  DEFAULT_SESSION_BUDGET,
  DEFAULT_SESSION_DURATION_MIN,
  SESSION_BUDGET_KEYS,
  SESSION_LIMIT_MAX,
  defaultSessionBudget,
  isValidWeekActiveMask,
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
    collectSaveLikeRatio: () => {
      const d = row?.collectSaveLikeDenom;
      return 1 / (d != null && Number.isInteger(d) && d >= 1 ? d : DEFAULT_COLLECT_SAVE_LIKE_DENOM);
    },
    followFansRatio: () => {
      const d = row?.followFansDenom;
      return 1 / (d != null && Number.isInteger(d) && d >= 1 ? d : DEFAULT_FOLLOW_FANS_DENOM);
    },
    weekActiveMask: () => {
      const m = row?.activeWeekMask ?? null;
      return isValidWeekActiveMask(m) ? m : null;
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
        collectSaveLikeDenom: patch.collectSaveLikeDenom ?? prev?.collectSaveLikeDenom ?? null,
        followFansDenom: patch.followFansDenom ?? prev?.followFansDenom ?? null,
        activeWeekMask: (patch as { activeWeekMask?: string }).activeWeekMask ?? prev?.activeWeekMask ?? null,
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

test('set 加群预算合法 → 落库 + 回真态', async () => {
  const { store, setCalls } = fakeStore();
  const panel = createSessionLimitPanel({ store });
  const r = await panel.set({ join_groups: 2 }, 'bob');
  assert.equal(r.ok, true);
  assert.equal(setCalls.length, 1);
  const view = (r as { ok: true; view: { budget: SessionInteractionBudget } }).view;
  assert.equal(view.budget.join_groups, 2);
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

test('互动质量比例：空库显示写死默认 1:3 / 1:8', () => {
  const { store } = fakeStore();
  const view = createSessionLimitPanel({ store }).getView();
  assert.equal(view.collectSaveLikeDenom, DEFAULT_COLLECT_SAVE_LIKE_DENOM);
  assert.equal(view.followFansDenom, DEFAULT_FOLLOW_FANS_DENOM);
});

test('互动质量比例：set 分母 → 回真态生效', async () => {
  const { store, setCalls } = fakeStore();
  const panel = createSessionLimitPanel({ store });
  const r = await panel.set({ collectSaveLikeDenom: 4, followFansDenom: 12 }, 'bob');
  assert.equal(r.ok, true);
  assert.equal(setCalls.length, 1);
  const view = (r as { ok: true; view: { collectSaveLikeDenom: number; followFansDenom: number; overridden: boolean } }).view;
  assert.equal(view.collectSaveLikeDenom, 4);
  assert.equal(view.followFansDenom, 12);
  assert.equal(view.overridden, true);
});

test('互动质量比例：分母 0 / 负 / 非整 → invalid_value，整块拒不落库（除零会把闸搞坏）', async () => {
  const { store, setCalls } = fakeStore();
  const panel = createSessionLimitPanel({ store });
  for (const bad of [0, -1, 2.5]) {
    const r = await panel.set({ collectSaveLikeDenom: bad }, 'a');
    assert.equal((r as { reason: string }).reason, 'invalid_value', `分母 ${bad} 应拒`);
  }
  assert.equal(setCalls.length, 0);
});

// ── 「可活跃时间」周历掩码（change weekly-active-window）──────────────────────────

test('「可活跃时间」掩码：getView 空库 → activeWeekMask=null（不限）', () => {
  const { store } = fakeStore();
  const view = createSessionLimitPanel({ store }).getView();
  assert.equal(view.activeWeekMask, null);
});

test('「可活跃时间」掩码：set 合法 168 串 → 回真态生效 + 落库一次', async () => {
  const { store, setCalls } = fakeStore();
  const panel = createSessionLimitPanel({ store });
  const mask = '1'.repeat(168);
  const r = await panel.set({ activeWeekMask: mask }, 'bob');
  assert.equal(r.ok, true);
  assert.equal(setCalls.length, 1);
  const view = (r as { ok: true; view: { activeWeekMask: string | null; overridden: boolean } }).view;
  assert.equal(view.activeWeekMask, mask);
  assert.equal(view.overridden, true);
});

test('「可活跃时间」掩码：非法（长度/字符）→ invalid_value，整块拒不落库', async () => {
  const { store, setCalls } = fakeStore();
  const panel = createSessionLimitPanel({ store });
  for (const bad of ['', '10', '2'.repeat(168), '1'.repeat(167)]) {
    const r = await panel.set({ activeWeekMask: bad }, 'a');
    assert.equal((r as { reason: string }).reason, 'invalid_value', `掩码 ${JSON.stringify(bad).slice(0, 8)} 应拒`);
  }
  assert.equal(setCalls.length, 0);
});

test('「可活跃时间」掩码：仅传掩码也算有效字段（非 no_valid_fields）', async () => {
  const { store, setCalls } = fakeStore();
  const panel = createSessionLimitPanel({ store });
  const r = await panel.set({ activeWeekMask: '0'.repeat(168) }, 'a');
  assert.equal(r.ok, true);
  assert.equal(setCalls.length, 1);
});
