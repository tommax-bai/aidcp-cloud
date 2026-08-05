-- 0110_facebook_global_policy_single_scope.sql
-- aidcp:kind=expand
-- aidcp:objects=table:facebook_operation_global_policy,table:facebook_operation_global_policy_audit
-- aidcp:objects=table:facebook_group_comment_policy,table:facebook_group_comment_policy_audit
-- aidcp:objects=table:facebook_environment_slow_start_completion
-- 约束名在 PG 里反推不出所属表，只声明约束会让归属推断落进「残留」分支、把这条迁移计入
-- 全部属主库。这五张表都是 api 属主，故表声明必须写上——否则拆库后它会被派去自动化库跑。
-- aidcp:objects=constraint:facebook_operation_global_policy_execution_target_check
-- aidcp:objects=constraint:facebook_operation_global_policy_audit_execution_target_check
-- aidcp:objects=constraint:facebook_group_comment_policy_execution_target_check
-- aidcp:objects=constraint:facebook_group_comment_policy_audit_execution_target_check
-- aidcp:objects=constraint:facebook_environment_slow_start_completion_execution_target_check
--
-- change unify-facebook-global-policy-across-targets（第一段：expand 切读）。
--
-- Facebook 全局运营策略与冷启动完成事实此前按 execution_target 各存一份，而同一件事的起点
-- （环境表上的慢启动起点列）与安全限额（自动化域的限额配置）本来就是共享的。隔离切了一半，
-- 于是同一个账号「起点只有一个、天数有两个、完成状态有两个」。已经付过一次代价：运营在 dev 后台
-- 把冷启动改成 5 天，OL 仍是 7 天，OL 上第 6/7 天的账号一直显示未完成、配额继续被冷启动曲线夹住，
-- 两边各自都在如实汇报自己那份配置算出来的结果，所以没有任何一处报错。
--
-- ## 为什么是「放宽取值 + 写一行合并行」，而不是「删掉分行键」
--
-- 终点确实是删掉 execution_target 这个分行键，但本目录的纪律写着：**收缩 MUST 是独立 change、
-- 独立部署、可单独回滚，MUST NOT 与 expand 同批交付**。删列属收缩（旧代码在它之后会坏）。
-- 所以拆成两段：
--   本段（expand）：把 CHECK 放宽到接受 SCOPE_ALL，写入一行合并行，代码切读该行。
--   下一段（contract，独立 change）：切读稳定后，删掉 dev/ol 两行与该列。
--
-- 这样安排还顺带给出了回滚故事：切读出问题就把代码回滚，旧的 dev/ol 两行原样还在。
-- **但它们从本迁移那一刻起就是冻结的**——回滚后读到的是合并当时的旧值，不含合并之后的任何编辑。
-- 回滚窗口因此是有限的，必须写进迁移记录。
--
-- ## 合并取值规则（与 spec facebook-global-policy-single-scope 同源）
--
-- 1. 主策略与群评论策略：两行都在取 dev，只有一行取那一行。**「没有行」是缺席，MUST NOT 被当成
--    「那一侧配置了默认值」而与另一侧被人写下的值同权竞争**——群评论策略的 dev 侧正是没有行，
--    照搬它等于把运营手写过的 72 小时窗口悄悄改回默认 24。
-- 2. 完成事实：同一环境多侧都有记录取**更早**的完成时刻。完成是「该账号已经毕业」的既成事实，
--    取更早只会让它早一点走安全限额；取更晚会把一个已按毕业档运行的账号重新关回冷启动。
-- 3. revision：从各侧历史最大值之上开始，使既有审计记录无需重写即可与新序列共存。

-- ── 1. 五处 CHECK 放宽到接受 'all' ────────────────────────────────────────────
-- 审计表两处同样要放宽：新审计行写 'all'，唯一约束 (execution_target, new_revision) 原样保留，
-- 于是新序列与历史两组天然不冲突，历史行一行不改。

ALTER TABLE facebook_operation_global_policy
  DROP CONSTRAINT IF EXISTS facebook_operation_global_policy_execution_target_check;
ALTER TABLE facebook_operation_global_policy
  ADD CONSTRAINT facebook_operation_global_policy_execution_target_check
    CHECK (execution_target IN ('dev', 'ol', 'all'));

ALTER TABLE facebook_operation_global_policy_audit
  DROP CONSTRAINT IF EXISTS facebook_operation_global_policy_audit_execution_target_check;
