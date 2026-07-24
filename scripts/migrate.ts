/**
 * 迁移执行器 CLI（change cloud-schema-migration-executor 任务 1.3–1.9）。
 *
 *   npm run migrate status                  只读：列出已应用 / 待应用 / 异常
 *   npm run migrate up [--allow-contract]   应用待应用项（整批 advisory lock 互斥，逐条单事务）
 *   npm run migrate verify                  实测对账：声明对象 vs 库里实际对象
 *   npm run migrate baseline                先内部 verify，缺失清单为空才把全部迁移以 baseline 写入账本
 *
 * 红线：
 *  - 校验和不符 / 乱序 / 缺 kind → 整批拒绝，一条 SQL 都不执行。
 *  - 拿不到整批锁 → 立即退出，绝不等待后强行继续。
 *  - baseline 缺失清单非空 → 拒绝写入，逐条打印缺什么、来自哪个 version。绝不「假设已跑过」。
 */

import pg from 'pg';

import { DEFAULT_PG_CONFIG } from '../src/kernel/pg-config.js';
import {
  LEDGER_MIGRATION_NAME,
  loadMigrationFiles,
  migrationsDir,
} from '../src/schema/migration-files.js';
import {
  compareVersions,
  parseMigrationHeader,
  planMigrations,
  unauthorizedContracts,
  versionOf,
  type LedgerRow,
  type MigrationFile,
} from '../src/schema/migration-plan.js';
import { declaredObjects, diffSchema, readActualSchema } from '../src/schema/schema-inspect.js';
import { runtimeSchemaName } from '../src/kernel/schema-name.js';

const { Client } = pg;

/** 整批互斥用的固定 advisory lock key（库级；任何 aidcp 迁移执行器共用这一把）。 */
export const MIGRATION_ADVISORY_LOCK_KEY = 4788219350114677;

const UNDEFINED_TABLE = '42P01';

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

