/**
 * 验收用例 `AC-BOUND-01..06` —— 云端模块导入方向门禁。
 *
 * 规范位置：控制仓 docs/cloud-service-decomposition-proposal.md §12「两族门禁」第 1 条
 *   （族名与族内编号以该处为准，MUST NOT 另立命名、MUST NOT 同名不同义）。
 * 归属输入：§4.7「归属总表」→ boundaries/ownership-rules.json → boundaries/module-ownership.json。
 * kernel 花名册与准入条件：§4.7 kernel 段 + §10.9。
 *
 * 环境层级：离线 / 逻辑级（只读源码与清单文件，无外部依赖）。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  LAYERS,
  type ExemptionList,
  type ImportExemption,
  type OwnershipRules,
  boundarySnapshot,
  classifyEdge,
  expandOwnership,
  isLayer,
  readJson,
  repoPath,
  stripTsComments,
} from './helpers/boundary-scan.js';

const snapshot = boundarySnapshot();
const rules = readJson<OwnershipRules>('boundaries/ownership-rules.json');
const exemptions = readJson<ExemptionList<ImportExemption>>('boundaries/import-exemptions.json');

/** 跨层边（需豁免或被禁止的方向）。允许方向直接不进这个集合。 */
const crossEdges = snapshot.imports.edges.flatMap((edge) => {
  const from = snapshot.ownership.get(edge.from);
  const to = snapshot.ownership.get(edge.to);
  if (!from || !to) return [];
  const verdict = classifyEdge(from, to);
  if (verdict === 'allowed') return [];
  return [{ ...edge, fromLayer: from, toLayer: to, verdict }];
});

/** 任务 3.6：每次运行输出机器可读计数（方向分解 / 总数 / frozenTotal / 差值）。 */
const byDirection: Record<string, number> = {};
for (const edge of crossEdges) {
  const key = `${edge.fromLayer}->${edge.toLayer}`;
  byDirection[key] = (byDirection[key] ?? 0) + 1;
}
console.log(
  `AC-BOUND metrics ${JSON.stringify({
    sourceFiles: snapshot.files.length,
    ownershipEntries: snapshot.ownershipEntries.length,
    crossBoundaryEdges: crossEdges.length,
    byDirection,
    // 阶段 3（提取 aidcp-content）的准入取值：一端是 content 的跨边界条数 MUST 先降到 0。
    involvingContent: crossEdges.filter((e) => e.fromLayer === 'content' || e.toLayer === 'content').length,
    exemptionEntries: exemptions.entries.length,
    frozenTotal: exemptions.frozenTotal,
    delta: exemptions.entries.length - exemptions.frozenTotal,
    unplanned: exemptions.entries.filter((e) => e.eliminatedBy === null).length,
  })}`,
);

