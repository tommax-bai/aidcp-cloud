import { test } from 'node:test';
import assert from 'node:assert/strict';

import { readMigration } from '../helpers/migration-union.js';

test('Facebook rule migrations keep API config and target-scoped runtime in separate owner files', async () => {
  const [config, runtime] = await Promise.all([
    readMigration('0092_facebook_rule_mode_config.sql'),
    readMigration('0093_facebook_rule_mode_runtime.sql'),
  ]);

  assert.match(config, /aidcp:kind=expand/);
  assert.match(config, /table:facebook_rule_mode_config/);
  assert.doesNotMatch(config, /facebook_rule_progress/);
  assert.match(config, /enabled\s+BOOLEAN NOT NULL DEFAULT false/);
  assert.match(config, /definition_version\s+INTEGER NOT NULL DEFAULT 1/);

  assert.match(runtime, /aidcp:kind=expand/);
  assert.match(runtime, /execution_target\s+TEXT NOT NULL CHECK \(execution_target IN \('dev', 'ol'\)\)/);
  assert.match(runtime, /PRIMARY KEY \(\s*account_id, execution_target, definition_id, definition_version,\s*collecting_sequence, content_key\s*\)/s);
  assert.match(runtime, /UNIQUE \(\s*account_id, execution_target, definition_id, definition_version,\s*source_dedupe_key\s*\)/s);
  assert.match(runtime, /UNIQUE \(account_id, execution_target, definition_id, definition_version, sequence\)/);
  assert.match(runtime, /CHECK \(view_count BETWEEN 0 AND 9\)/);
  assert.match(runtime, /CHECK \(definition_version = 1\)/);
  for (const state of [
    'confirmed',
    'already_satisfied',
    'risk_suppressed',
    'structural_skip',
    'not_started',
    'failed',
    'ambiguous',
    'submitted_unknown',
  ]) {
    assert.match(runtime, new RegExp(`'${state}'`));
  }
});

test('two-tier cadence migrations widen in place, resolve constraint names dynamically, and backfill config only', async () => {
  const [configRaw, runtimeRaw] = await Promise.all([
    readMigration('0094_facebook_rule_two_tier_config.sql'),
    readMigration('0095_facebook_rule_two_tier_runtime.sql'),
  ]);
  // 必须先剥注释再断言禁用语句：这两个文件的注释里逐字写着它们**不该**用的写法，
  // 不剥就会被自己的说明文字判成违规（本仓扫描器同类假阳性的老坑）。
  const executable = (sql: string) => sql.replace(/--.*$/gm, '');
  const config = executable(configRaw);
  const runtime = executable(runtimeRaw);

  for (const [raw, sql] of [[configRaw, config], [runtimeRaw, runtime]] as const) {
    assert.match(raw, /aidcp:kind=expand/);
    // 约束名由 PG 自动生成。猜名 + 若存在则删会静默 no-op，新旧 CHECK 取合取后迁移「成功」
    // 而运行期写入仍被 23514 拒——迁移层的静默假成功。名字 MUST 从 pg_constraint 查。
    assert.match(sql, /FROM pg_constraint/);
    assert.doesNotMatch(sql, /DROP CONSTRAINT IF EXISTS/);
    // 放宽必须是「新旧都接受」：旧定义仍可写 ⇒ 回滚只需改回代码常量，不需要反向迁移。
    assert.match(sql, /facebook_browse_10_like_1_join_contact_1/);
    assert.match(sql, /facebook_browse_5_like_1_join_contact_every_2/);
    assert.match(sql, /definition_version IN \(1, 2\)/);
  }

  // 属主分家：config 归 api、三张运行时表归 automation，MUST NOT 合成一条跨属主迁移。
  assert.doesNotMatch(config, /facebook_rule_progress|facebook_rule_view_fact|facebook_rule_batch/);
  assert.doesNotMatch(runtime, /facebook_rule_mode_config/);

  // 只点赞的轮次要有诚实终态；缺这个取值时写入被 CHECK 拒 ⇒ 轮次终结不了 ⇒ 单飞锁不释放。
  assert.match(runtime, /'not_scheduled'/);

  // 开关表达「要不要跑规则」，与节奏版本无关 ⇒ 存量配置行随定义身份迁移，但只动身份。
  const configUpdate = /UPDATE facebook_rule_mode_config[\s\S]*?;/.exec(config)?.[0] ?? '';
  assert.notEqual(configUpdate, '', '存量配置行 MUST 随定义身份迁移，否则配置权威与实际节奏长期对不上');
  assert.doesNotMatch(configUpdate, /\benabled\s*=/, '回填 MUST NOT 改动开关');
  assert.doesNotMatch(configUpdate, /updated_by\s*=/, '回填不是运营动作，MUST NOT 冒充操作人');
  // 进度 / 去重事实 / 批次答的是「在这套节奏下做到哪了」，换节奏后 MUST 从零重收，不得回填。
  assert.doesNotMatch(runtime, /\bUPDATE\s+facebook_rule_(progress|view_fact|batch)\b/);
});
