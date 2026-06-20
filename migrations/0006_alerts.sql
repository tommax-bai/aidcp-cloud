-- V1 告警日志（change aidcp-console-panel-mvp，task 9.5 / 重构步骤）：
-- append-only 告警表，飞书卡发送点写入、验证码清除点 set resolved_at。
-- 复用 P0–P3 分级（risk-control §7 / product-exception §1）；与 risk_state.signalCount 区分（这是事件日志、非计数）。
-- 幂等：CREATE TABLE / INDEX IF NOT EXISTS，可重复执行。
-- 库：aidcp（user=aidcp）。

CREATE TABLE IF NOT EXISTS alerts (
  alert_id    BIGSERIAL PRIMARY KEY,
  severity    TEXT NOT NULL CHECK (severity IN ('P0','P1','P2','P3')),
  type        TEXT NOT NULL,                 -- 'captcha' | 'block' | ...（告警来源种类）
  account_id  TEXT,                          -- 涉及账号（可空：未归因/全局告警）
  edge_id     TEXT,                          -- 来源 edge（验证码清除点据此 resolve）
  title       TEXT NOT NULL,
  detail      TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at TIMESTAMPTZ                    -- 清除点 set；NULL = 未解决
);

CREATE INDEX IF NOT EXISTS idx_alerts_created ON alerts (created_at DESC);
-- 按 edge 解决未解决告警的部分索引（验证码清除快路）。
CREATE INDEX IF NOT EXISTS idx_alerts_unresolved_edge ON alerts (edge_id) WHERE resolved_at IS NULL;
