import { test } from 'node:test';
import { ensureCapabilitySchema } from '../../src/schema/schema-capability.js';
import assert from 'node:assert/strict';
import pg from 'pg';
import { FACEBOOK_GROUP_JOIN_AUTOMATION_CONFIG_SCHEMA_SQL, FACEBOOK_GROUP_JOIN_AUTOMATION_DAILY_CAP_MAX, FacebookGroupJoinAutomationStore } from '../../src/config/facebook-group-join-automation-store.js';
import {
  SCHEDULED_CONTACT_COMMENT_DAILY_CAP_MAX,
  SCHEDULED_GROUP_JOIN_DAILY_CAP_MAX,
} from '../../src/kernel/platform-types.js';
import { SCHEDULED_AUTOMATION_CATALOG } from '../../src/kernel/scheduled-automation-catalog.js';
import { fakeSchemaProbe } from '../fixtures/schema-probe.js';

/** 假 pool 的 schema 探测应答：存储 init() 现在只探测、不建表（change cloud-schema-migration-executor 第 5 节）。 */
const schemaProbe = fakeSchemaProbe(FACEBOOK_GROUP_JOIN_AUTOMATION_CONFIG_SCHEMA_SQL);

const FULL = '1'.repeat(168);
const HALF = '1'.repeat(84) + '0'.repeat(84);

interface StoredRow {
  account_id: string;
  enabled: boolean;
  daily_cap: number;
  week_mask: string | null;
  updated_at: string;
  updated_by: string | null;
}

function fakePool(options: {
  accountExists?: boolean;
  platform?: string | null;
  seed?: StoredRow;
  emptyReturning?: boolean;
} = {}): {
  calls: Array<{ text: string; params: unknown[] }>;
  pool: pg.Pool;
} {
  const calls: Array<{ text: string; params: unknown[] }> = [];
  let stored = options.seed;
  const pool = {
    query: async (text: string, params: unknown[] = []) => {
      const __probe = schemaProbe(text);
      if (__probe) return __probe;
      calls.push({ text, params });
      if (text.includes('CREATE TABLE IF NOT EXISTS facebook_group_join_automation_config')) {
        return { rows: [] };
      }
      if (/SELECT platform FROM accounts/.test(text)) {
        return {
          rows:
            options.accountExists === false
              ? []
              : [{ platform: options.platform === undefined ? 'facebook' : options.platform }],
        };
      }
      if (/INSERT INTO facebook_group_join_automation_config/.test(text)) {
        const [accountId, enabled, dailyCap, weekMask, updatedBy, hasEnabled, hasDailyCap, hasWeekMask] =
          params as [string, boolean, number, string | null, string, boolean, boolean, boolean];
        stored = {
          account_id: accountId,
          enabled: stored ? (hasEnabled ? enabled : stored.enabled) : enabled,
          daily_cap: stored ? (hasDailyCap ? dailyCap : stored.daily_cap) : dailyCap,
          week_mask: stored ? (hasWeekMask ? weekMask : stored.week_mask) : weekMask,
          updated_at: '2026-07-22T06:00:00.000Z',
          updated_by: updatedBy,
        };
        return { rows: options.emptyReturning ? [] : [stored] };
      }
      if (/FROM facebook_group_join_automation_config/.test(text)) {
        return { rows: stored ? [stored] : [] };
      }
      throw new Error(`fake pool 未覆盖 SQL: ${text.trim().slice(0, 80)}`);
    },
  } as unknown as pg.Pool;
  return { calls, pool };
}

test('schema: 配置表可在 accounts 初始化前 additive 建表，默认关闭，并在数据库层约束 cap 与周历', () => {
  assert.match(FACEBOOK_GROUP_JOIN_AUTOMATION_CONFIG_SCHEMA_SQL, /account_id\s+TEXT PRIMARY KEY/);
  assert.doesNotMatch(FACEBOOK_GROUP_JOIN_AUTOMATION_CONFIG_SCHEMA_SQL, /REFERENCES accounts/);
  assert.match(FACEBOOK_GROUP_JOIN_AUTOMATION_CONFIG_SCHEMA_SQL, /enabled\s+BOOLEAN NOT NULL DEFAULT false/);
  assert.match(FACEBOOK_GROUP_JOIN_AUTOMATION_CONFIG_SCHEMA_SQL, /daily_cap BETWEEN 0 AND 50/);
  assert.match(FACEBOOK_GROUP_JOIN_AUTOMATION_CONFIG_SCHEMA_SQL, /week_mask ~ '\^\[01\]\{168\}\$'/);
  assert.equal(FACEBOOK_GROUP_JOIN_AUTOMATION_DAILY_CAP_MAX, 50);
});

