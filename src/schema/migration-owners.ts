/**
 * 「一条迁移属于哪个属主库」的唯一判据（Block③ 物理拆库：**每个属主库各持一份迁移账本**）。
 *
 * ## 为什么是每库一份账本
 *
 * 共享一份账本会逼 content / api 进程**跨读 automation 库**才能校验自己的 schema —— 那正好
 * 违反本项目的架构铁律「一个域绝不直连另一个域的数据库」。每库一份则自包含：每个属主进程只连
 * 自己的库、只读自己的账本、只校验自己那批表，拆进程后零跨域依赖。
 *
 * ## 账本范围 ≠ 执行范围（本模块最容易读错的一处）
 *
 * 一条迁移有**两个**互不相同的范围，MUST 分开读：
 *
 *   - **账本范围**（`ledgerOwners`）：哪些属主库要为它写一行「已处置」。
 *   - **执行范围**（`executionOwners`）：哪些属主库真的执行它的 SQL。可以是**空集**——
 *     「每个库都记账、哪个库都不执行」是一个合法且必要的形态（见下面第 2 点末尾）。
 *
 * 两者曾是同一个东西，那正是缺陷的根：一条迁移进入属主 O 的范围就意味着在 O 的库里跑它，
 * 于是 12 条单属主的历史迁移会在另外两个库里对**不存在的表**执行 DDL/DML，而
 * `0030_panel_hardening_indexes` 在任何单一属主库里都跑不通。
 *
 * ## 账本范围的判据（单一，不新造）
 *
 *   一条迁移记进属主 O 的账本  ⟺  它 `-- aidcp:objects=` 头里声明的对象所落在的表中，
 *                                至少有一张在 `boundaries/table-ownership.json` 里 owner = O；
 *                                一张都定位不到时**计入全部属主**（理由见下面第 2 点）。
 *
 * 两个输入都是既有机制：对象声明来自迁移文件头（`parseMigrationHeader`，同一份声明也是
 * `migrate verify` 的唯一事实源），属主来自边界清单（同一份清单也是 AC-OWN-* 的属主输入）。
 * 本文件 MUST NOT 另立判据，尤其 MUST NOT 由 SQL 文本反推表名 —— 那会造出第二套口径。
 *
 * ## 执行范围的解析顺序（唯一，MUST NOT 另立）
 *
 *   ① 文件内 `-- aidcp:owner=` 头（只给新迁移用）
 *   ② 封闭名册 `migrations/legacy-owner-overrides.json` 的条目（只给历史用）
 *   ③ `-- aidcp:objects=` 声明能定位到表 ⇒ 那些表的属主
 *   ④ **失败并指名**（进 `unresolvedExecution`，由 `loadMigrationOwnerScopes` 抛错）
 *
 * 第 ④ 步取代了旧的「推断不出就计入全部属主」，是本模块的核心红线：
 * **MUST NOT 静默把一条判不出执行范围的迁移放进任何库去跑。**
 *
 * 为什么历史与未来走两条不同的路径：已应用迁移的校验和是**整文件 sha256**，账本行与磁盘不一致
 * 即 `migration_checksum_mismatch` **整批拒绝**。往那 13 条已入账的迁移里加一行头声明，dev 与 ol
 * 的迁移命令会当场全停。故历史只能走**独立的封闭名册**（只减不增、version 必须属于冻结集合），
 * 新迁移才用文件内头（新文件尚未入账本，加头无成本）。范式与 `boundaries/adjudicated-files.json`
 * 一致：人工判过的集合，生成物不得回喂顶替。
 *
 * ## 三类必须显式处置的边角（都不许留模糊地带）
 *
 * 1. **跨属主迁移**（如 `0000_baseline…` 同时建 api / automation / content 三家的表）：
 *    **在每个相关属主的账本里各记一条**，版本 id 与校验和逐字相同；**不**按属主把条目拆成
 *    `0000@api` 一类的子条目。理由：版本 id 就是迁移文件的身份，校验和比对、复合序、乱序闸
 *    全都定义在它上面；造一批磁盘上不存在的合成版本 id 会让账本行对不上任何文件（`ledgerOnly`
 *    噪声）、让校验和比对失去对象、并把复合序分叉成三条。而账本行的语义本来就是
 *    「**这个版本在这个库里已经处置过**」—— 那天然就是按库一行。
 *
 * 2. **对象声明定位不到任何表的迁移**（本仓 13 条）：**账本范围**仍是全部属主，理由不变——
 *    否则 (a) 拆库后执行器会把一条外域迁移当 pending 塞进本属主库重放，(b) `planMigrations`
 *    的乱序闸会在每个库里把它判成 `migration_out_of_order` 整批拒绝。账本行只声称「该版本已
 *    处置」，从不声称「某张表存在」（对象级证明是 `migrate verify` 的职责）。清单每次都被
 *    `MigrationOwnerIndex.residue` 原样带出，调用方 MUST 打出来，绝不静默。
 *
 *    **但执行范围 MUST NOT 由此推断。** 本模块此前在这里写着「这类迁移不持有任何存活对象，
 *    因此没有哪个属主库的 schema 正确性依赖它，多记是安全方向」——**该前提已被 2026-08-05 的
 *    空库实跑证伪**：13 条里 12 条仍在对真实的表执行 DDL/DML，实跑停在
 *    `0030_panel_hardening_indexes`（`relation "risk_counters" does not exist`）。头声明为空只
 *    说明「它建的对象后来被别的文件重新声明了」（生成规则是「每个对象归**最后**创建它的那个
 *    文件」），**完全不说明它不碰表**。这一整段错误前提正是本 change 要拆掉的东西。
 *
 * 3. **账本迁移本身**（`0064_schema_migrations_ledger`）：`schema_migrations` 在边界清单里登记
 *    为 automation，但账本表是**每个库的基础设施**、不是业务表（该条目的 basis 也写明「拆库后
 *    账本的最终归属随数据库角色划分定」）。故它被**强制并入每个属主的账本范围与执行范围**，
 *    否则新建的 content 库连账本表都建不出来。这一条是显式例外，不是判据的一部分。
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

/* ------------------------------------------------------------------ 历史封闭名册 */

