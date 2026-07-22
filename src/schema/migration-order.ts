/**
 * 迁移目录的**顺序可执行性**（change cloud-schema-migration-executor 任务 3.1 的补课）。
 *
 * 「迁移目录是完整事实源」有两个条件，缺一不可：
 *   ① 对象抄全了 —— 由 `test/schema/ddl-parity.test.ts` 守（集合比对，对顺序完全无感）；
 *   ② **按执行器自己的复合序，从空库跑得完** —— 就是本文件守的这条。
 *
 * 只守 ① 的后果是实测过的：补齐迁移（accounts / concepts / client_users 那批）编号排在
 * 「后续 ALTER 这些表」的历史迁移之后，空库上 `migrate up` 在第 5 条 `0005_account_id_columns`
 * 就整批停住（relation "concepts" does not exist），而 ① 的用例永远是绿的。
 * 「迁移目录是事实源」这句话于是只在旧库上成立——旧库的表早被存储自建好了，走的是 baseline 记账而非 up。
 *
 * 判定是**静态**的：按复合序模拟，维护「到此刻为止已被建出的表」，任何一条语句引用了还没建出来的表
 * 即为顺序缺陷。静态判定比真库跑一遍弱，但它零依赖、随每次 `npm test` 跑，
 * 而真库空跑属真机验收项（backlog 110.6）。
 */

import { stripComments } from './ddl-scan.js';
import { versionOf, type MigrationFile } from './migration-plan.js';

/** PG 内置目录 / 明显不是业务表的名字，引用它们不需要任何迁移先建。 */
function isSystemObject(name: string): boolean {
  return name.startsWith('pg_') || name.startsWith('information_schema');
}

interface Event {
  at: number;
  kind: 'create' | 'require';
  table: string;
}

const CREATE_TABLE = /\bCREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([a-zA-Z_][\w]*)/gi;
const RENAME_TABLE = /\bALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?[a-zA-Z_][\w]*\s+RENAME\s+TO\s+([a-zA-Z_][\w]*)/gi;

/**
 * 「要求这张表已经存在」的语句形态。刻意**不**收 `FROM` / `JOIN`：
 * 它们在 CTE、子查询与 `pg_catalog` 查询里出现得太杂，收进来会制造假阳性，
 * 而假阳性最后一定被人用豁免清单绕过去，闸门也就废了。下面这几类足以覆盖真实的顺序缺陷。
 */
const REQUIRE_PATTERNS: RegExp[] = [
  /\bALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?([a-zA-Z_][\w]*)/gi,
  /\bCREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:CONCURRENTLY\s+)?(?:IF\s+NOT\s+EXISTS\s+)?[a-zA-Z_][\w]*\s+ON\s+([a-zA-Z_][\w]*)/gi,
  /\bREFERENCES\s+([a-zA-Z_][\w]*)\s*\(/gi,
  /\bINSERT\s+INTO\s+([a-zA-Z_][\w]*)/gi,
  /\bDELETE\s+FROM\s+([a-zA-Z_][\w]*)/gi,
  /\bUPDATE\s+([a-zA-Z_][\w]*)\s+SET\b/gi,
  /'([a-zA-Z_][\w]*)'::regclass/gi,
];

export interface OrderDefect {
  /** 出问题的迁移版本 id */
  version: string;
  /** 它引用了、但此刻还没有任何迁移建出来的表 */
  table: string;
}

/**
 * 按复合序检查顺序可执行性。输入 MUST 已按复合序排好（`loadMigrationFiles()` 就是这个顺序）。
 * 返回空数组代表：每一条语句引用的表，都由**排在它之前**（或同文件更靠前）的语句建出来了。
 */
export function findOrderDefects(orderedFiles: MigrationFile[]): OrderDefect[] {
  const created = new Set<string>();
  const defects: OrderDefect[] = [];
  const reported = new Set<string>();

  for (const file of orderedFiles) {
    const version = versionOf(file.name);
    const sql = stripComments(file.content);
    const events: Event[] = [];

    for (const re of [CREATE_TABLE, RENAME_TABLE]) {
      re.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = re.exec(sql)) !== null) events.push({ at: m.index, kind: 'create', table: m[1].toLowerCase() });
    }
    for (const re of REQUIRE_PATTERNS) {
      re.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = re.exec(sql)) !== null) events.push({ at: m.index, kind: 'require', table: m[1].toLowerCase() });
    }
    // 同一位置上 create 先于 require：建表语句体内 `REFERENCES` 自己那张表是合法的。
    // （本文件刻意不写出连着的 DDL 关键字字面量，否则会被 AC-SCHEMA-DDL-OWNER 的文本命中数当成运行时建表点。）
    events.sort((a, b) => a.at - b.at || (a.kind === b.kind ? 0 : a.kind === 'create' ? -1 : 1));

    for (const ev of events) {
      if (isSystemObject(ev.table)) continue;
      if (ev.kind === 'create') {
        created.add(ev.table);
        continue;
      }
      if (created.has(ev.table)) continue;
      const key = `${version}:${ev.table}`;
      if (reported.has(key)) continue;
      reported.add(key);
      defects.push({ version, table: ev.table });
    }
  }

  return defects;
}
