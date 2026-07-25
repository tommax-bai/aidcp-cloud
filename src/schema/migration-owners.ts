/**
 * 「一条迁移属于哪个属主库」的唯一判据（Block③ 物理拆库：**每个属主库各持一份迁移账本**）。
 *
 * ## 为什么是每库一份账本
 *
 * 共享一份账本会逼 content / api 进程**跨读 automation 库**才能校验自己的 schema —— 那正好
 * 违反本项目的架构铁律「一个域绝不直连另一个域的数据库」。每库一份则自包含：每个属主进程只连
 * 自己的库、只读自己的账本、只校验自己那批表，拆进程后零跨域依赖。
 *
 * ## 判据（单一，不新造）
 *
 *   一条迁移属于属主 O  ⟺  它 `-- aidcp:objects=` 头里声明的对象所落在的表中，
 *                          至少有一张在 `boundaries/table-ownership.json` 里 owner = O。
 *
 * 两个输入都是既有机制：对象声明来自迁移文件头（`parseMigrationHeader`，同一份声明也是
 * `migrate verify` 的唯一事实源），属主来自边界清单（同一份清单也是 AC-OWN-* 的属主输入）。
 * 本文件 MUST NOT 另立判据，尤其 MUST NOT 由 SQL 文本反推表名 —— 那会造出第二套口径。
 *
 * ## 两类必须显式处置的边角（都不许留模糊地带）
 *
 * 1. **跨属主迁移**（如 `0000_baseline…` 同时建 api / automation / content 三家的表）：
 *    **在每个相关属主的账本里各记一条**，版本 id 与校验和逐字相同；**不**按属主把条目拆成
 *    `0000@api` 一类的子条目。理由：版本 id 就是迁移文件的身份，校验和比对、复合序、乱序闸
 *    全都定义在它上面；造一批磁盘上不存在的合成版本 id 会让账本行对不上任何文件（`ledgerOnly`
 *    噪声）、让校验和比对失去对象、并把复合序分叉成三条。而账本行的语义本来就是
 *    「**这个版本在这个库里已经处置过**」—— 那天然就是按库一行。
 *
 * 2. **残留迁移**（头里没有任何能定位到表的对象声明，本仓 13 条）：**算作全部属主的**。
 *    这不是兜底默认值，是有依据的：头声明由 `scripts/generate-migration-headers.ts` 生成，
 *    规则是「每个对象归属于**最后**创建它的那个文件」，所以一条早期迁移的产物若被后来的
 *    baseline 迁移重新声明，它自己就只剩一个空 `-- aidcp:objects=` 头。这类迁移**不持有任何
 *    存活对象**，因此没有哪个属主库的 schema 正确性依赖它；但每个属主库仍必须把它记成「已处置」，
 *    否则 (a) 拆库后执行器会把一条外域迁移当 pending 塞进本属主库重放，(b) `planMigrations`
 *    的乱序闸会在每个库里把它判成 `migration_out_of_order` 整批拒绝。
 *    多记的方向是**安全方向**：账本行只声称「该版本已处置」，从不声称「某张表存在」（对象级
 *    证明是 `migrate verify` 的职责）；少记才会开洞，而少记会被契约门当缺失响亮报出来。
 *    残留清单每次都被 `MigrationOwnerIndex.residue` 原样带出，调用方 MUST 打出来，绝不静默。
 *
 * 3. **账本迁移本身**（`0064_schema_migrations_ledger`）：`schema_migrations` 在边界清单里登记
 *    为 automation，但账本表是**每个库的基础设施**、不是业务表（该条目的 basis 也写明「拆库后
 *    账本的最终归属随数据库角色划分定」）。故它被**强制并入每个属主的范围**，否则新建的
 *    content 库连账本表都建不出来。这一条是显式例外，不是判据的一部分。
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { PG_OWNERS, type PgOwner } from '../kernel/pg-owner-connection-resolver.js';
import { LEDGER_MIGRATION_NAME } from './migration-files.js';
import { compareVersions, parseMigrationHeader, versionOf, type MigrationFile } from './migration-plan.js';

/** 账本迁移的版本 id（每个属主库都要有账本表，故强制并入每个属主范围）。 */
export const LEDGER_MIGRATION_VERSION = versionOf(LEDGER_MIGRATION_NAME);

