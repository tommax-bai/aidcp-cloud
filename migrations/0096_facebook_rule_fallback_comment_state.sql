-- aidcp:kind=expand
-- aidcp:objects=table:facebook_rule_batch

-- change facebook-rule-comment-plain-fallback：规则轮次的评论段新增可辨识终态
-- `confirmed_without_contact`——账号没配联系方式时，加群联系评论按显式声明降级为不带联系方式的
-- 普通评论。它 MUST NOT 记成 confirmed：那会让后台与客户端认为联系方式已经发出去了。
--
-- MUST NOT 编辑 0093/0095：两条都已入 DEV 账本，改磁盘内容即 migration_checksum_mismatch、整批拒绝。
-- 这里继续按 0095 的模式动态查名后放宽（猜名 + IF EXISTS 会静默 no-op，新旧 CHECK 取合取，
-- 迁移报成功而运行期写入仍被 23514 拒）。

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
      || '''submitted_unknown'', ''not_scheduled'', ''confirmed_without_contact''))',
      'facebook_rule_batch_' || target_column || '_check',
      target_column
    );
  END LOOP;
EXCEPTION WHEN undefined_table THEN
  NULL;
END $$;
