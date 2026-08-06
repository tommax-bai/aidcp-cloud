/**
 * 「一条迁移在哪些库记账、在哪些库执行」的判据（src/schema/migration-owners.ts）。
 *
 * 用例克制：只钉会真出事的性质 ——
 *   ① 账本范围的判据（头声明的对象 → 边界清单的属主），含跨属主与「定位不到表」两种边角；
 *   ② 执行范围的解析顺序四个分支，尤其第 ④ 步 MUST 失败并指名（旧实现在这里静默计入全部属主，
 *      于是把一条只碰 api 表的迁移放进 content 库去跑）；
 *   ③ 封闭名册的三条机械断言 + `owners: []` 的接替覆盖校验；
 *   ④ 三属主范围的并集 = 全部迁移（属主 URL 未设时执行器仍跑同一批文件 = 逐字节等价的前提）；
 *   ⑤ 有表查不到属主时 MUST 抛错，MUST NOT 静默把它从所有属主范围里抹掉。
 *
 * 每条负向断言都是**注入验证**：先把输入改坏，再确认闸真的变红（而不是只测 happy path）。
 */

import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { PG_OWNERS, type PgOwner } from '@kernel/kernel/pg-owner-connection-resolver.js';
import { loadMigrationFiles } from '@automation/schema/migration-files.js';
import {
  EMPTY_LEGACY_OWNER_OVERRIDES,
  LEDGER_MIGRATION_VERSION,
  LEGACY_OWNER_OVERRIDES_NAME,
  attributeMigrations,
  executionVersionsForOwner,
  loadLegacyOwnerOverrides,
  loadMigrationOwnerScopes,
  loadTableOwnership,
  recordOnlyVersionsForOwners,
  scopeDeclarationsToOwners,
  versionsForOwner,
  type LegacyOwnerOverrides,
} from '@automation/schema/migration-owners.js';
import { declaredObjects } from '@automation/schema/schema-inspect.js';
import { versionOf, type MigrationFile } from '@automation/schema/migration-plan.js';

function file(name: string, header: string): MigrationFile {
  return { name, content: `-- aidcp:kind=expand\n${header}\n`, checksum: name };
}

function roster(entries: LegacyOwnerOverrides['entries'], frozen: string[]): LegacyOwnerOverrides {
  return {
    frozenVersions: frozen,
    frozenBasis: '测试夹具',
    sealedEntryCount: entries.length,
    entries,
  };
}

const owners = new Map<string, PgOwner>([
  ['accounts', 'api'],
  ['alerts', 'automation'],
  ['token_usage', 'content'],
]);

/**
 * 真语料的名册与迁移目录（多处用到，读一次）。
 * loader 代码按属主别名从派生仓装载，但真语料 MUST 仍是本仓（事实源）的全量 migrations/ 与
 * boundaries/ —— loader 的模块相对默认路径会悄悄换成派生仓的属主子集（61/115 条），
 * 「并集 = 全部迁移」「名册与目录对得上」就静默降级成对子集的弱主张。
 * 三个 loader 的文档都写明「仓外消费方 MUST 显式传路径」，此处照办。
 */
const FACT_SOURCE_ROOT = path.join(fileURLToPath(import.meta.url), '..', '..', '..');

async function realScopes() {
  return loadMigrationOwnerScopes(
    () => loadMigrationFiles(path.join(FACT_SOURCE_ROOT, 'migrations')),
    () => loadTableOwnership(path.join(FACT_SOURCE_ROOT, 'boundaries', 'table-ownership.json')),
    () => loadLegacyOwnerOverrides(path.join(FACT_SOURCE_ROOT, 'migrations', LEGACY_OWNER_OVERRIDES_NAME)),
  );
}

