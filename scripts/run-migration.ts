import { readFile } from 'node:fs/promises';
import path from 'node:path';
import pg from 'pg';
import { DEFAULT_PG_CONFIG } from '../src/kernel/pg-config.js';

const { Client } = pg;

function readEnvString(name: string): string | undefined {
  const value = process.env[name];
  return value && value.trim() ? value : undefined;
}

function readEnvPort(): number {
  const value = readEnvString('PGPORT');
  if (!value) return DEFAULT_PG_CONFIG.port;
  const port = Number(value);
  return Number.isInteger(port) && port > 0 ? port : DEFAULT_PG_CONFIG.port;
}

async function main(): Promise<void> {
  const migrationFile = process.argv[2];
  if (!migrationFile) {
    throw new Error('Usage: tsx scripts/run-migration.ts <migration-file>');
  }

  const sql = await readFile(path.resolve(migrationFile), 'utf8');
  const connectionString = readEnvString('DATABASE_URL');
  const client = new Client(
    connectionString
      ? { connectionString }
      : {
          host: readEnvString('PGHOST') ?? DEFAULT_PG_CONFIG.host,
          port: readEnvPort(),
          database: readEnvString('PGDATABASE') ?? DEFAULT_PG_CONFIG.database,
          user: readEnvString('PGUSER') ?? DEFAULT_PG_CONFIG.user,
          password: readEnvString('PGPASSWORD') ?? DEFAULT_PG_CONFIG.password,
        },
  );

  await client.connect();
  try {
    await client.query(sql);
    console.log(JSON.stringify({ migrationFile: path.resolve(migrationFile), status: 'ok' }));
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});