/**
 * 验收用例 `AC-OWN-01..05` —— 云端表写入与建表归属门禁。
 *
 * 规范位置：控制仓 docs/cloud-service-decomposition-proposal.md §12「两族门禁」第 2 条
 *   （族名与族内编号以该处为准）。属主输入：§5.1「单一写入者」→ boundaries/table-ownership.json。
 *   两张运维表的设计内永久例外走 boundaries/exception-tables.json，不占豁免条目、不参与棘轮计数。
 *
 * 环境层级：离线 / 逻辑级（只读源码、migrations 与清单文件，无数据库连接）。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  DDL_OPS,
  DML_OPS,
  type ExemptionList,
  type SqlOp,
  type TableOwnershipFile,
  type TableWriteExemption,
  RatchetViolationError,
  boundarySnapshot,
  isLayer,
  readJson,
  reconcileExemptions,
  scanSqlSource,
} from './helpers/boundary-scan.js';

const snapshot = boundarySnapshot();
const owners = readJson<TableOwnershipFile>('boundaries/table-ownership.json');
const exemptions = readJson<ExemptionList<TableWriteExemption>>('boundaries/table-write-exemptions.json');

/** src 自建表 ∪ migrations 建表 —— 表全集口径与 change `cloud-schema-migration-executor` 统一。 */
const srcCreated = new Set(snapshot.sql.writes.filter((w) => w.op === 'create_table').map((w) => w.table));
const knownTables = new Set([...srcCreated, ...snapshot.migrationTables]);

interface Violation {
  table: string;
  file: string;
  op: SqlOp;
  owner: string;
  writerLayer: string;
}

const violations: Violation[] = [];
/**
 * 属主或写入方归属查不到的写入点 —— MUST 报出来判失败，MUST NOT 静默丢弃。
 * 本族自持这条断言，不依赖另一个测试文件里的 `AC-BOUND-01`（那是隐式耦合，单独跑本文件时不成立）。
 */
const unresolvedWrites: string[] = [];
for (const write of snapshot.writes) {
  if (snapshot.exceptionTables.has(write.table)) continue;
  const owner = snapshot.tableOwners.get(write.table);
  const writerLayer = snapshot.ownership.get(write.file);
  if (!owner || !writerLayer) {
    unresolvedWrites.push(
      `${write.table}${owner ? '' : '（表无属主）'} <- ${write.file}${writerLayer ? '' : '（写入方无归属）'} [${write.op}]`,
    );
    continue;
  }
  if (owner === writerLayer) continue;
  violations.push({ table: write.table, file: write.file, op: write.op, owner, writerLayer });
}

/**
 * 豁免按 `{表, 文件, 操作}` 三元组精确匹配：已豁免 `delete` 的条目挡不住新加的 `insert`，
 * 已豁免 `update` 的条目也挡不住新加的 `alter_table`。这条口径同时是清单本身的条目粒度
 * （每个三元组一条条目），故棘轮的键与门禁的键**是同一个键**——键少一维就会两头一起失明。
 */
const exemptionKey = (e: { table: string; file: string; op: SqlOp }): string => `${e.table} ${e.file} ${e.op}`;
const exemptionIndex = new Set(exemptions.entries.map(exemptionKey));
const isExempted = (v: Violation): boolean => exemptionIndex.has(exemptionKey(v));
const describeViolation = (v: Violation): string =>
  `${v.table} <- ${v.file} [${v.op}]（表属主 ${v.owner} / 写入方 ${v.writerLayer}）`;

console.log(
  `AC-OWN metrics ${JSON.stringify({
    knownTables: knownTables.size,
    srcCreatedTables: srcCreated.size,
    migrationTables: snapshot.migrationTables.length,
    exceptionTables: [...snapshot.exceptionTables],
    writeSites: snapshot.writes.length,
    crossLayerWrites: violations.length,
    dmlViolations: violations.filter((v) => (DML_OPS as SqlOp[]).includes(v.op)).length,
    ddlViolations: violations.filter((v) => (DDL_OPS as SqlOp[]).includes(v.op)).length,
    exemptionEntries: exemptions.entries.length,
    frozenTotal: exemptions.frozenTotal,
    delta: exemptions.entries.length - exemptions.frozenTotal,
    unplanned: exemptions.entries.filter((e) => e.eliminatedBy === null).length,
  })}`,
);