test('账本范围：头声明的表 → 边界清单的属主；跨属主迁移进每个相关属主的范围', () => {
  const index = attributeMigrations(
    [
      file('0001_api_only.sql', '-- aidcp:objects=table:accounts'),
      file('0002_cross_owner.sql', '-- aidcp:objects=table:accounts,column:alerts.detail'),
      file('0003_content.sql', '-- aidcp:objects=column:token_usage.cost'),
    ],
    owners,
  );

  assert.deepEqual(index.byVersion.get('0001_api_only')?.ledgerOwners, ['api']);
  assert.deepEqual(index.byVersion.get('0002_cross_owner')?.ledgerOwners, ['automation', 'api']);
  assert.equal(index.byVersion.get('0002_cross_owner')?.reason, 'declared');
  assert.deepEqual(index.byVersion.get('0003_content')?.ledgerOwners, ['content']);

  // 分支 ③：能定位到表时执行范围 = 账本范围（今日行为不变）。
  assert.deepEqual(index.byVersion.get('0001_api_only')?.executionOwners, ['api']);
  assert.equal(index.byVersion.get('0001_api_only')?.executionBasis, 'declared');
  assert.deepEqual(index.unresolvedExecution, []);

  // 跨属主迁移在两个属主的账本里各记一条，版本 id 逐字相同（不拆成合成子条目）。
  assert.ok(versionsForOwner(index, 'api').includes('0002_cross_owner'));
  assert.ok(versionsForOwner(index, 'automation').includes('0002_cross_owner'));
  assert.ok(!versionsForOwner(index, 'content').includes('0002_cross_owner'));
});

test('分支 ④：对象声明定位不到表且无声明来源 ⇒ 账本范围仍是全部属主，但执行范围 MUST 判失败并指名', async () => {
  const files = [
    file('0004_empty_header.sql', '-- aidcp:objects='),
    file('0005_index_only.sql', '-- aidcp:objects=index:some_idx'),
  ];
  const index = attributeMigrations(files, owners);

  // 账本范围：今日行为逐字不变。
  assert.deepEqual(index.residue, ['0004_empty_header', '0005_index_only']);
  for (const owner of PG_OWNERS) {
    assert.deepEqual(versionsForOwner(index, owner), ['0004_empty_header', '0005_index_only']);
  }
  assert.equal(index.byVersion.get('0005_index_only')?.reason, 'residue');

  // 执行范围：**绝不**跟着计入全部属主 —— 这正是把只碰 api 表的迁移灌进 content 库的那条旧路径。
  assert.deepEqual(index.unresolvedExecution.length, 2);
  for (const owner of PG_OWNERS) assert.deepEqual(executionVersionsForOwner(index, owner), []);
  await assert.rejects(
    () => loadMigrationOwnerScopes(async () => files, async () => owners, async () => EMPTY_LEGACY_OWNER_OVERRIDES),
    /判不出执行范围[\s\S]*0004_empty_header/,
  );
});

test('分支 ①：文件内 -- aidcp:owner= 头压过对象声明；非法取值 MUST 失败，MUST NOT 退回推断', () => {
  const index = attributeMigrations(
    [
      file('0007_header.sql', '-- aidcp:objects=index:idx_x\n-- aidcp:owner=automation'),
      // 头里声明的属主与对象声明指向的属主刻意不同：以头为准，才谈得上「拆一条跨属主迁移」。
      file('0008_header_over_declared.sql', '-- aidcp:objects=table:accounts\n-- aidcp:owner=content'),
      file('0009_bad_owner.sql', '-- aidcp:objects=index:idx_y\n-- aidcp:owner=warehouse'),
    ],
    owners,
  );
  assert.deepEqual(index.byVersion.get('0007_header')?.executionOwners, ['automation']);
  assert.equal(index.byVersion.get('0007_header')?.executionBasis, 'header');
  assert.deepEqual(index.byVersion.get('0008_header_over_declared')?.executionOwners, ['content']);
  assert.deepEqual(
    index.byVersion.get('0008_header_over_declared')?.ledgerOwners,
    ['api'],
    '账本范围仍按对象声明走：头声明只管在哪儿执行，不改「谁要记这一笔」',
  );
  assert.match(index.unresolvedExecution.join(' '), /0009_bad_owner[\s\S]*warehouse/);
});

