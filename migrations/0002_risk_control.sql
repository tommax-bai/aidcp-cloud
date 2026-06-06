-- 风控核心模块：滑动窗口计数事件与账号风险状态。
-- 幂等：可重复执行（CREATE TABLE IF NOT EXISTS）。
-- 库：aidcp（user=aidcp）。

CREATE TABLE IF NOT EXISTS risk_counters (
  id          BIGSERIAL PRIMARY KEY,
  account_id  TEXT NOT NULL,
  action      TEXT NOT NULL CHECK (action IN ('like','collect','comment','follow','publish','view')),
  count       INTEGER NOT NULL DEFAULT 1,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_risk_counters_account_time ON risk_counters (account_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_risk_counters_account_action_time ON risk_counters (account_id, action, occurred_at DESC);

CREATE TABLE IF NOT EXISTS risk_state (
  account_id     TEXT PRIMARY KEY,
  status         TEXT NOT NULL CHECK (status IN ('normal','warned','restricted','frozen')),
  quota_level    TEXT NOT NULL CHECK (quota_level IN ('conservative','normal','aggressive')),
  signal_count   INTEGER NOT NULL DEFAULT 0,
  last_signal_at TIMESTAMPTZ,
  status_since   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);