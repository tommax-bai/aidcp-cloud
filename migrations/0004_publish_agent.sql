-- Migration: 0004_publish_agent
-- Description: 为发布角色链（PublishManagerAgent）添加支持
-- Date: 2024-01-01

-- 1. publish_log 增加 images 列（存储配图 URL 列表）
ALTER TABLE publish_log ADD COLUMN IF NOT EXISTS images TEXT[] DEFAULT '{}';

-- 2. 发布管道执行日志表（每个角色一条记录）
CREATE TABLE IF NOT EXISTS publish_pipeline_logs (
  id               SERIAL PRIMARY KEY,
  run_id           TEXT NOT NULL,
  role_name        TEXT NOT NULL,
  triggered_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at     TIMESTAMPTZ,
  input_snapshot   JSONB,
  output_snapshot  JSONB,
  success          BOOLEAN NOT NULL DEFAULT true,
  error_message    TEXT,
  duration_ms      INT
);

-- 索引：按 run_id 查询整条管道日志
CREATE INDEX IF NOT EXISTS idx_pipeline_logs_run ON publish_pipeline_logs(run_id);

-- 索引：按角色名过滤
CREATE INDEX IF NOT EXISTS idx_pipeline_logs_role ON publish_pipeline_logs(role_name);
