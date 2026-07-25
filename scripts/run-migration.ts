/**
 * 单文件迁移执行器（应急 / 调试用；正规通道是 `npm run migrate up`，它才写账本）。
 *
 * Block③ 物理拆库：本脚本也必须按属主定目标库。做法是复用**唯一那套判据**
 * （`src/schema/migration-owners.ts`：迁移头声明的对象 → `boundaries/table-ownership.json` 的属主），
 * 解析出该文件属于哪些属主、这些属主各连哪个库：
 *   - 全落在同一个连接目标（今天：属主 URL 都没设 ⇒ 三属主同库）→ 连一次、跑一次，与改动前逐字节一致；
 *   - 落在多个目标（拆库后的跨属主迁移）→ **拒绝执行**并说明，改用 `npm run migrate up`
 *     （它按属主分组各跑各的、并逐库写账本）。绝不挑一个库跑完就报 ok。
 *
 * 已知既存缺口（本刀未改）：本脚本只执行 SQL、**不写 `schema_migrations` 账本**。
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import pg from 'pg';

import {
  PG_OWNERS,
  pgOwnerUrlEnvVar,
  resolveOwnerPgConfig,
  type PgOwner,
} from '../src/kernel/pg-owner-connection-resolver.js';
import { loadMigrationFiles } from '../src/schema/migration-files.js';
import { loadMigrationOwnerScopes } from '../src/schema/migration-owners.js';
import { versionOf } from '../src/schema/migration-plan.js';

const { Client } = pg;

/** 连接目标指纹：只作分组键，绝不落日志（连接串里可能带口令）。 */
function connectionFingerprint(config: pg.ClientConfig): string {
  const raw = config.connectionString
    ? `url:${config.connectionString}`
    : `host:${config.host}|${config.port}|${config.database}|${config.user}`;
  return createHash('sha256').update(raw).digest('hex');
}

function parseOwnerFlag(argv: string[]): PgOwner | undefined {
  for (const arg of argv) {
    if (!arg.startsWith('--owner=')) continue;
    const raw = arg.slice('--owner='.length).trim();
    const owner = PG_OWNERS.find((o) => o === raw);
    if (!owner) throw new Error(`--owner=${raw} 非法，只接受 ${PG_OWNERS.join(' / ')}`);
    return owner;
  }
  return undefined;
}

async function main(): Promise<void> {
  const migrationFile = process.argv[2];
  if (!migrationFile) {
    throw new Error('Usage: tsx scripts/run-migration.ts <migration-file> [--owner=<content|automation|api>]');
  }
  const explicitOwner = parseOwnerFlag(process.argv.slice(3));

  const resolved = path.resolve(migrationFile);
  const sql = await readFile(resolved, 'utf8');

  let owners: PgOwner[];
  if (explicitOwner) {
    owners = [explicitOwner];
  } else {
    const { index } = await loadMigrationOwnerScopes(() => loadMigrationFiles());
    const version = versionOf(path.basename(resolved));
    const attribution = index.byVersion.get(version);
    if (!attribution) {
      throw new Error(
        `${version} 不在本构建的 migrations/ 里，判不出属主库。显式指定 --owner=<content|automation|api> 再跑。`,
      );
    }
    owners = attribution.owners;
  }

  const targets = new Map<string, { owners: PgOwner[]; config: pg.ClientConfig }>();
  for (const owner of owners) {
    const config = resolveOwnerPgConfig(owner) as pg.ClientConfig;
    const key = connectionFingerprint(config);
    const existing = targets.get(key);
    if (existing) existing.owners.push(owner);
    else targets.set(key, { owners: [owner], config });
  }

  if (targets.size > 1) {
    const detail = [...targets.values()]
      .map((t) => `${t.owners.join('+')}（${t.owners.map(pgOwnerUrlEnvVar).join(' / ')}）`)
      .join('，');
    throw new Error(
      `该迁移跨 ${targets.size} 个属主库：${detail}。本脚本只连一个库，跑完只会改其中一个 —— `
        + '改用 npm run migrate up（按属主分组各跑各的并逐库写账本），或用 --owner=<owner> 指定单个属主。',
    );
  }

  const [target] = [...targets.values()];
  const client = new Client(target.config);
  await client.connect();
  try {
    await client.query(sql);
    console.log(JSON.stringify({ migrationFile: resolved, owners: target.owners, status: 'ok' }));
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
