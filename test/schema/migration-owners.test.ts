/**
 * 「一条迁移属于哪个属主库」的判据（src/schema/migration-owners.ts）。
 *
 * 用例克制：只钉三条会真出事的性质 ——
 *   ① 判据本身（头声明的对象 → 边界清单的属主），含跨属主与残留两种边角；
 *   ② 三属主范围的并集 = 全部迁移（属主 URL 未设时执行器仍跑同一批文件 = 逐字节等价的前提）；
 *   ③ 有表查不到属主时 MUST 抛错，MUST NOT 静默把它从所有属主范围里抹掉。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { PG_OWNERS, type PgOwner } from '../../src/kernel/pg-owner-connection-resolver.js';
import { loadMigrationFiles } from '../../src/schema/migration-files.js';
import {
  LEDGER_MIGRATION_VERSION,
  attributeMigrations,
  loadMigrationOwnerScopes,
  loadTableOwnership,
  scopeDeclarationsToOwners,
  versionsForOwner,
} from '../../src/schema/migration-owners.js';
import { declaredObjects } from '../../src/schema/schema-inspect.js';
import { versionOf, type MigrationFile } from '../../src/schema/migration-plan.js';

function file(name: string, header: string): MigrationFile {
  return { name, content: `-- aidcp:kind=expand\n${header}\n`, checksum: name };
}

const owners = new Map<string, PgOwner>([
  ['accounts', 'api'],
  ['alerts', 'automation'],
  ['token_usage', 'content'],
]);

test('判据：头声明的表 → 边界清单的属主；跨属主迁移进每个相关属主的范围', () => {
  const index = attributeMigrations(
    [
      file('0001_api_only.sql', '-- aidcp:objects=table:accounts'),
      file('0002_cross_owner.sql', '-- aidcp:objects=table:accounts,column:alerts.detail'),
      file('0003_content.sql', '-- aidcp:objects=column:token_usage.cost'),
    ],
    owners,
  );

  assert.deepEqual(index.byVersion.get('0001_api_only')?.owners, ['api']);
  assert.deepEqual(index.byVersion.get('0002_cross_owner')?.owners, ['automation', 'api']);
  assert.equal(index.byVersion.get('0002_cross_owner')?.reason, 'declared');
  assert.deepEqual(index.byVersion.get('0003_content')?.owners, ['content']);

  // 跨属主迁移在两个属主的账本里各记一条，版本 id 逐字相同（不拆成合成子条目）。
  assert.ok(versionsForOwner(index, 'api').includes('0002_cross_owner'));
  assert.ok(versionsForOwner(index, 'automation').includes('0002_cross_owner'));
  assert.ok(!versionsForOwner(index, 'content').includes('0002_cross_owner'));
});

test('残留（头声明为空 / 只声明索引）计入全部属主，并被原样带出清单', () => {
  const index = attributeMigrations(
    [
      file('0004_empty_header.sql', '-- aidcp:objects='),
      file('0005_index_only.sql', '-- aidcp:objects=index:some_idx'),
    ],
    owners,
  );
  assert.deepEqual(index.residue, ['0004_empty_header', '0005_index_only']);
  for (const owner of PG_OWNERS) {
    assert.deepEqual(versionsForOwner(index, owner), ['0004_empty_header', '0005_index_only']);
  }
  assert.equal(index.byVersion.get('0005_index_only')?.reason, 'residue');
});

test('声明了但边界清单查不到属主的表 MUST 报出来，MUST NOT 静默丢弃', async () => {
  const index = attributeMigrations([file('0006_ghost.sql', '-- aidcp:objects=table:zz_unregistered')], owners);
  assert.deepEqual(index.unknownTables, ['zz_unregistered']);
  await assert.rejects(
    () => loadMigrationOwnerScopes(async () => [file('0006_ghost.sql', '-- aidcp:objects=table:zz_unregistered')], async () => owners),
    /zz_unregistered/,
  );
});

test('真实语料：三属主范围的并集 = 全部迁移，且账本迁移在每个属主范围内', async () => {
  const files = await loadMigrationFiles();
  const index = attributeMigrations(files, await loadTableOwnership());
  assert.deepEqual(index.unknownTables, [], '迁移头声明的表 MUST 全部在 boundaries/table-ownership.json 里有属主');

  const union = new Set<string>();
  for (const owner of PG_OWNERS) {
    const versions = versionsForOwner(index, owner);
    assert.ok(versions.length > 0, `属主 ${owner} 的迁移范围为空`);
    assert.ok(
      versions.includes(LEDGER_MIGRATION_VERSION),
      `账本表迁移 MUST 在属主 ${owner} 的范围内，否则新建的属主库连账本表都建不出来`,
    );
    for (const v of versions) union.add(v);
  }

  // 这条是「属主 URL 未设时逐字节等价」的前提：三属主同组 ⇒ 组范围 = 并集 = 今天的全部迁移。
  assert.deepEqual([...union].sort(), files.map((f) => versionOf(f.name)).sort());
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
