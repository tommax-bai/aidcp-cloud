/**
 * 存储能力的 schema 探测（change cloud-schema-migration-executor 任务 5.1 / 5.2，design.md D4 第三步）。
 *
 * 范式照抄 `src/interactions/schema-capability.ts`：**探到就正常工作，探不到就带 version id 报错并
 * fail-closed，绝不建表**。今天 34 个存储的做法相反 —— 启动期无条件跑一遍幂等建表语句，
 * 于是「回滚到旧代码」时旧存储会静默重建一张空表并开始往里写，全程零告警。
 *
 * 三态（与 interactions 那份同构）：
 *   ready    要求的表、列、索引都在 → 正常工作；
 *   degraded 表在、但缺列或缺索引  → 报 `schema_incomplete_*`，能力 fail-closed；
 *   missing  要求的表不在          → 报 `schema_missing_*`，能力 fail-closed。
 *
 * 为什么 degraded 也抛：缺列时存储的 SELECT / ON CONFLICT 迟早会抛一条**原始 PG 错误**，
 * 那条错误既不带 version id、也不说该补哪条迁移。在 init 处一次性把话说清楚，比在业务路径上炸更有用。
 *
 * 要求从哪来：**存储自己那段 DDL 常量**。它原本就是「这个存储需要什么」的权威表达，
 * 由 `ddl-objects.ts` 解析成对象清单即可，无需再手写一份必然漂移的清单。
 *
 * 过渡期回滚旋钮 `AIDCP_SCHEMA_SELF_CREATE=true`：恢复本 change 之前的自建行为，
 * 并在启动日志打显式过渡态警告。默认 `false`。全部批次稳定后随任务 5.11 删除。
 */

import { mergeCreatedObjects } from './ddl-objects.js';
import { runtimeSchemaName } from './schema-name.js';

export type SchemaCapabilityStatus = 'ready' | 'degraded' | 'missing';

export interface SchemaShape {
  /** 库里实际存在的表名 */
  tables: Set<string>;
  /** 库里实际存在的列，`表名.列名` */
  columns: Set<string>;
  /** 库里实际存在的索引名 */
  indexes: Set<string>;
}

export interface SchemaCapabilityVerdict {
  status: SchemaCapabilityStatus;
  missingTables: string[];
  missingColumns: string[];
  missingIndexes: string[];
}

export interface SchemaCapabilitySpec {
  /** 能力名，进错误码与日志，如 `model_config` */
  capability: string;
  /** 提供这些对象的迁移版本 id（缺对象时要能回答「补跑哪一条」） */
  sinceVersion: string;
  /** 该存储原本会自建的 DDL 段（要求的来源；旋钮打开时也是被执行的那几段） */
  ddl: string[];
}

/** 纯判定：给定「要求」与「实测」，返回三态与缺失清单。不连库、可脱库单测。 */
export function classifySchemaCapability(
  required: { tables: Map<string, Set<string>>; indexes: Map<string, string> },
  actual: SchemaShape,
): SchemaCapabilityVerdict {
  const missingTables: string[] = [];
  const missingColumns: string[] = [];
  const missingIndexes: string[] = [];

  for (const [table, columns] of [...required.tables].sort((a, b) => a[0].localeCompare(b[0]))) {
    if (!actual.tables.has(table)) {
      missingTables.push(table);
      continue; // 表都不在，逐列再报一遍只是刷屏
    }
    for (const column of [...columns].sort()) {
      if (!actual.columns.has(`${table}.${column}`)) missingColumns.push(`${table}.${column}`);
    }
  }
  for (const [index, table] of [...required.indexes].sort((a, b) => a[0].localeCompare(b[0]))) {
    if (missingTables.includes(table)) continue;
    if (!actual.indexes.has(index)) missingIndexes.push(index);
  }

  const status: SchemaCapabilityStatus = missingTables.length > 0
    ? 'missing'
    : missingColumns.length > 0 || missingIndexes.length > 0
      ? 'degraded'
      : 'ready';
  return { status, missingTables, missingColumns, missingIndexes };
}

export class SchemaCapabilityError extends Error {
  readonly code: string;
  readonly capability: string;
  readonly status: SchemaCapabilityStatus;
  readonly sinceVersion: string;
  readonly missing: string[];

