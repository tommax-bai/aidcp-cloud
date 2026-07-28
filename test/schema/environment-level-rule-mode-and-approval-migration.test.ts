/**
 * SQL 合同用例（change environment-level-rule-mode-and-approval）。零数据库依赖：只读迁移文本。
 *
 * 这条迁移的四件事必须逐条钉死，因为它们全是「跑过一次就很难再验」的一次性动作：
 *   ① expand 形态：不删旧账号键表 / 列，不加 NOT NULL；
 *   ② 新表的定义身份 DEFAULT / CHECK 与账号键旧表当前状态逐条对齐（回填是原样拷贝）；
 *   ③ 回填只认唯一绑定，三种歧义一律跳过并写具名原因；
 *   ④ 进度 / 去重 / 批次三张表按设计保持账号键，本迁移一个字都不能碰。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import {
  FACEBOOK_RULE_DEFINITION_ID,
  FACEBOOK_RULE_DEFINITION_VERSION,
  FACEBOOK_RULE_LEGACY_DEFINITION_ID,
  FACEBOOK_RULE_LEGACY_DEFINITION_VERSION,
} from '../../src/kernel/facebook-rule-mode-types.js';

const MIGRATION = new URL(
  '../../migrations/0096_environment_level_rule_mode_and_approval.sql',
  import.meta.url,
);

/** 账号键旧表的定义身份现状由这条迁移决定；新表必须与它逐条对齐。 */
const ACCOUNT_KEYED_TWO_TIER = new URL(
  '../../migrations/0094_facebook_rule_two_tier_config.sql',
  import.meta.url,
);

function stripSqlComments(sql: string): string {
  return sql.split('\n').map((line) => line.replace(/--.*$/, '')).join('\n');
}

