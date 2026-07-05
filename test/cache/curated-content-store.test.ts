import { test } from 'node:test';
import assert from 'node:assert/strict';
import type pg from 'pg';
import {
  CuratedContentStore,
  normalizeCuratedReferenceImages,
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
  contentType: 'image_text',
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
  assert.match(calls[0].sql, /content_type IN \('image_text','video','comment'\)/);
  assert.match(calls[0].sql, /ADD COLUMN IF NOT EXISTS reference_images JSONB/);
  assert.match(calls[0].sql, /content_type = 'image_text'/);
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
  assert.equal(params[1], 'image_text');
  assert.equal(params[2], 'note-9');
  assert.equal(params[3], 'acc-1::image_text::note-9');
  // 计数原样落库。
  assert.deepEqual(params.slice(10, 13), [12, 3, 5]);
  assert.equal(params[13], 'high_quality');
});

test('reference images are normalized, deduped, relocated, and stored as JSONB', async () => {
  const { pool, calls } = capturingPool();
  const relocatedInputs: unknown[] = [];
  const store = new CuratedContentStore({
    pool,
    referenceImageLimit: 2,
    referenceImageRelocator: async ({ images }) => {
      relocatedInputs.push(images);
      return images.map((img) => ({
        ...img,
        ossUrl: `https://oss.test/ref-${img.index}.jpg`,
        captureStatus: 'stored' as const,
        capturedAt: 123,
      }));
    },
  });

  await store.upsertObservation({
    ...baseObs,
    referenceImages: [
      { index: 9, sourceUrl: 'https://img.test/a.jpg', width: 640, height: 480, alt: 'cover' },
      { index: 1, sourceUrl: 'https://img.test/a.jpg' },
      { index: 2, sourceUrl: 'https://img.test/b.jpg' },
      { index: 3, sourceUrl: 'data:image/png;base64,xx' },
    ],
  });

  assert.equal(relocatedInputs.length, 1);
  assert.deepEqual(
    (relocatedInputs[0] as Array<{ sourceUrl: string }>).map((img) => img.sourceUrl),
    ['https://img.test/a.jpg', 'https://img.test/b.jpg'],
  );
  const stored = JSON.parse(calls[0].params[9] as string) as ReturnType<typeof normalizeCuratedReferenceImages>;
  assert.deepEqual(
    stored.map((img) => ({ index: img.index, sourceUrl: img.sourceUrl, ossUrl: img.ossUrl, captureStatus: img.captureStatus, capturedAt: img.capturedAt })),
    [
      { index: 9, sourceUrl: 'https://img.test/a.jpg', ossUrl: 'https://oss.test/ref-9.jpg', captureStatus: 'stored', capturedAt: 123 },
      { index: 2, sourceUrl: 'https://img.test/b.jpg', ossUrl: 'https://oss.test/ref-2.jpg', captureStatus: 'stored', capturedAt: 123 },
    ],
  );
  assert.equal(stored[0].width, 640);
  assert.equal(stored[0].height, 480);
  assert.equal(stored[0].alt, 'cover');
});

test('normalizeCuratedReferenceImages drops invalid URLs and caps at the configured limit', () => {
  const normalized = normalizeCuratedReferenceImages(
    [
      { sourceUrl: 'ftp://img.test/a.jpg' },
      { sourceUrl: 'https://img.test/a.jpg' },
      { sourceUrl: 'https://img.test/a.jpg' },
      { sourceUrl: 'https://img.test/b.jpg' },
    ],
    { now: 99, limit: 1 },
  );
  assert.deepEqual(normalized, [
    { index: 0, sourceUrl: 'https://img.test/a.jpg', captureStatus: 'url_only', capturedAt: 99 },
  ]);
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
  assert.equal(params[9], '[]'); // reference_images
  assert.equal(params[10], null); // like_count
  assert.equal(params[11], null); // collect_count
  assert.equal(params[12], null); // comment_count
});