/** 名册文件名（与 `migrations/` 同目录：它逐条谈的就是那批文件）。 */
export const LEGACY_OWNER_OVERRIDES_NAME = 'legacy-owner-overrides.json';

/**
 * 名册绝对路径的**默认值**。与 `migrationsDir()` 同一口径、同一个坑：本族已并入共享包
 * `aidcp-transport`，装进 `node_modules/<包>/dist/schema/` 之后这个默认值指向包自己的目录。
 * **消费方 MUST 显式传自己的路径**（三个派生仓的启动契约门与 `scripts/migrate.ts` 都显式传）。
 */
export function legacyOwnerOverridesPath(): string {
  return path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '..',
    '..',
    'migrations',
    LEGACY_OWNER_OVERRIDES_NAME,
  );
}

/** 名册的一条：一条历史迁移的执行范围人判结论。 */
export interface LegacyOwnerOverride {
  version: string;
  /** 执行范围。`[]` = 每个库都记账、哪个库都不执行，此时 MUST 同时给 `supersededBy` */
  owners: PgOwner[];
  /** 判定依据：读了该迁移哪些语句、对应边界清单里哪一行的属主。MUST NOT 只写属主名 */
  basis: string;
  /** `owners: []` 时接替它建对象的迁移版本；这些迁移合起来 MUST 覆盖它声明过的全部对象 */
  supersededBy?: string[];
}

