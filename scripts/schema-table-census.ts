/**
 * 表全集与运行时 DDL 的统一口径脚本（change cloud-schema-migration-executor 任务 4.1）。
 *
 *   npx tsx scripts/schema-table-census.ts
 *
 * 存在的理由：`cloud-schema-migration-executor` 与 `cloud-service-boundary-gates` 两个 change
 * 各自记了一份「库里一共几张表 / 几张由 src 建」的数字，两份只要差一张，后者的
 * 「未登记的表出现即失败」当天就会红。口径必须由同一个脚本产出、结果同时回写两处。
 *
 * 口径（MUST 与定稿 §5.4.1 一致）：
 *  - 扫描前 MUST 先剥注释：`.sql` 剥 `--` 行注释与 `/* *\/` 块注释；`.ts` 另剥 `//` 行注释。
 *    否则会把注释里提到 DDL 的那十几行当成真实建表点。
 *  - 运行时 DDL 计数 MUST 按三元组给出：文本命中 / 去注释后生效 / 分布的源文件数。MUST NOT 只写一个数。
 */

import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const DDL_PATTERN = /\b(CREATE\s+TABLE|ALTER\s+TABLE|CREATE\s+INDEX|CREATE\s+UNIQUE\s+INDEX)\b/i;

/** 剥块注释；`stripLineComments` 里的 `--` 只对 .sql 生效，`//` 只对 .ts 生效。 */
export function stripComments(source: string, kind: 'sql' | 'ts'): string {
  // 剥块注释时 MUST 保留原有换行数，否则剥后行号与原文错位，
  // 「这一行去注释后还算不算 DDL」的判定会读到隔壁行 —— 计数会凭空少掉一大半。
  const withoutBlocks = source.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
  return withoutBlocks
    .split('\n')
    .map((line) => {
      if (kind === 'sql') return line.replace(/--.*$/, '');
      // .ts：DDL 活在模板字符串里，所以三种注释都要剥 ——
      //  ① 整行 `//` 注释与块注释续行 `*`（TS 注释）；
      //  ② 模板串里的 `-- ` SQL 行注释（`--` 后必须跟空白，才不会误伤自减运算符 `i--`）。
      const trimmed = line.trimStart();
      if (trimmed.startsWith('//') || trimmed.startsWith('*')) return '';
      return line.replace(/(^|\s)--\s.*$/, '$1');
    })
    .join('\n');
}

async function walk(dir: string, ext: string, out: string[] = []): Promise<string[]> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) await walk(full, ext, out);
    else if (entry.name.endsWith(ext)) out.push(full);
  }
  return out;
}

export interface DdlHit {
  file: string;
  line: number;
  statement: string;
}

export async function scanRuntimeDdl(srcDir = path.join(repoRoot, 'src')): Promise<{
  textualHits: DdlHit[];
  effectiveHits: DdlHit[];
  effectiveFiles: string[];
}> {
  const files = (await walk(srcDir, '.ts')).sort();
  const textualHits: DdlHit[] = [];
  const effectiveHits: DdlHit[] = [];
  const effectiveFiles = new Set<string>();

  for (const file of files) {
    const rel = path.relative(repoRoot, file);
    const source = await readFile(file, 'utf8');
    const rawLines = source.split('\n');
    const strippedLines = stripComments(source, 'ts').split('\n');
    for (let i = 0; i < rawLines.length; i += 1) {
      if (!DDL_PATTERN.test(rawLines[i])) continue;
      textualHits.push({ file: rel, line: i + 1, statement: rawLines[i].trim() });
      if (DDL_PATTERN.test(strippedLines[i] ?? '')) {
        effectiveHits.push({ file: rel, line: i + 1, statement: strippedLines[i].trim() });
        effectiveFiles.add(rel);
      }
    }
  }
  return { textualHits, effectiveHits, effectiveFiles: [...effectiveFiles].sort() };
}

const CREATE_TABLE_NAME = /CREATE\s+TABLE\s+([a-zA-Z_$][\w.${}]*)/gi;

async function tablesIn(dir: string, ext: string, kind: 'sql' | 'ts'): Promise<{ tables: Set<string>; dynamic: number }> {
  const files = await walk(dir, ext);
  const tables = new Set<string>();
  let dynamic = 0;
  for (const file of files) {
    // 先把 `IF NOT EXISTS` 归一掉，避免表名是模板插值时正则回溯把 `IF` 当成表名。
    const stripped = stripComments(await readFile(file, 'utf8'), kind)
      .replace(/CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+/gi, 'CREATE TABLE ');
    CREATE_TABLE_NAME.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = CREATE_TABLE_NAME.exec(stripped)) !== null) {
      const name = m[1].replace(/^public\./, '');
      if (name.includes('$') || name.includes('{')) {
        dynamic += 1;
        continue;
      }
      tables.add(name);
    }
  }
  return { tables, dynamic };
}

async function main(): Promise<void> {
  const mig = await tablesIn(path.join(repoRoot, 'migrations'), '.sql', 'sql');
  const src = await tablesIn(path.join(repoRoot, 'src'), '.ts', 'ts');
  const migrationTables = mig.tables;
  const srcTables = src.tables;
  const union = new Set([...migrationTables, ...srcTables]);
  const onlySrc = [...srcTables].filter((t) => !migrationTables.has(t)).sort();
  const onlyMigrations = [...migrationTables].filter((t) => !srcTables.has(t)).sort();
  const ddl = await scanRuntimeDdl();

  console.log(JSON.stringify({
    tables: {
      byMigrations: migrationTables.size,
      bySrc: srcTables.size,
      union: union.size,
      onlySrcCount: onlySrc.length,
      onlyMigrationsCount: onlyMigrations.length,
      dynamicNameCreateTableInSrc: src.dynamic,
      onlySrc,
    },
    // 定稿 §5.4.1 的三元组口径：文本命中 / 去注释后生效 / 分布的源文件数。MUST NOT 只给一个数。
    runtimeCreateTable: {
      textualHits: ddl.textualHits.filter((h) => /CREATE\s+TABLE/i.test(h.statement)).length,
      effectiveHits: ddl.effectiveHits.filter((h) => /CREATE\s+TABLE/i.test(h.statement)).length,
      effectiveFiles: new Set(
        ddl.effectiveHits.filter((h) => /CREATE\s+TABLE/i.test(h.statement)).map((h) => h.file),
      ).size,
    },
    runtimeDdlAll: {
      textualHits: ddl.textualHits.length,
      effectiveHits: ddl.effectiveHits.length,
      effectiveFiles: ddl.effectiveFiles.length,
    },
  }, null, 2));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