test('upsertObservation：正文为空则不写入精选素材', async () => {
  const { pool, calls } = capturingPool();
  const store = new CuratedContentStore({ pool });
  await store.upsertObservation({ ...baseObs, body: '   ' });
  assert.equal(calls.length, 0);
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
  // 按账号+sourceId 命中既有源帖行（image_text/video 任一），不自动建行。
  assert.match(calls[0].sql, /content_type IN \('image_text', 'video'\)/);
  assert.deepEqual(calls[0].params, ['acc-1', 'note-9']);
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
  assert.match(sql, /ON CONFLICT \(dedup_key\) DO UPDATE SET\s+bot_collected = true/);
  const params = calls[0].params;
  assert.equal(params[0], 'acc-1');
  assert.equal(params[1], 'image_text');
  assert.equal(params[2], 'note-9');
  assert.equal(params[3], 'acc-1::image_text::note-9'); // dedup_key 用媒体类型
  assert.equal(params[4], 'T'); // title
  assert.equal(params[5], '收藏的正文'); // body
  assert.equal(params[6], 'A'); // author
  assert.equal(params[7], 'u'); // source_url
  assert.deepEqual(params[8], ['x']); // topics
  assert.equal(params[9], '[]'); // reference_images
  assert.equal(params[10], 'bot_collect'); // admit_reason（有正文）
});

test('markBotAction collect 视频内容：content_type/dedup_key 用 video', async () => {
  const { pool, calls } = capturingPool();
  const store = new CuratedContentStore({ pool });
  await store.markBotAction('acc-1', 'note-v', 'collect', {
    title: 'V',
    body: '视频文案',
    mediaType: 'video',
  });
  const params = calls[0].params;
  assert.equal(params[1], 'video');
  assert.equal(params[3], 'acc-1::video::note-v');
});

test('markBotAction collect 无正文：只补标记既有源帖行，不补建空正文壳行', async () => {
  const { pool, calls } = capturingPool();
  const store = new CuratedContentStore({ pool });
  await store.markBotAction('acc-1', 'note-9', 'collect');
  assert.equal(calls.length, 1);
  assert.match(calls[0].sql, /^\s*UPDATE curated_content SET bot_collected = true/);
  assert.doesNotMatch(calls[0].sql, /INSERT/);
  assert.match(calls[0].sql, /content_type IN \('image_text', 'video'\)/);
  assert.deepEqual(calls[0].params, ['acc-1', 'note-9']);
});

test('markBotAction collect 空白正文：按缺正文处理，不补建精选壳行', async () => {
  const { pool, calls } = capturingPool();
  const store = new CuratedContentStore({ pool });
  await store.markBotAction('acc-1', 'note-9', 'collect', { title: 'T', body: '   ', mediaType: 'video' });
  assert.equal(calls.length, 1);
  assert.match(calls[0].sql, /^\s*UPDATE curated_content SET bot_collected = true/);
  assert.doesNotMatch(calls[0].sql, /INSERT/);
  assert.deepEqual(calls[0].params, ['acc-1', 'note-9']);
});