describe('AC-OWN-* 表写入与建表归属门禁', () => {
  it('AC-OWN-01 表归属表覆盖全部已知表且无孤儿', () => {
    const declared = owners.tables.map((t) => t.table);
    const duplicates = declared.filter((t, i) => declared.indexOf(t) !== i).sort();
    assert.deepEqual(duplicates, [], `每张表 MUST 恰好有一个属主层，重复登记：\n${duplicates.join('\n')}`);

    const badLayer = owners.tables.filter((t) => !isLayer(t.owner)).map((t) => `${t.table}=${t.owner}`);
    assert.deepEqual(badLayer, [], `属主层取值非法：\n${badLayer.join('\n')}`);

    const declaredSet = new Set(declared);
    const missing = [...knownTables].filter((t) => !declaredSet.has(t)).sort();
    const orphans = declared.filter((t) => !knownTables.has(t)).sort();
    assert.deepEqual(missing, [], `表归属清单未覆盖以下已知表，MUST 先登记属主：\n${missing.join('\n')}`);
    assert.deepEqual(orphans, [], `表归属清单里有源码与 migrations 都不再建的表：\n${orphans.join('\n')}`);

    const overlap = [...snapshot.exceptionTables].filter((t) => declaredSet.has(t)).sort();
    assert.deepEqual(
      overlap,
      [],
      `设计内永久例外表（无单一 owner）MUST 只登记在 exception-tables.json：\n${overlap.join('\n')}`,
    );

    // 诚实闸一：命中一个既不在表全集、也不在例外表清单里的标识符 MUST 失败，MUST NOT 静默跳过。
    const unknown = [
      ...new Set(
        snapshot.writes
          .map((w) => w.table)
          .filter((t) => !knownTables.has(t) && !snapshot.exceptionTables.has(t)),
      ),
    ].sort();
    assert.deepEqual(unknown, [], `SQL 扫描命中未登记的表标识符：\n${unknown.join('\n')}`);

    // 诚实闸一之二：属主或写入方归属查不到的写入点 MUST 失败，MUST NOT 当作这个写入不存在。
    const unresolved = [...new Set(unresolvedWrites)].sort();
    assert.deepEqual(
      unresolved,
      [],
      `存在归属查不到的写入点（表无属主 / 写入方文件不在归属表内）；MUST 先补登记，MUST NOT 静默跳过：\n${unresolved.join('\n')}`,
    );

    // 诚实闸二：动态拼接 SQL MUST 在解析登记表里具名，未登记与失效条目都判失败。
    assert.deepEqual(
      snapshot.dynamic.unregistered.map((d) => `${d.file} [${d.op}] ${d.excerpt}`),
      [],
      '存在未登记的动态拼接 SQL；MUST 在 boundaries/dynamic-sql-resolutions.json 逐处具名，MUST NOT 跳过',
    );
    assert.deepEqual(
      snapshot.dynamic.stale.map((d) => `${d.file} [${d.op}]`),
      [],
      '动态 SQL 解析登记表里有源码中已不存在的条目，MUST 同批清理',
    );
  });

  it('AC-OWN-02 无未豁免的跨层 DML 写入', () => {
    const unexempted = violations
      .filter((v) => (DML_OPS as SqlOp[]).includes(v.op) && !isExempted(v))
      .map(describeViolation)
      .sort();
    assert.deepEqual(unexempted, [], `非属主层新增了 DML 写入：\n${unexempted.join('\n')}`);
  });

  it('AC-OWN-03 无未豁免的跨层 DDL（建表 / 改表）', () => {
    const unexempted = violations
      .filter((v) => (DDL_OPS as SqlOp[]).includes(v.op) && !isExempted(v))
      .map(describeViolation)
      .sort();
    assert.deepEqual(
      unexempted,
      [],
      `非属主层新增了建表 / 改表语句（回滚时会静默重建空表并分叉写入）：\n${unexempted.join('\n')}`,
    );
  });

  it('AC-OWN-04 无失效豁免条目', () => {
    // 条目粒度 MUST 是 {表, 文件, 操作} 三元组：op 取值非法 = 键坏了，一律判失败而不是当它不存在。
    const validOps = new Set<string>([...DML_OPS, ...DDL_OPS]);
    const badOp = exemptions.entries.filter((e) => !validOps.has(e.op)).map((e) => `${e.table} <- ${e.file} [${e.op}]`);
    assert.deepEqual(badOp, [], `豁免条目的 op MUST 是 ${[...validOps].join(' / ')} 之一：\n${badOp.join('\n')}`);

    const duplicates = exemptions.entries
      .map(exemptionKey)
      .filter((k, i, all) => all.indexOf(k) !== i)
      .sort();
    assert.deepEqual(duplicates, [], `同一个 {表, 文件, 操作} 三元组 MUST 只有一条豁免条目：\n${duplicates.join('\n')}`);

    const actual = new Set(violations.map((v) => `${v.table} ${v.file} ${v.op}`));
    const stale = exemptions.entries
      .filter((e) => !actual.has(exemptionKey(e)))
      .map((e) => `${e.table} <- ${e.file} [${e.op}]`)
      .sort();
    assert.deepEqual(
      stale,
      [],
      `豁免清单里有源码中已不存在的跨层写入；削减 MUST 在同一提交里删条目并下调 frozenTotal：\n${stale.join('\n')}`,
    );

    const missingReason = exemptions.entries.filter((e) => !e.reason || e.reason.trim() === '');
    assert.deepEqual(missingReason, [], '每条豁免条目 MUST 携带 reason');
  });

  it('AC-OWN-05 条目数 ≤ frozenTotal 棘轮，上调必须带合规 raises[]', () => {
    assert.ok(
      exemptions.entries.length <= exemptions.frozenTotal,
      `豁免条目数 ${exemptions.entries.length} 超过 frozenTotal ${exemptions.frozenTotal}`,
    );

    const raisedAmount = exemptions.raises.reduce((sum, r) => sum + r.amount, 0);
    for (const raise of exemptions.raises) {
      assert.ok(Number.isInteger(raise.amount) && raise.amount > 0, `raises[] 的 amount 必须是正整数：${JSON.stringify(raise)}`);
      assert.ok(
        typeof raise.approvedByChange === 'string' && raise.approvedByChange.trim() !== '',
        `raises[] 的 approvedByChange（批准它的控制仓 change 名）不得缺失：${JSON.stringify(raise)}`,
      );
      assert.match(raise.eliminateBy ?? '', /^\d{4}-\d{2}-\d{2}$/, `raises[] 的 eliminateBy 必须是具体日期：${JSON.stringify(raise)}`);
    }
    assert.ok(
      exemptions.frozenTotal <= exemptions.seedTotal + raisedAmount,
      `frozenTotal ${exemptions.frozenTotal} 高于 seed 值 ${exemptions.seedTotal} 且未由 raises[] 覆盖（已批准上调合计 ${raisedAmount}）`,
    );

    const unplanned = exemptions.entries.filter((e) => e.eliminatedBy === null).length;
    assert.ok(
      unplanned <= exemptions.seedUnplanned,
      `未挂消除 change 的条目数 ${unplanned} 高于 seed 值 ${exemptions.seedUnplanned}；该数 MUST 单调不增`,
    );

    // seedBasis 是「seed 基线为何是这个数」的唯一在仓记录；早期版本的 refresh 会在默认路径上把它静默删掉。
    assert.ok(
      typeof exemptions.seedBasis === 'string' && exemptions.seedBasis.trim() !== '',
      'boundaries/table-write-exemptions.json MUST 携带非空 seedBasis（seed 基线的由来）；重跑生成器 MUST NOT 把它丢掉',
    );
  });
});

