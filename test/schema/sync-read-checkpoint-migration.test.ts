// aidcp:test-owner=cloud
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { test } from 'node:test';

import { loadMigrationFiles } from '../../src/schema/migration-files.js';
import {
  attributeMigrations,
  loadTableOwnership,
  versionsForOwner,
} from '../../src/schema/migration-owners.js';
import { KNOWN_MAX_SCHEMA_VERSION } from '../../src/schema/schema-contract.js';
import {
  SYNC_READ_STREAM_DEFINITIONS,
  type SyncReadStream,
} from '../../src/kernel/sync-read-snapshot.js';

const migrations = [
  {
    name: '0082_api_sync_read_consumer_checkpoint',
    table: 'api_sync_read_consumer_checkpoint',
    consumer: 'api',
    streams: [
      'session_config_global',
      'edge_presence',
      'publish_in_flight',
      'captcha_availability',
      'automation_config_mirror_health',
    ],
  },
  {
    name: '0083_automation_sync_read_consumer_checkpoint',
    table: 'automation_sync_read_consumer_checkpoint',
    consumer: 'automation',
    streams: [
      'account_persona',
      'client_environment_automation',
      'automation_account_projection',
      'content_schedule',
      'hot_lead_config',
      'facebook_comment_config',
      'facebook_group_join_automation_config',
    ],
  },
] as const;

test('0082/0083 are expand-only owner-local checkpoint tables with no business payload', async () => {
  for (const migration of migrations) {
    const sql = await readFile(
      new URL(`../../migrations/${migration.name}.sql`, import.meta.url),
      'utf8',
    );
    assert.match(sql, /-- aidcp:kind=expand/);
    assert.match(
      sql,
      new RegExp(`CREATE TABLE IF NOT EXISTS ${migration.table}`),
    );
    assert.match(sql, /PRIMARY KEY \(execution_target, consumer, stream\)/);
    assert.match(
      sql,
      new RegExp(`consumer\\s+TEXT NOT NULL CHECK \\(consumer = '${migration.consumer}'\\)`),
    );
    for (const stream of migration.streams) {
      assert.match(sql, new RegExp(`'${stream}'`));
    }
    for (const column of [
      'applied_cursor',
      'payload_digest',
      'source_as_of_ms',
      'last_observed_at_ms',
      'fresh_until_ms',
      'last_applied_at_ms',
      'state',
      'last_error',
    ]) {
      assert.match(sql, new RegExp(`\\b${column}\\b`));
    }
    const executable = sql.replace(/^--.*$/gm, '');
    assert.doesNotMatch(
      executable,
      /\b(?:payload|value|fact_scope|owner_version|config_mirror_version)\b/i,
      'checkpoint tables MUST NOT copy shared facts, projection payloads, or owner versions',
    );
    assert.doesNotMatch(executable, /\b(?:DROP|ALTER)\s+(?:TABLE|COLUMN)\b/i);
  }
});