test('0096 是 expand：建环境键表 + 加跳过原因列，不删旧账号键表也不加 NOT NULL', async () => {
  const raw = await readFile(MIGRATION, 'utf8');
  assert.match(raw, /aidcp:kind=expand/);
  assert.match(raw, /aidcp:objects=table:facebook_rule_mode_environment_config,table:environment_comment_approval_policy/);

  const sql = stripSqlComments(raw);
  // 环境键 = 主键，天然唯一：一个环境至多一行配置。
  assert.match(sql, /CREATE TABLE IF NOT EXISTS facebook_rule_mode_environment_config \(\s*\n\s*env_key\s+TEXT PRIMARY KEY REFERENCES client_environments\(env_key\) ON DELETE CASCADE/);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS environment_comment_approval_policy \(\s*\n\s*env_key\s+TEXT PRIMARY KEY REFERENCES client_environments\(env_key\) ON DELETE CASCADE/);
  assert.match(sql, /mode\s+TEXT NOT NULL CHECK \(mode IN \('source_rules','auto_approve_all'\)\)/);

  // 旧账号键表只多挂一列跳过原因，其余一个字不动。
  assert.match(sql, /ALTER TABLE facebook_rule_mode_config\s*\n\s*ADD COLUMN IF NOT EXISTS env_backfill_skip_reason TEXT;/);
  assert.match(sql, /ALTER TABLE account_comment_approval_policy\s*\n\s*ADD COLUMN IF NOT EXISTS env_backfill_skip_reason TEXT;/);
  for (const forbidden of [
    /\bDROP\s+TABLE\b/i, /\bDROP\s+COLUMN\b/i, /\bDROP\s+CONSTRAINT\b/i,
    /\bRENAME\s+(TO|COLUMN)\b/i, /\bSET\s+NOT\s+NULL\b/i, /\bDELETE\s+FROM\b/i,
  ]) {
    assert.doesNotMatch(sql, forbidden, `expand 迁移 MUST NOT 出现 ${forbidden}`);
  }
});

test('0096 新表的定义身份与账号键旧表逐条对齐：DEFAULT 跟当前定义、CHECK 新旧都接受', async () => {
  const [sql, accountKeyed] = await Promise.all([
    readFile(MIGRATION, 'utf8').then(stripSqlComments),
    readFile(ACCOUNT_KEYED_TWO_TIER, 'utf8').then(stripSqlComments),
  ]);

  // DEFAULT 必须是**代码常量当前值**。钉死成字面量而不引用常量，就会在下一次换节奏时静默过期。
  assert.match(
    sql,
    new RegExp(`definition_id\\s+TEXT NOT NULL DEFAULT '${FACEBOOK_RULE_DEFINITION_ID}'`),
  );
  assert.match(
    sql,
    new RegExp(`definition_version\\s+INTEGER NOT NULL DEFAULT ${FACEBOOK_RULE_DEFINITION_VERSION}`),
  );

  // CHECK 必须新旧都接受：回填是**原样拷贝**旧表的定义身份，而旧表两种身份都可能在。
  // 只允许一个值 ⇒ 这条迁移在有存量行的库上必然被 23514 拒绝、整体失败。
  const check = /CHECK \(definition_id IN \(([\s\S]*?)\)\)/.exec(sql);
  assert.ok(check, '定义号 CHECK MUST 是取值集合而不是单值等号');
  for (const accepted of [FACEBOOK_RULE_DEFINITION_ID, FACEBOOK_RULE_LEGACY_DEFINITION_ID]) {
    assert.match(check![1], new RegExp(`'${accepted}'`), `${accepted} 必须被接受`);
  }
  assert.match(
    sql,
    new RegExp(
      `CHECK \\(definition_version IN \\(${FACEBOOK_RULE_LEGACY_DEFINITION_VERSION}, ${FACEBOOK_RULE_DEFINITION_VERSION}\\)\\)`,
    ),
  );

  // 与账号键旧表的现状**逐条同源**：旧表接受的每个定义号，新表都必须接受。
  // 少接受一个，回填就会在那批行上炸；这条断言让两边今后一起改，而不是各自漂。
  const accountAccepted = [...accountKeyed.matchAll(/'(facebook_browse_[a-z0-9_]+)'/g)]
    .map((m) => m[1]);
  assert.ok(accountAccepted.length > 0, '账号键旧表的定义号取值必须能被读出来');
  for (const accepted of new Set(accountAccepted)) {
    assert.match(check![1], new RegExp(`'${accepted}'`), `旧表接受 ${accepted}，新表也必须接受`);
  }

  // 回填 MUST 原样拷贝定义身份：改写成当前定义会把「这一行原本处在哪套节奏」这条事实抹掉。
  const backfill = /INSERT INTO facebook_rule_mode_environment_config[\s\S]*?;/.exec(sql)?.[0] ?? '';
  assert.match(backfill, /c\.definition_id, c\.definition_version/, '回填 MUST 原样拷贝定义身份');
  assert.doesNotMatch(
    backfill,
    new RegExp(`'${FACEBOOK_RULE_DEFINITION_ID}'`),
    '回填 MUST NOT 用当前定义常量顶替存量行的定义身份',
  );
});

test('0096 回填只认唯一绑定：多环境与跨客户争用都不回填', async () => {
  const sql = stripSqlComments(await readFile(MIGRATION, 'utf8'));
  // 绑定判据：环境个数与归属客户数都按 DISTINCT 计（避免一对多把计数放大成假冲突）。
  const bindings = sql.match(/WITH bindings AS \([\s\S]*?\)\n/g) ?? [];
  assert.equal(bindings.length, 4, '两次回填 + 两次跳过标注各自带同一份绑定判据');
  for (const cte of bindings) {
    assert.match(cte, /count\(DISTINCT e\.env_key\)\s+AS env_count/);
    assert.match(cte, /count\(DISTINCT s\.user_id\)\s+AS owner_count/);
    assert.match(cte, /LEFT JOIN client_env_scope s\s*\n\s*ON s\.env_key = e\.env_key AND s\.source = 'admin'/);
  }
  // 回填入口的准入条件：唯一环境 且 至多一个归属客户。
  const inserts = sql.match(/WHERE b\.env_count = 1 AND b\.owner_count <= 1/g) ?? [];
  assert.equal(inserts.length, 2, '两张表的回填都要带同一条准入条件');
  assert.match(sql, /INSERT INTO facebook_rule_mode_environment_config[\s\S]*?ON CONFLICT \(env_key\) DO NOTHING;/);
  assert.match(sql, /INSERT INTO environment_comment_approval_policy[\s\S]*?ON CONFLICT \(env_key\) DO NOTHING;/);
});

test('0096 跳过的行写具名原因，三种判据齐全且可被查询出来', async () => {
  const sql = stripSqlComments(await readFile(MIGRATION, 'utf8'));
  for (const table of ['facebook_rule_mode_config', 'account_comment_approval_policy']) {
    const updates = sql.match(
      new RegExp(`UPDATE ${table} c\\n\\s*SET env_backfill_skip_reason = resolved\\.skip_reason[\\s\\S]*?;`),
    );
    assert.ok(updates, `${table} 必须写下具名跳过原因`);
    assert.match(updates![0], /WHEN b\.account_id IS NULL THEN 'environment_missing'/);
    assert.match(updates![0], /WHEN b\.env_count > 1\s+THEN 'binding_conflict'/);
    assert.match(updates![0], /WHEN b\.owner_count > 1\s+THEN 'cross_customer_contention'/);
  }
  // 跳过条数必须被喊出来，MUST NOT 静默。
  assert.match(sql, /RAISE NOTICE '\[0096\][\s\S]*?未回填 % 行/);
});

test('0096 一个字都不碰进度 / 浏览去重 / 批次终态三张账号键表', async () => {
  const raw = await readFile(MIGRATION, 'utf8');
  const sql = stripSqlComments(raw);
  for (const table of ['facebook_rule_progress', 'facebook_rule_view_fact', 'facebook_rule_batch']) {
    assert.doesNotMatch(sql, new RegExp(table), `${table} 按设计保持账号键，MUST NOT 出现在本迁移的可执行 SQL 里`);
    assert.doesNotMatch(raw.split('\n').filter((l) => l.startsWith('-- aidcp:objects')).join('\n'),
      new RegExp(table), `${table} MUST NOT 出现在对象声明里`);
  }
});