ALTER TABLE facebook_operation_global_policy_audit
  ADD CONSTRAINT facebook_operation_global_policy_audit_execution_target_check
    CHECK (execution_target IN ('dev', 'ol', 'all'));

ALTER TABLE facebook_group_comment_policy
  DROP CONSTRAINT IF EXISTS facebook_group_comment_policy_execution_target_check;
ALTER TABLE facebook_group_comment_policy
  ADD CONSTRAINT facebook_group_comment_policy_execution_target_check
    CHECK (execution_target IN ('dev', 'ol', 'all'));

ALTER TABLE facebook_group_comment_policy_audit
  DROP CONSTRAINT IF EXISTS facebook_group_comment_policy_audit_execution_target_check;
ALTER TABLE facebook_group_comment_policy_audit
  ADD CONSTRAINT facebook_group_comment_policy_audit_execution_target_check
    CHECK (execution_target IN ('dev', 'ol', 'all'));

ALTER TABLE facebook_environment_slow_start_completion
  DROP CONSTRAINT IF EXISTS facebook_environment_slow_start_completion_execution_target_check;
ALTER TABLE facebook_environment_slow_start_completion
  ADD CONSTRAINT facebook_environment_slow_start_completion_execution_target_check
    CHECK (execution_target IN ('dev', 'ol', 'all'));

-- ── 2. 主策略：写入合并行 ────────────────────────────────────────────────────
-- 取值优先 dev、其次 ol；两者都无则本段不建行（全新空库上 0103 已 seed 两行，走不到这条）。
-- revision 取全表最大值 +1。已存在 'all' 行则本段幂等跳过（迁移可重复执行的前提）。

INSERT INTO facebook_operation_global_policy (
  execution_target,
  persona_reel_views_per_like,
  persona_reel_views_per_follow,
  slow_start_reel_views_per_like,
  slow_start_reel_views_per_follow,
  rule_reel_views_per_follow,
  consumption_reel_views_per_follow,
  rule_views_per_like,
  rule_join_every_n_rounds,
  consumption_views_per_like,
  consumption_confirmed_likes_per_join,
  consumption_confirmed_joins_per_comment,
  slow_start_total_days,
  slow_start_daily_caps,
  revision,
  updated_at,
  updated_by
)
SELECT
  'all',
  src.persona_reel_views_per_like,
  src.persona_reel_views_per_follow,
  src.slow_start_reel_views_per_like,
  src.slow_start_reel_views_per_follow,
  src.rule_reel_views_per_follow,
  src.consumption_reel_views_per_follow,
  src.rule_views_per_like,
  src.rule_join_every_n_rounds,
  src.consumption_views_per_like,
  src.consumption_confirmed_likes_per_join,
  src.consumption_confirmed_joins_per_comment,
  src.slow_start_total_days,
  src.slow_start_daily_caps,
  (SELECT max(revision) FROM facebook_operation_global_policy) + 1,
  now(),
  'migration:0110_facebook_global_policy_single_scope'
FROM facebook_operation_global_policy src
WHERE src.execution_target <> 'all'
ORDER BY CASE src.execution_target WHEN 'dev' THEN 0 ELSE 1 END
LIMIT 1
ON CONFLICT (execution_target) DO NOTHING;

-- ── 3. 群评论策略：同一取值规则 ──────────────────────────────────────────────
-- 现实数据里 dev 侧没有行、ol 侧有运营手写的 72 小时；本语句只从**存在的行**里挑，
-- 因此 dev 的缺席不会把 72 变回 24。

INSERT INTO facebook_group_comment_policy (
  execution_target,
  join_to_first_comment_hours,
  revision,
  updated_at,
  updated_by
)
SELECT
  'all',
  src.join_to_first_comment_hours,
  (SELECT max(revision) FROM facebook_group_comment_policy) + 1,
  now(),
  'migration:0110_facebook_global_policy_single_scope'
FROM facebook_group_comment_policy src
WHERE src.execution_target <> 'all'
ORDER BY CASE src.execution_target WHEN 'dev' THEN 0 ELSE 1 END
LIMIT 1
ON CONFLICT (execution_target) DO NOTHING;

-- ── 4. 完成事实：按环境取更早的完成时刻 ──────────────────────────────────────

INSERT INTO facebook_environment_slow_start_completion (
  env_key,
  execution_target,
  completed_at
)
SELECT
  src.env_key,
  'all',
  min(src.completed_at)
FROM facebook_environment_slow_start_completion src
WHERE src.execution_target <> 'all'
GROUP BY src.env_key
ON CONFLICT (env_key, execution_target) DO NOTHING;
