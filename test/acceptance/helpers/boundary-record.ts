/**
 * 边界清单的可重跑生成器（record 模式）。
 *
 * 用法（在 aidcp-cloud 仓根）：
 *   npx tsx test/acceptance/helpers/boundary-record.ts ownership   # 只重生成文件级归属表
 *   npx tsx test/acceptance/helpers/boundary-record.ts census      # 只打印对账口径，不写文件
 *   npx tsx test/acceptance/helpers/boundary-record.ts seed        # 一次性 seed 两份豁免清单（仅首次）
 *   npx tsx test/acceptance/helpers/boundary-record.ts all         # ownership + census
 *
 * **棘轮纪律**：`seed` 会覆盖两份豁免清单并把 `frozenTotal` 重置为当天实测值，
 * 只允许在本 change 的一次性 seed 时使用；此后削减违规 MUST 手工删条目并下调 `frozenTotal`，
 * MUST NOT 用 `seed` 重刷（那等于把棘轮拆掉）。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import {
  DDL_OPS,
  DML_OPS,
  type ExemptionList,
  type ImportExemption,
  type Layer,
  type OwnershipEntry,
  type OwnershipRules,
  type DynamicSqlResolution,
  type SqlOp,
  type TableWriteExemption,
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

function writeJson(relative: string, value: unknown): void {
  writeFileSync(repoPath(relative), `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  console.log(`written: ${relative}`);
}

function generateOwnership(): OwnershipEntry[] {
  const rules = readJson<OwnershipRules>('boundaries/ownership-rules.json');
  const entries = expandOwnership(rules, listSourceFiles());
  writeJson('boundaries/module-ownership.json', entries);
  return entries;
}

function layerOf(entries: OwnershipEntry[]): Map<string, Layer> {
  return new Map(entries.map((e) => [e.path, e.layer]));
}

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
  for (const edge of edges) {
    const from = ownership.get(edge.from);
    const to = ownership.get(edge.to);
    if (!from || !to) continue;
    const verdict = classifyEdge(from, to);
    if (verdict === 'allowed') continue;
    if (verdict === 'forbidden') forbidden += 1;
    const key = `${from}->${to}`;
    byDirection.set(key, (byDirection.get(key) ?? 0) + 1);
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

/** 重跑 seed 时保留人工写过的 reason / eliminatedBy / note，避免把已登记的消除计划刷掉。 */
function existingAnnotations<T extends { reason: string; eliminatedBy: string | null; note?: string }>(
  relative: string,
  key: (item: T) => string,
): Map<string, Pick<T, 'reason' | 'eliminatedBy' | 'note'>> {
  try {
    const list = readJson<ExemptionList<T>>(relative);
    return new Map(list.entries.map((e) => [key(e), { reason: e.reason, eliminatedBy: e.eliminatedBy, note: e.note }]));
  } catch {
    return new Map();
  }
}

function seedImportExemptions(entries: OwnershipEntry[]): void {
  const ownership = layerOf(entries);
  const { edges } = scanImports(listSourceFiles());
  const kept = existingAnnotations<ImportExemption>('boundaries/import-exemptions.json', (e) => `${e.from} ${e.to}`);
  const items: ImportExemption[] = [];
  for (const edge of edges) {
    const from = ownership.get(edge.from);
    const to = ownership.get(edge.to);
    if (!from || !to) continue;
    if (classifyEdge(from, to) !== 'exemptable') continue;
    const prior = kept.get(`${edge.from} ${edge.to}`);
    const item: ImportExemption = {
      from: edge.from,
      to: edge.to,
      reason: prior?.reason ?? `seed: ${from} -> ${to} 既存跨边界依赖`,
      eliminatedBy: prior?.eliminatedBy ?? null,
    };
    if (prior?.note) item.note = prior.note;
    items.push(item);
  }
  const list: ExemptionList<ImportExemption> = {
    seedTotal: items.length,
    seedUnplanned: items.filter((i) => i.eliminatedBy === null).length,
    frozenTotal: items.length,
    recordedAt: new Date().toISOString().slice(0, 10),
    raises: [],
    entries: items,
  };
  writeJson('boundaries/import-exemptions.json', list);
}

function seedTableExemptions(entries: OwnershipEntry[]): void {
  const ownership = layerOf(entries);
  const owners = readJson<{ tables: { table: string; owner: Layer; basis: string }[] }>('boundaries/table-ownership.json');
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
    if (!owner || !layer) continue;
    if (owner === layer) continue;
    const key = `${write.table} ${write.file}`;
    const bucket = grouped.get(key) ?? { table: write.table, file: write.file, ops: new Set<SqlOp>() };
    bucket.ops.add(write.op);
    grouped.set(key, bucket);
  }
  const kept = existingAnnotations<TableWriteExemption>(
    'boundaries/table-write-exemptions.json',
    (e) => `${e.table} ${e.file}`,
  );
  const items: TableWriteExemption[] = [...grouped.values()]
    .map((b) => {
      const prior = kept.get(`${b.table} ${b.file}`);
      const item: TableWriteExemption = {
        table: b.table,
        file: b.file,
        ops: [...DML_OPS, ...DDL_OPS].filter((op) => b.ops.has(op)),
        reason: prior?.reason ?? `seed: ${ownership.get(b.file)} 层文件写入属主为 ${ownerOf.get(b.table)} 的表`,
        eliminatedBy: prior?.eliminatedBy ?? null,
      };
      if (prior?.note) item.note = prior.note;
      return item;
    })
    .sort((a, b) => (a.table === b.table ? a.file.localeCompare(b.file) : a.table.localeCompare(b.table)));
  const list: ExemptionList<TableWriteExemption> = {
    seedTotal: items.length,
    seedUnplanned: items.filter((i) => i.eliminatedBy === null).length,
    frozenTotal: items.length,
    recordedAt: new Date().toISOString().slice(0, 10),
    raises: [],
    entries: items,
  };
  writeJson('boundaries/table-write-exemptions.json', list);
}

const mode = process.argv[2] ?? 'all';
if (mode === 'ownership') {
  generateOwnership();
} else if (mode === 'census') {
  census(readJson<OwnershipEntry[]>('boundaries/module-ownership.json'));
} else if (mode === 'seed') {
  const entries = generateOwnership();
  seedImportExemptions(entries);
  seedTableExemptions(entries);
  census(entries);
} else if (mode === 'all') {
  census(generateOwnership());
} else {
  console.error(`unknown mode: ${mode}`);
  process.exit(1);
}
