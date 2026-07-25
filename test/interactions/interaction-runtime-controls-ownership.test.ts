/**
 * 运行控制行的播种守卫：账号存在与否经 **api 域端口**判定，绝不在 automation 池上跑 `accounts` 的 SQL。
 *
 * 背景：守卫原本是一条语句里的 `WHERE EXISTS (SELECT 1 FROM accounts …)`。`accounts` 属 api 域，
 * 本 store 绑 automation 池 —— 物理拆库后 automation 库里没有这张表，整条 INSERT 报
 * `relation "accounts" does not exist`。与 `PgRiskStore.saveState` 同形，同一批修掉。
 *
 * **测得到的**：不再对本域池发 accounts 查询、平台不符 / 缺账号不播种、端口未注入即当场抛。
 * **测不到的**：真 PostgreSQL 上「api 库里确有这行、automation 库里确无这张表」——那是部署事实，
 * 属真机验收项。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Pool } from 'pg';
import { InteractionStore } from '../../src/interactions/interaction-store.js';
import { INTERACTION_PLATFORM } from '../../src/kernel/interaction-types.js';
import type { PlatformId } from '../../src/kernel/platform-types.js';

/** 本域池：认运行控制行的读写；**任何提到 accounts 的 SQL 都当场炸**（复刻拆库后 PG 的报错）。 */
function automationPool(controlRows: Record<string, unknown>[]) {
  const seen: string[] = [];
  const pool = {
    query: async (sql: string) => {
      seen.push(sql);
      if (/\baccounts\b/.test(sql)) throw new Error('relation "accounts" does not exist');
      if (sql.includes('INSERT INTO interaction_runtime_controls')) return { rows: [], rowCount: 0 };
      if (sql.includes('SELECT * FROM interaction_runtime_controls')) return { rows: controlRows };
      return { rows: [], rowCount: 0 };
    },
  } as unknown as Pool;
  return { pool, seen };
}

function controlRow() {
  return {
    account_id: 'acct-1', env_key: 'env-1', version: 1,
    comments_read_enabled: true, comments_reply_enabled: false,
    dm_read_enabled: false, dm_send_text_enabled: false, dm_send_image_enabled: false,
    write_paused: false, consecutive_failures: 0, circuit_opened_at: null, last_confirmed_at: null,
    updated_at: new Date(1_784_044_800_000), updated_by: 'system',
  };
}

test('账号是互动平台 → 播种一行；全程不对 automation 池发任何 accounts 查询', async () => {
  const { pool, seen } = automationPool([controlRow()]);
  const asked: string[] = [];
  const store = new InteractionStore({
    pool,
    accountPlatform: {
      getPlatformOrNull: async (id) => {
        asked.push(id);
        return INTERACTION_PLATFORM;
      },
    },
  });
  const controls = await store.getRuntimeControls('acct-1');
  assert.equal(controls.accountId, 'acct-1');
  assert.deepEqual(asked, ['acct-1'], '账号是否存在改问 api 域端口');
  assert.equal(seen.filter((s) => /\baccounts\b/.test(s)).length, 0, '绝不在本域池上碰 api 属主表');
  assert.equal(seen.filter((s) => s.includes('INSERT INTO interaction_runtime_controls')).length, 1);
});

test('缺账号 / 平台不符 → 不播种，照旧 404（语义逐位保留）', async () => {
  for (const [scenario, platform] of [
    ['账号不存在', null],
    ['账号不是互动平台', 'xiaohongshu' as PlatformId],
  ] as const) {
    const { pool, seen } = automationPool([]);
    const store = new InteractionStore({ pool, accountPlatform: { getPlatformOrNull: async () => platform } });
    await assert.rejects(
      () => store.getRuntimeControls('acct-1'),
      (err: unknown) => (err as { code?: string }).code === 'INTERACTION_NOT_FOUND',
      scenario,
    );
    assert.equal(
      seen.filter((s) => s.includes('INSERT INTO interaction_runtime_controls')).length,
      0,
      `${scenario}：MUST NOT 播出孤儿控制行`,
    );
  }
});

test('端口未注入 → 当场抛，MUST NOT 把「问不到」当成「账号存在」', async () => {
  const { pool, seen } = automationPool([controlRow()]);
  const store = new InteractionStore({ pool });
  await assert.rejects(
    () => store.getRuntimeControls('acct-1'),
    /interaction_account_platform_port_not_configured/,
  );
  assert.equal(seen.length, 0, '问不到就一条语句都不发');
});
