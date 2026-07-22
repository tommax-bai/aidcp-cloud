-- aidcp:kind=expand
-- aidcp:objects=column:concepts.account_id,column:publish_log.account_id,index:idx_concepts_account,index:idx_publish_log_account
-- V1 多账号（change aidcp-console-panel-mvp，task 9.3 / 重构步骤 7）：
-- publish_log / concepts 加 account_id —— additive，DEFAULT 'default' 自动回填存量行。
-- 幂等：ADD COLUMN IF NOT EXISTS，可重复执行。
-- 概念查询当前保持账号无关（隔离搜索记忆成真需求前不按账号过滤），本列仅为按账号发布切片铺地基。
-- 库：aidcp（user=aidcp）。

ALTER TABLE publish_log ADD COLUMN IF NOT EXISTS account_id TEXT NOT NULL DEFAULT 'default';
ALTER TABLE concepts    ADD COLUMN IF NOT EXISTS account_id TEXT NOT NULL DEFAULT 'default';

-- 按账号查询的索引（发布按账号切片用；概念暂账号无关，索引备用）。
CREATE INDEX IF NOT EXISTS idx_publish_log_account ON publish_log (account_id);
CREATE INDEX IF NOT EXISTS idx_concepts_account ON concepts (account_id);