/**
 * 边界清单绝对路径（相对本文件解析，与 `migrationsDir()` 同一口径：随仓库移动仍成立；
 * 运行时走 `tsx src/server.ts`，故解析的是源码树而非 dist）。
 */
export function tableOwnershipPath(): string {
  return path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '..',
    '..',
    'boundaries',
    'table-ownership.json',
  );
}

function isPgOwner(value: unknown): value is PgOwner {
  return typeof value === 'string' && (PG_OWNERS as readonly string[]).includes(value);
}

/**
 * 读 `boundaries/table-ownership.json` → `表名 → 属主`。
 *
 * 文件读不出来、JSON 坏了、或某条 owner 不是三属主之一 → **抛错**。调用方 MUST NOT 吞掉它退化成
 * 「查不到就当没有属主」：那会让一批表悄悄从所有属主范围里消失，正是本模块要消灭的假绿形态。
 */
export async function loadTableOwnership(file = tableOwnershipPath()): Promise<Map<string, PgOwner>> {
  const raw = JSON.parse(await readFile(file, 'utf8')) as { tables?: unknown };
  if (!Array.isArray(raw.tables)) {
    throw new Error(`${file} 缺少 tables 数组，无法判定迁移属主`);
  }
  const map = new Map<string, PgOwner>();
  const bad: string[] = [];
  for (const entry of raw.tables as { table?: unknown; owner?: unknown }[]) {
    if (typeof entry?.table !== 'string' || !entry.table) continue;
    if (!isPgOwner(entry.owner)) {
      bad.push(`${entry.table}=${String(entry.owner)}`);
      continue;
    }
    map.set(entry.table, entry.owner);
  }
  if (bad.length > 0) {
    throw new Error(`${file} 中下列表的 owner 不是 ${PG_OWNERS.join(' / ')} 之一：${bad.join(', ')}`);
  }
  return map;
}

/** 一条迁移进入某个属主范围的理由。 */
export type MigrationScopeReason =
  /** 头声明的对象落在该属主的表上 */
  | 'declared'
  /** 头里没有任何可定位到表的对象声明 → 计入全部属主（见文件头第 2 点） */
  | 'residue'
  /** 账本表迁移，每个库的基础设施 → 强制并入全部属主（见文件头第 3 点） */
  | 'ledger';

export interface MigrationAttribution {
  version: string;
  name: string;
  /** 头声明能定位到的表名（复合序无关，字典序） */
  tables: string[];
  /** 该迁移进入哪些属主的范围（复合序无关，PG_OWNERS 序） */
  owners: PgOwner[];
  reason: MigrationScopeReason;
}

export interface MigrationOwnerIndex {
  byVersion: Map<string, MigrationAttribution>;
  /** 本构建磁盘上认识的全部版本 id（用来区分「不属于本属主」与「本构建根本不认识」） */
  allVersions: Set<string>;
  /** 头声明为空、按残留规则计入全部属主的版本 id（调用方 MUST 打出来） */
  residue: string[];
  /** 头里声明了、但边界清单查不到属主的表 —— 非空即判失败，MUST NOT 静默丢弃 */
  unknownTables: string[];
}

function tablesOf(content: string): string[] {
  const tables = new Set<string>();
  for (const obj of parseMigrationHeader(content).objects) {
    if (obj.type === 'table') tables.add(obj.name);
    else if (obj.type === 'column') {
      const dot = obj.name.indexOf('.');
      if (dot > 0) tables.add(obj.name.slice(0, dot));
    }
    // index / constraint 名在 PG 里不带表名，无法从声明反推归属表；
    // 只声明了索引的迁移因此落进残留分支（计入全部属主），MUST NOT 猜。
  }
  return [...tables].sort();
}

