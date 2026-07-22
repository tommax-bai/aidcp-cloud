/**
 * 边界扫描器 —— `AC-BOUND-*`（导入方向）与 `AC-OWN-*`（表写入与建表归属）两族门禁的共用输入。
 *
 * 设计约束（来自控制仓定稿 docs/cloud-service-decomposition-proposal.md §12「两族门禁」）：
 *   - 零新依赖：只用 node:fs / node:path，MUST NOT 引入 eslint / madge / dependency-cruiser 一类工具链；
 *   - 诚实红线：任何解析不了的输入 MUST 报错并列出，MUST NOT 静默跳过、MUST NOT 按通过处理；
 *   - 一次扫描两处复用：两个门禁用例共享同一份缓存结果，避免读盘两遍。
 *
 * 归属判据不在本文件内自立：文件→层的映射一律取自 boundaries/module-ownership.json，
 * 而该文件由 boundaries/ownership-rules.json 机械展开，规则本身逐行抄自定稿 §4.7「归属总表」。
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = path.resolve(fileURLToPath(new URL('../../../', import.meta.url)));

export const LAYERS = ['kernel', 'api', 'content', 'automation', 'composition'] as const;
export type Layer = (typeof LAYERS)[number];

export function isLayer(value: unknown): value is Layer {
  return typeof value === 'string' && (LAYERS as readonly string[]).includes(value);
}

export function repoPath(...parts: string[]): string {
  return path.join(REPO_ROOT, ...parts);
}

export function readJson<T>(relative: string): T {
  return JSON.parse(readFileSync(repoPath(relative), 'utf8')) as T;
}

/* ------------------------------------------------------------------ 源文件清单 */

/** 递归列出 `src/**\/*.ts`，返回仓根相对的 posix 路径，字典序。 */
export function listSourceFiles(root = 'src'): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(repoPath(dir)).sort()) {
      const rel = `${dir}/${name}`;
      if (statSync(repoPath(rel)).isDirectory()) walk(rel);
      else if (name.endsWith('.ts')) out.push(rel);
    }
  };
  walk(root);
  return out.sort();
}

/* ------------------------------------------------------------------ 注释剥离 */

/**
 * 剥 TypeScript 注释。行注释的 `//` 前紧邻 `:` 时不剥（避免把 `https://…` 之后的整行吃掉）。
 */
export function stripTsComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/gm, '$1');
}

/**
 * 剥 SQL 行注释。**显式规则**：只有「行首或空白 + `--` + 空白或行尾」才算 SQL 注释，
 * 因此 TypeScript 的自减运算符（`i--`、`--i`）不会被误剥。
 */
export function stripSqlLineComments(source: string): string {
  return source.replace(/(^|\s)--(\s[^\n]*|$)/gm, '$1');
}

/* ------------------------------------------------------------------ import 解析 */

export interface ImportEdge {
  from: string;
  to: string;
}

export interface ImportScanResult {
  edges: ImportEdge[];
  /** 相对说明符解析不到实文件 —— MUST 判失败，MUST NOT 跳过。 */
  unresolved: { file: string; specifier: string }[];
}

const SPECIFIER_PATTERNS: RegExp[] = [
  /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g, // 动态 import() 与内联 import('...').Type
  /\bfrom\s*['"]([^'"]+)['"]/g, // import ... from / export ... from
  /\bimport\s+['"]([^'"]+)['"]/g, // 纯副作用 import
  /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g, // 兜底：CommonJS 形态
];

/** 抽出一个源文件里的全部说明符（已剥注释）。 */
export function extractSpecifiers(source: string): string[] {
  const stripped = stripTsComments(source);
  const found = new Set<string>();
  for (const pattern of SPECIFIER_PATTERNS) {
    pattern.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = pattern.exec(stripped)) !== null) found.add(m[1]);
  }
  return [...found].sort();
}

