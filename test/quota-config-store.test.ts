import { test } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { QuotaConfigStore } from '../src/config/quota-config-store.js';
import { deriveWindowQuotas } from '../src/risk/quotas.js';
import { RISK_QUOTA_LEVELS } from '../src/risk/types.js';

/** 内存假 pool：路由 quota_config 的建表 / SELECT / upsert(RETURNING)；可注入写失败 + 脏行。 */
function fakePool(seed: Array<{ tier: string; action: string; daily: number; per_minute: number; per_hour: number }> = []) {
  const rows = new Map<string, { tier: string; action: string; daily: number; per_minute: number; per_hour: number; updated_at: string; updated_by: string }>();
  for (const s of seed) rows.set(`${s.tier} ${s.action}`, { ...s, updated_at: '2026-06-24T00:00:00.000Z', updated_by: 'seed' });
  let failWrite = false;
  const pool = {
    query: async (sql: string, params?: unknown[]) => {
      if (sql.includes('CREATE TABLE')) return { rows: [] };
      if (sql.includes('INSERT INTO quota_config')) {
        if (failWrite) throw new Error('db down');
        const [tier, action, daily, per_minute, per_hour, updated_by] = params as [string, string, number, number, number, string];
        const row = { tier, action, daily, per_minute, per_hour, updated_at: '2026-06-24T01:00:00.000Z', updated_by };
        rows.set(`${tier} ${action}`, row);
        return { rows: [row] };
      }
      if (sql.includes('FROM quota_config')) return { rows: [...rows.values()] };
      return { rows: [] };
    },
  };
  return { pool: pool as unknown as pg.Pool, setFailWrite: (v: boolean) => { failWrite = v; } };
}

test('零回归：表为空 → windowQuotasFor 与 deriveWindowQuotas 逐位一致（全档位）', async () => {
  const { pool } = fakePool();
  const store = new QuotaConfigStore({ pool });
  await store.init();
  for (const level of RISK_QUOTA_LEVELS) {
    assert.deepEqual(store.windowQuotasFor(level), deriveWindowQuotas(level), `档位 ${level} 应逐位一致`);
  }
});

test('命中库值 → 该 (tier,action) 三窗口用库值；其余动作仍回落派生默认', async () => {
  const { pool } = fakePool([{ tier: 'normal', action: 'like', daily: 999, per_minute: 7, per_hour: 88 }]);
  const store = new QuotaConfigStore({ pool });
  await store.init();
  const w = store.windowQuotasFor('normal');
  assert.equal(w.day.like, 999);
  assert.equal(w.minute.like, 7);
  assert.equal(w.hour.like, 88);
  // 未覆盖的 collect 仍是派生默认
  assert.equal(w.day.collect, deriveWindowQuotas('normal').day.collect);
});

test('脏行（非法 tier/action 或负值）→ 忽略，回落派生默认（绝不 brick）', async () => {
  const { pool } = fakePool([
    { tier: 'bogus_tier', action: 'like', daily: 5, per_minute: 5, per_hour: 5 },
    { tier: 'normal', action: 'like', daily: -3, per_minute: 4, per_hour: 10 },
  ]);
  const store = new QuotaConfigStore({ pool });
  await store.init();
  const w = store.windowQuotasFor('normal');
  // 负 daily 非法 → 回落派生默认；per_minute/per_hour 合法 → 用库值
  assert.equal(w.day.like, deriveWindowQuotas('normal').day.like);
  assert.equal(w.minute.like, 4);
  assert.equal(w.hour.like, 10);
});

test('set 后 windowQuotasFor 即时热加载（无需重启）+ 回真态含审计', async () => {
  const { pool } = fakePool();
  const store = new QuotaConfigStore({ pool });
  await store.init();
  const row = await store.set('aggressive', 'follow', { daily: 40, perMinute: 2, perHour: 12 }, 'alice');
  assert.equal(row.updatedBy, 'alice');
  const w = store.windowQuotasFor('aggressive');
  assert.equal(w.day.follow, 40);
  assert.equal(w.minute.follow, 2);
  assert.equal(w.hour.follow, 12);
});

test('部分窗口写：未传窗口保持原值（有原值）或回落派生默认（无原值）', async () => {
  const { pool } = fakePool([{ tier: 'normal', action: 'like', daily: 50, per_minute: 4, per_hour: 20 }]);
  const store = new QuotaConfigStore({ pool });
  await store.init();
  await store.set('normal', 'like', { daily: 60 }, 'a'); // 只改 daily
  const w = store.windowQuotasFor('normal');
  assert.equal(w.day.like, 60);
  assert.equal(w.minute.like, 4); // 保持原值
  assert.equal(w.hour.like, 20);
});

test('写库失败 → 内存镜像不变（绝不镜像/库不一致）', async () => {
  const { pool, setFailWrite } = fakePool([{ tier: 'normal', action: 'like', daily: 50, per_minute: 4, per_hour: 20 }]);
  const store = new QuotaConfigStore({ pool });
  await store.init();
  setFailWrite(true);
  await assert.rejects(store.set('normal', 'like', { daily: 999 }, 'a'));
  assert.equal(store.windowQuotasFor('normal').day.like, 50);
});
