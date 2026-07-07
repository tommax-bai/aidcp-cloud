import { test } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { FacebookCommentAuditStore } from '../../src/comment-agent/facebook-comment-audit-store.js';

function fakePool(opts: { throwOnInsert?: boolean } = {}): { calls: { text: string; params: unknown[] }[]; pool: pg.Pool } {
  const calls: { text: string; params: unknown[] }[] = [];
  const pool = {
    query: async (text: string, params: unknown[]) => {
      calls.push({ text, params });
      if (opts.throwOnInsert && /INSERT INTO facebook_comment_audit/.test(text)) throw new Error('db down');
      return { rows: [], rowCount: 0 };
    },
  } as unknown as pg.Pool;
  return { calls, pool };
}

test('append: 写一行审计（不含正文，只存长度）', async () => {
  const { calls, pool } = fakePool();
  const store = new FacebookCommentAuditStore({ pool });
  await store.append({ accountId: 'fb-1', outcome: 'shadow_ok', shadow: true, keyword: '咖啡', container: 'g1', textLength: 12 });
  assert.equal(calls.length, 1);
  assert.match(calls[0].text, /INSERT INTO facebook_comment_audit/);
  assert.deepEqual(calls[0].params, ['fb-1', 'shadow_ok', null, true, '咖啡', 'g1', 12]);
});

test('append: best-effort — 写库失败被吞，绝不抛（不波及评论主链路）', async () => {
  const { pool } = fakePool({ throwOnInsert: true });
  const store = new FacebookCommentAuditStore({ pool });
  await assert.doesNotReject(() =>
    store.append({ accountId: 'fb-1', outcome: 'no_targets', shadow: false }),
  );
});
