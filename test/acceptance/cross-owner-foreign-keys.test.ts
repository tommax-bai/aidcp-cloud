/**
 * AC-SPLIT-02 · `src/**\/*.ts` 的自建 DDL 里 MUST NOT 出现跨属主外键。
 *
 * 为什么这条必须机械化：
 *   本仓约 37 个存储在启动期用 `CREATE TABLE IF NOT EXISTS` 自建表（migrations/ 是另一套账本）。
 *   物理拆库后每个属主连自己的库，PostgreSQL **外键不能跨库** —— 一条 `REFERENCES accounts(account_id)`
 *   写在 content 属主的建表语句里，到了空的 aidcp_content 库就是「引用一张不存在的表」，
 *   CREATE TABLE **当场失败、整个域起不来**。共库期它完全看不出来（大家连的是同一个库、外键都能建上），
 *   所以这是典型的「今天全绿、翻转 owner URL 那一刻才炸」的形态，只能靠门禁提前拦。
 *
 * 属主判据：`boundaries/table-ownership.json`（唯一来源），经 scripts/db-split/generate-owner-table-lists.ts
 * 的导出函数读取 —— MUST NOT 在本文件里另立一套判据（目录位置、文件名都不是判据）。
 *
 * 本门禁的**已知盲区**（诚实登记，MUST NOT 当成「已覆盖」）：
 *   1. 只看 `src/**\/*.ts`。`migrations/*.sql` 是 append-only 账本，里面存量跨属主外键十余条，
 *      不在本门禁范围内；真库里已经建上的那些由运维脚本
 *      `scripts/db-split/0076_downgrade_cross_owner_account_fk.sql` 逐条 DROP。
 *      例：`interaction_reply_jobs.config_scope_id -> interaction_reply_config_scopes`
 *      只活在 migrations/0048，源码侧扫不到 —— 它被 0076 覆盖，不在下面的例外清单里。
 *   2. 只看**字面量** SQL。模板插值拼出的 `REFERENCES ${…}` 本仓当前没有；真出现时扫描器看不见。
 *   3. 门禁看的是「源码会建成什么样」，不是「现网真库现在有什么」。两者会因属主改判而分叉
 *      （实例：b46708b 把 interaction_reply_config_scopes 改判 api 之后，真库凭空多出一条跨属主外键）。
 *      真库那一侧的权威做法是只读实测 `pg_constraint`，见 0076 文件头。
 */
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { ownerTableListsFromOwnership } from '../../scripts/db-split/generate-owner-table-lists.js';
import { stripComments } from '../../src/schema/ddl-scan.js';
import { listSourceFiles, repoPath } from './helpers/boundary-scan.js';

/** `CREATE TABLE <t>` / `ALTER TABLE <t>` —— 一条 REFERENCES 的「源表」= 它前面最近的这么一条语句。 */
const DDL_STATEMENT =
  /\b(?:CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?|ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?)(?:public\.)?([a-zA-Z_][\w]*)/gi;
/** 单列与复合外键都要认（口径与 src/schema/db-scope-scan.ts 一致）。 */
const REFERENCES =
  /\bREFERENCES\s+(?:public\.)?([a-zA-Z_][\w]*)\s*\(\s*[a-zA-Z_][\w]*(?:\s*,\s*[a-zA-Z_][\w]*)*\s*\)/gi;

export interface ForeignKeyEdge {
  file: string;
  line: number;
  sourceTable: string;
  targetTable: string;
}

function lineOf(text: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < text.length; i += 1) if (text[i] === '\n') line += 1;
  return line;
}

/**
 * 抽出一个源文件里的全部外键边。**解析不出源表的 REFERENCES MUST 报出来**（`sourceTable: '?'`），
 * MUST NOT 静默丢弃 —— 丢一条就是门禁失明，而失明的表现恰恰是「全绿」。
 */
export function scanForeignKeyEdges(file: string, rawSource: string): ForeignKeyEdge[] {
  // 偏移保持型剥注释：注释里解释「这里故意不写 REFERENCES accounts(...)」的段落很多，
  // 不剥会把反例说明登记成真外键；用等量空白替换才能保住行号。
  const text = stripComments(rawSource);

  const statements: { index: number; table: string }[] = [];
  DDL_STATEMENT.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = DDL_STATEMENT.exec(text)) !== null) statements.push({ index: m.index, table: m[1].toLowerCase() });

  const edges: ForeignKeyEdge[] = [];
  REFERENCES.lastIndex = 0;
  while ((m = REFERENCES.exec(text)) !== null) {
    let sourceTable = '?';
    for (const stmt of statements) {
      if (stmt.index > m.index) break;
      sourceTable = stmt.table;
    }
    edges.push({ file, line: lineOf(text, m.index), sourceTable, targetTable: m[1].toLowerCase() });
  }
  return edges;
}