/**
 * 棘轮键保真自检 —— **不属 `AC-OWN-*` 族编号**。
 *
 * 存在理由（2026-07-23 审计坐实）：棘轮曾按「条目数」计而不按「表×文件×操作」计。已豁免的
 * `(表, 文件)` 对上新增一个操作时条目数不变，`refresh` 会自己把 `ops` 拓宽写回文件并**退出 0**，
 * 随后 `AC-OWN-03`「无未豁免的跨层 DDL」全绿——门禁在一类真实可达的改动上恒绿，正是红线
 * 「MUST NOT 静默假成功」。这里把「新增操作 = 新增违规 = 棘轮当场拒绝」钉成机械断言。
 */
describe('棘轮键保真自检（非 AC 编号）', () => {
  const entry = (op: SqlOp): TableWriteExemption => ({
    table: 'probe_table',
    file: 'src/probe/writer.ts',
    op,
    reason: 'probe',
    eliminatedBy: null,
  });
  const seeded: ExemptionList<TableWriteExemption> = {
    seedTotal: 1,
    seedUnplanned: 1,
    frozenTotal: 1,
    recordedAt: '2026-07-23',
    raises: [],
    entries: [entry('update')],
    seedBasis: 'probe',
  };
  const input = (current: TableWriteExemption[]) => ({
    relative: 'boundaries/table-write-exemptions.json',
    list: seeded,
    current,
    keyOf: exemptionKey,
    describe: (e: TableWriteExemption) => `${e.table} <- ${e.file} [${e.op}]`,
    merge: (fresh: TableWriteExemption, prior: TableWriteExemption | undefined) => ({
      ...fresh,
      reason: prior?.reason ?? fresh.reason,
    }),
  });

  it('已豁免的 (表, 文件) 对上新增 alter_table MUST 被棘轮拒绝', () => {
    assert.throws(
      () => reconcileExemptions(input([entry('update'), entry('alter_table')]), { reseed: false, raises: [] }),
      (error: unknown) =>
        error instanceof RatchetViolationError && error.added.join('\n').includes('[alter_table]'),
      '新增操作等价于新增违规，MUST NOT 被静默拓宽进已有条目',
    );
  });

  it('操作集不变时棘轮放行，且 seedBasis MUST 原样留在清单头部', () => {
    const result = reconcileExemptions(input([entry('update')]), { reseed: false, raises: [] });
    assert.equal(result.added.length, 0);
    assert.equal(result.removed.length, 0);
    assert.equal(result.list.seedBasis, 'probe');
    assert.equal(result.list.frozenTotal, 1);
  });

  it('违规消失时棘轮下调 frozenTotal（恒允许），seedTotal 不动', () => {
    const result = reconcileExemptions(input([]), { reseed: false, raises: [] });
    assert.equal(result.removed.length, 1);
    assert.equal(result.list.frozenTotal, 0);
    assert.equal(result.list.seedTotal, 1);
  });

  it('--reseed 缺 seed-note 或已有 raises[] 时 MUST 拒绝', () => {
    assert.throws(
      () => reconcileExemptions(input([entry('update')]), { reseed: true, raises: [], seedNote: '  ' }),
      /seed-note/,
    );
    const withRaise = { ...input([entry('update')]), list: { ...seeded, raises: [{ amount: 1, approvedByChange: 'x', eliminateBy: '2026-09-30' }] } };
    assert.throws(
      () => reconcileExemptions(withRaise, { reseed: true, raises: [], seedNote: '理由' }),
      /raises/,
    );
  });
});

