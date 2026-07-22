-- aidcp:kind=expand
-- aidcp:objects=index:idx_interaction_feed_time,index:idx_llm_token_usage_bucket,index:idx_risk_counters_time
-- 0030_panel_hardening_indexes.sql
-- change console-cloud-panel-hardening (#21/#22/#23)
--
-- 面板「全局 / 纯时间窗」只读查询（今日各动作聚合、全局互动流、时间窗用量）不带账号前缀，
-- 而这三张表原有的索引都以 account_id 为首列，PostgreSQL 无法用它们服务纯时间范围/倒序查询，
-- 三处均退化为顺序全表扫描。补 occurred_at / bucket_start 打头索引消灭全表扫描。
-- 与各 store 内嵌 `CREATE INDEX IF NOT EXISTS` 同源双写（schema 启动自建 + migration 文件）。

CREATE INDEX IF NOT EXISTS idx_risk_counters_time     ON risk_counters   (occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_interaction_feed_time  ON interaction_feed (occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_llm_token_usage_bucket ON llm_token_usage (bucket_start);