function buildClient(): pg.Client {
  const connectionString = readEnvString('DATABASE_URL');
  return new Client(
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
}

/**
 * 施加动作来自哪个执行目标，只作审计（design.md D1）。
 * MUST NOT 因为没设 target 就拒绝执行 —— schema 是库的属性，不是按 target 隔离的任务。
 */
function appliedFromTarget(): { value: string; note?: string } {
  const raw = readEnvString('AIDCP_DEPLOY_ENV');
  if (!raw) return { value: 'unknown', note: '未设置 AIDCP_DEPLOY_ENV，applied_from_target 记为 unknown（仅审计列，不影响执行）' };
  return { value: raw.trim() };
}

function appliedBy(flags: Flags): string {
  return flags.by ?? readEnvString('AIDCP_MIGRATE_BY') ?? readEnvString('USER') ?? 'unknown';
}

interface Flags {
  allowContract: boolean;
  by?: string;
}

function parseFlags(argv: string[]): Flags {
  const flags: Flags = { allowContract: false };
  for (const arg of argv) {
    if (arg === '--allow-contract') flags.allowContract = true;
    else if (arg.startsWith('--by=')) flags.by = arg.slice('--by='.length).trim() || undefined;
  }
  return flags;
}

async function readLedger(client: pg.Client): Promise<{ rows: LedgerRow[]; present: boolean }> {
  try {
    const res = await client.query<{ version: string; checksum: string }>(
      'SELECT version, checksum FROM schema_migrations',
    );
    return { rows: res.rows, present: true };
  } catch (err) {
    if ((err as { code?: string }).code === UNDEFINED_TABLE) return { rows: [], present: false };
    throw err;
  }
}

/** bootstrap：账本表本身的 DDL 只有一份，就是那条迁移文件，这里原样执行（全部语句幂等）。 */
async function ensureLedger(client: pg.Client, files: MigrationFile[]): Promise<void> {
  const ledgerFile = files.find((f) => f.name === LEDGER_MIGRATION_NAME);
  if (!ledgerFile) {
    throw new Error(`迁移目录缺少账本迁移 ${LEDGER_MIGRATION_NAME}，无法建立账本`);
  }
  await client.query(ledgerFile.content);
}

function printErrors(errors: { code: string; version: string; detail: string }[]): void {
  for (const e of errors) console.error(`  [${e.code}] ${e.version}: ${e.detail}`);
}

async function commandStatus(client: pg.Client, files: MigrationFile[]): Promise<number> {
  const ledger = await readLedger(client);
  const plan = planMigrations(files, ledger.rows);
  console.log(`迁移目录：${migrationsDir()}（${files.length} 个文件）`);
  console.log(ledger.present ? `账本 schema_migrations：${ledger.rows.length} 行` : '账本 schema_migrations：不存在（尚未 bootstrap，跑 migrate up 或 migrate baseline 建立）');
  const maxApplied = ledger.rows.map((r) => r.version).sort(compareVersions).at(-1);
  if (maxApplied) console.log(`账本最高版本：${maxApplied}`);
  console.log(`已应用且校验和一致：${plan.skipped.length}`);
  console.log(`待应用：${plan.pending.length}`);
  for (const p of plan.pending) console.log(`  + ${p.version} (kind=${p.kind})`);
  if (plan.ledgerOnly.length > 0) {
    console.log(`账本有、磁盘无（库比本构建新的线索）：${plan.ledgerOnly.length}`);
    for (const v of plan.ledgerOnly) console.log(`  ! ${v}`);
  }
  if (plan.errors.length > 0) {
    console.error(`异常：${plan.errors.length}`);
    printErrors(plan.errors);
    return 1;
  }
  return 0;
}

async function commandUp(client: pg.Client, files: MigrationFile[], flags: Flags): Promise<number> {
  await ensureLedger(client, files);

  const locked = await client.query<{ locked: boolean }>(
    'SELECT pg_try_advisory_lock($1) AS locked',
    [MIGRATION_ADVISORY_LOCK_KEY],
  );
  if (!locked.rows[0]?.locked) {
    console.error(`另一个迁移执行器正持有整批锁（key=${MIGRATION_ADVISORY_LOCK_KEY}），本次立即退出，未执行任何迁移。`);
    return 1;
  }

  try {
    const ledger = await readLedger(client);
    const plan = planMigrations(files, ledger.rows);
    if (plan.errors.length > 0) {
      console.error(`整批拒绝：迁移计划存在 ${plan.errors.length} 处异常，未执行任何 SQL。`);
      printErrors(plan.errors);
      return 1;
    }
    const blockedContracts = unauthorizedContracts(plan.pending, flags.allowContract);
    if (blockedContracts.length > 0) {
      console.error('整批拒绝：待应用集合含收缩类迁移，共库期需显式 --allow-contract 授权。');
      for (const v of blockedContracts) console.error(`  [contract] ${v}`);
      return 1;
    }
    if (plan.pending.length === 0) {
      console.log(`无待应用迁移（已跳过 ${plan.skipped.length} 条已应用项）。`);
      return 0;
    }

    const target = appliedFromTarget();
    if (target.note) console.log(target.note);
    const by = appliedBy(flags);

    for (const migration of plan.pending) {
      const startedAt = Date.now();
      try {
        await client.query('BEGIN');
        await client.query(migration.content);
        await client.query(
          `INSERT INTO schema_migrations (version, name, checksum, kind, applied_by, applied_from_target, duration_ms, baseline)
           VALUES ($1,$2,$3,$4,$5,$6,$7,false)`,
          [
            migration.version,
            migration.name,
            migration.checksum,
            migration.kind,
            migration.kind === 'contract' ? `${by} (--allow-contract)` : by,
            target.value,
            Date.now() - startedAt,
          ],
        );
        await client.query('COMMIT');
        console.log(`applied ${migration.version} (kind=${migration.kind}, ${Date.now() - startedAt}ms)`);
      } catch (err) {
        await client.query('ROLLBACK').catch(() => undefined);
        console.error(`迁移失败并停止整批：${migration.version}`);
        console.error(`  原始数据库错误：${err instanceof Error ? err.message : String(err)}`);
        console.error('  已成功的条目保留在账本中；修复后重跑 migrate up 从失败处继续。');
        return 1;
      }
    }
    return 0;
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_ADVISORY_LOCK_KEY]).catch(() => undefined);
  }
}