/**
 * 把相对说明符解析到实际源文件（仓根相对路径）。非相对说明符返回 `'external'`。
 * 解析不到返回 `null` —— 调用方 MUST 据此失败。
 */
export function resolveSpecifier(fromFile: string, specifier: string): string | null | 'external' {
  if (!specifier.startsWith('.')) return 'external';
  const base = path.posix.join(path.posix.dirname(fromFile), specifier);
  const candidates = [
    base.replace(/\.js$/, '.ts'),
    `${base}.ts`,
    `${base}/index.ts`,
    `${base.replace(/\.js$/, '')}/index.ts`,
  ];
  for (const candidate of candidates) {
    if (candidate.endsWith('.ts') && existsSync(repoPath(candidate))) return candidate;
  }
  return null;
}

export function scanImports(files: string[]): ImportScanResult {
  const edges: ImportEdge[] = [];
  const unresolved: { file: string; specifier: string }[] = [];
  const seen = new Set<string>();
  for (const file of files) {
    const source = readFileSync(repoPath(file), 'utf8');
    for (const specifier of extractSpecifiers(source)) {
      const target = resolveSpecifier(file, specifier);
      if (target === 'external') continue;
      if (target === null) {
        unresolved.push({ file, specifier });
        continue;
      }
      if (target === file) continue;
      const key = `${file} ${target}`;
      if (seen.has(key)) continue;
      seen.add(key);
      edges.push({ from: file, to: target });
    }
  }
  edges.sort((a, b) => (a.from === b.from ? a.to.localeCompare(b.to) : a.from.localeCompare(b.from)));
  return { edges, unresolved };
}

/* ------------------------------------------------------------------ SQL 解析 */

export type SqlOp = 'insert' | 'update' | 'delete' | 'create_table' | 'alter_table';
export const DML_OPS: SqlOp[] = ['insert', 'update', 'delete'];
export const DDL_OPS: SqlOp[] = ['create_table', 'alter_table'];

export interface SqlWrite {
  file: string;
  table: string;
  op: SqlOp;
}

export interface DynamicSqlSite {
  file: string;
  op: SqlOp;
  excerpt: string;
}

export interface SqlScanResult {
  writes: SqlWrite[];
  /** 表名由模板插值拼出、静态判不了 —— 定稿 §12 要求 MUST 判失败，除非在解析登记表里具名。 */
  dynamic: DynamicSqlSite[];
}

/**
 * `UPDATE <表> [[AS] <别名>] SET` 的语法源串（唯一定义处）。
 *
 * **别名段 MUST 是可选的**：`UPDATE delegated_tasks t SET …` 这类带别名形态是本仓 UPDATE 的主流写法
 * （2026-07-23 实测 14 处 / 6 文件）。早期版本要求表名后紧跟 `SET`，对这一整类写入完全不可见——
 * 门禁报「无违规」实为「没看见」，违反红线「MUST NOT 静默假成功」。
 * 回归防线：`table-ownership.test.ts` 的「SQL 扫描器保真自检」。
 *
 * 假阳性仍靠**语法锚定**排除，不靠标识符跳过名单：
 *   - `ON CONFLICT … DO UPDATE SET`：`UPDATE` 后没有表标识符，且额外由 `(?<!\bDO\s{1,4})` 双保险；
 *   - `FOR UPDATE SKIP LOCKED` / `FOR UPDATE OF …`：后面没有 `SET`，且由 `(?<!\bFOR\s{1,4})` 双保险。
 */
export const UPDATE_TABLE_PATTERN_SOURCE =
  String.raw`(?<!\bDO\s{1,4})(?<!\bFOR\s{1,4})\bUPDATE\s+(?:ONLY\s+)?(?:public\.)?([a-zA-Z_][a-zA-Z0-9_]*)(?:\s+(?:AS\s+)?[a-zA-Z_][a-zA-Z0-9_]*)?\s+SET\b`;

