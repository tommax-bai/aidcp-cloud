import { test } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { PacingConfigStore } from '../src/config/pacing-config-store.js';
import { BUILTIN_FLOOR, OP_MIN_FLOOR, CAP_MS, PACING_OPS } from '../src/risk/pacing.js';

/** 内存假 pool：路由 pacing_floor_config 的建表 / SELECT / upsert(RETURNING)；可注入写失败 + 脏行 + 直插非法值。 */
function fakePool(seed: Array<{ operation: string; min_ms: number; max_ms: number }> = []) {
  const rows = new Map<string, { operation: string; min_ms: number; max_ms: number; updated_at: string; updated_by: string }>();
  for (const s of seed) rows.set(s.operation, { ...s, updated_at: '2026-07-04T00:00:00.000Z', updated_by: 'seed' });
  let failWrite = false;
  const pool = {
    query: async (sql: string, params?: unknown[]) => {
      if (sql.includes('CREATE TABLE')) return { rows: [] };
      if (sql.includes('INSERT INTO pacing_floor_config')) {
        if (failWrite) throw new Error('db down');
        const [operation, min_ms, max_ms, updated_by] = params as [string, number, number, string];
        const row = { operation, min_ms, max_ms, updated_at: '2026-07-04T01:00:00.000Z', updated_by };
        rows.set(operation, row);
        return { rows: [row] };
      }
      if (sql.includes('FROM pacing_floor_config')) return { rows: [...rows.values()] };
      return { rows: [] };
    },
  };
  return { pool: pool as unknown as pg.Pool, setFailWrite: (v: boolean) => { failWrite = v; }, rows };
}

test('零回归：表为空 → floorFor 每 op 逐字等于内置默认（已经读出口 clamp、非零）', async () => {
  const { pool } = fakePool();
  const store = new PacingConfigStore({ pool });
  await store.init();
  for (const op of PACING_OPS) {
    const eff = store.floorFor(op);
    assert.deepEqual(eff, { minMs: BUILTIN_FLOOR[op].minMs, maxMs: BUILTIN_FLOOR[op].maxMs }, `${op} 表空应回落内置默认`);
    assert.ok(eff.minMs >= OP_MIN_FLOOR[op] && eff.minMs > 0, `${op} 生效 min 恒 ≥ 非零防呆下限`);
  }
});

test('命中合法库值 → floorFor 用库值（在护栏内不被夹改）', async () => {
  const { pool } = fakePool([{ operation: 'action', min_ms: 2000, max_ms: 5000 }]);
  const store = new PacingConfigStore({ pool });
  await store.init();
  assert.deepEqual(store.floorFor('action'), { minMs: 2000, maxMs: 5000 });
  // 其余 op 仍回落内置默认。
  assert.deepEqual(store.floorFor('scroll'), { minMs: BUILTIN_FLOOR.scroll.minMs, maxMs: BUILTIN_FLOOR.scroll.maxMs });
});

test('psql 直插 0 → 读出口 clamp 夹回非零防呆下限（绝不零延迟）', async () => {
  const { pool } = fakePool([{ operation: 'action', min_ms: 0, max_ms: 0 }]);
  const store = new PacingConfigStore({ pool });
  await store.init();
  const eff = store.floorFor('action');
  assert.equal(eff.minMs, OP_MIN_FLOOR.action, 'min=0 应被夹回非零防呆下限');
  assert.ok(eff.minMs > 0 && eff.maxMs >= eff.minMs, '恒非零且 max≥min');
});

test('psql 直插超界 → 读出口 clamp 夹到 CAP（永不逼近看门狗）', async () => {
  const { pool } = fakePool([{ operation: 'card_gap', min_ms: 999999, max_ms: 999999 }]);
  const store = new PacingConfigStore({ pool });
  await store.init();
  const eff = store.floorFor('card_gap');
  assert.equal(eff.minMs, CAP_MS);
  assert.equal(eff.maxMs, CAP_MS);
  assert.ok(eff.maxMs <= CAP_MS, '恒 ≤ CAP');
});

test('psql 直插负数 → 视作缺、逐项回落内置默认（validInt 忽略负值）', async () => {
  const { pool } = fakePool([{ operation: 'scroll', min_ms: -5, max_ms: -1 }]);
  const store = new PacingConfigStore({ pool });
  await store.init();
  assert.deepEqual(store.floorFor('scroll'), { minMs: BUILTIN_FLOOR.scroll.minMs, maxMs: BUILTIN_FLOOR.scroll.maxMs });
});

test('脏行/未知 op → 忽略（不进镜像、getAll 不含、floorFor 回落）', async () => {
  const { pool } = fakePool([
    { operation: 'bogus_op', min_ms: 100, max_ms: 200 },
    { operation: 'action', min_ms: 1800, max_ms: 4000 },
  ]);
  const store = new PacingConfigStore({ pool });
  await store.init();
  assert.equal(store.getAll().size, 1, '仅合法 action 行入镜像');
  assert.equal(store.getRow('action')?.minMs, 1800);
  assert.deepEqual(store.floorFor('action'), { minMs: 1800, maxMs: 4000 });
});

test('越序库值（max<min）→ clamp 保证 max≥min（不返回负间隔）', async () => {
  const { pool } = fakePool([{ operation: 'detail_dwell', min_ms: 5000, max_ms: 2000 }]);
  const store = new PacingConfigStore({ pool });
  await store.init();
  const eff = store.floorFor('detail_dwell');
  assert.ok(eff.maxMs >= eff.minMs, 'max 应被抬到不小于 min');
});

test('set：UPSERT + 先写库后刷镜像 + 审计 updated_by；floorFor 立即读到新值（热加载）', async () => {
  const { pool } = fakePool();
  const store = new PacingConfigStore({ pool });
  await store.init();
  const row = await store.set('action', { minMs: 2000, maxMs: 5000 }, 'alice');
  assert.equal(row.updatedBy, 'alice');
  assert.deepEqual(store.floorFor('action'), { minMs: 2000, maxMs: 5000 });
  assert.ok(store.getRow('action'), '写后镜像应有覆盖行');
});

test('set：写库失败 → 镜像不变（不假成功）', async () => {
  const { pool, setFailWrite } = fakePool([{ operation: 'action', min_ms: 1800, max_ms: 4000 }]);
  const store = new PacingConfigStore({ pool });
  await store.init();
  setFailWrite(true);
  await assert.rejects(() => store.set('action', { minMs: 2500, maxMs: 6000 }, 'bob'));
  // 镜像仍是旧值（写库失败未刷镜像）。
  assert.deepEqual(store.floorFor('action'), { minMs: 1800, maxMs: 4000 });
});
