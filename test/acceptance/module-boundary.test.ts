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
  UPDATE_TABLE_PATTERN_SOURCE,
  boundarySnapshot,
  classifyEdge,
  expandOwnership,
  isLayer,
  readAdjudicatedFiles,
  readJson,
  repoPath,
  stripTsComments,
} from './helpers/boundary-scan.js';

const snapshot = boundarySnapshot();
const rules = readJson<OwnershipRules>('boundaries/ownership-rules.json');
const exemptions = readJson<ExemptionList<ImportExemption>>('boundaries/import-exemptions.json');
/**
 * 「已裁决文件」名册 —— 人工维护的 `boundaries/adjudicated-files.json`。
 * **MUST NOT 换成生成物 `module-ownership.json`**：那会让准入判据退化成「是否已经在生成物里」，
 * 手工往生成物塞一条新文件 + 目录默认层即可全绿（2026-07-23 审计坐实，见文末保真自检）。
 */
const adjudicated = readAdjudicatedFiles();

/**
 * 归属查不到的边 —— MUST 报出来判失败，MUST NOT 静默丢弃。
 * 典型形态：`../../scripts/foo.js` 这类解析到 `src/` 之外但确实存在的 `.ts`（正是最该报警的越界形态）。
 */
const unownedEdges: string[] = [];

