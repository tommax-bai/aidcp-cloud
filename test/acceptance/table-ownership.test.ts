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
  boundarySnapshot,
  isLayer,
  readJson,
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
for (const write of snapshot.writes) {
  if (snapshot.exceptionTables.has(write.table)) continue;
  const owner = snapshot.tableOwners.get(write.table);
  const writerLayer = snapshot.ownership.get(write.file);
  if (!owner || !writerLayer) continue;
  if (owner === writerLayer) continue;
  violations.push({ table: write.table, file: write.file, op: write.op, owner, writerLayer });
}

const exemptionIndex = new Map(exemptions.entries.map((e) => [`${e.table} ${e.file}`, new Set<SqlOp>(e.ops)]));
const isExempted = (v: Violation): boolean => exemptionIndex.get(`${v.table} ${v.file}`)?.has(v.op) === true;
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
    const actual = new Set(violations.map((v) => `${v.table} ${v.file} ${v.op}`));
    const stale: string[] = [];
    for (const entry of exemptions.entries) {
      if (entry.ops.length === 0) stale.push(`${entry.table} <- ${entry.file}（ops 为空）`);
      for (const op of entry.ops) {
        if (!actual.has(`${entry.table} ${entry.file} ${op}`)) stale.push(`${entry.table} <- ${entry.file} [${op}]`);
      }
    }
    assert.deepEqual(
      stale.sort(),
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
  });
});
