import { test } from 'node:test';
import { ensureCapabilitySchema } from '../src/schema/schema-capability.js';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import pg from 'pg';
import {
  CLIENT_USERS_SCHEMA_SQL,
  ClientUserStore,
  createEnvironmentHandshakeAuthority,
  normalizeEnvironmentProxyAuthority,
} from '../src/client-auth/client-user-store.js';
import { shanghaiDayStartMs } from '../src/time/shanghai-day.js';
import type { ClientEnvAutomationReader } from '../src/kernel/client-env-automation-types.js';

/**
 * client-user-env-picker：`listAllEnvironments` 的**映射逻辑**单测（行 → ClientEnvironmentView）。
 *
 * 真 SQL 聚合（json_agg / array_agg … FILTER / GROUP BY）与「多分只动当前 user_id」的 WHERE 语义靠
 * 真库核（本仓 store 测试用手写假 pool、非真 SQL 引擎，桩不了聚合正确性）→ 真机 backlog 簇 61。
 * 这里只锁我自己那段映射：assigneeCount = assignees.length、null assignees 回落空、缺表 fail-closed。
 */
function fakePool(handler: (sql: string, params?: unknown[]) => { rows: unknown[] }) {
  const pool = {
    query: async (sql: string, params?: unknown[]) => handler(sql, params),
  };
  return pool as unknown as pg.Pool;
}

/**
 * Block③ L3：automation 属主表只读投影端口的测试桩。默认「空世界」——无未清除离场记录、
 * 无微信互动绑定、无风控行；每个用例只覆盖自己关心的那一两个方法。
 * 端口**未注入**时 store 会当场抛具名错（见下方 fail-loud 用例），不会静默回落成空集。
 */
function fakeAutomationReads(overrides: Partial<ClientEnvAutomationReader> = {}): ClientEnvAutomationReader {
  return {
    offboardForUser: async () => null,
    activeWechatOffboards: async () => [],
    wechatBoundEnvKeys: async () => [],
    wechatEnvKeysForAccount: async () => [],
    boundAccountForEnv: async () => null,
    riskStateProjection: async () => [],
    ...overrides,
  };
}

test('normalizeEnvironmentProxyAuthority accepts explicit states and rejects malformed credential payloads', () => {
  assert.deepEqual(normalizeEnvironmentProxyAuthority({ state: 'no_proxy' }), { state: 'no_proxy' });
  assert.deepEqual(normalizeEnvironmentProxyAuthority({
    state: 'configured',
    proxyType: 'SOCKS5',
    proxyHost: 'proxy.example',
    proxyPort: 1080,
    proxyUser: 'alice',
    proxyPassword: 'secret',
  }), {
    state: 'configured',
    proxyType: 'socks5',
    proxyHost: 'proxy.example',
    proxyPort: 1080,
    proxyUser: 'alice',
    proxyPassword: 'secret',
  });
  for (const malformed of [
    { state: 'no_proxy', proxyPassword: 'stale' },
    { state: 'configured', proxyType: 'ftp', proxyHost: 'proxy.example', proxyPort: 21 },
    { state: 'configured', proxyType: 'http', proxyHost: 'proxy.example', proxyPort: 70000 },
    { state: 'configured', proxyType: 'http', proxyHost: 'bad host', proxyPort: 8080 },
    {
      state: 'configured',
      proxyType: 'http',
      proxyHost: 'proxy.example',
      proxyPort: 8080,
      proxyUser: '',
      proxyPassword: 'secret',
    },
  ]) {
    assert.equal(normalizeEnvironmentProxyAuthority(malformed), null);
  }
});

test('listAllEnvironments: 行映射为视图，assigneeCount = assignees 长度', async () => {
  const slowStartSince = new Date('2026-07-28T00:00:00+08:00');
  const pool = fakePool((sql) => {
    assert.match(sql, /FROM client_env_scope/); // 命中聚合 SELECT
    return {
      rows: [
        {
          env_key: 'p1', label: '大白', platform: 'xiaohongshu',
          slow_start_since: slowStartSince,
          assignees: [{ userId: 'u1', name: 'A' }],
        },
        {
          env_key: 'p2',
          label: null,
          platform: null,
          assignees: [{ userId: 'u2', name: 'B' }],
        },
      ],
    };
  });
  const store = new ClientUserStore({ schemaEnsurer: ensureCapabilitySchema, pool, automationReads: fakeAutomationReads() });
  const envs = await store.listAllEnvironments();
  assert.equal(envs.length, 2);
  assert.deepEqual(envs[0], {
    envKey: 'p1',
    environmentName: 'p1',
    label: '大白',
    platform: 'xiaohongshu',
    slowStart: { enabled: true, since: slowStartSince.getTime() },
    assignees: [{ userId: 'u1', name: 'A' }],
    assigneeCount: 1,
    cleanup: null,
    account: null,
    bindingObservedAt: null,
    installation: null,
    lifecycle: { state: 'active', requestId: null, requestedBy: null, requestedAt: null,
      resultKind: null, resultError: null, resultAt: null, deletedAt: null },
  });
  assert.equal(envs[1].assigneeCount, 1); // 全局唯一 active owner
  assert.deepEqual(
    envs[1].assignees.map((a) => a.name),
    ['B'],
  );
});

test('listAllEnvironments: json_agg 为 null 时回落空 assignees（count 0）', async () => {
  const pool = fakePool(() => ({ rows: [{ env_key: 'p3', label: null, platform: null, assignees: null }] }));
  const store = new ClientUserStore({ schemaEnsurer: ensureCapabilitySchema, pool, automationReads: fakeAutomationReads() });
  const [env] = await store.listAllEnvironments();
  assert.deepEqual(env.assignees, []);
  assert.equal(env.assigneeCount, 0);
});

test('listAllEnvironments: binding-missing hold 映射为不含伪 accountId 的 cleanup 真态', async () => {
  const requestedAt = new Date('2026-07-17T08:00:00Z');
  const pool = fakePool(() => ({ rows: [{
    env_key: 'wechat-env', label: '视频号', platform: 'wechat_channels', assignees: null,
    hold_id: '6f421ba8-b921-4c5d-bff2-65f330e3c227', hold_reason: 'admin_revoked',
    hold_requested_at: requestedAt,
  }] }));
  const store = new ClientUserStore({ schemaEnsurer: ensureCapabilitySchema, pool, automationReads: fakeAutomationReads() });
  const [env] = await store.listAllEnvironments();
  assert.deepEqual(env.cleanup, {
    kind: 'binding_missing', revocationId: '6f421ba8-b921-4c5d-bff2-65f330e3c227',
    envKey: 'wechat-env', state: 'binding_missing', reason: 'admin_revoked', requestedAt: requestedAt.getTime(),
  });
  assert.equal('accountId' in (env.cleanup ?? {}), false);
});

test('listAllEnvironments: 缺表(42P01)fail-closed 回落空数组，不抛', async () => {
  const pool = fakePool(() => {
    const err = new Error('relation "client_env_scope" does not exist') as Error & { code: string };
    err.code = '42P01';
    throw err;
  });
  const store = new ClientUserStore({ schemaEnsurer: ensureCapabilitySchema, pool, automationReads: fakeAutomationReads() });
  assert.deepEqual(await store.listAllEnvironments(), []);
});

test('listAllEnvironments: 非缺表错误照常抛出（不吞真故障）', async () => {
  const pool = fakePool(() => {
    const err = new Error('connection refused') as Error & { code: string };
    err.code = 'ECONNREFUSED';
    throw err;
  });
  const store = new ClientUserStore({ schemaEnsurer: ensureCapabilitySchema, pool, automationReads: fakeAutomationReads() });
  await assert.rejects(() => store.listAllEnvironments(), /connection refused/);
});

/**
 * Block③ 物理拆库 L3（读侧解耦）：automation 属主表（离场记录 / 微信互动授权绑定 / 风控态）
 * 的**顶层只读**改经 kernel 端口取投影，本 store 不再直连别域的库。
 *
 * 这一组锁的是「原来一条跨库 SQL 拆成本地读 + 端口取集合 + 本地合入」之后**语义没漂**：
 * 离场回执按 envKey 1:1 合入、风控态按 accountId 合入且缺行=null、候选筛选的序与截断不变、
 * 端口缺表与本地缺表同口径 fail-closed、端口未注入当场响亮报错。
 * 真 SQL 侧（并集 CTE 的 unnest 分支、GROUP BY 去掉 o.* 后的行数）仍靠真库核 → 真机 backlog 簇 61。
 */
test('listAllEnvironments: 离场回执取自端口投影，环境键并集把端口的 envKey 传进 $1', async () => {
  const requestedAt = new Date('2026-07-20T02:00:00Z');
  const purgeDueAt = new Date('2026-07-27T02:00:00Z');
  let seenParams: unknown[] | undefined;
  const pool = fakePool((sql, params) => {
    assert.match(sql, /SELECT unnest\(\$1::text\[\]\) AS env_key/); // 第四支环境键来自端口
    assert.doesNotMatch(sql, /interaction_offboards|risk_state/); // 本地 SQL 已无 automation 属主表
    seenParams = params;
    return { rows: [{ env_key: 'wechat-env', label: null, platform: null, assignees: null }] };
  });
  const store = new ClientUserStore({
    schemaEnsurer: ensureCapabilitySchema,
    pool,
    automationReads: fakeAutomationReads({
      activeWechatOffboards: async () => [{
        offboardId: 'ob-1', envKey: 'wechat-env', accountId: 'acct-1', state: 'dispatched',
        reason: 'admin_revoked', requestedAt: requestedAt.getTime(), purgeDueAt: purgeDueAt.getTime(),
      }],
    }),
  });
  const [env] = await store.listAllEnvironments();
  assert.deepEqual(seenParams, [['wechat-env']]);
  assert.deepEqual(env.cleanup, {
    kind: 'offboard_pending', offboardId: 'ob-1', envKey: 'wechat-env', accountId: 'acct-1',
    state: 'dispatched', reason: 'admin_revoked',
    requestedAt: requestedAt.getTime(), purgeDueAt: purgeDueAt.getTime(),
  });
});

