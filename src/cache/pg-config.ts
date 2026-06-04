import type pg from 'pg';
import { DEFAULT_PG_CONFIG } from './pg-anchor-cache.js';

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