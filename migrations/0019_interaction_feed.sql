-- 面板互动流（change interaction-feed-enrichment）。
-- 幂等：可重复执行（CREATE TABLE / INDEX IF NOT EXISTS）。库：aidcp（user=aidcp）。
-- 与 src/cache/interaction-feed-store.ts 的 INTERACTION_FEED_SCHEMA_SQL 同源（运行时 init 亦建表）。
--
-- 设计要点：
--  - interaction_feed = 展示账本（点赞/收藏/评论/关注四类），与 risk_interactions（去重台账，本变更一行不动）解耦。
--    笔记动作 target_id = noteId；关注 target_id = authorId。PK 去重为一行、ON CONFLICT DO NOTHING 保留首次时间（诚实审计、不重排）。
--  - interaction_target_meta = 标题/链接旁表（按 account_id+target_id）；在「看到笔记/看到作者」上报到达时独立 upsert，
--    面板读时 LEFT JOIN。诚实置空：title/url 缺失即 NULL，绝不伪造。

CREATE TABLE IF NOT EXISTS interaction_feed (
  account_id  TEXT        NOT NULL,
  action      TEXT        NOT NULL CHECK (action IN ('like','collect','comment','follow')),
  target_id   TEXT        NOT NULL,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, action, target_id)
);
CREATE INDEX IF NOT EXISTS idx_interaction_feed_account_time ON interaction_feed (account_id, occurred_at DESC);

CREATE TABLE IF NOT EXISTS interaction_target_meta (
  account_id TEXT        NOT NULL,
  target_id  TEXT        NOT NULL,
  title      TEXT,
  url        TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, target_id)
);
