/**
 * 边界清单的可重跑生成器。
 *
 * 用法（在 aidcp-cloud 仓根；`npm run boundaries:*` 是同一入口的别名）：
 *   npm run boundaries:refresh          # 事实侧全量重算并写回清单（默认棘轮只减不增）
 *   npm run boundaries:census           # 只打印对账口径，不写任何文件
 *   npx tsx test/acceptance/helpers/boundary-record.ts ownership   # 只重生成文件级归属表
 *
 * ## 一条分界线：重算「事实」可以自动，重判「归属」不可以
 *
 * 可以自动重算的是**事实**：当前实际存在哪些源文件、哪些跨边界 import、哪些表写入点、哪些表。
 * MUST NOT 自动生成的是**人判**：某个新文件属于哪一层、某张新表的属主是谁。后者的判据是控制仓
 * 定稿 `docs/cloud-service-decomposition-proposal.md` §4.7 / §5.1，脚本无权代判。
 * 因此 `refresh` 遇到下列三种情形一律**报错并列出待裁决清单**，MUST NOT 塞一个默认值放过：
 *
 *   1. 新增源文件落在 §4.7「逐文件切分」的目录里（或没有任何目录规则覆盖）→ 待裁归属层；
 *   2. 新增表没有属主登记（或登记表里有已消失的表）→ 待裁属主层 / 待清理；
 *   3. 出现豁免清单里没有的新违规 → 默认判失败（棘轮），要么修掉，要么走下面两条显式通道。
 *
 * ## 棘轮与两条显式通道
 *
 * 默认（不带任何 raise / reseed 标志）只允许**下调**：违规消失即删条目并把 `frozenTotal` 减掉相应数量。
 *
 *   --raise=<控制仓 change 名>:<数量>:<YYYY-MM-DD>   （可重复）
 *       定稿 §12「例外通道（唯一）」：具名上调冻结总数，三字段齐备才算数。
 *   --reseed
 *       **只在 seed 窗口内合法**：门禁 change `cloud-service-boundary-gates` 尚未归档、
 *       棘轮尚未开始计数的那段时间。它会按当天实测重置 `seedTotal` / `seedUnplanned` / `frozenTotal`
 *       并清空 `raises[]`。该 change 归档之后再用它 = 把棘轮拆掉。
 *
 * 两种模式都保留人工写过的 `reason` / `eliminatedBy` / `note`，不会把已登记的消除计划刷掉。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import {
  DDL_OPS,
  DML_OPS,
  type ExemptionList,
  type ExemptionRaise,
  type ImportExemption,
  type Layer,
  type OwnershipEntry,
  type OwnershipRules,
  type DynamicSqlResolution,
  type SqlOp,
  type TableOwnershipFile,
  type TableWriteExemption,
  UnadjudicatedFilesError,
  auditDynamicSql,
  classifyEdge,
  expandOwnership,
  listMigrationTables,
  listSourceFiles,
  readJson,
  repoPath,
  scanImports,
  scanSqlWrites,
  stripSqlLineComments,
  stripTsComments,
} from './boundary-scan.js';

const OWNERSHIP_PATH = 'boundaries/module-ownership.json';
const IMPORT_EXEMPTIONS_PATH = 'boundaries/import-exemptions.json';
const TABLE_EXEMPTIONS_PATH = 'boundaries/table-write-exemptions.json';

function writeJson(relative: string, value: unknown): void {
  writeFileSync(repoPath(relative), `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  console.log(`written: ${relative}`);
}

/* ------------------------------------------------------------------ 命令行 */

interface Options {
  reseed: boolean;
  raises: ExemptionRaise[];
  /** 新增豁免条目的 `eliminatedBy` 默认值；未给即为 `null`（seed 期允许，棘轮期由 raises 通道把关）。 */
  eliminatedBy: string | null;
  seedNote: string | null;
}

function parseOptions(argv: string[]): Options {
  const opts: Options = { reseed: false, raises: [], eliminatedBy: null, seedNote: null };
  for (const arg of argv) {
    if (arg === '--reseed') {
      opts.reseed = true;
    } else if (arg.startsWith('--raise=')) {
      const [approvedByChange, amountText, eliminateBy] = arg.slice('--raise='.length).split(':');
      const amount = Number(amountText);
      if (!approvedByChange || !Number.isInteger(amount) || amount <= 0 || !/^\d{4}-\d{2}-\d{2}$/.test(eliminateBy ?? '')) {
        throw new Error(
          `--raise 的形态必须是 <控制仓 change 名>:<正整数数量>:<YYYY-MM-DD>，收到：${arg}\n` +
            '（三个字段缺一不可，定稿 §12「例外通道（唯一）」逐字要求）',
        );
      }
      opts.raises.push({ amount, approvedByChange, eliminateBy: eliminateBy as string });
    } else if (arg.startsWith('--eliminated-by=')) {
      opts.eliminatedBy = arg.slice('--eliminated-by='.length) || null;
    } else if (arg.startsWith('--seed-note=')) {
      opts.seedNote = arg.slice('--seed-note='.length) || null;
    } else {
      throw new Error(`未知参数：${arg}`);
    }
  }
  return opts;
}

