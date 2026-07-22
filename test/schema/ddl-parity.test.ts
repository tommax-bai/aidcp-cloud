/**
 * 补齐迁移与存储 DDL 的一致性（change cloud-schema-migration-executor 任务 3.3）。零数据库依赖。
 *
 * 背景：24 张表今天只由存储在启动期自建，迁移目录从未创建过它们。第 3 节把这些 DDL 原样抽进
 * migrations/0065–0068。**抽漏一条自愈加列，新库建出的表就会缺列**，而缺列在旧库上完全看不出来
 * （旧库的列是存储早年自建的），只有全新空库拉起时才炸——那时已经在部署现场了。
 *
 * 断言方向是**单向包含**：存储源码会建出的列 / 索引 MUST 都能在迁移目录里找到。
 * 反向不要求：迁移可以比存储多（后续迁移加的列存储不一定自建），那不会让新库缺东西。
 *
 * 生命周期：第 5 节把存储侧 DDL 删干净之后，本用例自然退化为空断言，届时随任务 5.11 一并删除。
 */

import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';

import { mergeCreatedObjects, type CreatedObjects } from '../../src/schema/ddl-objects.js';
import { repoRoot } from '../../src/schema/ddl-scan.js';

/** design.md F3 列出的 24 张「只由存储自建」的表。 */
const SELF_CREATED_TABLES = [
  'accounts',
  'client_users',
  'client_environments',
  'client_env_scope',
  'client_environment_installations',
  'client_environment_deletion_requests',
  'client_env_revocation_holds',
  'anchors',
  'anchor_staging',
  'concepts',
  'curated_content',
  'liked_notes',
  'valuable_comments',
  'group_route',
  'hot_lead_config_global',
  'facebook_group_target',
  'facebook_group_target_scope',
  'facebook_group_membership',
  'facebook_group_join_audit',
  'facebook_group_join_automation_config',
  'account_facebook_publish_image',
  'account_facebook_publish_image_set',
  'persona_auto_fill_runs',
  'persona_auto_fill_targets',
];

async function collect(dir: string, ext: string, out: string[] = []): Promise<string[]> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'dist') continue;
      await collect(full, ext, out);
    } else if (entry.isFile() && entry.name.endsWith(ext)) {
      out.push(full);
    }
  }
  return out;
}

async function objectsOf(dir: string, ext: string): Promise<CreatedObjects> {
  const files = (await collect(dir, ext)).sort();
  const sources = await Promise.all(files.map((f) => readFile(f, 'utf8')));
  return mergeCreatedObjects(sources);
}

let cached: { src: CreatedObjects; migrations: CreatedObjects } | undefined;
async function both() {
  if (!cached) {
    cached = {
      src: await objectsOf(path.join(repoRoot(), 'src'), '.ts'),
      migrations: await objectsOf(path.join(repoRoot(), 'migrations'), '.sql'),
    };
  }
  return cached;
}

test('24 张自建表的列集合：存储源码建出的列迁移目录都有', async () => {
  const { src, migrations } = await both();
  const gaps: string[] = [];
  for (const table of SELF_CREATED_TABLES) {
    const fromSrc = src.tables.get(table);
    if (!fromSrc) continue; // 该表的存储侧 DDL 已在第 5 节被删除 —— 那正是本 change 的目标
    const fromMigrations = migrations.tables.get(table);
    if (!fromMigrations) {
      gaps.push(`${table}：整张表在迁移目录里不存在`);
      continue;
    }
    for (const column of [...fromSrc].sort()) {
      if (!fromMigrations.has(column)) gaps.push(`${table}.${column}：存储会建、迁移目录没有`);
    }
  }
  assert.deepEqual(gaps, [], `补齐迁移漏抄了下列对象，新库建出的表会缺它们：\n${gaps.join('\n')}`);
});

test('24 张自建表的索引集合：存储源码建出的索引迁移目录都有', async () => {
  const { src, migrations } = await both();
  const wanted = new Set(SELF_CREATED_TABLES);
  const gaps: string[] = [];
  for (const [index, table] of [...src.indexes].sort()) {
    if (!wanted.has(table)) continue;
    if (!migrations.indexes.has(index)) gaps.push(`${index}（ON ${table}）：存储会建、迁移目录没有`);
  }
  assert.deepEqual(gaps, [], `补齐迁移漏抄了下列索引：\n${gaps.join('\n')}`);
});

test('24 张表在迁移目录里确实都被建出（第 3 节的交付定义）', async () => {
  const { migrations } = await both();
  const missing = SELF_CREATED_TABLES.filter((t) => !migrations.tables.has(t));
  assert.deepEqual(missing, [], '迁移目录仍不是完整事实源：这些表只能靠存储自建才存在');
});

/**
 * 第 5 节之后最要紧的一条：存储 `init()` 的探测要求就是从这些 DDL 常量解析出来的，
 * 所以「迁移目录有没有抄漏对象」等价于「src 会建出的对象是不是迁移目录的子集」。
 * 这条不成立，空库拉起必然在某个存储上 fail-closed，而且要到部署现场才发现。
 *
 * **本条只比对象集合，对执行顺序完全无感**——曾经因此漏掉一个真缺陷：补齐迁移的编号排在
 * 「后续 ALTER 这些表」的历史迁移之后，对象一个不缺，空库上却在第 5 条就整批停住。
 * 顺序那一半由 `test/schema/migration-order.test.ts` 守。两条都绿也仍不等于真库跑过一遍
 * （真库空跑是 backlog 110.6 的真机验收项）。
 */
test('迁移目录没抄漏对象：存储探测要求的对象都在（只比集合，不含顺序）', async () => {
  const { src, migrations } = await both();
  const gaps: string[] = [];
  for (const [table, columns] of [...src.tables].sort((a, b) => a[0].localeCompare(b[0]))) {
    const fromMigrations = migrations.tables.get(table);
    if (!fromMigrations) {
      gaps.push(`table:${table}`);
      continue;
    }
    for (const column of [...columns].sort()) {
      if (!fromMigrations.has(column)) gaps.push(`column:${table}.${column}`);
    }
  }
  for (const [index] of [...src.indexes].sort((a, b) => a[0].localeCompare(b[0]))) {
    if (!migrations.indexes.has(index)) gaps.push(`index:${index}`);
  }
  assert.deepEqual(
    gaps,
    [],
    `下列对象存储要求、迁移目录却没有 —— 全新空库上这些存储会 fail-closed：\n${gaps.join('\n')}`,
  );
});
