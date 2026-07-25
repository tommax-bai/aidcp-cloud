/**
 * PG 连通性探针（部署 healthcheck 用）。
 *
 * Block③ 物理拆库：三个属主各连各的库，只探一个库就报 ok 是一次假绿 —— 另外两个库连不上时
 * 探针照样绿。故本脚本按属主解析连接、**按连接目标去重**后逐个探，任一失败即非零退出。
 *
 * 三个 `AIDCP_PG_<OWNER>_URL` 都未设（今天）时三属主解析出同一份配置 ⇒ 只有一个目标 ⇒
 * 仍是一条连接、一行 JSON，与改动前一致（JSON 多一个 owners 字段说明这行代表哪几个属主）。
 *
 * 可选 `--owner=<content|automation|api>` 只探单个属主。
 */
import { createHash } from 'node:crypto';
import pg from 'pg';

import {
  PG_OWNERS,
  resolveOwnerPgConfig,
  type PgOwner,
} from '../src/kernel/pg-owner-connection-resolver.js';

const { Client } = pg;

/** 连接目标指纹：只作去重键，绝不落日志（连接串里可能带口令）。 */
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
  const only = parseOwnerFlag(process.argv.slice(2));
  const owners = only ? [only] : PG_OWNERS;

  const targets = new Map<string, { owners: PgOwner[]; config: pg.ClientConfig }>();
  for (const owner of owners) {
    const config = resolveOwnerPgConfig(owner) as pg.ClientConfig;
    const key = connectionFingerprint(config);
    const existing = targets.get(key);
    if (existing) existing.owners.push(owner);
    else targets.set(key, { owners: [owner], config });
  }

  let failed = 0;
  for (const target of targets.values()) {
    const client = new Client(target.config);
    try {
      await client.connect();
      const result = await client.query(
        'SELECT current_database() AS database, current_user AS user, 1 AS ok',
      );
      console.log(JSON.stringify({ ...result.rows[0], owners: target.owners }));
    } catch (error) {
      failed += 1;
      console.error(
        JSON.stringify({
          owners: target.owners,
          ok: 0,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    } finally {
      await client.end().catch(() => undefined);
    }
  }
  if (failed > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