export interface LegacyOwnerOverrides {
  /**
   * 冻结集合：本 change 落地前磁盘上已存在的全部版本 id。名册条目的 version MUST 属于它，
   * 新迁移写进名册即失败——名册是**封闭**的历史处置表，不是常规路径。
   * 用显式清单而不是「文件 mtime / git 首次出现时间」：前者可审、可重放，后者不可。
   */
  frozenVersions: string[];
  /** 冻结集合为何是这一批（人工写，重建时 MUST 原样带过） */
  frozenBasis: string;
  /** 封存时的条目数。名册只减不增：`entries.length` MUST ≤ 它 */
  sealedEntryCount: number;
  entries: LegacyOwnerOverride[];
}

/**
 * 读名册。文件读不出、JSON 坏了、结构不对、属主非法、版本重复、条目数超过封存数、
 * 或某条 version 不在冻结集合里 —— 一律**抛错**。
 *
 * MUST NOT 在读不到时退化成空名册：那会让 13 条历史迁移一起掉进解析顺序的第 ④ 步，
 * 报出来的将是「判不出执行范围」而不是「名册没读到」，把一个部署问题伪装成一个数据问题。
 */
export async function loadLegacyOwnerOverrides(
  file = legacyOwnerOverridesPath(),
): Promise<LegacyOwnerOverrides> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(file, 'utf8'));
  } catch (error) {
    throw new Error(
      `读不出历史属主名册 ${file}：${error instanceof Error ? error.message : String(error)}` +
        '（它是 13 条历史迁移执行范围的唯一事实源，缺了 MUST NOT 当空名册继续）',
    );
  }
  const doc = raw as Partial<LegacyOwnerOverrides>;
  if (!Array.isArray(doc.frozenVersions) || doc.frozenVersions.length === 0) {
    throw new Error(`${file} 缺少非空 frozenVersions（冻结集合），无法判定名册条目是否越界`);
  }
  if (!Array.isArray(doc.entries)) throw new Error(`${file} 缺少 entries 数组`);
  if (typeof doc.sealedEntryCount !== 'number' || !Number.isInteger(doc.sealedEntryCount)) {
    throw new Error(`${file} 缺少整数 sealedEntryCount（封存条目数），棘轮无从判定`);
  }
  if (doc.entries.length > doc.sealedEntryCount) {
    throw new Error(
      `${file} 条目数 ${doc.entries.length} 超过封存数 ${doc.sealedEntryCount}：名册只减不增。` +
        '新迁移 MUST 用文件内 `-- aidcp:owner=` 头声明执行范围，MUST NOT 写进名册。',
    );
  }

  const frozen = new Set(doc.frozenVersions);
  const seen = new Set<string>();
  const problems: string[] = [];
  for (const entry of doc.entries) {
    if (typeof entry?.version !== 'string' || !entry.version) {
      problems.push(`条目缺少 version：${JSON.stringify(entry)}`);
      continue;
    }
    if (seen.has(entry.version)) problems.push(`${entry.version}：重复条目`);
    seen.add(entry.version);
    if (!frozen.has(entry.version)) {
      problems.push(`${entry.version}：不在冻结集合里（新迁移 MUST 用文件内 -- aidcp:owner= 头）`);
    }
    if (!Array.isArray(entry.owners) || entry.owners.some((o) => !isPgOwner(o))) {
      problems.push(`${entry.version}：owners MUST 是 ${PG_OWNERS.join(' / ')} 的数组`);
    }
    if (typeof entry.basis !== 'string' || entry.basis.trim().length === 0) {
      problems.push(`${entry.version}：缺少 basis（判定依据），MUST 写清读了哪些语句、按哪张表判的`);
    }
    if (Array.isArray(entry.owners) && entry.owners.length === 0) {
      if (!Array.isArray(entry.supersededBy) || entry.supersededBy.length === 0) {
        problems.push(
          `${entry.version}：owners 为空（记账不执行）MUST 同时给 supersededBy —— ` +
            '不给就是把它建过的对象在全新库上悄悄丢掉，这是本机制最容易犯的错。',
        );
      }
    }
  }
  if (problems.length > 0) throw new Error(`${file} 校验失败：\n  ${problems.join('\n  ')}`);

  return {
    frozenVersions: doc.frozenVersions,
    frozenBasis: typeof doc.frozenBasis === 'string' ? doc.frozenBasis : '',
    sealedEntryCount: doc.sealedEntryCount,
    entries: doc.entries,
  };
}