/** 按上面的判据给每条迁移定属主范围。纯函数，不读文件、不连库。 */
export function attributeMigrations(
  files: MigrationFile[],
  tableOwners: Map<string, PgOwner>,
): MigrationOwnerIndex {
  const byVersion = new Map<string, MigrationAttribution>();
  const allVersions = new Set<string>();
  const residue: string[] = [];
  const unknown = new Set<string>();

  for (const file of files) {
    const version = versionOf(file.name);
    allVersions.add(version);
    const tables = tablesOf(file.content);
    const owners = new Set<PgOwner>();
    for (const table of tables) {
      const owner = tableOwners.get(table);
      if (!owner) {
        unknown.add(table);
        continue;
      }
      owners.add(owner);
    }

    let reason: MigrationScopeReason = 'declared';
    if (version === LEDGER_MIGRATION_VERSION) {
      reason = 'ledger';
      for (const owner of PG_OWNERS) owners.add(owner);
    } else if (owners.size === 0) {
      reason = 'residue';
      residue.push(version);
      for (const owner of PG_OWNERS) owners.add(owner);
    }

    byVersion.set(version, {
      version,
      name: file.name,
      tables,
      owners: PG_OWNERS.filter((o) => owners.has(o)),
      reason,
    });
  }

  return {
    byVersion,
    allVersions,
    residue: residue.sort(compareVersions),
    unknownTables: [...unknown].sort(),
  };
}

/** 属主 O 的迁移版本集合（复合序）。 */
export function versionsForOwner(index: MigrationOwnerIndex, owner: PgOwner): string[] {
  const out: string[] = [];
  for (const attribution of index.byVersion.values()) {
    if (attribution.owners.includes(owner)) out.push(attribution.version);
  }
  return out.sort(compareVersions);
}

/** 属主 O 的迁移文件集合（复合序），供执行器按属主库裁剪范围。 */
export function filesForOwners(
  files: MigrationFile[],
  index: MigrationOwnerIndex,
  owners: readonly PgOwner[],
): MigrationFile[] {
  const wanted = new Set<string>();
  for (const owner of owners) for (const v of versionsForOwner(index, owner)) wanted.add(v);
  return files
    .filter((f) => wanted.has(versionOf(f.name)))
    .sort((a, b) => compareVersions(versionOf(a.name), versionOf(b.name)));
}

export interface MigrationOwnerScopes {
  index: MigrationOwnerIndex;
  files: MigrationFile[];
}

/**
 * 一次性把「迁移文件 + 属主清单 → 属主范围」备齐。
 *
 * 任一输入缺失（迁移目录读不出、边界清单读不出）或存在无属主的声明表，一律**抛错**。
 * 契约门与执行器都 MUST 让这个错误直接判失败：判据不可用时「继续放行」等于什么都没校验，
 * 那正是本刀要消灭的 enforce 假绿。
 */
export async function loadMigrationOwnerScopes(
  loadFiles: () => Promise<MigrationFile[]>,
  loadOwners: () => Promise<Map<string, PgOwner>> = () => loadTableOwnership(),
): Promise<MigrationOwnerScopes> {
  const files = await loadFiles();
  const tableOwners = await loadOwners();
  const index = attributeMigrations(files, tableOwners);
  if (index.unknownTables.length > 0) {
    throw new Error(
      `下列表被迁移头声明、但 boundaries/table-ownership.json 里查不到属主，无法判定迁移归属：${index.unknownTables.join(', ')}`,
    );
  }
  for (const owner of PG_OWNERS) {
    if (versionsForOwner(index, owner).length === 0) {
      throw new Error(`属主 ${owner} 的迁移范围为空，属主判据已失效（迁移目录或边界清单不完整）`);
    }
  }
  return { index, files };
}