/* ------------------------------------------------------------------ 归属 */

/** 重生成文件级归属表。遇到未裁决的新文件即抛错并列出清单，MUST NOT 塞默认层。 */
function generateOwnership(): OwnershipEntry[] {
  const rules = readJson<OwnershipRules>('boundaries/ownership-rules.json');
  let prior: OwnershipEntry[] = [];
  try {
    prior = readJson<OwnershipEntry[]>(OWNERSHIP_PATH);
  } catch {
    prior = [];
  }
  const entries = expandOwnership(rules, listSourceFiles(), prior);
  writeJson(OWNERSHIP_PATH, entries);
  return entries;
}

function layerOf(entries: OwnershipEntry[]): Map<string, Layer> {
  return new Map(entries.map((e) => [e.path, e.layer]));
}

/* ------------------------------------------------------------------ 表登记核对 */

/**
 * 表登记只核对、不代判：缺属主的新表与已消失的孤儿条目都报错并列出。
 * 属主层是 §5.1 的人判结论，脚本 MUST NOT 生成。
 */
function auditTableRegistry(): void {
  const owners = readJson<TableOwnershipFile>('boundaries/table-ownership.json');
  const exceptions = new Set(
    readJson<{ tables: { table: string }[] }>('boundaries/exception-tables.json').tables.map((t) => t.table),
  );
  const scan = scanSqlWrites(listSourceFiles());
  const srcCreated = new Set(scan.writes.filter((w) => w.op === 'create_table').map((w) => w.table));
  const known = new Set([...srcCreated, ...listMigrationTables()]);
  const declared = new Set(owners.tables.map((t) => t.table));

  const missing = [...known].filter((t) => !declared.has(t) && !exceptions.has(t)).sort();
  const orphans = [...declared].filter((t) => !known.has(t)).sort();
  const problems: string[] = [];
  if (missing.length > 0) {
    problems.push(
      `以下表已被 src/ 或 migrations/ 建出来但没有属主登记，MUST 先按定稿 §5.1 逐张裁定属主并写进 boundaries/table-ownership.json：\n  ${missing.join(
        '\n  ',
      )}`,
    );
  }
  if (orphans.length > 0) {
    problems.push(
      `boundaries/table-ownership.json 里有源码与 migrations 都不再建的表，MUST 人工确认后删除（自动删会丢掉已写好的 §5.1 依据）：\n  ${orphans.join(
        '\n  ',
      )}`,
    );
  }
  if (problems.length > 0) throw new Error(problems.join('\n\n'));
}

/* ------------------------------------------------------------------ 棘轮对账 */

interface Reconciled<T> {
  list: ExemptionList<T>;
  added: T[];
  removed: T[];
  changed: string[];
}

/**
 * 把一份豁免清单对到当天实测的违规集合上。
 *
 *   - 违规消失 → 删条目、`frozenTotal` 同步下调（棘轮下调，恒允许）；
 *   - 出现新违规 → 默认判失败；只有 `--reseed` 或足量 `--raise=` 才放行；
 *   - 人工写过的 `reason` / `eliminatedBy` / `note` 一律保留。
 */
