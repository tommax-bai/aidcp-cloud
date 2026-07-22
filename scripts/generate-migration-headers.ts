/**
 * 一次性工具：为历史迁移文件补 `-- aidcp:kind=` 与 `-- aidcp:objects=` 头声明
 * （change cloud-schema-migration-executor 任务 1.8 / 2.3）。
 *
 *   npx tsx scripts/generate-migration-headers.ts [--write]
 *
 * 为什么需要它：60 个历史文件逐个手写对象清单不现实，而 `verify` 又 MUST 只读头声明、
 * MUST NOT 在运行时由 SQL 文本推断 —— 推断不完整就是假阴性，而这里的假阴性等价于「验证通过」。
 * 折中是把推断挪到**一次性、结果签入仓库、可人工审阅**的这一步：头声明一旦落盘就是权威声明，
 * 之后的漂移由 test/schema/migration-numbering.test.ts 与 migrate verify 负责暴露。
 *
 * 生成规则：
 *  - 按复合序模拟整条迁移序列，维护「当前活着的对象集合」，每个对象归属于最后创建它的那个文件；
 *    后续文件 DROP / RENAME 掉的对象不会留在任何头声明里（否则 verify 必然报一堆假缺失）。
 *  - 只声明 table / column / index 三类。约束名在 PG 里大量由系统生成（列级 CHECK / UNIQUE 都会
 *    自动命名），机械登记只会制造噪声而不是事实，故 MUST NOT 机械生成 constraint 声明；
 *    确需守住的具名约束由人手加进头，或由既有的 SQL 合同测试（test/interactions/migration-contract.test.ts）守。
 *  - kind：文件里出现 DROP TABLE / DROP COLUMN / RENAME / ALTER COLUMN … TYPE / SET NOT NULL /
 *    DROP INDEX / DROP CONSTRAINT 之一即判 contract，否则 expand。
 */

import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { findAddedColumns } from '../src/schema/ddl-objects.js';
import { loadMigrationFiles, migrationsDir } from '../src/schema/migration-files.js';
import { parseMigrationHeader, versionOf } from '../src/schema/migration-plan.js';

/**
 * contract 判定标记，MUST 与 test/schema/expand-only.test.ts 的禁用清单逐条一致
 * （tasks.md 7.4：DROP TABLE / DROP COLUMN / RENAME TO / ALTER COLUMN … TYPE / SET NOT NULL / DROP INDEX）。
 * 刻意不含 `DROP CONSTRAINT`：仓内既有的「先 DROP CONSTRAINT 再 ADD 更宽的 CHECK」是放宽而非收紧，
 * 旧代码在其之后仍能正常读写，按 D6 的判定标准属 expand。
 */
const CONTRACT_MARKERS: RegExp[] = [
  /\bDROP\s+TABLE\b/i,
  /\bDROP\s+COLUMN\b/i,
  /\bDROP\s+INDEX\b/i,
  /\bRENAME\s+(TO|COLUMN)\b/i,
  /\bALTER\s+COLUMN\s+\w+\s+TYPE\b/i,
  /\bSET\s+NOT\s+NULL\b/i,
];

function stripSqlComments(sql: string): string {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .split('\n')
    .map((l) => l.replace(/--.*$/, ''))
    .join('\n');
}

const COLUMN_KEYWORDS = new Set([
  'primary', 'unique', 'foreign', 'check', 'constraint', 'exclude', 'like', 'partition',
]);

/** 取 `CREATE TABLE name (` 后的平衡括号体。 */
function balancedBody(sql: string, openIndex: number): string {
  let depth = 0;
  for (let i = openIndex; i < sql.length; i += 1) {
    if (sql[i] === '(') depth += 1;
    else if (sql[i] === ')') {
      depth -= 1;
      if (depth === 0) return sql.slice(openIndex + 1, i);
    }
  }
  return '';
}

