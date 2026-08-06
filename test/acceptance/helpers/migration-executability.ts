/**
 * 迁移可执行性的静态判据（change restore-derived-migration-executability 任务 6.1–6.3）。
 *
 * ## 这个扫描器 MUST NOT 参与归属判定
 *
 * 它扫 SQL 文本拿「这条迁移碰了哪些表」，而**归属判据明令禁止由 SQL 文本反推表名**
 * （见 `src/schema/migration-owners.ts` 文件头：那会造出第二套口径）。两者能共存只因为
 * 这里的产物**只有否决权**：
 *
 *   - 它可以说「这条迁移在属主 O 的库里跑不通」；
 *   - 它**永远不能**说「所以这条迁移属于属主 P」。
 *
 * 本文件 MUST NOT 导出任何返回属主的函数，调用方 MUST NOT 把 `tableRefs` 喂给归属解析。
 * 不写死这句话，它迟早被当成第二套归属口径 —— 那正是判据要消灭的东西。
 *
 * ## 判据
 *
 *   对每个属主 O、每条**执行范围含 O** 的迁移 M：M 引用的每张表，都必须由某条
 *   **执行范围也含 O** 的迁移创建。
 *
 * 不满足即失败并指名「迁移 / 属主 / 缺失的表」。`0000_baseline` 那种自己建自己用的跨属主迁移
 * 因此无害（它建了它碰的每一张表）；只建索引不建表的 `0030_panel_hardening_indexes` 因此致命。
 *
 * ## 口径复用，不写第三份
 *
 * 写操作（INSERT / UPDATE / DELETE / CREATE TABLE / ALTER TABLE）与读引用（FROM / JOIN）
 * 一律走 `sql-scan.ts` 的 `scanSqlSource`——2026-08-06 cutover 前它逐字同源于边界门禁的
 * `boundary-scan.ts`；单体门禁退役后那份扫描器随之删除（唯一实现活在 aidcp-automation），
 * `sql-scan.ts` 是从它逐字析出的存活子集，「与边界门禁逐字同源」的约束随门禁一并失效。
 * 本文件只补**迁移文件里独有、而 src/ 里几乎不出现**的那几种引用形态（下面 `MIGRATION_REF_PATTERNS`
 * 逐条列出理由）—— 少了它们这道闸会漏掉本 change 要抓的那一类：`CREATE INDEX … ON <表>`
 * 正是 `0030` 的全部内容，而 `scanSqlSource` 的写模式里没有 create_index。
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';

import { REPO_ROOT, scanSqlSource } from './sql-scan.js';

/**
 * 迁移独有的表引用形态。每条都锚定到完整语法，且都是**在库里那张表不存在时会当场报错**的形态
 * —— 判据只关心这一类，`ALTER TABLE IF EXISTS` 一类缺表即 no-op 的写法不在其列（见 `GUARDED`）。
 */
const MIGRATION_REF_PATTERNS: { why: string; re: RegExp }[] = [
  {
    why: 'CREATE INDEX … ON <表>：0030 的全部内容就是三条这个；scanSqlSource 的写模式不含 create_index',
    re: /\bCREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:CONCURRENTLY\s+)?(?:IF\s+NOT\s+EXISTS\s+)?[a-zA-Z_]\w*\s+ON\s+(?:ONLY\s+)?(?:public\.)?([a-zA-Z_]\w*)/gi,
  },
  {
    why: 'LOCK TABLE <表>：0040 用它把回填与约束收成一个原子边界，表不存在即报错',
    re: /\bLOCK\s+(?:TABLE\s+)?(?:ONLY\s+)?(?:public\.)?([a-zA-Z_]\w*)/gi,
  },
  {
    why: 'REFERENCES <表>：外键的目标表必须已存在（0057 的 record_id 指向 publish_log）',
    re: /\bREFERENCES\s+(?:public\.)?([a-zA-Z_]\w*)/gi,
  },
  {
    why: 'TRUNCATE <表>',
    re: /\bTRUNCATE\s+(?:TABLE\s+)?(?:ONLY\s+)?(?:public\.)?([a-zA-Z_]\w*)/gi,
  },
  {
    why: "'<表>'::regclass：0039 在 DO 块里靠它查约束，表不存在时 regclass 转换直接抛错",
    re: /'([a-zA-Z_]\w*)'::regclass/gi,
  },
  {
    why: "to_regclass('<对象>')：同上，但它对不存在的对象返回 NULL —— 仍登记为引用，判据宁可误报",
    re: /to_regclass\(\s*'([a-zA-Z_]\w*)'\s*\)/gi,
  },
  {
    why: 'GRANT / REVOKE … ON TABLE a, b, c：0050 一次授权三张表',
    re: /\bON\s+TABLE\s+((?:[a-zA-Z_]\w*\s*,\s*)*[a-zA-Z_]\w*)/gi,
  },
  {
    why: 'COMMENT ON TABLE / COLUMN <表>[.列]',
    re: /\bCOMMENT\s+ON\s+(?:TABLE|COLUMN)\s+(?:public\.)?([a-zA-Z_]\w*)/gi,
  },
];

