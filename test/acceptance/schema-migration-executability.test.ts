/**
 * AC-SCHEMA-EXEC-*：迁移可执行性静态闸（change restore-derived-migration-executability 任务 6.4–6.5）。
 * aidcp:test-owner=cloud
 *
 * 判据与扫描器住在 `helpers/migration-executability.ts`（那里也写死了「本扫描器 MUST NOT 参与归属
 * 判定、只有否决权」这条限制）。本文件负责三件事：
 *
 *   - 把真实语料喂进判据，与**只减不增**的存量欠账清单逐条对账；
 *   - 三条注入验证：改坏输入，确认闸真的变红（只测 happy path 的闸等于没有闸）；
 *   - 保证这道闸只在**事实源仓**跑：派生仓只持本属主子集，在那里跑整图判据必然报一堆假缺失。
 *
 * 为什么需要它：没有这道闸，本 change 只是把当下这 13 条排好，下一条同形态的迁移照样漂进来，
 * 而且**照样要等到有人真的建一个新库才会发现**。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { PG_OWNERS } from '../../src/kernel/pg-owner-connection-resolver.js';
import { loadMigrationFiles } from '../../src/schema/migration-files.js';
import { loadMigrationOwnerScopes } from '../../src/schema/migration-owners.js';
import { versionOf } from '../../src/schema/migration-plan.js';
import {
  auditExecutability,
  readExecutabilityDebt,
  scanMigration,
  splitSqlStatements,
  violationKey,
  type ExecutabilityInput,
} from './helpers/migration-executability.js';

async function realInput(): Promise<{ input: ExecutabilityInput[]; knownTables: Set<string> }> {
  const { index, files, tableOwners, overrides } = await loadMigrationOwnerScopes(() => loadMigrationFiles());
  // 整图判据只在**事实源仓**成立：派生仓只持本属主的账本范围子集，在那儿跑会把「另一家的建表迁移
  // 不在本目录里」全部报成缺失。这里显式判失败而不是静默跳过——一道会自己关掉的闸比没有闸更坏。
  const onDisk = new Set(files.map((f) => versionOf(f.name)));
  const absent = overrides.frozenVersions.filter((v) => !onDisk.has(v));
  assert.deepEqual(
    absent.slice(0, 5),
    [],
    `本仓的 migrations/ 缺 ${absent.length} 条冻结集合内的迁移，说明这里只持某个属主的子集：` +
      '整图可执行性判据只能在事实源仓 aidcp-cloud 跑。',
  );
  const input = files.map((f) => {
    const version = versionOf(f.name);
    return {
      version,
      sql: f.content,
      executionOwners: index.byVersion.get(version)?.executionOwners ?? [],
    };
  });
  return { input, knownTables: new Set(tableOwners.keys()) };
}

test('AC-SCHEMA-EXEC-01 真实语料：可执行性违规集合与存量欠账清单逐条相等', async () => {
  const { input, knownTables } = await realInput();
  const report = auditExecutability(input, knownTables, PG_OWNERS);
  const debt = readExecutabilityDebt();

  assert.ok(
    debt.entries.length <= debt.sealedCount,
    `欠账清单只减不增：条目 ${debt.entries.length} > 封存数 ${debt.sealedCount}`,
  );

  const actual = new Map(report.violations.map((v) => [violationKey(v), v.missingTables.join(', ')]));
  const registered = new Map(debt.entries.map((e) => [violationKey(e), e.missingTables.join(', ')]));

  const fresh = [...actual.keys()].filter((k) => !registered.has(k));
  assert.deepEqual(
    fresh,
    [],
    '新增可执行性违规：这条迁移在该属主的库里引用了一张没人在那个库里建的表，' +
      '全新库跑到它就会 relation … does not exist 整批停。MUST 当场修掉，' +
      '或按 boundaries/migration-executability-debt.json 的规则显式登记并说明为什么留着。',
  );

  const gone = [...registered.keys()].filter((k) => !actual.has(k));
  assert.deepEqual(
    gone,
    [],
    '欠账清单里有已经不存在的违规：MUST 在同一提交里删掉条目并下调 sealedCount，' +
      '不留空位给新违规回填。',
  );

  for (const [key, tables] of actual) {
    assert.equal(registered.get(key), tables, `${key} 缺失的表清单与登记不一致，MUST 更新登记而不是放宽断言`);
  }
});

test('AC-SCHEMA-EXEC-02 真实语料：没有一条语句是扫描器解析不了的', async () => {
  const { input, knownTables } = await realInput();
  const report = auditExecutability(input, knownTables, PG_OWNERS);
  assert.deepEqual(
    report.unparsed,
    [],
    '解析不了的语句 MUST 判失败并指名，MUST NOT 静默跳过——跳过一条就是这道闸对那条迁移完全无感',
  );
});

test('AC-SCHEMA-EXEC-03 注入：引用外域表的新迁移当场变红并指名属主与表', async () => {
  const knownTables = new Set(['accounts', 'risk_counters']);
  const migrations: ExecutabilityInput[] = [
    { version: '0001_accounts', sql: 'CREATE TABLE accounts (id TEXT);', executionOwners: ['api'] },
    { version: '0002_risk', sql: 'CREATE TABLE risk_counters (id TEXT);', executionOwners: ['automation'] },
    {
      version: '0003_new',
      sql: 'CREATE INDEX IF NOT EXISTS idx_risk_time ON risk_counters (occurred_at);',
      executionOwners: ['api'],
    },
  ];
  const report = auditExecutability(migrations, knownTables, ['api', 'automation']);
  assert.deepEqual(report.violations, [{ owner: 'api', version: '0003_new', missingTables: ['risk_counters'] }]);

  // 同一条迁移换到正确的库里就该放行——闸的意义在于分辨这两者，而不是一见跨属主就红。
  migrations[2].executionOwners = ['automation'];
  assert.deepEqual(auditExecutability(migrations, knownTables, ['api', 'automation']).violations, []);
});

test('AC-SCHEMA-EXEC-04 注入：把 0030 的执行范围放回 [automation, content] ⇒ 当场变红', async () => {
  const { input, knownTables } = await realInput();
  const injected = input.map((m) =>
    m.version === '0030_panel_hardening_indexes' ? { ...m, executionOwners: ['automation', 'content'] } : m,
  );
  const report = auditExecutability(injected, knownTables, PG_OWNERS);
  const hits = report.violations.filter((v) => v.version === '0030_panel_hardening_indexes');
  assert.deepEqual(
    hits.map((v) => `${v.owner}:${v.missingTables.join('+')}`).sort(),
    ['automation:llm_token_usage', 'content:interaction_feed+risk_counters'],
    '这正是空库实跑停住的那个形态：automation 库没有 llm_token_usage、content 库没有另外两张表',
  );
});

test('AC-SCHEMA-EXEC-05 注入：解析不了的语句 MUST 失败，MUST NOT 放行', () => {
  const scan = scanMigration('0999_weird', 'FLUMMOX TABLE accounts;', new Set(['accounts']));
  assert.equal(scan.unparsed.length, 1);
  assert.match(scan.unparsed[0], /0999_weird/);
});

test('AC-SCHEMA-EXEC-06 语句切分认得 dollar-quote，否则 DO 块会被切成一堆解析不了的碎片', () => {
  const sql = "DO $$ BEGIN IF true THEN RAISE EXCEPTION 'x; y'; END IF; END $$;\nSELECT 1;";
  assert.deepEqual(splitSqlStatements(sql).length, 2);
});

test('AC-SCHEMA-EXEC-07 缺表即 no-op 的守卫形态不算引用（ALTER TABLE IF EXISTS）', () => {
  const known = new Set(['publish_log']);
  assert.deepEqual(scanMigration('a', 'ALTER TABLE IF EXISTS publish_log ADD COLUMN x TEXT;', known).refs, []);
  assert.deepEqual(scanMigration('b', 'ALTER TABLE publish_log ADD COLUMN x TEXT;', known).refs, ['publish_log']);
});
