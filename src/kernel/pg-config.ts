/**
 * PostgreSQL 连接参数解析（kernel 层，见控制仓定稿 §4.7 kernel 花名册）。
 *
 * kernel 准入要求本文件 MUST NOT 反向依赖任何业务层：唯一 import 是 `import type pg`，
 * 无 SQL 字面量、无业务依赖、无进程内活状态。消费方一律**直接从本文件** import
 * `DEFAULT_PG_CONFIG` / `resolveEnvPgConfig`（any→kernel 恒允许），不再经 automation 层
 * `pg-anchor-cache.ts` 的历史再导出取值，取值逐字不变。
 *
 * 明文口令兜底是既存事实，本次只做搬迁、MUST NOT 视为已处置：
 * 删除该兜底并改为纯配置读取是定稿 §6.5.6 列的**拆分前置条件**（独立 change 承接），
 * 搬到这里之后它在全仓只剩这一处出现点，正是该 change 要动的唯一位置。
 */
import type pg from 'pg';

/** 默认连接配置（本机 PG）。原位置为 `pg-anchor-cache.ts`，取值逐字未改。 */
export const DEFAULT_PG_CONFIG = {
  host: '127.0.0.1',
  port: 5432,
  database: 'aidcp',
  user: 'aidcp',
  password: '***REMOVED***',
};

function readEnvString(name: string): string | undefined {
  const value = process.env[name];
  return value && value.trim() ? value : undefined;
}

function readEnvPort(name: string): number | undefined {
  const value = readEnvString(name);
  if (!value) return undefined;
  const port = Number(value);
  return Number.isInteger(port) && port > 0 ? port : undefined;
}

export function resolveEnvPgConfig(): pg.PoolConfig {
  const connectionString = readEnvString('DATABASE_URL');
  if (connectionString) {
    return { connectionString };
  }
  return {
    host: readEnvString('PGHOST') ?? DEFAULT_PG_CONFIG.host,
    port: readEnvPort('PGPORT') ?? DEFAULT_PG_CONFIG.port,
    database: readEnvString('PGDATABASE') ?? DEFAULT_PG_CONFIG.database,
    user: readEnvString('PGUSER') ?? DEFAULT_PG_CONFIG.user,
    password: readEnvString('PGPASSWORD') ?? DEFAULT_PG_CONFIG.password,
  };
}