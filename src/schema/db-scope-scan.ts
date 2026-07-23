/**
 * 库级作用域机制扫描器（change cloud-schema-migration-executor 任务 10.1，design.md D8）。
 *
 * 扫三类「今天靠『大家连的是同一个数据库』才成立」的机制：
 *   1. advisory lock 调用点     —— 拆 schema 仍互斥，**拆库静默失去互斥**（不报错、业务照跑）；
 *   2. 跨域外键 REFERENCES      —— 拆 schema 仍生效，**拆库外键根本不存在**（脏引用无人拦）；
 *   3. 硬编码 schema 名的形状探测 —— 搬 schema 即指错地方，改 search_path 也救不了。
 *
 * 三类的失效方向都是**静默**的，这正是它们必须被机械清点、而不是只写进文档的理由。
 *
 * 与 test/acceptance/advisory-lock-ownership.test.ts（AC-LOCK-*）的分工：那一条问「这把锁归哪个服务」，
 * 本文件问「还有哪些库级机制没被登记」。两者互不替代。
 *
 * 判定 MUST 先剥注释：仓内大量注释在解释「这里**故意不写** REFERENCES accounts(account_id)」
 * （src/client-auth/client-user-store.ts:126），不剥注释会把一条明确的**反例说明**登记成一条真实外键。
 */

import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

import { repoRoot, stripComments } from './ddl-scan.js';

export interface AdvisoryLockSite {
  file: string;
  line: number;
  /** pg_advisory_lock / pg_try_advisory_lock / pg_advisory_xact_lock / pg_advisory_unlock … */
  fn: string;
}

export interface ForeignKeySite {
  file: string;
  line: number;
  /** `accounts(account_id)` 一类的目标 */
  target: string;
}

export interface SchemaLiteralSite {
  file: string;
  line: number;
  /** 被硬编码的限定名，如 `public.curated_content` */
  qualified: string;
}

export interface DbScopeReport {
  advisoryLocks: AdvisoryLockSite[];
  foreignKeys: ForeignKeySite[];
  schemaLiterals: SchemaLiteralSite[];
  /** 迁移目录里 REFERENCES 的目标表 → 条数（源码之外的另一半事实） */
  migrationForeignKeyTargets: Record<string, number>;
}

/** 扫描根：源码与执行器脚本都要看 —— 执行器的整批锁同样是库级机制，漏掉它就是漏掉一条。 */
const SCAN_DIRS = ['src', 'scripts'];

const ADVISORY = /\b(pg_(?:try_)?advisory(?:_xact)?_(?:lock|unlock)(?:_shared)?)\s*\(/g;
// 单列与复合外键都要认：`REFERENCES t(col)` 与 `REFERENCES t(col1, col2, col3)`。
// 只认单列会让 migrations/0039 的三条复合键 FK（interaction_threads / interaction_messages /
// interaction_reply_jobs）零登记 —— 而它们同样是「拆库即静默失效」的库级机制，必须进清单。
// 复合列表只作为目标名的一部分保留（迁移侧只按表名计数，源码侧本仓当前无复合 FK）。
const REFERENCES = /\bREFERENCES\s+([a-zA-Z_][\w]*)\s*\(\s*([a-zA-Z_][\w]*(?:\s*,\s*[a-zA-Z_][\w]*)*)\s*\)/gi;
const SCHEMA_LITERAL = /['"`]([a-zA-Z_][\w]*)\.([a-zA-Z_][\w]*)['"`]/g;
/** 只有这些前缀是「schema 限定名」；别的 `a.b` 字面量（如 `0.1`、`foo.ts`）不是。 */
const SCHEMA_PREFIXES = new Set(['public']);

function lineOf(text: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < text.length; i += 1) {
    if (text[i] === '\n') line += 1;
  }
  return line;
}

async function listFiles(dir: string, rootLen: number, ext: string, out: string[]): Promise<void> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'dist') continue;
      await listFiles(full, rootLen, ext, out);
    } else if (entry.isFile() && entry.name.endsWith(ext)) {
      out.push(full.slice(rootLen + 1));
    }
  }
}