/** 建表形态：判据里「谁创建了这张表」的唯一来源。 */
const CREATE_TABLE = /\bCREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:public\.)?([a-zA-Z_]\w*)/gi;

/**
 * 缺表即 no-op 的守卫形态：`ALTER TABLE IF EXISTS <表>` / `DROP … IF EXISTS <表>`。
 * 这类语句在没有那张表的库里不会报错，因此**不构成**可执行性问题，MUST 从引用集合里剔掉——
 * 否则闸会对着一批本来就安全的语句报红，逼人把它关掉。
 */
const GUARDED = [
  /\bALTER\s+TABLE\s+IF\s+EXISTS\s+(?:ONLY\s+)?(?:public\.)?([a-zA-Z_]\w*)/gi,
  /\bDROP\s+TABLE\s+IF\s+EXISTS\s+(?:ONLY\s+)?(?:public\.)?([a-zA-Z_]\w*)/gi,
];

/** 语句首词白名单。不在其中 = 本扫描器没有对应的引用提取规则 ⇒ MUST 失败并指名，MUST NOT 静默跳过。 */
const KNOWN_VERBS = new Set([
  'ALTER', 'ANALYZE', 'BEGIN', 'CALL', 'COMMENT', 'COMMIT', 'CREATE', 'DELETE', 'DO', 'DROP',
  'END', 'GRANT', 'INSERT', 'LOCK', 'REFRESH', 'REVOKE', 'ROLLBACK', 'SELECT', 'SET', 'TRUNCATE',
  'UPDATE', 'VACUUM', 'WITH',
]);

/** 剥注释（保持字节数不变，位置不漂）。 */
function stripSqlComments(sql: string): string {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .split('\n')
    .map((line) => {
      const cut = line.indexOf('--');
      return cut < 0 ? line : line.slice(0, cut);
    })
    .join('\n');
}

/**
 * 按分号切语句，识别 dollar-quote（`$$ … $$` / `$tag$ … $tag$`）与单引号字符串。
 * 不识别 dollar-quote 的话，`DO $$ … $$` 里的每个分号都会把一个块切成一堆碎片，
 * 碎片的首词五花八门，闸会当场对着自己的解析残渣报「解析不了」。
 */
export function splitSqlStatements(sql: string): string[] {
  const out: string[] = [];
  let current = '';
  let i = 0;
  let dollarTag: string | null = null;
  let inString = false;
  while (i < sql.length) {
    const ch = sql[i];
    if (dollarTag) {
      if (sql.startsWith(dollarTag, i)) {
        current += dollarTag;
        i += dollarTag.length;
        dollarTag = null;
        continue;
      }
    } else if (inString) {
      if (ch === "'") inString = false;
    } else if (ch === "'") {
      inString = true;
    } else {
      const dollar = /^\$[a-zA-Z_]*\$/.exec(sql.slice(i));
      if (dollar) {
        dollarTag = dollar[0];
        current += dollarTag;
        i += dollarTag.length;
        continue;
      }
      if (ch === ';') {
        if (current.trim()) out.push(current.trim());
        current = '';
        i += 1;
        continue;
      }
    }
    current += ch;
    i += 1;
  }
  if (current.trim()) out.push(current.trim());
  return out;
}

export interface MigrationScan {
  version: string;
  /** 引用到的已登记表（字典序）。**只有否决权，MUST NOT 用来定属主** */
  refs: string[];
  /** 本迁移创建的表（字典序） */
  creates: string[];
  /** 首词不在白名单里的语句摘要 —— 非空即判失败 */
  unparsed: string[];
}

/**
 * 扫一条迁移的表引用。
 *
 * `knownTables` = `boundaries/table-ownership.json` 的登记表全集。命中但未登记的标识符一律丢弃：
 * 读模式会顺带命中 CTE 名、子查询别名、`pg_catalog` 系统表、集合返回函数（口径与 boundary-scan
 * 的 `crossOwnerReads` 一致）。方向是**宁可漏判**：漏判的后果是「闸没抓住」（退回今天的状态），
 * 而误报的后果是逼人关掉这道闸。真正的兜底是空库实跑。
 */