/**
 * 写操作模式。每条都**锚定到完整语法形态**（而不是「命中关键字后再靠白名单过滤」）：
 *   - `UPDATE <t> [别名] SET` 必须带 `SET`（源串见上）；
 *   - `INSERT INTO` / `DELETE FROM` / `CREATE TABLE` / `ALTER TABLE` 各自带自己的固定引导词。
 * 这就是定稿 §12 要求的「显式排除规则」，与「不在白名单就跳过」相反：
 * 凡命中而表名未登记的，一律报错（见 AC-OWN-01）。
 */
const WRITE_PATTERNS: { op: SqlOp; re: RegExp }[] = [
  { op: 'insert', re: /\bINSERT\s+INTO\s+(?:ONLY\s+)?(?:public\.)?([a-zA-Z_][a-zA-Z0-9_]*)/gi },
  { op: 'update', re: new RegExp(UPDATE_TABLE_PATTERN_SOURCE, 'gi') },
  { op: 'delete', re: /\bDELETE\s+FROM\s+(?:ONLY\s+)?(?:public\.)?([a-zA-Z_][a-zA-Z0-9_]*)/gi },
  { op: 'create_table', re: /\bCREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:public\.)?([a-zA-Z_][a-zA-Z0-9_]*)/gi },
  { op: 'alter_table', re: /\bALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?(?:public\.)?([a-zA-Z_][a-zA-Z0-9_]*)/gi },
];

const DYNAMIC_PATTERNS: { op: SqlOp; re: RegExp }[] = [
  { op: 'insert', re: /\bINSERT\s+INTO\s+\$\{/gi },
  { op: 'update', re: /\bUPDATE\s+\$\{/gi },
  { op: 'delete', re: /\bDELETE\s+FROM\s+\$\{/gi },
  { op: 'create_table', re: /\bCREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?\$\{/gi },
  { op: 'alter_table', re: /\bALTER\s+TABLE\s+\$\{/gi },
];

export function scanSqlSource(file: string, rawSource: string): SqlScanResult {
  const source = stripSqlLineComments(stripTsComments(rawSource));
  const writes: SqlWrite[] = [];
  const dynamic: DynamicSqlSite[] = [];
  const seen = new Set<string>();
  for (const { op, re } of WRITE_PATTERNS) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(source)) !== null) {
      const key = `${op} ${m[1]}`;
      if (seen.has(key)) continue;
      seen.add(key);
      writes.push({ file, table: m[1], op });
    }
  }
  for (const { op, re } of DYNAMIC_PATTERNS) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(source)) !== null) {
      dynamic.push({ file, op, excerpt: source.slice(m.index, m.index + 40).replace(/\s+/g, ' ').trim() });
    }
  }
  writes.sort((a, b) => (a.table === b.table ? a.op.localeCompare(b.op) : a.table.localeCompare(b.table)));
  return { writes, dynamic };
}

export function scanSqlWrites(files: string[]): SqlScanResult {
  const writes: SqlWrite[] = [];
  const dynamic: DynamicSqlSite[] = [];
  for (const file of files) {
    const result = scanSqlSource(file, readFileSync(repoPath(file), 'utf8'));
    writes.push(...result.writes);
    dynamic.push(...result.dynamic);
  }
  writes.sort((a, b) =>
    a.table === b.table
      ? a.file === b.file
        ? a.op.localeCompare(b.op)
        : a.file.localeCompare(b.file)
      : a.table.localeCompare(b.table),
  );
  return { writes, dynamic };
}

/* ------------------------------------------------------------------ 动态 SQL 登记 */

export interface DynamicSqlResolution {
  file: string;
  op: SqlOp;
  tables: string[];
  evidence: string;
  reason: string;
}