/**
 * 扫描器保真自检 —— **不属 `AC-OWN-*` 族编号**（族内编号由定稿 §12 定死为 01..05）。
 *
 * 存在理由：扫描器漏检时门禁会报「无违规」而实为「没看见」，属红线「MUST NOT 静默假成功」，
 * 而这种漏检既不会让任何用例变红、也不会被 typecheck 抓到。已经踩过的形态在这里各留一条机械断言。
 * 实测教训：`UPDATE <表> <别名> SET` 是本仓 UPDATE 的主流写法（2026-07-23 实测 14 处 / 6 文件），
 * 早期版本的 UPDATE 分支要求表名后紧跟 `SET`，对这一整类写入完全失明；修复后写入点 229 → 231。
 */
describe('SQL 扫描器保真自检（非 AC 编号）', () => {
  const tablesOf = (sql: string, op: SqlOp): string[] =>
    scanSqlSource('probe.ts', `const q = \`${sql}\`;`)
      .writes.filter((w) => w.op === op)
      .map((w) => w.table);

  it('UPDATE：裸形态、别名形态、AS 别名、ONLY / public. 前缀都 MUST 命中', () => {
    assert.deepEqual(tablesOf('UPDATE risk_state SET status=$1', 'update'), ['risk_state']);
    assert.deepEqual(tablesOf('UPDATE risk_state r SET status=$1 WHERE r.id=$2', 'update'), ['risk_state']);
    assert.deepEqual(tablesOf('UPDATE risk_state AS r SET status=$1', 'update'), ['risk_state']);
    assert.deepEqual(tablesOf('UPDATE ONLY public.risk_state r SET status=$1', 'update'), ['risk_state']);
    assert.deepEqual(tablesOf('UPDATE\n  delegated_tasks t\n  SET version=version+1', 'update'), ['delegated_tasks']);
  });

  it('UPDATE：三类实测假阳性形态 MUST NOT 命中', () => {
    assert.deepEqual(tablesOf('INSERT INTO risk_state (id) VALUES ($1) ON CONFLICT (id) DO UPDATE SET status=$2', 'update'), []);
    assert.deepEqual(tablesOf('SELECT id FROM delegated_tasks WHERE status=$1 FOR UPDATE SKIP LOCKED', 'update'), []);
    assert.deepEqual(tablesOf('SELECT id FROM delegated_tasks t FOR UPDATE OF t', 'update'), []);
  });

  it('UPDATE：假阳性形态与真写入同处一段 SQL 时，只取真写入', () => {
    const sql = [
      'WITH locked AS (SELECT id FROM delegated_tasks WHERE status=$1 FOR UPDATE SKIP LOCKED)',
      'UPDATE delegated_tasks t SET status=$2 FROM locked WHERE t.id=locked.id',
    ].join('\n');
    assert.deepEqual(tablesOf(sql, 'update'), ['delegated_tasks']);
  });
});
