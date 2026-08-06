import { test } from 'node:test';
import { ensureCapabilitySchema } from '@automation/schema/schema-capability.js';
import assert from 'node:assert/strict';
import pg from 'pg';
import { NotificationContactStore, notificationDedupKey } from '@api/cache/notification-contact-store.js';
import type { NotificationItem } from '@automation/comm/protocol.js';

/**
 * change notification-contact-registry：去重键（红线：同人不同评论不撞键丢失）+ appendEvents 写入逻辑
 * （无需真实 PG，注入桩池记录 SQL/params）。
 */

interface Recorded {
  inserts: { sql: string; params: unknown[] }[];
  deletes: { sql: string; params: unknown[] }[];
  selects: { sql: string; params: unknown[] }[];
}
function fakePool(opts: { listError?: { code: string }; listRows?: Record<string, unknown>[] } = {}) {
  const rec: Recorded = { inserts: [], deletes: [], selects: [] };
  const pool = {
    query: async (sql: string, params?: unknown[]) => {
      if (sql.includes('INSERT INTO notification_event')) rec.inserts.push({ sql, params: params ?? [] });
      else if (sql.includes('DELETE FROM notification_event')) rec.deletes.push({ sql, params: params ?? [] });
      else if (sql.includes('FROM notification_event e')) {
        rec.selects.push({ sql, params: params ?? [] });
        if (opts.listError) throw opts.listError;
        return { rows: opts.listRows ?? [], rowCount: opts.listRows?.length ?? 0 };
      }
      return { rows: [], rowCount: 0 };
    },
  } as unknown as pg.Pool;
  return { pool, rec };
}

const mk = (o: Partial<NotificationItem> & { kind: NotificationItem['kind'] }): NotificationItem => ({
  fromUser: '',
  content: '',
  ...o,
});

// ── 去重键（纯函数，红线核心）─────────────────────────────────────────────
test('去重键：同人同篇两条不同评论 → 两个不同键（红线：绝不撞键丢失）', () => {
  const a = notificationDedupKey(mk({ kind: 'comment', fromUserId: 'u_1', itemKey: 'note-9', content: '第一条' }));
  const b = notificationDedupKey(mk({ kind: 'comment', fromUserId: 'u_1', itemKey: 'note-9', content: '第二条' }));
  assert.notEqual(a, b, '同人同篇不同内容必须键不同，否则第二条会被 ON CONFLICT 丢掉');
});

test('去重键：同一条评论重扫 → 同键（幂等折叠）', () => {
  const a = notificationDedupKey(mk({ kind: 'comment', fromUserId: 'u_1', itemKey: 'note-9', content: '同一条' }));
  const b = notificationDedupKey(mk({ kind: 'comment', fromUserId: 'u_1', itemKey: 'note-9', content: '同一条' }));
  assert.equal(a, b);
});

test('去重键：同一人点赞 50 篇 → 50 个不同键（聚合后 1 联系人 count=50）', () => {
  const keys = new Set<string>();
  for (let i = 0; i < 50; i++) keys.add(notificationDedupKey(mk({ kind: 'like', fromUserId: 'u_2', itemKey: `note-${i}` })));
  assert.equal(keys.size, 50);
});

test('去重键：关注按人唯一（同人多次扫到关注 → 同键）', () => {
  const a = notificationDedupKey(mk({ kind: 'follow', fromUserId: 'u_3' }));
  const b = notificationDedupKey(mk({ kind: 'follow', fromUserId: 'u_3', fromUser: '改了昵称' }));
  assert.equal(a, b, '关注键只认身份，不随昵称变');
});

test('去重键：赞与收藏同篇同人 → 不同键（kind 区分）', () => {
  const like = notificationDedupKey(mk({ kind: 'like', fromUserId: 'u_4', itemKey: 'note-1' }));
  const collect = notificationDedupKey(mk({ kind: 'collect', fromUserId: 'u_4', itemKey: 'note-1' }));
  assert.notEqual(like, collect);
});

test('去重键：缺主页ID退回昵称', () => {
  const a = notificationDedupKey(mk({ kind: 'follow', fromUser: '小明' }));
  const b = notificationDedupKey(mk({ kind: 'follow', fromUser: '小明' }));
  assert.equal(a, b);
  assert.ok(a.includes('小明'));
});

// ── appendEvents 写入 ─────────────────────────────────────────────────────
test('appendEvents：构造 ON CONFLICT DO NOTHING + 按账号删旧（留存上限）', async () => {
  const { pool, rec } = fakePool();
  const store = new NotificationContactStore({ schemaEnsurer: ensureCapabilitySchema, pool, retentionMax: 5000 });
  await store.appendEvents('acct-1', [mk({ kind: 'comment', fromUserId: 'u_1', content: 'hi', itemKey: 'n1' })]);
  assert.equal(rec.inserts.length, 1);
  assert.ok(rec.inserts[0].sql.includes('ON CONFLICT (account_id, dedup_key) DO NOTHING'));
  assert.equal(rec.inserts[0].params[0], 'acct-1');
  assert.equal(rec.deletes.length, 1, '写后按账号裁留存上限');
  assert.deepEqual(rec.deletes[0].params, ['acct-1', 5000]);
});

test('appendEvents：空昵称/空内容/无锚点的结构异常行丢弃（不记空联系人）', async () => {
  const { pool, rec } = fakePool();
  const store = new NotificationContactStore({ schemaEnsurer: ensureCapabilitySchema, pool });
  await store.appendEvents('acct-1', [mk({ kind: 'comment', fromUser: '  ', content: '  ' })]);
  assert.equal(rec.inserts.length, 0, '无身份无内容无锚点 → 不插入');
});