export interface DynamicSqlAudit {
  /** 源码里有、登记表里没有 —— MUST 判失败（定稿 §12：动态拼接 MUST NOT 跳过）。 */
  unregistered: DynamicSqlSite[];
  /** 登记表里有、源码里已不存在 —— 同样 MUST 判失败，不留空位。 */
  stale: DynamicSqlResolution[];
  /** 登记表解析出来的写入点，并入静态写入集参与归属判定。 */
  resolvedWrites: SqlWrite[];
}

export function auditDynamicSql(sites: DynamicSqlSite[], resolutions: DynamicSqlResolution[]): DynamicSqlAudit {
  const key = (file: string, op: SqlOp): string => `${file} ${op}`;
  const registered = new Map(resolutions.map((r) => [key(r.file, r.op), r]));
  const seenInSource = new Set(sites.map((s) => key(s.file, s.op)));
  const unregistered = sites.filter((s) => !registered.has(key(s.file, s.op)));
  const stale = resolutions.filter((r) => !seenInSource.has(key(r.file, r.op)));
  const resolvedWrites: SqlWrite[] = [];
  for (const resolution of resolutions) {
    if (!seenInSource.has(key(resolution.file, resolution.op))) continue;
    for (const table of resolution.tables) resolvedWrites.push({ file: resolution.file, table, op: resolution.op });
  }
  return { unregistered, stale, resolvedWrites };
}

/** `migrations/*.sql` 里 `CREATE TABLE` 的表名集合（口径：先剥注释，再取 distinct 表名）。 */
export function listMigrationTables(): string[] {
  const dir = 'migrations';
  const tables = new Set<string>();
  for (const name of readdirSync(repoPath(dir)).sort()) {
    if (!name.endsWith('.sql')) continue;
    const source = stripSqlLineComments(readFileSync(repoPath(`${dir}/${name}`), 'utf8').replace(/\/\*[\s\S]*?\*\//g, ' '));
    const re = /\bCREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:public\.)?([a-zA-Z_][a-zA-Z0-9_]*)/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(source)) !== null) tables.add(m[1]);
  }
  return [...tables].sort();
}

/* ------------------------------------------------------------------ 归属表 */

export interface OwnershipEntry {
  path: string;
  layer: Layer;
  note: string;
}

/**
 * 目录规则对**新增文件**的处置。
 *
 *   - `inherit`：§4.7 里该目录整行只有一个归属层（如 `src/risk/` 19/19 automation），
 *     新增文件的归属已被 §4.7 判定，目录规则可以直接接住；
 *   - `adjudicate`：§4.7 里该目录被**逐文件切开**（如 `src/publish-agent/` 7 api / 54 content / 6 automation），
 *     §4.7 并没有判定「该目录下任意新文件属于哪一层」。此时让目录默认值接住新文件＝脚本替人裁决，
 *     正是红线「MUST NOT 静默假成功」。故这类目录的新增文件 MUST 先在 `fileOverrides` 里逐个裁定，
 *     生成器在裁定之前 **报错并列出待裁决清单**。
 *
 * 字段缺省时按 `adjudicate` 处理（fail-safe：宁可多问一次，也不替人判）。
 */
export type NewFileDisposition = 'inherit' | 'adjudicate';

export interface OwnershipRules {
  sourceOfTruth: string;
  baseline: Record<string, unknown>;
  /**
   * seed 窗口是否还开着。关掉之后 `--reseed` 一律拒绝（棘轮已开始计数，重新 seed = 把棘轮拆掉）。
   * 缺省按**已关闭**处理（fail-safe）。
   */
  seedWindow?: { open: boolean; whyOpen?: string; closeWhen?: string };
  compositionWhitelist: string[];
  directoryRules: { dir: string; layer: Layer; basis: string; newFile?: NewFileDisposition }[];
  fileOverrides: { path: string; layer: Layer; basis: string }[];
}

export const ADJUDICATED_FILES_PATH = 'boundaries/adjudicated-files.json';

