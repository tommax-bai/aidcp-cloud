import { test } from 'node:test';
import assert from 'node:assert/strict';
import type pg from 'pg';
import type { SchemaEnsurer } from '@kernel/kernel/schema-capability-contract.js';
import {
  RISK_SCHEMA_SQL,
  PgRiskStore,
  PgRiskCounterOutboxStore,
  pgRiskConfigFromEnv,
} from '@automation/risk/index.js';

const readySchemaEnsurer: SchemaEnsurer = async () => 'ready';

test('RISK_SCHEMA_SQL 含 risk_counters / risk_state 表', () => {
  assert.match(RISK_SCHEMA_SQL, /CREATE TABLE IF NOT EXISTS risk_counters/);
  assert.match(RISK_SCHEMA_SQL, /CREATE TABLE IF NOT EXISTS risk_state/);
  assert.match(RISK_SCHEMA_SQL, /idx_risk_counters_account_action_time/);
});

test('pgRiskConfigFromEnv 读取 AIDCP_PG_* 并兼容 AIDCP_PG_DB', () => {
  const config = pgRiskConfigFromEnv({
    AIDCP_PG_HOST: 'pg.local',
    AIDCP_PG_PORT: '15432',
    AIDCP_PG_DB: 'aidcp_test',
    AIDCP_PG_USER: 'bot',
    AIDCP_PG_PASSWORD: 'secret',
  });
  assert.deepEqual(config, {
    host: 'pg.local',
    port: 15432,
    database: 'aidcp_test',
    user: 'bot',
    password: 'secret',
  });
});

test('RISK_SCHEMA_SQL 补 occurred_at 打头索引服务面板全局时间窗查询（#21）', () => {
  assert.match(RISK_SCHEMA_SQL, /idx_risk_counters_time ON risk_counters \(occurred_at DESC\)/);
});

test('PgRiskStore.init 并发只探测一次 schema，默认路径不执行 DDL', async () => {
  let releaseProbe!: () => void;
  const probeGate = new Promise<void>((resolve) => {
    releaseProbe = resolve;
  });
  let probeCalls = 0;
  const queries: string[] = [];
  const pool = {
    query: async (sql: string) => {
      queries.push(sql);
      return { rows: [], rowCount: 0 };
    },
  } as unknown as pg.Pool;
  const schemaEnsurer: SchemaEnsurer = async (client, spec) => {
    probeCalls += 1;
    assert.equal(client, pool);
    assert.equal(spec.capability, 'risk_control');
    assert.equal(spec.sinceVersion, '0061_risk_writer_ownership_and_outbox');
    assert.deepEqual(spec.ddl, [RISK_SCHEMA_SQL]);
    await probeGate;
    return 'ready';
  };
  const store = new PgRiskStore({ pool, schemaEnsurer });

  const first = store.init();
  const second = store.init();
  assert.equal(first, second, '并发账号物化 MUST 共用同一个初始化 Promise');
  assert.equal(probeCalls, 1);

  releaseProbe();
  await Promise.all([first, second]);
  assert.equal(probeCalls, 1);
  assert.equal(
    queries.some((sql) => /\b(?:CREATE|ALTER|DROP|DO)\b/i.test(sql)),
    false,
    '默认运行时路径 MUST NOT 执行 DDL',
  );
  await store.close();
});

test('PgRiskStore.init 失败后清理 single-flight，下一次真实调用重新探测', async () => {
  let probeCalls = 0;
  const schemaEnsurer: SchemaEnsurer = async () => {
    probeCalls += 1;
    if (probeCalls === 1) throw new Error('schema probe interrupted');
    return 'ready';
  };
  const { pool } = poolSpy();
  const store = new PgRiskStore({ pool, schemaEnsurer });

  await assert.rejects(() => store.init(), /schema probe interrupted/);
  await store.init();
  assert.equal(probeCalls, 2, '一次失败 MUST NOT 被永久缓存');
  await store.close();
});

test('purgeCountersOlderThan 按 occurred_at 删过期计数、回传删除行数（走索引不全表扫描）', async () => {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const pool = {
    query: async (sql: string, params: unknown[]) => {
      calls.push({ sql, params });
      return { rowCount: 4 };
    },
  } as unknown as pg.Pool;
  const store = new PgRiskStore({ pool, schemaEnsurer: readySchemaEnsurer });
  const n = await store.purgeCountersOlderThan(7);
  assert.equal(n, 4);
  assert.match(calls[0].sql, /DELETE FROM risk_counters WHERE occurred_at </);
  assert.deepEqual(calls[0].params, [7]);
});
// ── 属主池的生命周期（Block③ 物理拆库 L3）─────────────────────────────────────────────
//
// 组合根注入 automationPool 之后，close() 若照旧 end 那个池，一次**局部**失败就会打死全域
// 共用的池、把风控一处的问题升级成进程级瘫痪（aidcp-cloud 7f5232a 修过一次同形 bug）。
// 判据是 ownsPool：只 end 自己建的池。

function poolSpy(): { pool: pg.Pool; ended: () => number } {
  let ended = 0;
  const pool = {
    query: async () => ({ rows: [], rowCount: 0 }),
    end: async () => {
      ended += 1;
    },
  } as unknown as pg.Pool;
  return { pool, ended: () => ended };
}

test('PgRiskStore.close 绝不 end 注入的属主池（否则一处失败拖死全域）', async () => {
  const { pool, ended } = poolSpy();
  const store = new PgRiskStore({ pool, schemaEnsurer: readySchemaEnsurer });
  await store.close();
  assert.equal(ended(), 0, '注入池由组合根掌控生命周期，store MUST NOT 替它 end');
});

test('PgRiskCounterOutboxStore.close 同样只 end 自己建的池', async () => {
  const { pool, ended } = poolSpy();
  const store = new PgRiskCounterOutboxStore({ executionTarget: 'dev', pool });
  await store.close();
  assert.equal(ended(), 0);
});
