import { test } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { ContentScheduleStore } from '../src/config/content-schedule-store.js';

const FULL = '1'.repeat(168);
const HALF = '1'.repeat(84) + '0'.repeat(84);

/**
 * pg.Pool 桩：按 SQL 前缀路由固定应答，记录全部 query 调用。
 * 覆盖：init 建表（空镜像）/ SELECT 1 FROM accounts 存在性 / UPSERT RETURNING 回读。
 */
function makePoolStub(opts: { accountExists?: boolean } = {}) {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const accountExists = opts.accountExists ?? true;
  const pool = {
    query: async (sql: string, params: unknown[] = []) => {
      calls.push({ sql, params });
      const s = sql.trim();
      if (s.startsWith('CREATE TABLE')) return { rows: [] };
      if (s.startsWith('SELECT content_active_mask')) return { rows: [] }; // init reload：全局无行
      if (s.startsWith('SELECT account_id, auto_enabled')) return { rows: [] }; // init reload：侧表无行
      if (s.startsWith('SELECT 1 FROM accounts')) return { rows: accountExists ? [{ '?column?': 1 }] : [] };
      if (s.startsWith('INSERT INTO content_schedule_global')) {
        return { rows: [{ content_active_mask: params[0], updated_at: new Date('2026-07-03T00:00:00Z'), updated_by: params[1] }] };
      }
      if (s.startsWith('INSERT INTO account_content_schedule')) {
        return {
          rows: [{
            account_id: params[0], auto_enabled: params[1], post_enabled: params[2],
            post_daily_cap: params[3], content_active_mask: params[4],
            updated_at: new Date('2026-07-03T00:00:00Z'), updated_by: params[5],
          }],
        };
      }
      throw new Error(`pool stub 未覆盖的 SQL：${s.slice(0, 60)}`);
    },
    end: async () => {},
  } as unknown as pg.Pool;
  return { pool, calls };
}

async function makeStore(opts: { accountExists?: boolean } = {}) {
  const { pool, calls } = makePoolStub(opts);
  const store = new ContentScheduleStore({ pool });
  await store.init();
  return { store, calls };
}

test('store: 未配 = 完全不自动（零回归默认）', async () => {
  const { store } = await makeStore();
  const s = store.effectiveScheduleFor('acc-1');
  assert.deepEqual(s, { autoEnabled: false, postEnabled: false, postDailyCap: 0, effectiveMask: null });
  assert.equal(store.getGlobal(), null);
  assert.equal(store.getAccount('acc-1'), null);
});

test('store: setGlobal 非法掩码整块拒（长度不对 / 非01 / 非串）', async () => {
  const { store } = await makeStore();
  for (const bad of ['1'.repeat(167), 'x'.repeat(168), 42 as unknown as string]) {
    const r = await store.setGlobal({ contentActiveMask: bad }, 'op');
    assert.deepEqual(r, { ok: false, reason: 'invalid_value' }, `bad=${String(bad).slice(0, 8)}…`);
  }
  // 未传字段 → no_valid_fields
  const r2 = await store.setGlobal({}, 'op');
  assert.deepEqual(r2, { ok: false, reason: 'no_valid_fields' });
});

test('store: setGlobal 合法掩码写后回读真态并刷镜像；null=清空', async () => {
  const { store } = await makeStore();
  const r = await store.setGlobal({ contentActiveMask: HALF }, 'op');
  assert.ok(r.ok);
  if (r.ok) assert.equal(r.row.contentActiveMask, HALF);
  assert.equal(store.getGlobal()?.contentActiveMask, HALF, '镜像已刷（供 effectiveScheduleFor 现读）');
  const r2 = await store.setGlobal({ contentActiveMask: null }, 'op');
  assert.ok(r2.ok && r2.row.contentActiveMask === null, '清空 = NULL');
});

test('store: setAccount 退役 default 拒、账号不存在拒（绝不造幽灵行）', async () => {
  const { store } = await makeStore();
  const r1 = await store.setAccount('default', { autoEnabled: true }, 'op');
  assert.deepEqual(r1, { ok: false, reason: 'retired_account' });

  const { store: s2, calls } = await makeStore({ accountExists: false });
  const r2 = await s2.setAccount('ghost-acc', { autoEnabled: true }, 'op');
  assert.deepEqual(r2, { ok: false, reason: 'account_not_found' });
  assert.ok(
    !calls.some((c) => c.sql.trim().startsWith('INSERT INTO account_content_schedule')),
    '账号不存在时绝不 UPSERT（不造幽灵排期行）',
  );
});

test('store: setAccount 非法值整块拒（cap 越界 / 类型错 / 掩码非法 / 空补丁）', async () => {
  const { store, calls } = await makeStore();
  const before = calls.length;
  for (const patch of [
    { postDailyCap: -1 },
    { postDailyCap: 1.5 },
    { postDailyCap: 51 }, // > CAP_MAX 50
    { autoEnabled: 'yes' as unknown as boolean },
    { contentActiveMask: '10'.repeat(10) },
    {},
  ]) {
    const r = await store.setAccount('acc-1', patch, 'op');
    assert.equal(r.ok, false, JSON.stringify(patch));
  }
  assert.equal(calls.length, before, '非法补丁不产生任何 SQL（先校验后触库，绝不部分落库）');
});

test('store: setAccount 合法写回读真态；effectiveScheduleFor 解析 override ?? global', async () => {
  const { store } = await makeStore();
  await store.setGlobal({ contentActiveMask: FULL }, 'op');
  const r = await store.setAccount('acc-1', { autoEnabled: true, postEnabled: true, postDailyCap: 2 }, 'op');
  assert.ok(r.ok);
  // 无 override → 继承全局
  let eff = store.effectiveScheduleFor('acc-1');
  assert.equal(eff.effectiveMask, FULL, '无覆盖 → 继承全局');
  assert.deepEqual([eff.autoEnabled, eff.postEnabled, eff.postDailyCap], [true, true, 2]);
  // 设 override → 用账号自己的
  await store.setAccount('acc-1', { contentActiveMask: HALF }, 'op');
  eff = store.effectiveScheduleFor('acc-1');
  assert.equal(eff.effectiveMask, HALF, '有覆盖 → 用账号自己的');
  // 清空 override → 回到继承
  await store.setAccount('acc-1', { contentActiveMask: null }, 'op');
  eff = store.effectiveScheduleFor('acc-1');
  assert.equal(eff.effectiveMask, FULL, '清空覆盖 → 回继承全局');
});

test('store: setAccount 未传字段保持原值（部分补丁不清其它字段）', async () => {
  const { store } = await makeStore();
  await store.setAccount('acc-1', { autoEnabled: true, postEnabled: true, postDailyCap: 3 }, 'op');
  await store.setAccount('acc-1', { postDailyCap: 1 }, 'op'); // 只改 cap
  const row = store.getAccount('acc-1');
  assert.deepEqual(
    [row?.autoEnabled, row?.postEnabled, row?.postDailyCap],
    [true, true, 1],
    '开关保持、仅 cap 变',
  );
});
