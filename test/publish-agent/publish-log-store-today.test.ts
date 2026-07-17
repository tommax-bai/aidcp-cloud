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
  assert.match(seen[0].sql, /status IN \('submitted', 'published'\)/);
  assert.match(seen[0].sql, /published_at >= .*AT TIME ZONE 'Asia\/Shanghai'/s);
});

test('countReferenceDraftsForAccount: 只按账号与真实 source_reference 统计成稿', async () => {
  const seen: Array<{ sql: string; params: unknown[] }> = [];
  const pool = {
    query: async (sql: string, params: unknown[] = []) => {
      seen.push({ sql, params });
      return { rows: [{ n: '7' }] };
    },
    end: async () => {},
  } as unknown as pg.Pool;
  const store = new PublishLogStore({ pool });

  assert.equal(await store.countReferenceDraftsForAccount('acc-1'), 7);
  assert.deepEqual(seen[0].params, ['acc-1']);
  assert.match(seen[0].sql, /account_id = \$1/);
  assert.match(seen[0].sql, /source_reference IS NOT NULL/);
  // PublishExecutor 有两条「出生即 failed」且照样写 source_reference 的路径（M=0 全部生图失败 / 合规闸否决）。
  // 这些从未成稿、客户从未见过，计入即把没生成的稿谎报成「已成稿」。必须在 SQL 层排除。
  assert.match(seen[0].sql, /status <> 'failed'/, 'failed 行必须排除，否则「已成稿」被从未生成的稿件灌水');
});
