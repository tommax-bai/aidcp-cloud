/**
 * 实测对账判定层的脱库单测（change cloud-schema-migration-executor 任务 1.10 的最后一条：
 * 「baseline 在缺失清单非空时拒绝」）。零数据库依赖。
 *
 * `scripts/migrate.ts` 的 `commandBaseline` 只做一件事：先跑 `verify`，缺失清单非空就拒绝写账本。
 * 那个判断的**唯一输入**就是 `diffSchema` 的 `missing`，所以这里断言的是判据本身：
 * 声明了但库里没有的对象 MUST 出现在缺失清单里，并 MUST 带上「来自哪一条迁移」。
 * 缺失清单一旦漏报，baseline 就会把一个其实少跑过迁移的库标成「已应用」——
 * 之后所有版本比较都建立在假账上。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { declaredObjects, diffSchema, type ActualSchema } from '../../src/schema/schema-inspect.js';
import type { MigrationFile } from '../../src/schema/migration-plan.js';

function file(name: string, objects: string[]): MigrationFile {
  const content = `-- aidcp:kind=expand\n-- aidcp:objects=${objects.join(',')}\nSELECT 1;\n`;
  return { name, content, checksum: `sum:${name}` };
}

function actual(partial: Partial<ActualSchema>): ActualSchema {
  return {
    tables: partial.tables ?? new Set(),
    columns: partial.columns ?? new Set(),
    indexes: partial.indexes ?? new Set(),
    constraints: partial.constraints ?? new Set(),
    constraintBackedIndexes: partial.constraintBackedIndexes ?? new Set(),
  };
}

test('缺失对象逐条报出，并带上声明它的 version（baseline 的拒绝依据）', () => {
  const files = [
    file('0001_a.sql', ['table:foo', 'column:foo.bar']),
    file('0002_b.sql', ['index:idx_foo']),
  ];
  const report = diffSchema(
    declaredObjects(files),
    actual({ tables: new Set(['foo']), columns: new Set(['foo.bar']) }),
  );
  assert.deepEqual(
    report.missing.map((m) => `${m.type}:${m.name}@${m.version}`),
    ['index:idx_foo@0002_b'],
    '缺失清单 MUST 回答「缺什么、来自哪一条迁移」——只说「有缺失」无法指导补跑',
  );
  assert.ok(report.missing.length > 0, 'missing 非空 = baseline 必须拒绝写入');
});

test('声明齐备时缺失清单为空（baseline 的放行条件）', () => {
  const files = [file('0001_a.sql', ['table:foo', 'column:foo.bar', 'index:idx_foo'])];
  const report = diffSchema(
    declaredObjects(files),
    actual({
      tables: new Set(['foo']),
      columns: new Set(['foo.bar']),
      indexes: new Set(['foo idx_foo']),
    }),
  );
  assert.deepEqual(report.missing, []);
  assert.equal(report.declaredTableCount, 1);
});

test('多余对象只报「没人声明的表」与「已声明表上的多余列/索引」，约束不报（否则全是系统噪声）', () => {
  const files = [file('0001_a.sql', ['table:foo', 'column:foo.bar'])];
  const report = diffSchema(
    declaredObjects(files),
    actual({
      tables: new Set(['foo', 'ghost']),
      columns: new Set(['foo.bar', 'foo.extra', 'ghost.x']),
      indexes: new Set(['foo idx_unclaimed', 'ghost idx_ghost']),
      constraints: new Set(['foo_check_1']),
    }),
  );
  assert.deepEqual(
    report.extra.map((e) => `${e.type}:${e.name}`),
    ['table:ghost', 'column:foo.extra', 'index:idx_unclaimed'],
    'ghost 表自己的列与索引不再逐条刷屏——那张表已经被报出来了；约束一条都不报',
  );
});

test('约束背后的索引不算多余（PK / UNIQUE 会自动生成索引名）', () => {
  const files = [file('0001_a.sql', ['table:foo'])];
  const report = diffSchema(
    declaredObjects(files),
    actual({
      tables: new Set(['foo']),
      indexes: new Set(['foo foo_pkey']),
      constraintBackedIndexes: new Set(['foo_pkey']),
    }),
  );
  assert.deepEqual(report.extra, []);
});