// change raise-facebook-group-join-cap-ceiling：加群硬上限 10 → 50。
// 这三条断言各挡一类回归，缺一不可。
test('cap ceiling: 50 放行、51 整块拒，且联系评论的 10 不被顺带抬高', () => {
  // ① 天花板本身抬到 50。
  assert.equal(SCHEDULED_GROUP_JOIN_DAILY_CAP_MAX, 50);
  assert.equal(FACEBOOK_GROUP_JOIN_AUTOMATION_DAILY_CAP_MAX, SCHEDULED_GROUP_JOIN_DAILY_CAP_MAX);

  // ② **误改红线**：联系评论硬上限与加群常量在 kernel 同一文件相邻两行、历史同值 10。
  // 本条专挡「按行号定位、把两条一起改成 50」这个误改（design.md Risks 第一条）。
  assert.equal(SCHEDULED_CONTACT_COMMENT_DAILY_CAP_MAX, 10);
  assert.notEqual(SCHEDULED_CONTACT_COMMENT_DAILY_CAP_MAX, SCHEDULED_GROUP_JOIN_DAILY_CAP_MAX);

  // ③ 自愈建表模板按常量插值，MUST 与常量逐字一致——漂移会让「代码放行、库拒收」重演。
  assert.match(
    FACEBOOK_GROUP_JOIN_AUTOMATION_CONFIG_SCHEMA_SQL,
    new RegExp(`daily_cap BETWEEN 0 AND ${SCHEDULED_GROUP_JOIN_DAILY_CAP_MAX}`),
  );
  assert.doesNotMatch(FACEBOOK_GROUP_JOIN_AUTOMATION_CONFIG_SCHEMA_SQL, /daily_cap BETWEEN 0 AND 10/);
});

test('cap ceiling: 平台动作目录下发的加群上限跟随常量（后台输入框上限由它决定）', () => {
  const fb = SCHEDULED_AUTOMATION_CATALOG.facebook.join_group;
  assert.equal(fb.supported, true);
  assert.equal(fb.supported === true ? fb.maxDailyCap : -1, 50);
  // 联系评论同一张目录里保持 10（后台两个输入框上限必须不同）。
  const contact = SCHEDULED_AUTOMATION_CATALOG.facebook.contact_comment;
  assert.equal(contact.supported === true ? contact.maxDailyCap : -1, 10);
});

test('init/getForAccount: 缺行默认关闭且不造行；已有数据库真态载入镜像', async () => {
  const empty = fakePool();
  const emptyStore = new FacebookGroupJoinAutomationStore({ schemaEnsurer: ensureCapabilitySchema, pool: empty.pool });
  await emptyStore.init();
  assert.deepEqual(emptyStore.getForAccount('fb-empty'), {
    accountId: 'fb-empty',
    enabled: false,
    dailyCap: 0,
    weekMask: null,
    updatedAt: null,
    updatedBy: null,
  });
  assert.equal(
    empty.calls.some((call) => /INSERT INTO facebook_group_join_automation_config/.test(call.text)),
    false,
  );

  const seeded = fakePool({
    seed: {
      account_id: 'fb-1',
      enabled: true,
      daily_cap: 2,
      week_mask: HALF,
      updated_at: '2026-07-22T05:00:00.000Z',
      updated_by: 'panel:seed',
    },
  });
  const seededStore = new FacebookGroupJoinAutomationStore({ schemaEnsurer: ensureCapabilitySchema, pool: seeded.pool });
  await seededStore.init();
  assert.deepEqual(seededStore.getForAccount('fb-1'), {
    accountId: 'fb-1',
    enabled: true,
    dailyCap: 2,
    weekMask: HALF,
    updatedAt: '2026-07-22T05:00:00.000Z',
    updatedBy: 'panel:seed',
  });
});

test('setAccount: 合法完整写与部分写均以 RETURNING 回真态，未传字段原子保留', async () => {
  const { calls, pool } = fakePool();
  const store = new FacebookGroupJoinAutomationStore({ schemaEnsurer: ensureCapabilitySchema, pool });
  const created = await store.setAccount(
    'fb-1',
    { enabled: true, dailyCap: 2, weekMask: FULL },
    'panel:alice',
  );
  assert.deepEqual(created, {
    ok: true,
    row: {
      accountId: 'fb-1',
      enabled: true,
      dailyCap: 2,
      weekMask: FULL,
      updatedAt: '2026-07-22T06:00:00.000Z',
      updatedBy: 'panel:alice',
    },
  });

  const patched = await store.setAccount('fb-1', { dailyCap: 1 }, 'panel:bob');
  assert.equal(patched.ok, true);
  if (!patched.ok) return;
  assert.deepEqual(
    [patched.row.enabled, patched.row.dailyCap, patched.row.weekMask, patched.row.updatedBy],
    [true, 1, FULL, 'panel:bob'],
  );
  const writes = calls.filter((call) => /INSERT INTO facebook_group_join_automation_config/.test(call.text));
  assert.equal(writes.length, 2);
  assert.deepEqual(writes[1].params.slice(5), [false, true, false], '字段存在标志必须区分未传字段');
  assert.deepEqual(store.getForAccount('fb-1'), patched.row, '写成功后镜像与数据库回真态一致');
});