function reconcile<T extends { reason: string; eliminatedBy: string | null; note?: string }>(
  relative: string,
  current: T[],
  keyOf: (item: T) => string,
  describe: (item: T) => string,
  merge: (fresh: T, prior: T | undefined) => { item: T; changedNote?: string },
  opts: Options,
): Reconciled<T> {
  const list = readJson<ExemptionList<T>>(relative);
  const priorByKey = new Map(list.entries.map((e) => [keyOf(e), e]));
  const currentKeys = new Set(current.map(keyOf));

  const removed = list.entries.filter((e) => !currentKeys.has(keyOf(e)));
  const added = current.filter((c) => !priorByKey.has(keyOf(c)));
  const changed: string[] = [];

  const entries = current
    .map((fresh) => {
      const prior = priorByKey.get(keyOf(fresh));
      const merged = merge(fresh, prior);
      if (merged.changedNote) changed.push(merged.changedNote);
      return merged.item;
    })
    .sort((a, b) => describe(a).localeCompare(describe(b)));

  if (opts.reseed) {
    const list2: ExemptionList<T> = {
      seedTotal: entries.length,
      seedUnplanned: entries.filter((e) => e.eliminatedBy === null).length,
      frozenTotal: entries.length,
      recordedAt: new Date().toISOString().slice(0, 10),
      raises: [],
      entries,
    };
    if (opts.seedNote) (list2 as ExemptionList<T> & { seedBasis: string }).seedBasis = opts.seedNote;
    else if ((list as ExemptionList<T> & { seedBasis?: string }).seedBasis) {
      (list2 as ExemptionList<T> & { seedBasis: string }).seedBasis = (list as ExemptionList<T> & { seedBasis: string }).seedBasis;
    }
    return { list: list2, added, removed, changed };
  }

  // 棘轮模式：先按消失的条目下调，再看新增是否有合规的上调通道兜住。
  const loweredFrozen = list.frozenTotal - removed.length;
  const needed = Math.max(0, entries.length - loweredFrozen);
  const approved = opts.raises.reduce((sum, r) => sum + r.amount, 0);
  if (needed > 0 && approved < needed) {
    throw new Error(
      `${relative}：出现 ${added.length} 条清单里没有的新违规，棘轮不允许静默追加（定稿 §12：seed 之后发现的既存违规 MUST 当场修复）。\n` +
        `${added.map((a) => `  + ${describe(a)}`).join('\n')}\n` +
        (changed.length > 0 ? `另有已登记条目的操作集变大：\n${changed.map((c) => `  ~ ${c}`).join('\n')}\n` : '') +
        `处置只有三条，按优先级：\n` +
        `  1) 先查归属是否填错——多数「新违规」其实是新文件的归属层没按 §4.7 判对；\n` +
        `  2) 修掉这条跨边界依赖 / 跨层写入；\n` +
        `  3) 确需冻结时走定稿 §12「例外通道（唯一）」：--raise=<控制仓 change 名>:<数量>:<YYYY-MM-DD>` +
        `（当前还差 ${needed - approved} 条批准额度），并逐条补 reason 与消除动作。\n` +
        `  （门禁 change 尚未归档、棘轮尚未开始计数时，另有 --reseed 一条 seed 窗口内的通道。）`,
    );
  }
  const raises = [...list.raises, ...opts.raises];
  return {
    list: {
      seedTotal: list.seedTotal,
      seedUnplanned: list.seedUnplanned,
      frozenTotal: Math.max(loweredFrozen, entries.length),
      recordedAt: new Date().toISOString().slice(0, 10),
      raises,
      entries,
    },
    added,
    removed,
    changed,
  };
}

/* ------------------------------------------------------------------ 两族违规的当日实测 */

function currentImportViolations(entries: OwnershipEntry[]): ImportExemption[] {
  const ownership = layerOf(entries);
  const { edges } = scanImports(listSourceFiles());
  const out: ImportExemption[] = [];
  for (const edge of edges) {
    const from = ownership.get(edge.from);
    const to = ownership.get(edge.to);
    if (!from || !to) continue; // 归属查不到的边由 AC-BOUND-01 判失败，不在本文件里静默处理。
    if (classifyEdge(from, to) !== 'exemptable') continue;
    out.push({ from: edge.from, to: edge.to, reason: `${from} -> ${to} 既存跨边界依赖`, eliminatedBy: null });
  }
  return out;
}