test('分支 ②：名册给出执行范围；owners: [] = 记账不执行，且被原样带出清单', () => {
  const files = [
    file('0004_legacy.sql', '-- aidcp:objects='),
    file('0006_cross.sql', '-- aidcp:objects=index:idx_a,index:idx_b'),
    file('0010_heir.sql', '-- aidcp:objects=index:idx_a,index:idx_b\n-- aidcp:owner=automation'),
  ];
  const index = attributeMigrations(
    files,
    owners,
    roster(
      [
        { version: '0004_legacy', owners: ['api'], basis: '唯一语句 ALTER TABLE accounts …' },
        {
          version: '0006_cross',
          owners: [],
          basis: '跨 automation / content，两边都跑不通',
          supersededBy: ['0010_heir'],
        },
      ],
      ['0004_legacy', '0006_cross'],
    ),
  );

  assert.deepEqual(index.byVersion.get('0004_legacy')?.executionOwners, ['api']);
  assert.equal(index.byVersion.get('0004_legacy')?.executionBasis, 'roster');
  assert.deepEqual(index.byVersion.get('0004_legacy')?.ledgerOwners, [...PG_OWNERS]);
  assert.deepEqual(index.byVersion.get('0006_cross')?.executionOwners, []);
  assert.deepEqual(index.recordedNotExecuted, ['0006_cross']);
  assert.deepEqual(index.overrideProblems, []);

  // 「在这一组的库里到底跑不跑」是按库判的，不是按条目判的。
  assert.deepEqual(recordOnlyVersionsForOwners(index, ['0004_legacy', '0006_cross'], ['api']), ['0006_cross']);
  assert.deepEqual(
    recordOnlyVersionsForOwners(index, ['0004_legacy', '0006_cross'], ['content']),
    ['0004_legacy', '0006_cross'],
    'content 库既不执行那条 api 迁移、也不执行那条记账不执行的',
  );
});

test('注入：owners: [] 的接替迁移覆盖不全 ⇒ 当场报出被丢掉的对象', () => {
  const files = [
    file('0006_cross.sql', '-- aidcp:objects=index:idx_a,index:idx_b'),
    file('0010_partial_heir.sql', '-- aidcp:objects=index:idx_a\n-- aidcp:owner=automation'),
  ];
  const index = attributeMigrations(
    files,
    owners,
    roster(
      [{ version: '0006_cross', owners: [], basis: '跨属主', supersededBy: ['0010_partial_heir'] }],
      ['0006_cross'],
    ),
  );
  assert.match(index.overrideProblems.join('\n'), /0006_cross[\s\S]*index:idx_b[\s\S]*悄悄丢掉/);
});

test('注入：名册留着磁盘上已不存在的 version ⇒ 报出来，MUST NOT 静默忽略', () => {
  const index = attributeMigrations(
    [file('0004_legacy.sql', '-- aidcp:objects=table:accounts')],
    owners,
    roster([{ version: '0099_gone', owners: ['api'], basis: '早已删除' }], ['0099_gone']),
  );
  assert.match(index.overrideProblems.join('\n'), /0099_gone[\s\S]*迁移目录里却没有/);
});