/**
 * 「已裁决文件」名册 —— **人工文件，不是生成物**。
 *
 * 它登记 seed 当天就已存在于「逐文件切分目录」（`newFile: 'adjudicate'`）里的那批文件：
 * 这些文件的归属层在定稿 §4.7 的基线快照里已被人看过，故允许继续走目录默认值。
 *
 * 为什么必须是独立的人工文件：早期版本把生成物 `module-ownership.json` 自己回喂给展开器当「已裁决集」，
 * 于是「是否被裁决过」退化成「是否已经在生成物里」——手工往生成物塞一条新文件 + 目录默认层即可全绿，
 * 而 `refresh` 随后会把它永久洗白。准入依据 MUST 是人写的名册，生成物只作输出。
 *
 * 纪律：本名册 **MUST NOT 增长**。此后逐文件切分目录里的任何新文件 MUST 进
 * `ownership-rules.json` 的 `fileOverrides` 并写明 §4.7 判据；源文件删除时由 `refresh` 同步剔除。
 */
export interface AdjudicatedFiles {
  sourceOfTruth: string;
  rule: string;
  recordedAt: string;
  files: string[];
}

/** 读「已裁决文件」名册；缺文件即视为空名册（最严格口径：所有逐文件切分目录的文件都待裁决）。 */
export function readAdjudicatedFiles(): string[] {
  try {
    return readJson<AdjudicatedFiles>(ADJUDICATED_FILES_PATH).files;
  } catch {
    return [];
  }
}

/** 归属展开失败时抛出：`pending` 是待人工裁决的文件清单，MUST 原样报给调用者。 */
export class UnadjudicatedFilesError extends Error {
  constructor(readonly pending: { file: string; dir: string | null }[]) {
    super(
      `以下源文件的归属层尚未裁定，MUST 先在 boundaries/ownership-rules.json 的 fileOverrides 里逐个判定（判据引定稿 §4.7），再重跑生成器；` +
        `生成器 MUST NOT 替你塞一个默认层：\n  ${pending
          .map((p) => `${p.file}${p.dir ? `（${p.dir} 在 §4.7 是逐文件切分的目录）` : '（没有任何目录规则覆盖它）'}`)
          .join('\n  ')}`,
    );
    this.name = 'UnadjudicatedFilesError';
  }
}

/**
 * 把规则表机械展开到文件级清单。
 *
 * `adjudicated` 是**已裁定文件名册**（`boundaries/adjudicated-files.json` 的 `files`，人工维护）：
 * 逐文件切分目录（`newFile: 'adjudicate'`）里的**既有**文件靠它继续走目录默认值，
 * 而**新增**文件因不在名册内被判为待裁决、当场报错。
 *
 * **MUST NOT 把生成物 `module-ownership.json` 传进来当名册**：那会让「是否被裁决过」退化成
 * 「是否已经在生成物里」，手工往生成物塞一条即可洗白（见 `AdjudicatedFiles` 的注释）。
 * 不传即最严格口径。
 */
export function expandOwnership(
  rules: OwnershipRules,
  files: string[],
  adjudicated: readonly string[] = [],
): OwnershipEntry[] {
  const overrides = new Map(rules.fileOverrides.map((o) => [o.path, o]));
  const dirs = [...rules.directoryRules].sort((a, b) => b.dir.length - a.dir.length);
  const known = new Set(adjudicated);
  const entries: OwnershipEntry[] = [];
  const pending: { file: string; dir: string | null }[] = [];
  for (const file of files) {
    const override = overrides.get(file);
    if (override) {
      entries.push({ path: file, layer: override.layer, note: override.basis });
      continue;
    }
    const dir = dirs.find((d) => file.startsWith(d.dir));
    if (!dir) {
      pending.push({ file, dir: null });
      continue;
    }
    if ((dir.newFile ?? 'adjudicate') === 'adjudicate' && !known.has(file)) {
      pending.push({ file, dir: dir.dir });
      continue;
    }
    entries.push({ path: file, layer: dir.layer, note: dir.basis });
  }
  if (pending.length > 0) throw new UnadjudicatedFilesError(pending);
  return entries.sort((a, b) => a.path.localeCompare(b.path));
}

