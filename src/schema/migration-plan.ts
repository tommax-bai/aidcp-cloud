/**
 * 迁移计划（纯函数层，change cloud-schema-migration-executor 任务 1.2）。
 *
 * 输入「文件名 + 内容 + 校验和」列表与账本行列表，输出 { pending, skipped, errors }。
 * 本文件 MUST NOT import pg —— 它必须能脱库单测。
 *
 * 版本 id = 文件名去 `.sql` 后缀（如 `0002_bot_chats`）。
 * 排序键 = （数字前缀数值升序，完整文件名字典序升序）复合序；历史四组同号碰撞由此被冻结成可复现顺序。
 *
 * 可判定错误只有三类（多一类都不许加，见 design.md D1）：
 *   - migration_checksum_mismatch：已入账本但磁盘内容变了 → 整批拒绝，绝不重跑、绝不覆盖账本校验和。
 *   - migration_out_of_order：版本序低于账本最大已应用版本却不在账本里 → 整批拒绝，绝不补跑。
 *   - migration_kind_missing：缺 `-- aidcp:kind=` 头声明 → 拒绝写入账本（up 与 baseline 都要写 kind）。
 */

export type MigrationKind = 'expand' | 'contract';

export interface MigrationFile {
  /** 文件名，含 `.sql` 后缀 */
  name: string;
  /** 文件全文 */
  content: string;
  /** 文件字节的 SHA-256（十六进制小写） */
  checksum: string;
}

export interface LedgerRow {
  version: string;
  checksum: string;
}

export interface PlannedMigration {
  version: string;
  name: string;
  content: string;
  checksum: string;
  kind: MigrationKind;
}

export type MigrationPlanErrorCode =
  | 'migration_checksum_mismatch'
  | 'migration_out_of_order'
  | 'migration_kind_missing';

export interface MigrationPlanError {
  code: MigrationPlanErrorCode;
  version: string;
  detail: string;
}

export interface MigrationPlan {
  /** 待应用项，已按复合序排好 */
  pending: PlannedMigration[];
  /** 已在账本且校验和一致 → 跳过（幂等） */
  skipped: string[];
  /** 账本里有、磁盘上没有对应文件的版本（库比代码新的线索；不是可判定错误，由启动期契约门处理） */
  ledgerOnly: string[];
  errors: MigrationPlanError[];
}

/** 迁移文件名去后缀即版本 id。 */
export function versionOf(fileName: string): string {
  return fileName.replace(/\.sql$/i, '');
}

/**
 * 数字前缀。无前缀时返回 Number.MAX_SAFE_INTEGER，使其排在全部有号文件之后
 * （而不是被当成 0 悄悄插到最前面 —— 那会制造一次假的 out_of_order 判定）。
 */
export function numericPrefix(version: string): number {
  const m = /^(\d+)/.exec(version);
  if (!m) return Number.MAX_SAFE_INTEGER;
  return Number(m[1]);
}

