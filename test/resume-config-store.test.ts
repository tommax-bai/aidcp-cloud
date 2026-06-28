import { test } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { ResumeConfigStore } from '../src/config/resume-config-store.js';
import {
  DEFAULT_IDLE_END_MS,
  DEFAULT_IDLE_NUDGE_MS,
  DEFAULT_REST_RATIO_PCT,
} from '../src/risk/resume-limits.js';

interface SeedRow {
  rest_ratio_pct: number | null;
  active_window_start_min: number | null;
  active_window_end_min: number | null;
  daily_max_sessions: number | null;
  daily_max_minutes: number | null;
  idle_nudge_ms: number | null;
  idle_end_ms: number | null;
}

/** 内存假 pool（全局单行）：路由 resume_config_global 的建表 / SELECT(id=1) / upsert(RETURNING)。 */
function fakePool(seed?: SeedRow) {
  let row: (SeedRow & { updated_at: string; updated_by: string }) | null = seed
    ? { ...seed, updated_at: '2026-06-25T00:00:00.000Z', updated_by: 'seed' }
    : null;
  let failWrite = false;
  const pool = {
    query: async (sql: string, params?: unknown[]) => {
      if (sql.includes('CREATE TABLE')) return { rows: [] };
      if (sql.includes('INSERT INTO resume_config_global')) {
        if (failWrite) throw new Error('db down');
        const [
          rest_ratio_pct,
          active_window_start_min,
          active_window_end_min,
          daily_max_sessions,
          daily_max_minutes,
          idle_nudge_ms,
          idle_end_ms,
          updated_by,
        ] = params as [number | null, number | null, number | null, number | null, number | null, number | null, number | null, string];
        row = {
          rest_ratio_pct,
          active_window_start_min,
          active_window_end_min,
          daily_max_sessions,
          daily_max_minutes,
          idle_nudge_ms,
          idle_end_ms,
          updated_at: '2026-06-25T01:00:00.000Z',
          updated_by,
        };
        return { rows: [row] };
      }
      if (sql.includes('FROM resume_config_global')) return { rows: row ? [row] : [] };
      return { rows: [] };
    },
  };
  return { pool: pool as unknown as pg.Pool, setFailWrite: (v: boolean) => { failWrite = v; } };
}

test('零回归：全局表为空 → 全回落写死默认（rest 10% / 全天 / 不限 / 轻推 130s / 放弃 1h）', async () => {
  const { pool } = fakePool();
  const store = new ResumeConfigStore({ pool });
  await store.init();
  assert.equal(store.restRatio(), DEFAULT_REST_RATIO_PCT / 100);
  assert.deepEqual(store.activeWindow(), { startMin: 0, endMin: 1440 });
  assert.deepEqual(store.dailyCaps(), { maxSessions: 0, maxMinutes: 0 });
  assert.equal(store.idleNudgeMs(), DEFAULT_IDLE_NUDGE_MS);
  assert.equal(store.idleEndMs(), DEFAULT_IDLE_END_MS);
  assert.equal(store.getRow(), undefined);
});

test('命中全局行 → 各项用库值', async () => {
  const { pool } = fakePool({
    rest_ratio_pct: 25, active_window_start_min: 480, active_window_end_min: 1320,
    daily_max_sessions: 6, daily_max_minutes: 120, idle_nudge_ms: 120_000, idle_end_ms: 1_800_000,
  });
  const store = new ResumeConfigStore({ pool });
  await store.init();
  assert.equal(store.restRatio(), 0.25);
  assert.deepEqual(store.activeWindow(), { startMin: 480, endMin: 1320 });
  assert.deepEqual(store.dailyCaps(), { maxSessions: 6, maxMinutes: 120 });
  assert.equal(store.idleNudgeMs(), 120_000);
  assert.equal(store.idleEndMs(), 1_800_000);
});

test('看门狗不变量：放弃 <= 轻推 → 放弃回落写死默认（end 必 > nudge）', async () => {
  const { pool } = fakePool({
    rest_ratio_pct: null, active_window_start_min: null, active_window_end_min: null,
    daily_max_sessions: null, daily_max_minutes: null, idle_nudge_ms: 200_000, idle_end_ms: 150_000,
  });
  const store = new ResumeConfigStore({ pool });
  await store.init();
  assert.equal(store.idleNudgeMs(), 200_000);
  assert.equal(store.idleEndMs(), Math.max(DEFAULT_IDLE_END_MS, 200_000 + 1), '放弃 <= 轻推 → 回落默认 1h');
  assert.ok(store.idleEndMs() > store.idleNudgeMs(), 'end 必严格大于 nudge');
});

test('轻推低于详情页停留上限（< 91s）→ 回落写死默认（绝不误触）', async () => {
  const { pool } = fakePool({
    rest_ratio_pct: null, active_window_start_min: null, active_window_end_min: null,
    daily_max_sessions: null, daily_max_minutes: null, idle_nudge_ms: 50_000, idle_end_ms: 3_600_000,
  });
  const store = new ResumeConfigStore({ pool });
  await store.init();
  assert.equal(store.idleNudgeMs(), DEFAULT_IDLE_NUDGE_MS);
});

test('活跃时段分钟越界（> 1440）→ 回落全天不限', async () => {
  const { pool } = fakePool({
    rest_ratio_pct: null, active_window_start_min: 9000, active_window_end_min: 1320,
    daily_max_sessions: null, daily_max_minutes: null, idle_nudge_ms: null, idle_end_ms: null,
  });
  const store = new ResumeConfigStore({ pool });
  await store.init();
  assert.deepEqual(store.activeWindow(), { startMin: 0, endMin: 1440 }, '任一端越界 → 全天不限');
});

test('set 后即时热加载 + 部分写未传字段保持原值', async () => {
  const { pool } = fakePool({
    rest_ratio_pct: 10, active_window_start_min: 0, active_window_end_min: 1440,
    daily_max_sessions: 0, daily_max_minutes: 0, idle_nudge_ms: 130_000, idle_end_ms: 3_600_000,
  });
  const store = new ResumeConfigStore({ pool });
  await store.init();
  await store.set({ restRatioPct: 30 }, 'alice'); // 只改休息比例
  assert.equal(store.restRatio(), 0.3);
  assert.deepEqual(store.activeWindow(), { startMin: 0, endMin: 1440 }, '未传窗口保持原值');
  assert.equal(store.getRow()?.updatedBy, 'alice');
});

test('写库失败 → 内存镜像不变', async () => {
  const { pool, setFailWrite } = fakePool({
    rest_ratio_pct: 10, active_window_start_min: 0, active_window_end_min: 1440,
    daily_max_sessions: 0, daily_max_minutes: 0, idle_nudge_ms: 130_000, idle_end_ms: 3_600_000,
  });
  const store = new ResumeConfigStore({ pool });
  await store.init();
  setFailWrite(true);
  await assert.rejects(store.set({ restRatioPct: 99 }, 'a'));
  assert.equal(store.restRatio(), 0.1, '写失败镜像不变');
});
