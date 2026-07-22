-- aidcp:kind=expand
-- aidcp:objects=column:anchor_staging.action_id,column:anchor_staging.attributes,column:anchor_staging.fingerprint,column:anchor_staging.role
-- aidcp:objects=column:anchor_staging.scope,column:anchor_staging.successes,column:anchor_staging.text,column:anchor_staging.text_match
-- aidcp:objects=column:anchor_staging.updated_at,column:anchors.action_id,column:anchors.attributes,column:anchors.fail_count
-- aidcp:objects=column:anchors.hit_count,column:anchors.last_verified,column:anchors.role,column:anchors.scope
-- aidcp:objects=column:anchors.text,column:anchors.text_match,column:anchors.updated_at,column:concepts.discovered_at
-- aidcp:objects=column:concepts.id,column:concepts.keyword,column:concepts.searched_at,column:concepts.source_note
-- aidcp:objects=column:concepts.status,column:curated_content.account_id,column:curated_content.admit_reason,column:curated_content.author
-- aidcp:objects=column:curated_content.body,column:curated_content.bot_collected,column:curated_content.bot_liked,column:curated_content.collect_count
-- aidcp:objects=column:curated_content.comment_count,column:curated_content.content_type,column:curated_content.counts_captured_at,column:curated_content.dedup_key
-- aidcp:objects=column:curated_content.first_seen_at,column:curated_content.id,column:curated_content.like_count,column:curated_content.reference_images
-- aidcp:objects=column:curated_content.source_id,column:curated_content.source_published_at,column:curated_content.source_published_at_observed_at,column:curated_content.source_published_at_precision
-- aidcp:objects=column:curated_content.source_published_at_status,column:curated_content.source_published_at_text,column:curated_content.source_url,column:curated_content.text_card_transcription
-- aidcp:objects=column:curated_content.title,column:curated_content.topics,column:curated_content.updated_at,column:curated_content.visual_analysis
-- aidcp:objects=column:group_route.chat_id,column:group_route.group_label,column:group_route.updated_at,column:group_route.updated_by
-- aidcp:objects=column:hot_lead_config_global.id,column:hot_lead_config_global.min_like_floor,column:hot_lead_config_global.post_age_max_hours,column:hot_lead_config_global.updated_at
-- aidcp:objects=column:hot_lead_config_global.updated_by,column:hot_lead_config_global.velocity_min,column:liked_notes.author,column:liked_notes.id
-- aidcp:objects=column:liked_notes.liked_at,column:liked_notes.note_id,column:liked_notes.summary,column:liked_notes.title
-- aidcp:objects=column:valuable_comments.author,column:valuable_comments.comment_text,column:valuable_comments.dedup_key,column:valuable_comments.id
-- aidcp:objects=column:valuable_comments.liked_at,column:valuable_comments.reason,column:valuable_comments.source_note_id,column:valuable_comments.source_note_title
-- aidcp:objects=column:valuable_comments.topics,index:idx_curated_content_account_updated,index:idx_curated_content_topics,index:idx_liked_notes_liked_at
-- aidcp:objects=index:idx_valuable_comments_liked_at,index:idx_valuable_comments_topics,table:anchor_staging,table:anchors
-- aidcp:objects=table:concepts,table:curated_content,table:group_route,table:hot_lead_config_global
-- aidcp:objects=table:liked_notes,table:valuable_comments
-- 补齐缺失迁移：锚点缓存与语料域（change cloud-schema-migration-executor 任务 3.1/3.2）。
-- DDL 原样抽自各存储的 SCHEMA_SQL 常量，保留 IF NOT EXISTS 与全部幂等自愈语句。本文件零运行时行为变化。