function ownerOf(): (table: string) => string | undefined {
  const lists = ownerTableListsFromOwnership(readFileSync(repoPath('boundaries/table-ownership.json'), 'utf8'));
  const byTable = new Map<string, string>();
  for (const [owner, tables] of Object.entries(lists)) for (const t of tables) byTable.set(t, owner);
  return (table: string) => byTable.get(table);
}

/**
 * 已知例外清单 —— **写在测试源码里、不进 JSON**：改它必须改这个文件、必须过代码评审
 * （与 boundary-scan.ts 的方向白名单同一条纪律）。
 *
 * 每条 MUST 写清「去向」：谁在降、降完谁来把这条删掉。清单只减不增；新加一条 = 新欠一笔债。
 */
const KNOWN_CROSS_OWNER_EXCEPTIONS: { key: string; reason: string }[] = [
  {
    key: 'src/comment-agent/facebook-group-store.ts facebook_group_membership -> accounts',
    reason:
      'automation → api。由并发进行的 automation 侧同批降级处理（本 change 只降 content 侧）；'
      + '真库里那条约束已在 scripts/db-split/0076 的段 A 覆盖。automation 侧源码降级落地后 MUST 删本条。',
  },
  {
    key: 'src/delegated-task/store.ts delegated_tasks -> accounts',
    reason:
      'automation → api。同上，由 automation 侧同批降级处理；真库那条在 0076 段 B 覆盖。'
      + 'automation 侧源码降级落地后 MUST 删本条。',
  },
];

const files = listSourceFiles();
const edges = files.flatMap((file) => scanForeignKeyEdges(file, readFileSync(repoPath(file), 'utf8')));
const owner = ownerOf();
const keyOf = (e: ForeignKeyEdge): string => `${e.file} ${e.sourceTable} -> ${e.targetTable}`;

test('AC-SPLIT-02 每条 REFERENCES 的源表与目标表都能查到属主', () => {
  // 扫不到任何外键 = 扫描路径坏了；那时的「零违规」是假的零违规。
  assert.ok(edges.length > 0, '一条 REFERENCES 都没扫到，先确认扫描路径');
  const unresolved = edges
    .filter((e) => e.sourceTable === '?' || !owner(e.sourceTable) || !owner(e.targetTable))
    .map((e) => `${e.file}:${e.line} ${e.sourceTable} -> ${e.targetTable}`);
  assert.deepEqual(
    unresolved,
    [],
    '这些外键的源表或目标表在 boundaries/table-ownership.json 里查不到属主：先登记属主，MUST NOT 跳过',
  );
});

test('AC-SPLIT-02 自建 DDL 里不得出现跨属主外键（例外须在本文件登记）', () => {
  const registered = new Set(KNOWN_CROSS_OWNER_EXCEPTIONS.map((e) => e.key));
  const crossOwner = edges.filter((e) => owner(e.sourceTable) !== owner(e.targetTable));
  const violations = crossOwner
    .filter((e) => !registered.has(keyOf(e)))
    .map((e) => `${e.file}:${e.line} ${e.sourceTable}(${owner(e.sourceTable)}) -> ${e.targetTable}(${owner(e.targetTable)})`);
  assert.deepEqual(
    violations,
    [],
    '跨属主外键在物理拆库后不可能建成功（PostgreSQL 外键不能跨库），会让该属主域启动即失败。'
      + '把 REFERENCES 子句去掉（列保留），并在应用层给出等价的插入期守卫；'
      + '真库里已建上的那条同时补进 scripts/db-split/0076_downgrade_cross_owner_account_fk.sql。',
  );

  // 例外清单只减不增：登记了却已经不存在的条目 MUST 当场删掉，否则清单会慢慢变成谎言。
  const present = new Set(crossOwner.map(keyOf));
  const stale = KNOWN_CROSS_OWNER_EXCEPTIONS.filter((e) => !present.has(e.key)).map((e) => e.key);
  assert.deepEqual(stale, [], '这些例外在源码里已经不存在了，删掉它们（清单只减不增）');
});

test('AC-SPLIT-02 扫描器保真自检：源表归属与注释剥离', () => {
  const sample = `
const SQL = \`
CREATE TABLE IF NOT EXISTS account_facebook_publish_image_set (
  -- 注释里的反例：这里故意不写 REFERENCES accounts(account_id)
  account_id TEXT NOT NULL,
  set_id BIGINT REFERENCES account_facebook_publish_image_set(id) ON DELETE CASCADE
);
ALTER TABLE publish_draft_refinement_jobs ADD COLUMN IF NOT EXISTS record_id INT REFERENCES publish_log(id);
\`;`;
  const found = scanForeignKeyEdges('sample.ts', sample).map((e) => `${e.sourceTable} -> ${e.targetTable}`);
  assert.deepEqual(found, [
    // 注释里那条 REFERENCES accounts(...) MUST 不出现；ALTER 段的源表 MUST 是 ALTER 的那张表。
    'account_facebook_publish_image_set -> account_facebook_publish_image_set',
    'publish_draft_refinement_jobs -> publish_log',
  ]);
});