test('selectForCreation：ORDER BY 含 bot_collected/bot_liked 权重，按账号+类型过滤，映射成 CuratedSelectItem', async () => {
  const cannedRows = [
    {
      source_id: 'note-1',
      content_type: 'image_text',
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
      content_type: 'video',
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
  const out = await store.selectForCreation('acc-1', 'source_post', 7);

  const sql = calls[0].sql;
  assert.match(sql, /WHERE account_id = \$1 AND content_type IN \('image_text', 'video'\)/);
  assert.match(sql, /CASE WHEN bot_collected THEN 2 ELSE 0 END/);
  assert.match(sql, /CASE WHEN bot_liked THEN 1 ELSE 0 END/);
  assert.match(sql, /collect_count DESC NULLS LAST/);
  assert.match(sql, /updated_at DESC/);
  assert.deepEqual(calls[0].params, ['acc-1', 7]);

  // 映射：实值行。
  assert.deepEqual(out[0], {
    sourceId: 'note-1',
    contentType: 'image_text',
    title: 'T1',
    body: 'B1',
    author: '甲',
    topics: ['a'],
    likeCount: 10,
    collectCount: 4,
    botLiked: true,
    botCollected: true,
    referenceImages: [],
  });
  // 映射：空值行——诚实置空（null/'' /undefined/[]），count 不编造 0。
  assert.deepEqual(out[1], {
    sourceId: 'note-2',
    contentType: 'video',
    title: '',
    body: '',
    author: undefined,
    topics: [],
    likeCount: null,
    collectCount: null,
    botLiked: false,
    botCollected: false,
    referenceImages: [],
  });
});

test('archiveComment 落 content_type=comment + bot_liked=true + ON CONFLICT DO NOTHING（Phase 2）', async () => {
  const { pool, calls } = capturingPool();
  const store = new CuratedContentStore({ pool });
  await store.archiveComment('acc-1', {
    sourceId: 'comment-9',
    text: '很有用的评论',
    author: '老王',
    topics: ['露营'],
    sourceNoteTitle: '湖边露营',
    reason: 'insightful',
    likeCount: 88,
  });
  // 第一条 INSERT，第二条 trimToRetention DELETE。
  assert.ok(calls.length >= 1);
  const ins = calls[0];
  assert.match(ins.sql, /INSERT INTO curated_content/);
  assert.match(ins.sql, /'comment'/);
  assert.match(ins.sql, /bot_liked/);
  assert.match(ins.sql, /ON CONFLICT \(dedup_key\) DO NOTHING/);
  assert.equal(ins.params[2], 'acc-1::comment::comment-9'); // dedup_key
  assert.equal(ins.params[3], '湖边露营'); // title = 来源笔记标题
  assert.equal(ins.params[4], '很有用的评论'); // body = 评论正文
  assert.equal(ins.params[7], 88); // like_count（Phase 2b：评论赞数）
  assert.equal(ins.params[8], 'confirmed_like:insightful'); // admit_reason
  // trimToRetention 按账号
  assert.ok(calls.some((c) => /DELETE FROM curated_content/.test(c.sql)));
});

test('archiveComment 无 reason/无 likeCount → admit_reason=confirmed_like、like_count=null（诚实置空）', async () => {
  const { pool, calls } = capturingPool();
  const store = new CuratedContentStore({ pool });
  await store.archiveComment('acc-2', { sourceId: 'comment-2', text: 't', topics: [] });
  assert.equal(calls[0].params[7], null); // like_count 抓不到 → null，不编造
  assert.equal(calls[0].params[8], 'confirmed_like');
});

// ── 后台管理（change curated-content-admin-page）─────────────────────────────────

/** 可控返回 rows/rowCount、可抛错的 pool（面板读写方法用）。 */
function controllablePool(handler: (sql: string, params: unknown[]) => { rows?: unknown[]; rowCount?: number }): {
  pool: pg.Pool;
  calls: Array<{ sql: string; params: unknown[] }>;
} {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const pool = {
    query: async (sql: string, params: unknown[]) => {
      calls.push({ sql, params });
      const r = handler(sql, params);
      return { rows: r.rows ?? [], rowCount: r.rowCount };
    },
  } as unknown as pg.Pool;
  return { pool, calls };
}

const panelDbRow = {
  id: 7,
  account_id: 'acc-1',
  content_type: 'image_text',
  source_id: 'n-1',
  title: 'T',
  body: 'B',
  author: '甲',
  source_url: 'u',
  topics: ['x'],
  like_count: 10,
  collect_count: 4,
  comment_count: 2,
  counts_captured_at: new Date(1000),
  bot_liked: true,
  bot_collected: false,
  admit_reason: 'collect_floor',
  first_seen_at: new Date(2000),
  updated_at: new Date(3000),
  total_count: '1',
  reference_images: [],
};

test('listForPanel：按账号 + 类型 + 原因过滤，COUNT(*) OVER() 取 total，映射 epoch ms + 诚实置空', async () => {
  const { pool, calls } = controllablePool(() => ({ rows: [panelDbRow] }));
  const store = new CuratedContentStore({ pool });
  const out = await store.listForPanel('acc-1', { contentType: 'image_text', admitReason: 'collect_floor', limit: 50, offset: 0 });

  const sql = calls[0].sql;
  assert.match(sql, /WHERE account_id = \$1/);
  assert.match(sql, /content_type = \$2/);
  assert.match(sql, /admit_reason = \$3/);
  assert.match(sql, /COUNT\(\*\) OVER\(\) AS total_count/);
  assert.match(sql, /ORDER BY updated_at DESC/);
  assert.match(sql, /LIMIT \$4 OFFSET \$5/);
  assert.deepEqual(calls[0].params, ['acc-1', 'image_text', 'collect_floor', 50, 0]);

  assert.equal(out.total, 1);
  assert.equal(out.items[0].id, 7);
  assert.equal(out.items[0].countsCapturedAt, 1000); // Date → epoch ms
  assert.equal(out.items[0].firstSeenAt, 2000);
  assert.equal(out.items[0].updatedAt, 3000);
  assert.equal(out.items[0].likeCount, 10);
  assert.equal(out.items[0].commentCount, 2);
  assert.equal(out.items[0].botLiked, true);
  assert.equal(out.items[0].botCollected, false);
});

test('listForPanel：无筛选时仅按账号；空结果 total 兜底 0', async () => {
  const { pool, calls } = controllablePool(() => ({ rows: [] }));
  const store = new CuratedContentStore({ pool });
  const out = await store.listForPanel('acc-1', { limit: 20, offset: 40 });
  assert.doesNotMatch(calls[0].sql, /content_type = \$/);
  assert.doesNotMatch(calls[0].sql, /admit_reason = \$/);
  assert.deepEqual(calls[0].params, ['acc-1', 20, 40]); // 仅 account + limit + offset
  assert.deepEqual(out, { items: [], total: 0 });
});

test('listForPanel：缺 accountId（全账号视图）不加 account_id 过滤，仍可叠类型过滤', async () => {
  const { pool, calls } = controllablePool(() => ({ rows: [panelDbRow] }));
  const store = new CuratedContentStore({ pool });
  const out = await store.listForPanel(undefined, { contentType: 'note', limit: 50, offset: 0 });
  assert.doesNotMatch(calls[0].sql, /account_id = \$/);
  assert.match(calls[0].sql, /WHERE content_type IN \('image_text', 'video'\)/);
  assert.match(calls[0].sql, /LIMIT \$1 OFFSET \$2/);
  assert.deepEqual(calls[0].params, [50, 0]); // 无 account；旧 note 别名不占参数位
  assert.equal(out.total, 1);
  assert.equal(out.items[0].accountId, 'acc-1'); // 每行带归属账号
});

test('listForPanel：缺 accountId 且无筛选 → 全表（无 WHERE）', async () => {
  const { pool, calls } = controllablePool(() => ({ rows: [] }));
  const store = new CuratedContentStore({ pool });
  const out = await store.listForPanel(undefined, { limit: 20, offset: 0 });
  assert.doesNotMatch(calls[0].sql, /WHERE/);
  assert.deepEqual(calls[0].params, [20, 0]);
  assert.deepEqual(out, { items: [], total: 0 });
});

test('facetsForPanel：缺 accountId（全账号视图）不加 account_id 过滤', async () => {
  const { pool, calls } = controllablePool((sql) => {
    if (/GROUP BY admit_reason/.test(sql)) return { rows: [{ admit_reason: 'collect_floor', count: '9', bot_action_count: '4' }] };
    return { rows: [{ content_type: 'image_text', count: '5' }, { content_type: 'video', count: '2' }, { content_type: 'comment', count: '2' }] };
  });
  const store = new CuratedContentStore({ pool });
  const out = await store.facetsForPanel(undefined);
  assert.ok(calls.every((c) => !/account_id = \$/.test(c.sql))); // 两查询都不按账号
  assert.ok(calls.every((c) => c.params.length === 0));
  assert.equal(out.imageTextCount, 5);
  assert.equal(out.videoCount, 2);
  assert.equal(out.noteCount, 7);
  assert.equal(out.commentCount, 2);
  assert.deepEqual(out.admitReasons[0], { admitReason: 'collect_floor', count: 9, botActionCount: 4 });
});

test('listForPanel：缺表 42P01 → 优雅降级 {items:[],total:0}', async () => {
  const { pool } = controllablePool(() => {
    const err = new Error('relation does not exist') as Error & { code: string };
    err.code = '42P01';
    throw err;
  });
  const store = new CuratedContentStore({ pool });
  const out = await store.listForPanel('acc-1', { limit: 10, offset: 0 });
  assert.deepEqual(out, { items: [], total: 0 });
});

test('facetsForPanel：纳入原因去重+计数+高权重行数 与 笔记/评论计数，均按账号', async () => {
  const { pool, calls } = controllablePool((sql) => {
    if (/GROUP BY admit_reason/.test(sql)) {
      return {
        rows: [
          { admit_reason: 'collect_floor', count: '3', bot_action_count: '1' },
          { admit_reason: 'bot_collect(content_missing)', count: '2', bot_action_count: '2' },
        ],
      };
    }
    return { rows: [{ content_type: 'image_text', count: '3' }, { content_type: 'video', count: '1' }, { content_type: 'comment', count: '1' }] };
  });
  const store = new CuratedContentStore({ pool });
  const out = await store.facetsForPanel('acc-1');
  assert.ok(calls.every((c) => c.params[0] === 'acc-1')); // 两查询都按账号
  assert.equal(out.imageTextCount, 3);
  assert.equal(out.videoCount, 1);
  assert.equal(out.noteCount, 4);
  assert.equal(out.commentCount, 1);
  assert.deepEqual(out.admitReasons[0], { admitReason: 'collect_floor', count: 3, botActionCount: 1 });
  assert.deepEqual(out.admitReasons[1], { admitReason: 'bot_collect(content_missing)', count: 2, botActionCount: 2 });
});

test('deleteOne：account_id 进 WHERE 防越权，回真实删除行数', async () => {
  const { pool, calls } = controllablePool(() => ({ rowCount: 1 }));
  const store = new CuratedContentStore({ pool });
  const n = await store.deleteOne('acc-1', 7);
  assert.match(calls[0].sql, /DELETE FROM curated_content WHERE id = \$1 AND account_id = \$2/);
  assert.deepEqual(calls[0].params, [7, 'acc-1']);
  assert.equal(n, 1);
});

test('deleteOne：凭别账号 id 删 → rowCount 0（越权被隔离），诚实回 0', async () => {
  const { pool } = controllablePool(() => ({ rowCount: 0 }));
  const store = new CuratedContentStore({ pool });
  assert.equal(await store.deleteOne('acc-1', 999), 0);
});

test('clearEmptyBody：按账号删空正文壳行（body IS NULL OR body=\'\'），回真实条数', async () => {
  const { pool, calls } = controllablePool(() => ({ rowCount: 5 }));
  const store = new CuratedContentStore({ pool });
  const n = await store.clearEmptyBody('acc-1');
  assert.match(calls[0].sql, /DELETE FROM curated_content WHERE account_id = \$1 AND \(body IS NULL OR body = ''\)/);
  assert.deepEqual(calls[0].params, ['acc-1']);
  assert.equal(n, 5);
});

// ── getOneForAccount（change curated-note-actions：行级动作的防越权单行读）───────

test('getOneForAccount：id + account_id 双条件命中，映射面板视图', async () => {
  const { pool, calls } = controllablePool(() => ({ rows: [panelDbRow] }));
  const store = new CuratedContentStore({ pool });
  const row = await store.getOneForAccount(7, 'acc-1');
  assert.match(calls[0].sql, /WHERE id = \$1 AND account_id = \$2/);
  assert.deepEqual(calls[0].params, [7, 'acc-1']);
  assert.ok(row);
  assert.equal(row.id, 7);
  assert.equal(row.updatedAt, 3000);
});

test('getOneForAccount：跨账号/不存在 → null（越权被隔离，不泄露行存在性）', async () => {
  const { pool } = controllablePool(() => ({ rows: [] }));
  const store = new CuratedContentStore({ pool });
  assert.equal(await store.getOneForAccount(999, 'acc-1'), null);
});

test('getOneForAccount：缺表 42P01 → null 优雅降级，不抛 500', async () => {
  const { pool } = controllablePool(() => {
    const err = new Error('missing') as Error & { code?: string };
    err.code = '42P01';
    throw err;
  });
  const store = new CuratedContentStore({ pool });
  assert.equal(await store.getOneForAccount(1, 'acc-1'), null);
});
