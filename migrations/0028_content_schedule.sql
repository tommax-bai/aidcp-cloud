-- aidcp:kind=expand
-- aidcp:objects=column:account_content_schedule.account_id,column:account_content_schedule.auto_enabled,column:account_content_schedule.content_active_mask,column:account_content_schedule.post_daily_cap
-- aidcp:objects=column:account_content_schedule.post_enabled,column:account_content_schedule.updated_at,column:account_content_schedule.updated_by,column:content_schedule_global.content_active_mask
-- aidcp:objects=column:content_schedule_global.id,column:content_schedule_global.updated_at,column:content_schedule_global.updated_by,table:account_content_schedule
-- aidcp:objects=table:content_schedule_global
-- 0028_content_schedule.sql（change content-schedule-auto-publish，Phase 1 只发帖）
-- 人审文档：本仓无迁移执行器，实际建表由 ContentScheduleStore.init() 幂等自建
-- （src/config/content-schedule-store.ts CONTENT_SCHEDULE_SCHEMA_SQL，与此同源、勿漂移）。
--
-- 语义（与浏览掩码刻意相反的 fail-closed）：
-- - content_schedule_global.content_active_mask：全局「内容可自动时段」168 格 '0'/'1'（周一起头×24h、服务器本地时）；
--   NULL / 非法 = 全 0 = 不自动（浏览掩码 session_config_global.active_week_mask 是「缺失=全天活跃」，两者物理分开、语义相反）。
-- - account_content_schedule：每账号发帖排期；无行 = 完全不自动（零回归）。auto_enabled 总开关默认 false、
--   post_enabled 默认 false、post_daily_cap 默认 0（三重 fail-closed）；content_active_mask 为每账号时段覆盖，
--   NULL = 继承全局（v1 留列不接编辑界面）。
-- - 写通道：面板 PUT 经 ContentScheduleStore 单写——UPSERT 前校验 accounts 有该账号行（绝不造幽灵排期行）、
--   退役 'default' 拒、非法整块拒、RETURNING 回读真态。

CREATE TABLE IF NOT EXISTS content_schedule_global (
  id                  INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  content_active_mask TEXT,
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by          TEXT
);

CREATE TABLE IF NOT EXISTS account_content_schedule (
  account_id          TEXT PRIMARY KEY,
  auto_enabled        BOOLEAN NOT NULL DEFAULT false,
  post_enabled        BOOLEAN NOT NULL DEFAULT false,
  post_daily_cap      INTEGER NOT NULL DEFAULT 0,
  content_active_mask TEXT,
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by          TEXT
);
