-- aidcp:kind=expand
-- aidcp:objects=index:idx_llm_token_usage_bucket
-- aidcp:owner=content
-- 0113_panel_hardening_indexes_content.sql（change restore-derived-migration-executability）
--
-- 接替 `0030_panel_hardening_indexes` 的 content 那一半，理由与 0112 逐字同源（见该文件文件头）：
-- 0030 跨 automation / content 两家建索引，在任何单一属主库里都跑不通，而它已入账、字节不可改，
-- 故名册里标为「记账不执行」，索引由 0112（automation）与本文件（content）各建回自己那一半。
--
-- dev / ol：索引早已存在 → 幂等空转。全新 content 库：由本文件建出。

CREATE INDEX IF NOT EXISTS idx_llm_token_usage_bucket ON llm_token_usage (bucket_start);
