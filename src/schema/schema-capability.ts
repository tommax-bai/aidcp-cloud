/**
 * 存储能力的 schema 探测**执行段**（含 SQL，留 automation；change cloud-schema-migration-executor
 * 任务 5.1 / 5.2，design.md D4 第三步）。
 *
 * 纯契约段（三态类型 / `classifySchemaCapability` / `SchemaCapabilityError` / `isSchemaCapabilityError`
 * / `schemaSelfCreateEnabled`）已析出到 `src/kernel/schema-capability-contract.ts`（无 SQL、可进 kernel）。
 * 本文件只保留**连库**的两段：`probeSchemaShape`（读实测形状）、`ensureCapabilitySchema`（init 入口），
 * 并从 kernel 复用契约。为不惊动同层既有 import 者，契约在此原样 re-export。
 *
 * 范式照抄 `src/interactions/schema-capability.ts`：**探到就正常工作，探不到就带 version id 报错并
 * fail-closed，绝不建表**。今天 34 个存储的做法相反 —— 启动期无条件跑一遍幂等建表语句，
 * 于是「回滚到旧代码」时旧存储会静默重建一张空表并开始往里写，全程零告警。
 *
 * 要求从哪来：**存储自己那段 DDL 常量**。它原本就是「这个存储需要什么」的权威表达，
 * 由 `ddl-objects.ts` 解析成对象清单即可，无需再手写一份必然漂移的清单。
 *
 * 过渡期回滚旋钮 `AIDCP_SCHEMA_SELF_CREATE=true`：恢复本 change 之前的自建行为，
 * 并在启动日志打显式过渡态警告。默认 `false`。全部批次稳定后随任务 5.11 删除。
 */

import {
  SchemaCapabilityError,
  classifySchemaCapability,
  schemaSelfCreateEnabled,
  type SchemaCapabilitySpec,
  type SchemaCapabilityStatus,
  type SchemaShape,
} from '../kernel/schema-capability-contract.js';
import { mergeCreatedObjects } from './ddl-objects.js';
import { readTableColumns, type SchemaQueryable } from './pg-catalog.js';
import { runtimeSchemaName } from '../kernel/schema-name.js';

// 纯契约在 kernel 定义；此处原样 re-export，保住同层既有 import 路径。
export {
  SchemaCapabilityError,
  classifySchemaCapability,
  isSchemaCapabilityError,
  schemaSelfCreateEnabled,
} from '../kernel/schema-capability-contract.js';
export type {
  SchemaCapabilitySpec,
  SchemaCapabilityStatus,
  SchemaCapabilityVerdict,
  SchemaShape,
} from '../kernel/schema-capability-contract.js';
export type { SchemaQueryable };

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

/**
 * 读实测形状。表与列走 `src/schema/pg-catalog.ts` 的统一查询（`pg_catalog`，不是 `information_schema`）——
 * 理由与 `migrate verify` 那侧同源，见 pg-catalog.ts 的文件头。
 */
export async function probeSchemaShape(
  client: SchemaQueryable,
  tables: string[],
  schema = runtimeSchemaName(),
): Promise<SchemaShape> {
  const shape: SchemaShape = { tables: new Set(), columns: new Set(), indexes: new Set() };
  if (tables.length === 0) return shape;

  const tableColumns = await readTableColumns(client, schema, tables);
  shape.tables = tableColumns.tables;
  shape.columns = tableColumns.columns;

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
