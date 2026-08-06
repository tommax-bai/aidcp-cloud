import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, test } from 'node:test';

/**
 * change unify-facebook-global-policy-across-targets §4.2 / §4.3 / §4.6 —— 迁移的合并取值规则。
 *
 * **这些断言读的是迁移 SQL 本身**（与本仓既有的 `search-activity-migration.test.ts` 同一写法）。
 * 得说清它能证什么、不能证什么：它不执行 SQL，所以证明不了「跑一遍会得到某个结果」；
 * 它守的是**取值方向**——而这条迁移里所有真正会造成损失的错法，恰好都是方向反了：
 *   - 完成时刻取 max 而不是 min ⇒ 把一个已按毕业档运行的账号重新关回冷启动；
 *   - 优先级把 ol 排在 dev 前 ⇒ 整套取值基准与裁定相反；
 *   - 把「没有行」当成「那一侧配置了默认值」参与竞争 ⇒ 群评论那格的 72 小时被悄悄改回 24。
 * 方向反了在真库上同样不报错，只是数值不同 —— 所以「跑得通」本来也拦不住它们。
 */

const MIGRATION = new URL(
  '../migrations/0110_facebook_global_policy_single_scope.sql',
  import.meta.url,
);

/** 抠出某个 INSERT ... SELECT 语句块，避免断言跨语句串味。 */
function statementFor(sql: string, table: string): string {
  const start = sql.indexOf(`INSERT INTO ${table} (`);
  assert.notEqual(start, -1, `迁移里应有针对 ${table} 的 INSERT`);
  const end = sql.indexOf(';', start);
  assert.notEqual(end, -1, `${table} 的 INSERT 应有结束分号`);
  return sql.slice(start, end);
}

describe('0110 合并取值规则', () => {
  test('完成事实按环境取更早的完成时刻，MUST NOT 取更晚', async () => {
    const sql = await readFile(MIGRATION, 'utf8');
    const statement = statementFor(sql, 'facebook_environment_slow_start_completion');

    // 取更早：完成是既成事实，早一点只是让它早点走安全限额；
    // 取更晚会把一个已经按毕业档在跑的账号重新关回冷启动曲线。
    assert.match(statement, /min\(\s*src\.completed_at\s*\)/i);
    assert.doesNotMatch(statement, /max\(\s*src\.completed_at\s*\)/i);
    // 按环境聚合，而不是整表取一个时刻。
    assert.match(statement, /GROUP BY\s+src\.env_key/i);
  });

  test('完成事实只从既有记录里合并，且不覆盖已存在的合并行', async () => {
    const sql = await readFile(MIGRATION, 'utf8');
    const statement = statementFor(sql, 'facebook_environment_slow_start_completion');

    // 只读非合并行 —— 否则再跑一次会把上一轮的合并结果当作输入，自己喂自己。
    assert.match(statement, /WHERE\s+src\.execution_target\s*<>\s*'all'/i);
    // 幂等：重跑不改已经在的合并行。
    assert.match(statement, /ON CONFLICT\s*\([^)]*env_key[^)]*\)\s*DO NOTHING/i);
  });

  for (const table of ['facebook_operation_global_policy', 'facebook_group_comment_policy']) {
    test(`${table}：两侧都有取 dev，只有一侧则取那一侧`, async () => {
      const sql = await readFile(MIGRATION, 'utf8');
      const statement = statementFor(sql, table);

      // 优先级必须把 dev 排在前（CASE ... WHEN 'dev' THEN 0 ELSE 1）。
      // 写反了不会报错，只会让整套基准变成 ol —— 与裁定相反。
      assert.match(statement, /ORDER BY\s+CASE\s+src\.execution_target\s+WHEN\s+'dev'\s+THEN\s+0\s+ELSE\s+1\s+END/i);
      assert.match(statement, /LIMIT\s+1/i);

      // **只从存在的行里挑**：源是表本身、且排除合并行。
      // 这一条是 §4.2 的承重点 —— 「没有行」是缺席，MUST NOT 被当成
      // 「那一侧配置了默认值」而与另一侧被人写下的值同权竞争。
      // 群评论策略的 dev 侧正是没有行；若这里改成先补默认再合并，
      // 运营手写的 72 小时会被悄悄换回默认 24，而且一处都不会报错。
      assert.match(statement, new RegExp(`FROM\\s+${table}\\s+src`, 'i'));
      assert.match(statement, /WHERE\s+src\.execution_target\s*<>\s*'all'/i);
      assert.doesNotMatch(statement, /COALESCE|DEFAULT|VALUES\s*\(/i);

      // 幂等：重跑不改已经在的合并行。
      assert.match(statement, /ON CONFLICT\s*\(\s*execution_target\s*\)\s*DO NOTHING/i);
    });
  }

  test('合并行的 revision 接在现有序列之后，两侧不各起一条', async () => {
    const sql = await readFile(MIGRATION, 'utf8');
    for (const table of ['facebook_operation_global_policy', 'facebook_group_comment_policy']) {
      const statement = statementFor(sql, table);
      // 取全表 max+1：合并之后 revision 是**一条**序列，CAS 才拦得住两侧并发写。
      assert.match(
        statement,
        new RegExp(`\\(\\s*SELECT\\s+max\\(revision\\)\\s+FROM\\s+${table}\\s*\\)\\s*\\+\\s*1`, 'i'),
        `${table} 的合并行 revision 应取全表 max+1`,
      );
    }
  });

  test('本迁移只放宽、不删除：dev / ol 两行与分行列都还在，回滚才有落点', async () => {
    const sql = await readFile(MIGRATION, 'utf8');
    // 收缩（删列 / 删行）按目录纪律是独立 change、独立部署、可单独回滚，
    // MUST NOT 与 expand 同批交付。这里出现任何一种都说明两段被合并了。
    assert.doesNotMatch(sql, /DROP\s+COLUMN\s+execution_target/i);
    assert.doesNotMatch(sql, /DELETE\s+FROM\s+facebook_(operation_global_policy|group_comment_policy)/i);
    assert.match(sql, /aidcp:kind=expand/);
  });
});