function currentTableViolations(entries: OwnershipEntry[]): TableWriteExemption[] {
  const ownership = layerOf(entries);
  const owners = readJson<TableOwnershipFile>('boundaries/table-ownership.json');
  const ownerOf = new Map(owners.tables.map((t) => [t.table, t.owner]));
  const exceptions = new Set(
    readJson<{ tables: { table: string }[] }>('boundaries/exception-tables.json').tables.map((t) => t.table),
  );
  const scan = scanSqlWrites(listSourceFiles());
  const dynamic = auditDynamicSql(
    scan.dynamic,
    readJson<{ sites: DynamicSqlResolution[] }>('boundaries/dynamic-sql-resolutions.json').sites,
  );
  const writes = [...scan.writes, ...dynamic.resolvedWrites].filter((w) => !exceptions.has(w.table));
  const grouped = new Map<string, { table: string; file: string; ops: Set<SqlOp> }>();
  for (const write of writes) {
    const owner = ownerOf.get(write.table);
    const layer = ownership.get(write.file);
    if (!owner || !layer) continue; // 同上：由 AC-OWN-01 判失败。
    if (owner === layer) continue;
    const key = `${write.table} ${write.file}`;
    const bucket = grouped.get(key) ?? { table: write.table, file: write.file, ops: new Set<SqlOp>() };
    bucket.ops.add(write.op);
    grouped.set(key, bucket);
  }
  return [...grouped.values()].map((b) => ({
    table: b.table,
    file: b.file,
    ops: [...DML_OPS, ...DDL_OPS].filter((op) => b.ops.has(op)),
    reason: `${ownership.get(b.file)} 层文件写入属主为 ${ownerOf.get(b.table)} 的表`,
    eliminatedBy: null,
  }));
}

/* ------------------------------------------------------------------ refresh */

function refresh(opts: Options): void {
  const entries = generateOwnership();
  auditTableRegistry();

  const imports = reconcile<ImportExemption>(
    IMPORT_EXEMPTIONS_PATH,
    currentImportViolations(entries),
    (e) => `${e.from} ${e.to}`,
    (e) => `${e.from} -> ${e.to}`,
    (fresh, prior) => {
      const item: ImportExemption = {
        from: fresh.from,
        to: fresh.to,
        reason: prior?.reason ?? `seed: ${fresh.reason}`,
        eliminatedBy: prior ? prior.eliminatedBy : opts.eliminatedBy,
      };
      if (prior?.note) item.note = prior.note;
      return { item };
    },
    opts,
  );

  const tables = reconcile<TableWriteExemption>(
    TABLE_EXEMPTIONS_PATH,
    currentTableViolations(entries),
    (e) => `${e.table} ${e.file}`,
    (e) => `${e.table} <- ${e.file}`,
    (fresh, prior) => {
      const item: TableWriteExemption = {
        table: fresh.table,
        file: fresh.file,
        ops: fresh.ops,
        reason: prior?.reason ?? `seed: ${fresh.reason}`,
        eliminatedBy: prior ? prior.eliminatedBy : opts.eliminatedBy,
      };
      if (prior?.note) item.note = prior.note;
      const grew = prior ? fresh.ops.filter((op) => !prior.ops.includes(op)) : [];
      return {
        item,
        changedNote: grew.length > 0 ? `${fresh.table} <- ${fresh.file} 新增操作 ${grew.join('/')}` : undefined,
      };
    },
    opts,
  );

  writeJson(IMPORT_EXEMPTIONS_PATH, imports.list);
  writeJson(TABLE_EXEMPTIONS_PATH, tables.list);

  for (const [name, r] of [
    ['import-exemptions', imports],
    ['table-write-exemptions', tables],
  ] as const) {
    console.log(
      `\n[${name}] 条目 ${r.list.entries.length}（新增 ${r.added.length} / 删除 ${r.removed.length}）` +
        ` frozenTotal ${r.list.frozenTotal} seedTotal ${r.list.seedTotal} seedUnplanned ${r.list.seedUnplanned}`,
    );
    for (const item of r.added) console.log(`  + 新增：${JSON.stringify(item)}`);
    for (const item of r.removed) console.log(`  - 删除（源码中已不存在）：${JSON.stringify(item)}`);
    for (const note of r.changed) console.log(`  ~ ${note}`);
  }
  if (imports.added.length > 0 || tables.added.length > 0) {
    console.log(
      '\n新增条目的 reason / note MUST 人工补写清楚「由哪个 change 新增了什么、怎么消除」；' +
        '生成器只写占位文案，重跑时会保留你写过的内容。',
    );
  }
  census(entries);
}

/* ------------------------------------------------------------------ 对账输出 */

