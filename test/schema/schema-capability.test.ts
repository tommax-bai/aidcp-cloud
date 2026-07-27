/**
 * 存储能力 schema 探测的三态与 fail-closed（change cloud-schema-migration-executor 任务 5.1 / 5.2）。
 * 零数据库依赖。
 *
 * 为什么必须有这一条：`ensureCapabilitySchema()` 是第 5 节 34 个存储 `init()` 共用的唯一入口，
 * 它承担的是本 change 最硬的那条红线 ——「探不到就带 version id 报错，**一条 DDL 都不执行**」。
 * 而 13 个被改过的存储单测用的假 pool（`test/fixtures/schema-probe.ts`）会用存储自己的 DDL 常量
 * 反推出「假库里恰好有它要的一切」，于是那些用例里探测**永远成功** —— missing / degraded / 旋钮
 * 三条路径在整个测试套里一次都走不到。只写文档不加测试等于没做（同 `test/acceptance/schema-db-scope.test.ts` 的口径）。
 *
 * `AC-SCHEMA-NO-SILENT-RECREATE` 守的是启动期契约门那一条路径；本文件守的是这 34 个 init 站点共用的这一条。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { scanSource } from '../../src/schema/ddl-scan.js';
import {
  SchemaCapabilityError,
  classifySchemaCapability,
  ensureCapabilitySchema,
  isSchemaCapabilityError,
  type SchemaCapabilitySpec,
} from '../../src/schema/schema-capability.js';

/** 一段和真实存储同形的 DDL 常量：一张表两列一索引。要求就是从它解析出来的。 */
const DDL = `
CREATE TABLE IF NOT EXISTS zz_probe (
  a TEXT PRIMARY KEY,
  b TEXT
);
CREATE INDEX IF NOT EXISTS idx_zz_probe ON zz_probe (b);
`;

const SPEC: SchemaCapabilitySpec = {
  capability: 'zz_probe',
  sinceVersion: '0099_zz_probe',
  ddl: [DDL],
};

/**
 * 桩：按「库里实际有哪些表 / 列 / 索引」应答探测，并记录所有被执行过的语句。
 * 判定「有没有偷偷执行 DDL」用与 AC-SCHEMA-DDL-OWNER / AC-SCHEMA-NO-SILENT-RECREATE 同一个扫描器，
 * 口径只有一份。
 */
function stubClient(shape: { tables: string[]; columns: string[]; indexes: string[] }) {
  const queries: string[] = [];
  return {
    queries,
    ddlExecuted: () => queries.flatMap((q) => scanSource('probe-path', q, true).map((h) => `${h.verb}:${h.object}`)),
    client: {
      async query(text: string) {
        queries.push(text);
        if (text.includes('pg_attribute')) {
          const rows: Record<string, unknown>[] = [];
          for (const table of shape.tables) {
            const columns = shape.columns.filter((c) => c.startsWith(`${table}.`));
            if (columns.length === 0) rows.push({ table_name: table, column_name: null });
            for (const c of columns) rows.push({ table_name: table, column_name: c.slice(table.length + 1) });
          }
          return { rows };
        }
        if (text.includes('pg_indexes')) {
          return { rows: shape.indexes.map((indexname) => ({ indexname })) };
        }
        return { rows: [] };
      },
    },
  };
}

const READY = { tables: ['zz_probe'], columns: ['zz_probe.a', 'zz_probe.b'], indexes: ['idx_zz_probe'] };

test('ready：对象齐备时返回 ready，只发探测查询、零 DDL', async () => {
  const stub = stubClient(READY);
  const status = await ensureCapabilitySchema(stub.client, SPEC);
  assert.equal(status, 'ready');
  assert.equal(stub.queries.length, 2, '探测就是两条读目录的语句；多出来的都是没被审阅过的副作用');
  assert.deepEqual(stub.ddlExecuted(), []);
});

test('missing：表不在 → 抛 schema_missing_*，带 version id 与缺失表，且一条 DDL 都没执行', async () => {
  const stub = stubClient({ tables: [], columns: [], indexes: [] });
  await assert.rejects(
    () => ensureCapabilitySchema(stub.client, SPEC),
    (err: unknown) => {
      assert.ok(isSchemaCapabilityError(err));
      const e = err as SchemaCapabilityError;
      assert.equal(e.code, 'schema_missing_zz_probe_run_0099_zz_probe');
      assert.equal(e.status, 'missing');
      assert.deepEqual(e.missing, ['zz_probe']);
      assert.match(e.message, /npm run migrate up/, '错误 MUST 直接给出处置动作，而不是只说「表不存在」');
      return true;
    },
  );
  assert.deepEqual(stub.ddlExecuted(), [], '缺表时 MUST NOT 顺手把表建出来 —— 那正是本 change 要堵的静默重建');
});