export async function scanDbScope(root = repoRoot()): Promise<DbScopeReport> {
  const files: string[] = [];
  for (const dir of SCAN_DIRS) await listFiles(path.join(root, dir), root.length, '.ts', files);
  files.sort();

  const selfRelative = path.join('src', 'schema', 'db-scope-scan.ts');
  const advisoryLocks: AdvisoryLockSite[] = [];
  const foreignKeys: ForeignKeySite[] = [];
  const schemaLiterals: SchemaLiteralSite[] = [];

  for (const file of files) {
    if (file === selfRelative) continue;
    const text = stripComments(await readFile(path.join(root, file), 'utf8'));

    ADVISORY.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = ADVISORY.exec(text)) !== null) {
      advisoryLocks.push({ file, line: lineOf(text, m.index), fn: m[1] });
    }

    REFERENCES.lastIndex = 0;
    while ((m = REFERENCES.exec(text)) !== null) {
      foreignKeys.push({ file, line: lineOf(text, m.index), target: `${m[1].toLowerCase()}(${m[2].toLowerCase()})` });
    }

    SCHEMA_LITERAL.lastIndex = 0;
    while ((m = SCHEMA_LITERAL.exec(text)) !== null) {
      if (!SCHEMA_PREFIXES.has(m[1].toLowerCase())) continue;
      schemaLiterals.push({ file, line: lineOf(text, m.index), qualified: `${m[1]}.${m[2]}` });
    }
  }

  const migrationFiles: string[] = [];
  await listFiles(path.join(root, 'migrations'), root.length, '.sql', migrationFiles);
  const migrationForeignKeyTargets: Record<string, number> = {};
  for (const file of migrationFiles.sort()) {
    const text = stripComments(await readFile(path.join(root, file), 'utf8'));
    REFERENCES.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = REFERENCES.exec(text)) !== null) {
      const table = m[1].toLowerCase();
      migrationForeignKeyTargets[table] = (migrationForeignKeyTargets[table] ?? 0) + 1;
    }
  }

  return { advisoryLocks, foreignKeys, schemaLiterals, migrationForeignKeyTargets };
}

/** 清单的稳定形态：不含行号（行号随无关编辑漂移，会把清单变成噪声源）。 */
export interface DbScopeInventory {
  advisoryLocks: Record<string, Record<string, number>>;
  foreignKeys: Record<string, Record<string, number>>;
  schemaLiterals: Record<string, Record<string, number>>;
  migrationForeignKeyTargets: Record<string, number>;
}

function tally<T>(items: T[], file: (t: T) => string, key: (t: T) => string): Record<string, Record<string, number>> {
  const out: Record<string, Record<string, number>> = {};
  for (const item of items) {
    const perFile = (out[file(item)] ??= {});
    const k = key(item);
    perFile[k] = (perFile[k] ?? 0) + 1;
  }
  const sortedFiles = Object.keys(out).sort();
  const sorted: Record<string, Record<string, number>> = {};
  for (const f of sortedFiles) {
    sorted[f] = Object.fromEntries(Object.keys(out[f]).sort().map((k) => [k, out[f][k]]));
  }
  return sorted;
}

export function toInventory(report: DbScopeReport): DbScopeInventory {
  return {
    advisoryLocks: tally(report.advisoryLocks, (s) => s.file, (s) => s.fn),
    foreignKeys: tally(report.foreignKeys, (s) => s.file, (s) => s.target),
    schemaLiterals: tally(report.schemaLiterals, (s) => s.file, (s) => s.qualified),
    migrationForeignKeyTargets: Object.fromEntries(
      Object.keys(report.migrationForeignKeyTargets).sort().map((k) => [k, report.migrationForeignKeyTargets[k]]),
    ),
  };
}
