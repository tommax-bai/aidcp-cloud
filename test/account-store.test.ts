import { test } from 'node:test';
import assert from 'node:assert/strict';
import type pg from 'pg';
import { ACCOUNTS_SCHEMA_SQL, PgAccountStore } from '../src/account-store.js';

test('ACCOUNTS_SCHEMA_SQL 建 accounts 表（account_id PK + 关键列）', () => {
  assert.match(ACCOUNTS_SCHEMA_SQL, /CREATE TABLE IF NOT EXISTS accounts/);
  assert.match(ACCOUNTS_SCHEMA_SQL, /account_id\s+TEXT PRIMARY KEY/);
  assert.match(ACCOUNTS_SCHEMA_SQL, /persona_ref/);
  assert.match(ACCOUNTS_SCHEMA_SQL, /machine_label/);
  assert.match(ACCOUNTS_SCHEMA_SQL, /group_label/);
});

test('ACCOUNTS_SCHEMA_SQL status/quota_level 有 CHECK 约束（status 非空、无默认 active 歧义）', () => {
  assert.match(ACCOUNTS_SCHEMA_SQL, /status\s+TEXT NOT NULL DEFAULT 'active'/);
  assert.match(ACCOUNTS_SCHEMA_SQL, /CHECK \(status IN \('active','paused'\)\)/);
  assert.match(ACCOUNTS_SCHEMA_SQL, /CHECK \(quota_level IN \('conservative','normal','aggressive'\)\)/);
});

test('ACCOUNTS_SCHEMA_SQL 不再 seed 任何占位账号（retire-default-account：default 已退役，绝不建占位行）', () => {
  // 建表 SQL 不得含任何 INSERT（不 seed 占位行）；账号父行由真实账号握手时 ensureAccount 登记。
  assert.doesNotMatch(ACCOUNTS_SCHEMA_SQL, /INSERT INTO accounts/);
});

// ── change account-real-nickname：nickname 列自愈 DDL + setNickname 单写 ──

test('ACCOUNTS_SCHEMA_SQL 含 nickname 列 + 幂等自愈 ALTER（本仓无迁移执行器，靠 init() DDL 自愈）', () => {
  assert.match(ACCOUNTS_SCHEMA_SQL, /nickname\s+TEXT/);
  assert.match(ACCOUNTS_SCHEMA_SQL, /ALTER TABLE accounts ADD COLUMN IF NOT EXISTS nickname TEXT/);
});

test('ACCOUNTS_SCHEMA_SQL 含独立 operator_alias 列 + 幂等自愈 ALTER', () => {
  assert.match(ACCOUNTS_SCHEMA_SQL, /operator_alias\s+TEXT/);
  assert.match(ACCOUNTS_SCHEMA_SQL, /ALTER TABLE accounts ADD COLUMN IF NOT EXISTS operator_alias TEXT/);
});

test('ACCOUNTS_SCHEMA_SQL 含 platform 列 + 幂等自愈 ALTER（accounts.platform 是平台事实源）', () => {
  assert.match(ACCOUNTS_SCHEMA_SQL, /platform\s+TEXT NOT NULL DEFAULT 'xiaohongshu'/);
  assert.match(ACCOUNTS_SCHEMA_SQL, /ALTER TABLE accounts ADD COLUMN IF NOT EXISTS platform TEXT NOT NULL DEFAULT 'xiaohongshu'/);
});

function fakePool(): { calls: { text: string; params: unknown[] }[]; pool: pg.Pool } {
  const calls: { text: string; params: unknown[] }[] = [];
  const pool = {
    query: async (text: string, params: unknown[]) => {
      calls.push({ text, params });
      return { rows: [], rowCount: 0 };
    },
  } as unknown as pg.Pool;
  return { calls, pool };
}

test('setNickname: 非空昵称 trim 后 upsert（按 account_id，ON CONFLICT 自愈）', async () => {
  const { calls, pool } = fakePool();
  const store = new PgAccountStore({ pool });
  await store.setNickname('acc-1', '  工程师大白  ');
  assert.equal(calls.length, 1);
  assert.match(calls[0].text, /INSERT INTO accounts[\s\S]*nickname[\s\S]*ON CONFLICT \(account_id\) DO UPDATE SET nickname/);
  assert.deepEqual(calls[0].params, ['acc-1', '工程师大白']);
});

