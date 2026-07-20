import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import pg from 'pg';
import { CLIENT_USERS_SCHEMA_SQL, ClientUserStore } from '../src/client-auth/client-user-store.js';
import { shanghaiDayStartMs } from '../src/time/shanghai-day.js';

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

test('listAllEnvironments: 行映射为视图，assigneeCount = assignees 长度', async () => {
  const pool = fakePool((sql) => {
    assert.match(sql, /FROM client_env_scope/); // 命中聚合 SELECT
    return {
      rows: [
        { env_key: 'p1', label: '大白', platform: 'xiaohongshu', assignees: [{ userId: 'u1', name: 'A' }] },
        {
          env_key: 'p2',
          label: null,
          platform: null,
          assignees: [{ userId: 'u2', name: 'B' }],
        },
      ],
    };
  });
  const store = new ClientUserStore({ pool });
  const envs = await store.listAllEnvironments();
  assert.equal(envs.length, 2);
  assert.deepEqual(envs[0], {
    envKey: 'p1',
    label: '大白',
    platform: 'xiaohongshu',
    assignees: [{ userId: 'u1', name: 'A' }],
    assigneeCount: 1,
    cleanup: null,
  });
  assert.equal(envs[1].assigneeCount, 1); // 全局唯一 active owner
  assert.deepEqual(
    envs[1].assignees.map((a) => a.name),
    ['B'],
  );
});

test('listAllEnvironments: json_agg 为 null 时回落空 assignees（count 0）', async () => {
  const pool = fakePool(() => ({ rows: [{ env_key: 'p3', label: null, platform: null, assignees: null }] }));
  const store = new ClientUserStore({ pool });
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
  const store = new ClientUserStore({ pool });
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
  const store = new ClientUserStore({ pool });
  assert.deepEqual(await store.listAllEnvironments(), []);
});

test('listAllEnvironments: 非缺表错误照常抛出（不吞真故障）', async () => {
  const pool = fakePool(() => {
    const err = new Error('connection refused') as Error & { code: string };
    err.code = 'ECONNREFUSED';
    throw err;
  });
  const store = new ClientUserStore({ pool });
  await assert.rejects(() => store.listAllEnvironments(), /connection refused/);
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
  const store = new ClientUserStore({ pool });
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
  const store = new ClientUserStore({ pool });
  const n = await store.registerEnvironments([{ envKey: '  ' }, { envKey: '' }]);
  assert.equal(n, 0);
  assert.equal(calls.length, 0);
});

test('registerEnvironments: source 显式传 auto 透传到参数（自动登记路径）', async () => {
  const { pool, calls } = recordingPool();
  const store = new ClientUserStore({ pool });
  await store.registerEnvironments([{ envKey: 'k9' }], 'auto');
  assert.deepEqual(calls[0].params, ['k9', null, null, 'auto', null]);
});

