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

test('兜底下发列表按本地 target 过滤自动排期稿，同时保留历史/人工稿', async () => {
  const calls: { sql: string; params: unknown[] }[] = [];
  const pool = {
    async query(sql: string, params: unknown[]) {
      calls.push({ sql, params });
      return { rows: [{ id: 1 }, { id: 2 }] };
    },
  };
  const store = new PublishLogStore({ pool: pool as never });
  assert.deepEqual(await store.listPendingApprovalIds('dev'), [1, 2]);
  assert.match(calls[0].sql, /publish_metadata->'scheduleExecution' IS NULL/);
  assert.match(calls[0].sql, /executionTarget' = \$1/);
  assert.deepEqual(calls[0].params, ['dev']);

  await store.listPendingApprovalIds(null);
  assert.match(calls[1].sql, /publish_metadata->'scheduleExecution' IS NULL/);
  assert.doesNotMatch(calls[1].sql, /executionTarget' = \$1/);
  assert.deepEqual(calls[1].params, []);
});

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

test('客户端排期占用只查询账号的小红书 scheduled 与 Cloud 固定未来 14 天', async () => {
  const now = Date.parse('2026-07-20T09:30:00+08:00');
  const calls: { sql: string; params: unknown[] }[] = [];
  const pool = {
    async query(sql: string, params: unknown[]) {
      calls.push({ sql, params });
      return {
        rows: [
          { scheduled_at_ms: String(Date.parse('2026-07-21T08:15:00+08:00')) },
          { scheduled_at_ms: 'not-a-number' },
        ],
      };
    },
  };
  const store = new PublishLogStore({ pool: pool as never, clock: () => now });

  assert.deepEqual(await store.listOccupiedScheduledTimesForAccount('account-1'), [
    Date.parse('2026-07-21T08:15:00+08:00'),
  ]);
  assert.equal(calls.length, 1);
  assert.match(calls[0].sql, /account_id = \$1/);
  assert.match(calls[0].sql, /platform = 'xiaohongshu'/);
  assert.match(calls[0].sql, /status = 'scheduled'/);
  assert.match(calls[0].sql, /scheduled_at >= to_timestamp\(\$2/);
  assert.match(calls[0].sql, /scheduled_at <= to_timestamp\(\$3/);
  assert.deepEqual(calls[0].params, ['account-1', now, now + 14 * 24 * 60 * 60 * 1000]);
});

test('客户首页当前发布只读取仍在途状态，submitted 不与 confirmed published 混同', async () => {
  const calls: { sql: string; params: unknown[] }[] = [];
  const pool = {
    async query(sql: string, params: unknown[]) {
      calls.push({ sql, params });
      return { rows: [{ id: 88, title: '待平台确认', status: 'submitted', ts: '1721277200000' }] };
    },
  };
  const store = new PublishLogStore({ pool: pool as never });
  const result = await store.currentPublishForAccount('account-1');

  assert.deepEqual(result, { id: 88, title: '待平台确认', status: 'submitted', at: 1_721_277_200_000 });
  assert.match(calls[0].sql, /account_id = \$1/);
  assert.match(calls[0].sql, /status IN \('pending_approval', 'scheduled', 'submitted'\)/);
  assert.doesNotMatch(calls[0].sql, /status IN \([^)]*published/);
  assert.deepEqual(calls[0].params, ['account-1']);
});
