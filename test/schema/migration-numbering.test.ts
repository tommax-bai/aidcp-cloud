/**
 * 编号治理的机械断言（change cloud-schema-migration-executor 任务 2.3）。零数据库依赖。
 * aidcp:test-owner=cloud
 *
 * 事实源翻转后（invert-split-fact-source 5.3）：治理对象是三个派生仓 migrations/ 的并集
 * （unionMigrationFiles，按文件名去重 + 校验和一致断言），不再是本仓冻结的 migrations/ 副本。
 * 编号空间是全库共享的，所以这些断言必须继续对**并集**成立，而不是对任何单仓子集成立。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { numericPrefix, parseMigrationHeader, versionOf } from '@automation/schema/migration-plan.js';

import { readMigration, unionMigrationFiles } from '../helpers/migration-union.js';

/** 四组历史碰撞的既定相对顺序，与 migrations/README.md §2 的表逐条一致。 */
const FROZEN_COLLISIONS: Record<string, string[]> = {
  '2': ['0002_bot_chats', '0002_risk_control'],
  '30': ['0030_content_schedule_group_comments', '0030_panel_hardening_indexes'],
  '37': ['0037_facebook_comment_mode_templates', '0037_session_join_group_budget'],
  '38': ['0038_delegated_tasks', '0038_first_post_onboarding'],
};

test('0012 是永不分配的历史空洞', async () => {
  const files = await unionMigrationFiles();
  const hits = files.filter((f) => numericPrefix(versionOf(f.name)) === 12);
  assert.deepEqual(hits, [], '0012 已登记为空洞，MUST NOT 被新迁移占用（见 migrations/README.md §3）');
});

test('除已登记的四组外不存在新的同号；四组的文件名集合与相对顺序与 README 一致', async () => {
  const files = await unionMigrationFiles();
  const byPrefix = new Map<number, string[]>();
  for (const f of files) {
    const version = versionOf(f.name);
    const prefix = numericPrefix(version);
    byPrefix.set(prefix, [...(byPrefix.get(prefix) ?? []), version]);
  }

  const collisions = [...byPrefix.entries()].filter(([, versions]) => versions.length > 1);
  assert.deepEqual(
    collisions.map(([prefix]) => String(prefix)).sort(),
    Object.keys(FROZEN_COLLISIONS).sort(),
    '新增迁移 MUST NOT 复用已有数字前缀（见 migrations/README.md §4）',
  );

  for (const [prefix, expected] of Object.entries(FROZEN_COLLISIONS)) {
    // unionMigrationFiles 已按复合序排好，故这里的顺序就是执行器的实际顺序。
    assert.deepEqual(byPrefix.get(Number(prefix)), expected, `0${prefix} 组的冻结顺序被改动了`);
  }
});

test('每个迁移文件都带 kind 与 objects 两段头声明', async () => {
  const files = await unionMigrationFiles();
  const missingKind: string[] = [];
  const missingObjects: string[] = [];
  for (const f of files) {
    const header = parseMigrationHeader(f.content);
    if (!header.kind) missingKind.push(versionOf(f.name));
    const raw = await readMigration(f.name);
    if (!/^[ \t]*--[ \t]*aidcp:objects[ \t]*=/m.test(raw)) missingObjects.push(versionOf(f.name));
  }
  assert.deepEqual(missingKind, [], '缺 -- aidcp:kind= 的迁移会被执行器拒绝应用');
  assert.deepEqual(missingObjects, [], '缺 -- aidcp:objects= 的迁移在 verify 里查不出任何对象（假阴性 = 假装验证通过）');
});

test('文件名格式固定为 <4位数字>_<slug>.sql', async () => {
  const files = await unionMigrationFiles();
  const bad = files.filter((f) => !/^\d{4}_[a-z0-9_]+\.sql$/.test(f.name)).map((f) => f.name);
  assert.deepEqual(bad, []);
});
