/**
 * SQL 源码扫描小工具 —— 从退役的边界扫描器 `boundary-scan.ts` 中析出的存活子集。
 *
 * 2026-08-06 cutover（change `invert-split-fact-source`）后，单体导入图与 `AC-BOUND-*` /
 * `AC-OWN-*` 两族门禁随 cloud src/ 一并退役，约 1047 行的 `boundary-scan.ts` 在本仓只剩两个
 * 存活消费方：`migration-executability.ts`（要 `REPO_ROOT` + `scanSqlSource`）与
 * `sync-read-inventory.test.ts`（要 `readJson`）。本文件把这两个消费方需要的部分**逐字**搬来，
 * 其余（导入图 / 归属展开 / 行锁扫描 / 棘轮对账）随门禁一起删除；唯一实现今后活在
 * aidcp-automation 的 `test/acceptance/helpers/boundary-scan.ts`。
 *
 * 注意：本文件与原扫描器同处 `test/acceptance/helpers/`，`REPO_ROOT` 的解析表达式因此
 * 原样保留即解析到同一个仓根；若挪动本文件 MUST 同步改层数。
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = path.resolve(fileURLToPath(new URL('../../../', import.meta.url)));

function repoPath(...parts: string[]): string {
  return path.join(REPO_ROOT, ...parts);
}

export function readJson<T>(relative: string): T {
  return JSON.parse(readFileSync(repoPath(relative), 'utf8')) as T;
}

/* ------------------------------------------------------------------ 注释剥离 */

/**
 * 剥 TypeScript 注释。行注释的 `//` 前紧邻 `:` 时不剥（避免把 `https://…` 之后的整行吃掉）。
 */
export function stripTsComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/gm, '$1');
}

/**
 * 剥 SQL 行注释。**显式规则**：只有「行首或空白 + `--` + 空白或行尾」才算 SQL 注释，
 * 因此 TypeScript 的自减运算符（`i--`、`--i`）不会被误剥。
 */
export function stripSqlLineComments(source: string): string {
  return source.replace(/(^|\s)--(\s[^\n]*|$)/gm, '$1');
}

/* ------------------------------------------------------------------ SQL 解析 */

export type SqlOp = 'insert' | 'update' | 'delete' | 'create_table' | 'alter_table';

export interface SqlWrite {
  file: string;
  table: string;
  op: SqlOp;
}

export interface DynamicSqlSite {
  file: string;
  op: SqlOp;
  excerpt: string;
}

/**
 * 一处读引用（`FROM` / `JOIN` 到的表）。**候选，不是判决**：读模式会顺带命中 CTE 名、子查询别名、
 * 集合返回函数等一堆非表标识符，故消费方 MUST 先按「是否已知表」过滤再判归属。
 */
export interface SqlRead {
  file: string;
  table: string;
  kind: 'from' | 'join';
}

export interface SqlScanResult {
  writes: SqlWrite[];
  /** 读引用候选（未按已知表过滤）。 */
  reads: SqlRead[];
  /** 表名由模板插值拼出、静态判不了 —— MUST 判失败，除非在解析登记表里具名。 */
  dynamic: DynamicSqlSite[];
}

/**
 * `UPDATE <表> [[AS] <别名>] SET` 的语法源串。
 *
 * **别名段 MUST 是可选的**：`UPDATE delegated_tasks t SET …` 这类带别名形态是本仓 UPDATE 的主流写法
 * （2026-07-23 实测 14 处 / 6 文件）。早期版本要求表名后紧跟 `SET`，对这一整类写入完全不可见——
 * 门禁报「无违规」实为「没看见」，违反红线「MUST NOT 静默假成功」。
 *
 * 假阳性仍靠**语法锚定**排除，不靠标识符跳过名单：
 *   - `ON CONFLICT … DO UPDATE SET`：`UPDATE` 后没有表标识符，且额外由 `(?<!\bDO\s{1,4})` 双保险；
 *   - `FOR UPDATE SKIP LOCKED` / `FOR UPDATE OF …`：后面没有 `SET`，且由 `(?<!\bFOR\s{1,4})` 双保险。
 */
