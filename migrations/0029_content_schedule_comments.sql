-- aidcp:kind=expand
-- aidcp:objects=column:account_content_schedule.comment_daily_cap,column:account_content_schedule.comment_enabled
-- 0029_content_schedule_comments.sql（change content-schedule-comments，Phase 2 定时自动评论）
-- 人审文档：本仓无迁移执行器，实际补列由 ContentScheduleStore.init() 幂等自愈
-- （src/config/content-schedule-store.ts CONTENT_SCHEDULE_SCHEMA_SQL 内的 ALTER，与此同源、勿漂移）。
--
-- 语义（fail-closed，与发帖字段同构）：
-- - comment_enabled 默认 false、comment_daily_cap 默认 0 —— 未配 / 默认 = 评论不自动（零回归）。
-- - 评论日上限判定 = risk_interactions 按账号当日 'comment' 计数 + (评论任务在跑 ? 1 : 0)——
--   评论管线为「任务内联等审 + 单飞」模型，无排队草稿窗口，无需在途台账（design D2 论证）。
-- - 自动路径过 canDo('comment') 配额闸（手动 /comment 仍跳配额、人是刹车）。

ALTER TABLE account_content_schedule ADD COLUMN IF NOT EXISTS comment_enabled BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE account_content_schedule ADD COLUMN IF NOT EXISTS comment_daily_cap INTEGER NOT NULL DEFAULT 0;