test('ownsEnv: user A only owns rows explicitly scoped to user A', async () => {
  const pool = fakePool((sql, params) => {
    assert.match(sql, /WHERE user_id = \$1 AND env_key = \$2/);
    assert.match(sql, /source = 'admin'/);
    return { rows: [{ owned: params?.[0] === 'user-a' && params?.[1] === 'env-a' }] };
  });
  const store = new ClientUserStore({ pool });
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
  const store = new ClientUserStore({ pool });
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
  // PK 单值（change slow-start-offline-toggle，迁移自已删除的 ws-server-resolve-account「多账号即拒绝猜测」）：
  // client_environments.env_key 是主键 ⇒ 一个环境至多一行 ⇒ 至多一个绑定账号 ⇒「同一环境解析出多个账号、
  // 须拒绝猜测」的路径**结构上不存在**。这正是慢启动写路由从活会话反查改到持久绑定后歧义消失的根据。
  assert.match(CLIENT_USERS_SCHEMA_SQL, /CREATE TABLE IF NOT EXISTS client_environments\s*\([\s\S]*?env_key\s+TEXT\s+PRIMARY KEY/);
  assert.match(CLIENT_USERS_SCHEMA_SQL, /CREATE TABLE IF NOT EXISTS client_env_revocation_holds/);
  assert.match(CLIENT_USERS_SCHEMA_SQL, /env_key\s+TEXT\s+NOT NULL UNIQUE/);
  assert.match(CLIENT_USERS_SCHEMA_SQL, /client_env_scope_cleanup_hold_guard/);
  assert.match(CLIENT_USERS_SCHEMA_SQL, /CONSTRAINT = 'client_env_scope_cleanup_hold'/);
});

test('completeProvisioningIntent rejects malformed intent/proof before touching PostgreSQL', async () => {
  const pool = fakePool(() => {
    assert.fail('malformed provisioning credentials must fail before any query');
  });
  const store = new ClientUserStore({ pool });
  assert.deepEqual(await store.completeProvisioningIntent('user-a', {
    intentId: 'not-a-uuid', proof: 'short', envKey: 'fresh-env', platform: 'facebook',
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
  const result = await new ClientUserStore({ pool }).completeProvisioningIntent('user-a', {
    intentId, proof, envKey: 'fb-new', label: 'FB new', platform: 'facebook', slowStartEnabled: true,
  });
  const after = Date.now();
  assert.equal(result.ok, true);
  const insert = calls.find((call) => /INSERT INTO client_environments/.test(call.sql))!;
  assert.match(insert.sql, /slow_start_since,slow_start_initialized/);
  assert.match(insert.sql, /VALUES \(\$1,\$2,\$3,'auto',\$4,true,now\(\),now\(\)\)/);
  const stored = insert.params?.[3] as Date;
  assert.ok(stored instanceof Date);
  assert.ok(stored.getTime() >= shanghaiDayStartMs(before));
  assert.ok(stored.getTime() <= shanghaiDayStartMs(after));
  assert.ok(calls.some((call) => call.sql === 'COMMIT'));
});

test('completeProvisioningIntent rejects non-Facebook slow start before PostgreSQL', async () => {
  const pool = { connect: async () => assert.fail('non-Facebook slow start must fail before PostgreSQL') } as unknown as pg.Pool;
  const result = await new ClientUserStore({ pool }).completeProvisioningIntent('user-a', {
    intentId: '11111111-1111-4111-8111-111111111111',
    proof: 'A'.repeat(43),
    envKey: 'xhs-new',
    platform: 'xiaohongshu',
    slowStartEnabled: true,
  });
  assert.deepEqual(result, { ok: false, reason: 'invalid_environment' });
});

test('listEnvScope ignores client self-claims and revoked assignments', async () => {
  const pool = fakePool((sql) => {
    assert.match(sql, /user_id = \$1 AND source = 'admin'/);
    return { rows: [] };
  });
  const store = new ClientUserStore({ pool });
  assert.deepEqual(await store.listEnvScope('user-a'), []);
});

test('withAuthorizedInteractionScope holds complete authorization locks through operation and commit', async () => {
  const calls: string[] = [];
  let released = false;
  const client = {
    query: async (sql: string) => {
      calls.push(sql);
      if (/SELECT status FROM client_users/.test(sql)) return { rows: [{ status: 'enabled' }] };
      if (/FROM client_env_scope s/.test(sql)) return { rows: [{ account_id: 'acct-a' }] };
      return { rows: [] };
    },
    release: () => { released = true; },
  };
  const pool = { connect: async () => client } as unknown as pg.Pool;
  const store = new ClientUserStore({ pool });
  const result = await store.withAuthorizedInteractionScope('user-a', 'env-a', async ({ accountId }) => {
    assert.equal(accountId, 'acct-a');
    assert.equal(calls.at(-1)?.includes('FOR SHARE OF s, e, a, acc'), true);
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
  const store = new ClientUserStore({ pool });
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
  const store = new ClientUserStore({ pool });
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
  const store = new ClientUserStore({ pool });
  await store.registerEnvironments([{ envKey: 'k1', accountId: 'acct-24hex' }], 'auto');
  const upsert = calls.find((c) => /INSERT INTO client_environments/.test(c.sql))!;
  assert.deepEqual(upsert.params, ['k1', null, null, 'auto', 'acct-24hex']);
  // 红线：合并 MUST 为「来了新值才覆盖」，MUST NOT 为「当前为空才写」（后者=FB 昵称回归形状）。
  assert.match(upsert.sql, /account_id = COALESCE\(EXCLUDED\.account_id, client_environments\.account_id\)/);
  assert.doesNotMatch(upsert.sql, /account_id = COALESCE\(client_environments\.account_id, EXCLUDED\.account_id\)/);
  // 事务包裹（不牵连握手由调用侧 fire-and-forget 保证；此处锁 BEGIN/COMMIT 成对）。
  assert.equal(calls[0].sql, 'BEGIN');
  assert.equal(calls.some((call) => call.sql === 'COMMIT'), true);
  assert.match(calls.at(-1)!.sql, /SELECT env_key, account_id, slow_start_since/,
    '绑定提交后必须刷新环境慢启动镜像');
});

test('registerEnvironments: D5 写闸——跨客户冲突则拒写绑定(account_id→null)+告警，label/platform 照登记', async () => {
  const { pool, calls } = txPool((sql) => {
    if (/AS conflict/.test(sql)) return { rows: [{ conflict: true }] };
    return { rows: [] };
  });
  const store = new ClientUserStore({ pool });
  const alerts: { envKey: string; accountId: string }[] = [];
  store.setBindingConflictAlertSink((a) => alerts.push({ envKey: a.envKey, accountId: a.accountId }));
  await store.registerEnvironments([{ envKey: 'k1', label: '大白', platform: 'facebook', accountId: 'victim-acct' }], 'auto');
  const upsert = calls.find((c) => /INSERT INTO client_environments/.test(c.sql))!;
  // 绑定被拒写（account_id=null 交给 COALESCE 保留既有），但 label/platform 照常登记。
  assert.deepEqual(upsert.params, ['k1', '大白', 'facebook', 'auto', null]);
  assert.deepEqual(alerts, [{ envKey: 'k1', accountId: 'victim-acct' }]);
});

test('resolveBoundAccountForEnv: 判别式映射（owned/bound/dangling/contended/unavailable）', async () => {
  const make = (row: unknown) => new ClientUserStore({ pool: fakePool(() => ({ rows: [row] })) });
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
  const missingTable = new ClientUserStore({ pool: fakePool(() => { const e = new Error('no table') as Error & { code: string }; e.code = '42P01'; throw e; }) });
  assert.deepEqual(await missingTable.resolveBoundAccountForEnv('u1', 'p1'), { ok: false, reason: 'binding_unavailable' });
});

test('resolveOperatorAliasAccountForEnv: 专用写解析保留悬空账号原因并复用归属/争用闸', async () => {
  const make = (row: unknown) => new ClientUserStore({ pool: fakePool(() => ({ rows: [row] })) });
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
  const make = (row: unknown) => new ClientUserStore({ pool: fakePool(() => ({ rows: [row] })) });
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
      if (/SELECT env_key, account_id, slow_start_since/.test(sql)) {
        return { rows: [{ env_key: 'fb-env', account_id: 'acct-a', slow_start_since: since }] };
      }
      return { rows: [], rowCount: 0 };
    },
  } as unknown as pg.Pool;
  const store = new ClientUserStore({ pool });
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
      if (/SELECT env_key, account_id, slow_start_since/.test(sql)) return { rows: [] };
      if (/AS owned/.test(sql)) return { rows: [{
        owned: true, slow_start_since: new Date(aligned), bound_account: null,
        account_exists: false, contended: false, duplicate_count: 0,
      }] };
      return { rows: [], rowCount: 0 };
    },
  } as unknown as pg.Pool;
  const store = new ClientUserStore({ pool });
  const result = await store.setEnvironmentSlowStart('u1', 'fb-env', true, now);
  assert.deepEqual(result, {
    ok: true, envKey: 'fb-env', slowStartSince: aligned, binding: 'binding_unknown',
  });
  const write = calls.find((call) => /UPDATE client_environments e/.test(call.sql))!;
  assert.equal((write.params?.[2] as Date).getTime(), aligned);
  assert.match(write.sql, /slow_start_initialized=true/);
  assert.doesNotMatch(write.sql, /UPDATE accounts/);
});

test('environment slow-start mirror: 换绑即时移除旧账号；重复绑定不任取并标记歧义', async () => {
  let rows: { env_key: string; account_id: string; slow_start_since: Date | null }[] = [
    { env_key: 'fb-env', account_id: 'acct-a', slow_start_since: new Date(1000) },
  ];
  const pool = fakePool(() => ({ rows }));
  const store = new ClientUserStore({ pool });
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