test('checkpoint migrations remain owner-local when owner databases split', async () => {
  const files = await loadMigrationFiles();
  const index = attributeMigrations(files, await loadTableOwnership());
  const api = versionsForOwner(index, 'api');
  const automation = versionsForOwner(index, 'automation');
  assert.ok(api.includes('0082_api_sync_read_consumer_checkpoint'));
  assert.ok(!api.includes('0083_automation_sync_read_consumer_checkpoint'));
  assert.ok(automation.includes('0083_automation_sync_read_consumer_checkpoint'));
  assert.ok(!automation.includes('0082_api_sync_read_consumer_checkpoint'));
  // 两级节奏的 CHECK 放宽同样必须落在各自属主：config 归 api、三张运行时表归 automation。
  // 合成一条跨属主迁移在拆库后无处可跑。
  assert.ok(api.includes('0094_facebook_rule_two_tier_config'));
  assert.ok(!api.includes('0095_facebook_rule_two_tier_runtime'));
  assert.ok(automation.includes('0095_facebook_rule_two_tier_runtime'));
  assert.ok(!automation.includes('0094_facebook_rule_two_tier_config'));
  // 降级终态只动 automation 属主的 batch 表。
  assert.ok(automation.includes('0096_facebook_rule_fallback_comment_state'));
  assert.ok(!api.includes('0096_facebook_rule_fallback_comment_state'));
  // 环境键配置只动 api 属主的两张配置表。
  assert.ok(api.includes('0097_environment_level_rule_mode_and_approval'));
  assert.ok(!automation.includes('0097_environment_level_rule_mode_and_approval'));
  // 加群日上限的 CHECK 放宽只动 api 属主的加群配置表。
  assert.ok(api.includes('0098_facebook_group_join_daily_cap_50'));
  assert.ok(!automation.includes('0098_facebook_group_join_daily_cap_50'));
  // 运营指令幂等台账是 automation 属主的新表，故只能落在 automation 那一侧。
  assert.ok(automation.includes('0099_operator_command_receipt'));
  assert.ok(!api.includes('0099_operator_command_receipt'));
  // 操作策略与群评论等待是 API 配置权威；规则/消费进度是 automation 运行事实。
  assert.ok(api.includes('0100_facebook_operation_and_group_comment_policy'));
  assert.ok(!automation.includes('0100_facebook_operation_and_group_comment_policy'));
  assert.ok(automation.includes('0101_facebook_rule_policy_revision_runtime'));
  assert.ok(!api.includes('0101_facebook_rule_policy_revision_runtime'));
  assert.ok(automation.includes('0102_facebook_consumption_runtime'));
  assert.ok(!api.includes('0102_facebook_consumption_runtime'));
  // 目标全局运行数值、环境继承来源和目标隔离的慢启动毕业事实均由 API 配置权威持有。
  assert.ok(api.includes('0103_facebook_operation_global_policy'));
  assert.ok(!automation.includes('0103_facebook_operation_global_policy'));
  // Reel 模式节奏只扩展 API 属主的目标全局配置表，不进入 automation 运行库。
  assert.ok(api.includes('0104_facebook_reel_mode_cadence'));
  assert.ok(!automation.includes('0104_facebook_reel_mode_cadence'));
  assert.ok(api.includes('0105_facebook_primary_browse_surface'));
  assert.ok(!automation.includes('0105_facebook_primary_browse_surface'));
  // 同步读检查点表归 automation 属主库，故放宽其流名取值域的迁移只进 automation 组。
  assert.ok(
    automation.includes('0106_automation_sync_read_facebook_operation_policy'),
  );
  assert.ok(
    !api.includes('0106_automation_sync_read_facebook_operation_policy'),
  );
  // 冷启动 Reel 点赞节奏只扩展 API 属主的全局策略表。
  assert.ok(api.includes('0107_facebook_slow_start_reel_like_cadence'));
  assert.ok(!automation.includes('0107_facebook_slow_start_reel_like_cadence'));
  // 推进镜像版本动的是 config_mirror_version（API 属主的共享配置权威）。
  assert.ok(api.includes('0108_facebook_operation_policy_snapshot_revision'));
  assert.ok(
    !automation.includes('0108_facebook_operation_policy_snapshot_revision'),
  );
  // 排期小时格台账是 API 属主表，故放宽其 env_key 的迁移只进 api 组。
  assert.ok(api.includes('0109_content_schedule_hour_claim_env_key_optional'));
  assert.ok(
    !automation.includes('0109_content_schedule_hour_claim_env_key_optional'),
  );
  // 每加一条迁移都要在这里同步抬。
  assert.equal(
    KNOWN_MAX_SCHEMA_VERSION,
    '0109_content_schedule_hour_claim_env_key_optional',
  );
});

test('0085 keeps runtime owner generations durable, target-scoped and payload-free', async () => {
  const sql = await readFile(
    new URL(
      '../../migrations/0085_automation_sync_read_owner_generation.sql',
      import.meta.url,
    ),
    'utf8',
  );
  assert.match(sql, /-- aidcp:kind=expand/);
  assert.match(
    sql,
    /CREATE TABLE IF NOT EXISTS automation_sync_read_owner_generation/,
  );
  assert.match(sql, /PRIMARY KEY \(execution_target, stream\)/);
  assert.match(sql, /\bgeneration\b/);
  assert.match(sql, /\bpayload_digest\b/);
  assert.match(sql, /\blast_emitted_generation\b/);
  assert.doesNotMatch(
    sql.replace(/^--.*$/gm, ''),
    /\b(?:payload|value|account_id|record_ids|edge_id)\b/i,
  );
  assert.doesNotMatch(sql.replace(/^--.*$/gm, ''), /\b(?:DROP|ALTER)\b/i);
});