test('setNickname: 拒空白 → no-op（绝不用空覆盖已有真名）', async () => {
  const { calls, pool } = fakePool();
  const store = new PgAccountStore({ pool });
  await store.setNickname('acc-1', '   ');
  await store.setNickname('acc-1', '');
  assert.equal(calls.length, 0);
});

test('setOperatorAlias: 非空 trim 后 UPDATE-only，写后统一目录立即返回人工来源', async () => {
  const { calls, pool } = fakePoolReturning([{
    operator_alias: '运营重点号', nickname: '平台真名', label: 'acc-1',
  }]);
  const store = new PgAccountStore({ pool });
  const result = await store.setOperatorAlias('acc-1', '  运营重点号  ');
  assert.deepEqual(result, {
    ok: true,
    operatorAlias: '运营重点号',
    display: { name: '运营重点号', source: 'operator_alias' },
  });
  assert.deepEqual(store.getDisplayName('acc-1'), { name: '运营重点号', source: 'operator_alias' });
  assert.deepEqual(store.getDisplayNameCandidates('acc-1'), ['运营重点号', '平台真名']);
  assert.match(calls[0].text, /UPDATE accounts SET operator_alias = \$2 WHERE account_id = \$1/);
  assert.doesNotMatch(calls[0].text, /INSERT INTO accounts/);
  assert.deepEqual(calls[0].params, ['acc-1', '运营重点号']);
});

test('setOperatorAlias: 空白清为 NULL，并立即回落平台昵称', async () => {
  const { calls, pool } = fakePoolReturning([{
    operator_alias: null, nickname: '平台真名', label: '运营标签',
  }]);
  const store = new PgAccountStore({ pool });
  const result = await store.setOperatorAlias('acc-1', '   ');
  assert.deepEqual(result, {
    ok: true,
    operatorAlias: null,
    display: { name: '平台真名', source: 'platform_nickname' },
  });
  assert.equal(calls[0].params[1], null);
});

test('setOperatorAlias: 无账号与退役账号诚实拒绝', async () => {
  const { calls, pool } = fakePoolReturning([]);
  const store = new PgAccountStore({ pool });
  assert.deepEqual(await store.setOperatorAlias('ghost', '别名'), { ok: false, reason: 'account_not_found' });
  assert.deepEqual(await store.setOperatorAlias('default', '别名'), { ok: false, reason: 'retired_account' });
  assert.equal(calls.length, 1, '退役账号不得发 SQL');
});

