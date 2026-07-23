/**
 * 读「库里实际有什么表和列」的**唯一**实现（change cloud-schema-migration-executor 第 1 / 5 节共用）。
 *
 * 为什么必须走 `pg_catalog` 而不是 `information_schema`：后者只显示**当前角色有权限**的对象，
 * 权限出问题时会把「有表但没权限」误报成「表不存在」—— 本仓真出过一次运行时角色失去 DML 权限的事故
 * （`migrations/0050` 就是那次的补丁）。这个误报在两条路径上后果不同、方向都不好：
 *   - 运行时探测（`schema-capability.ts`）：让存储在一条其实存在的表上 fail-closed；
 *   - `migrate verify` / `migrate baseline`（`schema-inspect.ts`）：刷出一串根本不存在的「缺失」，
 *     baseline 被拒，而操作者照着「缺失非空就补跑迁移」去补，补多少次都不会变空。
 *
 * 两条路径曾各写一份查询、结论相反。收口到这里，是为了消掉「同一件事两份口径」这个必然漂移的结构。
 */

// 最小查询接口的单一定义处已上移 kernel（`../kernel/schema-capability-contract.ts`，随 SchemaEnsurer
// 端口一并进 kernel，any→kernel 恒允许）；此处原样 re-export，保住同层既有 import 路径。
export type { SchemaQueryable } from '../kernel/schema-capability-contract.js';
import type { SchemaQueryable } from '../kernel/schema-capability-contract.js';

export interface TableColumns {
  /** 库里实际存在的表名 */
  tables: Set<string>;
  /** 库里实际存在的列，`表名.列名` */
  columns: Set<string>;
}

/**
 * `relkind IN ('r','p')` = 普通表与分区表（视图 / 序列 / 索引不算）。
 * `attnum > 0 AND NOT attisdropped` 排除系统列与已删除列。
 * `LEFT JOIN` 而不是 `JOIN`：零列的表也要被认成「表存在」。
 */
const BASE = `SELECT c.relname AS table_name, a.attname AS column_name
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       LEFT JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
      WHERE n.nspname = $1 AND c.relkind IN ('r','p')`;

/**
 * 读表与列。`tables` 省略时读整个 schema；给了清单则只读清单内的表
 * （存储探测只关心自己那几张，没必要把整库拉回来）。
 */
export async function readTableColumns(
  client: SchemaQueryable,
  schema: string,
  tables?: string[],
): Promise<TableColumns> {
  const out: TableColumns = { tables: new Set(), columns: new Set() };
  if (tables && tables.length === 0) return out;

  const res = tables
    ? await client.query(`${BASE} AND c.relname = ANY($2::text[])`, [schema, tables])
    : await client.query(BASE, [schema]);

  for (const row of res.rows) {
    const table = String(row.table_name);
    out.tables.add(table);
    if (row.column_name != null) out.columns.add(`${table}.${String(row.column_name)}`);
  }
  return out;
}