/** 复合序比较：先比数字前缀数值，再比完整版本 id 字典序。MUST NOT 退化成纯字符串比较。 */
export function compareVersions(a: string, b: string): number {
  const pa = numericPrefix(a);
  const pb = numericPrefix(b);
  if (pa !== pb) return pa < pb ? -1 : 1;
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

export interface MigrationHeader {
  kind?: MigrationKind;
  /** 头里写了 kind 但值不是 expand/contract 时，原样带出用于报错 */
  rawKind?: string;
  objects: MigrationObject[];
  /**
   * `-- aidcp:owner=<owner>[,<owner>]` 声明的**执行范围**（原样字符串，此处不校验取值）。
   *
   * 本文件刻意不校验：属主枚举住在 kernel，而本模块 MUST 保持零依赖以便脱库单测。
   * 合法性由 `migration-owners.ts` 判——非法值即失败，MUST NOT 当作「没写」放过去：
   * 那会让一条拼错属主名的迁移悄悄退回按对象声明推断，正是本机制要消灭的静默路径。
   *
   * 没写这一行时为 `undefined`；写了但一个 token 都没有时为**空数组**。两者语义不同
   * （「没声明」vs「声明了哪个库都不执行」），MUST NOT 压成同一态。
   */
  owners?: string[];
}

export type MigrationObjectType = 'table' | 'column' | 'index' | 'constraint';

export interface MigrationObject {
  type: MigrationObjectType;
  /** table:`t` / column:`t.c` / index:`i` / constraint:`c` */
  name: string;
}

const KIND_LINE = /^[ \t]*--[ \t]*aidcp:kind[ \t]*=[ \t]*([A-Za-z_]+)[ \t]*$/gm;
const OBJECTS_LINE = /^[ \t]*--[ \t]*aidcp:objects[ \t]*=[ \t]*(.+)$/gm;
/** `-- aidcp:owner=` 允许写空值（声明「哪个库都不执行」），故值段是 `(.*)` 而非 `(.+)`。 */
const OWNER_LINE = /^[ \t]*--[ \t]*aidcp:owner[ \t]*=[ \t]*(.*)$/gm;

/**
 * 解析迁移文件头的结构化声明。
 * `-- aidcp:objects=` 可写多行，取并集（长清单便于分行维护）。
 * 对象声明只从头注释来，MUST NOT 由 SQL 文本推断（推断不全 = 假阴性 = 假装验证通过）。
 */
export function parseMigrationHeader(content: string): MigrationHeader {
  KIND_LINE.lastIndex = 0;
  OBJECTS_LINE.lastIndex = 0;
  OWNER_LINE.lastIndex = 0;
  const kindMatch = KIND_LINE.exec(content);
  const rawKind = kindMatch?.[1];
  const kind: MigrationKind | undefined =
    rawKind === 'expand' || rawKind === 'contract' ? rawKind : undefined;

  const objects: MigrationObject[] = [];
  const seen = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = OBJECTS_LINE.exec(content)) !== null) {
    for (const raw of m[1].split(',')) {
      const token = raw.trim();
      if (!token) continue;
      const sep = token.indexOf(':');
      if (sep <= 0) continue;
      const type = token.slice(0, sep).trim();
      const name = token.slice(sep + 1).trim();
      if (!name) continue;
      if (type !== 'table' && type !== 'column' && type !== 'index' && type !== 'constraint') continue;
      const key = `${type}:${name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      objects.push({ type, name });
    }
  }

  // 执行范围头：多行取并集（与 objects 同形），去重后保序。写了几行都算「声明过」。
  let owners: string[] | undefined;
  let om: RegExpExecArray | null;
  while ((om = OWNER_LINE.exec(content)) !== null) {
    owners ??= [];
    for (const raw of om[1].split(',')) {
      const token = raw.trim();
      if (!token) continue;
      if (!owners.includes(token)) owners.push(token);
    }
  }

  return { kind, rawKind, objects, owners };
}

export function planMigrations(files: MigrationFile[], ledger: LedgerRow[]): MigrationPlan {
  const sorted = [...files].sort((a, b) => compareVersions(versionOf(a.name), versionOf(b.name)));
  const ledgerByVersion = new Map<string, LedgerRow>();
  for (const row of ledger) ledgerByVersion.set(row.version, row);

  let maxApplied: string | undefined;
  for (const row of ledger) {
    if (maxApplied === undefined || compareVersions(row.version, maxApplied) > 0) maxApplied = row.version;
  }

  const pending: PlannedMigration[] = [];
  const skipped: string[] = [];
  const errors: MigrationPlanError[] = [];
  const fileVersions = new Set<string>();

  for (const file of sorted) {
    const version = versionOf(file.name);
    fileVersions.add(version);
    const applied = ledgerByVersion.get(version);
    if (applied) {
      if (applied.checksum !== file.checksum) {
        errors.push({
          code: 'migration_checksum_mismatch',
          version,
          detail: `账本校验和 ${applied.checksum} 与磁盘 ${file.checksum} 不一致`,
        });
      } else {
        skipped.push(version);
      }
      continue;
    }

    if (maxApplied !== undefined && compareVersions(version, maxApplied) < 0) {
      errors.push({
        code: 'migration_out_of_order',
        version,
        detail: `版本序低于账本最大已应用版本 ${maxApplied}，不补跑`,
      });
      continue;
    }

    const header = parseMigrationHeader(file.content);
    if (!header.kind) {
      errors.push({
        code: 'migration_kind_missing',
        version,
        detail: header.rawKind
          ? `头声明 -- aidcp:kind=${header.rawKind} 非法，只接受 expand / contract`
          : '缺少 -- aidcp:kind=expand|contract 头声明',
      });
      continue;
    }

    pending.push({ version, name: file.name, content: file.content, checksum: file.checksum, kind: header.kind });
  }

  const ledgerOnly = ledger
    .map((row) => row.version)
    .filter((version) => !fileVersions.has(version))
    .sort(compareVersions);

  return { pending, skipped, ledgerOnly, errors };
}

/**
 * 共库期收缩闸（任务 1.6）：待应用集合里出现 kind=contract 且未显式授权 → 整批拒绝。
 * 返回被拒的版本清单；空数组代表放行。
 */
export function unauthorizedContracts(pending: PlannedMigration[], allowContract: boolean): string[] {
  if (allowContract) return [];
  return pending.filter((p) => p.kind === 'contract').map((p) => p.version);
}
