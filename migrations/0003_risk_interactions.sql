-- aidcp:kind=expand
-- aidcp:objects=column:risk_interactions.account_id,column:risk_interactions.action,column:risk_interactions.interacted_at,column:risk_interactions.note_id
-- aidcp:objects=index:idx_risk_interactions_account_time,table:risk_interactions
-- 风控内容去重：已互动笔记集合。
-- 幂等：可重复执行（CREATE TABLE IF NOT EXISTS / CREATE INDEX IF NOT EXISTS）。
-- 库：aidcp（user=aidcp）。

CREATE TABLE IF NOT EXISTS risk_interactions (
  account_id    TEXT NOT NULL,
  note_id       TEXT NOT NULL,
  action        TEXT NOT NULL CHECK (action IN ('like','collect','comment')),
  interacted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, note_id, action)
);

CREATE INDEX IF NOT EXISTS idx_risk_interactions_account_time ON risk_interactions (account_id, interacted_at DESC);