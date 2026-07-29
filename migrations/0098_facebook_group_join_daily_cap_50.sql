-- aidcp:kind=expand
-- aidcp:objects=table:facebook_group_join_automation_config
--
-- 头部 MUST 声明**表名**而不是约束名：约束名在 PG 里不带表名，属主归属反推不出来，
-- 只声明约束会让本迁移落进「残留」分支被计入**全部**属主库。
--
-- change raise-facebook-group-join-cap-ceiling（design.md D2/D3）。
--
-- 把自动加群每账号日上限的库侧上界从 10 抬到 50。
--
-- **为什么必须显式换约束，不能只改常量**：该约束是当初随建表语句一起落库的内联 CHECK，
-- 而存储侧的自愈建表只在**表不存在**时才执行——对已经存在的表完全不生效。
-- 仓内此前不存在替换该约束的迁移，所以现网那条 0..10 只能靠本迁移换掉。
-- 只改契约常量而不跑本迁移的后果是：写前校验放行 51，数据库拒收，报错没有业务含义。
--
-- **顺序铁律**：本迁移 MUST 先于代码部署执行。反过来会在两次部署之间留一个必然失败的写入窗口
-- （校验已放宽到 50、库仍卡 10）。放宽方向对既有数据恒安全：满足 0..10 的行必然满足 0..50。
--
-- **旧约束名不可预知**：内联 CHECK 由 PG 自动命名，不同环境可能不一致（自愈建表与基线迁移
-- 两条路径都建过这张表）。故照 0094 / 0039 的先例按 pg_constraint 动态查名循环 DROP，
-- 再加一条显式命名的新约束。漏删旧约束会造成两条并存、严格者继续生效，
-- 而「写入 50 失败」这一现象与「迁移没跑」无法区分——那正是本段要防的静默失败。
--
-- 表名一律不带 schema 前缀：迁移顺序闸的表名正则不含点号，写 `public.` 会被截成表名 `public`
-- 并误报成「引用了尚未建出的表」。
--
-- 幂等：可重复执行。循环 DROP 覆盖新命名约束，故重跑安全。
--
-- 红线：只动 facebook_group_join_automation_config 的 CHECK 约束；不改任何行数据、不改列默认值、
-- 不触风控状态单写路径。

DO $$
DECLARE constraint_name TEXT;
BEGIN
  FOR constraint_name IN
    SELECT conname
      FROM pg_constraint
     WHERE conrelid = 'facebook_group_join_automation_config'::regclass
       AND contype = 'c'
       AND pg_get_constraintdef(oid) LIKE '%daily_cap%'
  LOOP
    EXECUTE format('ALTER TABLE facebook_group_join_automation_config DROP CONSTRAINT %I', constraint_name);
  END LOOP;

  ALTER TABLE facebook_group_join_automation_config
    ADD CONSTRAINT facebook_group_join_automation_config_daily_cap_range
    CHECK (daily_cap BETWEEN 0 AND 50);
EXCEPTION WHEN undefined_table THEN
  -- 表还没建出来（全新空库尚未跑到自愈建表）：跳过即可，自愈建表模板会按新常量插值建出 0..50。
  NULL;
END $$;

-- 事后校验（人工执行，见 tasks 5.3）：下面这条 MUST 恰好返回一行，且定义为 0..50。
-- 返回两行 = 旧约束没删干净，严格者仍在生效。
--
--   SELECT conname, pg_get_constraintdef(oid)
--     FROM pg_constraint
--    WHERE conrelid = 'facebook_group_join_automation_config'::regclass
--      AND contype = 'c'
--      AND pg_get_constraintdef(oid) LIKE '%daily_cap%';
