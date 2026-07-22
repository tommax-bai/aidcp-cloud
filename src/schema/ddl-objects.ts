/**
 * 从一段 DDL 文本里抽出「它会创建哪些对象」（change cloud-schema-migration-executor 第 3 / 5 节）。
 *
 * 两个用途，共用同一份解析口径（两份口径迟早会漂，漂了就没人知道以哪份为准）：
 *  1. `test/schema/ddl-parity.test.ts`：比对存储源码 DDL 与补齐迁移建出的对象是否一致；
 *  2. `src/schema/schema-capability.ts`：把「这个存储原本会自建什么」翻译成「它现在要求库里有什么」。
 *
 * 与 `scripts/generate-migration-headers.ts` 的 `simulate()` 的分工：那边要模拟整条序列（含 DROP / RENAME
 * 导致的对象消亡）来算「谁拥有这个对象」；这边只回答「这一段文本会建出什么」，不做序列模拟。
 * 两者刻意分开：让只需要后者的调用方不必背上前者的复杂度。
 *
 * 本文件只解析建表 / 加列 / 建索引三类，且**只解析文本**，MUST NOT 拿去当作库里实际有什么的证据——
 * 那是 `schema-inspect.ts` 读数据库目录的职责。
 */

import { stripComments } from './ddl-scan.js';

export interface CreatedObjects {
  /** 表名 → 该表被建出的列名集合 */
  tables: Map<string, Set<string>>;
  /** 索引名 → 它建在哪张表上 */
  indexes: Map<string, string>;
}

const CREATE_TABLE = /\bCREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([a-zA-Z_][\w]*)\s*\(/gi;
const CREATE_INDEX = /\bCREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:CONCURRENTLY\s+)?(?:IF\s+NOT\s+EXISTS\s+)?([a-zA-Z_][\w]*)\s+ON\s+([a-zA-Z_][\w]*)/gi;

/**
 * 加列必须**两段解析**：先切出整条 `ALTER TABLE … ;` 语句，再在语句体内全局找 `ADD COLUMN` 子句。
 *
 * 一段式的 `/ALTER\s+TABLE\s+(\w+)\s+ADD\s+COLUMN\s+(\w+)/` 要求每个 `ADD COLUMN` 前都紧跟改表关键字，
 * 于是一条语句里逗号分隔的第 2 个及之后的 `ADD COLUMN` **全部丢失**。
 * （本段刻意不把改表关键字连着写出来，否则会被 AC-SCHEMA-DDL-OWNER 的文本命中数当成运行时建表点。）
 * 这正是本模块自己禁止的那类假阴性：漏掉的列不会被声明、也不会被探测要求，
 * 结果是 `migrate verify` 对它们永远查不出缺失、`ensureCapabilitySchema` 在一个缺列的库上返回 ready。
 * （实测：修复前 migrations/ 下 108 个 ADD COLUMN 只捕获 104 个，0041 漏 1、0049 漏 3。）
 */
const ALTER_TABLE_STATEMENT = /\bALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?([a-zA-Z_][\w]*)([\s\S]*?)(?=;|$)/gi;
const ADD_COLUMN_CLAUSE = /\bADD\s+COLUMN\s+(?:IF\s+NOT\s+EXISTS\s+)?([a-zA-Z_][\w]*)/gi;

export interface AddedColumn {
  table: string;
  column: string;
  /** 该 `ADD COLUMN` 子句在传入文本里的起始偏移（调用方要按文档顺序排事件时用） */
  at: number;
  /** 子句原文，用于判定 `IF NOT EXISTS` 幂等性 */
  clause: string;
}

/**
 * 找出一段（已剥注释的）SQL 里全部 `ADD COLUMN` 子句。
 * `scripts/generate-migration-headers.ts` 与本模块共用这一份实现——两份口径迟早会漂，
 * 而这里漂一次就等于生成端与校验端自相矛盾。
 */
export function findAddedColumns(sql: string): AddedColumn[] {
  const out: AddedColumn[] = [];
  ALTER_TABLE_STATEMENT.lastIndex = 0;
  let stmt: RegExpExecArray | null;
  while ((stmt = ALTER_TABLE_STATEMENT.exec(sql)) !== null) {
    const table = stmt[1].toLowerCase();
    const body = stmt[2] ?? '';
    const bodyOffset = stmt.index + stmt[0].length - body.length;
    ADD_COLUMN_CLAUSE.lastIndex = 0;
    let clause: RegExpExecArray | null;
    while ((clause = ADD_COLUMN_CLAUSE.exec(body)) !== null) {
      out.push({
        table,
        column: clause[1].toLowerCase(),
        at: bodyOffset + clause.index,
        clause: clause[0],
      });
    }
    // 零宽 lookahead 结尾的懒匹配可能返回空 body，手动推进避免死循环。
    if (ALTER_TABLE_STATEMENT.lastIndex === stmt.index) ALTER_TABLE_STATEMENT.lastIndex += 1;
  }
  out.sort((a, b) => a.at - b.at);
  return out;
}

/** 建表体里这些开头的条目是表级约束，不是列。 */
const NOT_A_COLUMN = new Set(['primary', 'unique', 'foreign', 'check', 'constraint', 'exclude', 'like', 'partition']);

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

/** 解析一段 DDL 文本（TS 源码或 .sql 文件都可）。判定前先剥注释。 */
export function extractCreatedObjects(source: string): CreatedObjects {
  const sql = stripComments(source);
  const tables = new Map<string, Set<string>>();
  const indexes = new Map<string, string>();

  CREATE_TABLE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = CREATE_TABLE.exec(sql)) !== null) {
    const table = m[1].toLowerCase();
    const columns = tables.get(table) ?? new Set<string>();
    const body = balancedBody(sql, m.index + m[0].length - 1);
    for (const part of splitTopLevel(body)) {
      const first = part.trim().split(/\s+/)[0];
      if (!first) continue;
      if (NOT_A_COLUMN.has(first.toLowerCase())) continue;
      if (!/^[a-zA-Z_][\w]*$/.test(first)) continue;
      columns.add(first.toLowerCase());
    }
    tables.set(table, columns);
  }

  for (const added of findAddedColumns(sql)) {
    const columns = tables.get(added.table) ?? new Set<string>();
    columns.add(added.column);
    tables.set(added.table, columns);
  }

  CREATE_INDEX.lastIndex = 0;
  while ((m = CREATE_INDEX.exec(sql)) !== null) {
    indexes.set(m[1].toLowerCase(), m[2].toLowerCase());
  }

  return { tables, indexes };
}

/** 合并多段 DDL（一个存储常有 SCHEMA_SQL + ALTER_SQL 两段）。 */
export function mergeCreatedObjects(sources: string[]): CreatedObjects {
  const tables = new Map<string, Set<string>>();
  const indexes = new Map<string, string>();
  for (const source of sources) {
    const one = extractCreatedObjects(source);
    for (const [table, columns] of one.tables) {
      const merged = tables.get(table) ?? new Set<string>();
      for (const c of columns) merged.add(c);
      tables.set(table, merged);
    }
    for (const [index, table] of one.indexes) indexes.set(index, table);
  }
  return { tables, indexes };
}
