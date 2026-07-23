import { test } from 'node:test';
import { ensureCapabilitySchema } from '../../src/schema/schema-capability.js';
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
          comment_mode: params[3],
          comment_templates: JSON.parse(String(params[4])),
          updated_at: '2026-07-07T00:00:00.000Z',
          updated_by: params[5],
        };
        return { rows: [row], rowCount: 1 };
      }
      // resolveContainerName 的 UPDATE ... SET containers RETURNING（params: [accountId, containersJson]）。
      if (/UPDATE account_facebook_comment_config SET containers/.test(text)) {
        const row = {
          account_id: params[0],
          keywords: [],
          containers: JSON.parse(String(params[1])),
          comment_mode: 'generated',
          comment_templates: [],
          updated_at: '2026-07-07T00:00:00.000Z',
          updated_by: 'panel:op',
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
  const store = new FacebookCommentConfigStore({ schemaEnsurer: ensureCapabilitySchema, pool });
  const row = store.getForAccount('acc-1');
  assert.deepEqual(row, {
    accountId: 'acc-1',
    keywords: [],
    containers: [],
    commentMode: 'generated',
    commentTemplates: [],
    updatedAt: null,
    updatedBy: null,
  });
});

test('effectiveConfigFor: fail-closed — 无关键词或模板模式无模板则不生效；容器不再决定启用', async () => {
  const { pool } = fakePool();
  const store = new FacebookCommentConfigStore({ schemaEnsurer: ensureCapabilitySchema, pool });
  // 空配置
  assert.equal(store.effectiveConfigFor('acc-1').enabled, false);
  // 只有关键词、无 legacy 容器 → 生成模式仍生效；目标群由 joined ledger 运行时选择。
  await store.setAccount('acc-1', { keywords: ['coffee'], containers: [] }, 'panel:op');
  const generated = store.effectiveConfigFor('acc-1');
  assert.equal(generated.enabled, true);
  assert.deepEqual(generated.keywords, ['coffee']);
  assert.deepEqual(generated.containers, []);
  assert.equal(generated.commentMode, 'generated');

  await store.setAccount('acc-1', { commentMode: 'template', commentTemplates: [] }, 'panel:op');
  assert.equal(store.effectiveConfigFor('acc-1').enabled, false, '模板模式无模板 → 不生效');
  await store.setAccount('acc-1', { commentTemplates: ['Looks great'] }, 'panel:op');
  const templated = store.effectiveConfigFor('acc-1');
  assert.equal(templated.enabled, true);
  assert.equal(templated.commentMode, 'template');
  assert.deepEqual(templated.commentTemplates, ['Looks great']);
});

test('setAccount: sanitize（trim/去空串/去重），写 JSONB，写成功刷缓存', async () => {
  const { calls, pool } = fakePool();
  const store = new FacebookCommentConfigStore({ schemaEnsurer: ensureCapabilitySchema, pool });
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
  const store = new FacebookCommentConfigStore({ schemaEnsurer: ensureCapabilitySchema, pool });
  await store.setAccount('acc-1', { keywords: ['coffee'], containers: ['g1'] }, 'panel:op');
  await store.setAccount('acc-1', { containers: ['g1', 'g2'] }, 'panel:op'); // 不传 keywords
  const row = store.getForAccount('acc-1');
  assert.deepEqual(row.keywords, ['coffee'], '未传的关键词应保留原值');
  assert.deepEqual(row.containers, [{ url: 'g1' }, { url: 'g2' }]);
});

test('setAccount: mode/templates sanitize（trim/去空串/去重），部分补丁保留旧值', async () => {
  const { calls, pool } = fakePool();
  const store = new FacebookCommentConfigStore({ schemaEnsurer: ensureCapabilitySchema, pool });
  await store.setAccount(
    'acc-1',
    { keywords: ['coffee'], commentMode: 'template', commentTemplates: [' hi coffee ', 'hi coffee', '', 'nice coffee'] },
    'panel:op',
  );
  let row = store.getForAccount('acc-1');
  assert.equal(row.commentMode, 'template');
  assert.deepEqual(row.commentTemplates, ['hi coffee', 'nice coffee']);
  let ins = calls.find((c) => /INSERT INTO account_facebook_comment_config/.test(c.text))!;
  assert.equal(ins.params[3], 'template');
  assert.deepEqual(JSON.parse(String(ins.params[4])), ['hi coffee', 'nice coffee']);

  await store.setAccount('acc-1', { keywords: ['tea'] }, 'panel:op');
  row = store.getForAccount('acc-1');
  assert.equal(row.commentMode, 'template', '未传 mode 应保留原值');
  assert.deepEqual(row.commentTemplates, ['hi coffee', 'nice coffee'], '未传 templates 应保留原值');
});

