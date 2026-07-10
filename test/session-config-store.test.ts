import { test } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { SessionConfigStore } from '../src/config/session-config-store.js';
import { DEFAULT_SESSION_BUDGET, DEFAULT_SESSION_DURATION_MS } from '../src/risk/session-limits.js';

interface SeedRow {
  max_duration_min: number;
  budget_likes: number;
  budget_collects: number;
  budget_follows: number;
  budget_searches: number;
  budget_comments: number;
  budget_comment_likes: number;
  budget_join_groups?: number;
  collect_save_like_denom?: number | null;
  follow_fans_denom?: number | null;
  active_week_mask?: string | null;
}

/** 内存假 pool（全局单行）：路由 session_config_global 的建表 / SELECT(id=1) / upsert(RETURNING)；可注入写失败 + 脏行。 */
function fakePool(seed?: SeedRow) {
  let row: (SeedRow & { updated_at: string; updated_by: string }) | null = seed
    ? { budget_join_groups: DEFAULT_SESSION_BUDGET.join_groups, ...seed, updated_at: '2026-06-25T00:00:00.000Z', updated_by: 'seed' }
    : null;
  let failWrite = false;
  const pool = {
    query: async (sql: string, params?: unknown[]) => {
      if (sql.includes('CREATE TABLE') || sql.includes('ALTER TABLE')) return { rows: [] };
      if (sql.includes('INSERT INTO session_config_global')) {
        if (failWrite) throw new Error('db down');
        // 入参顺序须与 store.set() 的 INSERT 占位符严格一致：
        // [时长, 7 项预算, 收藏分母, 关注分母, 周历掩码, updated_by]（共 12 个）。
        const [
          max_duration_min,
          budget_likes,
          budget_collects,
          budget_follows,
          budget_searches,
          budget_comments,
          budget_comment_likes,
          budget_join_groups,
          collect_save_like_denom,
          follow_fans_denom,
          active_week_mask,
          updated_by,
        ] = params as [
          number, number, number, number, number, number, number, number,
          number | null, number | null, string | null, string,
        ];
        row = {
          max_duration_min,
          budget_likes,
          budget_collects,
          budget_follows,
          budget_searches,
          budget_comments,
          budget_comment_likes,
          budget_join_groups,
          collect_save_like_denom,
          follow_fans_denom,
          active_week_mask,
          updated_at: '2026-06-25T01:00:00.000Z',
          updated_by,
        };
        return { rows: [row] };
      }
      if (sql.includes('FROM session_config_global')) return { rows: row ? [row] : [] };
      return { rows: [] };
    },
  };
  return { pool: pool as unknown as pg.Pool, setFailWrite: (v: boolean) => { failWrite = v; } };
}

test('零回归：全局表为空 → 回落写死默认（时长 10min + freshBudget 数字）', async () => {
  const { pool } = fakePool();
  const store = new SessionConfigStore({ pool });
  await store.init();
  assert.equal(store.sessionDurationMs(), DEFAULT_SESSION_DURATION_MS);
  assert.deepEqual(store.sessionBudget(), { ...DEFAULT_SESSION_BUDGET });
  assert.equal(store.getRow(), undefined, '空库 getRow 为 undefined（overridden=false）');
});

test('命中全局行 → 时长 + 预算用库值', async () => {
  const { pool } = fakePool({
    max_duration_min: 25, budget_likes: 20, budget_collects: 8, budget_follows: 4, budget_searches: 9, budget_comments: 3, budget_comment_likes: 6,
  });
  const store = new SessionConfigStore({ pool });
  await store.init();
  assert.equal(store.sessionDurationMs(), 25 * 60_000);
  assert.deepEqual(store.sessionBudget(), { likes: 20, collects: 8, follows: 4, searches: 9, comments: 3, comment_likes: 6, join_groups: 1 });
});

test('脏行：字段非法逐项回落写死默认（绝不 brick）', async () => {
  const { pool } = fakePool({
    max_duration_min: 30, budget_likes: -3, budget_collects: 8, budget_follows: 4, budget_searches: 9, budget_comments: 3, budget_comment_likes: 6,
  });
  const store = new SessionConfigStore({ pool });
  await store.init();
  const b = store.sessionBudget();
  assert.equal(b.likes, DEFAULT_SESSION_BUDGET.likes, '负 likes 非法 → 回落写死默认');
  assert.equal(b.collects, 8, '合法字段仍用库值');
});

test('时长 < 1 分钟 → 回落写死默认（防误存 0 致会话瞬时结束）', async () => {
  const { pool } = fakePool({
    max_duration_min: 0, budget_likes: 10, budget_collects: 5, budget_follows: 3, budget_searches: 5, budget_comments: 2, budget_comment_likes: 3,
  });
  const store = new SessionConfigStore({ pool });
  await store.init();
  assert.equal(store.sessionDurationMs(), DEFAULT_SESSION_DURATION_MS);
});

