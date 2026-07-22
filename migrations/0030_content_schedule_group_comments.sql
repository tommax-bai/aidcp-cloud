-- aidcp:kind=expand
-- aidcp:objects=
-- 0030_content_schedule_group_comments.sql（change content-schedule-group-comments，Phase 3 定时群评）
-- 人审文档：本仓无迁移执行器，实际 DDL 由 ContentScheduleStore.init() 幂等自愈
-- （src/config/content-schedule-store.ts CONTENT_SCHEDULE_SCHEMA_SQL，与此同源、勿漂移）。
--
-- 语义：
-- - group_comment_enabled 默认 false / group_comment_daily_cap 默认 0（fail-closed）；cap 硬上限 10（store 校验层）。
-- - 开启 group_comment_enabled=true 须过一码一号硬校验（无码拒 no_group_code；与任一其它账号群码 verbatim
--   相同拒 shared_group_code），每次开启写入重跑，绝不仅告警放行。
-- - group_comment_attempts：群评每日自动**尝试**台账（触发回执 ok 即记；被人审拒/无目标也占额度——保守方向；
--   重启不清零、绝不超发）。

ALTER TABLE account_content_schedule ADD COLUMN IF NOT EXISTS group_comment_enabled BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE account_content_schedule ADD COLUMN IF NOT EXISTS group_comment_daily_cap INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS group_comment_attempts (
  id           BIGSERIAL PRIMARY KEY,
  account_id   TEXT NOT NULL,
  attempted_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_group_comment_attempts_account ON group_comment_attempts (account_id, attempted_at);