/* ------------------------------------------------------------------ 方向白名单 */

/**
 * 允许方向白名单**写在测试源码里，不进 JSON** —— 改它必须改这个文件、必须走代码评审
 * （定稿 §12 与本 change 任务 3.5）。
 *
 *   - 任何层 MAY → `kernel`；
 *   - `composition` MAY → 任何层；
 *   - 同层内部恒允许；
 *   - 任何层 MUST NOT → `composition`：组合根不可被反向导入，**无豁免通道**；
 *   - `kernel` MUST NOT → 其它任一层：内核层不得反向依赖业务层，**无豁免通道**；
 *   - 其余跨层方向：需要豁免清单里有对应条目。
 */
export type EdgeVerdict = 'allowed' | 'exemptable' | 'forbidden';

export function classifyEdge(from: Layer, to: Layer): EdgeVerdict {
  if (to === 'composition') return 'forbidden';
  if (from === 'kernel') return to === 'kernel' ? 'allowed' : 'forbidden';
  if (to === 'kernel') return 'allowed';
  if (from === 'composition') return 'allowed';
  if (from === to) return 'allowed';
  return 'exemptable';
}

/* ------------------------------------------------------------------ 豁免清单 */

export interface ExemptionRaise {
  amount: number;
  approvedByChange: string;
  eliminateBy: string;
}

export interface ImportExemption {
  from: string;
  to: string;
  reason: string;
  eliminatedBy: string | null;
  note?: string;
}

/**
 * 跨层表写入的豁免条目 —— **一条条目 = 一个 `{表, 文件, 操作}` 三元组**。
 *
 * 早期版本把同一个 `(表, 文件)` 对上的多个操作压成一个 `ops: SqlOp[]` 字段，于是棘轮的键少了「操作」
 * 这一维：已豁免的对上新增一个操作（含 `ALTER TABLE` / `CREATE TABLE`）时条目数不变，`refresh` 会
 * 自己把 `ops` 拓宽写回文件并退出 0，`AC-OWN-02` / `AC-OWN-03` 随后全绿——正是红线「MUST NOT 静默假成功」。
 * 现在把操作放进键里：新增操作 = 新增条目 = 棘轮当场拒绝。
 * 回归防线：`table-ownership.test.ts` 的「棘轮键保真自检」。
 */
export interface TableWriteExemption {
  table: string;
  file: string;
  op: SqlOp;
  reason: string;
  eliminatedBy: string | null;
  note?: string;
}

export interface ExemptionList<T> {
  /** seed 当天的条目数，**不可变**：棘轮的上界基准，任何高于它的 frozenTotal MUST 由 raises[] 覆盖。 */
  seedTotal: number;
  /** seed 当天 `eliminatedBy === null` 的条目数，**不可变**：该数只减不增。 */
  seedUnplanned: number;
  frozenTotal: number;
  recordedAt: string;
  raises: ExemptionRaise[];
  entries: T[];
  /**
   * seed 基线**为什么是这个数**的唯一在仓记录（`--seed-note=` 写入）。
   *
   * MUST 正式声明在这里：早期版本靠 `as` 强转写入、类型上不存在，棘轮重建清单对象时漏搬了它，
   * 于是最常跑的那条默认路径会静默把它删掉——typecheck 抓不到、也没有任何断言看它。
   * 现在两条路径都靠 `{ ...list }` 展开保留，并由两族门禁各一条断言要求它非空。
   */
  seedBasis?: string;
}

/* ------------------------------------------------------------------ 棘轮对账（纯函数） */

/** 棘轮放行标志。`reseed` 只在 seed 窗口内合法，`raises` 是定稿 §12「例外通道（唯一）」。 */
export interface RatchetFlags {
  reseed: boolean;
  raises: ExemptionRaise[];
  /** `--seed-note=` 的内容；reseed 时 MUST 非空，写进 `seedBasis`。 */
  seedNote?: string | null;
}

