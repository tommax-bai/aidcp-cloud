-- aidcp:kind=expand
-- aidcp:objects=
-- 0044_account_slow_start_since.sql（change account-level-slow-start）
--
-- 文档性迁移：本仓无迁移执行器，实际由 src/account-store.ts 的 ACCOUNTS_SCHEMA_SQL
-- 在 init() 时以同义的幂等 ALTER 自愈式加列。此文件与那条 ALTER 逐字同义，仅作台账。
--
-- 语义：账号级慢启动（逐日配额爬坡）的起点。
--   NULL     = 关（默认；全部既有行落到这里 → 逐位零回归）
--   非 NULL  = 开，且该时刻即第 1 天的起点（写入时已对齐上海日起点，见 AccountStore.setSlowStart）
--
-- 为什么不复用 accounts.created_at 当起点：created_at 记的是「该 accountId 第一次握手连上本云端库」，
-- 不是平台注册时间。FB 号主要靠 cookie 批量导入 → 养了三年的老号导入后会被算作「第 1 天」；
-- 反向亦错（号停用半年后复活，ON CONFLICT DO NOTHING 保留原 created_at → 算「第 180 天」）。
-- 且曲线只有 day 1..7：给任何入库超 7 天的号勾上慢启动 = 彻底零效果（界面显示「已开启」、运行时什么都不做）。
--
-- 回滚：不删列（删列要停机）。秒级止血走 AIDCP_SLOW_START_DISABLED=true + restart。

ALTER TABLE accounts ADD COLUMN IF NOT EXISTS slow_start_since TIMESTAMPTZ;