test('名册的三条机械断言：只减不增 / version 属于冻结集合 / owners 为空必须带接替', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'aidcp-roster-'));
  const write = async (doc: unknown): Promise<string> => {
    const p = path.join(dir, `${Math.random().toString(36).slice(2)}-${LEGACY_OWNER_OVERRIDES_NAME}`);
    await writeFile(p, JSON.stringify(doc), 'utf8');
    return p;
  };
  const base = {
    frozenVersions: ['0001_a', '0002_b'],
    frozenBasis: '测试夹具',
    sealedEntryCount: 1,
  };

  // 基准：合法名册读得出来。
  const ok = await loadLegacyOwnerOverrides(
    await write({ ...base, entries: [{ version: '0001_a', owners: ['api'], basis: '读了唯一那条 ALTER' }] }),
  );
  assert.equal(ok.entries.length, 1);

  // (a) 只减不增
  const grown = await write({
    ...base,
    entries: [
      { version: '0001_a', owners: ['api'], basis: 'x' },
      { version: '0002_b', owners: ['api'], basis: 'y' },
    ],
  });
  await assert.rejects(() => loadLegacyOwnerOverrides(grown), /只减不增/);

  // (b) version MUST 属于冻结集合（新迁移写进名册即失败）
  const notFrozen = await write({ ...base, entries: [{ version: '0112_new', owners: ['api'], basis: 'x' }] });
  await assert.rejects(() => loadLegacyOwnerOverrides(notFrozen), /不在冻结集合里/);

  // owners 为空却不给接替声明 —— 本机制最容易犯的错
  const orphanEmpty = await write({ ...base, entries: [{ version: '0001_a', owners: [], basis: 'x' }] });
  await assert.rejects(() => loadLegacyOwnerOverrides(orphanEmpty), /supersededBy/);

  // basis 只写属主名不算依据
  const noBasis = await write({ ...base, entries: [{ version: '0001_a', owners: ['api'], basis: '  ' }] });
  await assert.rejects(() => loadLegacyOwnerOverrides(noBasis), /缺少 basis/);

  // 文件缺席 MUST 抛错，MUST NOT 退化成空名册（那会把部署问题伪装成数据问题）
  await assert.rejects(
    () => loadLegacyOwnerOverrides(path.join(dir, 'does-not-exist.json')),
    /读不出历史属主名册/,
  );
});

test('声明了但边界清单查不到属主的表 MUST 报出来，MUST NOT 静默丢弃', async () => {
  const index = attributeMigrations([file('0006_ghost.sql', '-- aidcp:objects=table:zz_unregistered')], owners);
  assert.deepEqual(index.unknownTables, ['zz_unregistered']);
  await assert.rejects(
    () =>
      loadMigrationOwnerScopes(
        async () => [file('0006_ghost.sql', '-- aidcp:objects=table:zz_unregistered')],
        async () => owners,
        async () => EMPTY_LEGACY_OWNER_OVERRIDES,
      ),
    /zz_unregistered/,
  );
});

test('真实语料：账本范围并集 = 全部迁移；每条迁移都判得出执行范围；名册与目录对得上', async () => {
  const { index, files, overrides } = await realScopes();
  assert.deepEqual(index.unknownTables, [], '迁移头声明的表 MUST 全部在 boundaries/table-ownership.json 里有属主');
  assert.deepEqual(index.unresolvedExecution, [], '每条迁移 MUST 判得出执行范围（头声明 / 名册 / 对象声明三者其一）');
  assert.deepEqual(index.overrideProblems, []);

  const union = new Set<string>();
  for (const owner of PG_OWNERS) {
    const versions = versionsForOwner(index, owner);
    assert.ok(versions.length > 0, `属主 ${owner} 的账本范围为空`);
    assert.ok(executionVersionsForOwner(index, owner).length > 0, `属主 ${owner} 的执行范围为空`);
    assert.ok(
      versions.includes(LEDGER_MIGRATION_VERSION),
      `账本表迁移 MUST 在属主 ${owner} 的范围内，否则新建的属主库连账本表都建不出来`,
    );
    for (const v of versions) union.add(v);
  }

  // 这条是「属主 URL 未设时逐字节等价」的前提：三属主同组 ⇒ 组范围 = 并集 = 今天的全部迁移。
  assert.deepEqual([...union].sort(), files.map((f) => versionOf(f.name)).sort());

  // 名册逐条落在真实迁移上，且执行范围确实按名册走。
  for (const entry of overrides.entries) {
    const attribution = index.byVersion.get(entry.version);
    assert.ok(attribution, `名册条目 ${entry.version} 在迁移目录里必须存在`);
    assert.equal(attribution.executionBasis, 'roster', `${entry.version} 的执行范围 MUST 来自名册`);
    assert.deepEqual(attribution.executionOwners, PG_OWNERS.filter((o) => entry.owners.includes(o)));
  }
});

