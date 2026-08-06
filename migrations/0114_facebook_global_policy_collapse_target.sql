-- 0114_facebook_global_policy_collapse_target.sql
-- aidcp:kind=contract
-- aidcp:objects=table:facebook_operation_global_policy,table:facebook_group_comment_policy
-- aidcp:objects=table:facebook_environment_slow_start_completion
-- aidcp:objects=column:facebook_operation_global_policy.singleton
-- aidcp:objects=column:facebook_group_comment_policy.singleton
-- aidcp:objects=constraint:facebook_operation_global_policy_singleton_check
-- aidcp:objects=constraint:facebook_group_comment_policy_singleton_check
-- 本条删掉的、由更早迁移声明过的对象。不写这几行不会报错，只会让 `migrate verify` 从此
-- 挂着四条假缺失（声明在 0103 / 0110，而那两个文件的校验和已落账、改不得），
-- 而缺失清单是 `migrate baseline` 唯一的准入闸 —— 新建属主库会被永久拒绝。
-- aidcp:retires=constraint:facebook_operation_global_policy_execution_target_check
-- aidcp:retires=constraint:facebook_group_comment_policy_execution_target_check
-- aidcp:retires=constraint:facebook_env_slow_start_completion_scope_check
-- aidcp:retires=index:idx_facebook_environment_slow_start_completion_target
--
-- change collapse-facebook-global-policy-target-column（第二段：contract 收缩）。
--
-- 0110 把这三张表收成「唯一一份」用的是**放宽 CHECK + 写一行作用域为 'all' 的合并行 + 代码切读**，
-- dev / ol 两行与 execution_target 这个分行列原样留着。留着的代价是具体的：
--
--   · 那两行谁都能写、代码一行都不读。往那儿改一笔会成功、不报错、不生效 —— 改的人以为改了。
--     这正是本条链路一开始要根治的毛病（两边各自如实汇报自己那份配置算出来的结果，
--     所以没有任何一处报错），换了个位置又长出来一遍。
--   · 它们自 0110 那一刻起就是冻结的。回滚到旧代码读到的是合并当时的值、不含之后任何编辑，
--     所以「旧行还在 = 还能回滚」这个故事每过一天越不成立。
--
-- ## 回滚语义已经变了，MUST NOT 照抄 0110 的说法
--
-- 删列是收缩：此后任何仍按运行目标过滤的构建都读不到这三张表，且**不会报错退出**，
-- 只是读不到策略。回滚代码救不了，唯一退路是**迁移前备份**。执行本条前必须先导出三张表，
-- 并把导出时刻与文件位置写进迁移记录。发布分支在发往任一环境前 MUST 已含本条。
--
-- ## 审计表一个字节都不动
--
-- 两张 *_audit 的 execution_target、CHECK 与 UNIQUE (execution_target, new_revision) 全部保留。
-- 直觉上「revision 已是一条序列 ⇒ 唯一约束应收紧成只按 new_revision」，但实测否掉了它：
-- 合并之前各目标的 revision 是各自独立的序列，历史行因此跨目标重复（2026-08-06 实测
-- facebook_operation_global_policy_audit 14 行里有 3 个 new_revision 出现两次），收紧会当场失败。
-- 而保留原约束对新行同样给出「每个 revision 至多一条审计」——新行作用域恒为 'all'。
-- 主表旧行删掉之后，审计上的这个字段是「合并之前各目标各是什么」唯一的留存处。

-- ── 1. 数据前置：逐条断言，任一不成立即整条失败回滚 ──────────────────────────
-- MUST NOT 退化成「只删通过检查的那部分行」：那会把一次数据不一致变成一次静默的部分删除。
-- 这里 MUST 实测当次数值，MUST NOT 引用任何写在文档里的实测快照。

DO $$
DECLARE
  uncovered  bigint;
  duplicated bigint;
  regressed  bigint;
  orphaned   text;
BEGIN
  -- ① 合并行必须已覆盖被删行的全部 env_key。
  --    不成立就删旧行 = 丢掉一条毕业事实，把一个已按毕业档运行的账号重新关回冷启动曲线。
  SELECT count(*) INTO uncovered FROM (
    SELECT DISTINCT env_key FROM facebook_environment_slow_start_completion
     WHERE execution_target <> 'all'
    EXCEPT
    SELECT env_key FROM facebook_environment_slow_start_completion
     WHERE execution_target = 'all'
  ) t;
  IF uncovered > 0 THEN
    RAISE EXCEPTION
      '0114 前置①不成立：% 个 env_key 的毕业事实只存在于 dev/ol 行上，合并行没有覆盖到；删旧行会丢失毕业事实',
      uncovered;
  END IF;

  -- ② 合并行内 env_key 不得重复，否则主键收敛到 (env_key) 会失败。
  SELECT count(*) INTO duplicated FROM (
    SELECT env_key FROM facebook_environment_slow_start_completion
     WHERE execution_target = 'all'
     GROUP BY env_key HAVING count(*) > 1
  ) t;
  IF duplicated > 0 THEN
    RAISE EXCEPTION '0114 前置②不成立：合并行内有 % 个重复 env_key，主键无法收敛到 (env_key)', duplicated;
  END IF;

  -- ③ 每个环境的合并完成时刻不得晚于它任一被删行 —— 对 0110「取更早」那条规则的事后复核。
  --    不成立说明合并当时取错了方向，此时删旧行会把证据一起删掉。
  SELECT count(DISTINCT a.env_key) INTO regressed
    FROM facebook_environment_slow_start_completion a
    JOIN facebook_environment_slow_start_completion o
      ON o.env_key = a.env_key AND o.execution_target <> 'all'
   WHERE a.execution_target = 'all' AND a.completed_at > o.completed_at;
  IF regressed > 0 THEN
    RAISE EXCEPTION
      '0114 前置③不成立：% 个环境的合并完成时刻晚于其旧行，0110 的「取更早」在这些行上没有成立',
      regressed;
  END IF;

  -- ④ 两张策略表：有旧行就必须有合并行。
  --    design 里的三条前置只覆盖完成事实表，但策略表漏掉这一条的后果同样是静默丢配置 ——
  --    群评论策略的 dev 侧本来就没有行、ol 侧是运营手写的 72 小时，
  --    若合并行不存在，删 ol 行等于把那个 72 小时删掉，而代码只会退回「默认档」不报错。
  SELECT string_agg(t, ', ') INTO orphaned FROM (
    SELECT 'facebook_operation_global_policy' AS t
     WHERE EXISTS (SELECT 1 FROM facebook_operation_global_policy WHERE execution_target <> 'all')
       AND NOT EXISTS (SELECT 1 FROM facebook_operation_global_policy WHERE execution_target = 'all')
    UNION ALL
    SELECT 'facebook_group_comment_policy'
     WHERE EXISTS (SELECT 1 FROM facebook_group_comment_policy WHERE execution_target <> 'all')
       AND NOT EXISTS (SELECT 1 FROM facebook_group_comment_policy WHERE execution_target = 'all')
  ) t;
  IF orphaned IS NOT NULL THEN
    RAISE EXCEPTION '0114 前置④不成立：% 还有按目标分行的旧行、却没有合并行；删旧行会静默丢掉运营写下的配置', orphaned;
  END IF;
