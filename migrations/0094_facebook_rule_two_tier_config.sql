-- aidcp:kind=expand
-- aidcp:objects=table:facebook_rule_mode_config

-- change facebook-rule-mode-two-tier-cadence：规则节奏从单轴（10 浏览 → 1 批次含点赞+加群联系评论）
-- 改为两级（5 浏览 → 1 轮次点赞；每 2 轮次 → 1 次加群联系评论）。节奏数字编码在定义号字符串里，
-- 因此必须换定义身份，而 0092 用 `CHECK (definition_id = '<旧值>')` 把它钉死了。
--
-- MUST NOT 编辑 0092：它已入 DEV 账本，改磁盘内容即 migration_checksum_mismatch、整批拒绝。
-- 这里放宽成「新旧都接受」（README §5 判定为 expand：旧版本代码在此之后仍能正常读写），
-- 副产品是回滚只需把代码常量改回旧值、不需要反向迁移。
--
-- 约束名是 PG 自动生成的匿名内联 CHECK，MUST NOT 猜名 + `DROP CONSTRAINT IF EXISTS`：
-- 名字不符会静默 no-op，随后 ADD 的更宽 CHECK 与旧 CHECK 取合取，迁移报成功而运行期写入仍被 23514 拒。
-- 照 0039 的先例按 pg_constraint 动态查名。循环 DROP 也让本迁移对新命名约束幂等。
DO $$
DECLARE constraint_name TEXT;
BEGIN
  FOR constraint_name IN
    SELECT conname
      FROM pg_constraint
     WHERE conrelid = 'facebook_rule_mode_config'::regclass
       AND contype = 'c'
       AND (pg_get_constraintdef(oid) LIKE '%definition_id%'
            OR pg_get_constraintdef(oid) LIKE '%definition_version%')
  LOOP
    EXECUTE format('ALTER TABLE facebook_rule_mode_config DROP CONSTRAINT %I', constraint_name);
  END LOOP;

  ALTER TABLE facebook_rule_mode_config
    ADD CONSTRAINT facebook_rule_mode_config_definition_id_check
    CHECK (definition_id IN (
      'facebook_browse_10_like_1_join_contact_1',
      'facebook_browse_5_like_1_join_contact_every_2'
    ));

  ALTER TABLE facebook_rule_mode_config
    ADD CONSTRAINT facebook_rule_mode_config_definition_version_check
    CHECK (definition_version IN (1, 2));
EXCEPTION WHEN undefined_table THEN
  NULL;
END $$;

-- 列默认值跟到当前定义。存量写入方一律显式传值，改默认不影响旧版本代码（expand）。
ALTER TABLE facebook_rule_mode_config
  ALTER COLUMN definition_id SET DEFAULT 'facebook_browse_5_like_1_join_contact_every_2';
ALTER TABLE facebook_rule_mode_config
  ALTER COLUMN definition_version SET DEFAULT 2;
