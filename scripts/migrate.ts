/**
 * 迁移执行器 CLI（change cloud-schema-migration-executor 任务 1.3–1.9；
 * Block③ 物理拆库：改成**逐属主库各连各的、各读各的账本、各校验各的表**）。
 *
 *   npm run migrate status                  只读：列出已应用 / 待应用 / 异常
 *   npm run migrate up [--allow-contract]   应用待应用项（整批 advisory lock 互斥，逐条单事务）
 *   npm run migrate verify                  实测对账：声明对象 vs 库里实际对象
 *   npm run migrate baseline                先内部 verify，缺失清单为空才把该库范围内的迁移以 baseline 写入账本
 *
 *   共用可选参数 --owner=<content|automation|api>   只处理该属主（新建属主库时 seed 用）
 *
 * ## 属主分组
 *
 * 每个属主用 `resolveOwnerPgConfig(owner)` 解析连接。**按连接目标分组**：落在同一个库的属主
 * 合成一组，一组一条连接、一份账本，范围 = 组内各属主迁移范围的并集。
 * 今天三个 `AIDCP_PG_<OWNER>_URL` 都未设 ⇒ 三属主同组 ⇒ 一条连接、一份账本、范围 = 全部迁移
 * ⇒ 与改动前逐字节一致（同一个库、同一张账本表、同一批行、同一批 SQL）。
 * 拆库后逐个把 owner URL 指向新库，组自然裂开，各库只跑各自那批迁移。
 *
 * 「一条迁移属于哪个属主」的判据见 `src/schema/migration-owners.ts`（唯一判据，不在此另立）。
 *
 * 红线：
 *  - 校验和不符 / 乱序 / 缺 kind → 整批拒绝，一条 SQL 都不执行。
 *  - 拿不到整批锁 → 立即退出，绝不等待后强行继续。
 *  - baseline 缺失清单非空 → 拒绝写入，逐条打印缺什么、来自哪个 version。绝不「假设已跑过」。
 *  - 属主判据不可用（迁移目录 / 边界清单读不出、有表查不到属主）→ 直接退出，绝不退化成「全库一把梭」。
 */

import { createHash } from 'node:crypto';
import pg from 'pg';

import {
  PG_OWNERS,
  pgOwnerUrlEnvVar,
  resolveOwnerPgConfig,
  type PgOwner,
} from '../src/kernel/pg-owner-connection-resolver.js';
import {
  LEDGER_MIGRATION_NAME,
  loadMigrationFiles,
  migrationsDir,
} from '../src/schema/migration-files.js';
import {
  filesForOwners,
  loadMigrationOwnerScopes,
  scopeDeclarationsToOwners,
  type MigrationOwnerIndex,
} from '../src/schema/migration-owners.js';
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

/** 连接目标指纹：只作分组键，绝不落日志（连接串里可能带口令）。 */
function connectionFingerprint(config: pg.ClientConfig): string {
  const raw = config.connectionString
    ? `url:${config.connectionString}`
    : `host:${config.host}|${config.port}|${config.database}|${config.user}`;
  return createHash('sha256').update(raw).digest('hex');
}

interface OwnerGroup {
  owners: PgOwner[];
  config: pg.ClientConfig;
  /** 组内各属主迁移范围的并集，复合序 */
  files: MigrationFile[];
}

/** 按连接目标把属主分组；今天三属主同组 ⇒ 一组、范围 = 全部迁移。 */
function buildOwnerGroups(files: MigrationFile[], owners: readonly PgOwner[], index: MigrationOwnerIndex): OwnerGroup[] {
  const byFingerprint = new Map<string, { owners: PgOwner[]; config: pg.ClientConfig }>();
  for (const owner of owners) {
    const config = resolveOwnerPgConfig(owner) as pg.ClientConfig;
    const key = connectionFingerprint(config);
    const existing = byFingerprint.get(key);
    if (existing) existing.owners.push(owner);
    else byFingerprint.set(key, { owners: [owner], config });
  }
  return [...byFingerprint.values()].map((group) => ({
    ...group,
    files: filesForOwners(files, index, group.owners),
  }));
}

function describeGroup(group: OwnerGroup): string {
  const vars = group.owners.map(pgOwnerUrlEnvVar).filter((name) => readEnvString(name));
  const target = vars.length > 0 ? `专属库（${vars.join(' / ')} 已设）` : '共享回落库（属主 URL 未设）';
  return `属主 ${group.owners.join('+')} → ${target}；范围 ${group.files.length} 条迁移`;
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
  /** 只处理该属主（新建属主库时 seed 用）；未给则处理全部三属主 */
  owner?: PgOwner;
}