test('set 后即时热加载（无需重启）+ 回真态含审计', async () => {
  const { pool } = fakePool();
  const store = new SessionConfigStore({ pool });
  await store.init();
  const row = await store.set({ maxDurationMin: 20, likes: 7 }, 'alice');
  assert.equal(row.updatedBy, 'alice');
  assert.equal(store.sessionDurationMs(), 20 * 60_000);
  assert.equal(store.sessionBudget().likes, 7);
  assert.equal(store.sessionBudget().join_groups, DEFAULT_SESSION_BUDGET.join_groups);
  // 未传字段回落写死默认（列 NOT NULL）
  assert.equal(store.sessionBudget().collects, DEFAULT_SESSION_BUDGET.collects);
  assert.ok(store.getRow(), 'set 后 getRow 有行（overridden=true）');
});

test('部分写：未传字段保持原值（有原值）', async () => {
  const { pool } = fakePool({
    max_duration_min: 15, budget_likes: 12, budget_collects: 6, budget_follows: 4, budget_searches: 7, budget_comments: 2, budget_comment_likes: 3,
  });
  const store = new SessionConfigStore({ pool });
  await store.init();
  await store.set({ likes: 99 }, 'a'); // 只改 likes
  assert.equal(store.sessionBudget().likes, 99);
  assert.equal(store.sessionBudget().collects, 6, '未传 collects 保持原值');
  assert.equal(store.sessionBudget().join_groups, 1, '未传 join_groups 保持原值');
  assert.equal(store.sessionDurationMs(), 15 * 60_000, '未传时长保持原值');
});

test('set 加群预算 → 热加载即时生效', async () => {
  const { pool } = fakePool();
  const store = new SessionConfigStore({ pool });
  await store.init();
  await store.set({ join_groups: 2 }, 'alice');
  assert.equal(store.sessionBudget().join_groups, 2);
});

test('写库失败 → 内存镜像不变（绝不镜像/库不一致）', async () => {
  const { pool, setFailWrite } = fakePool({
    max_duration_min: 15, budget_likes: 12, budget_collects: 6, budget_follows: 4, budget_searches: 7, budget_comments: 2, budget_comment_likes: 3,
  });
  const store = new SessionConfigStore({ pool });
  await store.init();
  setFailWrite(true);
  await assert.rejects(store.set({ likes: 1 }, 'a'));
  assert.equal(store.sessionBudget().likes, 12, '写失败镜像不变');
});

test('sessionBudget 返回新拷贝：调用方扣减不污染下次取值', async () => {
  const { pool } = fakePool();
  const store = new SessionConfigStore({ pool });
  await store.init();
  const b = store.sessionBudget();
  b.likes = 0;
  assert.equal(store.sessionBudget().likes, DEFAULT_SESSION_BUDGET.likes, '上次扣减不应影响下次');
});

// ── 「可活跃时间」周历掩码（change weekly-active-window）──────────────────────────

test('零回归：空库 → weekActiveMask() 为 null（= 全天活跃不限）', async () => {
  const { pool } = fakePool();
  const store = new SessionConfigStore({ pool });
  await store.init();
  assert.equal(store.weekActiveMask(), null);
});

test('命中合法周历掩码（168 长 0/1）→ 原样返回', async () => {
  const mask = '0'.repeat(48) + '1'.repeat(120);
  const { pool } = fakePool({
    max_duration_min: 10, budget_likes: 10, budget_collects: 5, budget_follows: 3, budget_searches: 5, budget_comments: 2, budget_comment_likes: 3,
    active_week_mask: mask,
  });
  const store = new SessionConfigStore({ pool });
  await store.init();
  assert.equal(store.weekActiveMask(), mask);
});

test('脏掩码（长度/字符非法）→ weekActiveMask() 回落 null（绝不 brick）', async () => {
  for (const bad of ['10101', '2'.repeat(168), '1'.repeat(167)]) {
    const { pool } = fakePool({
      max_duration_min: 10, budget_likes: 10, budget_collects: 5, budget_follows: 3, budget_searches: 5, budget_comments: 2, budget_comment_likes: 3,
      active_week_mask: bad,
    });
    const store = new SessionConfigStore({ pool });
    await store.init();
    assert.equal(store.weekActiveMask(), null, `脏掩码 ${JSON.stringify(bad).slice(0, 12)} 应回落 null`);
  }
});

test('set 周历掩码 → 热加载即时生效；未传时长/预算回落写死默认', async () => {
  const mask = '1'.repeat(168);
  const { pool } = fakePool();
  const store = new SessionConfigStore({ pool });
  await store.init();
  const row = await store.set({ activeWeekMask: mask }, 'alice');
  assert.equal(row.activeWeekMask, mask);
  assert.equal(store.weekActiveMask(), mask);
  assert.equal(row.updatedBy, 'alice');
  assert.equal(store.sessionDurationMs(), DEFAULT_SESSION_DURATION_MS, '未传时长回落写死默认');
});

test('部分写：只改 likes 不动既存掩码 → 掩码保持原值', async () => {
  const mask = '1'.repeat(84) + '0'.repeat(84);
  const { pool } = fakePool({
    max_duration_min: 10, budget_likes: 10, budget_collects: 5, budget_follows: 3, budget_searches: 5, budget_comments: 2, budget_comment_likes: 3,
    active_week_mask: mask,
  });
  const store = new SessionConfigStore({ pool });
  await store.init();
  await store.set({ likes: 7 }, 'a');
  assert.equal(store.sessionBudget().likes, 7);
  assert.equal(store.weekActiveMask(), mask, '未传掩码保持原值');
});