export function scanMigration(version: string, sql: string, knownTables: ReadonlySet<string>): MigrationScan {
  const text = stripSqlComments(sql);
  const refs = new Set<string>();
  const creates = new Set<string>();

  // ① 写操作与读引用：逐字复用边界门禁那份扫描器。
  const base = scanSqlSource(version, text);
  for (const w of base.writes) {
    if (knownTables.has(w.table)) refs.add(w.table);
    if (w.op === 'create_table' && knownTables.has(w.table)) creates.add(w.table);
  }
  for (const r of base.reads) if (knownTables.has(r.table)) refs.add(r.table);

  // ② 迁移独有的引用形态。
  for (const { re } of MIGRATION_REF_PATTERNS) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      for (const token of m[1].split(',')) {
        const table = token.trim();
        if (knownTables.has(table)) refs.add(table);
      }
    }
  }

  // ③ 建表口径独立再扫一遍：base.writes 已去重到 (op, table)，这里要的是同一张表的建表事实。
  CREATE_TABLE.lastIndex = 0;
  let c: RegExpExecArray | null;
  while ((c = CREATE_TABLE.exec(text)) !== null) if (knownTables.has(c[1])) creates.add(c[1]);

  // ④ 缺表即 no-op 的守卫形态不算引用。
  for (const re of GUARDED) {
    re.lastIndex = 0;
    let g: RegExpExecArray | null;
    while ((g = re.exec(text)) !== null) if (!creates.has(g[1])) refs.delete(g[1]);
  }

  const unparsed: string[] = [];
  for (const statement of splitSqlStatements(text)) {
    const verb = /^[a-zA-Z]+/.exec(statement)?.[0]?.toUpperCase();
    if (!verb || !KNOWN_VERBS.has(verb)) {
      unparsed.push(`${version}: ${statement.replace(/\s+/g, ' ').slice(0, 80)}`);
    }
  }

  return { version, refs: [...refs].sort(), creates: [...creates].sort(), unparsed };
}

export interface ExecutabilityInput {
  version: string;
  sql: string;
  /** 执行范围（由 src/schema/migration-owners.ts 给出；本文件 MUST NOT 自己算） */
  executionOwners: readonly string[];
}

export interface ExecutabilityViolation {
  owner: string;
  version: string;
  /** 该库里没有任何执行范围内的迁移会创建的表 */
  missingTables: string[];
}

export interface ExecutabilityReport {
  violations: ExecutabilityViolation[];
  /** 首词不认识的语句 —— 非空即判失败 */
  unparsed: string[];
}

/** 判据本体。纯函数：不读文件、不连库，注入验证直接换输入即可。 */
export function auditExecutability(
  migrations: readonly ExecutabilityInput[],
  knownTables: ReadonlySet<string>,
  owners: readonly string[],
): ExecutabilityReport {
  const scans = new Map<string, MigrationScan>();
  const unparsed: string[] = [];
  for (const m of migrations) {
    const scan = scanMigration(m.version, m.sql, knownTables);
    scans.set(m.version, scan);
    unparsed.push(...scan.unparsed);
  }

  const violations: ExecutabilityViolation[] = [];
  for (const owner of owners) {
    const inScope = migrations.filter((m) => m.executionOwners.includes(owner));
    const createdHere = new Set<string>();
    for (const m of inScope) for (const t of scans.get(m.version)?.creates ?? []) createdHere.add(t);
    for (const m of inScope) {
      const missing = (scans.get(m.version)?.refs ?? []).filter((t) => !createdHere.has(t));
      if (missing.length > 0) violations.push({ owner, version: m.version, missingTables: missing });
    }
  }
  violations.sort((a, b) => (a.owner === b.owner ? a.version.localeCompare(b.version) : a.owner.localeCompare(b.owner)));
  return { violations, unparsed };
}

export function violationKey(v: { owner: string; version: string }): string {
  return `${v.owner} ${v.version}`;
}

/* ------------------------------------------------------------------ 存量欠账清单 */

export const EXECUTABILITY_DEBT_PATH = 'boundaries/migration-executability-debt.json';

export interface ExecutabilityDebtEntry {
  owner: string;
  version: string;
  missingTables: string[];
  basis: string;
  eliminatedBy: string | null;
}

export interface ExecutabilityDebt {
  sealedCount: number;
  entries: ExecutabilityDebtEntry[];
}

export function readExecutabilityDebt(root = REPO_ROOT): ExecutabilityDebt {
  return JSON.parse(readFileSync(path.join(root, EXECUTABILITY_DEBT_PATH), 'utf8')) as ExecutabilityDebt;
}