/** 空名册：只给「本次输入里没有任何历史迁移」的脱库单测用。生产路径 MUST 传真名册。 */
export const EMPTY_LEGACY_OWNER_OVERRIDES: LegacyOwnerOverrides = {
  frozenVersions: [],
  frozenBasis: '（空名册，仅供脱库单测）',
  sealedEntryCount: 0,
  entries: [],
};

/* ------------------------------------------------------------------ 归属 */

/** 一条迁移进入某个属主**账本**范围的理由。 */
export type MigrationScopeReason =
  /** 头声明的对象落在该属主的表上 */
  | 'declared'
  /** 头里没有任何可定位到表的对象声明 → 账本范围计入全部属主（见文件头第 2 点） */
  | 'residue'
  /** 账本表迁移，每个库的基础设施 → 强制并入全部属主（见文件头第 3 点） */
  | 'ledger';

/** 执行范围是按解析顺序的哪一步定下来的（`unresolved` = 第 ④ 步，判失败）。 */
export type MigrationExecutionBasis = 'header' | 'roster' | 'declared' | 'ledger' | 'unresolved';

export interface MigrationAttribution {
  version: string;
  name: string;
  /** 头声明能定位到的表名（复合序无关，字典序） */
  tables: string[];
  /** **账本范围**：哪些属主库为它写一行「已处置」（复合序无关，PG_OWNERS 序） */
  ledgerOwners: PgOwner[];
  /** **执行范围**：哪些属主库真的执行它的 SQL；空数组 = 记账不执行 */
  executionOwners: PgOwner[];
  /** 账本范围的理由 */
  reason: MigrationScopeReason;
  /** 执行范围的来源 */
  executionBasis: MigrationExecutionBasis;
  /** 名册里 `owners: []` 时点名的接替迁移 */
  supersededBy?: string[];
}

