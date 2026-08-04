/**
 * AC-OWN-07 · 启动期的 schema 探测 MUST NOT 点名**别的属主**的表。
 *
 * ## 这条为什么必须机械化：它的失败形态是「进程根本起不来」，且只在物理拆库之后出现
 *
 * 实测原型（change deploy-derived-services-to-dev，2026-08-04 首次真跑派生接口进程时撞上）：
 * `src/interactions/reply-config-scope-store.ts` 绑的是 **api 属主池**，它的 `init()` 却顺带断言
 * `interaction_reply_jobs.config_scope_id` 这一列存在 —— 那张表的属主是 **automation**。
 * 三域同库时这条断言恒成立；物理拆库之后 api 库里没有那张表 ⇒ 断言永远为假 ⇒
 * **派生接口进程启动即失败、退出码 1、systemd 反复重启**。单体侧看不见，因为它把这次 init
 * 包在 try/catch 里、失败就把整个互动域标成「未启用」—— 一个更难查的形态。
 *
 * ## 为什么 AC-OWN-02/03/06 都没拦住
 *
 * 那三道看的是**真正的读写语句**（`FROM`/`JOIN`/`UPDATE`/`INSERT` 的表名）。这一条读的是**元数据**：
 * `to_regclass('public.x')` 里表名在字符串参数里，`information_schema.columns` 的表名在 `WHERE` 的
 * 等号右边 —— 两种都不是表引用位置，扫描器看不见。所以它需要自己的判据。
 *
 * ## 判据
 *
 * 文件属主取自 `boundaries/module-ownership.json`（唯一来源，MUST NOT 在此另立）；
 * 表属主取自 `boundaries/table-ownership.json`（同上）。两者不一致即红。
 * `composition` / `kernel` 层不判（组装根本来就横跨三域；kernel 零副作用、不出现 SQL）。
 */
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  listSourceFiles,
  readJson,
  repoPath,
  stripTsComments,
  type Layer,
} from './helpers/boundary-scan.js';

interface OwnershipEntry {
  path: string;
  layer: Layer;
}

/** `to_regclass('public.foo')` / `to_regclass('foo')` —— 表名在字符串参数里。 */
const REGCLASS = /to_regclass\(\s*'(?:public\.)?([a-zA-Z_][\w]*)'\s*\)/g;
/** `table_name='foo'` / `table_name = 'foo'` —— 表名在等号右边（information_schema 查询）。 */
const INFORMATION_SCHEMA_TABLE = /table_name\s*=\s*'([a-zA-Z_][\w]*)'/g;

function tableOwners(): Map<string, string> {
  // `tables` 是**数组**（每项 `{table, owner, …}`），不是对象。
  // 按对象读会得到一张空表 ⇒ 本门禁恒绿、看着在守其实什么都没查
  // （写这条时实测过一次：注入违规仍然全绿，只有变异测试才发现）。
  const raw = readJson<{ tables: Array<{ table: string; owner: string }> }>(
    'boundaries/table-ownership.json',
  );
  assert.ok(Array.isArray(raw.tables) && raw.tables.length > 0, '表属主清单读空了');
  return new Map(raw.tables.map((entry) => [entry.table, entry.owner]));
}

function fileOwners(): Map<string, Layer> {
  const entries = readJson<OwnershipEntry[]>('boundaries/module-ownership.json');
  return new Map(entries.map((entry) => [entry.path, entry.layer]));
}

test('AC-OWN-07 启动期 schema 探测只点名本属主的表', () => {
  const owners = tableOwners();
  const layers = fileOwners();
  const violations: string[] = [];

  for (const relative of listSourceFiles()) {
    const layer = layers.get(relative);
    // 组装根横跨三域、kernel 不出现 SQL —— 两者都不在本条判据范围内。
    if (!layer || layer === 'composition' || layer === 'kernel') continue;
    const source = stripTsComments(readFileSync(repoPath(relative), 'utf8'));
    for (const pattern of [REGCLASS, INFORMATION_SCHEMA_TABLE]) {
      pattern.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = pattern.exec(source)) !== null) {
        const table = match[1];
        const owner = owners.get(table);
        // 属主表里没有的名字（临时表 / 视图 / 拼错）不在本条范围内：表属主清单自己有别的门禁管。
        if (!owner || owner === layer) continue;
        violations.push(`${relative}（${layer} 层）探测了 ${owner} 属主的表 ${table}`);
      }
    }
  }

  assert.deepEqual(
    violations,
    [],
    '启动期探测点名了别的属主的表 —— 物理拆库后该断言永远为假，表现是进程起不来或整域被静默标为「未启用」：\n'
      + violations.join('\n'),
  );
});
