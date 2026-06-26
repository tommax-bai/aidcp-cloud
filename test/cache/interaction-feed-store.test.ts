import { test } from 'node:test';
import assert from 'node:assert/strict';
import type pg from 'pg';
import { InteractionFeedStore } from '../../src/cache/interaction-feed-store.js';

/** 捕获每次 query 的 (sql, params)，用于断言写入行为，不依赖真 PG。 */
function capturingPool(): { pool: pg.Pool; calls: Array<{ sql: string; params: unknown[] }> } {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const pool = {
    query: async (sql: string, params: unknown[]) => {
      calls.push({ sql, params });
      return { rows: [] };
    },
  } as unknown as pg.Pool;
  return { pool, calls };
}

test('recordEvent 落事件、用 ON CONFLICT DO NOTHING（保留首次时间）', async () => {
  const { pool, calls } = capturingPool();
  const store = new InteractionFeedStore({ pool });
  await store.recordEvent('default', 'follow', 'author-1', 1000);
  assert.equal(calls.length, 1);
  assert.match(calls[0].sql, /INSERT INTO interaction_feed/);
  assert.match(calls[0].sql, /ON CONFLICT \(account_id, action, target_id\) DO NOTHING/);
  assert.deepEqual(calls[0].params, ['default', 'follow', 'author-1', 1000]);
});

test('recordEvent 空/空白 targetId 不写（诚实：无目标不记）', async () => {
  const { pool, calls } = capturingPool();
  const store = new InteractionFeedStore({ pool });
  await store.recordEvent('default', 'like', '', 1000);
  await store.recordEvent('default', 'like', '   ', 1000);
  assert.equal(calls.length, 0);
});

test('upsertMeta 用 COALESCE 合并（不抹除已存在的 title/url）', async () => {
  const { pool, calls } = capturingPool();
  const store = new InteractionFeedStore({ pool });
  await store.upsertMeta('default', 'note-1', { title: '标题', url: 'https://x/explore/note-1?xsec_token=t' });
  assert.equal(calls.length, 1);
  assert.match(calls[0].sql, /INSERT INTO interaction_target_meta/);
  assert.match(calls[0].sql, /COALESCE\(EXCLUDED\.title/);
  assert.match(calls[0].sql, /COALESCE\(EXCLUDED\.url/);
  assert.deepEqual(calls[0].params, ['default', 'note-1', '标题', 'https://x/explore/note-1?xsec_token=t']);
});

test('upsertMeta 把空白字段归一为 null（诚实置空，不写空串）', async () => {
  const { pool, calls } = capturingPool();
  const store = new InteractionFeedStore({ pool });
  // 只有 title、url 空白 → url 落 null（非空串），title 落实值。
  await store.upsertMeta('default', 'author-2', { title: '某作者', url: '   ' });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].params, ['default', 'author-2', '某作者', null]);
});

test('upsertMeta title+url 全空白则不写（无可补充）', async () => {
  const { pool, calls } = capturingPool();
  const store = new InteractionFeedStore({ pool });
  await store.upsertMeta('default', 'note-3', { title: '', url: undefined });
  assert.equal(calls.length, 0);
});