export interface MigrationOwnerIndex {
  byVersion: Map<string, MigrationAttribution>;
  /** 本构建磁盘上认识的全部版本 id（用来区分「不属于本属主」与「本构建根本不认识」） */
  allVersions: Set<string>;
  /** 头声明定位不到任何表、账本范围计入全部属主的版本 id（调用方 MUST 打出来） */
  residue: string[];
  /** 执行范围为空（记账不执行）的版本 id —— 调用方 MUST 原样打出来，绝不静默 */
  recordedNotExecuted: string[];
  /** 头里声明了、但边界清单查不到属主的表 —— 非空即判失败，MUST NOT 静默丢弃 */
  unknownTables: string[];
  /** 解析顺序四步走完仍判不出执行范围的版本 id —— 非空即判失败（红线：MUST NOT 静默放行） */
  unresolvedExecution: string[];
  /** 名册自身的结构性问题（条目指向磁盘上不存在的版本 / 接替声明覆盖不全） */
  overrideProblems: string[];
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

/** 该文件声明过的对象键集合（`type:name`），用于名册的接替覆盖校验。 */
function declaredObjectKeys(content: string): Set<string> {
  return new Set(parseMigrationHeader(content).objects.map((o) => `${o.type}:${o.name}`));
}

/**
 * 按上面的两套判据给每条迁移定**账本范围**与**执行范围**。纯函数，不读文件、不连库。
 *
 * 名册缺省为空只服务脱库单测；生产路径一律由 `loadMigrationOwnerScopes` 把真名册传进来。
 */
export function attributeMigrations(
  files: MigrationFile[],
  tableOwners: Map<string, PgOwner>,
  overrides: LegacyOwnerOverrides = EMPTY_LEGACY_OWNER_OVERRIDES,
): MigrationOwnerIndex {
  const byVersion = new Map<string, MigrationAttribution>();
  const allVersions = new Set<string>();
  const residue: string[] = [];
  const recordedNotExecuted: string[] = [];
  const unknown = new Set<string>();
  const unresolved: string[] = [];

  const overrideByVersion = new Map(overrides.entries.map((e) => [e.version, e]));
  const contentByVersion = new Map(files.map((f) => [versionOf(f.name), f.content]));

  for (const file of files) {
    const version = versionOf(file.name);
    allVersions.add(version);
    const header = parseMigrationHeader(file.content);
    const tables = tablesOf(file.content);
    const declaredOwners = new Set<PgOwner>();
    for (const table of tables) {
      const owner = tableOwners.get(table);
      if (!owner) {
        unknown.add(table);
        continue;
      }
      declaredOwners.add(owner);
    }

    // ── 账本范围：今日口径逐字不变（定位不到表 ⇒ 全部属主；账本迁移 ⇒ 全部属主）
    const ledgerOwners = new Set(declaredOwners);
    let reason: MigrationScopeReason = 'declared';
    if (version === LEDGER_MIGRATION_VERSION) {
      reason = 'ledger';
      for (const owner of PG_OWNERS) ledgerOwners.add(owner);
    } else if (ledgerOwners.size === 0) {
      reason = 'residue';
      residue.push(version);
      for (const owner of PG_OWNERS) ledgerOwners.add(owner);
    }

    // ── 执行范围：① 文件内头 → ② 名册 → ③ 对象声明 → ④ 失败并指名
    let executionOwners: PgOwner[] | undefined;
    let executionBasis: MigrationExecutionBasis = 'unresolved';
    let supersededBy: string[] | undefined;
    const override = overrideByVersion.get(version);
    if (version === LEDGER_MIGRATION_VERSION) {
      executionOwners = [...PG_OWNERS];
      executionBasis = 'ledger';
    } else if (header.owners !== undefined) {
      // 头里写了就以头为准。非法取值 MUST 判失败，MUST NOT 退回下一步——退回等于让一个拼错的
      // 属主名悄悄改走推断路径，而推断在这类迁移上恰恰是错的。
      const bad = header.owners.filter((o) => !isPgOwner(o));
      if (bad.length > 0) {
        unresolved.push(
          `${version}（-- aidcp:owner= 里的 ${bad.join(' / ')} 不是 ${PG_OWNERS.join(' / ')} 之一）`,
        );
      } else {
        executionOwners = PG_OWNERS.filter((o) => (header.owners as string[]).includes(o));
        executionBasis = 'header';
      }
    } else if (override) {
      executionOwners = PG_OWNERS.filter((o) => override.owners.includes(o));
      executionBasis = 'roster';
      supersededBy = override.supersededBy;
    } else if (declaredOwners.size > 0) {
      executionOwners = PG_OWNERS.filter((o) => declaredOwners.has(o));
      executionBasis = 'declared';
    } else {
      unresolved.push(
        `${version}（对象声明定位不到任何表，且既无 -- aidcp:owner= 头也无名册条目）`,
      );
    }
    if (executionOwners && executionOwners.length === 0) recordedNotExecuted.push(version);

    byVersion.set(version, {
      version,
      name: file.name,
      tables,
      ledgerOwners: PG_OWNERS.filter((o) => ledgerOwners.has(o)),
      executionOwners: executionOwners ?? [],
      reason,
      executionBasis,
      ...(supersededBy ? { supersededBy } : {}),
    });
  }

  // 名册自身的两条结构性校验（都要 files 才判得了，故放在这里而不是 loader 里）：
  //   (c) 名册不得留着磁盘上已不存在的 version；
  //   4.5 接替覆盖：`owners: []` 点名的迁移合起来 MUST 覆盖它声明过的全部对象。
  const overrideProblems: string[] = [];
  for (const entry of overrides.entries) {
    const own = contentByVersion.get(entry.version);
    if (own === undefined) {
      overrideProblems.push(`${entry.version}：名册有条目、迁移目录里却没有这个版本（MUST 人工确认后删条目）`);
      continue;
    }
    if (entry.owners.length > 0) continue;
    const need = declaredObjectKeys(own);
    const covered = new Set<string>();
    for (const heir of entry.supersededBy ?? []) {
      const heirContent = contentByVersion.get(heir);
      if (heirContent === undefined) {
        overrideProblems.push(`${entry.version}：supersededBy 点名的 ${heir} 不在迁移目录里`);
        continue;
      }
      for (const key of declaredObjectKeys(heirContent)) covered.add(key);
    }
    const missing = [...need].filter((k) => !covered.has(k)).sort();
    if (missing.length > 0) {
      overrideProblems.push(
        `${entry.version}：记账不执行，但接替迁移（${(entry.supersededBy ?? []).join(', ') || '无'}）` +
          `没有覆盖它声明过的对象 ${missing.join(', ')} —— 这些对象会在全新库上被悄悄丢掉`,
      );
    }
  }

  return {
    byVersion,
    allVersions,
    residue: residue.sort(compareVersions),
    recordedNotExecuted: recordedNotExecuted.sort(compareVersions),
    unknownTables: [...unknown].sort(),
    unresolvedExecution: unresolved.sort(),
    overrideProblems,
  };
}

/** 属主 O 的**账本**版本集合（复合序）：分发范围与契约门的「已知版本」都取这个。 */
export function versionsForOwner(index: MigrationOwnerIndex, owner: PgOwner): string[] {
  const out: string[] = [];
  for (const attribution of index.byVersion.values()) {
    if (attribution.ledgerOwners.includes(owner)) out.push(attribution.version);
  }
  return out.sort(compareVersions);
}

/** 属主 O 的**执行**版本集合（复合序）：只有它们的 SQL 会在 O 的库里真的发出去。 */
export function executionVersionsForOwner(index: MigrationOwnerIndex, owner: PgOwner): string[] {
  const out: string[] = [];
  for (const attribution of index.byVersion.values()) {
    if (attribution.executionOwners.includes(owner)) out.push(attribution.version);
  }
  return out.sort(compareVersions);
}

/**
 * 一组属主里「记账但不执行」的版本（复合序）。
 * 组内任一属主要执行它，就不算——执行范围是按库判的，不是按条目判的。
 */
export function recordOnlyVersionsForOwners(
  index: MigrationOwnerIndex,
  versions: readonly string[],
  owners: readonly PgOwner[],
): string[] {
  return versions
    .filter((version) => {
      const attribution = index.byVersion.get(version);
      if (!attribution) return false;
      return !owners.some((owner) => attribution.executionOwners.includes(owner));
    })
    .sort(compareVersions);
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
  /** 表 → 属主（调用方要用它把对象声明收窄到本属主，见 scopeDeclarationsToOwners） */
  tableOwners: Map<string, PgOwner>;
  /** 本次用的历史封闭名册（调用方要报「执行范围从哪来」时用得上） */
  overrides: LegacyOwnerOverrides;
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
  loadOverrides: () => Promise<LegacyOwnerOverrides> = () => loadLegacyOwnerOverrides(),
): Promise<MigrationOwnerScopes> {
  const files = await loadFiles();
  const tableOwners = await loadOwners();
  const overrides = await loadOverrides();
  const index = attributeMigrations(files, tableOwners, overrides);
  if (index.unknownTables.length > 0) {
    throw new Error(
      `下列表被迁移头声明、但 boundaries/table-ownership.json 里查不到属主，无法判定迁移归属：${index.unknownTables.join(', ')}`,
    );
  }
  // 解析顺序第 ④ 步。判不出执行范围时 MUST 停手并指名——旧实现在这里静默计入全部属主，
  // 结果是把一条只碰 api 表的迁移放进 content 库去跑，报 relation does not exist 整批停。
  if (index.unresolvedExecution.length > 0) {
    throw new Error(
      '下列迁移判不出执行范围（解析顺序：文件内 -- aidcp:owner= 头 → migrations/' +
        `${LEGACY_OWNER_OVERRIDES_NAME} 名册条目 → 对象声明能定位到表）：\n  ` +
        index.unresolvedExecution.join('\n  ') +
        '\n新迁移 MUST 写 -- aidcp:owner= 头；历史迁移的字节不可改，只能进名册。',
    );
  }
  if (index.overrideProblems.length > 0) {
    throw new Error(`历史属主名册与迁移目录对不上：\n  ${index.overrideProblems.join('\n  ')}`);
  }
  for (const owner of PG_OWNERS) {
    if (versionsForOwner(index, owner).length === 0) {
      throw new Error(`属主 ${owner} 的迁移范围为空，属主判据已失效（迁移目录或边界清单不完整）`);
    }
    if (executionVersionsForOwner(index, owner).length === 0) {
      throw new Error(`属主 ${owner} 的执行范围为空，判据已失效（名册或迁移目录不完整）`);
    }
  }
  return { index, files, tableOwners, overrides };
}

/**
 * 把「本组范围内全部迁移声明的对象」收窄到「这些属主真正拥有的对象」。
 *
 * 为什么必须收窄：一条迁移可以同时碰多个属主的表（实测 8 条），它会因此进入每个相关属主的范围。
 * 但它声明的对象里，只有**本属主拥有的那部分**该在本属主的库里存在。不收窄就会出现
 * 「在 content 库里要求 automation 的表」这种必然失败，而这条失败会挡住新建库的 baseline ——
 * 于是新库永远没有账本，契约门永远报「账本表不存在」。
 *
 * 收窄规则：
 *   - `table:t` / `column:t.c` → 按 `boundaries/table-ownership.json` 判 `t` 的属主，属本组才核验；
 *   - `index:i` / `constraint:c` → 声明里**不带表名**，无法反推归属表。若它来自一条只碰本组属主的
 *     迁移，则确定属本组、照常核验；若来自**跨属主**迁移，则无法归因 —— 归进 `unattributable`，
 *     由调用方**如实打印「本次未核验」**。MUST NOT 静默丢弃：一个说不清自己验了什么的验证装置，
 *     比没有验证更坏。
 */
export interface OwnerScopedDeclarations<T extends { type: string; name: string; version: string }> {
  /** 确定属于本组、本次真的核验了的对象 */
  checked: T[];
  /** 来自跨属主迁移的索引/约束声明：无法按属主归因，本次**未核验**（调用方 MUST 打出来） */
  unattributable: T[];
}

export function scopeDeclarationsToOwners<T extends { type: string; name: string; version: string }>(
  declared: readonly T[],
  index: MigrationOwnerIndex,
  tableOwners: Map<string, PgOwner>,
  owners: readonly PgOwner[],
): OwnerScopedDeclarations<T> {
  const inGroup = new Set<PgOwner>(owners);
  const checked: T[] = [];
  const unattributable: T[] = [];

  for (const obj of declared) {
    if (obj.type === 'table' || obj.type === 'column') {
      const table = obj.type === 'table' ? obj.name : obj.name.slice(0, obj.name.indexOf('.'));
      const owner = tableOwners.get(table);
      if (owner && inGroup.has(owner)) checked.push(obj);
      continue;
    }
    // index / constraint：只有当声明它的那条迁移**只在本组属主的库里执行**时才能确定归属。
    // 这里读的是**执行范围**而不是账本范围：一条只在 automation 库里跑的迁移，它建的索引
    // 就只可能出现在 automation 库里——按账本范围（可能是全部属主）判会把它一路划进
    // unattributable，于是那些索引在**任何**库里都不被核验，验证装置变成摆设。
    const attribution = index.byVersion.get(obj.version);
    const migrationOwners = attribution?.executionOwners ?? [];
    if (migrationOwners.length > 0 && migrationOwners.every((o) => inGroup.has(o))) checked.push(obj);
    else unattributable.push(obj);
  }

  return { checked, unattributable };
}