function splitTopLevel(body: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  for (const ch of body) {
    if (ch === '(') depth += 1;
    else if (ch === ')') depth -= 1;
    if (ch === ',' && depth === 0) {
      parts.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  if (current.trim()) parts.push(current);
  return parts;
}

interface LiveObject {
  type: 'table' | 'column' | 'index';
  name: string;
  owner: string;
}

function simulate(files: { name: string; content: string }[]): Map<string, LiveObject> {
  const live = new Map<string, LiveObject>();
  const key = (type: string, name: string) => `${type}:${name}`;

  const dropTable = (table: string) => {
    live.delete(key('table', table));
    for (const k of [...live.keys()]) {
      if (k.startsWith('column:') && k.slice('column:'.length).startsWith(`${table}.`)) live.delete(k);
    }
  };

  // 语句 MUST 按文档顺序施加：同一个文件里「先 DROP INDEX 再 CREATE 同名 INDEX」很常见，
  // 按正则分类批量处理会让 DROP 赢过后面的 CREATE，把一个活着的索引判成已删。
  // 加列**不在这张表里**：多子句 `ALTER TABLE t ADD COLUMN a, ADD COLUMN b` 一段式正则只认得第一列，
  // 而这里生成的是 verify 的权威声明，漏掉的列 verify 永远报不出缺失。改用与运行时探测同源的两段解析
  // （src/schema/ddl-objects.ts 的 findAddedColumns），生成端与校验端只有一份口径。
  const PATTERNS: { kind: string; re: RegExp }[] = [
    { kind: 'createTable', re: /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([a-zA-Z_][\w]*)\s*\(/gi },
    { kind: 'createIndex', re: /CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:CONCURRENTLY\s+)?(?:IF\s+NOT\s+EXISTS\s+)?([a-zA-Z_][\w]*)\s+ON\s+/gi },
    { kind: 'dropTable', re: /DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?([a-zA-Z_][\w]*)/gi },
    { kind: 'dropColumn', re: /ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?([a-zA-Z_][\w]*)\s+DROP\s+COLUMN\s+(?:IF\s+EXISTS\s+)?([a-zA-Z_][\w]*)/gi },
    { kind: 'renameColumn', re: /ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?([a-zA-Z_][\w]*)\s+RENAME\s+COLUMN\s+([a-zA-Z_][\w]*)\s+TO\s+([a-zA-Z_][\w]*)/gi },
    { kind: 'renameTable', re: /ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?([a-zA-Z_][\w]*)\s+RENAME\s+TO\s+([a-zA-Z_][\w]*)/gi },
    { kind: 'dropIndex', re: /DROP\s+INDEX\s+(?:CONCURRENTLY\s+)?(?:IF\s+EXISTS\s+)?([a-zA-Z_][\w]*)/gi },
    { kind: 'renameIndex', re: /ALTER\s+INDEX\s+(?:IF\s+EXISTS\s+)?([a-zA-Z_][\w]*)\s+RENAME\s+TO\s+([a-zA-Z_][\w]*)/gi },
  ];

  for (const file of files) {
    const owner = versionOf(file.name);
    const sql = stripSqlComments(file.content);

    const events: { at: number; kind: string; m: RegExpExecArray }[] = [];
    for (const { kind, re } of PATTERNS) {
      re.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = re.exec(sql)) !== null) events.push({ at: m.index, kind, m });
    }
    for (const added of findAddedColumns(sql)) {
      const synthetic = [added.clause, added.table, added.column] as unknown as RegExpExecArray;
      events.push({ at: added.at, kind: 'addColumn', m: synthetic });
    }
    events.sort((a, b) => a.at - b.at);

    for (const ev of events) {
      const m = ev.m;
      // `IF NOT EXISTS` 命中一个已经活着的对象时是 no-op：归属 MUST 留在最先创建它的那条迁移，
      // 否则「原样抽存储常量」补齐的基线文件会把别人早就建过的表抢过来，头声明会误导读者。
      const idempotent = /IF\s+NOT\s+EXISTS/i.test(m[0]);
      if (ev.kind === 'createTable') {
        const table = m[1];
        if (idempotent && live.has(key('table', table))) continue;
        live.set(key('table', table), { type: 'table', name: table, owner });
        const body = balancedBody(sql, m.index + m[0].length - 1);
        for (const part of splitTopLevel(body)) {
          const first = part.trim().split(/\s+/)[0];
          if (!first) continue;
          if (COLUMN_KEYWORDS.has(first.toLowerCase())) continue;
          if (!/^[a-zA-Z_][\w]*$/.test(first)) continue;
          live.set(key('column', `${table}.${first}`), { type: 'column', name: `${table}.${first}`, owner });
        }
      } else if (ev.kind === 'addColumn') {
        const name = `${m[1]}.${m[2]}`;
        if (idempotent && live.has(key('column', name))) continue;
        live.set(key('column', name), { type: 'column', name, owner });
      } else if (ev.kind === 'createIndex') {
        if (idempotent && live.has(key('index', m[1]))) continue;
        live.set(key('index', m[1]), { type: 'index', name: m[1], owner });
      } else if (ev.kind === 'dropTable') {
        dropTable(m[1]);
      } else if (ev.kind === 'dropColumn') {
        live.delete(key('column', `${m[1]}.${m[2]}`));
      } else if (ev.kind === 'renameColumn') {
        live.delete(key('column', `${m[1]}.${m[2]}`));
        const name = `${m[1]}.${m[3]}`;
        live.set(key('column', name), { type: 'column', name, owner });
      } else if (ev.kind === 'renameTable') {
        const from = m[1];
        const to = m[2];
        const columns = [...live.values()].filter((o) => o.type === 'column' && o.name.startsWith(`${from}.`));
        dropTable(from);
        live.set(key('table', to), { type: 'table', name: to, owner });
        for (const col of columns) {
          const name = `${to}.${col.name.slice(from.length + 1)}`;
          live.set(key('column', name), { type: 'column', name, owner });
        }
      } else if (ev.kind === 'dropIndex') {
        live.delete(key('index', m[1]));
      } else if (ev.kind === 'renameIndex') {
        live.delete(key('index', m[1]));
        live.set(key('index', m[2]), { type: 'index', name: m[2], owner });
      }
    }
  }

  return live;
}

