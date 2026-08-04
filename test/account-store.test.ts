import { test } from 'node:test';
import { ensureCapabilitySchema } from '../src/schema/schema-capability.js';
import assert from 'node:assert/strict';
import type pg from 'pg';
import { ACCOUNTS_SCHEMA_SQL, PgAccountStore } from '../src/account-store.js';
import { fakeSchemaProbe } from './fixtures/schema-probe.js';

/** 假 pool 的 schema 探测应答：存储 init() 现在只探测、不建表（change cloud-schema-migration-executor 第 5 节）。 */
const schemaProbe = fakeSchemaProbe(ACCOUNTS_SCHEMA_SQL);

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
      const __probe = schemaProbe(text);
      if (__probe) return __probe;
      calls.push({ text, params });
      return { rows: [], rowCount: 0 };
    },
  } as unknown as pg.Pool;
  return { calls, pool };
}

test('setNickname: 非空昵称 trim 后 upsert（按 account_id，ON CONFLICT 自愈）', async () => {
  const { calls, pool } = fakePool();
  const store = new PgAccountStore({ schemaEnsurer: ensureCapabilitySchema, pool });
  await store.setNickname('acc-1', '  工程师大白  ');
  assert.equal(calls.length, 1);
  assert.match(calls[0].text, /INSERT INTO accounts[\s\S]*nickname[\s\S]*ON CONFLICT \(account_id\) DO UPDATE SET nickname/);
  assert.deepEqual(calls[0].params, ['acc-1', '工程师大白']);
});

test('setNickname: 拒空白 → no-op（绝不用空覆盖已有真名）', async () => {
  const { calls, pool } = fakePool();
  const store = new PgAccountStore({ schemaEnsurer: ensureCapabilitySchema, pool });
  await store.setNickname('acc-1', '   ');
  await store.setNickname('acc-1', '');
  assert.equal(calls.length, 0);
});

test('setNickname self-heal insert and account_status bump share one transaction', async () => {
  const statements: string[] = [];
  const client = {
    async query(text: string) {
      statements.push(text);
      return { rows: [], rowCount: 1 };
    },
    release() {
      statements.push('RELEASE');
    },
  };
  const store = new PgAccountStore({
    schemaEnsurer: ensureCapabilitySchema,
    pool: { connect: async () => client } as unknown as pg.Pool,
    mirrorVersionBumper: {
      bumpDomain: 'api',
      async bumpInTx(_client, mirrorKey) {
        assert.equal(mirrorKey, 'account_status');
        statements.push('BUMP account_status');
        throw new Error('bump_failed');
      },
    },
  });

  await assert.rejects(store.setNickname('new-account', 'nickname'), /bump_failed/);
  assert.equal(statements[0], 'BEGIN');
  assert.ok(statements[1]!.includes('INSERT INTO accounts'));
  assert.equal(statements[2], 'BUMP account_status');
  assert.equal(statements[3], 'ROLLBACK');
  assert.equal(statements.includes('COMMIT'), false);
});

