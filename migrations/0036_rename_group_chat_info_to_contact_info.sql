-- aidcp:kind=contract
-- aidcp:objects=column:account_content_schedule.contact_comment_daily_cap,column:account_content_schedule.contact_comment_enabled,column:accounts.contact_info,column:contact_comment_attempts.account_id
-- aidcp:objects=column:contact_comment_attempts.attempted_at,column:contact_comment_attempts.id,index:idx_contact_comment_attempts_account,table:contact_comment_attempts
-- 0036_rename_group_chat_info_to_contact_info.sql（change generalize-contact-info）
-- generalize-contact-info: physical rename group_chat_info / group_comment_* -> contact_*
-- Coordinated single-writer migration (NOT self-heal): guarded, schema-qualified, lock-bounded, idempotent.
--
-- 本仓无迁移执行器：运维在部署新构建前**手动**运行本文件一次，把既有数据的物理列/表改名（保数据）；
-- 之后各 store 的自愈 DDL（account-store.ts ACCOUNTS_SCHEMA_SQL、content-schedule-store.ts
-- CONTENT_SCHEDULE_SCHEMA_SQL）声明的是**新名**（contact_info / contact_comment_*），
-- 对已改名库为幂等 no-op；对全新库直接建新名。两者对新名逐字同源、旧名 DDL 已从自愈层删除
-- （旧构建重启不会复活僵尸列/表）。
--
-- 语义：仅重命名，不改类型/默认/约束——group_chat_info(TEXT) verbatim 联系方式不变；
-- group_comment_enabled(BOOLEAN NOT NULL DEFAULT false) / group_comment_daily_cap(INTEGER NOT NULL DEFAULT 0)
-- 语义不变；group_comment_attempts 尝试台账不变。红线：不碰风控单写路径、不经协议、只动自身列/表。

-- ① accounts.group_chat_info -> accounts.contact_info
DO $$
BEGIN
  PERFORM set_config('lock_timeout', '3s', true);
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='accounts' AND column_name='group_chat_info')
     AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='accounts' AND column_name='contact_info')
  THEN ALTER TABLE accounts RENAME COLUMN group_chat_info TO contact_info; END IF;
END $$;
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS contact_info TEXT;

-- ② account_content_schedule.group_comment_enabled -> contact_comment_enabled
DO $$
BEGIN
  PERFORM set_config('lock_timeout', '3s', true);
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='account_content_schedule' AND column_name='group_comment_enabled')
     AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='account_content_schedule' AND column_name='contact_comment_enabled')
  THEN ALTER TABLE account_content_schedule RENAME COLUMN group_comment_enabled TO contact_comment_enabled; END IF;
END $$;
ALTER TABLE account_content_schedule ADD COLUMN IF NOT EXISTS contact_comment_enabled BOOLEAN NOT NULL DEFAULT false;

-- ③ account_content_schedule.group_comment_daily_cap -> contact_comment_daily_cap
DO $$
BEGIN
  PERFORM set_config('lock_timeout', '3s', true);
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='account_content_schedule' AND column_name='group_comment_daily_cap')
     AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='account_content_schedule' AND column_name='contact_comment_daily_cap')
  THEN ALTER TABLE account_content_schedule RENAME COLUMN group_comment_daily_cap TO contact_comment_daily_cap; END IF;
END $$;
ALTER TABLE account_content_schedule ADD COLUMN IF NOT EXISTS contact_comment_daily_cap INTEGER NOT NULL DEFAULT 0;

-- ④ table group_comment_attempts -> contact_comment_attempts (+ index rename)
DO $$
BEGIN
  PERFORM set_config('lock_timeout', '3s', true);
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema=current_schema() AND table_name='group_comment_attempts')
     AND NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema=current_schema() AND table_name='contact_comment_attempts')
  THEN ALTER TABLE group_comment_attempts RENAME TO contact_comment_attempts; END IF;
  IF EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname=current_schema() AND indexname='idx_group_comment_attempts_account')
     AND NOT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname=current_schema() AND indexname='idx_contact_comment_attempts_account')
  THEN ALTER INDEX idx_group_comment_attempts_account RENAME TO idx_contact_comment_attempts_account; END IF;
END $$;
-- 全新库回退（旧表从未存在）：直接建新名表 + 索引（与 content-schedule-store.ts 自愈 DDL 逐字同源）。
CREATE TABLE IF NOT EXISTS contact_comment_attempts (
  id           BIGSERIAL PRIMARY KEY,
  account_id   TEXT NOT NULL,
  attempted_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_contact_comment_attempts_account ON contact_comment_attempts (account_id, attempted_at);