  constructor(spec: SchemaCapabilitySpec, verdict: SchemaCapabilityVerdict) {
    const missing = [...verdict.missingTables, ...verdict.missingColumns, ...verdict.missingIndexes];
    const prefix = verdict.status === 'missing' ? 'schema_missing' : 'schema_incomplete';
    const code = `${prefix}_${spec.capability}_run_${spec.sinceVersion}`;
    super(
      `${code}：缺 ${missing.length} 个对象（${missing.join(', ')}）。`
      + `补跑迁移 npm run migrate up 后重启；本进程 MUST NOT 自建这些对象。`,
    );
    this.name = 'SchemaCapabilityError';
    this.code = code;
    this.capability = spec.capability;
    this.status = verdict.status;
    this.sinceVersion = spec.sinceVersion;
    this.missing = missing;
  }
}

export function isSchemaCapabilityError(err: unknown): err is SchemaCapabilityError {
  return err instanceof SchemaCapabilityError;
}

/** 过渡期回滚旋钮。默认 false —— 只有显式设成 true 才恢复自建。 */
export function schemaSelfCreateEnabled(): boolean {
  return (process.env.AIDCP_SCHEMA_SELF_CREATE ?? '').trim().toLowerCase() === 'true';
}

let selfCreateWarned = false;
function warnSelfCreateOnce(): void {
  if (selfCreateWarned) return;
  selfCreateWarned = true;
  console.warn(
    '[aidcp-cloud] AIDCP_SCHEMA_SELF_CREATE=true：存储自建表已被显式恢复。'
    + '这是**过渡态**——DDL 的唯一所有者是 migrations/，回滚到旧代码时自建会静默重建空表并开始写入。'
    + '稳定后 MUST 移除该旋钮（change cloud-schema-migration-executor 任务 5.11）。',
  );
}

/** 最小查询接口（生产传 pg.Pool / pg.Client，测试传桩）。 */
export interface SchemaQueryable {
  query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

/**
 * 读实测形状。走 `pg_catalog` 而不是 `information_schema`：后者只显示当前角色有权限的对象，
 * 权限出问题时会把「有表但没权限」误报成「表不存在」—— 而本仓真出过一次运行时角色失去 DML 权限的事故
 * （migrations/0050 就是那次的补丁）。误报成 missing 会让存储在一个其实存在的表上 fail-closed。
 */
export async function probeSchemaShape(
  client: SchemaQueryable,
  tables: string[],
  schema = runtimeSchemaName(),
): Promise<SchemaShape> {
  const shape: SchemaShape = { tables: new Set(), columns: new Set(), indexes: new Set() };
  if (tables.length === 0) return shape;

  const cols = await client.query(
    `SELECT c.relname AS table_name, a.attname AS column_name
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       LEFT JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
      WHERE n.nspname = $1 AND c.relkind IN ('r','p') AND c.relname = ANY($2::text[])`,
    [schema, tables],
  );
  for (const row of cols.rows) {
    const table = String(row.table_name);
    shape.tables.add(table);
    if (row.column_name != null) shape.columns.add(`${table}.${String(row.column_name)}`);
  }

  const idx = await client.query(
    `SELECT indexname FROM pg_indexes WHERE schemaname = $1 AND tablename = ANY($2::text[])`,
    [schema, tables],
  );
  for (const row of idx.rows) shape.indexes.add(String(row.indexname));

  return shape;
}

/**
 * 存储 `init()` 里替代 `pool.query(SCHEMA_SQL)` 的统一入口。
 *
 * 默认路径：探测 → 三态判定 → 不是 ready 就抛 `SchemaCapabilityError`（带 version id 与缺失清单），
 * **一条 DDL 都不执行**。旋钮打开时才回到自建，并打一次过渡态警告。
 */
export async function ensureCapabilitySchema(
  client: SchemaQueryable,
  spec: SchemaCapabilitySpec,
): Promise<SchemaCapabilityStatus> {
  if (schemaSelfCreateEnabled()) {
    warnSelfCreateOnce();
    for (const sql of spec.ddl) await client.query(sql);
    return 'ready';
  }

  const required = mergeCreatedObjects(spec.ddl);
  const shape = await probeSchemaShape(client, [...required.tables.keys()]);
  const verdict = classifySchemaCapability(required, shape);
  if (verdict.status !== 'ready') throw new SchemaCapabilityError(spec, verdict);
  return 'ready';
}