function chunkObjects(objects: string[], perLine = 4): string[] {
  const lines: string[] = [];
  for (let i = 0; i < objects.length; i += perLine) {
    lines.push(`-- aidcp:objects=${objects.slice(i, i + perLine).join(',')}`);
  }
  return lines;
}

/** 去掉文件里已有的 `-- aidcp:kind=` / `-- aidcp:objects=` 行（重生成时用）。 */
function stripHeaderLines(content: string): string {
  return content
    .split('\n')
    .filter((line) => !/^[ \t]*--[ \t]*aidcp:(kind|objects)[ \t]*=/.test(line))
    .join('\n')
    .replace(/^\n+/, '');
}

async function main(): Promise<void> {
  const write = process.argv.includes('--write');
  /**
   * `--rewrite`：连已有头声明的文件一并重生成。默认只补缺头的文件——但**对象归属依赖复合序**，
   * 一旦有文件改名 / 插到序列前面（例如把基线表提到 0000），旧头就会停留在旧归属上。
   *
   * 注意：重写会改文件校验和。账本一旦落账，改校验和就是 `migration_checksum_mismatch`（整批拒绝），
   * 所以 `--rewrite` MUST 只在该批迁移进真库账本**之前**用。
   */
  const rewrite = process.argv.includes('--rewrite');
  const files = await loadMigrationFiles();
  const live = simulate(files);

  const byOwner = new Map<string, string[]>();
  for (const obj of live.values()) {
    const list = byOwner.get(obj.owner) ?? [];
    list.push(`${obj.type}:${obj.name}`);
    byOwner.set(obj.owner, list);
  }
  for (const list of byOwner.values()) list.sort();

  let changed = 0;
  for (const file of files) {
    const version = versionOf(file.name);
    const existing = parseMigrationHeader(file.content);
    const hasHeader = Boolean(existing.kind) && /aidcp:objects=/.test(file.content);
    if (hasHeader && !rewrite) continue;

    const body = hasHeader ? stripHeaderLines(file.content) : file.content;
    const sql = stripSqlComments(body);
    const inferred = CONTRACT_MARKERS.some((re) => re.test(sql)) ? 'contract' : 'expand';
    // 已有的 kind 是人工审阅过的结论，MUST 保留：机械推断只是缺省值。不一致时报出来，由人裁决。
    const kind = existing.kind ?? inferred;
    if (existing.kind && existing.kind !== inferred) {
      console.log(`${version}: ! 保留人工 kind=${existing.kind}（机械推断为 ${inferred}）`);
    }
    const objects = byOwner.get(version) ?? [];
    const header = [
      `-- aidcp:kind=${kind}`,
      ...(objects.length > 0 ? chunkObjects(objects) : ['-- aidcp:objects=']),
      '',
    ].join('\n');
    const next = header + body;
    if (next === file.content) continue;
    console.log(`${version}: kind=${kind}, objects=${objects.length}`);
    if (write) await writeFile(path.join(migrationsDir(), file.name), next, 'utf8');
    changed += 1;
  }
  console.log(`${write ? '已写入' : '待写入'} ${changed} 个文件（共 ${files.length}）`);
  if (!write) console.log('（干跑；加 --write 落盘）');
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

void readFile;
