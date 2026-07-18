import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PublishLogStore } from '../../src/publish-agent/publish-log-store.js';

function row(id = 42) {
  return {
    id,
    account_id: 'account-1',
    platform: 'xiaohongshu',
    title: '待审稿件',
    content: '完整正文',
    images: ['https://img/cover.jpg'],
    image_url: null,
    publish_metadata: { topics: ['Agent'], mode: 'scheduled', publishTime: 1_721_284_400_000 },
    content_version: 3,
    edited_at: new Date('2026-07-18T10:00:00+08:00'),
    published_at: new Date('2026-07-18T09:00:00+08:00'),
    source_reference: { kind: 'curated_reference' },
  };
}

test('待审批列表的 items 与 total 均在 SQL 内绑定账号和 pending 状态', async () => {
  const calls: { sql: string; params: unknown[] }[] = [];
  const pool = {
    async query(sql: string, params: unknown[]) {
      calls.push({ sql, params });
      return /count\(\*\)/i.test(sql) ? { rows: [{ n: '2' }] } : { rows: [row(43), row(42)] };
    },
  };
  const store = new PublishLogStore({ pool: pool as never });
  const result = await store.listPendingPublishPreviewsForAccount('account-1', { limit: 12, offset: 24 });

  assert.equal(result.total, 2);
  assert.deepEqual(result.items.map((item) => item.id), [43, 42]);
  assert.equal(result.items[0].kind, 'rewrite');
  assert.equal(result.items[0].publishMode, 'scheduled');
  assert.equal(result.items[0].publishTime, 1_721_284_400_000);
  assert.equal(calls.length, 2);
  for (const call of calls) {
    assert.match(call.sql, /account_id = \$1/);
    assert.match(call.sql, /status = 'pending_approval'/);
    assert.equal(call.params[0], 'account-1');
  }
  const list = calls.find((call) => /OFFSET \$3/.test(call.sql));
  assert.deepEqual(list?.params, ['account-1', 12, 24]);
});

test('待审批详情用记录号和账号联合查询，非命中不暴露记录', async () => {
  const calls: { sql: string; params: unknown[] }[] = [];
  const pool = {
    async query(sql: string, params: unknown[]) {
      calls.push({ sql, params });
      return { rows: [] };
    },
  };
  const store = new PublishLogStore({ pool: pool as never });
  const result = await store.pendingPublishPreviewForAccountRecord('account-1', 42);

  assert.equal(result, null);
  assert.equal(calls.length, 1);
  assert.match(calls[0].sql, /id = \$1 AND account_id = \$2 AND status = 'pending_approval'/);
  assert.deepEqual(calls[0].params, [42, 'account-1']);
});