test('setAccount: weekMask 显式 null 可清覆盖，未传则保留', async () => {
  const { pool } = fakePool({
    seed: {
      account_id: 'fb-1',
      enabled: true,
      daily_cap: 2,
      week_mask: HALF,
      updated_at: '2026-07-22T05:00:00.000Z',
      updated_by: 'seed',
    },
  });
  const store = new FacebookGroupJoinAutomationStore({ schemaEnsurer: ensureCapabilitySchema, pool });
  await store.init();
  const result = await store.setAccount('fb-1', { weekMask: null }, 'panel:alice');
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.row.weekMask, null);
  assert.equal(result.row.enabled, true);
  assert.equal(result.row.dailyCap, 2);
});

test('setAccount: 所有字段先校验，非法补丁整块拒且完全不查账号/不写', async () => {
  for (const patch of [
    {},
    { enabled: 'yes' },
    { dailyCap: -1 },
    { dailyCap: 1.5 },
    // change raise-facebook-group-join-cap-ceiling：越界样本随硬上限 10 → 50 上移。
    // 用 MAX + 1 而不是写死 51，硬上限再变时这条不会悄悄退化成「测了个合法值」。
    { dailyCap: SCHEDULED_GROUP_JOIN_DAILY_CAP_MAX + 1 },
    { weekMask: '1'.repeat(167) },
    { weekMask: '1'.repeat(167) + 'x' },
    { enabled: true, dailyCap: SCHEDULED_GROUP_JOIN_DAILY_CAP_MAX + 1, weekMask: FULL },
  ]) {
    const { calls, pool } = fakePool();
    const store = new FacebookGroupJoinAutomationStore({ schemaEnsurer: ensureCapabilitySchema, pool });
    const result = await store.setAccount(
      'fb-1',
      patch as { enabled?: boolean; dailyCap?: number; weekMask?: string | null },
      'panel:alice',
    );
    assert.deepEqual(result, {
      ok: false,
      reason: Object.keys(patch).length === 0 ? 'no_valid_fields' : 'invalid_value',
    });
    assert.equal(calls.length, 0, `非法补丁不得查账号或写库: ${JSON.stringify(patch)}`);
  }
});

test('setAccount: 账号不存在与非 Facebook/未知平台具名拒绝，均不 UPSERT', async () => {
  for (const options of [
    { accountExists: false },
    { platform: 'xiaohongshu' },
    { platform: 'wechat_channels' },
    { platform: 'unknown-platform' },
    { platform: null },
  ]) {
    const { calls, pool } = fakePool(options);
    const store = new FacebookGroupJoinAutomationStore({ schemaEnsurer: ensureCapabilitySchema, pool });
    const result = await store.setAccount('account-1', { enabled: true }, 'panel:alice');
    assert.deepEqual(result, {
      ok: false,
      reason: options.accountExists === false ? 'account_not_found' : 'unsupported_automation_action',
    });
    assert.equal(
      calls.some((call) => /INSERT INTO facebook_group_join_automation_config/.test(call.text)),
      false,
    );
  }

  const alias = fakePool({ platform: ' FB ' });
  const aliasStore = new FacebookGroupJoinAutomationStore({ schemaEnsurer: ensureCapabilitySchema, pool: alias.pool });
  assert.equal((await aliasStore.setAccount('fb-alias', { enabled: false }, 'panel:alice')).ok, true);
});

test('setAccount: UPSERT 未 RETURNING 时抛错且不伪造成功/不刷新镜像', async () => {
  const { pool } = fakePool({ emptyReturning: true });
  const store = new FacebookGroupJoinAutomationStore({ schemaEnsurer: ensureCapabilitySchema, pool });
  await assert.rejects(
    store.setAccount('fb-1', { enabled: true, dailyCap: 1 }, 'panel:alice'),
    /upsert returned no row/,
  );
  assert.deepEqual(store.getForAccount('fb-1'), {
    accountId: 'fb-1',
    enabled: false,
    dailyCap: 0,
    weekMask: null,
    updatedAt: null,
    updatedBy: null,
  });
});