test('平台昵称刷新只更新 nickname，绝不覆盖目录中的运营别名', async () => {
  const calls: { text: string; params: unknown[] }[] = [];
  const pool = {
    query: async (text: string, params: unknown[]) => {
      calls.push({ text, params });
      if (text.includes('SET operator_alias')) {
        return { rows: [{ operator_alias: '运营重点号', nickname: '旧平台名', label: 'acc-1' }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    },
  } as unknown as pg.Pool;
  const store = new PgAccountStore({ pool });
  await store.setOperatorAlias('acc-1', '运营重点号');
  await store.setNickname('acc-1', '新平台名');
  assert.deepEqual(store.getDisplayName('acc-1'), { name: '运营重点号', source: 'operator_alias' });
  assert.equal(store.getNickname('acc-1'), '新平台名');
  assert.deepEqual(store.getDisplayNameCandidates('acc-1'), ['运营重点号', '新平台名']);
});

test('init 预热运营别名、平台昵称和标签到统一同步目录', async () => {
  let call = 0;
  const pool = {
    query: async () => {
      call += 1;
      if (call === 1) return { rows: [], rowCount: 0 };
      return { rows: [{
        account_id: 'acc-1', operator_alias: '运营重点号', nickname: '平台真名', label: '标签',
        platform: 'facebook', created_at: null,
      }], rowCount: 1 };
    },
  } as unknown as pg.Pool;
  const store = new PgAccountStore({ pool });
  await store.init();
  assert.deepEqual(store.getDisplayName('acc-1'), { name: '运营重点号', source: 'operator_alias' });
  assert.deepEqual(store.getDisplayNameCandidates('acc-1'), ['运营重点号', '平台真名', '标签']);
});

// ── change editable-account-group-label：setGroupLabel 单写、UPDATE-only、诚实可区分 ──

/** 可配 RETURNING 行的 fake pool（setGroupLabel 靠 RETURNING 回读真态 / 判 not-found）。 */
function fakePoolReturning(rows: unknown[]): { calls: { text: string; params: unknown[] }[]; pool: pg.Pool } {
  const calls: { text: string; params: unknown[] }[] = [];
  const pool = {
    query: async (text: string, params: unknown[]) => {
      calls.push({ text, params });
      return { rows, rowCount: rows.length };
    },
  } as unknown as pg.Pool;
  return { calls, pool };
}

test('setGroupLabel: 非空 trim 后 UPDATE-only + RETURNING，回读真态（不 seed 造行）', async () => {
  const { calls, pool } = fakePoolReturning([{ group_label: '矩阵A' }]);
  const store = new PgAccountStore({ pool });
  const res = await store.setGroupLabel('acc-1', '  矩阵A  ');
  assert.deepEqual(res, { ok: true, groupLabel: '矩阵A' });
  assert.equal(calls.length, 1);
  assert.match(calls[0].text, /UPDATE accounts SET group_label = \$2 WHERE account_id = \$1 RETURNING group_label/);
  assert.doesNotMatch(calls[0].text, /INSERT INTO accounts/); // UPDATE-only：绝不 seed 幽灵行
  assert.deepEqual(calls[0].params, ['acc-1', '矩阵A']);
});

test('setGroupLabel: 空 / 纯空白 / null → 写 NULL（清空分组）', async () => {
  const { calls, pool } = fakePoolReturning([{ group_label: null }]);
  const store = new PgAccountStore({ pool });
  const r1 = await store.setGroupLabel('acc-1', '   ');
  assert.deepEqual(r1, { ok: true, groupLabel: null });
  assert.equal(calls[0].params[1], null);
  await store.setGroupLabel('acc-1', null);
  assert.equal(calls[1].params[1], null);
});

test('setGroupLabel: 无对应行（0 rows）→ account_not_found，可区分、不 seed', async () => {
  const { calls, pool } = fakePoolReturning([]); // UPDATE 影响 0 行
  const store = new PgAccountStore({ pool });
  const res = await store.setGroupLabel('ghost', '矩阵B');
  assert.deepEqual(res, { ok: false, reason: 'account_not_found' });
  assert.match(calls[0].text, /UPDATE accounts/);
  assert.doesNotMatch(calls[0].text, /INSERT/);
});

test('setGroupLabel: 退役保留账号 default 被拒，绝不落库', async () => {
  const { calls, pool } = fakePoolReturning([{ group_label: 'x' }]);
  const store = new PgAccountStore({ pool });
  const res = await store.setGroupLabel('default', '矩阵C');
  assert.deepEqual(res, { ok: false, reason: 'retired_account' });
  assert.equal(calls.length, 0); // 绝不发 SQL
});

// ── change account-group-chat-injection：setContactInfo 单写 + verbatim（不 trim / 不截断）──

test('ACCOUNTS_SCHEMA_SQL 含 contact_info 列 + 幂等自愈 ALTER', () => {
  assert.match(ACCOUNTS_SCHEMA_SQL, /ALTER TABLE accounts ADD COLUMN IF NOT EXISTS contact_info TEXT/);
});

test('setContactInfo: verbatim——含 emoji / 换行 / 首尾空白原样存（不 trim、不截断）+ UPDATE-only + RETURNING', async () => {
  const raw = '  2【长按复制】加群🐶🍅\n第二行 :/#f  '; // 首尾空白 + emoji + 换行 + 特殊符
  const { calls, pool } = fakePoolReturning([{ contact_info: raw }]);
  const store = new PgAccountStore({ pool });
  const res = await store.setContactInfo('acc-1', raw);
  assert.deepEqual(res, { ok: true, contactInfo: raw });
  assert.equal(calls.length, 1);
  assert.match(
    calls[0].text,
    /UPDATE accounts SET contact_info = \$2 WHERE account_id = \$1 RETURNING contact_info/,
  );
  assert.doesNotMatch(calls[0].text, /INSERT INTO accounts/); // UPDATE-only：绝不 seed 幽灵行
  assert.equal(calls[0].params[1], raw); // 原样：未 trim、未截断
});

test('setContactInfo: 超长码不截断（与 group_label 的 64 上限刻意相反）', async () => {
  const longCode = '群'.repeat(300);
  const { calls, pool } = fakePoolReturning([{ contact_info: longCode }]);
  const store = new PgAccountStore({ pool });
  const res = await store.setContactInfo('acc-1', longCode);
  assert.deepEqual(res, { ok: true, contactInfo: longCode });
  assert.equal((calls[0].params[1] as string).length, 300); // 不截断
});

test('setContactInfo: 空 / 纯空白 / null → 写 NULL（清空）', async () => {
  const { calls, pool } = fakePoolReturning([{ contact_info: null }]);
  const store = new PgAccountStore({ pool });
  const r1 = await store.setContactInfo('acc-1', '   ');
  assert.deepEqual(r1, { ok: true, contactInfo: null });
  assert.equal(calls[0].params[1], null);
  await store.setContactInfo('acc-1', '');
  assert.equal(calls[1].params[1], null);
  await store.setContactInfo('acc-1', null);
  assert.equal(calls[2].params[1], null);
});

test('setContactInfo: 无对应行（0 rows）→ account_not_found，可区分、不 seed', async () => {
  const { calls, pool } = fakePoolReturning([]);
  const store = new PgAccountStore({ pool });
  const res = await store.setContactInfo('ghost', '加群码');
  assert.deepEqual(res, { ok: false, reason: 'account_not_found' });
  assert.match(calls[0].text, /UPDATE accounts/);
  assert.doesNotMatch(calls[0].text, /INSERT/);
});

test('setContactInfo: 退役保留账号 default 被拒，绝不落库', async () => {
  const { calls, pool } = fakePoolReturning([{ contact_info: 'x' }]);
  const store = new PgAccountStore({ pool });
  const res = await store.setContactInfo('default', '加群码');
  assert.deepEqual(res, { ok: false, reason: 'retired_account' });
  assert.equal(calls.length, 0);
});

test('getContactInfo: 异步直读 SELECT，回 verbatim 值 / 缺行为 null', async () => {
  const code = '加群🐶\n第二行';
  const { calls, pool } = fakePoolReturning([{ contact_info: code }]);
  const store = new PgAccountStore({ pool });
  const got = await store.getContactInfo('acc-1');
  assert.equal(got, code);
  assert.match(calls[0].text, /SELECT contact_info FROM accounts WHERE account_id = \$1/);

  const { pool: emptyPool } = fakePoolReturning([]);
  const store2 = new PgAccountStore({ pool: emptyPool });
  assert.equal(await store2.getContactInfo('ghost'), null);
});

test('getPlatform: 读取 accounts.platform 并归一，缺行按历史 xhs 默认', async () => {
  const { calls, pool } = fakePoolReturning([{ platform: 'facebook' }]);
  const store = new PgAccountStore({ pool });
  assert.equal(await store.getPlatform('acc-fb'), 'facebook');
  assert.match(calls[0].text, /SELECT platform FROM accounts WHERE account_id = \$1/);

  const { pool: emptyPool } = fakePoolReturning([]);
  const store2 = new PgAccountStore({ pool: emptyPool });
  assert.equal(await store2.getPlatform('missing'), 'xiaohongshu');
});

test('listByPlatform: 按平台枚举账号并保留暂停态', async () => {
  const pausedAt = new Date('2026-07-06T00:00:00Z');
  const { calls, pool } = fakePoolReturning([
    { account_id: 'a1', status: 'active', paused_at: null, platform: 'xiaohongshu' },
    { account_id: 'a2', status: 'paused', paused_at: pausedAt, platform: 'xiaohongshu' },
  ]);
  const store = new PgAccountStore({ pool });
  assert.deepEqual(await store.listByPlatform('xiaohongshu'), [
    { accountId: 'a1', status: 'active', pausedAt: null, platform: 'xiaohongshu' },
    { accountId: 'a2', status: 'paused', pausedAt: pausedAt.getTime(), platform: 'xiaohongshu' },
  ]);
  assert.match(calls[0].text, /WHERE platform = \$1 ORDER BY account_id/);
  assert.deepEqual(calls[0].params, ['xiaohongshu']);
});

// ── facebook-scheduled-comment 2.5：握手 insert-time 平台预置（修复全新 FB 账号首连死锁）──

test('ensureAccount: 新账号按 edge 声明平台建行（INSERT 带 platform，回填缓存，无需再查库）', async () => {
  // RETURNING 返回一行 → 视为真插入了新行。
  const { calls, pool } = fakePoolReturning([{ platform: 'facebook' }]);
  const store = new PgAccountStore({ pool });
  await store.ensureAccount('fb-acc', 'facebook');
  assert.match(calls[0].text, /INSERT INTO accounts[\s\S]*platform[\s\S]*ON CONFLICT \(account_id\) DO NOTHING RETURNING platform/);
  assert.deepEqual(calls[0].params, ['fb-acc', 'facebook']);
  // 缓存已回填 → getPlatform 命中缓存、不再发第二次查询。
  assert.equal(await store.getPlatform('fb-acc'), 'facebook');
  assert.equal(calls.length, 1, 'getPlatform 命中缓存，不应产生额外查询');
});

test('ensureAccount: 缺省平台回落 xiaohongshu（行为不变）', async () => {
  const { calls, pool } = fakePoolReturning([{ platform: 'xiaohongshu' }]);
  const store = new PgAccountStore({ pool });
  await store.ensureAccount('legacy-acc');
  assert.deepEqual(calls[0].params, ['legacy-acc', 'xiaohongshu']);
});

test('ensureAccount: 既有行冲突（RETURNING 空）→ 不回填缓存（不污染既有平台）', async () => {
  // ON CONFLICT DO NOTHING 命中既有行 → RETURNING 空。
  const { calls, pool } = fakePoolReturning([]);
  const store = new PgAccountStore({ pool });
  await store.ensureAccount('existing', 'facebook');
  assert.equal(calls.length, 1);
  // 缓存未被写成 facebook；getPlatform 落库读真态（这里 fake 返回空 → 归一化为 xiaohongshu），
  // 关键是发生了第二次查询（= 未命中缓存），证明既有行平台没被 ensureAccount 覆盖/污染。
  await store.getPlatform('existing');
  assert.equal(calls.length, 2, '既有行不应回填缓存，getPlatform 必须落库读真态');
});

// ── change environment-level-slow-start：旧列只留迁移/回滚，不再提供账号级运行时读写 ──

test('ACCOUNTS_SCHEMA_SQL 含 slow_start_since 幂等自愈 ALTER（本仓无迁移执行器，dev/OL 那张既有表靠它补列）', () => {
  assert.match(ACCOUNTS_SCHEMA_SQL, /ALTER TABLE accounts ADD COLUMN IF NOT EXISTS slow_start_since TIMESTAMPTZ/);
});

test('PgAccountStore 不再暴露账号级慢启动 writer/provider（旧列不得重新成为运行时事实源）', () => {
  const { pool } = fakePoolReturning([]);
  const store = new PgAccountStore({ pool });
  assert.equal('setSlowStart' in store, false);
  assert.equal('slowStartSinceFor' in store, false);
});

test('platformFor：缺键 → undefined（未知），MUST NOT 回落 xiaohongshu', async () => {
  const { pool } = fakePoolReturning([]);
  const store = new PgAccountStore({ pool });
  // 与 getPlatform 刻意不同：那条归一化缺值为 xiaohongshu，这条服务于冷启动曲线选择——
  // 回落一次就是 FB 号按 XHS 曲线跑（D1 view=50 而非 20）。
  assert.equal(store.platformFor('never-seen'), undefined);
});