function nicknameTransactionPool(
  row: { nickname: string | null; label: string | null; operator_alias: string | null } | null,
): { statements: Array<{ text: string; params: unknown[] }>; pool: pg.Pool } {
  const statements: Array<{ text: string; params: unknown[] }> = [];
  const client = {
    query: async (text: string, params: unknown[] = []) => {
      statements.push({ text, params });
      if (/^SELECT nickname,label,operator_alias/.test(text)) {
        return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
      }
      if (/^UPDATE accounts SET nickname/.test(text)) {
        return { rows: [{ nickname: params[1] }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    },
    release: () => undefined,
  };
  return {
    statements,
    pool: { connect: async () => client } as unknown as pg.Pool,
  };
}

test('recordNickname: owner 事务内比较后 UPDATE-only，并回读真实昵称', async () => {
  const { statements, pool } = nicknameTransactionPool({
    nickname: '旧昵称',
    label: '账号标签',
    operator_alias: '运营别名',
  });
  const store = new PgAccountStore({ schemaEnsurer: ensureCapabilitySchema, pool });
  assert.deepEqual(await store.recordNickname('acc-1', '  新昵称  '), {
    outcome: 'updated',
    nickname: '新昵称',
  });
  assert.deepEqual(
    statements.map((statement) => statement.text),
    [
      'BEGIN',
      'SELECT nickname,label,operator_alias FROM accounts WHERE account_id=$1 FOR UPDATE',
      'UPDATE accounts SET nickname=$2 WHERE account_id=$1 RETURNING nickname',
      'COMMIT',
    ],
  );
  assert.doesNotMatch(statements[2].text, /INSERT/);
  assert.deepEqual(store.getDisplayName('acc-1'), { name: '运营别名', source: 'operator_alias' });
});

test('recordNickname: 同值不写、空白忽略、缺账号不造行', async () => {
  const same = nicknameTransactionPool({ nickname: '同名', label: null, operator_alias: null });
  const sameStore = new PgAccountStore({ schemaEnsurer: ensureCapabilitySchema, pool: same.pool });
  assert.deepEqual(await sameStore.recordNickname('acc-1', '同名'), {
    outcome: 'unchanged',
    nickname: '同名',
  });
  assert.ok(!same.statements.some((statement) => /^UPDATE accounts/.test(statement.text)));

  assert.deepEqual(await sameStore.recordNickname('acc-1', '   '), { outcome: 'ignored_blank' });

  const missing = nicknameTransactionPool(null);
  const missingStore = new PgAccountStore({ schemaEnsurer: ensureCapabilitySchema, pool: missing.pool });
  assert.deepEqual(await missingStore.recordNickname('ghost', '昵称'), { outcome: 'account_not_found' });
  assert.ok(!missing.statements.some((statement) => /^UPDATE accounts/.test(statement.text)));
  assert.deepEqual(await missingStore.recordNickname('default', '昵称'), { outcome: 'account_not_found' });
});

test('setOperatorAlias: 非空 trim 后 UPDATE-only，写后统一目录立即返回人工来源', async () => {
  const { calls, pool } = fakePoolReturning([{
    operator_alias: '运营重点号', nickname: '平台真名', label: 'acc-1',
  }]);
  const store = new PgAccountStore({ schemaEnsurer: ensureCapabilitySchema, pool });
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
  const store = new PgAccountStore({ schemaEnsurer: ensureCapabilitySchema, pool });
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
  const store = new PgAccountStore({ schemaEnsurer: ensureCapabilitySchema, pool });
  assert.deepEqual(await store.setOperatorAlias('ghost', '别名'), { ok: false, reason: 'account_not_found' });
  assert.deepEqual(await store.setOperatorAlias('default', '别名'), { ok: false, reason: 'retired_account' });
  assert.equal(calls.length, 1, '退役账号不得发 SQL');
});

test('平台昵称刷新只更新 nickname，绝不覆盖目录中的运营别名', async () => {
  const calls: { text: string; params: unknown[] }[] = [];
  const pool = {
    query: async (text: string, params: unknown[]) => {
      const __probe = schemaProbe(text);
      if (__probe) return __probe;
      calls.push({ text, params });
      if (text.includes('SET operator_alias')) {
        return { rows: [{ operator_alias: '运营重点号', nickname: '旧平台名', label: 'acc-1' }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    },
  } as unknown as pg.Pool;
  const store = new PgAccountStore({ schemaEnsurer: ensureCapabilitySchema, pool });
  await store.setOperatorAlias('acc-1', '运营重点号');
  await store.setNickname('acc-1', '新平台名');
  assert.deepEqual(store.getDisplayName('acc-1'), { name: '运营重点号', source: 'operator_alias' });
  assert.equal(store.getNickname('acc-1'), '新平台名');
  assert.deepEqual(store.getDisplayNameCandidates('acc-1'), ['运营重点号', '新平台名']);
});

test('init 预热运营别名、平台昵称和标签到统一同步目录', async () => {
  const pool = {
    query: async (sql: string) => {
      // init() 现在先探测 schema 再预热（change cloud-schema-migration-executor 第 5 节），
      // 探测应答由 ACCOUNTS_SCHEMA_SQL 推导，剩下的那一次才是预热 SELECT。
      const probe = schemaProbe(sql);
      if (probe) return probe;
      return { rows: [{
        account_id: 'acc-1', operator_alias: '运营重点号', nickname: '平台真名', label: '标签',
        platform: 'facebook', created_at: null,
      }], rowCount: 1 };
    },
  } as unknown as pg.Pool;
  const store = new PgAccountStore({ schemaEnsurer: ensureCapabilitySchema, pool });
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
      const __probe = schemaProbe(text);
      if (__probe) return __probe;
      calls.push({ text, params });
      return { rows, rowCount: rows.length };
    },
  } as unknown as pg.Pool;
  return { calls, pool };
}

test('setGroupLabel: 非空 trim 后 UPDATE-only + RETURNING，回读真态（不 seed 造行）', async () => {
  const { calls, pool } = fakePoolReturning([{ group_label: '矩阵A' }]);
  const store = new PgAccountStore({ schemaEnsurer: ensureCapabilitySchema, pool });
  const res = await store.setGroupLabel('acc-1', '  矩阵A  ');
  assert.deepEqual(res, { ok: true, groupLabel: '矩阵A' });
  assert.equal(calls.length, 1);
  assert.match(calls[0].text, /UPDATE accounts SET group_label = \$2 WHERE account_id = \$1 RETURNING group_label/);
  assert.doesNotMatch(calls[0].text, /INSERT INTO accounts/); // UPDATE-only：绝不 seed 幽灵行
  assert.deepEqual(calls[0].params, ['acc-1', '矩阵A']);
});

test('setGroupLabel: 空 / 纯空白 / null → 写 NULL（清空分组）', async () => {
  const { calls, pool } = fakePoolReturning([{ group_label: null }]);
  const store = new PgAccountStore({ schemaEnsurer: ensureCapabilitySchema, pool });
  const r1 = await store.setGroupLabel('acc-1', '   ');
  assert.deepEqual(r1, { ok: true, groupLabel: null });
  assert.equal(calls[0].params[1], null);
  await store.setGroupLabel('acc-1', null);
  assert.equal(calls[1].params[1], null);
});

test('setGroupLabel: 无对应行（0 rows）→ account_not_found，可区分、不 seed', async () => {
  const { calls, pool } = fakePoolReturning([]); // UPDATE 影响 0 行
  const store = new PgAccountStore({ schemaEnsurer: ensureCapabilitySchema, pool });
  const res = await store.setGroupLabel('ghost', '矩阵B');
  assert.deepEqual(res, { ok: false, reason: 'account_not_found' });
  assert.match(calls[0].text, /UPDATE accounts/);
  assert.doesNotMatch(calls[0].text, /INSERT/);
});

test('setGroupLabel: 退役保留账号 default 被拒，绝不落库', async () => {
  const { calls, pool } = fakePoolReturning([{ group_label: 'x' }]);
  const store = new PgAccountStore({ schemaEnsurer: ensureCapabilitySchema, pool });
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
  const store = new PgAccountStore({ schemaEnsurer: ensureCapabilitySchema, pool });
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
  const store = new PgAccountStore({ schemaEnsurer: ensureCapabilitySchema, pool });
  const res = await store.setContactInfo('acc-1', longCode);
  assert.deepEqual(res, { ok: true, contactInfo: longCode });
  assert.equal((calls[0].params[1] as string).length, 300); // 不截断
});

test('setContactInfo: 空 / 纯空白 / null → 写 NULL（清空）', async () => {
  const { calls, pool } = fakePoolReturning([{ contact_info: null }]);
  const store = new PgAccountStore({ schemaEnsurer: ensureCapabilitySchema, pool });
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
  const store = new PgAccountStore({ schemaEnsurer: ensureCapabilitySchema, pool });
  const res = await store.setContactInfo('ghost', '加群码');
  assert.deepEqual(res, { ok: false, reason: 'account_not_found' });
  assert.match(calls[0].text, /UPDATE accounts/);
  assert.doesNotMatch(calls[0].text, /INSERT/);
});

test('setContactInfo: 退役保留账号 default 被拒，绝不落库', async () => {
  const { calls, pool } = fakePoolReturning([{ contact_info: 'x' }]);
  const store = new PgAccountStore({ schemaEnsurer: ensureCapabilitySchema, pool });
  const res = await store.setContactInfo('default', '加群码');
  assert.deepEqual(res, { ok: false, reason: 'retired_account' });
  assert.equal(calls.length, 0);
});

test('getContactInfo: 异步直读 SELECT，回 verbatim 值 / 缺行为 null', async () => {
  const code = '加群🐶\n第二行';
  const { calls, pool } = fakePoolReturning([{ contact_info: code }]);
  const store = new PgAccountStore({ schemaEnsurer: ensureCapabilitySchema, pool });
  const got = await store.getContactInfo('acc-1');
  assert.equal(got, code);
  assert.match(calls[0].text, /SELECT contact_info FROM accounts WHERE account_id = \$1/);

  const { pool: emptyPool } = fakePoolReturning([]);
  const store2 = new PgAccountStore({ schemaEnsurer: ensureCapabilitySchema, pool: emptyPool });
  assert.equal(await store2.getContactInfo('ghost'), null);
});

test('getPlatform: 读取 accounts.platform 并归一，缺行按历史 xhs 默认', async () => {
  const { calls, pool } = fakePoolReturning([{ platform: 'facebook' }]);
  const store = new PgAccountStore({ schemaEnsurer: ensureCapabilitySchema, pool });
  assert.equal(await store.getPlatform('acc-fb'), 'facebook');
  assert.match(calls[0].text, /SELECT platform FROM accounts WHERE account_id = \$1/);

  const { pool: emptyPool } = fakePoolReturning([]);
  const store2 = new PgAccountStore({ schemaEnsurer: ensureCapabilitySchema, pool: emptyPool });
  assert.equal(await store2.getPlatform('missing'), 'xiaohongshu');
});

test('listByPlatform: 按平台枚举账号并保留暂停态', async () => {
  const pausedAt = new Date('2026-07-06T00:00:00Z');
  const { calls, pool } = fakePoolReturning([
    { account_id: 'a1', status: 'active', paused_at: null, platform: 'xiaohongshu' },
    { account_id: 'a2', status: 'paused', paused_at: pausedAt, platform: 'xiaohongshu' },
  ]);
  const store = new PgAccountStore({ schemaEnsurer: ensureCapabilitySchema, pool });
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
  const store = new PgAccountStore({ schemaEnsurer: ensureCapabilitySchema, pool });
  await store.ensureAccount('fb-acc', 'facebook');
  assert.match(calls[0].text, /INSERT INTO accounts[\s\S]*platform[\s\S]*ON CONFLICT \(account_id\) DO NOTHING RETURNING platform/);
  assert.deepEqual(calls[0].params, ['fb-acc', 'facebook']);
  // 缓存已回填 → getPlatform 命中缓存、不再发第二次查询。
  assert.equal(await store.getPlatform('fb-acc'), 'facebook');
  assert.equal(calls.length, 1, 'getPlatform 命中缓存，不应产生额外查询');
});

test('ensureAccount: 缺省平台回落 xiaohongshu（行为不变）', async () => {
  const { calls, pool } = fakePoolReturning([{ platform: 'xiaohongshu' }]);
  const store = new PgAccountStore({ schemaEnsurer: ensureCapabilitySchema, pool });
  await store.ensureAccount('legacy-acc');
  assert.deepEqual(calls[0].params, ['legacy-acc', 'xiaohongshu']);
});

/** 假 pool：按 SQL 形状分别应答（INSERT 与其后的回填 SELECT 要给不同结果）。 */
function fakePoolByQuery(
  responder: (text: string) => unknown[],
): { calls: { text: string; params: unknown[] }[]; pool: pg.Pool } {
  const calls: { text: string; params: unknown[] }[] = [];
  const pool = {
    query: async (text: string, params: unknown[]) => {
      const __probe = schemaProbe(text);
      if (__probe) return __probe;
      calls.push({ text, params });
      const rows = responder(text);
      return { rows, rowCount: rows.length };
    },
  } as unknown as pg.Pool;
  return { calls, pool };
}

const isEnsureInsert = (text: string): boolean =>
  /INSERT INTO accounts \(account_id, label, platform\)/.test(text);

test('ensureAccount: 既有行冲突（RETURNING 空）→ 绝不拿 edge 声明平台覆盖，只补库里真值', async () => {
  // ON CONFLICT DO NOTHING 命中既有行 → RETURNING 空；随后的回填读的是库里的真值。
  // 本次 edge 声明 facebook、库里是 xiaohongshu：缓存 MUST 取库里那个，否则就是原来防的那种污染。
  const { pool } = fakePoolByQuery((text) => (isEnsureInsert(text)
    ? []
    : [{ platform: 'xiaohongshu', created_at: null, label: null, nickname: null, operator_alias: null }]));
  const store = new PgAccountStore({ schemaEnsurer: ensureCapabilitySchema, pool });
  await store.ensureAccount('existing', 'facebook');
  assert.equal(store.platformFor('existing'), 'xiaohongshu', '既有行平台 MUST 以库为准，不被 edge 声明覆盖');
});

test('ensureAccount: 既有行 + 本进程从未见过该账号 → 同步平台口必须能答出来（DEV/OL 共库，行是另一台云端插的）', async () => {
  // 2026-08-04 实测回归：客户端中途从 OL 切到 dev，账号行是 OL 插的、dev 进程 init() 又早于它们出生，
  // DO NOTHING 不回行 ⇒ dev 的 platformCache 永久缺这些账号。platformFor 是同步零 IO 口，缺键即
  // 「平台未知」→ 慢启动判定答「不在爬坡」→ 客户端运行方式回落显示「普通」+ 冷启动配额一档不叠。
  const createdAt = new Date('2026-08-04T04:00:00Z');
  const { pool } = fakePoolByQuery((text) => (isEnsureInsert(text)
    ? []
    : [{ platform: 'facebook', created_at: createdAt, label: null, nickname: null, operator_alias: null }]));
  const store = new PgAccountStore({ schemaEnsurer: ensureCapabilitySchema, pool });
  assert.equal(store.platformFor('cross-cloud'), undefined, '前置：本进程确实没见过它');
  await store.ensureAccount('cross-cloud', 'facebook');
  assert.equal(store.platformFor('cross-cloud'), 'facebook');
  assert.equal(store.createdAtFor('cross-cloud'), createdAt.getTime());
});

test('ensureAccount: 既有行但缓存已齐 → 不再回查库（回填只补缺键）', async () => {
  const createdAt = new Date('2026-08-04T04:00:00Z');
  let insertCount = 0;
  const { calls, pool } = fakePoolByQuery((text) => {
    if (!isEnsureInsert(text)) return [];
    insertCount += 1;
    // 第 1 次视为真插入新行（缓存就此填满），第 2 次视为冲突。
    return insertCount === 1
      ? [{ platform: 'facebook', created_at: createdAt, label: null, nickname: null, operator_alias: null }]
      : [];
  });
  const store = new PgAccountStore({ schemaEnsurer: ensureCapabilitySchema, pool });
  await store.ensureAccount('known', 'facebook');
  assert.equal(calls.length, 1);
  await store.ensureAccount('known', 'facebook');
  assert.equal(calls.length, 2, '第二次只该发出那条 INSERT，不该追加回填 SELECT');
});

// ── change seed-facebook-automation-defaults-on-registration：新账号种入自动化默认配置 ──
//
// 范围铁律：**只对真正首次登记的账号种入，存量一个不碰**（用户 2026-07-29 定）。
// 下面这组用例逐条守住那条铁律的每一个失效方向。

/** 收集种入钩子被调到的次数与入参。 */
function seedSpy() {
  const seen: { accountId: string; platform: string }[] = [];
  return {
    seen,
    hook: (accountId: string, platform: string) => {
      seen.push({ accountId, platform });
    },
  };
}

test('种入: 真的插入了新行才触发钩子，且带归一化后的平台', async () => {
  const spy = seedSpy();
  const { pool } = fakePoolReturning([{ platform: 'facebook' }]);
  const store = new PgAccountStore({
    schemaEnsurer: ensureCapabilitySchema, pool, onAccountRegistered: spy.hook,
  });
  await store.ensureAccount('fb-new', 'facebook');
  assert.deepEqual(spy.seen, [{ accountId: 'fb-new', platform: 'facebook' }]);
});

test('种入: 存量账号防扩散——已存在的行（RETURNING 空）绝不触发钩子', async () => {
  // 这是本 change 最危险的失效方向：若判据被写成「配置侧表没有该账号的行」，
  // 一个早已存在、只是从未被配过的账号同样满足，种入会静默扩散到全部存量账号
  // （dev 实测 40 个 FB 账号里 37 个正处在这个状态），而单账号测试完全看不出来。
  // ON CONFLICT DO NOTHING 命中既有行 → RETURNING 空 → 钩子 MUST NOT 被调到。
  const spy = seedSpy();
  const { pool } = fakePoolReturning([]);
  const store = new PgAccountStore({
    schemaEnsurer: ensureCapabilitySchema, pool, onAccountRegistered: spy.hook,
  });
  await store.ensureAccount('fb-existing', 'facebook');
  assert.deepEqual(spy.seen, [], '既有账号 MUST NOT 被种入');
});

test('种入: 调用方未声明平台 → 不触发钩子（回落值只用于建行，不作为种入依据）', async () => {
  const spy = seedSpy();
  const { pool } = fakePoolReturning([{ platform: 'xiaohongshu' }]);
  const store = new PgAccountStore({
    schemaEnsurer: ensureCapabilitySchema, pool, onAccountRegistered: spy.hook,
  });
  await store.ensureAccount('unknown-platform-acc');
  assert.deepEqual(spy.seen, [], '平台未声明时 MUST NOT 按回落值种入');
});

test('种入: 钩子抛错不外抛、不阻断登记（缓存回填照常完成）', async () => {
  const { pool } = fakePoolReturning([{ platform: 'facebook' }]);
  const store = new PgAccountStore({
    schemaEnsurer: ensureCapabilitySchema,
    pool,
    onAccountRegistered: () => { throw new Error('seed boom'); },
  });
  await store.ensureAccount('fb-seed-fails', 'facebook');
  // 登记本身成功：平台缓存已回填（不必落库即可读到）。
  assert.equal(await store.getPlatform('fb-seed-fails'), 'facebook');
});

test('种入: 退役保留账号既不建行也不触发钩子', async () => {
  const spy = seedSpy();
  const { calls, pool } = fakePoolReturning([{ platform: 'facebook' }]);
  const store = new PgAccountStore({
    schemaEnsurer: ensureCapabilitySchema, pool, onAccountRegistered: spy.hook,
  });
  await store.ensureAccount('default', 'facebook');
  assert.equal(calls.length, 0, '退役保留账号不得建行');
  assert.deepEqual(spy.seen, []);
});

test('种入: 不注入钩子时行为逐字回到本 change 之前（零回归 / 回滚拉杆）', async () => {
  const { calls, pool } = fakePoolReturning([{ platform: 'facebook' }]);
  const store = new PgAccountStore({ schemaEnsurer: ensureCapabilitySchema, pool });
  await store.ensureAccount('fb-no-hook', 'facebook');
  assert.equal(calls.length, 1);
  assert.equal(await store.getPlatform('fb-no-hook'), 'facebook');
});

// ── change environment-level-slow-start：旧列只留迁移/回滚，不再提供账号级运行时读写 ──

test('ACCOUNTS_SCHEMA_SQL 含 slow_start_since 幂等自愈 ALTER（本仓无迁移执行器，dev/OL 那张既有表靠它补列）', () => {
  assert.match(ACCOUNTS_SCHEMA_SQL, /ALTER TABLE accounts ADD COLUMN IF NOT EXISTS slow_start_since TIMESTAMPTZ/);
});

test('PgAccountStore 不再暴露账号级慢启动 writer/provider（旧列不得重新成为运行时事实源）', () => {
  const { pool } = fakePoolReturning([]);
  const store = new PgAccountStore({ schemaEnsurer: ensureCapabilitySchema, pool });
  assert.equal('setSlowStart' in store, false);
  assert.equal('slowStartSinceFor' in store, false);
});

test('platformFor：缺键 → undefined（未知），MUST NOT 回落 xiaohongshu', async () => {
  const { pool } = fakePoolReturning([]);
  const store = new PgAccountStore({ schemaEnsurer: ensureCapabilitySchema, pool });
  // 与 getPlatform 刻意不同：那条归一化缺值为 xiaohongshu，这条服务于冷启动曲线选择——
  // 回落一次就是 FB 号按 XHS 曲线跑（D1 view=50 而非 20）。
  assert.equal(store.platformFor('never-seen'), undefined);
});