async function runVerify(client: pg.Client, files: MigrationFile[]) {
  const schema = runtimeSchemaName();
  const actual = await readActualSchema(client, schema);
  return { schema, report: diffSchema(declaredObjects(files), actual) };
}

async function commandVerify(client: pg.Client, files: MigrationFile[]): Promise<number> {
  const { schema, report } = await runVerify(client, files);
  console.log(`实测对账（schema=${schema}）：声明 ${report.declaredObjectCount} 个对象、覆盖 ${report.declaredTableCount} 张表`);
  console.log(`缺失对象：${report.missing.length}`);
  for (const m of report.missing) console.log(`  - ${m.type}:${m.name}  ← ${m.version}`);
  console.log(`多余对象（库里有、任何迁移都没声明）：${report.extra.length}`);
  for (const e of report.extra) console.log(`  + ${e.type}:${e.name}`);
  return report.missing.length > 0 ? 1 : 0;
}

async function commandBaseline(client: pg.Client, files: MigrationFile[], flags: Flags): Promise<number> {
  await ensureLedger(client, files);
  const { schema, report } = await runVerify(client, files);
  if (report.missing.length > 0) {
    console.error(`拒绝写入基线：实测对账在 schema=${schema} 上发现 ${report.missing.length} 个缺失对象。`);
    for (const m of report.missing) console.error(`  - ${m.type}:${m.name}  ← ${m.version}`);
    console.error('先补跑缺失迁移使库对象齐备，再重跑 baseline。绝不为了让 baseline 通过而放宽比对。');
    return 1;
  }

  const target = appliedFromTarget();
  if (target.note) console.log(target.note);
  const by = appliedBy(flags);
  let inserted = 0;
  let skipped = 0;
  for (const file of files) {
    const version = versionOf(file.name);
    const { kind } = parseMigrationHeader(file.content);
    if (!kind) {
      console.error(`拒绝写入基线：${version} 缺少 -- aidcp:kind= 头声明。`);
      return 1;
    }
    const res = await client.query(
      `INSERT INTO schema_migrations (version, name, checksum, kind, applied_by, applied_from_target, duration_ms, baseline)
       VALUES ($1,$2,$3,$4,$5,$6,NULL,true)
       ON CONFLICT (version) DO NOTHING`,
      [version, file.name, file.checksum, kind, by, target.value],
    );
    if (res.rowCount && res.rowCount > 0) inserted += 1;
    else skipped += 1;
  }
  const rows = (await client.query<{ version: string }>('SELECT version FROM schema_migrations')).rows;
  const maxVersion = rows.map((r) => r.version).sort(compareVersions).at(-1);
  console.log(`基线写入完成：新增 ${inserted} 行，已存在跳过 ${skipped} 行（不覆盖）。`);
  console.log(`账本行数：${rows.length}，最高版本 id：${maxVersion ?? '(空)'}`);
  return 0;
}

async function main(): Promise<void> {
  const command = process.argv[2];
  const flags = parseFlags(process.argv.slice(3));
  if (!command || !['status', 'up', 'verify', 'baseline'].includes(command)) {
    console.error('Usage: npm run migrate <status|up|verify|baseline> [--allow-contract] [--by=<operator>]');
    process.exitCode = 1;
    return;
  }

  const files = await loadMigrationFiles();
  const client = buildClient();
  await client.connect();
  try {
    let code = 1;
    if (command === 'status') code = await commandStatus(client, files);
    else if (command === 'up') code = await commandUp(client, files, flags);
    else if (command === 'verify') code = await commandVerify(client, files);
    else if (command === 'baseline') code = await commandBaseline(client, files, flags);
    process.exitCode = code;
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
