import { test } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { PersonaStore, createPersonaResolver } from '../src/config/persona-store.js';

const soulYaml = (name: string) => `
identity:
  name: "${name}"
  role: "美妆博主"
  background: "三年护肤经验"
  tone: "亲切"
interests:
  primary:
    - "护肤"
  secondary:
    - "彩妆"
  seed_keywords:
    - "成分党"
`;

/**
 * 内存假 pool：路由 persona_config 的建表 / SELECT / upsert(RETURNING) / DELETE，
 * 以及 accounts 的 list / exists。可注入写失败。
 */
function fakePool(opts: { accounts?: Array<{ account_id: string; label: string | null }>; persona?: Record<string, string> } = {}) {
  const accounts = new Map<string, string | null>();
  for (const a of opts.accounts ?? [{ account_id: 'default', label: 'default' }]) accounts.set(a.account_id, a.label);
  const rows = new Map<string, { account_id: string; persona: string; updated_at: string; updated_by: string }>();
  for (const [id, persona] of Object.entries(opts.persona ?? {})) {
    rows.set(id, { account_id: id, persona, updated_at: '2026-06-24T00:00:00.000Z', updated_by: 'seed' });
  }
  let failWrite = false;
  const pool = {
    query: async (sql: string, params?: unknown[]) => {
      if (sql.includes('CREATE TABLE')) return { rows: [] };
      if (sql.includes('INSERT INTO persona_config')) {
        if (failWrite) throw new Error('db down');
        const [accountId, persona, updatedBy] = params as [string, string, string];
        if (sql.includes('DO NOTHING') && rows.has(accountId)) return { rows: [] };
        const row = { account_id: accountId, persona, updated_at: '2026-06-24T01:00:00.000Z', updated_by: updatedBy };
        rows.set(accountId, row);
        return { rows: [row] };
      }
      if (sql.includes('DELETE FROM persona_config')) {
        if (failWrite) throw new Error('db down');
        const [accountId] = params as [string];
        rows.delete(accountId);
        return { rows: [] };
      }
      if (sql.includes('FROM persona_config')) return { rows: [...rows.values()] };
      if (sql.includes('SELECT 1 AS one FROM accounts')) {
        const [accountId] = params as [string];
        return { rows: accounts.has(accountId) ? [{ one: 1 }] : [] };
      }
      if (sql.includes('FROM accounts')) {
        return { rows: [...accounts.entries()].map(([account_id, label]) => ({ account_id, label })) };
      }
      return { rows: [] };
    },
  };
  return { pool: pool as unknown as pg.Pool, setFailWrite: (v: boolean) => { failWrite = v; } };
}

test('缺行 → getForAccount 返回 null（回落语义）', async () => {
  const { pool } = fakePool();
  const store = new PersonaStore({ pool });
  await store.init();
  assert.equal(store.getForAccount('default'), null);
});

test('set 后 getForAccount 即时热加载（无需重启）+ 回真态含审计', async () => {
  const { pool } = fakePool();
  const store = new PersonaStore({ pool });
  await store.init();
  const row = await store.set('default', soulYaml('账号A'), 'alice');
  assert.equal(row.updatedBy, 'alice');
  assert.ok(row.updatedAt);
  assert.ok(store.getForAccount('default')?.includes('账号A'));
});

test('setIfMissing：首次原子写入；已有行时跳过且绝不覆盖', async () => {
  const { pool } = fakePool();
  const store = new PersonaStore({ pool });
  await store.init();
  const created = await store.setIfMissing('default', soulYaml('自动生成'), 'auto');
  assert.equal(created?.updatedBy, 'auto');
  const skipped = await store.setIfMissing('default', soulYaml('不应覆盖'), 'auto');
  assert.equal(skipped, null);
  assert.ok(store.getForAccount('default')?.includes('自动生成'));
  assert.equal(store.getForAccount('default')?.includes('不应覆盖'), false);
});

test('结构化 mandatory_interactions 经 store 热加载后由 resolver 原样解析', async () => {
  const { pool } = fakePool();
  const store = new PersonaStore({ pool });
  await store.init();
  const persona = `${soulYaml('Tianxing Bai')}
mandatory_interactions:
  - id: "vietnam-recruitment"
    when: "Bài đăng tuyển dụng hoặc tuyển người tại Việt Nam"
    actions:
      - "like"
      - "comment"
    comment_guidance: "Bình luận bằng tiếng Việt và hỏi về công việc."
    comment_approval: "auto_approve"
`;
  await store.set('default', persona, 'codex');

  const resolved = createPersonaResolver({ store })('default');
  assert.deepEqual(resolved?.mandatory_interactions?.[0]?.actions, ['like', 'comment']);
  assert.equal(resolved?.mandatory_interactions?.[0]?.comment_approval, 'auto_approve');
});

test('空白文本视作无覆盖（getForAccount 返回 null）', async () => {
  const { pool } = fakePool({ persona: { default: '   ' } });
  const store = new PersonaStore({ pool });
  await store.init();
  assert.equal(store.getForAccount('default'), null);
});

test('clear 删行 → getForAccount 回 null', async () => {
  const { pool } = fakePool({ persona: { default: soulYaml('账号A') } });
  const store = new PersonaStore({ pool });
  await store.init();
  assert.ok(store.getForAccount('default'));
  await store.clear('default');
  assert.equal(store.getForAccount('default'), null);
});

test('写库失败 → 内存镜像不变（绝不镜像/库不一致）', async () => {
  const { pool, setFailWrite } = fakePool({ persona: { default: soulYaml('原始') } });
  const store = new PersonaStore({ pool });
  await store.init();
  setFailWrite(true);
  await assert.rejects(store.set('default', soulYaml('新值'), 'a'));
  assert.ok(store.getForAccount('default')?.includes('原始'));
});

test('listAccounts 列全部账号（含无人设覆盖者）; accountExists 区分存在', async () => {
  const { pool } = fakePool({ accounts: [{ account_id: 'default', label: 'D' }, { account_id: 'acc2', label: null }] });
  const store = new PersonaStore({ pool });
  await store.init();
  const list = await store.listAccounts();
  assert.deepEqual(list.map((a) => a.accountId).sort(), ['acc2', 'default']);
  assert.equal(await store.accountExists('acc2'), true);
  assert.equal(await store.accountExists('ghost'), false);
});

// ── createPersonaResolver：无人设信号 + 永不抛（persona-driven-content-pipeline：系统不存在默认/兜底人设）──
test('resolver：命中镜像且可解析 → 用之', () => {
  const resolve = createPersonaResolver({
    store: { getForAccount: () => soulYaml('OVERRIDE') },
  });
  assert.equal(resolve('default')?.identity.name, 'OVERRIDE');
});

test('resolver：无行 → null（明确「无人设」信号，绝不返回任何默认人设）', () => {
  const resolve = createPersonaResolver({ store: { getForAccount: () => null } });
  assert.equal(resolve('default'), null);
});

test('resolver：解析失败 → 记 warn + null（按无人设处理），永不抛、绝不静默替换默认人设', () => {
  const warns: string[] = [];
  const resolve = createPersonaResolver({
    store: { getForAccount: () => 'this: is: not: valid: soul' },
    logger: { warn: (m: string) => warns.push(m) },
  });
  assert.equal(resolve('bad'), null);
  assert.equal(warns.length, 1);
});

test('resolver：无 store（PG 不可用）→ null（fail-closed，所有账号视为未绑人设）', () => {
  const resolve = createPersonaResolver({});
  assert.equal(resolve(), null);
});
