/**
 * 假 pool 的 schema 探测应答（change cloud-schema-migration-executor 第 5 节配套）。
 *
 * 第 5 节之后，存储的 `init()` 不再建表，而是**探测**自己需要的表 / 列 / 索引在不在。
 * 脱库单测里的假 pool 因此必须能回答这次探测 —— 否则等于在断言「一个空库上存储照样能跑」，
 * 那不是这些用例想验的东西。
 *
 * 应答内容由**存储自己那段 DDL 常量**推导：假库里「有的东西」恰好等于该存储要求的东西。
 * 这样假 pool 不需要维护第二份列清单（那份清单必然漂移，漂了之后用例会开始验一个不存在的形状）。
 *
 * 用法：
 *   const probe = fakeSchemaProbe(MODEL_CONFIG_SCHEMA_SQL, MODEL_CONFIG_ALTER_SQL);
 *   query: async (sql, params) => { const hit = probe(sql); if (hit) return hit; … }
 *
 * 想验「库里缺东西时存储 fail-closed」的用例，不要用本 helper —— 直接让探测返回空行即可。
 */

import { mergeCreatedObjects } from '../../src/schema/ddl-objects.js';

export interface ProbeRows {
  rows: Record<string, unknown>[];
}

export function fakeSchemaProbe(...ddl: string[]): (sql: string) => ProbeRows | undefined {
  const objects = mergeCreatedObjects(ddl);
  return (sql: string) => {
    if (sql.includes('pg_attribute')) {
      const rows: Record<string, unknown>[] = [];
      for (const [table, columns] of objects.tables) {
        if (columns.size === 0) rows.push({ table_name: table, column_name: null });
        for (const column of columns) rows.push({ table_name: table, column_name: column });
      }
      return { rows };
    }
    if (sql.includes('pg_indexes')) {
      return { rows: [...objects.indexes.keys()].map((indexname) => ({ indexname })) };
    }
    return undefined;
  };
}