test('listAllEnvironments: 风控态按 accountId 从端口合入；无风控行 = null（等价 LEFT JOIN）', async () => {
  let askedFor: string[] | undefined;
  const pool = fakePool(() => ({ rows: [
    { env_key: 'e1', assignees: null, account_id: 'acct-with-risk', account_platform: 'wechat_channels' },
    { env_key: 'e2', assignees: null, account_id: 'acct-no-risk', account_platform: 'wechat_channels' },
    // 悬空绑定：account_platform 为 null（accounts 无此行）⇒ 原查询链上也取不到风控态，不进批量入参。
    { env_key: 'e3', assignees: null, account_id: 'acct-dangling', account_platform: null },
  ] }));
  const store = new ClientUserStore({
    schemaEnsurer: ensureCapabilitySchema,
    pool,
    automationReads: fakeAutomationReads({
      riskStateProjection: async (ids) => {
        askedFor = ids;
        return [{ accountId: 'acct-with-risk', status: 'restricted', quotaLevel: 'conservative' }];
      },
    }),
  });
  const envs = await store.listAllEnvironments();
  assert.deepEqual(askedFor, ['acct-with-risk', 'acct-no-risk']);
  assert.equal(envs[0].account?.riskStatus, 'restricted');
  assert.equal(envs[0].account?.riskQuotaLevel, 'conservative');
  assert.equal(envs[1].account?.riskStatus, null);
  assert.equal(envs[1].account?.riskQuotaLevel, null);
  assert.equal(envs[2].account, null); // 悬空绑定照旧不产出账号块
});

test('listAllEnvironments: 端口侧缺表(42P01)与本地缺表同口径 fail-closed 回空', async () => {
  const store = new ClientUserStore({
    schemaEnsurer: ensureCapabilitySchema,
    pool: fakePool(() => ({ rows: [] })),
    automationReads: fakeAutomationReads({
      activeWechatOffboards: async () => {
        throw Object.assign(new Error('relation "interaction_offboards" does not exist'), { code: '42P01' });
      },
    }),
  });
  assert.deepEqual(await store.listAllEnvironments(), []);
});

test('getOffboard: 经端口取投影并映射为视图；端口无行 → null（本地池不参与）', async () => {
  const requestedAt = new Date('2026-07-21T03:00:00Z');
  const purgeDueAt = new Date('2026-07-28T03:00:00Z');
  // 台账命中时本地池不参与；台账没有时才回落去查本域准入表（那是「已受理、尚未物化」的唯一来源）。
  const localReads: string[] = [];
  const pool = fakePool((sql) => { localReads.push(sql); return { rows: [] }; });
  const seen: { offboardId: string; userId: string }[] = [];
  const store = new ClientUserStore({
    schemaEnsurer: ensureCapabilitySchema,
    pool,
    automationReads: fakeAutomationReads({
      offboardForUser: async (offboardId, userId) => {
        seen.push({ offboardId, userId });
        return offboardId === 'ob-1'
          ? { offboardId: 'ob-1', envKey: 'env-1', accountId: 'acct-1', state: 'pending_edge',
              reason: 'environment_unbind', requestedAt: requestedAt.getTime(), purgeDueAt: purgeDueAt.getTime() }
          : null;
      },
    }),
  });
  assert.deepEqual(await store.getOffboard('user-a', 'ob-1'), {
    offboardId: 'ob-1', envKey: 'env-1', accountId: 'acct-1', state: 'pending_edge',
    reason: 'environment_unbind', requestedAt: requestedAt.getTime(), purgeDueAt: purgeDueAt.getTime(),
  });
  assert.deepEqual(localReads, [], '台账命中时绝不触本地池');
  assert.equal(await store.getOffboard('user-a', 'ob-missing'), null);
  assert.equal(localReads.length, 1, '台账没有时回落查一次本域准入表');
  assert.match(localReads[0], /FROM client_env_revocation_holds/);
  // 归属过滤下推到属主侧：两个参数都原样带过去，绝不在本地放宽。
  assert.deepEqual(seen, [
    { offboardId: 'ob-1', userId: 'user-a' },
    { offboardId: 'ob-missing', userId: 'user-a' },
  ]);
});

test('hasPendingRevocationHold: 无微信绑定直接 false（不查本地池）；有绑定则按 envKey 查 hold', async () => {
  const noBinding = new ClientUserStore({
    schemaEnsurer: ensureCapabilitySchema,
    pool: fakePool(() => { throw new Error('无绑定时不该查本地池'); }),
    automationReads: fakeAutomationReads(),
  });
  assert.equal(await noBinding.hasPendingRevocationHold('acct-none'), false);

  let seenParams: unknown[] | undefined;
  const withBinding = new ClientUserStore({
    schemaEnsurer: ensureCapabilitySchema,
    pool: fakePool((sql, params) => {
      assert.match(sql, /FROM client_env_revocation_holds h/);
      assert.doesNotMatch(sql, /interaction_auth_state/); // 跨库 JOIN 已拆掉
      seenParams = params;
      return { rows: [{ present: true }] };
    }),
    automationReads: fakeAutomationReads({ wechatEnvKeysForAccount: async () => ['env-held'] }),
  });
  assert.equal(await withBinding.hasPendingRevocationHold('acct-late'), true);
  assert.deepEqual(seenParams, [['env-held']]);
});

test('automation 读端口未注入：跨域读当场抛具名错，绝不静默回落空集', async () => {
  const store = new ClientUserStore({
    schemaEnsurer: ensureCapabilitySchema,
    pool: fakePool(() => ({ rows: [] })),
  });
  await assert.rejects(() => store.getOffboard('u', 'ob'), /client_env_automation_read_port_not_configured/);
  await assert.rejects(() => store.hasPendingRevocationHold('acct'), /client_env_automation_read_port_not_configured/);
  await assert.rejects(() => store.listAllEnvironments(), /client_env_automation_read_port_not_configured/);
});

/* ───────────── Block③ L3 最终一致改造：环境清理**准入**（api 属主）侧 ───────────── */

/** 准入行的裸形状（client_env_revocation_holds 升格后的列）。 */
function admissionRow(over: Record<string, unknown> = {}) {
  return {
    revocation_id: 'rev-1', env_key: 'env-1', user_id: 'user-1', reason: 'admin_revoked',
    revoked_by: 'admin', offboard_id: 'ob-1', unbound_terminal_ok: false,
    materialized_at: null, requested_at: new Date(1_000), ...over,
  };
}

