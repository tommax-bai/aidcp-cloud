/**
 * 实测对账（change cloud-schema-migration-executor 任务 1.8，design.md D2）。
 *
 * 比对「迁移文件头声明的对象」与「数据库目录里的实际对象」，输出缺失清单与多余清单。
 * 声明只来自 `-- aidcp:objects=` 头，MUST NOT 由 SQL 文本推断 —— 推断不完整会产生假阴性，
 * 而这里的假阴性等价于「验证通过」，正是本项目第一红线禁止的形态。
 *
 * 比较逻辑是纯函数（本文件不 import pg），实测对象由调用方注入，便于脱库单测。
 */

import { parseMigrationHeader, versionOf, type MigrationFile, type MigrationObject, type MigrationObjectType } from './migration-plan.js';
import { readTableColumns, type SchemaQueryable } from './pg-catalog.js';

export type { SchemaQueryable };

export interface DeclaredObject extends MigrationObject {
  /** 声明它的迁移版本 id（缺失时要能回答「缺的东西来自哪一条」） */
  version: string;
}

export interface ActualSchema {
  /** 表名 */
  tables: Set<string>;
  /** `表名.列名` */
  columns: Set<string>;
  /** `表名 索引名`（索引名在 PG 里 schema 内唯一，但带表名便于按声明表限定多余项） */
  indexes: Set<string>;
  /** 约束名 */
  constraints: Set<string>;
  /** 由约束自动生成的索引名（PK / UNIQUE 背后的索引），不计入「多余索引」 */
  constraintBackedIndexes: Set<string>;
}

export interface VerifyReport {
  missing: DeclaredObject[];
  /** 库里有、任何迁移都没声明的对象 */
  extra: MigrationObject[];
  declaredTableCount: number;
  declaredObjectCount: number;
}

/** 从全部迁移文件抽出对象声明（附来源版本）。 */
export function declaredObjects(files: MigrationFile[]): DeclaredObject[] {
  const out: DeclaredObject[] = [];
  for (const file of files) {
    const version = versionOf(file.name);
    for (const obj of parseMigrationHeader(file.content).objects) {
      out.push({ ...obj, version });
    }
  }
  return out;
}

function indexKey(table: string, index: string): string {
  return `${table} ${index}`;
}

/**
 * 缺失 = 声明了但库里没有。
 * 多余 = 库里有但没人声明；范围限定为
 *   ① 全部基表（未被任何迁移声明的表是真正要暴露的问题，例如今天由存储自建的那批）；
 *   ② 已声明表上的列与索引（避免未声明表的列/索引把清单刷屏，那些表本身已在①里报出来了）。
 * 约束不报多余项：PG 会自动生成大量系统命名的约束，逐条登记只会制造噪声而非事实。
 */
export function diffSchema(declared: DeclaredObject[], actual: ActualSchema): VerifyReport {
  const missing: DeclaredObject[] = [];
  const declaredTables = new Set<string>();
  const declaredColumns = new Set<string>();
  const declaredIndexes = new Set<string>();

  for (const d of declared) {
    if (d.type === 'table') declaredTables.add(d.name);
    else if (d.type === 'column') declaredColumns.add(d.name);
    else if (d.type === 'index') declaredIndexes.add(d.name);
  }

  for (const d of declared) {
    const present = objectPresent(d.type, d.name, actual);
    if (!present) missing.push(d);
  }

  const extra: MigrationObject[] = [];
  for (const table of [...actual.tables].sort()) {
    if (!declaredTables.has(table)) extra.push({ type: 'table', name: table });
  }
  for (const column of [...actual.columns].sort()) {
    const dot = column.indexOf('.');
    if (dot <= 0) continue;
    const table = column.slice(0, dot);
    if (!declaredTables.has(table)) continue;
    if (!declaredColumns.has(column)) extra.push({ type: 'column', name: column });
  }
  for (const key of [...actual.indexes].sort()) {
    const [table, index] = key.split(' ');
    if (!declaredTables.has(table)) continue;
    if (actual.constraintBackedIndexes.has(index)) continue;
    if (!declaredIndexes.has(index)) extra.push({ type: 'index', name: index });
  }

  return {
    missing,
    extra,
    declaredTableCount: declaredTables.size,
    declaredObjectCount: declared.length,
  };
}

function objectPresent(type: MigrationObjectType, name: string, actual: ActualSchema): boolean {
  if (type === 'table') return actual.tables.has(name);
  if (type === 'column') return actual.columns.has(name);
  if (type === 'constraint') return actual.constraints.has(name);
  for (const key of actual.indexes) {
    if (key.endsWith(` ${name}`)) return true;
  }
  return false;
}

/**
 * 读实测对象。表与列走 `src/schema/pg-catalog.ts` 的统一查询（`pg_catalog`，不是 `information_schema`）：
 * 后者只显示当前角色有权限的对象，权限不全时会把「有表但没权限」刷成一串假缺失，
 * 而缺失清单是 `migrate baseline` 唯一的准入闸 —— 假缺失会让 baseline 永远拒绝写入，
 * 且操作者按「缺失非空就补跑迁移」的口径补多少次都不会变空。理由与运行时探测同源，见 pg-catalog.ts。
 */
export async function readActualSchema(client: SchemaQueryable, schema: string): Promise<ActualSchema> {
  const tableColumns = await readTableColumns(client, schema);
  const indexes = await client.query(
    `SELECT tablename, indexname FROM pg_indexes WHERE schemaname = $1`,
    [schema],
  );
  const constraints = await client.query(
    `SELECT c.conname FROM pg_constraint c JOIN pg_namespace n ON n.oid = c.connamespace WHERE n.nspname = $1`,
    [schema],
  );
  const constraintIndexes = await client.query(
    `SELECT ci.relname AS indexname
       FROM pg_constraint c
       JOIN pg_class ci ON ci.oid = c.conindid
       JOIN pg_namespace n ON n.oid = c.connamespace
      WHERE n.nspname = $1 AND c.conindid <> 0`,
    [schema],
  );

  return {
    tables: tableColumns.tables,
    columns: tableColumns.columns,
    indexes: new Set(indexes.rows.map((r) => indexKey(String(r.tablename), String(r.indexname)))),
    constraints: new Set(constraints.rows.map((r) => String(r.conname))),
    constraintBackedIndexes: new Set(constraintIndexes.rows.map((r) => String(r.indexname))),
  };
}