test('appendEvents：空字符串昵称/主页ID 归一为 NULL', async () => {
  const { pool, rec } = fakePool();
  const store = new NotificationContactStore({ schemaEnsurer: ensureCapabilitySchema, pool });
  await store.appendEvents('acct-1', [mk({ kind: 'like', fromUser: '点赞的人', fromUserId: '   ', itemKey: 'n1' })]);
  // params: [accountId, dedupKey, reason, fromUser, fromUserId, content, noteTitle]
  const p = rec.inserts[0].params;
  assert.equal(p[4], null, '空白 fromUserId → null');
  assert.equal(p[3], '点赞的人');
});

test('appendEvents：同批次重复键去重（避免单语句自冲突）', async () => {
  const { pool, rec } = fakePool();
  const store = new NotificationContactStore({ schemaEnsurer: ensureCapabilitySchema, pool });
  const dup = mk({ kind: 'follow', fromUserId: 'u_9' });
  await store.appendEvents('acct-1', [dup, { ...dup }]);
  // 一个 INSERT，params = [accountId] + 一组 6 个（去重后 1 行）
  assert.equal(rec.inserts.length, 1);
  assert.equal(rec.inserts[0].params.length, 1 + 6, '同批次重复键折叠为一行');
});

test('appendEvents：空 items / 空 accountId 不发查询', async () => {
  const { pool, rec } = fakePool();
  const store = new NotificationContactStore({ schemaEnsurer: ensureCapabilitySchema, pool });
  await store.appendEvents('acct-1', []);
  await store.appendEvents('', [mk({ kind: 'follow', fromUserId: 'u_1' })]);
  assert.equal(rec.inserts.length, 0);
});

// ── listContacts 缺表回落 ─────────────────────────────────────────────────
test('listContacts：缺表（42P01）回落空，不抛', async () => {
  const { pool } = fakePool({ listError: { code: '42P01' } });
  const store = new NotificationContactStore({ schemaEnsurer: ensureCapabilitySchema, pool });
  const out = await store.listContacts('acct-1');
  assert.deepEqual(out, []);
});

test('listContacts：缺 accountId（全账号视图）不加 account_id 过滤、按账号分组、每行带 accountId', async () => {
  const { pool, rec } = fakePool({
    listRows: [
      {
        account_id: 'acct-9',
        sender_key: 'u_1',
        nickname: '小白',
        user_id: 'u_1',
        first_reason: 'comment',
        reasons: ['comment'],
        first_seen: new Date(1000),
        last_seen: new Date(2000),
        event_count: '3',
        wechat: null,
        note: null,
        tags: [],
        updated_by: null,
        updated_at: null,
      },
    ],
  });
  const store = new NotificationContactStore({ schemaEnsurer: ensureCapabilitySchema, pool });
  const out = await store.listContacts(undefined);
  // 全账号：SELECT 不带 WHERE e.account_id 过滤，仅 LIMIT/OFFSET 两个参数（占位 $1/$2）
  assert.equal(rec.selects.length, 1);
  assert.doesNotMatch(rec.selects[0].sql, /WHERE e\.account_id/);
  assert.match(rec.selects[0].sql, /GROUP BY e\.account_id/);
  assert.match(rec.selects[0].sql, /LIMIT \$1 OFFSET \$2/);
  assert.deepEqual(rec.selects[0].params, [200, 0]);
  // 每行带归属账号（供全账号视图区分 + 写入路由）
  assert.equal(out[0].accountId, 'acct-9');
  assert.equal(out[0].senderKey, 'u_1');
});

test('listContacts：给定 accountId → 加 WHERE e.account_id 过滤', async () => {
  const { pool, rec } = fakePool();
  const store = new NotificationContactStore({ schemaEnsurer: ensureCapabilitySchema, pool });
  await store.listContacts('acct-1');
  assert.match(rec.selects[0].sql, /WHERE e\.account_id = \$1/);
  assert.match(rec.selects[0].sql, /LIMIT \$2 OFFSET \$3/);
  assert.deepEqual(rec.selects[0].params, ['acct-1', 200, 0]);
});

// ── setManual 只动侧表 ────────────────────────────────────────────────────
test('setManual：upsert 人工字段（标签数组 + 审计），SQL 命中 contact_meta', async () => {
  const captured: { sql: string; params: unknown[] }[] = [];
  const pool = {
    query: async (sql: string, params?: unknown[]) => {
      captured.push({ sql, params: params ?? [] });
      return { rows: [], rowCount: 0 };
    },
  } as unknown as pg.Pool;
  const store = new NotificationContactStore({ schemaEnsurer: ensureCapabilitySchema, pool });
  await store.setManual('acct-1', 'u_1', { wechat: 'wx123', note: '客户', tags: ['潜客', '潜客', ' '] }, 'admin');
  const ins = captured.find((c) => c.sql.includes('notification_contact_meta'));
  assert.ok(ins, '应 upsert notification_contact_meta');
  assert.ok(ins!.sql.includes('ON CONFLICT (account_id, sender_key)'));
  assert.equal(ins!.params[0], 'acct-1');
  assert.equal(ins!.params[1], 'u_1');
  assert.equal(ins!.params[2], 'wx123');
  assert.equal(ins!.params[5], 'admin', 'updated_by = 审计');
  // tags 去空白后保留（去重在 panel 层 + 这里至少不崩）；断言为数组
  assert.ok(Array.isArray(ins!.params[4]));
});