test('真实语料：0030_panel_hardening_indexes 记账不执行，且它的三个索引由两条接替迁移建回', async () => {
  const { index } = await realScopes();
  const cross = index.byVersion.get('0030_panel_hardening_indexes');
  assert.ok(cross);
  assert.deepEqual(cross.executionOwners, [], '它在任何单一属主库里都跑不通，MUST 记账不执行');
  assert.deepEqual(cross.ledgerOwners, [...PG_OWNERS], '账本范围不变：三个库都要记一笔「已处置」');
  assert.deepEqual(index.recordedNotExecuted, ['0030_panel_hardening_indexes']);

  const heirs = cross.supersededBy ?? [];
  assert.deepEqual(heirs, [
    '0112_panel_hardening_indexes_automation',
    '0113_panel_hardening_indexes_content',
  ]);
  // 接替迁移各自落在正确的库里 —— 建错库就等于索引在全新库上被悄悄丢掉。
  assert.deepEqual(index.byVersion.get(heirs[0])?.executionOwners, ['automation']);
  assert.deepEqual(index.byVersion.get(heirs[1])?.executionOwners, ['content']);
});

test('跨属主迁移的对象按属主收窄：本属主的表才核验，索引/约束无法归因时如实列出', () => {
  const files: MigrationFile[] = [
    // 只碰 content：索引可确定归属
    { name: '0001_content_only.sql', content: '-- aidcp:objects=table:concepts,index:idx_concepts_a\n', checksum: 'a' },
    // 同时碰 content 与 automation：table/column 各归各家，index 无法归因
    {
      name: '0002_mixed.sql',
      content: '-- aidcp:objects=table:account_facebook_publish_image,table:facebook_group_target,index:idx_fb_x\n',
      checksum: 'b',
    },
  ];
  const owners = new Map<string, PgOwner>([
    ['concepts', 'content'],
    ['account_facebook_publish_image', 'content'],
    ['facebook_group_target', 'automation'],
  ]);
  const index = attributeMigrations(files, owners);
  const declared = declaredObjects(files);

  const content = scopeDeclarationsToOwners(declared, index, owners, ['content']);
  assert.deepEqual(
    content.checked.map((o) => `${o.type}:${o.name}`).sort(),
    ['index:idx_concepts_a', 'table:account_facebook_publish_image', 'table:concepts'],
    'content 只该核验自己的表，外加那条只碰 content 的迁移里的索引',
  );
  assert.deepEqual(
    content.unattributable.map((o) => `${o.type}:${o.name}`),
    ['index:idx_fb_x'],
    '跨属主迁移里的索引 MUST 进未核验清单，MUST NOT 被当成已核验、也 MUST NOT 被当成缺失',
  );

  const automation = scopeDeclarationsToOwners(declared, index, owners, ['automation']);
  assert.deepEqual(
    automation.checked.map((o) => `${o.type}:${o.name}`),
    ['table:facebook_group_target'],
    'automation 不该被要求 content 的表存在——这正是它挡住新库 baseline 的那个 bug',
  );
});

test('声明收窄读的是执行范围：只在一个库里跑的迁移，它的索引在那个库里 MUST 被核验', () => {
  const files: MigrationFile[] = [
    {
      name: '0010_heir.sql',
      content: '-- aidcp:kind=expand\n-- aidcp:objects=index:idx_alerts_time\n-- aidcp:owner=automation\n',
      checksum: 'a',
    },
  ];
  const index = attributeMigrations(files, owners);
  const declared = declaredObjects(files);

  // 账本范围是全部属主（对象声明定位不到表），执行范围只有 automation。
  assert.deepEqual(index.byVersion.get('0010_heir')?.ledgerOwners, [...PG_OWNERS]);
  const automation = scopeDeclarationsToOwners(declared, index, owners, ['automation']);
  assert.deepEqual(
    automation.checked.map((o) => o.name),
    ['idx_alerts_time'],
    '按账本范围判会把它划进 unattributable，于是这个索引在任何库里都不被核验，验证装置形同虚设',
  );
  const content = scopeDeclarationsToOwners(declared, index, owners, ['content']);
  assert.deepEqual(content.checked, []);
  assert.deepEqual(content.unattributable.map((o) => o.name), ['idx_alerts_time']);
});
