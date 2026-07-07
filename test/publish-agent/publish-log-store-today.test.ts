import { test } from 'node:test';
import assert from 'node:assert/strict';
import type pg from 'pg';
import { PublishLogStore } from '../../src/publish-agent/publish-log-store.js';

test('countPublishedTodayForAccount: 今日发布数按 Asia/Shanghai 自然日过滤', async () => {
  const seen: Array<{ sql: string; params: unknown[] }> = [];
  const pool = {
    query: async (sql: string, params: unknown[] = []) => {
      seen.push({ sql, params });
      return { rows: [{ n: '2' }] };
    },
    end: async () => {},
  } as unknown as pg.Pool;
  const store = new PublishLogStore({ pool });

  const count = await store.countPublishedTodayForAccount('acc-1');
  assert.equal(count, 2);
  assert.deepEqual(seen[0].params, ['acc-1']);
  assert.match(seen[0].sql, /published_at >= .*AT TIME ZONE 'Asia\/Shanghai'/s);
});