test('0086 keeps A1 owner revision on session_config_global rather than a parallel authority', async () => {
  const sql = await readFile(
    new URL(
      '../../migrations/0086_session_config_global_sync_read_revision.sql',
      import.meta.url,
    ),
    'utf8',
  );
  assert.match(sql, /-- aidcp:kind=expand/);
  assert.match(sql, /ALTER TABLE session_config_global/);
  assert.match(sql, /sync_read_revision NUMERIC NOT NULL DEFAULT 0/);
  assert.doesNotMatch(sql, /\bCREATE TABLE\b/);
  assert.doesNotMatch(sql.replace(/^--.*$/gm, ''), /\bevent_outbox\b/);
  assert.doesNotMatch(sql.replace(/^--.*$/gm, ''), /\bDROP\b/i);
});

test('0087 stores the B4 shared cursor on the shared projection state row', async () => {
  const sql = await readFile(
    new URL(
      '../../migrations/0087_automation_account_projection_shared_cursor.sql',
      import.meta.url,
    ),
    'utf8',
  );
  assert.match(sql, /-- aidcp:kind=expand/);
  assert.match(sql, /ALTER TABLE automation_account_projection_state/);
  assert.match(sql, /sync_read_cursor NUMERIC/);
  assert.match(sql, /sync_read_payload_digest TEXT/);
  assert.match(sql, /sync_read_source_as_of_ms BIGINT/);
  assert.match(sql, /automation_account_projection_state_sync_read_check/);
  assert.match(sql, /sync_read_cursor IS NOT NULL/);
  assert.match(sql, /sync_read_payload_digest IS NOT NULL/);
  assert.match(sql, /sync_read_source_as_of_ms IS NOT NULL/);
  assert.doesNotMatch(sql.replace(/^--.*$/gm, ''), /\bCREATE TABLE\b/);
  assert.doesNotMatch(sql.replace(/^--.*$/gm, ''), /\bDROP\b/i);
});

/**
 * 检查点表的 CHECK 约束里那份流名清单，是同一份名单的**第四个手抄副本**
 * （另三份：组装根自举名单、automation 私有组装根的消费流清单、镜像类的 apply 分支）。
 *
 * **前三份漏了会被 typecheck 或用例接住；这一份漏了只有真连库才现形** ——
 * 实测代价是：进程起得来、快照也拉到了，写检查点时被约束拒收 → 启动期抛错 → 服务起不来。
 * 批 E-2 步骤 2 就是这么让 dev 挂了一次（0106 是补的那条迁移）。
 *
 * 故这里按**流定义**算出应有集合去比对，而不是再写一份人肉清单。
 */
test('检查点表允许的流名 MUST 覆盖全部 automation 消费流（第四份手抄副本的防漂移闸）', async () => {
  const files = (await readdir(new URL('../../migrations/', import.meta.url)))
    .filter((name) => name.endsWith('.sql'))
    .sort();
  const allowed = new Set<string>();
  for (const file of files) {
    const sql = await readFile(
      new URL(`../../migrations/${file}`, import.meta.url),
      'utf8',
    );
    if (!sql.includes('automation_sync_read_consumer_checkpoint')) continue;
    const block = sql.match(/stream\s+IN\s*\(([^)]*)\)/i);
    if (!block) continue;
    // 后一条迁移整体重建约束 ⇒ 以最后出现的那份为准。
    allowed.clear();
    for (const raw of block[1].split(',')) {
      const name = raw.trim().replace(/^'|'$/g, '');
      if (name) allowed.add(name);
    }
  }

  const expected = (
    Object.keys(SYNC_READ_STREAM_DEFINITIONS) as SyncReadStream[]
  ).filter(
    (stream) => SYNC_READ_STREAM_DEFINITIONS[stream].consumer === 'automation',
  );
  assert.deepEqual(
    [...allowed].sort(),
    [...expected].sort(),
    '约束里的流名集合与 automation 消费流对不上 —— 少一条就是「进程起不来」，'
      + '多一条是允许写入一个本进程根本不消费的流',
  );
});