function census(entries: OwnershipEntry[]): void {
  const ownership = layerOf(entries);
  const files = listSourceFiles();

  const byLayer = new Map<string, number>();
  for (const entry of entries) byLayer.set(entry.layer, (byLayer.get(entry.layer) ?? 0) + 1);
  console.log(`\n[归属] 源文件 ${files.length}，归属条目 ${entries.length}`);
  for (const [layer, count] of [...byLayer].sort()) console.log(`  ${layer.padEnd(12)} ${count}`);

  const { edges, unresolved } = scanImports(files);
  if (unresolved.length > 0) {
    console.log(`\n[诚实闸] 解析不到实文件的相对说明符 ${unresolved.length} 条：`);
    for (const u of unresolved) console.log(`  ${u.file} -> ${u.specifier}`);
  }
  const byDirection = new Map<string, number>();
  let forbidden = 0;
  const unowned: string[] = [];
  for (const edge of edges) {
    const from = ownership.get(edge.from);
    const to = ownership.get(edge.to);
    if (!from || !to) {
      unowned.push(`${edge.from} -> ${edge.to}`);
      continue;
    }
    const verdict = classifyEdge(from, to);
    if (verdict === 'allowed') continue;
    if (verdict === 'forbidden') forbidden += 1;
    const key = `${from}->${to}`;
    byDirection.set(key, (byDirection.get(key) ?? 0) + 1);
  }
  if (unowned.length > 0) {
    console.log(`\n[诚实闸] 端点查不到归属的 import 边 ${unowned.length} 条：`);
    for (const e of unowned) console.log(`  ${e}`);
  }
  const total = [...byDirection.values()].reduce((a, b) => a + b, 0);
  console.log(`\n[导入方向] 需豁免/禁止的跨层边 ${total} 条（其中无豁免通道的 ${forbidden} 条）`);
  for (const [dir, count] of [...byDirection].sort((a, b) => b[1] - a[1])) console.log(`  ${dir.padEnd(28)} ${count}`);

  const { writes, dynamic } = scanSqlWrites(files);
  const migrationTables = listMigrationTables();
  const srcTables = new Set(writes.filter((w) => w.op === 'create_table').map((w) => w.table));
  const allTables = new Set([...srcTables, ...migrationTables]);
  const touched = new Set(writes.map((w) => w.table));
  console.log(`\n[表全集] distinct 并集 ${allTables.size} 张；src 自建 ${srcTables.size} 张；migrations 建 ${migrationTables.length} 张`);
  // §5.4.1 / §17 第 8 项的三元组口径：文本命中 / 去注释后生效 / 所在文件数。
  let ddlTextHits = 0;
  let ddlEffective = 0;
  const ddlFiles = new Set<string>();
  const CREATE_RE = /\bCREATE\s+TABLE\b/gi;
  for (const file of files) {
    const raw = readFileSync(repoPath(file), 'utf8');
    const text = raw.match(CREATE_RE)?.length ?? 0;
    const effective = stripSqlLineComments(stripTsComments(raw)).match(CREATE_RE)?.length ?? 0;
    ddlTextHits += text;
    ddlEffective += effective;
    if (text > 0) ddlFiles.add(file);
  }
  console.log(`[建表点] src 内 CREATE TABLE：文本命中 ${ddlTextHits} 处 / 去注释后生效 ${ddlEffective} 处 / 分布在 ${ddlFiles.size} 个源文件`);
  console.log(`[表写入] 被写/被建的 distinct 表 ${touched.size} 张；写入点（表×文件×操作）${writes.length} 条`);
  const unknown = [...touched].filter((t) => !allTables.has(t)).sort();
  if (unknown.length > 0) console.log(`[诚实闸] 命中但不在表全集里的标识符：${unknown.join(', ')}`);
  if (dynamic.length > 0) {
    console.log(`\n[动态 SQL] ${dynamic.length} 处表名由模板插值拼出，MUST 在 boundaries/dynamic-sql-resolutions.json 具名：`);
    for (const d of dynamic) console.log(`  ${d.file} [${d.op}] ${d.excerpt}`);
  }
  console.log('');
}

/* ------------------------------------------------------------------ 入口 */

const mode = process.argv[2] ?? 'refresh';
try {
  const opts = parseOptions(process.argv.slice(3));
  if (mode === 'ownership') {
    generateOwnership();
  } else if (mode === 'census') {
    census(readJson<OwnershipEntry[]>(OWNERSHIP_PATH));
  } else if (mode === 'refresh') {
    refresh(opts);
  } else if (mode === 'seed') {
    console.error(
      'seed 模式已并入 refresh：一次性 seed 请用 `npm run boundaries:refresh -- --reseed`（仅限门禁 change 归档前的 seed 窗口）。',
    );
    process.exit(1);
  } else {
    console.error(`unknown mode: ${mode}（可用：refresh / ownership / census）`);
    process.exit(1);
  }
} catch (error) {
  if (error instanceof UnadjudicatedFilesError) {
    console.error(`\n[待人工裁决] ${error.message}\n`);
  } else {
    console.error(`\n[失败] ${error instanceof Error ? error.message : String(error)}\n`);
  }
  process.exit(1);
}
