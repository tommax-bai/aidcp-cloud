import { test } from 'node:test';
import assert from 'node:assert/strict';
import type pg from 'pg';
import {
  CuratedContentStore,
  type CuratedObservation,
} from '../../src/cache/curated-content-store.js';

/** 捕获每次 query 的 (sql, params)，可按 sql 返回 canned rows，不依赖真 PG。 */
function capturingPool(rowsFor?: (sql: string) => unknown[]): {
  pool: pg.Pool;
  calls: Array<{ sql: string; params: unknown[] }>;
} {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const pool = {
    query: async (sql: string, params: unknown[]) => {
      calls.push({ sql, params });
      return { rows: rowsFor ? rowsFor(sql) : [] };
    },
  } as unknown as pg.Pool;
  return { pool, calls };
}

const baseObs: CuratedObservation = {
  accountId: 'acc-1',
  contentType: 'note',
  sourceId: 'note-9',
  title: '标题',
  body: '正文内容',
  author: '作者甲',
  sourceUrl: 'https://x/explore/note-9?xsec_token=t',
  topics: ['ai', '编程'],
  likeCount: 12,
  collectCount: 3,
  commentCount: 5,
  admitReason: 'high_quality',
};

test('init 建表幂等（DDL 含 IF NOT EXISTS 与索引）', async () => {
  const { pool, calls } = capturingPool();
  const store = new CuratedContentStore({ pool });
  await store.init();
  assert.equal(calls.length, 1);
  assert.match(calls[0].sql, /CREATE TABLE IF NOT EXISTS curated_content/);
  assert.match(calls[0].sql, /content_type IN \('note','comment'\)/);
  assert.match(calls[0].sql, /dedup_key\s+TEXT NOT NULL UNIQUE/);
  assert.match(calls[0].sql, /CREATE INDEX IF NOT EXISTS .* USING GIN\(topics\)/);
  assert.match(calls[0].sql, /CREATE INDEX IF NOT EXISTS .*\(account_id, updated_at DESC\)/);
});

test('upsertObservation：INSERT...ON CONFLICT DO UPDATE，含 dedup_key、不抹 bot 标记、保留 first_seen_at', async () => {
  const { pool, calls } = capturingPool();
  const store = new CuratedContentStore({ pool });
  await store.upsertObservation(baseObs);

  // 第一条是 upsert，第二条是保留上限裁剪。
  assert.equal(calls.length, 2);
  const sql = calls[0].sql;
  assert.match(sql, /INSERT INTO curated_content/);
  assert.match(sql, /ON CONFLICT \(dedup_key\) DO UPDATE/);
  // DO UPDATE 刷新这些列。
  assert.match(sql, /counts_captured_at = now\(\)/);
  assert.match(sql, /admit_reason\s+= EXCLUDED\.admit_reason/);
  assert.match(sql, /updated_at\s+= now\(\)/);
  // 绝不在 DO UPDATE 里触碰 bot_liked / bot_collected（不抹掉已置的自有动作标记）。
  assert.doesNotMatch(sql, /bot_liked\s*=/);
  assert.doesNotMatch(sql, /bot_collected\s*=/);
  // 绝不刷新 first_seen_at（保留首次时间）。
  assert.doesNotMatch(sql, /first_seen_at\s*=/);

  // dedup_key = accountId::contentType::sourceId。
  const params = calls[0].params;
  assert.equal(params[0], 'acc-1');
  assert.equal(params[1], 'note');
  assert.equal(params[2], 'note-9');
  assert.equal(params[3], 'acc-1::note::note-9');
  // 计数原样落库。
  assert.deepEqual(params.slice(9, 12), [12, 3, 5]);
  assert.equal(params[12], 'high_quality');
});

test('upsertObservation：缺失可选字段诚实置空（null），不编造', async () => {
  const { pool, calls } = capturingPool();
  const store = new CuratedContentStore({ pool });
  await store.upsertObservation({
    accountId: 'acc-1',
    contentType: 'comment',
    sourceId: 'c-1',
    body: '一条评论',
    topics: [],
    admitReason: 'ok',
  });
  const params = calls[0].params;
  assert.equal(params[4], null); // title
  assert.equal(params[5], '一条评论'); // body
  assert.equal(params[6], null); // author
  assert.equal(params[7], null); // source_url
  assert.deepEqual(params[8], []); // topics
  assert.equal(params[9], null); // like_count
  assert.equal(params[10], null); // collect_count
  assert.equal(params[11], null); // comment_count
});