function parseFlags(argv: string[]): Flags {
  const flags: Flags = { allowContract: false };
  for (const arg of argv) {
    if (arg === '--allow-contract') flags.allowContract = true;
    else if (arg.startsWith('--by=')) flags.by = arg.slice('--by='.length).trim() || undefined;
    else if (arg.startsWith('--owner=')) {
      const raw = arg.slice('--owner='.length).trim();
      const owner = PG_OWNERS.find((o) => o === raw);
      if (!owner) throw new Error(`--owner=${raw} 非法，只接受 ${PG_OWNERS.join(' / ')}`);
      flags.owner = owner;
    }
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
  console.log(`迁移目录：${migrationsDir()}；本属主组范围 ${files.length} 个文件`);
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

/** 一组属主的归因上下文：把「本组范围的迁移」进一步收窄成「本组属主拥有的对象」。 */
interface OwnerScope {
  owners: PgOwner[];
  index: MigrationOwnerIndex;
  tableOwners: Map<string, PgOwner>;
}

/**
 * 跨属主迁移里的索引/约束声明无法按属主归因。**如实打印**，绝不静默略过 ——
 * 一个说不清自己验了什么的验证装置，比没有验证更坏。
 */
function reportUnattributable(objects: readonly { type: string; name: string; version: string }[]): void {
  if (objects.length === 0) return;
  console.log(
    `本次未核验 ${objects.length} 个索引/约束声明：它们来自跨属主迁移，声明里不带表名、无法按属主归因。`,
  );
  for (const o of objects) console.log(`  ? ${o.type}:${o.name}  ← ${o.version}`);
}

async function runVerify(client: pg.Client, files: MigrationFile[], scope?: OwnerScope) {
  const schema = runtimeSchemaName();
  const actual = await readActualSchema(client, schema);
  const declared = declaredObjects(files);
  if (!scope) return { schema, report: diffSchema(declared, actual), unattributable: [] as typeof declared };
  // 收窄到本组属主真正拥有的对象。跨属主迁移的索引/约束无法按属主归因 ——
  // 它们进 unattributable，由调用方**如实打印「本次未核验」**，MUST NOT 静默丢弃。
  const { checked, unattributable } = scopeDeclarationsToOwners(declared, scope.index, scope.tableOwners, scope.owners);
  return { schema, report: diffSchema(checked, actual), unattributable };
}

async function commandVerify(client: pg.Client, files: MigrationFile[], scope?: OwnerScope): Promise<number> {
  const { schema, report, unattributable } = await runVerify(client, files, scope);
  reportUnattributable(unattributable);
  console.log(`实测对账（schema=${schema}）：声明 ${report.declaredObjectCount} 个对象、覆盖 ${report.declaredTableCount} 张表`);
  console.log(`缺失对象：${report.missing.length}`);
  for (const m of report.missing) console.log(`  - ${m.type}:${m.name}  ← ${m.version}`);
  console.log(`多余对象（库里有、任何迁移都没声明）：${report.extra.length}`);
  for (const e of report.extra) console.log(`  + ${e.type}:${e.name}`);
  return report.missing.length > 0 ? 1 : 0;
}

/**
 * baseline = **新建属主库的 seed 入口**，可重复执行、幂等。
 *
 * 序：① 建账本表（幂等 DDL）→ ② 实测对账：本组范围内声明的对象必须在这个库里真的存在
 * （缺一个就拒绝，绝不「假设已跑过」）→ ③ 把本组范围内的每条迁移以 baseline 行写入账本，
 * `ON CONFLICT (version) DO NOTHING`，所以重复跑只会全部落到「已存在跳过」。
 *
 * 新建 content 库的完整做法：
 *   1) 建库并把 content 的表灌进去（dump/restore 或按需重放）；
 *   2) `AIDCP_PG_CONTENT_URL=<新库> npm run migrate baseline --owner=content`；
 *   3) `AIDCP_PG_CONTENT_URL=<新库> npm run migrate status --owner=content` 复核。
 * 第 2 步可以随便重跑：幂等。
 */
async function commandBaseline(client: pg.Client, files: MigrationFile[], flags: Flags, scope?: OwnerScope): Promise<number> {
  await ensureLedger(client, files);
  const { schema, report, unattributable } = await runVerify(client, files, scope);
  reportUnattributable(unattributable);
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
  // 本库账本里不属于本组范围的行：拆库过渡期的残留（从共享库整体拷来的账本会带上另外两家的行）。
  // 不自动删（删账本行是不可逆动作），但 MUST 报出来，别让它悄悄留着冒充「本库已应用」。
  const inScope = new Set(files.map((f) => versionOf(f.name)));
  const foreign = rows.map((r) => r.version).filter((v) => !inScope.has(v)).sort(compareVersions);
  if (foreign.length > 0) {
    console.log(`本库账本另有 ${foreign.length} 行不属于本属主组范围（拆库过渡残留，人工确认后再清理）：${foreign.join(', ')}`);
  }
  return 0;
}

async function main(): Promise<void> {
  const command = process.argv[2];
  const flags = parseFlags(process.argv.slice(3));
  if (!command || !['status', 'up', 'verify', 'baseline'].includes(command)) {
    console.error(
      'Usage: npm run migrate <status|up|verify|baseline> [--allow-contract] [--by=<operator>] [--owner=<content|automation|api>]',
    );
    process.exitCode = 1;
    return;
  }

  // 属主判据不可用即退出：退化成「不分属主、全库一把梭」会把一个属主的迁移灌进另一个属主的库。
  const { index, files, tableOwners } = await loadMigrationOwnerScopes(() => loadMigrationFiles());
  if (index.residue.length > 0) {
    console.log(`残留迁移（头声明为空、计入全部属主）${index.residue.length} 条：${index.residue.join(', ')}`);
  }

  const owners = flags.owner ? [flags.owner] : PG_OWNERS;
  const groups = buildOwnerGroups(files, owners, index);
  let worst = 0;
  for (const group of groups) {
    console.log(`── ${describeGroup(group)} ──`);
    const client = new Client(group.config);
    await client.connect();
    try {
      let code = 1;
      const scope: OwnerScope = { owners: group.owners, index, tableOwners };
      if (command === 'status') code = await commandStatus(client, group.files);
      else if (command === 'up') code = await commandUp(client, group.files, flags);
      else if (command === 'verify') code = await commandVerify(client, group.files, scope);
      else if (command === 'baseline') code = await commandBaseline(client, group.files, flags, scope);
      worst = Math.max(worst, code);
    } finally {
      await client.end();
    }
  }
  process.exitCode = worst;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