test('setScope 的清理闸只读本域准入表：一行即拒，materialized_at 决定原因码（尚未物化）', async () => {
  const seen: string[] = [];
  const client = {
    query: async (sql: string) => {
      seen.push(sql);
      if (/FROM client_users WHERE user_id/.test(sql)) return { rows: [{ '?column?': 1 }], rowCount: 1 };
      if (/FROM client_env_revocation_holds/.test(sql)) {
        return { rows: [{ env_key: 'env-1', materialized_at: null }], rowCount: 1 };
      }
      if (/FROM client_environments\s+WHERE env_key = ANY/.test(sql)) {
        return { rows: [{ env_key: 'env-1', label: null, platform: 'wechat_channels' }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    },
    release() {},
  };
  const pool = { connect: async () => client, query: async () => ({ rows: [] }) } as unknown as pg.Pool;
  const store = new ClientUserStore({ schemaEnsurer: ensureCapabilitySchema, pool,
    automationReads: fakeAutomationReads() });
  assert.deepEqual(await store.setScope('user-1', [{ envKey: 'env-1' }], 'admin'),
    { ok: false, reason: 'cleanup_in_progress', envKey: 'env-1' });
  // 这道闸改造前要去锁 automation 的 interaction_offboards（跨库行锁，拆库后无声失效）。
  assert.ok(!seen.some((sql) => sql.includes('interaction_offboards')), '闸不得再碰属主的离场台账');
  assert.equal(seen[seen.length - 1], 'ROLLBACK');
});

test('setScope 的清理闸：已物化的准入回 offboard_in_progress（原因码不退化）', async () => {
  const client = {
    query: async (sql: string) => {
      if (/FROM client_users WHERE user_id/.test(sql)) return { rows: [{ '?column?': 1 }], rowCount: 1 };
      if (/FROM client_env_revocation_holds/.test(sql)) {
        return { rows: [{ env_key: 'env-1', materialized_at: new Date(2_000) }], rowCount: 1 };
      }
      if (/FROM client_environments\s+WHERE env_key = ANY/.test(sql)) {
        return { rows: [{ env_key: 'env-1', label: null, platform: 'wechat_channels' }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    },
    release() {},
  };
  const pool = { connect: async () => client, query: async () => ({ rows: [] }) } as unknown as pg.Pool;
  const store = new ClientUserStore({ schemaEnsurer: ensureCapabilitySchema, pool,
    automationReads: fakeAutomationReads() });
  assert.deepEqual(await store.setScope('user-1', [{ envKey: 'env-1' }], 'admin'),
    { ok: false, reason: 'offboard_in_progress', envKey: 'env-1' });
});

test('getOffboard：台账还没写成时答「已受理、尚未物化」，绝不 404；accountId / purgeDueAt 为 null 而非编造', async () => {
  const store = new ClientUserStore({
    schemaEnsurer: ensureCapabilitySchema,
    pool: fakePool((sql) => {
      assert.match(sql, /FROM client_env_revocation_holds/);
      assert.match(sql, /materialized_at IS NULL/);
      return { rows: [admissionRow()] };
    }),
    automationReads: fakeAutomationReads({ offboardForUser: async () => null }),
  });
  assert.deepEqual(await store.getOffboard('user-1', 'ob-1'), {
    offboardId: 'ob-1', envKey: 'env-1', accountId: null, state: 'accepted',
    reason: 'admin_revoked', requestedAt: 1_000, purgeDueAt: null,
  });
});

test('getOffboard：既无台账也无准入才回 null（真正的 not_found 仍是 not_found）', async () => {
  const store = new ClientUserStore({
    schemaEnsurer: ensureCapabilitySchema,
    pool: fakePool(() => ({ rows: [] })),
    automationReads: fakeAutomationReads({ offboardForUser: async () => null }),
  });
  assert.equal(await store.getOffboard('user-1', 'ob-x'), null);
});

test('物化失败方向：属主不可达时回执降级为 accepted、不写 materialized_at，绝不假装已清理', async () => {
  const writes: string[] = [];
  let admissionParams: unknown[] | undefined;
  const client = {
    query: async (sql: string, params?: unknown[]) => {
      if (/FROM client_users WHERE user_id/.test(sql)) return { rows: [{ status: 'enabled' }], rowCount: 1 };
      if (/FROM client_environments WHERE env_key = \$1 FOR UPDATE/.test(sql)) return { rows: [{ '?column?': 1 }], rowCount: 1 };
      if (/FROM client_env_scope s/.test(sql)) {
        return { rows: [{ label: null, platform: 'wechat_channels', source: 'admin',
          assigned_by: 'admin', assigned_at: new Date(0) }], rowCount: 1 };
      }
      if (/INSERT INTO client_env_revocation_holds/.test(sql)) {
        admissionParams = params;
        assert.match(
          sql,
          /WHERE client_env_revocation_holds\.execution_target=EXCLUDED\.execution_target/,
        );
        return { rows: [admissionRow({ reason: 'environment_unbind' })], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    },
    release() {},
  };
  const pool = {
    connect: async () => client,
    query: async (sql: string) => { writes.push(sql); return { rows: [] }; },
  } as unknown as pg.Pool;
  const store = new ClientUserStore({
    schemaEnsurer: ensureCapabilitySchema, pool,
    executionTarget: 'dev',
    automationReads: fakeAutomationReads({ boundAccountForEnv: async () => 'acct-1' }),
    offboardMaterialization: {
      materializeEnvironmentOffboard: async () => { throw new Error('automation_unreachable'); },
    },
  });
  const result = await store.beginEnvironmentOffboard('user-1', 'env-1');
  assert.ok(result.ok);
  assert.equal(result.offboard.state, 'accepted');
  assert.equal(result.offboard.accountId, null);
  assert.equal(admissionParams?.[7], 'dev', 'new durable admission must persist server target');
  assert.ok(!writes.some((sql) => sql.includes('materialized_at=now()')), '没物化就绝不盖回执');
});

test('新离场准入缺少 server target 时整笔回滚，不写 NULL durable work', async () => {
  const seen: string[] = [];
  const client = {
    query: async (sql: string) => {
      seen.push(sql);
      if (/FROM client_users WHERE user_id/.test(sql)) {
        return { rows: [{ status: 'enabled' }], rowCount: 1 };
      }
      if (/FROM client_environments WHERE env_key = \$1 FOR UPDATE/.test(sql)) {
        return { rows: [{ '?column?': 1 }], rowCount: 1 };
      }
      if (/FROM client_env_scope s/.test(sql)) {
        return {
          rows: [{
            label: null,
            platform: 'wechat_channels',
            source: 'admin',
            assigned_by: 'admin',
            assigned_at: new Date(0),
          }],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 0 };
    },
    release() {},
  };
  const pool = {
    connect: async () => client,
    query: async () => ({ rows: [] }),
  } as unknown as pg.Pool;
  const store = new ClientUserStore({
    schemaEnsurer: ensureCapabilitySchema,
    pool,
    automationReads: fakeAutomationReads({ boundAccountForEnv: async () => 'acct-1' }),
  });

  await assert.rejects(
    () => store.beginEnvironmentOffboard('user-1', 'env-1'),
    /offboard_admission_execution_target_not_configured/,
  );
  assert.ok(!seen.some((sql) => sql.includes('INSERT INTO client_env_revocation_holds')));
  assert.equal(seen[seen.length - 1], 'ROLLBACK');
});

test('beginEnvironmentOffboard：确无绑定且非自助建号时仍然拒绝（归属不撤、准入不写）', async () => {
  const seen: string[] = [];
  const client = {
    query: async (sql: string) => {
      seen.push(sql);
      if (/FROM client_users WHERE user_id/.test(sql)) return { rows: [{ status: 'enabled' }], rowCount: 1 };
      if (/FROM client_environments WHERE env_key = \$1 FOR UPDATE/.test(sql)) return { rows: [{ '?column?': 1 }], rowCount: 1 };
      if (/FROM client_env_scope s/.test(sql)) {
        return { rows: [{ label: null, platform: 'wechat_channels', source: 'admin',
          assigned_by: 'admin', assigned_at: new Date(0) }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 }; // provisioning intent 不命中
    },
    release() {},
  };
  const pool = { connect: async () => client, query: async () => ({ rows: [] }) } as unknown as pg.Pool;
  const store = new ClientUserStore({ schemaEnsurer: ensureCapabilitySchema, pool,
    automationReads: fakeAutomationReads({ boundAccountForEnv: async () => null }) });
  assert.deepEqual(await store.beginEnvironmentOffboard('user-1', 'env-1'),
    { ok: false, reason: 'offboard_binding_missing' });
  assert.ok(!seen.some((sql) => sql.includes('INSERT INTO client_env_revocation_holds')), '拒绝路径不写准入');
  assert.ok(!seen.some((sql) => sql.includes('DELETE FROM client_env_scope')), '拒绝路径不撤归属');
  assert.equal(seen[seen.length - 1], 'ROLLBACK');
});

test('beginEnvironmentOffboard：绑定读失败 MUST 抛，绝不降级成「没绑定」再往下走', async () => {
  const store = new ClientUserStore({
    schemaEnsurer: ensureCapabilitySchema,
    pool: fakePool(() => ({ rows: [] })),
    automationReads: fakeAutomationReads({
      boundAccountForEnv: async () => { throw new Error('automation_read_down'); },
    }),
  });
  await assert.rejects(() => store.beginEnvironmentOffboard('user-1', 'env-1'), /automation_read_down/);
});

test('对账循环：属主投影读不到时整轮抛出，绝不把空集当「一条都没有」去删准入行', async () => {
  const statements: string[] = [];
  const store = new ClientUserStore({
    schemaEnsurer: ensureCapabilitySchema,
    executionTarget: 'dev',
    pool: fakePool((sql) => { statements.push(sql); return { rows: [] }; }),
    automationReads: fakeAutomationReads({
      activeWechatOffboards: async () => { throw new Error('automation_read_down'); },
    }),
  });
  await assert.rejects(() => store.reconcileCleanupAdmissions(), /automation_read_down/);
  assert.deepEqual(statements, [], '读不到属主投影就一条本域写都不许发');
});

test('对账循环：认领属主台账里没被记上的清理，释放已清除的准入，重放尚未物化的准入', async () => {
  const statements: { sql: string; params?: unknown[] }[] = [];
  const materialized: string[] = [];
  const store = new ClientUserStore({
    schemaEnsurer: ensureCapabilitySchema,
    executionTarget: 'dev',
    pool: fakePool((sql, params) => {
      statements.push({ sql, params });
      if (/FROM client_env_revocation_holds\s+WHERE materialized_at IS NULL/.test(sql)) {
        return { rows: [admissionRow({ env_key: 'env-pending', offboard_id: 'ob-pending' })] };
      }
      return { rows: [] };
    }),
    automationReads: fakeAutomationReads({
      activeWechatOffboards: async () => [{
        offboardId: 'ob-live', envKey: 'env-live', accountId: 'acct-live',
        state: 'pending_edge', reason: 'admin_revoked', requestedAt: 1_000, purgeDueAt: 2_000,
      }],
    }),
    offboardMaterialization: {
      materializeEnvironmentOffboard: async (input) => {
        materialized.push(input.offboardId);
        return { materialized: true, offboard: {
          offboardId: input.offboardId, envKey: input.envKey, accountId: 'acct-pending',
          state: 'pending_edge', reason: input.reason, requestedAt: 1_000, purgeDueAt: 2_000,
        } };
      },
    },
  });
  const out = await store.reconcileCleanupAdmissions();
  const adopt = statements.find((s) => s.sql.includes('INSERT INTO client_env_revocation_holds'));
  assert.ok(adopt && adopt.sql.includes('ON CONFLICT (env_key) DO NOTHING'), '认领不覆盖既有准入');
  assert.deepEqual((adopt!.params ?? [])[0], ['env-live']);
  const release = statements.find((s) => s.sql.includes('DELETE FROM client_env_revocation_holds'));
  assert.ok(release && release.sql.includes('materialized_at IS NOT NULL'), '只释放已物化的准入');
  assert.deepEqual((release!.params ?? [])[0], ['env-live'], '仍在台账里的环境不许被释放');
  assert.equal((release!.params ?? [])[1], 'dev', 'durable reconcile 只释放本 target admission');
  assert.deepEqual(materialized, ['ob-pending']);
  assert.deepEqual(out.map((o) => [o.envKey, o.accountId]), [['env-pending', 'acct-pending']]);
  assert.ok(statements.some((s) => s.sql.includes('materialized_at=now()')), '物化成功要盖回执');
});

/**
 * client-user-env-registry：`registerEnvironments`（环境注册表写路径）。锁我这段映射逻辑——
 * 去空白 / 去重 / 跳空 envKey / 空串归 null / source 透传 / 每条一次 upsert / 返回去重条数。
 * 真 upsert 的 COALESCE 不覆盖既有非空值、并集 listAllEnvironments 列出未分配环境等 SQL 语义靠真库核（簇 61）。
 */
function recordingPool() {
  const calls: { sql: string; params?: unknown[] }[] = [];
  const pool = {
    query: async (sql: string, params?: unknown[]) => {
      calls.push({ sql, params });
      return { rows: [] };
    },
  } as unknown as pg.Pool;
  return { pool, calls };
}

test('registerEnvironments: 去空白 + 去重 + 跳空，每条一次 upsert，返回去重条数', async () => {
  const { pool, calls } = recordingPool();
  const store = new ClientUserStore({ schemaEnsurer: ensureCapabilitySchema, pool });
  const n = await store.registerEnvironments([
    { envKey: ' k1 ', label: ' 大白 ', platform: 'xiaohongshu' },
    { envKey: 'k1', label: '重复应被去重' }, // 同 envKey → 去重
    { envKey: '', label: '空跳过' }, // 空 envKey → 跳过
    { envKey: 'k2', label: '', platform: '' }, // 空串 label/platform → null
  ]);
  assert.equal(n, 2);
  assert.equal(calls.length, 2);
  assert.match(calls[0].sql, /INSERT INTO client_environments/);
  // 第 5 个参数 = account_id 绑定（change curated-envkey-account-binding）；无 accountId 的 item → null（不动既有绑定）。
  assert.deepEqual(calls[0].params, ['k1', '大白', 'xiaohongshu', 'import', null]); // trim + 默认 source=import
  assert.deepEqual(calls[1].params, ['k2', null, null, 'import', null]); // 空串归一为 null
});

test('registerEnvironments: 全空输入 → 0 次写、返回 0（绝不误发空 upsert）', async () => {
  const { pool, calls } = recordingPool();
  const store = new ClientUserStore({ schemaEnsurer: ensureCapabilitySchema, pool });
  const n = await store.registerEnvironments([{ envKey: '  ' }, { envKey: '' }]);
  assert.equal(n, 0);
  assert.equal(calls.length, 0);
});

test('registerEnvironments: source 显式传 auto 透传到参数（自动登记路径）', async () => {
  const { pool, calls } = recordingPool();
  const store = new ClientUserStore({ schemaEnsurer: ensureCapabilitySchema, pool });
  await store.registerEnvironments([{ envKey: 'k9' }], 'auto');
  assert.deepEqual(calls[0].params, ['k9', null, null, 'auto', null]);
});

// change env-table-write-collection：环境花名册窄回写口的 api 侧实现。锁「单条观测 → 恰一次 source='auto'
// upsert，各字段逐字转发」——automation 握手经 EnvironmentRegistryPort 只调这个方法，绝不直写该表。
test('registerHandshakeEnvironment: 单条观测走一次 auto upsert，字段逐字转发', async () => {
  const { pool, calls } = recordingPool();
  const store = new ClientUserStore({ schemaEnsurer: ensureCapabilitySchema, pool });
  await store.registerHandshakeEnvironment({ envKey: 'ok9', label: '大白', platform: 'facebook', accountId: null });
  assert.equal(calls.length, 1);
  assert.match(calls[0].sql, /INSERT INTO client_environments/);
  assert.deepEqual(calls[0].params, ['ok9', '大白', 'facebook', 'auto', null]);
});

test('environment handshake authority: owner 登记提交后才触发 persona auto-fill', async () => {
  const trace: string[] = [];
  const port = createEnvironmentHandshakeAuthority(
    {
      registerHandshakeEnvironment: async (observation) => {
        trace.push(`registered:${observation.envKey}`);
      },
    },
    async (envKey) => {
      trace.push(`persona:${envKey}`);
    },
  );
  await port.registerHandshakeEnvironment({
    envKey: 'env-1',
    label: '一号环境',
    platform: 'facebook',
    accountId: 'account-1',
  });
  assert.deepEqual(trace, ['registered:env-1', 'persona:env-1']);
});

test('environment handshake authority: owner 登记失败时不触发 persona auto-fill', async () => {
  let personaCalls = 0;
  const port = createEnvironmentHandshakeAuthority(
    {
      registerHandshakeEnvironment: async () => {
        throw new Error('registry_write_failed');
      },
    },
    async () => {
      personaCalls += 1;
    },
  );
  await assert.rejects(
    () => port.registerHandshakeEnvironment({
      envKey: 'env-1',
      label: null,
      platform: null,
      accountId: null,
    }),
    /registry_write_failed/,
  );
  assert.equal(personaCalls, 0);
});

test('ownsEnv: user A only owns rows explicitly scoped to user A', async () => {
  const pool = fakePool((sql, params) => {
    assert.match(sql, /WHERE s\.user_id = \$1 AND s\.env_key = \$2/);
    assert.match(sql, /source = 'admin'/);
    assert.match(sql, /e\.lifecycle_state = 'active'/);
    return { rows: [{ owned: params?.[0] === 'user-a' && params?.[1] === 'env-a' }] };
  });
  const store = new ClientUserStore({ schemaEnsurer: ensureCapabilitySchema, pool });
  assert.equal(await store.ownsEnv('user-a', 'env-a'), true);
  assert.equal(await store.ownsEnv('user-a', 'env-b'), false);
  assert.equal(await store.ownsEnv('user-b', 'env-a'), false);
});

test('ownsEnv: missing ownership table fails closed', async () => {
  const pool = fakePool(() => {
    const err = new Error('relation "client_env_scope" does not exist') as Error & { code: string };
    err.code = '42P01';
    throw err;
  });
  const store = new ClientUserStore({ schemaEnsurer: ensureCapabilitySchema, pool });
  assert.equal(await store.ownsEnv('user-a', 'env-a'), false);
});

test('schema archives and removes legacy customer claims, then enforces one authoritative owner per env', () => {
  assert.match(CLIENT_USERS_SCHEMA_SQL, /INSERT INTO client_env_scope_audit[\s\S]*legacy_self_claim/);
  assert.match(CLIENT_USERS_SCHEMA_SQL, /DELETE FROM client_env_scope WHERE source = 'client'/);
  assert.match(CLIENT_USERS_SCHEMA_SQL, /client_env_scope_authoritative_source[\s\S]*CHECK \(source = 'admin'\)/);
  assert.match(CLIENT_USERS_SCHEMA_SQL, /CREATE UNIQUE INDEX IF NOT EXISTS uq_client_env_scope_active_env/);
  assert.match(CLIENT_USERS_SCHEMA_SQL, /ON client_env_scope \(env_key\)/);
  assert.match(CLIENT_USERS_SCHEMA_SQL, /CREATE TABLE IF NOT EXISTS client_env_provisioning_intents/);
  assert.match(CLIENT_USERS_SCHEMA_SQL, /proof_hash\s+CHAR\(64\)\s+NOT NULL/);
  assert.match(CLIENT_USERS_SCHEMA_SQL, /state IN \('pending','completed','expired'\)/);
  assert.match(CLIENT_USERS_SCHEMA_SQL, /CREATE TABLE IF NOT EXISTS client_environment_installations/);
  assert.match(CLIENT_USERS_SCHEMA_SQL, /CREATE TABLE IF NOT EXISTS client_environment_deletion_requests/);
  assert.match(CLIENT_USERS_SCHEMA_SQL, /state IN \('waiting_edge','deleting','delete_failed','deleted'\)/);
  assert.match(CLIENT_USERS_SCHEMA_SQL, /client_environment_deletion_active_idx/);
  // PK 单值（change slow-start-offline-toggle，迁移自已删除的 ws-server-resolve-account「多账号即拒绝猜测」）：
  // client_environments.env_key 是主键 ⇒ 一个环境至多一行 ⇒ 至多一个绑定账号 ⇒「同一环境解析出多个账号、
  // 须拒绝猜测」的路径**结构上不存在**。这正是慢启动写路由从活会话反查改到持久绑定后歧义消失的根据。
  assert.match(CLIENT_USERS_SCHEMA_SQL, /CREATE TABLE IF NOT EXISTS client_environments\s*\([\s\S]*?env_key\s+TEXT\s+PRIMARY KEY/);
  assert.match(CLIENT_USERS_SCHEMA_SQL, /CREATE TABLE IF NOT EXISTS client_env_revocation_holds/);
  assert.match(CLIENT_USERS_SCHEMA_SQL, /env_key\s+TEXT\s+NOT NULL UNIQUE/);
  assert.match(
    CLIENT_USERS_SCHEMA_SQL,
    /execution_target\s+TEXT\s+NOT NULL CHECK \(execution_target IN \('dev','ol'\)\)/,
  );
  assert.match(CLIENT_USERS_SCHEMA_SQL, /client_env_scope_cleanup_hold_guard/);
  assert.match(CLIENT_USERS_SCHEMA_SQL, /CONSTRAINT = 'client_env_scope_cleanup_hold'/);
});

test('completeProvisioningIntent rejects malformed intent/proof before touching PostgreSQL', async () => {
  const pool = fakePool(() => {
    assert.fail('malformed provisioning credentials must fail before any query');
  });
  const store = new ClientUserStore({ schemaEnsurer: ensureCapabilitySchema, pool });
  assert.deepEqual(await store.completeProvisioningIntent('user-a', {
    intentId: 'not-a-uuid', proof: 'short', envKey: 'fresh-env', platform: 'facebook',
    proxyAuthority: { state: 'no_proxy' },
  }), { ok: false, reason: 'invalid_intent' });
});

test('completeProvisioningIntent atomically stores Facebook slow start at Shanghai day start', async () => {
  const intentId = '11111111-1111-4111-8111-111111111111';
  const proof = 'A'.repeat(43);
  const proofHash = createHash('sha256').update(proof, 'utf8').digest('hex');
  const calls: { sql: string; params?: unknown[] }[] = [];
  const assignedAt = new Date();
  const client = {
    query: async (sql: string, params?: unknown[]) => {
      calls.push({ sql, params });
      if (/SELECT status FROM client_users/.test(sql)) return { rows: [{ status: 'enabled' }] };
      if (/FROM client_env_provisioning_intents/.test(sql)) return { rows: [{
        proof_hash: proofHash,
        state: 'pending',
        expires_at: new Date(Date.now() + 60_000),
        completed_env_key: null,
        completed_at: null,
      }] };
      if (/INSERT INTO client_environments/.test(sql)) return { rows: [{ env_key: 'fb-new' }] };
      if (/INSERT INTO client_env_scope/.test(sql)) return { rows: [{
        env_key: 'fb-new', label: 'FB new', platform: 'facebook', assigned_at: assignedAt,
      }] };
      return { rows: [] };
    },
    release() {},
  };
  const pool = { connect: async () => client } as unknown as pg.Pool;
  const before = Date.now();
  const result = await new ClientUserStore({ schemaEnsurer: ensureCapabilitySchema, pool }).completeProvisioningIntent('user-a', {
    intentId, proof, envKey: 'fb-new', label: 'FB new', platform: 'facebook', slowStartEnabled: true,
    proxyAuthority: {
      state: 'configured',
      proxyType: 'http',
      proxyHost: 'proxy.example',
      proxyPort: 8080,
      proxyUser: 'proxy-user',
      proxyPassword: 'plain-proxy-password',
    },
  });
  const after = Date.now();
  assert.equal(result.ok, true);
  const insert = calls.find((call) => /INSERT INTO client_environments/.test(call.sql))!;
  assert.match(insert.sql, /slow_start_since,slow_start_initialized/);
  assert.match(insert.sql, /VALUES \(\$1,\$2,\$2,\$3,'auto',\$4,true,now\(\),now\(\)\)/);
  const stored = insert.params?.[3] as Date;
  assert.ok(stored instanceof Date);
  assert.ok(stored.getTime() >= shanghaiDayStartMs(before));
  assert.ok(stored.getTime() <= shanghaiDayStartMs(after));
  const proxyInsert = calls.find((call) => /INSERT INTO client_environment_proxy_authorities/.test(call.sql))!;
  assert.deepEqual(proxyInsert.params, [
    'fb-new', 'configured', 'http', 'proxy.example', 8080,
    'proxy-user', 'plain-proxy-password', 'user-a',
  ]);
  assert.ok(calls.some((call) => call.sql === 'COMMIT'));
});

test('completeProvisioningIntent rejects non-Facebook slow start before PostgreSQL', async () => {
  const pool = { connect: async () => assert.fail('non-Facebook slow start must fail before PostgreSQL') } as unknown as pg.Pool;
  const result = await new ClientUserStore({ schemaEnsurer: ensureCapabilitySchema, pool }).completeProvisioningIntent('user-a', {
    intentId: '11111111-1111-4111-8111-111111111111',
    proof: 'A'.repeat(43),
    envKey: 'xhs-new',
    platform: 'xiaohongshu',
    slowStartEnabled: true,
    proxyAuthority: { state: 'no_proxy' },
  });
  assert.deepEqual(result, { ok: false, reason: 'invalid_environment' });
});

/**
 * change environment-level-rule-mode-and-approval —— 归属完成接口的两个新创建意图。
 * 三条闸（平台门禁 / 枚举合法 / 互斥）MUST 都在**注册环境之前**判定，拒绝时一条 SQL 都不发。
 */
function provisioningClient(calls: { sql: string; params?: unknown[] }[], proofHash: string) {
  return {
    query: async (sql: string, params?: unknown[]) => {
      calls.push({ sql, params });
      if (/SELECT status FROM client_users/.test(sql)) return { rows: [{ status: 'enabled' }] };
      if (/FROM client_env_provisioning_intents/.test(sql)) return { rows: [{
        proof_hash: proofHash,
        state: 'pending',
        expires_at: new Date(Date.now() + 60_000),
        completed_env_key: null,
        completed_at: null,
      }] };
      if (/INSERT INTO client_environments/.test(sql)) return { rows: [{ env_key: 'fb-new' }] };
      if (/INSERT INTO client_env_scope/.test(sql)) return { rows: [{
        env_key: 'fb-new', label: 'FB new', platform: 'facebook', assigned_at: new Date(),
      }] };
      return { rows: [] };
    },
    release() {},
  };
}

test('创建意图：规则模式 + 免审与环境登记、归属、intent 完成态同一事务落库，且慢启动保持 NULL', async () => {
  const intentId = '11111111-1111-4111-8111-111111111111';
  const proof = 'A'.repeat(43);
  const proofHash = createHash('sha256').update(proof, 'utf8').digest('hex');
  const calls: { sql: string; params?: unknown[] }[] = [];
  const bumps: string[] = [];
  const pool = { connect: async () => provisioningClient(calls, proofHash) } as unknown as pg.Pool;
  const result = await new ClientUserStore({
    schemaEnsurer: ensureCapabilitySchema,
    pool,
    mirrorVersionBumper: {
      bumpDomain: 'api',
      bumpInTx: async (_client, mirrorKey: string) => { bumps.push(mirrorKey); },
    },
  }).completeProvisioningIntent('user-a', {
    intentId, proof, envKey: 'fb-new', label: 'FB new', platform: 'facebook',
    facebookRuleModeEnabled: true,
    commentApprovalMode: 'auto_approve_all',
    proxyAuthority: { state: 'no_proxy' },
  });
  assert.equal(result.ok, true);

  const envInsert = calls.find((call) => /INSERT INTO client_environments/.test(call.sql))!;
  assert.equal(envInsert.params?.[3], null, '未提交慢启动意图时 slow_start_since MUST 保持 NULL');

  const ruleInsert = calls.find(
    (call) => /INSERT INTO facebook_rule_mode_environment_config/.test(call.sql),
  )!;
  assert.equal(ruleInsert.params?.[0], 'fb-new');
  assert.match(ruleInsert.sql, /VALUES \(\$1,true,/);
  assert.equal(ruleInsert.params?.[3], `client-provision:${intentId}`);

  const approvalInsert = calls.find(
    (call) => /INSERT INTO environment_comment_approval_policy/.test(call.sql),
  )!;
  assert.deepEqual(approvalInsert.params, ['fb-new', 'auto_approve_all', `client-provision:${intentId}`]);

  // 两条写都排在 COMMIT 之前 = 同一事务。
  const commitIndex = calls.findIndex((call) => call.sql === 'COMMIT');
  assert.ok(calls.indexOf(ruleInsert) < commitIndex);
  assert.ok(calls.indexOf(approvalInsert) < commitIndex);
  assert.ok(bumps.includes('content_schedule'), '规则模式落库必须同事务推进配置镜像版本');
});

test('创建意图：省略两个字段的旧客户端请求保持兼容，一行配置都不写', async () => {
  const intentId = '11111111-1111-4111-8111-111111111111';
  const proof = 'A'.repeat(43);
  const proofHash = createHash('sha256').update(proof, 'utf8').digest('hex');
  const calls: { sql: string; params?: unknown[] }[] = [];
  const pool = { connect: async () => provisioningClient(calls, proofHash) } as unknown as pg.Pool;
  const result = await new ClientUserStore({ schemaEnsurer: ensureCapabilitySchema, pool })
    .completeProvisioningIntent('user-a', {
      intentId, proof, envKey: 'fb-new', label: 'FB new', platform: 'facebook',
      proxyAuthority: { state: 'no_proxy' },
    });
  assert.equal(result.ok, true);
  assert.equal(
    calls.some((call) => /INSERT INTO facebook_rule_mode_environment_config/.test(call.sql)),
    false,
    '不写一行 enabled=false 的配置：「没有行」才是「未配置」的权威表达',
  );
  assert.equal(
    calls.some((call) => /INSERT INTO environment_comment_approval_policy/.test(call.sql)),
    false,
  );
});

test('创建意图：慢启动与规则模式同时为真整请求拒绝，MUST NOT 静默取其一', async () => {
  const pool = { connect: async () => assert.fail('互斥意图 MUST 在触库前被拒绝') } as unknown as pg.Pool;
  assert.deepEqual(
    await new ClientUserStore({ schemaEnsurer: ensureCapabilitySchema, pool })
      .completeProvisioningIntent('user-a', {
        intentId: '11111111-1111-4111-8111-111111111111',
        proof: 'A'.repeat(43),
        envKey: 'fb-new',
        platform: 'facebook',
        slowStartEnabled: true,
        facebookRuleModeEnabled: true,
        proxyAuthority: { state: 'no_proxy' },
      }),
    { ok: false, reason: 'conflicting_run_mode' },
  );
});

test('创建意图：非 Facebook 平台携带规则模式或免审字段整请求拒绝', async () => {
  const pool = { connect: async () => assert.fail('非 Facebook 意图 MUST 在触库前被拒绝') } as unknown as pg.Pool;
  const store = new ClientUserStore({ schemaEnsurer: ensureCapabilitySchema, pool });
  const base = {
    intentId: '11111111-1111-4111-8111-111111111111',
    proof: 'A'.repeat(43),
    envKey: 'xhs-new',
    platform: 'xiaohongshu',
    proxyAuthority: { state: 'no_proxy' } as unknown,
  };
  assert.deepEqual(
    await store.completeProvisioningIntent('user-a', { ...base, facebookRuleModeEnabled: true }),
    { ok: false, reason: 'invalid_environment' },
  );
  assert.deepEqual(
    await store.completeProvisioningIntent('user-a', { ...base, commentApprovalMode: 'auto_approve_all' }),
    { ok: false, reason: 'invalid_environment' },
  );
});

test('创建意图：非法审批枚举在触库前拒绝', async () => {
  const pool = { connect: async () => assert.fail('非法枚举 MUST 在触库前被拒绝') } as unknown as pg.Pool;
  assert.deepEqual(
    await new ClientUserStore({ schemaEnsurer: ensureCapabilitySchema, pool })
      .completeProvisioningIntent('user-a', {
        intentId: '11111111-1111-4111-8111-111111111111',
        proof: 'A'.repeat(43),
        envKey: 'fb-new',
        platform: 'facebook',
        commentApprovalMode: 'auto_approve',
        proxyAuthority: { state: 'no_proxy' },
      }),
    { ok: false, reason: 'invalid_environment' },
  );
});

test('创建意图：已完成 intent 的幂等重试只回既成归属，MUST NOT 二次写配置', async () => {
  const intentId = '11111111-1111-4111-8111-111111111111';
  const proof = 'A'.repeat(43);
  const proofHash = createHash('sha256').update(proof, 'utf8').digest('hex');
  const calls: { sql: string; params?: unknown[] }[] = [];
  const client = {
    query: async (sql: string, params?: unknown[]) => {
      calls.push({ sql, params });
      if (/SELECT status FROM client_users/.test(sql)) return { rows: [{ status: 'enabled' }] };
      if (/FROM client_env_provisioning_intents/.test(sql)) return { rows: [{
        proof_hash: proofHash,
        state: 'completed',
        expires_at: new Date(Date.now() + 60_000),
        completed_env_key: 'fb-new',
        completed_at: new Date(),
      }] };
      if (/FROM client_env_scope/.test(sql)) return { rows: [{
        env_key: 'fb-new', label: 'FB new', platform: 'facebook', assigned_at: new Date(0),
      }] };
      if (/FROM client_environment_proxy_authorities/.test(sql)) return { rows: [{
        env_key: 'fb-new', state: 'no_proxy', proxy_type: null, proxy_host: null, proxy_port: null,
        proxy_user: null, proxy_password: null, revision: 1, source: 'provisioning', updated_at: new Date(0),
      }] };
      return { rows: [] };
    },
    release() {},
  };
  const pool = { connect: async () => client } as unknown as pg.Pool;
  const result = await new ClientUserStore({ schemaEnsurer: ensureCapabilitySchema, pool })
    .completeProvisioningIntent('user-a', {
      intentId, proof, envKey: 'fb-new', platform: 'facebook',
      facebookRuleModeEnabled: true,
      commentApprovalMode: 'auto_approve_all',
      proxyAuthority: { state: 'no_proxy' },
    });
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.idempotent, true);
  // 运营在首次完成后手动改过配置时，陈旧重试 MUST NOT 把它复原成创建时的值。
  for (const table of [
    'facebook_rule_mode_environment_config',
    'environment_comment_approval_policy',
    'client_environments',
  ]) {
    assert.equal(
      calls.some((call) => new RegExp(`INSERT INTO ${table}`).test(call.sql)),
      false,
      `${table} MUST NOT 被幂等重试再写一次`,
    );
  }
});

/**
 * 账号 → 唯一绑定环境的反查镜像（本 change 新增）。三条判据：
 * 唯一绑定才解析得出；多环境 = 绑定冲突；同一环境归属多客户 = 跨客户争用。
 * 慢启动那份镜像的语义**逐位不变**（它只看环境个数），本 change 不动它。
 */
test('账号→环境反查：唯一绑定解析成功，多环境与跨客户争用都 fail-closed', async () => {
  const pool = fakePool((sql) => {
    if (/FROM client_environments e/.test(sql) && /owner_count/.test(sql)) {
      return { rows: [
        { env_key: 'env-solo', account_id: 'acct-solo', slow_start_since: null, owner_count: 1 },
        { env_key: 'env-a', account_id: 'acct-dup', slow_start_since: null, owner_count: 1 },
        { env_key: 'env-b', account_id: 'acct-dup', slow_start_since: null, owner_count: 1 },
        { env_key: 'env-shared', account_id: 'acct-contended', slow_start_since: null, owner_count: 2 },
      ] };
    }
    return { rows: [] };
  });
  const store = new ClientUserStore({ schemaEnsurer: ensureCapabilitySchema, pool });
  await store.refreshEnvironmentSlowStartMirror();

  assert.deepEqual(store.resolveEnvironmentKeyForAccount('acct-solo'), { ok: true, envKey: 'env-solo' });
  assert.deepEqual(
    store.resolveEnvironmentKeyForAccount('acct-dup'),
    { ok: false, reason: 'binding_conflict' },
  );
  assert.deepEqual(
    store.resolveEnvironmentKeyForAccount('acct-contended'),
    { ok: false, reason: 'binding_conflict' },
    '跨客户争用 MUST 与多环境同一收紧方向，MUST NOT 任取那唯一一个环境',
  );
  assert.deepEqual(
    store.resolveEnvironmentKeyForAccount('acct-unbound'),
    { ok: false, reason: 'binding_unknown' },
  );

  // 慢启动那份镜像只看环境个数：跨客户争用的账号在它眼里仍是唯一绑定（既有语义，本 change 不改）。
  assert.equal(store.hasAmbiguousEnvironmentBinding('acct-dup'), true);
  assert.equal(store.hasAmbiguousEnvironmentBinding('acct-contended'), false);
});

test('listEnvScope ignores client self-claims and revoked assignments', async () => {
  const pool = fakePool((sql) => {
    assert.match(sql, /s\.user_id = \$1 AND s\.source = 'admin'/);
    assert.match(sql, /e\.lifecycle_state = 'active'/);
    return { rows: [] };
  });
  const store = new ClientUserStore({ schemaEnsurer: ensureCapabilitySchema, pool });
  assert.deepEqual(await store.listEnvScope('user-a'), []);
});

test('withAuthorizedInteractionScope holds complete authorization locks through operation and commit', async () => {
  const calls: string[] = [];
  let released = false;
  const client = {
    query: async (sql: string) => {
      calls.push(sql);
      if (/SELECT status FROM client_users/.test(sql)) return { rows: [{ status: 'enabled' }] };
      if (/FROM client_env_scope s/.test(sql)) return { rows: [{ platform: 'wechat_channels' }] };
      if (/FROM accounts WHERE account_id/.test(sql)) return { rows: [{ '?column?': 1 }] };
      return { rows: [] };
    },
    release: () => { released = true; },
  };
  const pool = { connect: async () => client } as unknown as pg.Pool;
  // Block③ L3：绑定改经端口取（automation 属主），本域三张表照旧在事务里 FOR SHARE 钉住。
  const store = new ClientUserStore({ schemaEnsurer: ensureCapabilitySchema, pool,
    automationReads: fakeAutomationReads({ boundAccountForEnv: async () => 'acct-a' }) });
  const result = await store.withAuthorizedInteractionScope('user-a', 'env-a', async ({ accountId }) => {
    assert.equal(accountId, 'acct-a');
    assert.equal(calls.at(-1)?.includes('FROM accounts WHERE account_id'), true);
    assert.ok(calls.some((sql) => sql.includes('FOR SHARE OF s, e')), '本域归属 / 注册行仍要钉住');
    assert.ok(!calls.some((sql) => sql.includes('interaction_auth_state')), '不再跨库锁属主的授权行');
    assert.equal(calls.some((sql) => sql === 'COMMIT'), false, 'operation runs before transaction commit');
    return 'done';
  });
  assert.deepEqual(result, { ok: true, accountId: 'acct-a', value: 'done' });
  assert.equal(calls[0], 'BEGIN');
  assert.match(calls[1], /client_users[\s\S]*FOR SHARE/);
  assert.equal(calls.at(-1), 'COMMIT');
  assert.equal(released, true);
});

test('withAuthorizedInteractionScope fails closed on env/account binding mismatch without running operation', async () => {
  let operationCalls = 0;
  const calls: string[] = [];
  const client = {
    query: async (sql: string) => {
      calls.push(sql);
      if (/SELECT status FROM client_users/.test(sql)) return { rows: [{ status: 'enabled' }] };
      return { rows: [] };
    },
    release() {},
  };
  const pool = { connect: async () => client } as unknown as pg.Pool;
  const store = new ClientUserStore({ schemaEnsurer: ensureCapabilitySchema, pool,
    automationReads: fakeAutomationReads() });
  const result = await store.withAuthorizedInteractionScope('user-a', 'env-b', async () => {
    operationCalls += 1;
  });
  assert.deepEqual(result, { ok: false, reason: 'not_authorized' });
  assert.equal(operationCalls, 0);
  assert.equal(calls.at(-1), 'ROLLBACK');
});

// ── 环境→账号绑定（change curated-envkey-account-binding）───────────────────────────
// 真 SQL 的绑定合并 / D5 双闸 / accounts JOIN 悬空 fail-closed 靠真库核（簇 61，见文件头同理）；
// 这里锁桩可验的那几段：退役归一、COALESCE 方向（防 FB 昵称回归形状）、D5 写闸拒写 + 告警、判别式映射。

/** 支持 connect() 事务路径的假 pool：按 SQL 内容分派返回值，records 收 upsert 参数。 */
function txPool(dispatch: (sql: string, params?: unknown[]) => { rows: unknown[] }) {
  const calls: { sql: string; params?: unknown[] }[] = [];
  const client = {
    query: async (sql: string, params?: unknown[]) => {
      calls.push({ sql, params });
      return dispatch(sql, params);
    },
    release() {},
  };
  const pool = { connect: async () => client, query: client.query } as unknown as pg.Pool;
  return { pool, calls };
}

test('registerEnvironments: 退役保留账号 default 归一为 null（不写绑定、走非事务路径）', async () => {
  const { pool, calls } = recordingPool();
  const store = new ClientUserStore({ schemaEnsurer: ensureCapabilitySchema, pool });
  await store.registerEnvironments([{ envKey: 'k1', accountId: 'default' }], 'auto');
  // 归一为 null ⇒ 不触发事务 D5 闸，直接一条 upsert；account_id 参数 = null（COALESCE 下等价「没有新值」）。
  assert.equal(calls.length, 1);
  assert.match(calls[0].sql, /INSERT INTO client_environments/);
  assert.deepEqual(calls[0].params, ['k1', null, null, 'auto', null]);
});

test('registerEnvironments: 带真实 accountId 走事务、无冲突则写绑定，且合并是「新值才覆盖」', async () => {
  const { pool, calls } = txPool((sql) => {
    if (/AS conflict/.test(sql)) return { rows: [{ conflict: false }] };
    return { rows: [] };
  });
  const store = new ClientUserStore({ schemaEnsurer: ensureCapabilitySchema, pool });
  await store.registerEnvironments([{ envKey: 'k1', accountId: 'acct-24hex' }], 'auto');
  const upsert = calls.find((c) => /INSERT INTO client_environments/.test(c.sql))!;
  assert.deepEqual(upsert.params, ['k1', null, null, 'auto', 'acct-24hex']);
  // 红线：合并 MUST 为「来了新值才覆盖」，MUST NOT 为「当前为空才写」（后者=FB 昵称回归形状）。
  assert.match(upsert.sql, /account_id = COALESCE\(EXCLUDED\.account_id, client_environments\.account_id\)/);
  assert.doesNotMatch(upsert.sql, /account_id = COALESCE\(client_environments\.account_id, EXCLUDED\.account_id\)/);
  // 事务包裹（不牵连握手由调用侧 fire-and-forget 保证；此处锁 BEGIN/COMMIT 成对）。
  assert.equal(calls[0].sql, 'BEGIN');
  assert.equal(calls.some((call) => call.sql === 'COMMIT'), true);
  assert.match(calls.at(-1)!.sql, /SELECT e\.env_key/,
    '绑定提交后必须刷新环境慢启动镜像');
});

test('registerEnvironments: D5 写闸——跨客户冲突则拒写绑定(account_id→null)+告警，label/platform 照登记', async () => {
  const { pool, calls } = txPool((sql) => {
    if (/AS conflict/.test(sql)) return { rows: [{ conflict: true }] };
    return { rows: [] };
  });
  const store = new ClientUserStore({ schemaEnsurer: ensureCapabilitySchema, pool });
  const alerts: { envKey: string; accountId: string }[] = [];
  store.setBindingConflictAlertSink((a) => alerts.push({ envKey: a.envKey, accountId: a.accountId }));
  await store.registerEnvironments([{ envKey: 'k1', label: '大白', platform: 'facebook', accountId: 'victim-acct' }], 'auto');
  const upsert = calls.find((c) => /INSERT INTO client_environments/.test(c.sql))!;
  // 绑定被拒写（account_id=null 交给 COALESCE 保留既有），但 label/platform 照常登记。
  assert.deepEqual(upsert.params, ['k1', '大白', 'facebook', 'auto', null]);
  assert.deepEqual(alerts, [{ envKey: 'k1', accountId: 'victim-acct' }]);
});

test('resolveBoundAccountForEnv: 判别式映射（owned/bound/dangling/contended/unavailable）', async () => {
  const make = (row: unknown) => new ClientUserStore({ schemaEnsurer: ensureCapabilitySchema, pool: fakePool(() => ({ rows: [row] })) });
  assert.deepEqual(
    await make({ owned: true, bound_account: 'acct-x', account_exists: true, contended: false })
      .resolveBoundAccountForEnv('u1', 'p1'),
    { ok: true, accountId: 'acct-x' });
  assert.deepEqual(
    await make({ owned: false, bound_account: null, account_exists: false, contended: false })
      .resolveBoundAccountForEnv('u1', 'p1'),
    { ok: false, reason: 'environment_not_owned' });
  assert.deepEqual(
    await make({ owned: true, bound_account: null, account_exists: false, contended: false })
      .resolveBoundAccountForEnv('u1', 'p1'),
    { ok: false, reason: 'binding_unknown' });
  assert.deepEqual( // 悬空绑定（accounts 无此行）→ 读时 fail-closed 归入 binding_unknown
    await make({ owned: true, bound_account: 'acct-x', account_exists: false, contended: false })
      .resolveBoundAccountForEnv('u1', 'p1'),
    { ok: false, reason: 'binding_unknown' });
  assert.deepEqual( // 争用是安全事件，与 binding_unknown 分码
    await make({ owned: true, bound_account: 'acct-x', account_exists: true, contended: true })
      .resolveBoundAccountForEnv('u1', 'p1'),
    { ok: false, reason: 'binding_conflict' });
  const missingTable = new ClientUserStore({ schemaEnsurer: ensureCapabilitySchema, pool: fakePool(() => { const e = new Error('no table') as Error & { code: string }; e.code = '42P01'; throw e; }) });
  assert.deepEqual(await missingTable.resolveBoundAccountForEnv('u1', 'p1'), { ok: false, reason: 'binding_unavailable' });
});

test('hasEnabledClientApprovalReachability: only authoritative enabled active bindings prove client review access', async () => {
  const reachable = new ClientUserStore({ schemaEnsurer: ensureCapabilitySchema, pool: fakePool((sql) => {
    assert.match(sql, /u\.status='enabled'/);
    assert.match(sql, /e\.lifecycle_state='active'/);
    assert.match(sql, /s\.source='admin'/);
    return { rows: [{ reachable: true }] };
  }) });
  assert.deepEqual(await reachable.hasEnabledClientApprovalReachability('acc-1'), { reachable: true, reason: 'reachable' });

  const unreachable = new ClientUserStore({ schemaEnsurer: ensureCapabilitySchema, pool: fakePool(() => ({ rows: [{ reachable: false }] })) });
  assert.deepEqual(
    await unreachable.hasEnabledClientApprovalReachability('acc-1'),
    { reachable: false, reason: 'no_enabled_client_binding' },
  );

  const missing = new ClientUserStore({ schemaEnsurer: ensureCapabilitySchema, pool: fakePool(() => {
    throw Object.assign(new Error('missing'), { code: '42P01' });
  }) });
  assert.deepEqual(await missing.hasEnabledClientApprovalReachability('acc-1'), { reachable: false, reason: 'unavailable' });
});

test('resolveOperatorAliasAccountForEnv: 专用写解析保留悬空账号原因并复用归属/争用闸', async () => {
  const make = (row: unknown) => new ClientUserStore({ schemaEnsurer: ensureCapabilitySchema, pool: fakePool(() => ({ rows: [row] })) });
  assert.deepEqual(
    await make({ owned: true, bound_account: 'acct-x', account_exists: true, contended: false })
      .resolveOperatorAliasAccountForEnv('u1', 'p1'),
    { ok: true, accountId: 'acct-x' });
  assert.deepEqual(
    await make({ owned: false, bound_account: null, account_exists: false, contended: false })
      .resolveOperatorAliasAccountForEnv('u1', 'p1'),
    { ok: false, reason: 'environment_not_owned' });
  assert.deepEqual(
    await make({ owned: true, bound_account: null, account_exists: false, contended: false })
      .resolveOperatorAliasAccountForEnv('u1', 'p1'),
    { ok: false, reason: 'binding_unknown' });
  assert.deepEqual(
    await make({ owned: true, bound_account: 'acct-x', account_exists: false, contended: false })
      .resolveOperatorAliasAccountForEnv('u1', 'p1'),
    { ok: false, reason: 'account_not_found' });
  assert.deepEqual(
    await make({ owned: true, bound_account: 'acct-x', account_exists: true, contended: true })
      .resolveOperatorAliasAccountForEnv('u1', 'p1'),
    { ok: false, reason: 'binding_conflict' });
});

test('isAccountReachableByUser: 反向判别（ok / 争用 fail-closed / 不可达）', async () => {
  const make = (row: unknown) => new ClientUserStore({ schemaEnsurer: ensureCapabilitySchema, pool: fakePool(() => ({ rows: [row] })) });
  assert.deepEqual(await make({ owned_bound: true, contended: false }).isAccountReachableByUser('u1', 'acct-x'),
    { ok: true, accountId: 'acct-x' });
  assert.deepEqual(await make({ owned_bound: true, contended: true }).isAccountReachableByUser('u1', 'acct-x'),
    { ok: false, reason: 'binding_conflict' });
  assert.deepEqual(await make({ owned_bound: false, contended: false }).isAccountReachableByUser('u1', 'acct-x'),
    { ok: false, reason: 'environment_not_owned' });
});

test('environment slow-start schema is additive and leaves the legacy account column untouched', () => {
  assert.match(CLIENT_USERS_SCHEMA_SQL, /ALTER TABLE client_environments ADD COLUMN IF NOT EXISTS slow_start_since TIMESTAMPTZ/);
  assert.match(CLIENT_USERS_SCHEMA_SQL, /slow_start_initialized BOOLEAN/);
  assert.match(CLIENT_USERS_SCHEMA_SQL, /ALTER COLUMN slow_start_initialized SET DEFAULT true/,
    '新环境默认已初始化，绝不能在未来重启时从复用账号回灌旧值');
  assert.doesNotMatch(CLIENT_USERS_SCHEMA_SQL, /DROP COLUMN[\s\S]*slow_start_since/i);
});

test('migrateEnvironmentSlowStartFromAccounts: COPY-on-null 后刷新同步镜像，可重跑且不双写账号', async () => {
  const calls: { sql: string; params?: unknown[] }[] = [];
  const since = new Date('2026-07-18T00:00:00+08:00');
  const pool = {
    query: async (sql: string, params?: unknown[]) => {
      calls.push({ sql, params });
      if (/UPDATE client_environments e/.test(sql)) return { rows: [{ env_key: 'fb-env' }], rowCount: 1 };
      if (/SELECT e\.env_key/.test(sql)) {
        return { rows: [{ env_key: 'fb-env', account_id: 'acct-a', slow_start_since: since }] };
      }
      return { rows: [], rowCount: 0 };
    },
  } as unknown as pg.Pool;
  const store = new ClientUserStore({ schemaEnsurer: ensureCapabilitySchema, pool });
  assert.equal(await store.migrateEnvironmentSlowStartFromAccounts(), 1);
  assert.equal(store.slowStartSinceFor('acct-a'), since.getTime());
  const migration = calls[0].sql;
  assert.match(migration, /e\.slow_start_initialized=false/);
  assert.match(migration, /slow_start_initialized = true/);
  assert.match(migration, /COALESCE\(e\.slow_start_since, pending\.legacy_since\)/,
    '历史值只初始化一次，已有环境真态优先');
  assert.doesNotMatch(migration, /UPDATE accounts/);
});

test('setEnvironmentSlowStart: ownership-scoped 环境单写，上海日起点对齐且未绑定也返回配置态', async () => {
  const calls: { sql: string; params?: unknown[] }[] = [];
  const now = Date.parse('2026-07-18T23:50:00+08:00');
  const aligned = shanghaiDayStartMs(now);
  const pool = {
    query: async (sql: string, params?: unknown[]) => {
      calls.push({ sql, params });
      if (/UPDATE client_environments e/.test(sql)) return { rows: [{ env_key: 'fb-env' }], rowCount: 1 };
      if (/SELECT e\.env_key/.test(sql)) return { rows: [] };
      if (/AS owned/.test(sql)) return { rows: [{
        owned: true, slow_start_since: new Date(aligned), bound_account: null,
        account_exists: false, contended: false, duplicate_count: 0,
      }] };
      return { rows: [], rowCount: 0 };
    },
  } as unknown as pg.Pool;
  const store = new ClientUserStore({ schemaEnsurer: ensureCapabilitySchema, pool });
  const result = await store.setEnvironmentSlowStart('u1', 'fb-env', true, now);
  assert.deepEqual(result, {
    ok: true, envKey: 'fb-env', slowStartSince: aligned, binding: 'binding_unknown',
  });
  const write = calls.find((call) => /UPDATE client_environments e/.test(call.sql))!;
  assert.equal((write.params?.[2] as Date).getTime(), aligned);
  assert.match(write.sql, /slow_start_initialized=true/);
  assert.doesNotMatch(write.sql, /UPDATE accounts/);
});

test('setAdminEnvironmentSlowStart: active Facebook 环境幂等开启保留起点，关闭清空并刷新镜像', async () => {
  const firstNow = Date.parse('2026-07-24T16:30:00+08:00');
  const laterNow = Date.parse('2026-07-28T10:00:00+08:00');
  let stored: Date | null = null;
  let mirrorRefreshes = 0;
  const pool = fakePool((sql, params) => {
    if (/UPDATE client_environments/.test(sql)) {
      assert.match(sql, /COALESCE\(slow_start_since, \$3\)/);
      assert.match(sql, /lifecycle_state='active'/);
      assert.match(sql, /platform='facebook'/);
      const enabled = params?.[1] as boolean;
      if (enabled) stored ??= params?.[2] as Date;
      else stored = null;
      return { rows: [{ slow_start_since: stored }] };
    }
    if (/SELECT e\.env_key/.test(sql)) {
      mirrorRefreshes += 1;
      return { rows: [] };
    }
    return { rows: [] };
  });
  const store = new ClientUserStore({ schemaEnsurer: ensureCapabilitySchema, pool });

  const enabled = await store.setAdminEnvironmentSlowStart('fb-env', true, firstNow);
  const originalSince = shanghaiDayStartMs(firstNow);
  assert.deepEqual(enabled, {
    ok: true,
    envKey: 'fb-env',
    slowStart: { enabled: true, since: originalSince },
  });
  assert.equal((stored as Date | null)?.getTime(), originalSince);

  const repeated = await store.setAdminEnvironmentSlowStart('fb-env', true, laterNow);
  assert.deepEqual(repeated, enabled);
  assert.equal((stored as Date | null)?.getTime(), originalSince, '重复开启不得重置第 1 天起点');

  assert.deepEqual(await store.setAdminEnvironmentSlowStart('fb-env', false, laterNow), {
    ok: true,
    envKey: 'fb-env',
    slowStart: { enabled: false, since: null },
  });
  assert.equal(stored, null);
  assert.equal(mirrorRefreshes, 3);
});

test('setAdminEnvironmentSlowStart: 不存在、非 active 与非 Facebook 目标具名拒绝且不刷新镜像', async () => {
  const cases = [
    { row: undefined, reason: 'environment_not_found' },
    { row: { lifecycle_state: 'deleted', platform: 'facebook' }, reason: 'environment_not_active' },
    { row: { lifecycle_state: 'active', platform: 'xiaohongshu' }, reason: 'platform_unsupported' },
  ] as const;
  for (const item of cases) {
    let refreshAttempted = false;
    const pool = fakePool((sql) => {
      if (/UPDATE client_environments/.test(sql)) return { rows: [] };
      if (/SELECT lifecycle_state, platform/.test(sql)) return { rows: item.row ? [item.row] : [] };
      if (/SELECT e\.env_key/.test(sql)) refreshAttempted = true;
      return { rows: [] };
    });
    const store = new ClientUserStore({ schemaEnsurer: ensureCapabilitySchema, pool });
    assert.deepEqual(
      await store.setAdminEnvironmentSlowStart('target-env', true, Date.now()),
      { ok: false, reason: item.reason },
    );
    assert.equal(refreshAttempted, false);
  }
});

test('environment slow-start mirror: 换绑即时移除旧账号；重复绑定不任取并标记歧义', async () => {
  let rows: { env_key: string; account_id: string; slow_start_since: Date | null }[] = [
    { env_key: 'fb-env', account_id: 'acct-a', slow_start_since: new Date(1000) },
  ];
  const pool = fakePool(() => ({ rows }));
  const store = new ClientUserStore({ schemaEnsurer: ensureCapabilitySchema, pool });
  await store.refreshEnvironmentSlowStartMirror();
  assert.equal(store.slowStartSinceFor('acct-a'), 1000);

  rows = [{ env_key: 'fb-env', account_id: 'acct-b', slow_start_since: new Date(1000) }];
  await store.refreshEnvironmentSlowStartMirror();
  assert.equal(store.slowStartSinceFor('acct-a'), null);
  assert.equal(store.slowStartSinceFor('acct-b'), 1000);

  rows = [
    { env_key: 'fb-env', account_id: 'acct-b', slow_start_since: new Date(1000) },
    { env_key: 'fb-env-2', account_id: 'acct-b', slow_start_since: null },
  ];
  await store.refreshEnvironmentSlowStartMirror();
  assert.equal(store.slowStartSinceFor('acct-b'), null, '多环境歧义不得任取开启或关闭任一行');
  assert.equal(store.hasAmbiguousEnvironmentBinding('acct-b'), true);
});