export interface Reconciled<T> {
  list: ExemptionList<T>;
  added: T[];
  removed: T[];
}

export interface ReconcileInput<T> {
  /** 仅用于错误消息里指名是哪份清单。 */
  relative: string;
  list: ExemptionList<T>;
  current: T[];
  keyOf: (item: T) => string;
  describe: (item: T) => string;
  merge: (fresh: T, prior: T | undefined) => T;
}

/** 棘轮拒绝：出现清单里没有的新违规且没有足量 `--raise=` 兜住。 */
export class RatchetViolationError extends Error {
  constructor(
    readonly relative: string,
    readonly added: string[],
    readonly shortfall: number,
  ) {
    super(
      `${relative}：出现 ${added.length} 条清单里没有的新违规，棘轮不允许静默追加（定稿 §12：seed 之后发现的既存违规 MUST 当场修复）。\n` +
        `${added.map((a) => `  + ${a}`).join('\n')}\n` +
        `处置只有三条，按优先级：\n` +
        `  1) 先查归属是否填错——多数「新违规」其实是新文件的归属层没按 §4.7 判对；\n` +
        `  2) 修掉这条跨边界依赖 / 跨层写入；\n` +
        `  3) 确需冻结时走定稿 §12「例外通道（唯一）」：--raise=<控制仓 change 名>:<数量>:<YYYY-MM-DD>` +
        `（当前还差 ${shortfall} 条批准额度），并逐条补 reason 与消除动作。\n` +
        `  （门禁 change 尚未归档、棘轮尚未开始计数时，另有 --reseed 一条 seed 窗口内的通道。）`,
    );
    this.name = 'RatchetViolationError';
  }
}

/**
 * 把一份豁免清单对到当天实测的违规集合上（**纯函数**，不读写磁盘，故可被门禁用例直接机械回归）。
 *
 *   - 违规消失 → 删条目、`frozenTotal` 同步下调（棘轮下调，恒允许）；
 *   - 出现新违规 → 默认判失败；只有 `reseed` 或足量 `raises` 才放行；
 *   - 人工写过的 `reason` / `eliminatedBy` / `note` 由调用方的 `merge` 保留；
 *   - **两条返回路径都用 `{ ...list }` 展开**，`seedBasis` 一类头部字段 MUST NOT 在重建时丢失。
 *
 * 「新违规」的判据完全由 `keyOf` 决定：键少一维 = 该维度上的新增静默通过。表侧的键 MUST 是
 * `{表, 文件, 操作}` 三元组（见 `TableWriteExemption` 的注释）。
 */