END
$$;

-- ── 2. 删除作用域不是 'all' 的历史行 ─────────────────────────────────────────
-- MUST 排在改主键之前：同一 env_key 在 dev 与 ol 各有一行时，(env_key) 这个主键还不成立。

DELETE FROM facebook_operation_global_policy WHERE execution_target <> 'all';
DELETE FROM facebook_group_comment_policy WHERE execution_target <> 'all';
DELETE FROM facebook_environment_slow_start_completion WHERE execution_target <> 'all';

-- ── 3. 两张策略表：分行键换成单例约束 ────────────────────────────────────────
-- 删列之后这两张表就没有主键了。**MUST NOT 就这么放着**：一张没有唯一性约束的配置表，
-- 插入第二行不会报错，而读路径拿到的是「某一行」，于是同一次部署里两个进程可能读到不同值、
-- 且没有任何一处报错 —— 正是这条链路一直在付代价的那种「靠人记得、不靠机器拦」的保证。
--
-- 用取值集合只有一个元素的单例列：PRIMARY KEY (singleton) + CHECK (singleton)，
-- 第二行在库层面插不进去。MUST NOT 改成「execution_target 只留一个合法值」——
-- 那等于把分行维度改名留下，下一个人照样能往里加值；要消除的就是这个维度本身。
--
-- 约束名 MUST ≤63 字节：0110 曾因自动名 65 字节被 PG 截断、按全名 DROP 不命中且**不报错**，
-- 老约束原样留着、新约束以另一个名字并存，于是写入被老约束拒绝。这里两个名字都是 47 / 45 字节。

ALTER TABLE facebook_operation_global_policy
  ADD COLUMN IF NOT EXISTS singleton boolean NOT NULL DEFAULT true;
ALTER TABLE facebook_operation_global_policy
  DROP CONSTRAINT IF EXISTS facebook_operation_global_policy_pkey;
ALTER TABLE facebook_operation_global_policy
  ADD PRIMARY KEY (singleton);
ALTER TABLE facebook_operation_global_policy
  ADD CONSTRAINT facebook_operation_global_policy_singleton_check CHECK (singleton);
-- 列级 CHECK 随列一起消失，故 facebook_operation_global_policy_execution_target_check
-- 不需要（也不应该）单独 DROP —— 它已在本文件头的 aidcp:retires 里如实登记。
ALTER TABLE facebook_operation_global_policy
  DROP COLUMN execution_target;

ALTER TABLE facebook_group_comment_policy
  ADD COLUMN IF NOT EXISTS singleton boolean NOT NULL DEFAULT true;
ALTER TABLE facebook_group_comment_policy
  DROP CONSTRAINT IF EXISTS facebook_group_comment_policy_pkey;
ALTER TABLE facebook_group_comment_policy
  ADD PRIMARY KEY (singleton);
ALTER TABLE facebook_group_comment_policy
  ADD CONSTRAINT facebook_group_comment_policy_singleton_check CHECK (singleton);
ALTER TABLE facebook_group_comment_policy
  DROP COLUMN execution_target;

-- ── 4. 完成事实表：主键收敛到 (env_key) ──────────────────────────────────────
-- 索引 idx_facebook_environment_slow_start_completion_target 建在 (execution_target, completed_at DESC)
-- 上，随列一起消失；显式 DROP 只是为了让这件事在文件里看得见，而不是靠读者知道 PG 会级联。
-- 不补建替代索引：它唯一的用途是「按运行目标筛完成事实」，而这个维度正是本条要消除的。

ALTER TABLE facebook_environment_slow_start_completion
  DROP CONSTRAINT IF EXISTS facebook_environment_slow_start_completion_pkey;
ALTER TABLE facebook_environment_slow_start_completion
  ADD PRIMARY KEY (env_key);
DROP INDEX IF EXISTS idx_facebook_environment_slow_start_completion_target;
ALTER TABLE facebook_environment_slow_start_completion
  DROP COLUMN execution_target;
