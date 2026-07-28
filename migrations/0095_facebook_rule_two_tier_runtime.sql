-- aidcp:kind=expand
-- aidcp:objects=table:facebook_rule_progress,table:facebook_rule_view_fact,table:facebook_rule_batch

-- change facebook-rule-mode-two-tier-cadence，automation 属主侧。见 0094 的完整背景。
--
-- 两件事：
--   ① 三张运行时表的 definition_id / definition_version CHECK 放宽为「新旧都接受」；
--   ② batch 三个动作状态列的 CHECK 增加 'not_scheduled'——只点赞的轮次要把加群与评论两格写成
--      「本轮按节奏不适用」。MUST NOT 复用 not_started / structural_skip：那两个表示「本该做却
--      没起来 / 目标结构上做不到」，混用会让后台把一半轮次渲染成两个假失败。
--
-- 注：progress.view_count 的 `CHECK (view_count BETWEEN 0 AND 9)` **不需要**放宽——新阈值 5 的
-- 取值域 0..4 落在区间内。仅当未来阈值 > 10 才需要动它。
--
-- 约束名全是 PG 自动生成的匿名内联 CHECK，MUST NOT 猜名 + `DROP CONSTRAINT IF EXISTS`：名字不符
-- 会静默 no-op，随后 ADD 的更宽 CHECK 与旧 CHECK 取合取，迁移报成功而运行期写入仍被 23514 拒。
-- 照 0039 的先例按 pg_constraint 动态查名；循环 DROP 也让本迁移对新命名约束幂等。

DO $$
DECLARE
  target_table TEXT;
  constraint_name TEXT;
BEGIN
  FOREACH target_table IN ARRAY ARRAY[
    'facebook_rule_progress',
    'facebook_rule_view_fact',
    'facebook_rule_batch'
  ]
  LOOP
    FOR constraint_name IN
      SELECT conname
        FROM pg_constraint
       WHERE conrelid = target_table::regclass
         AND contype = 'c'
         AND (pg_get_constraintdef(oid) LIKE '%definition_id%'
              OR pg_get_constraintdef(oid) LIKE '%definition_version%')
    LOOP
      EXECUTE format('ALTER TABLE %I DROP CONSTRAINT %I', target_table, constraint_name);
    END LOOP;

    EXECUTE format(
      'ALTER TABLE %I ADD CONSTRAINT %I CHECK (definition_id IN (%L, %L))',
      target_table,
      target_table || '_definition_id_check',
      'facebook_browse_10_like_1_join_contact_1',
      'facebook_browse_5_like_1_join_contact_every_2'
    );

    EXECUTE format(
      'ALTER TABLE %I ADD CONSTRAINT %I CHECK (definition_version IN (1, 2))',
      target_table,
      target_table || '_definition_version_check'
    );
  END LOOP;
EXCEPTION WHEN undefined_table THEN
  NULL;
END $$;

DO $$
DECLARE
  target_column TEXT;
  constraint_name TEXT;
BEGIN
  FOREACH target_column IN ARRAY ARRAY['like_state', 'join_state', 'comment_state']
  LOOP
    FOR constraint_name IN
      SELECT conname
        FROM pg_constraint
       WHERE conrelid = 'facebook_rule_batch'::regclass
         AND contype = 'c'
         AND pg_get_constraintdef(oid) LIKE '%' || target_column || '%'
    LOOP
      EXECUTE format('ALTER TABLE facebook_rule_batch DROP CONSTRAINT %I', constraint_name);
    END LOOP;

    EXECUTE format(
      'ALTER TABLE facebook_rule_batch ADD CONSTRAINT %I CHECK (%I IN ('
      || '''pending'', ''dispatched'', ''confirmed'', ''already_satisfied'', ''risk_suppressed'', '
      || '''structural_skip'', ''not_started'', ''rejected'', ''failed'', ''ambiguous'', '
      || '''submitted_unknown'', ''not_scheduled''))',
      'facebook_rule_batch_' || target_column || '_check',
      target_column
    );
  END LOOP;
EXCEPTION WHEN undefined_table THEN
  NULL;
END $$;