export function reconcileExemptions<T extends { reason: string; eliminatedBy: string | null; note?: string }>(
  input: ReconcileInput<T>,
  flags: RatchetFlags,
): Reconciled<T> {
  const { relative, list, current, keyOf, describe, merge } = input;
  const priorByKey = new Map(list.entries.map((e) => [keyOf(e), e]));
  const currentKeys = new Set(current.map(keyOf));
  const removed = list.entries.filter((e) => !currentKeys.has(keyOf(e)));
  const added = current.filter((c) => !priorByKey.has(keyOf(c)));
  const entries = current
    .map((fresh) => merge(fresh, priorByKey.get(keyOf(fresh))))
    .sort((a, b) => describe(a).localeCompare(describe(b)));
  const today = new Date().toISOString().slice(0, 10);

  if (flags.reseed) {
    if (!flags.seedNote || flags.seedNote.trim() === '') {
      throw new Error(`${relative}：--reseed MUST 同时给 --seed-note=<为什么重新 seed>，它是 seed 基线的唯一在仓记录。`);
    }
    if (list.raises.length > 0) {
      throw new Error(
        `${relative}：清单里已有 ${list.raises.length} 条已批准上调（raises[]），--reseed 会把它们连同消除时限一起清空。\n` +
          'MUST 先人工处置这些 raises（消除对应违规后删条目，或在 seedBasis 里写清它们的去向）再重新 seed。',
      );
    }
    return {
      list: {
        ...list,
        seedTotal: entries.length,
        seedUnplanned: entries.filter((e) => e.eliminatedBy === null).length,
        frozenTotal: entries.length,
        recordedAt: today,
        raises: [],
        entries,
        seedBasis: flags.seedNote,
      },
      added,
      removed,
    };
  }

  // 棘轮模式：先按消失的条目下调，再看新增是否有合规的上调通道兜住。
  const loweredFrozen = list.frozenTotal - removed.length;
  const needed = Math.max(0, entries.length - loweredFrozen);
  const approved = flags.raises.reduce((sum, r) => sum + r.amount, 0);
  if (needed > 0 && approved < needed) {
    throw new RatchetViolationError(relative, added.map(describe), needed - approved);
  }
  return {
    list: {
      ...list,
      frozenTotal: Math.max(loweredFrozen, entries.length),
      recordedAt: today,
      raises: [...list.raises, ...flags.raises],
      entries,
    },
    added,
    removed,
  };
}

/* ------------------------------------------------------------------ 缓存 */

export interface TableOwnershipFile {
  sourceOfTruth: string;
  howToRegenerate: string;
  tables: { table: string; owner: Layer; basis: string }[];
}

export interface ExceptionTablesFile {
  sourceOfTruth: string;
  rule: string;
  tables: { table: string; owner: null; form: string; whyNoEliminationDeadline: string; staticallyUncheckable: string }[];
}

export interface BoundarySnapshot {
  files: string[];
  ownership: Map<string, Layer>;
  ownershipEntries: OwnershipEntry[];
  imports: ImportScanResult;
  sql: SqlScanResult;
  dynamic: DynamicSqlAudit;
  /** 静态写入 + 动态登记解析出的写入，去重后按表排序。 */
  writes: SqlWrite[];
  migrationTables: string[];
  tableOwners: Map<string, Layer>;
  exceptionTables: Set<string>;
}

let cached: BoundarySnapshot | null = null;

/** 两个门禁用例共享同一次扫描（定稿要求门禁 MUST NOT 拖慢 test:acceptance）。 */
export function boundarySnapshot(): BoundarySnapshot {
  if (cached) return cached;
  const files = listSourceFiles();
  const ownershipEntries = readJson<OwnershipEntry[]>('boundaries/module-ownership.json');
  const ownership = new Map<string, Layer>(ownershipEntries.map((e) => [e.path, e.layer]));
  const sql = scanSqlWrites(files);
  const dynamic = auditDynamicSql(
    sql.dynamic,
    readJson<{ sites: DynamicSqlResolution[] }>('boundaries/dynamic-sql-resolutions.json').sites,
  );
  const merged = new Map<string, SqlWrite>();
  for (const write of [...sql.writes, ...dynamic.resolvedWrites]) {
    merged.set(`${write.table} ${write.file} ${write.op}`, write);
  }
  const owners = readJson<TableOwnershipFile>('boundaries/table-ownership.json');
  const exceptions = readJson<ExceptionTablesFile>('boundaries/exception-tables.json');
  cached = {
    files,
    ownership,
    ownershipEntries,
    imports: scanImports(files),
    sql,
    dynamic,
    writes: [...merged.values()].sort((a, b) =>
      a.table === b.table
        ? a.file === b.file
          ? a.op.localeCompare(b.op)
          : a.file.localeCompare(b.file)
        : a.table.localeCompare(b.table),
    ),
    migrationTables: listMigrationTables(),
    tableOwners: new Map(owners.tables.map((t) => [t.table, t.owner])),
    exceptionTables: new Set(exceptions.tables.map((t) => t.table)),
  };
  return cached;
}