/** 跨层边（需豁免或被禁止的方向）。允许方向直接不进这个集合。 */
const crossEdges = snapshot.imports.edges.flatMap((edge) => {
  const from = snapshot.ownership.get(edge.from);
  const to = snapshot.ownership.get(edge.to);
  if (!from || !to) {
    unownedEdges.push(`${edge.from}${from ? '' : '（无归属）'} -> ${edge.to}${to ? '' : '（无归属）'}`);
    return [];
  }
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

/**
 * kernel 准入判据（定稿 §4.7 kernel 段）。**写在这里、不进 JSON**，改它必须走代码评审。
 *
 * 「模块级可变单例」一条 MUST 同时覆盖 `export let` / `export var`：导出型可变单例正是最容易被
 * 其它层写坏的那一种，早期版本只锚行首裸 `let` / `var`，`export let …` 直接漏过。
 * 模块级 `const x = new Map()` / `new Set()` 同属可变容器单例，一并锚定（`[^=\n]*` 不跨越 `=` 与换行，
 * 因此 `Map<string, string>` 这类类型标注不会误伤，函数体内的局部量因不在行首也不命中）。
 */
const KERNEL_ADMISSION_CHECKS: { name: string; re: RegExp }[] = [
  {
    name: 'SQL 字面量',
    re: new RegExp(`\\b(INSERT\\s+INTO|DELETE\\s+FROM|CREATE\\s+TABLE|SELECT\\s)|${UPDATE_TABLE_PATTERN_SOURCE}`, 'i'),
  },
  { name: 'HTTP 路由注册', re: /createServer\s*\(|\bres\.writeHead\s*\(|\breq\.url\b|\brouter\./ },
  { name: 'LLM 或供应商 HTTP 调用', re: /\bfetch\s*\(|\bLlmClient\b|\bChatLlmClient\b|['"`]https?:\/\// },
  {
    name: '进程内活状态（模块级可变单例 / 定时器 / 连接池）',
    re: /^(?:export\s+)?(?:let|var)\s|^(?:export\s+)?const\s[^=\n]*=\s*new\s+(?:Map|Set)\b|\bsetInterval\s*\(|\bsetTimeout\s*\(|new\s+Pool\s*\(/m,
  },
];

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

    // 诚实闸：任何一端查不到归属的 import 边 MUST 报出来，MUST NOT 静默丢弃。
    // 典型形态是 `../../scripts/foo.js` —— 解析得到 src/ 之外的真实 .ts，恰恰是最该报警的越界。
    assert.deepEqual(
      [...new Set(unownedEdges)].sort(),
      [],
      `存在归属查不到的 import 边（多半是导入了 src/ 之外的源文件）；MUST 先归属或消除，MUST NOT 当作这条边不存在：\n${[
        ...new Set(unownedEdges),
      ]
        .sort()
        .join('\n')}`,
    );

    // 已裁决名册 MUST 只登记真实存在的源文件（删文件时由 refresh 同步剔除），且不与 fileOverrides 重叠。
    const overridden = new Set(rules.fileOverrides.map((o) => o.path));
    const rosterGhosts = adjudicated.filter((p) => !scanned.has(p)).sort();
    assert.deepEqual(rosterGhosts, [], `已裁决名册里有源码中已不存在的路径：\n${rosterGhosts.join('\n')}`);
    const rosterOverlap = adjudicated.filter((p) => overridden.has(p)).sort();
    assert.deepEqual(
      rosterOverlap,
      [],
      `已裁决名册与 fileOverrides 重叠（fileOverrides 优先，名册里这几条是死条目）：\n${rosterOverlap.join('\n')}`,
    );

    // 归属表 MUST 是规则表的机械展开：两者漂移即失败，防止有人绕过 §4.7 直接改文件级清单。
    // 第三参传**人工名册**：它只决定「逐文件切分目录里的既有文件可否继续走目录默认值」，
    // 层取值仍只来自规则表，故改错层依然会被这条断言抓到；名册里没有的新文件会当场抛「待人工裁决」。
    const expanded = expandOwnership(rules, snapshot.files, adjudicated);
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
    const checks: { name: string; re: RegExp }[] = KERNEL_ADMISSION_CHECKS;
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

    // seedBasis 是「seed 基线为何是这个数」的唯一在仓记录；早期版本的 refresh 会在默认路径上把它静默删掉。
    assert.ok(
      typeof exemptions.seedBasis === 'string' && exemptions.seedBasis.trim() !== '',
      'boundaries/import-exemptions.json MUST 携带非空 seedBasis（seed 基线的由来）；重跑生成器 MUST NOT 把它丢掉',
    );
  });
});

/**
 * 判据保真自检 —— **不属 `AC-BOUND-*` 族编号**（族内编号由定稿 §12 定死为 01..06）。
 * 存在理由：门禁自身漏检时会静默报「无违规」，属红线「MUST NOT 静默假成功」；
 * 这里对已经踩过的漏检形态各留一条机械断言，防止判据被改回去。
 */
describe('kernel 准入判据保真自检（非 AC 编号）', () => {
  const mutableSingleton = KERNEL_ADMISSION_CHECKS.find((c) => c.name.startsWith('进程内活状态'))!;
  const sqlLiteral = KERNEL_ADMISSION_CHECKS.find((c) => c.name === 'SQL 字面量')!;

  it('模块级可变单例：export 形态与裸形态都 MUST 命中', () => {
    for (const source of [
      'export let cachedPool: Pool | null = null;\n',
      'export var counter = 0;\n',
      'let cachedPool = null;\n',
      'var counter = 0;\n',
      'export const registry = new Map<string, string>();\n',
      'const seen = new Set<string>();\n',
    ]) {
      assert.ok(mutableSingleton.re.test(source), `模块级可变单例 MUST 被判违规，实际漏过：${source.trim()}`);
    }
  });

  it('模块级可变单例：不可变导出与函数内局部量 MUST NOT 误判', () => {
    for (const source of [
      'export const DEFAULT_PG_CONFIG = { host: "127.0.0.1" } as const;\n',
      'export function build(): void {\n  const seen = new Map<string, string>();\n  void seen;\n}\n',
    ]) {
      assert.equal(mutableSingleton.re.test(source), false, `不构成模块级可变单例，MUST NOT 判违规：${source.trim()}`);
    }
  });

  it('SQL 字面量：带别名的 UPDATE MUST 命中', () => {
    assert.ok(sqlLiteral.re.test('const q = `UPDATE risk_state r SET status=$1`;'));
    assert.ok(sqlLiteral.re.test('const q = `UPDATE risk_state AS r SET status=$1`;'));
  });
});

/**
 * 归属生成器保真自检 —— **不属 `AC-BOUND-*` 族编号**。
 *
 * 存在理由：`AC-BOUND-01` 只能证明「清单覆盖了当前每个文件」，证明不了「这个层是谁判的」。
 * 若生成器对**逐文件切分目录**（§4.7 里一行拆成多层的那些）的新增文件直接套目录默认值，
 * 门禁会照常全绿——而那个层根本没有人判过，正是红线「MUST NOT 静默假成功」的形态。
 * 这里把「逐文件切分目录的新文件必须报错、单层目录的新文件才可继承」钉成机械断言。
 */
describe('归属生成器保真自检（非 AC 编号）', () => {
  const splitDir = rules.directoryRules.find((d) => (d.newFile ?? 'adjudicate') === 'adjudicate');
  const inheritDir = rules.directoryRules.find((d) => d.newFile === 'inherit');

  it('逐文件切分目录里的新文件 MUST 报错待裁决，MUST NOT 被塞一个默认层', () => {
    assert.ok(splitDir, '规则表里至少应有一个逐文件切分目录（§4.7 有多处）');
    const probe = `${splitDir.dir}zz-unadjudicated-probe.ts`;
    assert.throws(
      () => expandOwnership(rules, [...snapshot.files, probe], adjudicated),
      (error: unknown) => error instanceof Error && error.message.includes(probe),
      `逐文件切分目录 ${splitDir.dir} 下的新文件必须进待裁决清单`,
    );
  });

  it('单层目录里的新文件继承该目录的 §4.7 归属，不误报', () => {
    assert.ok(inheritDir, '规则表里至少应有一个单层目录');
    const probe = `${inheritDir.dir}zz-inherited-probe.ts`;
    const expanded = expandOwnership(rules, [...snapshot.files, probe], adjudicated);
    assert.equal(expanded.find((e) => e.path === probe)?.layer, inheritDir.layer);
  });

  /**
   * 2026-07-23 审计坐实的洗白路径：把生成物 `module-ownership.json` 自己回喂当「已裁决集」时，
   * 手工往生成物里塞一条「新文件 + 目录默认层」即可让 `AC-BOUND-01` 全绿，`refresh` 随后永久洗白。
   * 准入依据 MUST 是人工名册；这条断言钉住「生成物不是准入依据」。
   */
  it('手工往生成物里塞一条新文件 MUST NOT 让它被当成已裁决', () => {
    assert.ok(splitDir);
    const probe = `${splitDir.dir}zz-handedited-probe.ts`;
    const laundered = [...snapshot.ownershipEntries, { path: probe, layer: splitDir.layer, note: '手工塞入' }];
    // 生成物里已经有它了，但人工名册里没有 —— 仍 MUST 判待裁决。
    assert.ok(laundered.some((e) => e.path === probe));
    assert.equal(adjudicated.includes(probe), false);
    assert.throws(
      () => expandOwnership(rules, [...snapshot.files, probe], adjudicated),
      (error: unknown) => error instanceof Error && error.message.includes(probe),
      '「是否被裁决过」的判据 MUST 是人工名册 boundaries/adjudicated-files.json，MUST NOT 是生成物',
    );
  });
});
