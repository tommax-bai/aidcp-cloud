/**
 * AC-SPLIT-01 · 拆库拷数据脚本用的属主表清单，MUST 与 boundaries/table-ownership.json 逐字一致。
 *
 * 为什么需要这条门禁：物理拷数据的脚本（scripts/db-split/0077）跑在 ECS 上、用 bash 读
 * scripts/db-split/owner-tables.<owner>.txt。属主判据的**唯一来源**是
 * boundaries/table-ownership.json——一旦有人改了属主却没重生成那三个 .txt，
 * 拷数据就会按**过期的属主**分表：漏拷的表在属主库里根本不存在（响亮失败，还好），
 * 拷错属主的表则会**静默落进错的库**，而两边都还能连上、两边都不报错。
 */
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  ownerTableListsFromOwnership,
  parseOwnerTableList,
  renderOwnerTableList,
} from '../../scripts/db-split/generate-owner-table-lists.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const ownershipJson = readFileSync(join(repoRoot, 'boundaries', 'table-ownership.json'), 'utf8');

test('AC-SPLIT-01 owner table lists match boundaries/table-ownership.json verbatim', () => {
  const expected = ownerTableListsFromOwnership(ownershipJson);
  const owners = Object.keys(expected).sort();
  assert.deepEqual(owners, ['api', 'automation', 'content'], 'owner set changed — update the split scripts');

  for (const owner of owners) {
    const path = join(repoRoot, 'scripts', 'db-split', `owner-tables.${owner}.txt`);
    const onDisk = readFileSync(path, 'utf8');
    assert.equal(
      onDisk,
      renderOwnerTableList(owner, expected[owner]!),
      `${path} is stale — regenerate with: npx tsx scripts/db-split/generate-owner-table-lists.ts`,
    );
  }
});

test('AC-SPLIT-01 every owned table lands in exactly one owner list', () => {
  const expected = ownerTableListsFromOwnership(ownershipJson);
  const seen = new Map<string, string>();
  for (const [owner, tables] of Object.entries(expected)) {
    for (const table of tables) {
      const prior = seen.get(table);
      assert.equal(prior, undefined, `table ${table} claimed by both ${prior} and ${owner}`);
      seen.set(table, owner);
    }
  }
  const declared = (JSON.parse(ownershipJson) as { tables: { table: string }[] }).tables.length;
  assert.equal(seen.size, declared, 'owner lists lost or duplicated a table');
});

test('AC-SPLIT-01 parseOwnerTableList drops comments and blanks', () => {
  const parsed = parseOwnerTableList('# header\n\n  accounts \n# trailing\nclient_users\n');
  assert.deepEqual(parsed, ['accounts', 'client_users']);
});
