import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createResumeConfigPanel } from '../src/config/resume-config-facade.js';
import type { ResumeConfigRow, ResumeConfigStore } from '../src/config/resume-config-store.js';
import {
  DEFAULT_IDLE_END_MS,
  DEFAULT_IDLE_NUDGE_MS,
  IDLE_NUDGE_MIN_MS,
  REST_RATIO_PCT_MAX,
  type ActiveWindow,
  type DailyCaps,
} from '../src/risk/resume-limits.js';

/** 内存假 store（全局单例）：实现 facade 用到的 getRow / 提供者口 / set。校验回落简化为「合法值优先、否则写死默认」。 */
function fakeStore() {
  let row: ResumeConfigRow | null = null;
  const setCalls: Array<Record<string, number | undefined>> = [];
  const validInt = (v: number | null | undefined): number | undefined =>
    v !== null && v !== undefined && Number.isInteger(v) && v >= 0 ? v : undefined;
  const store = {
    getRow: () => row ?? undefined,
    restRatio: () => (validInt(row?.restRatioPct) ?? 10) / 100,
    activeWindow: (): ActiveWindow => {
      const s = validInt(row?.activeWindowStartMin);
      const e = validInt(row?.activeWindowEndMin);
      return s !== undefined && e !== undefined && s <= 1440 && e <= 1440 ? { startMin: s, endMin: e } : { startMin: 0, endMin: 1440 };
    },
    dailyCaps: (): DailyCaps => ({
      maxSessions: validInt(row?.dailyMaxSessions) ?? 0,
      maxMinutes: validInt(row?.dailyMaxMinutes) ?? 0,
    }),
    idleNudgeMs: () => {
      const ms = validInt(row?.idleNudgeMs);
      return ms === undefined || ms < IDLE_NUDGE_MIN_MS ? DEFAULT_IDLE_NUDGE_MS : ms;
    },
    idleEndMs: () => {
      const ms = validInt(row?.idleEndMs);
      const nudge = validInt(row?.idleNudgeMs) !== undefined && (row!.idleNudgeMs as number) >= IDLE_NUDGE_MIN_MS ? (row!.idleNudgeMs as number) : DEFAULT_IDLE_NUDGE_MS;
      return ms === undefined || ms <= nudge ? Math.max(DEFAULT_IDLE_END_MS, nudge + 1) : ms;
    },
    set: async (patch: Record<string, number | undefined>, by: string): Promise<ResumeConfigRow> => {
      setCalls.push(patch);
      const prev = row;
      const pick = (k: string, p: number | null | undefined) => (patch[k] ?? p ?? null);
      row = {
        restRatioPct: pick('restRatioPct', prev?.restRatioPct),
        activeWindowStartMin: pick('activeWindowStartMin', prev?.activeWindowStartMin),
        activeWindowEndMin: pick('activeWindowEndMin', prev?.activeWindowEndMin),
        dailyMaxSessions: pick('dailyMaxSessions', prev?.dailyMaxSessions),
        dailyMaxMinutes: pick('dailyMaxMinutes', prev?.dailyMaxMinutes),
        idleNudgeMs: pick('idleNudgeMs', prev?.idleNudgeMs),
        idleEndMs: pick('idleEndMs', prev?.idleEndMs),
        updatedAt: '2026-06-25T01:00:00.000Z',
        updatedBy: by,
      };
      return row;
    },
  } as unknown as ResumeConfigStore;
  return { store, setCalls };
}

test('getView：空库显示写死默认 + overridden=false', () => {
  const { store } = fakeStore();
  const panel = createResumeConfigPanel({ store });
  const v = panel.getView();
  assert.equal(v.overridden, false);
  assert.equal(v.restRatioPct, 10);
  assert.equal(v.activeWindowStartMin, 0);
  assert.equal(v.activeWindowEndMin, 1440);
  assert.equal(v.dailyMaxSessions, 0);
  assert.equal(v.idleNudgeMs, DEFAULT_IDLE_NUDGE_MS);
  assert.equal(v.idleEndMs, DEFAULT_IDLE_END_MS);
});

test('set 合法 → 落库 + overridden=true', async () => {
  const { store, setCalls } = fakeStore();
  const panel = createResumeConfigPanel({ store });
  const r = await panel.set({ restRatioPct: 25, dailyMaxSessions: 6 }, 'bob');
  assert.equal(r.ok, true);
  assert.equal(setCalls.length, 1);
  const v = (r as { ok: true; view: { restRatioPct: number; dailyMaxSessions: number; overridden: boolean } }).view;
  assert.equal(v.restRatioPct, 25);
  assert.equal(v.dailyMaxSessions, 6);
  assert.equal(v.overridden, true);
});

test('休息比例超上限 → invalid_value，整块拒不落库', async () => {
  const { store, setCalls } = fakeStore();
  const panel = createResumeConfigPanel({ store });
  const r = await panel.set({ restRatioPct: REST_RATIO_PCT_MAX + 1 }, 'a');
  assert.equal((r as { reason: string }).reason, 'invalid_value');
  assert.equal(setCalls.length, 0);
});

test('分钟越界（> 1440）→ invalid_value', async () => {
  const { store } = fakeStore();
  const panel = createResumeConfigPanel({ store });
  const r = await panel.set({ activeWindowStartMin: 1441 }, 'a');
  assert.equal((r as { reason: string }).reason, 'invalid_value');
});

test('轻推低于下限（< 91s）→ invalid_value（facade 拒，避免误触）', async () => {
  const { store } = fakeStore();
  const panel = createResumeConfigPanel({ store });
  const r = await panel.set({ idleNudgeMs: 50_000 }, 'a');
  assert.equal((r as { reason: string }).reason, 'invalid_value');
});

test('无任何可改字段 → no_valid_fields', async () => {
  const { store, setCalls } = fakeStore();
  const panel = createResumeConfigPanel({ store });
  const r = await panel.set({}, 'a');
  assert.equal((r as { reason: string }).reason, 'no_valid_fields');
  assert.equal(setCalls.length, 0);
});

test('每日上限 0 合法（= 不限）', async () => {
  const { store } = fakeStore();
  const panel = createResumeConfigPanel({ store });
  const r = await panel.set({ dailyMaxSessions: 0, dailyMaxMinutes: 0 }, 'a');
  assert.equal(r.ok, true);
});