-- ==== 原样抽自 src/cache/pg-anchor-cache.ts SCHEMA_SQL ====
CREATE TABLE IF NOT EXISTS anchors (
  action_id   TEXT PRIMARY KEY,
  role        TEXT,
  text        TEXT,
  text_match  TEXT DEFAULT 'contains',
  attributes  JSONB DEFAULT '{}'::jsonb,
  scope       JSONB,
  hit_count   INTEGER NOT NULL DEFAULT 0,
  fail_count  INTEGER NOT NULL DEFAULT 0,
  last_verified TIMESTAMPTZ DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS anchor_staging (
  action_id   TEXT PRIMARY KEY,
  role        TEXT,
  text        TEXT,
  text_match  TEXT DEFAULT 'contains',
  attributes  JSONB DEFAULT '{}'::jsonb,
  scope       JSONB,
  successes   INTEGER NOT NULL DEFAULT 0,
  fingerprint TEXT NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ==== 原样抽自 src/cache/concept-store.ts CONCEPT_SCHEMA_SQL ====
CREATE TABLE IF NOT EXISTS concepts (
  id            SERIAL PRIMARY KEY,
  keyword       TEXT NOT NULL UNIQUE,
  status        TEXT NOT NULL DEFAULT 'candidate'
                CHECK (status IN ('candidate','searched','known')),
  source_note   TEXT,
  discovered_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  searched_at   TIMESTAMPTZ
);

-- ==== 原样抽自 src/cache/curated-content-store.ts CURATED_CONTENT_SCHEMA_SQL ====
CREATE TABLE IF NOT EXISTS curated_content (
  id                 SERIAL PRIMARY KEY,
  account_id         TEXT NOT NULL,
  content_type       TEXT NOT NULL CHECK (content_type IN ('image_text','video','comment')),
  source_id          TEXT NOT NULL,
  dedup_key          TEXT NOT NULL UNIQUE,
  title              TEXT,
  body               TEXT,
  author             TEXT,
  source_url         TEXT,
  topics             TEXT[] NOT NULL DEFAULT '{}',
  like_count         INT,
  collect_count      INT,
  comment_count      INT,
  counts_captured_at TIMESTAMPTZ,
  source_published_at_text TEXT,
  source_published_at TIMESTAMPTZ,
  source_published_at_precision TEXT,
  source_published_at_status TEXT,
  source_published_at_observed_at TIMESTAMPTZ,
  reference_images   JSONB NOT NULL DEFAULT '[]'::jsonb,
  visual_analysis    JSONB,
  text_card_transcription JSONB,
  bot_liked          BOOLEAN NOT NULL DEFAULT false,
  bot_collected      BOOLEAN NOT NULL DEFAULT false,
  admit_reason       TEXT,
  first_seen_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE curated_content ADD COLUMN IF NOT EXISTS reference_images JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE curated_content ADD COLUMN IF NOT EXISTS visual_analysis JSONB;
ALTER TABLE curated_content ADD COLUMN IF NOT EXISTS text_card_transcription JSONB;
ALTER TABLE curated_content ADD COLUMN IF NOT EXISTS source_published_at_text TEXT;
ALTER TABLE curated_content ADD COLUMN IF NOT EXISTS source_published_at TIMESTAMPTZ;
ALTER TABLE curated_content ADD COLUMN IF NOT EXISTS source_published_at_precision TEXT;
ALTER TABLE curated_content ADD COLUMN IF NOT EXISTS source_published_at_status TEXT;
ALTER TABLE curated_content ADD COLUMN IF NOT EXISTS source_published_at_observed_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_curated_content_topics ON curated_content USING GIN(topics);
CREATE INDEX IF NOT EXISTS idx_curated_content_account_updated ON curated_content (account_id, updated_at DESC);

DO $$
BEGIN
  IF to_regclass('public.curated_content') IS NOT NULL THEN
    ALTER TABLE curated_content DROP CONSTRAINT IF EXISTS curated_content_content_type_check;

    -- split-curated-source-media-types：存量 note 无法可靠反推是否视频，统一迁为 image_text。
    UPDATE curated_content target
       SET bot_liked = target.bot_liked OR legacy.bot_liked,
           bot_collected = target.bot_collected OR legacy.bot_collected,
           title = COALESCE(target.title, legacy.title),
           body = COALESCE(NULLIF(target.body, ''), legacy.body),
           author = COALESCE(target.author, legacy.author),
           source_url = COALESCE(target.source_url, legacy.source_url),
           topics = CASE WHEN COALESCE(array_length(target.topics, 1), 0) = 0 THEN legacy.topics ELSE target.topics END,
           reference_images = CASE
                                WHEN target.reference_images = '[]'::jsonb THEN legacy.reference_images
                                ELSE target.reference_images
                              END,
           text_card_transcription = COALESCE(target.text_card_transcription, legacy.text_card_transcription),
           like_count = COALESCE(target.like_count, legacy.like_count),
           collect_count = COALESCE(target.collect_count, legacy.collect_count),
           comment_count = COALESCE(target.comment_count, legacy.comment_count),
           admit_reason = COALESCE(target.admit_reason, legacy.admit_reason),
           updated_at = GREATEST(target.updated_at, legacy.updated_at)
      FROM curated_content legacy
     WHERE target.account_id = legacy.account_id
       AND target.source_id = legacy.source_id
       AND target.content_type = 'image_text'
       AND legacy.content_type = 'note'
       AND target.id <> legacy.id;

    DELETE FROM curated_content legacy
      USING curated_content target
     WHERE target.account_id = legacy.account_id
       AND target.source_id = legacy.source_id
       AND target.content_type = 'image_text'
       AND legacy.content_type = 'note'
       AND target.id <> legacy.id;

    UPDATE curated_content
       SET content_type = 'image_text',
           dedup_key = account_id || '::image_text::' || source_id
     WHERE content_type = 'note';

    ALTER TABLE curated_content
      ADD CONSTRAINT curated_content_content_type_check
      CHECK (content_type IN ('image_text','video','comment'));
  END IF;
END $$;

-- ==== 原样抽自 src/cache/liked-note-store.ts LIKED_NOTE_SCHEMA_SQL ====
CREATE TABLE IF NOT EXISTS liked_notes (
  id        SERIAL PRIMARY KEY,
  note_id   TEXT NOT NULL UNIQUE,
  title     TEXT NOT NULL DEFAULT '',
  summary   TEXT NOT NULL DEFAULT '',
  author    TEXT,
  liked_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_liked_notes_liked_at ON liked_notes(liked_at DESC);

-- ==== 原样抽自 src/cache/valuable-comment-store.ts VALUABLE_COMMENT_SCHEMA_SQL ====
CREATE TABLE IF NOT EXISTS valuable_comments (
  id                SERIAL PRIMARY KEY,
  dedup_key         TEXT NOT NULL UNIQUE,
  comment_text      TEXT NOT NULL,
  author            TEXT,
  source_note_id    TEXT,
  source_note_title TEXT,
  topics            TEXT[] NOT NULL DEFAULT '{}',
  reason            TEXT,
  liked_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_valuable_comments_liked_at ON valuable_comments(liked_at DESC);
CREATE INDEX IF NOT EXISTS idx_valuable_comments_topics ON valuable_comments USING GIN(topics);

-- ==== 原样抽自 src/cache/group-route-store.ts GROUP_ROUTE_SCHEMA_SQL ====
CREATE TABLE IF NOT EXISTS group_route (
  group_label TEXT        PRIMARY KEY,
  chat_id     TEXT        NOT NULL,
  updated_by  TEXT,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ==== 原样抽自 src/config/hot-lead-config-store.ts HOT_LEAD_CONFIG_SCHEMA_SQL ====
CREATE TABLE IF NOT EXISTS hot_lead_config_global (
  id                 INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  post_age_max_hours INTEGER,
  velocity_min       INTEGER,
  min_like_floor     INTEGER,
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by         TEXT
);