test('容器向后兼容 + 群名：接受裸 url 与 {url,name}，按 url 去重；resolveContainerName 回填真名', async () => {
  const { pool } = fakePool();
  const store = new FacebookCommentConfigStore({ schemaEnsurer: ensureCapabilitySchema, pool });
  // 混合入参：裸 url + {url,name} + 重复 url（后者被去重）。
  await store.setAccount(
    'acc-1',
    { keywords: ['x'], containers: ['https://fb.com/groups/1', { url: 'https://fb.com/groups/2', name: '手动名' }, 'https://fb.com/groups/1'] },
    'panel:op',
  );
  assert.deepEqual(store.getForAccount('acc-1').containers, [
    { url: 'https://fb.com/groups/1' },
    { url: 'https://fb.com/groups/2', name: '手动名' },
  ]);
  // 边缘解析回填 group 1 的真名（url 匹配才回填）。
  await store.resolveContainerName('acc-1', 'https://fb.com/groups/1', 'Puerto Rico Y Sus Encantos e Historia');
  assert.deepEqual(store.getForAccount('acc-1').containers[0], { url: 'https://fb.com/groups/1', name: 'Puerto Rico Y Sus Encantos e Historia' });
  // url 未配置 → 忽略，不新增/不报错。
  await store.resolveContainerName('acc-1', 'https://fb.com/groups/999', '不存在的群');
  assert.equal(store.getForAccount('acc-1').containers.length, 2);
});

test('setAccount: 非法值（非字符串数组）整块拒 invalid_value，不刷缓存', async () => {
  const { pool } = fakePool();
  const store = new FacebookCommentConfigStore({ schemaEnsurer: ensureCapabilitySchema, pool });
  const r1 = await store.setAccount('acc-1', { keywords: [123 as unknown as string] }, 'panel:op');
  assert.deepEqual(r1, { ok: false, reason: 'invalid_value' });
  const r2 = await store.setAccount('acc-1', { keywords: 'coffee' as unknown as string[] }, 'panel:op');
  assert.deepEqual(r2, { ok: false, reason: 'invalid_value' });
  const r3 = await store.setAccount('acc-1', { commentMode: 'bad' as unknown as 'generated' }, 'panel:op');
  assert.deepEqual(r3, { ok: false, reason: 'invalid_value' });
  const r4 = await store.setAccount('acc-1', { commentTemplates: [123 as unknown as string] }, 'panel:op');
  assert.deepEqual(r4, { ok: false, reason: 'invalid_value' });
});

test('setAccount: 无有效字段（空补丁）→ no_valid_fields', async () => {
  const { pool } = fakePool();
  const store = new FacebookCommentConfigStore({ schemaEnsurer: ensureCapabilitySchema, pool });
  const r = await store.setAccount('acc-1', {}, 'panel:op');
  assert.deepEqual(r, { ok: false, reason: 'no_valid_fields' });
});

test('setAccount: 退役账号拒 retired_account（不查库）', async () => {
  const { calls, pool } = fakePool();
  const store = new FacebookCommentConfigStore({ schemaEnsurer: ensureCapabilitySchema, pool });
  const r = await store.setAccount('default', { keywords: ['x'], containers: ['g'] }, 'panel:op');
  assert.deepEqual(r, { ok: false, reason: 'retired_account' });
  assert.equal(calls.length, 0, '退役账号绝不查库/建行');
});

test('setAccount: 账号不存在拒 account_not_found（防幽灵行）', async () => {
  const { pool } = fakePool({ accountExists: false });
  const store = new FacebookCommentConfigStore({ schemaEnsurer: ensureCapabilitySchema, pool });
  const r = await store.setAccount('ghost', { keywords: ['x'], containers: ['g'] }, 'panel:op');
  assert.deepEqual(r, { ok: false, reason: 'account_not_found' });
});