const UPDATE_TABLE_PATTERN_SOURCE =
  String.raw`(?<!\bDO\s{1,4})(?<!\bFOR\s{1,4})\bUPDATE\s+(?:ONLY\s+)?(?:public\.)?([a-zA-Z_][a-zA-Z0-9_]*)(?:\s+(?:AS\s+)?[a-zA-Z_][a-zA-Z0-9_]*)?\s+SET\b`;

/**
 * 写操作模式。每条都**锚定到完整语法形态**（而不是「命中关键字后再靠白名单过滤」）：
 *   - `UPDATE <t> [别名] SET` 必须带 `SET`（源串见上）；
 *   - `INSERT INTO` / `DELETE FROM` / `CREATE TABLE` / `ALTER TABLE` 各自带自己的固定引导词。
 */
const WRITE_PATTERNS: { op: SqlOp; re: RegExp }[] = [
  { op: 'insert', re: /\bINSERT\s+INTO\s+(?:ONLY\s+)?(?:public\.)?([a-zA-Z_][a-zA-Z0-9_]*)/gi },
  { op: 'update', re: new RegExp(UPDATE_TABLE_PATTERN_SOURCE, 'gi') },
  { op: 'delete', re: /\bDELETE\s+FROM\s+(?:ONLY\s+)?(?:public\.)?([a-zA-Z_][a-zA-Z0-9_]*)/gi },
  { op: 'create_table', re: /\bCREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:public\.)?([a-zA-Z_][a-zA-Z0-9_]*)/gi },
  { op: 'alter_table', re: /\bALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?(?:public\.)?([a-zA-Z_][a-zA-Z0-9_]*)/gi },
];

/**
 * 读模式（`FROM` / `JOIN` 候选）。`DELETE FROM` 的负向前瞻是必须的：它是写、由 `WRITE_PATTERNS` 认，
 * 不能在这里重复计一次读。命中的标识符**只是候选**（CTE 名 / 子查询别名 / `FROM unnest(...)` 都会命中），
 * 判决前 MUST 按已知表过滤。
 */
const READ_PATTERNS: { kind: SqlRead['kind']; re: RegExp }[] = [
  {
    kind: 'from',
    re: /(?<!\bDELETE\s{1,4})\bFROM\s+(?:ONLY\s+)?(?:public\.)?([a-zA-Z_][a-zA-Z0-9_]*)/gi,
  },
  { kind: 'join', re: /\bJOIN\s+(?:ONLY\s+)?(?:public\.)?([a-zA-Z_][a-zA-Z0-9_]*)/gi },
];

const DYNAMIC_PATTERNS: { op: SqlOp; re: RegExp }[] = [
  { op: 'insert', re: /\bINSERT\s+INTO\s+\$\{/gi },
  { op: 'update', re: /\bUPDATE\s+\$\{/gi },
  { op: 'delete', re: /\bDELETE\s+FROM\s+\$\{/gi },
  { op: 'create_table', re: /\bCREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?\$\{/gi },
  { op: 'alter_table', re: /\bALTER\s+TABLE\s+\$\{/gi },
];

export function scanSqlSource(file: string, rawSource: string): SqlScanResult {
  const source = stripSqlLineComments(stripTsComments(rawSource));
  const writes: SqlWrite[] = [];
  const reads: SqlRead[] = [];
  const dynamic: DynamicSqlSite[] = [];
  const seen = new Set<string>();
  const seenRead = new Set<string>();
  for (const { kind, re } of READ_PATTERNS) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(source)) !== null) {
      const table = m[1].toLowerCase();
      const key = `${kind} ${table}`;
      if (seenRead.has(key)) continue;
      seenRead.add(key);
      reads.push({ file, table, kind });
    }
  }
  for (const { op, re } of WRITE_PATTERNS) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(source)) !== null) {
      const key = `${op} ${m[1]}`;
      if (seen.has(key)) continue;
      seen.add(key);
      writes.push({ file, table: m[1], op });
    }
  }
  for (const { op, re } of DYNAMIC_PATTERNS) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(source)) !== null) {
      dynamic.push({ file, op, excerpt: source.slice(m.index, m.index + 40).replace(/\s+/g, ' ').trim() });
    }
  }
  writes.sort((a, b) => (a.table === b.table ? a.op.localeCompare(b.op) : a.table.localeCompare(b.table)));
  reads.sort((a, b) => (a.table === b.table ? a.kind.localeCompare(b.kind) : a.table.localeCompare(b.table)));
  return { writes, reads, dynamic };
}
