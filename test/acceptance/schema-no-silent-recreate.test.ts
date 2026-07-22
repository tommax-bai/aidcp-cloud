/**
 * AC-SCHEMA-NO-SILENT-RECREATE — 本 change 的核心红线用例（任务 6.7）。
 *
 * 要堵的洞：回滚到旧版本代码时，表已经被迁走 / 改名，旧存储在启动期发现表不在，
 * 就 `CREATE TABLE IF NOT EXISTS` 建一张空表并开始往里写 —— 全程零告警。
 * 回滚这个动作本身变成一次静默假成功，事后只能靠数据对不上才发现。
 *
 * 断言两件事，缺一不可：
 *   ① 库比代码新时启动被拒，错误码是 schema_ahead_of_code，且超前版本被逐条列出；
 *   ② **这条路径上一条建表语句都没执行过** —— 只断言「报错了」不够，静默重建正是发生在报错之外的地方。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { scanSource } from '../../src/schema/ddl-scan.js';
import {
  KNOWN_MAX_SCHEMA_VERSION,
  REQUIRED_SCHEMA_VERSION,
  evaluateSchemaGate,
  formatGateConclusion,
} from '../../src/schema/schema-contract.js';
import { evaluateSchemaGateWithLedger, runSchemaContractGate } from '../../src/schema/schema-gate.js';

/** 账本比本构建新一条：这就是「回滚到旧代码」在库这一侧的样子。 */
const AHEAD_VERSION = '9999_migrated_away_by_newer_build';

function ledgerStub(versions: string[]) {
  const queries: string[] = [];
  return {
    queries,
    client: {
      async query(text: string) {
        queries.push(text);
        return { rows: versions.map((version) => ({ version })) };
      },
    },
  };
}

/** 记录到的语句里 MUST 一条 DDL 都没有。用与 AC-SCHEMA-DDL-OWNER 同一个扫描器判定，口径只有一份。 */
function ddlIn(queries: string[]): string[] {
  return queries.flatMap((q) => scanSource('gate-path', q, true).map((h) => `${h.verb}:${h.object}`));
}

test('AC-SCHEMA-NO-SILENT-RECREATE-01 账本超前 → enforce 下拒绝启动，且全程零建表', async () => {
  const stub = ledgerStub([REQUIRED_SCHEMA_VERSION, KNOWN_MAX_SCHEMA_VERSION, AHEAD_VERSION]);

  await assert.rejects(
    () => runSchemaContractGate({ client: stub.client, mode: 'enforce' }),
    (err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      assert.match(message, /schema_ahead_of_code/, '错误码 MUST 是 schema_ahead_of_code');
      assert.match(message, new RegExp(AHEAD_VERSION), '超前版本 MUST 被逐条列出，而不是只说「不匹配」');
      return true;
    },
  );

  assert.deepEqual(ddlIn(stub.queries), [], '契约门判定路径上 MUST NOT 执行任何建表 / 改表 / 建索引语句');
  assert.equal(stub.queries.length, 1, '这条路径只读一次账本；多出来的语句都是没被审阅过的副作用');
  assert.match(stub.queries[0], /schema_migrations/);
});

test('AC-SCHEMA-NO-SILENT-RECREATE-02 warn 模式判定结论与 enforce 逐字一致（只是不拒绝启动）', async () => {
  const versions = [REQUIRED_SCHEMA_VERSION, KNOWN_MAX_SCHEMA_VERSION, AHEAD_VERSION];

  const warnStub = ledgerStub(versions);
  const warned = await runSchemaContractGate({ client: warnStub.client, mode: 'warn' });
  assert.equal(warned.decision.code, 'schema_ahead_of_code');
  assert.equal(warned.decision.pass, false, 'warn 只是不拒绝启动，判定本身照样是「不通过」');
  assert.deepEqual(ddlIn(warnStub.queries), []);

  const enforceStub = ledgerStub(versions);
  const expected = formatGateConclusion(
    await evaluateSchemaGateWithLedger(enforceStub.client),
  );
  assert.equal(warned.conclusion, expected, 'warn 与 enforce MUST 输出同一段结论与同一份版本清单');
  assert.match(warned.conclusion, new RegExp(AHEAD_VERSION));
});

test('AC-SCHEMA-NO-SILENT-RECREATE-03 账本不可读同样拒绝，且不落到「先建表再说」', async () => {
  const queries: string[] = [];
  const client = {
    async query(text: string) {
      queries.push(text);
      const err = new Error('relation "schema_migrations" does not exist') as Error & { code?: string };
      err.code = '42P01';
      throw err;
    },
  };

  await assert.rejects(
    () => runSchemaContractGate({ client, mode: 'enforce' }),
    (err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      assert.match(message, /schema_ledger_unreadable/);
      assert.match(message, /无法证明 schema 正确/);
      return true;
    },
  );
  assert.deepEqual(ddlIn(queries), [], '账本读不出来时 MUST NOT 顺手把账本表建出来再继续');
});

test('AC-SCHEMA-NO-SILENT-RECREATE-04 落后于代码时报 schema_behind_code 并列出缺失版本', () => {
  const decision = evaluateSchemaGate({
    ledgerVersions: [],
    knownVersions: [REQUIRED_SCHEMA_VERSION],
    required: REQUIRED_SCHEMA_VERSION,
    knownMax: KNOWN_MAX_SCHEMA_VERSION,
  });
  assert.equal(decision.code, 'schema_behind_code');
  assert.equal(decision.pass, false);
  assert.deepEqual(decision.missing, [REQUIRED_SCHEMA_VERSION]);
  assert.match(formatGateConclusion(decision), /补跑迁移/);
});
