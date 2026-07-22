import { test } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { CONTENT_SCHEDULE_SCHEMA_SQL, ContentScheduleStore } from '../src/config/content-schedule-store.js';

const FULL = '1'.repeat(168);
const HALF = '1'.repeat(84) + '0'.repeat(84);

test('schema: 自动发帖小时格台账只保留 account/action 最新占位', () => {
  assert.match(CONTENT_SCHEDULE_SCHEMA_SQL, /CREATE TABLE IF NOT EXISTS content_schedule_hour_claims/);
  assert.match(CONTENT_SCHEDULE_SCHEMA_SQL, /PRIMARY KEY \(account_id, action\)/);
  assert.match(CONTENT_SCHEDULE_SCHEMA_SQL, /execution_target IN \('dev', 'ol'\)/);
});

test('claimAutoPostHourCell: 原子 upsert 仅首个进程拿到相同小时格', async () => {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  let first = true;
  const pool = {
    query: async (sql: string, params: unknown[] = []) => {
      calls.push({ sql, params });
      const rows = first ? [{ account_id: 'acc-1' }] : [];
      first = false;
      return { rows };
    },
  } as unknown as pg.Pool;
  const store = new ContentScheduleStore({ pool });
  const input = { accountId: 'acc-1', hourCell: '2026-01-05-10', executionTarget: 'dev' as const, envKey: 'env-1' };
  assert.equal(await store.claimAutoPostHourCell(input), true);
  assert.equal(await store.claimAutoPostHourCell(input), false);
  assert.match(calls[0].sql, /ON CONFLICT \(account_id, action\) DO UPDATE/);
  assert.match(calls[0].sql, /WHERE content_schedule_hour_claims\.hour_cell <> EXCLUDED\.hour_cell/);
  assert.deepEqual(calls[0].params, ['acc-1', '2026-01-05-10', 'dev', 'env-1']);
});

/**
 * pg.Pool 桩：按 SQL 前缀路由固定应答，记录全部 query 调用。
 * 覆盖：init 建表（空镜像）/ SELECT 1 FROM accounts 存在性 / UPSERT RETURNING 回读。
 */
function makePoolStub(opts: { accountExists?: boolean; myGroupCode?: string | null; codeSharedByOther?: boolean } = {}) {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const accountExists = opts.accountExists ?? true;
  const pool = {
    query: async (sql: string, params: unknown[] = []) => {
      calls.push({ sql, params });
      const s = sql.trim();
      if (s.startsWith('CREATE TABLE')) return { rows: [] };
      if (s.startsWith('SELECT content_active_mask')) return { rows: [] }; // init reload：全局无行
      if (s.startsWith('SELECT account_id, auto_enabled')) return { rows: [] }; // init reload：侧表无行
      if (s.startsWith('SELECT contact_info FROM accounts')) {
        return { rows: [{ contact_info: opts.myGroupCode ?? null }] };
      }
      if (s.startsWith('SELECT 1 FROM accounts WHERE contact_info')) {
        return { rows: opts.codeSharedByOther ? [{ '?column?': 1 }] : [] };
      }
      if (s.startsWith('SELECT 1 FROM accounts')) return { rows: accountExists ? [{ '?column?': 1 }] : [] };
      if (s.startsWith('INSERT INTO content_schedule_global')) {
        return { rows: [{ content_active_mask: params[0], updated_at: new Date('2026-07-03T00:00:00Z'), updated_by: params[1] }] };
      }
      if (s.startsWith('INSERT INTO account_content_schedule')) {
        return {
	          rows: [{
	            account_id: params[0], auto_enabled: params[1], post_enabled: params[2],
	            post_daily_cap: params[3], comment_enabled: params[4], comment_daily_cap: params[5],
	            contact_comment_enabled: params[6], contact_comment_daily_cap: params[7],
	            post_mode: params[8], comment_mode: params[9], contact_comment_mode: params[10],
	            active_week_mask: params[11], content_active_mask: params[12],
	            updated_at: new Date('2026-07-03T00:00:00Z'), updated_by: params[13],
	          }],
	        };
      }
      throw new Error(`pool stub 未覆盖的 SQL：${s.slice(0, 60)}`);
    },
    end: async () => {},
  } as unknown as pg.Pool;
  return { pool, calls };
}

