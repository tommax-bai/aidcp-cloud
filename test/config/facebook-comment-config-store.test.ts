import { test } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { FacebookCommentConfigStore } from '../../src/config/facebook-comment-config-store.js';

/** fake pool：可配 accounts 存在性 + RETURNING 行；记录调用。 */
function fakePool(opts: { accountExists?: boolean; returning?: unknown } = {}): {
  calls: { text: string; params: unknown[] }[];
  pool: pg.Pool;
} {
  const calls: { text: string; params: unknown[] }[] = [];
  const accountExists = opts.accountExists ?? true;
  const pool = {
    query: async (text: string, params: unknown[]) => {
      calls.push({ text, params });
      if (/SELECT 1 FROM accounts/.test(text)) return { rows: accountExists ? [{ '?column?': 1 }] : [], rowCount: accountExists ? 1 : 0 };
      if (/INSERT INTO account_facebook_comment_config/.test(text)) {
        const row = opts.returning ?? {
          account_id: params[0],
          keywords: JSON.parse(String(params[1])),
          containers: JSON.parse(String(params[2])),
          updated_at: '2026-07-07T00:00:00.000Z',
          updated_by: params[3],
        };
        return { rows: [row], rowCount: 1 };
      }
      // reload SELECT
      return { rows: [], rowCount: 0 };
    },
  } as unknown as pg.Pool;
  return { calls, pool };
}

test('getForAccount: 缺行返回空默认（供面板回显）', () => {
  const { pool } = fakePool();
  const store = new FacebookCommentConfigStore({ pool });
  const row = store.getForAccount('acc-1');
  assert.deepEqual(row, { accountId: 'acc-1', keywords: [], containers: [], updatedAt: null, updatedBy: null });
});

test('effectiveConfigFor: fail-closed — 关键词或容器任一为空则不生效', async () => {
  const { pool } = fakePool();
  const store = new FacebookCommentConfigStore({ pool });
  // 空配置
  assert.equal(store.effectiveConfigFor('acc-1').enabled, false);
  // 只有关键词、无容器 → 不生效
  await store.setAccount('acc-1', { keywords: ['coffee'], containers: [] }, 'panel:op');
  assert.equal(store.effectiveConfigFor('acc-1').enabled, false);
  // 两者都非空 → 生效
  await store.setAccount('acc-1', { keywords: ['coffee'], containers: ['group-123'] }, 'panel:op');
  const eff = store.effectiveConfigFor('acc-1');
  assert.equal(eff.enabled, true);
  assert.deepEqual(eff.keywords, ['coffee']);
  assert.deepEqual(eff.containers, ['group-123']);
});

test('setAccount: sanitize（trim/去空串/去重），写 JSONB，写成功刷缓存', async () => {
  const { calls, pool } = fakePool();
  const store = new FacebookCommentConfigStore({ pool });
  const r = await store.setAccount('acc-1', { keywords: [' coffee ', 'coffee', '', 'tea'], containers: ['g1'] }, 'panel:op');
  assert.equal(r.ok, true);
  assert.deepEqual((r as { ok: true; row: { keywords: string[] } }).row.keywords, ['coffee', 'tea']);
  // INSERT 参数里的 keywords JSON 已 sanitize
  const ins = calls.find((c) => /INSERT INTO account_facebook_comment_config/.test(c.text))!;
  assert.deepEqual(JSON.parse(String(ins.params[1])), ['coffee', 'tea']);
  // 缓存已刷：getForAccount 命中新值
  assert.deepEqual(store.getForAccount('acc-1').keywords, ['coffee', 'tea']);
});

test('setAccount: 部分补丁（只改容器）保留原关键词', async () => {
  const { pool } = fakePool();
  const store = new FacebookCommentConfigStore({ pool });
  await store.setAccount('acc-1', { keywords: ['coffee'], containers: ['g1'] }, 'panel:op');
  await store.setAccount('acc-1', { containers: ['g1', 'g2'] }, 'panel:op'); // 不传 keywords
  const row = store.getForAccount('acc-1');
  assert.deepEqual(row.keywords, ['coffee'], '未传的关键词应保留原值');
  assert.deepEqual(row.containers, ['g1', 'g2']);
});

test('setAccount: 非法值（非字符串数组）整块拒 invalid_value，不刷缓存', async () => {
  const { pool } = fakePool();
  const store = new FacebookCommentConfigStore({ pool });
  const r1 = await store.setAccount('acc-1', { keywords: [123 as unknown as string] }, 'panel:op');
  assert.deepEqual(r1, { ok: false, reason: 'invalid_value' });
  const r2 = await store.setAccount('acc-1', { keywords: 'coffee' as unknown as string[] }, 'panel:op');
  assert.deepEqual(r2, { ok: false, reason: 'invalid_value' });
});

test('setAccount: 无有效字段（空补丁）→ no_valid_fields', async () => {
  const { pool } = fakePool();
  const store = new FacebookCommentConfigStore({ pool });
  const r = await store.setAccount('acc-1', {}, 'panel:op');
  assert.deepEqual(r, { ok: false, reason: 'no_valid_fields' });
});

test('setAccount: 退役账号拒 retired_account（不查库）', async () => {
  const { calls, pool } = fakePool();
  const store = new FacebookCommentConfigStore({ pool });
  const r = await store.setAccount('default', { keywords: ['x'], containers: ['g'] }, 'panel:op');
  assert.deepEqual(r, { ok: false, reason: 'retired_account' });
  assert.equal(calls.length, 0, '退役账号绝不查库/建行');
});

test('setAccount: 账号不存在拒 account_not_found（防幽灵行）', async () => {
  const { pool } = fakePool({ accountExists: false });
  const store = new FacebookCommentConfigStore({ pool });
  const r = await store.setAccount('ghost', { keywords: ['x'], containers: ['g'] }, 'panel:op');
  assert.deepEqual(r, { ok: false, reason: 'account_not_found' });
});
