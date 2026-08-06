-- aidcp:kind=expand
-- aidcp:objects=index:idx_interaction_feed_time,index:idx_risk_counters_time
-- aidcp:owner=automation
-- 0112_panel_hardening_indexes_automation.sql（change restore-derived-migration-executability）
--
-- 接替 `0030_panel_hardening_indexes` 的 automation 那一半。
--
-- 0030 在 risk_counters / interaction_feed（automation）与 llm_token_usage（content）上各建索引，
-- **在任何单一属主库里都跑不通**：拆库后 automation 库没有 llm_token_usage、content 库没有另外两张表。
-- 空库实跑正是停在它上面（relation "risk_counters" does not exist）。而它已入 dev / ol 的账本，
-- 校验和是整文件 sha256，改一个字节就是 migration_checksum_mismatch 整批拒绝 —— 所以不能改它，
-- 只能在名册里把它标成「每个库都记账、哪个库都不执行」，再由本文件与 0113 各建回自己那一半。
--
-- 索引名沿用 0030 的原名：`migrate verify` 的对账是「每条声明逐条查在不在库里」，
-- 声明表是可重复的扁平表、多余项用集合判，同一个对象被两个版本声明不会误判
-- （实读 src/schema/schema-inspect.ts 的 declaredObjects / diffSchema 确认，非推测）。
-- 换名反而会在两个已有库上留下一对同定义不同名的索引。
--
-- dev / ol：索引早已存在 → IF NOT EXISTS 幂等空转，零 DDL 变化。
-- 全新 automation 库：由本文件建出，不再依赖那条跑不通的 0030。

CREATE INDEX IF NOT EXISTS idx_risk_counters_time    ON risk_counters   (occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_interaction_feed_time ON interaction_feed (occurred_at DESC);