async function makeStore(opts: {
  accountExists?: boolean;
  myGroupCode?: string | null;
  codeSharedByOther?: boolean;
  globalActiveWeekMask?: string | null;
} = {}) {
  const { pool, calls } = makePoolStub(opts);
  const store = new ContentScheduleStore({ pool, globalActiveWeekMask: () => opts.globalActiveWeekMask ?? null });
  await store.init();
  return { store, calls };
}

test('store: 未配 = 完全不自动（零回归默认）', async () => {
  const { store } = await makeStore();
  const s = store.effectiveScheduleFor('acc-1');
  assert.deepEqual(s, {
	    autoEnabled: false,
	    postEnabled: false,
	    postMode: 'off',
	    postDailyCap: 0,
	    commentEnabled: false,
	    commentMode: 'off',
	    commentDailyCap: 0,
	    contactCommentEnabled: false,
	    contactCommentMode: 'off',
	    contactCommentDailyCap: 0,
    effectiveActiveWeekMask: null,
    effectiveMask: null,
  });
  assert.equal(store.getGlobal(), null);
  assert.equal(store.getAccount('acc-1'), null);
});

test('listCatalog: 排期账号展示复用统一解析器，运营别名优先', async () => {
  const pool = {
    query: async (sql: string) => {
      assert.match(sql, /a\.operator_alias/);
      return { rows: [{
        account_id: 'acc-1', label: '运营标签', nickname: '平台昵称', operator_alias: '人工昵称',
        has_contact_info: false, auto_enabled: null, post_enabled: null, post_mode: null,
        post_daily_cap: null, comment_enabled: null, comment_mode: null, comment_daily_cap: null,
        contact_comment_enabled: null, contact_comment_mode: null, contact_comment_daily_cap: null,
        active_week_mask: null, content_active_mask: null, updated_at: null, updated_by: null,
      }] };
    },
    end: async () => {},
  } as unknown as pg.Pool;
  const [row] = await new ContentScheduleStore({ pool, globalActiveWeekMask: () => FULL }).listCatalog();
  assert.equal(row.operatorAlias, '人工昵称');
  assert.equal(row.displayName, '人工昵称');
  assert.equal(row.displayNameSource, 'operator_alias');
  assert.equal(row.activeMaskSource, 'global');
  assert.equal(row.contentMaskSource, 'global');
  assert.equal(row.effectiveActiveWeekMask, FULL);
  assert.equal(row.activeWeekMask, null);
  assert.equal(row.contentActiveMask, null);
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
    { activeWeekMask: '10'.repeat(10) },
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

test('store/account masks: 活跃与内容独立继承、原子保存、清空恢复全局且不改自动化开关', async () => {
  const { store } = await makeStore({ globalActiveWeekMask: FULL });
  await store.setGlobal({ contentActiveMask: HALF }, 'global-op');

  const first = await store.setAccount('acc-1', { activeWeekMask: HALF, contentActiveMask: FULL }, 'op');
  assert.ok(first.ok);
  if (first.ok) {
    assert.equal(first.row.activeWeekMask, HALF);
    assert.equal(first.row.contentActiveMask, FULL);
    assert.equal(first.row.autoEnabled, false, '仅保存账号排期不得隐式开启自动化');
  }
  let eff = store.effectiveScheduleFor('acc-1');
  assert.equal(eff.effectiveActiveWeekMask, HALF, '账号活跃覆盖优先');
  assert.equal(eff.effectiveMask, FULL, '账号内容覆盖优先');

  const cleared = await store.setAccount('acc-1', { activeWeekMask: null, contentActiveMask: null }, 'op');
  assert.ok(cleared.ok);
  eff = store.effectiveScheduleFor('acc-1');
  assert.equal(eff.effectiveActiveWeekMask, FULL, '清空活跃覆盖 → 回全局');
  assert.equal(eff.effectiveMask, HALF, '清空内容覆盖 → 回全局');
  assert.equal(eff.autoEnabled, false, '清空覆盖不改变总开关');
});

test('store/account masks: 脏活跃覆盖回落合法全局，脏内容覆盖保持 fail-closed 输入', async () => {
  const bad = 'broken';
  const pool = {
    query: async (sql: string) => {
      const s = sql.trim();
      if (s.startsWith('CREATE TABLE')) return { rows: [] };
      if (s.startsWith('SELECT content_active_mask')) return { rows: [{ content_active_mask: HALF, updated_at: null, updated_by: null }] };
      if (s.startsWith('SELECT account_id, auto_enabled')) return { rows: [{
        account_id: 'acc-1', auto_enabled: true, post_enabled: true, post_mode: 'review', post_daily_cap: 1,
        comment_enabled: false, comment_mode: 'off', comment_daily_cap: 0,
        contact_comment_enabled: false, contact_comment_mode: 'off', contact_comment_daily_cap: 0,
        active_week_mask: bad, content_active_mask: bad, updated_at: null, updated_by: null,
      }] };
      throw new Error(`未覆盖 SQL: ${s.slice(0, 60)}`);
    },
    end: async () => {},
  } as unknown as pg.Pool;
  const store = new ContentScheduleStore({ pool, globalActiveWeekMask: () => FULL });
  await store.init();
  const eff = store.effectiveScheduleFor('acc-1');
  assert.equal(eff.effectiveActiveWeekMask, FULL, '脏活跃覆盖不能绕过全局');
  assert.equal(eff.effectiveMask, bad, '脏内容覆盖交调度器按非法 fail-closed');
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


test('store/comment: 两新字段合法写回读；非法整块拒；部分补丁保持原值（change content-schedule-comments）', async () => {
  const { store, calls } = await makeStore();
  // 合法写
  const r = await store.setAccount('acc-1', { commentEnabled: true, commentDailyCap: 3 }, 'op');
  assert.ok(r.ok);
  if (r.ok) assert.deepEqual([r.row.commentEnabled, r.row.commentDailyCap], [true, 3]);
  // 非法整块拒（越界 / 类型错），且不触库
  const before = calls.length;
  for (const patch of [{ commentDailyCap: -1 }, { commentDailyCap: 51 }, { commentEnabled: 'on' as unknown as boolean }]) {
    const bad = await store.setAccount('acc-1', patch, 'op');
    assert.equal(bad.ok, false, JSON.stringify(patch));
  }
  assert.equal(calls.length, before, '非法评论补丁不产生 SQL');
  // 部分补丁保持原值：只改 post 不动 comment
  await store.setAccount('acc-1', { postEnabled: true, postDailyCap: 1 }, 'op');
  const row = store.getAccount('acc-1');
  assert.deepEqual([row?.commentEnabled, row?.commentDailyCap], [true, 3], 'comment 字段保持');
});


test('store/contact: 联系评论 cap 硬上限 0..10（11/负/小数整块拒）；合法写回读（change content-schedule-group-comments）', async () => {
  const { store, calls } = await makeStore({ myGroupCode: 'CODE-A' });
  const before = calls.length;
  for (const patch of [{ contactCommentDailyCap: 11 }, { contactCommentDailyCap: -1 }, { contactCommentDailyCap: 1.5 }]) {
    const bad = await store.setAccount('acc-1', patch, 'op');
    assert.deepEqual(bad, { ok: false, reason: 'invalid_value' }, JSON.stringify(patch));
  }
  assert.equal(calls.length, before, '非法联系评论补丁不触库');
  const r = await store.setAccount('acc-1', { contactCommentEnabled: true, contactCommentDailyCap: 3 }, 'op');
  assert.ok(r.ok);
  if (r.ok) assert.deepEqual([r.row.contactCommentEnabled, r.row.contactCommentDailyCap], [true, 3]);
});

test('store/contact: 联系方式闸 — 无联系方式硬拒 no_contact_info、共用放行+警告(loosen-group-comment-shared-code)、异值放行无警告、每次开启重跑', async () => {
  // 无码 → no_contact_info 硬拒（放松只针对「共用」，不针对「无码」）
  const noCode = await makeStore({ myGroupCode: null });
  assert.deepEqual(await noCode.store.setAccount('acc-1', { contactCommentEnabled: true }, 'op'),
    { ok: false, reason: 'no_contact_info' });
  // 同码他号 → 放行但带 sharedContactInfoWarning（一码一号从硬阻断放松为放行+提示，绝不静默）
  const shared = await makeStore({ myGroupCode: 'CODE-A', codeSharedByOther: true });
  const rs = await shared.store.setAccount('acc-1', { contactCommentEnabled: true }, 'op');
  assert.ok(rs.ok, '共用联系方式不再硬拒');
  assert.equal(rs.ok && rs.sharedContactInfoWarning, true, '共用联系方式放行须带风险警告');
  assert.equal(shared.store.getAccount('acc-1')?.contactCommentEnabled, true, '开关真落库');
  // 异码 → 放行、无警告
  const okCase = await makeStore({ myGroupCode: 'CODE-A', codeSharedByOther: false });
  const r = await okCase.store.setAccount('acc-1', { contactCommentEnabled: true }, 'op');
  assert.ok(r.ok);
  assert.equal(r.ok && r.sharedContactInfoWarning, undefined, '独立联系方式无警告');
  // 关闭开关不触发校验（enabled=false 写入无码也允许——只拦「开启」）
  const off = await makeStore({ myGroupCode: null });
  const r2 = await off.store.setAccount('acc-1', { contactCommentEnabled: false }, 'op');
  assert.ok(r2.ok, '关闭写入不过联系方式校验');
  assert.equal(r2.ok && r2.sharedContactInfoWarning, undefined, '关闭无警告');
});

test('store/group: attempts 记录与当日计数（pool 桩验 SQL 形状）', async () => {
  const seen: Array<{ sql: string; params: unknown[] }> = [];
  const pool = {
    query: async (sql: string, params: unknown[] = []) => {
      seen.push({ sql, params });
      const t = sql.trim();
      if (t.startsWith('CREATE TABLE')) return { rows: [] };
      if (t.startsWith('SELECT content_active_mask')) return { rows: [] };
      if (t.startsWith('SELECT account_id, auto_enabled')) return { rows: [] };
      if (t.startsWith('INSERT INTO contact_comment_attempts')) return { rows: [] };
      if (t.startsWith('SELECT count(*)::text AS n FROM contact_comment_attempts')) return { rows: [{ n: '2' }] };
      throw new Error('未覆盖 SQL: ' + t.slice(0, 50));
    },
    end: async () => {},
  } as unknown as pg.Pool;
  const store = new ContentScheduleStore({ pool });
  await store.init();
  await store.recordContactCommentAttempt('acc-1');
  const rec = seen.find((c) => c.sql.includes('INSERT INTO contact_comment_attempts'));
  // change feed-hot-lead-auto-group-comment：审计列（source/note_id/velocity/age_hours），无审计时传 null。
  assert.deepEqual(rec?.params, ['acc-1', null, null, null, null]);
  const recAudit = seen.length; // 再记一条带审计快照，验列位
  await store.recordContactCommentAttempt('acc-2', { source: 'hot_lead', noteId: 'n9', velocity: 2500, ageHours: 2 });
  const rec2 = seen.slice(recAudit).find((c) => c.sql.includes('INSERT INTO contact_comment_attempts'));
  assert.deepEqual(rec2?.params, ['acc-2', 'hot_lead', 'n9', 2500, 2]);
  const n = await store.countContactAttemptsToday('acc-1');
  assert.equal(n, 2);
  const cnt = seen.find((c) => c.sql.includes('count(*)::text AS n FROM contact_comment_attempts'));
  assert.match(cnt!.sql, /attempted_at >= .*AT TIME ZONE 'Asia\/Shanghai'/s);
});