test('upsertObservation 之后按账号裁到保留上限（DELETE 带 account_id 且 NOT IN newest LIMIT）', async () => {
  const { pool, calls } = capturingPool();
  const store = new CuratedContentStore({ pool, retentionMax: 500 });
  await store.upsertObservation(baseObs);
  const del = calls[1];
  assert.match(del.sql, /DELETE FROM curated_content/);
  assert.match(del.sql, /WHERE account_id = \$1/);
  assert.match(del.sql, /id NOT IN \(/);
  assert.match(del.sql, /ORDER BY updated_at DESC/);
  // 按账号裁、不跨账号。
  assert.equal(del.params[0], 'acc-1');
  assert.equal(del.params[1], 500);
});

test('markBotAction like 走 UPDATE（不 INSERT），行不存在则 no-op，不自动建行', async () => {
  const { pool, calls } = capturingPool();
  const store = new CuratedContentStore({ pool });
  await store.markBotAction('acc-1', 'note-9', 'like');
  assert.equal(calls.length, 1);
  assert.match(calls[0].sql, /^\s*UPDATE curated_content SET bot_liked = true/);
  assert.doesNotMatch(calls[0].sql, /INSERT/);
  // 按 dedup_key 命中既有行（note/comment 任一）。
  assert.ok(calls[0].params.includes('acc-1::note::note-9'));
});

test('markBotAction collect 走 INSERT...ON CONFLICT（自有收藏自动建/纳入）', async () => {
  const { pool, calls } = capturingPool();
  const store = new CuratedContentStore({ pool });
  await store.markBotAction('acc-1', 'note-9', 'collect', {
    title: 'T',
    body: '收藏的正文',
    author: 'A',
    sourceUrl: 'u',
    topics: ['x'],
  });
  assert.equal(calls.length, 1);
  const sql = calls[0].sql;
  assert.match(sql, /INSERT INTO curated_content/);
  assert.match(sql, /ON CONFLICT \(dedup_key\) DO UPDATE SET bot_collected = true/);
  const params = calls[0].params;
  assert.equal(params[0], 'acc-1');
  assert.equal(params[1], 'note-9');
  assert.equal(params[2], 'acc-1::note::note-9'); // dedup_key 用 note 类型
  assert.equal(params[3], 'T'); // title
  assert.equal(params[4], '收藏的正文'); // body
  assert.equal(params[5], 'A'); // author
  assert.equal(params[6], 'u'); // source_url
  assert.deepEqual(params[7], ['x']); // topics
  assert.equal(params[8], 'bot_collect'); // admit_reason（有正文）
});

test('markBotAction collect 无内容：body 落 ""、admit_reason 标 content_missing（不编造正文）', async () => {
  const { pool, calls } = capturingPool();
  const store = new CuratedContentStore({ pool });
  await store.markBotAction('acc-1', 'note-9', 'collect');
  const params = calls[0].params;
  assert.equal(params[3], null); // title
  assert.equal(params[4], ''); // body 空串、不编造
  assert.equal(params[5], null); // author
  assert.equal(params[6], null); // source_url
  assert.deepEqual(params[7], []); // topics 空数组
  assert.equal(params[8], 'bot_collect(content_missing)'); // admit_reason 标注缺内容
});

test('selectForCreation：ORDER BY 含 bot_collected/bot_liked 权重，按账号+类型过滤，映射成 CuratedSelectItem', async () => {
  const cannedRows = [
    {
      source_id: 'note-1',
      content_type: 'note',
      title: 'T1',
      body: 'B1',
      author: '甲',
      topics: ['a'],
      like_count: 10,
      collect_count: 4,
      bot_liked: true,
      bot_collected: true,
    },
    {
      source_id: 'note-2',
      content_type: 'note',
      title: null,
      body: null,
      author: null,
      topics: null,
      like_count: null,
      collect_count: null,
      bot_liked: false,
      bot_collected: false,
    },
  ];
  const { pool, calls } = capturingPool((sql) => (/SELECT/.test(sql) ? cannedRows : []));
  const store = new CuratedContentStore({ pool });
  const out = await store.selectForCreation('acc-1', 'note', 7);

  const sql = calls[0].sql;
  assert.match(sql, /WHERE account_id = \$1 AND content_type = \$2/);
  assert.match(sql, /CASE WHEN bot_collected THEN 2 ELSE 0 END/);
  assert.match(sql, /CASE WHEN bot_liked THEN 1 ELSE 0 END/);
  assert.match(sql, /collect_count DESC NULLS LAST/);
  assert.match(sql, /updated_at DESC/);
  assert.deepEqual(calls[0].params, ['acc-1', 'note', 7]);

  // 映射：实值行。
  assert.deepEqual(out[0], {
    sourceId: 'note-1',
    contentType: 'note',
    title: 'T1',
    body: 'B1',
    author: '甲',
    topics: ['a'],
    likeCount: 10,
    collectCount: 4,
    botLiked: true,
    botCollected: true,
  });
  // 映射：空值行——诚实置空（null/'' /undefined/[]），count 不编造 0。
  assert.deepEqual(out[1], {
    sourceId: 'note-2',
    contentType: 'note',
    title: '',
    body: '',
    author: undefined,
    topics: [],
    likeCount: null,
    collectCount: null,
    botLiked: false,
    botCollected: false,
  });
});
