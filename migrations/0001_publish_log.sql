-- aidcp:kind=expand
-- aidcp:objects=column:publish_log.content,column:publish_log.id,column:publish_log.platform_post_id,column:publish_log.published_at
-- aidcp:objects=column:publish_log.source_concepts,column:publish_log.source_liked_ids,column:publish_log.status,column:publish_log.title
-- aidcp:objects=index:idx_publish_log_published_at,table:publish_log
-- 发布记录表：Publish Agent 落地每次生成/发布的帖子。
-- 幂等：可重复执行（CREATE TABLE IF NOT EXISTS）。
-- 库：aidcp（user=aidcp）。

CREATE TABLE IF NOT EXISTS publish_log (
  id               SERIAL PRIMARY KEY,
  published_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  title            TEXT,
  content          TEXT NOT NULL,
  source_concepts  TEXT[] NOT NULL DEFAULT '{}',  -- 引用的概念关键词
  source_liked_ids INT[]  DEFAULT '{}',           -- 引用的点赞内容 id
  status           TEXT NOT NULL DEFAULT 'draft'  -- draft | published | failed | needs_review
                   CHECK (status IN ('draft','published','failed','needs_review')),
  platform_post_id TEXT                           -- 小红书帖子 id（发布成功后回填）
);

-- 按发布时间倒序查询最近帖子（避免重复话题 / 计算距上次发布时长）。
CREATE INDEX IF NOT EXISTS idx_publish_log_published_at ON publish_log (published_at DESC);