describe('AC-BOUND-* 导入方向门禁', () => {
  it('AC-BOUND-01 归属表全覆盖且无孤儿条目', () => {
    // 归属表条目数 MUST 等于扫描到的源文件数；两侧任一多出即失败（定稿 §4.0 第 1 条：未归属 MUST 恒为 0）。
    const declared = new Set(snapshot.ownershipEntries.map((e) => e.path));
    const scanned = new Set(snapshot.files);
    const missing = [...scanned].filter((f) => !declared.has(f)).sort();
    const orphans = [...declared].filter((f) => !scanned.has(f)).sort();
    assert.deepEqual(missing, [], `新增源文件未登记归属，先跑 boundary-record ownership 再提交：\n${missing.join('\n')}`);
    assert.deepEqual(orphans, [], `归属表残留源码中已不存在的路径：\n${orphans.join('\n')}`);
    assert.equal(snapshot.ownershipEntries.length, snapshot.files.length);

    // 归属表 MUST 是规则表的机械展开：两者漂移即失败，防止有人绕过 §4.7 直接改文件级清单。
    const expanded = expandOwnership(rules, snapshot.files);
    assert.deepEqual(
      snapshot.ownershipEntries.map((e) => `${e.path}=${e.layer}`),
      expanded.map((e) => `${e.path}=${e.layer}`),
      'module-ownership.json 与 ownership-rules.json 不一致；改归属 MUST 改规则表（其判据来自定稿 §4.7）后重跑生成器',
    );
  });

  it('AC-BOUND-02 层枚举合法且 composition 成员在白名单内', () => {
    const illegal = snapshot.ownershipEntries.filter((e) => !isLayer(e.layer));
    assert.deepEqual(illegal, [], `层取值必须是 ${LAYERS.join(' / ')}，不存在「未分配」取值`);

    const whitelist = new Set(rules.compositionWhitelist);
    const declaredComposition = snapshot.ownershipEntries.filter((e) => e.layer === 'composition').map((e) => e.path);
    const outside = declaredComposition.filter((p) => !whitelist.has(p)).sort();
    assert.deepEqual(outside, [], `白名单外的文件不得声明为 composition：\n${outside.join('\n')}`);

    const missingWhitelisted = [...whitelist].filter((p) => !snapshot.ownership.has(p)).sort();
    assert.deepEqual(missingWhitelisted, [], `composition 白名单里有源码中已不存在的文件：\n${missingWhitelisted.join('\n')}`);
  });

  it('AC-BOUND-03 kernel 准入断言', () => {
    const roster = readJson<{ kernelRoster: { members: string[] }; rejected: { path: string; reason: string }[] }>(
      'boundaries/kernel-non-members.json',
    );
    const kernelFiles = snapshot.ownershipEntries.filter((e) => e.layer === 'kernel').map((e) => e.path).sort();
    assert.deepEqual(
      kernelFiles,
      [...roster.kernelRoster.members].sort(),
      'kernel 花名册以定稿 §4.7 kernel 段为唯一权威；新增成员 MUST 先走 §4.7 的析出 + 回写通道',
    );

    // 逐条准入：无 SQL / 无 HTTP 路由 / 无 LLM 与供应商调用 / 无进程内活状态 / 不反向依赖业务层。
    const checks: { name: string; re: RegExp }[] = [
      { name: 'SQL 字面量', re: /\b(INSERT\s+INTO|UPDATE\s+[a-zA-Z_][a-zA-Z0-9_]*\s+SET|DELETE\s+FROM|CREATE\s+TABLE|SELECT\s)/i },
      { name: 'HTTP 路由注册', re: /createServer\s*\(|\bres\.writeHead\s*\(|\breq\.url\b|\brouter\./ },
      { name: 'LLM 或供应商 HTTP 调用', re: /\bfetch\s*\(|\bLlmClient\b|\bChatLlmClient\b|['"`]https?:\/\// },
      { name: '进程内活状态（模块级可变单例 / 定时器 / 连接池）', re: /^(let|var)\s|\bsetInterval\s*\(|\bsetTimeout\s*\(|new\s+Pool\s*\(/m },
    ];
    const violations: string[] = [];
    for (const file of kernelFiles) {
      const source = stripTsComments(readFileSync(repoPath(file), 'utf8'));
      for (const check of checks) {
        if (check.re.test(source)) violations.push(`${file}: 违反 kernel 准入条件「${check.name}」`);
      }
    }
    const reverse = crossEdges.filter((e) => e.fromLayer === 'kernel');
    for (const edge of reverse) violations.push(`${edge.from} -> ${edge.to}: kernel 层 MUST NOT 导入 ${edge.toLayer} 层，且无豁免通道`);
    assert.deepEqual(violations, [], violations.join('\n'));

    // 被多边共导但 MUST NOT 进 kernel 的文件：路径仍在，且归属不是 kernel。
    const mislabeled = roster.rejected
      .filter((r) => snapshot.ownership.get(r.path) === 'kernel' || !snapshot.ownership.has(r.path))
      .map((r) => r.path);
    assert.deepEqual(mislabeled, [], `kernel 拒入清单里的文件不得被标为 kernel，也不得是已删除路径：\n${mislabeled.join('\n')}`);
  });

  it('AC-BOUND-04 无未豁免的跨边界 import', () => {
    // 诚实闸：解析不到实文件的相对说明符 MUST 失败，MUST NOT 当作这条边不存在。
    assert.deepEqual(
      snapshot.imports.unresolved,
      [],
      `相对 import 说明符解析不到实际源文件：\n${snapshot.imports.unresolved.map((u) => `${u.file} -> ${u.specifier}`).join('\n')}`,
    );

    const forbidden = crossEdges.filter((e) => e.verdict === 'forbidden');
    assert.deepEqual(
      forbidden.map((e) => `${e.from} -> ${e.to} (${e.fromLayer}->${e.toLayer})`),
      [],
      '该方向无豁免通道：任何层 MUST NOT 导入 composition，kernel MUST NOT 导入业务层',
    );

    const exempted = new Set(exemptions.entries.map((e) => `${e.from} ${e.to}`));
    const unexempted = crossEdges
      .filter((e) => e.verdict === 'exemptable' && !exempted.has(`${e.from} ${e.to}`))
      .map((e) => `${e.from} -> ${e.to} (${e.fromLayer}->${e.toLayer})`)
      .sort();
    assert.deepEqual(unexempted, [], `新增了未豁免的跨边界 import：\n${unexempted.join('\n')}`);

    const missingReason = exemptions.entries.filter((e) => !e.reason || e.reason.trim() === '');
    assert.deepEqual(missingReason, [], '每条豁免条目 MUST 携带 reason');
  });

  it('AC-BOUND-05 无失效（源码中已不存在）的豁免条目', () => {
    const actual = new Set(crossEdges.filter((e) => e.verdict === 'exemptable').map((e) => `${e.from} ${e.to}`));
    const stale = exemptions.entries
      .filter((e) => !actual.has(`${e.from} ${e.to}`))
      .map((e) => `${e.from} -> ${e.to}`)
      .sort();
    assert.deepEqual(
      stale,
      [],
      `豁免清单里有源码中已不存在的条目；削减 MUST 在同一提交里删条目并下调 frozenTotal，不留空位给新违规回填：\n${stale.join('\n')}`,
    );
  });

  it('AC-BOUND-06 条目数 ≤ frozenTotal 棘轮，上调必须带合规 raises[]', () => {
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
      `frozenTotal ${exemptions.frozenTotal} 高于 seed 值 ${exemptions.seedTotal} 且未由 raises[] 覆盖（已批准上调合计 ${raisedAmount}）；` +
        '上调只走定稿 §12「例外通道（唯一）」，MUST 由控制仓 change 批准并写明数量与消除时限',
    );

    const unplanned = exemptions.entries.filter((e) => e.eliminatedBy === null).length;
    assert.ok(
      unplanned <= exemptions.seedUnplanned,
      `未挂消除 change 的条目数 ${unplanned} 高于 seed 值 ${exemptions.seedUnplanned}；该数 MUST 单调不增（定稿 §12 棘轮规则第 1 条）`,
    );
  });
});