test('degraded：缺列 / 缺索引 → 抛 schema_incomplete_*，逐条列出缺什么，且零 DDL', async () => {
  const missingColumn = stubClient({ tables: ['zz_probe'], columns: ['zz_probe.a'], indexes: ['idx_zz_probe'] });
  await assert.rejects(
    () => ensureCapabilitySchema(missingColumn.client, SPEC),
    (err: unknown) => {
      const e = err as SchemaCapabilityError;
      assert.equal(e.code, 'schema_incomplete_zz_probe_run_0099_zz_probe');
      assert.equal(e.status, 'degraded');
      assert.deepEqual(e.missing, ['zz_probe.b']);
      return true;
    },
  );
  assert.deepEqual(missingColumn.ddlExecuted(), []);

  const missingIndex = stubClient({ ...READY, indexes: [] });
  await assert.rejects(
    () => ensureCapabilitySchema(missingIndex.client, SPEC),
    (err: unknown) => {
      const e = err as SchemaCapabilityError;
      assert.equal(e.code, 'schema_incomplete_zz_probe_run_0099_zz_probe');
      assert.deepEqual(e.missing, ['idx_zz_probe']);
      return true;
    },
  );
  assert.deepEqual(missingIndex.ddlExecuted(), []);
});

test('migrations-only requiredObjects joins the capability probe without adding runtime DDL', async () => {
  const spec: SchemaCapabilitySpec = {
    ...SPEC,
    requiredObjects: {
      tables: { zz_migration_only: ['id', 'payload'] },
    },
  };
  const missing = stubClient(READY);
  await assert.rejects(
    () => ensureCapabilitySchema(missing.client, spec),
    (err: unknown) => {
      const e = err as SchemaCapabilityError;
      assert.equal(e.status, 'missing');
      assert.deepEqual(e.missing, ['zz_migration_only']);
      return true;
    },
  );
  assert.deepEqual(missing.ddlExecuted(), []);

  const ready = stubClient({
    tables: [...READY.tables, 'zz_migration_only'],
    columns: [...READY.columns, 'zz_migration_only.id', 'zz_migration_only.payload'],
    indexes: READY.indexes,
  });
  assert.equal(await ensureCapabilitySchema(ready.client, spec), 'ready');
  assert.deepEqual(ready.ddlExecuted(), []);
});

test('回滚旋钮 AIDCP_SCHEMA_SELF_CREATE=true：确实回到自建（并且只有这一条路径会发 DDL）', async () => {
  const before = process.env.AIDCP_SCHEMA_SELF_CREATE;
  process.env.AIDCP_SCHEMA_SELF_CREATE = 'true';
  try {
    const stub = stubClient({ tables: [], columns: [], indexes: [] });
    const status = await ensureCapabilitySchema(stub.client, SPEC);
    assert.equal(status, 'ready');
    assert.deepEqual(stub.ddlExecuted(), ['create_table:zz_probe', 'create_index:idx_zz_probe']);
  } finally {
    if (before === undefined) delete process.env.AIDCP_SCHEMA_SELF_CREATE;
    else process.env.AIDCP_SCHEMA_SELF_CREATE = before;
  }
});

test('旋钮只认字面量 true：其它值一律不放开自建', async () => {
  const before = process.env.AIDCP_SCHEMA_SELF_CREATE;
  try {
    for (const value of ['1', 'yes', 'on', 'TRUE ', '']) {
      process.env.AIDCP_SCHEMA_SELF_CREATE = value;
      const stub = stubClient({ tables: [], columns: [], indexes: [] });
      // 'TRUE ' 带空格但 trim+toLowerCase 后是 true —— 它 MUST 放开；其余 MUST NOT。
      const expectSelfCreate = value.trim().toLowerCase() === 'true';
      if (expectSelfCreate) {
        assert.equal(await ensureCapabilitySchema(stub.client, SPEC), 'ready');
        assert.ok(stub.ddlExecuted().length > 0);
      } else {
        await assert.rejects(() => ensureCapabilitySchema(stub.client, SPEC), isSchemaCapabilityError);
        assert.deepEqual(stub.ddlExecuted(), [], `AIDCP_SCHEMA_SELF_CREATE=${JSON.stringify(value)} MUST NOT 放开自建`);
      }
    }
  } finally {
    if (before === undefined) delete process.env.AIDCP_SCHEMA_SELF_CREATE;
    else process.env.AIDCP_SCHEMA_SELF_CREATE = before;
  }
});

test('纯判定层：缺表时不再逐列刷屏，缺表上的索引也不重复报', () => {
  const verdict = classifySchemaCapability(
    { tables: new Map([['zz_probe', new Set(['a', 'b'])]]), indexes: new Map([['idx_zz_probe', 'zz_probe']]) },
    { tables: new Set(), columns: new Set(), indexes: new Set() },
  );
  assert.equal(verdict.status, 'missing');
  assert.deepEqual(verdict.missingTables, ['zz_probe']);
  assert.deepEqual(verdict.missingColumns, []);
  assert.deepEqual(verdict.missingIndexes, []);
});
