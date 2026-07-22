-- aidcp:kind=expand
-- aidcp:objects=column:account_facebook_publish_image.byte_size,column:account_facebook_publish_image.content_type,column:account_facebook_publish_image.created_at,column:account_facebook_publish_image.duplicate_of_image_id
-- aidcp:objects=column:account_facebook_publish_image.filename,column:account_facebook_publish_image.id,column:account_facebook_publish_image.object_key,column:account_facebook_publish_image.set_id
-- aidcp:objects=column:account_facebook_publish_image.sha256,column:account_facebook_publish_image.sort_order,column:account_facebook_publish_image.url,column:account_facebook_publish_image_set.account_id
-- aidcp:objects=column:account_facebook_publish_image_set.caption_hint,column:account_facebook_publish_image_set.created_at,column:account_facebook_publish_image_set.id,column:account_facebook_publish_image_set.last_error
-- aidcp:objects=column:account_facebook_publish_image_set.reserved_at,column:account_facebook_publish_image_set.reserved_by,column:account_facebook_publish_image_set.sort_order,column:account_facebook_publish_image_set.status
-- aidcp:objects=column:account_facebook_publish_image_set.updated_at,column:account_facebook_publish_image_set.used_by_publish_log_id,column:facebook_group_join_audit.account_id,column:facebook_group_join_audit.created_at
-- aidcp:objects=column:facebook_group_join_audit.group_url,column:facebook_group_join_audit.id,column:facebook_group_join_audit.observation,column:facebook_group_join_audit.outcome
-- aidcp:objects=column:facebook_group_join_audit.phase,column:facebook_group_join_audit.reason,column:facebook_group_join_audit.shadow,column:facebook_group_join_audit.trigger_source
-- aidcp:objects=column:facebook_group_join_audit.verdict,column:facebook_group_join_automation_config.account_id,column:facebook_group_join_automation_config.daily_cap,column:facebook_group_join_automation_config.enabled
-- aidcp:objects=column:facebook_group_join_automation_config.updated_at,column:facebook_group_join_automation_config.updated_by,column:facebook_group_join_automation_config.week_mask,column:facebook_group_membership.account_id
-- aidcp:objects=column:facebook_group_membership.assigned_at,column:facebook_group_membership.attempts,column:facebook_group_membership.comments_total,column:facebook_group_membership.cooldown_until
-- aidcp:objects=column:facebook_group_membership.created_at,column:facebook_group_membership.group_url,column:facebook_group_membership.id,column:facebook_group_membership.joined_at
-- aidcp:objects=column:facebook_group_membership.last_attempt_at,column:facebook_group_membership.last_commented_at,column:facebook_group_membership.last_reason,column:facebook_group_membership.left_confirmations
-- aidcp:objects=column:facebook_group_membership.status,column:facebook_group_membership.updated_at,column:facebook_group_target.created_at,column:facebook_group_target.direction
-- aidcp:objects=column:facebook_group_target.enabled,column:facebook_group_target.group_name,column:facebook_group_target.group_url,column:facebook_group_target.import_batch
-- aidcp:objects=column:facebook_group_target.join_gating,column:facebook_group_target.park,column:facebook_group_target.priority,column:facebook_group_target.region
-- aidcp:objects=column:facebook_group_target.scope_updated_at,column:facebook_group_target.scope_updated_by,column:facebook_group_target.updated_at,column:facebook_group_target_scope.account_group_label
-- aidcp:objects=column:facebook_group_target_scope.group_url,column:facebook_group_target_scope.updated_at,column:facebook_group_target_scope.updated_by,index:idx_fb_group_join_audit_account
-- aidcp:objects=index:idx_fb_group_join_audit_group,index:idx_fb_group_join_audit_scheduled,index:idx_fb_group_membership_account_status,index:idx_fb_group_membership_assigned_ttl
-- aidcp:objects=index:idx_fb_group_membership_coverage,index:idx_fb_group_membership_status,index:idx_fb_group_target_direction,index:idx_fb_group_target_enabled_gating
-- aidcp:objects=index:idx_fb_group_target_region_park,index:idx_fb_group_target_scope_label,index:idx_fb_publish_image_set_account_sha,index:idx_fb_publish_image_set_account_status_order
-- aidcp:objects=index:idx_fb_publish_image_set_reserved,index:idx_fb_publish_image_set_used_log,table:account_facebook_publish_image,table:account_facebook_publish_image_set
-- aidcp:objects=table:facebook_group_join_audit,table:facebook_group_join_automation_config,table:facebook_group_membership,table:facebook_group_target
-- aidcp:objects=table:facebook_group_target_scope
-- 补齐缺失迁移：Facebook 群组与发布媒体域（change cloud-schema-migration-executor 任务 3.1/3.2）。
-- DDL 原样抽自各存储的 SCHEMA_SQL 常量。account_facebook_publish_image_set 的外键指向 accounts 与 publish_log，
-- 故本文件 MUST 排在 0065（accounts）与 0001（publish_log）之后。本文件零运行时行为变化。

-- ==== 原样抽自 src/comment-agent/facebook-group-store.ts FACEBOOK_GROUP_TARGET_SCHEMA_SQL ====
CREATE TABLE IF NOT EXISTS facebook_group_target (
  group_url    TEXT PRIMARY KEY,
  group_name   TEXT,
  region       TEXT,
  park         TEXT,
  direction    TEXT,
  join_gating  TEXT NOT NULL DEFAULT 'unknown'
               CHECK (join_gating IN ('unknown','instant','gated')),
  priority     INTEGER NOT NULL DEFAULT 0,
  enabled      BOOLEAN NOT NULL DEFAULT true,
  import_batch TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE facebook_group_target ADD COLUMN IF NOT EXISTS group_name TEXT;
ALTER TABLE facebook_group_target ADD COLUMN IF NOT EXISTS region TEXT;
ALTER TABLE facebook_group_target ADD COLUMN IF NOT EXISTS park TEXT;
ALTER TABLE facebook_group_target ADD COLUMN IF NOT EXISTS direction TEXT;
ALTER TABLE facebook_group_target ADD COLUMN IF NOT EXISTS join_gating TEXT NOT NULL DEFAULT 'unknown';
ALTER TABLE facebook_group_target ADD COLUMN IF NOT EXISTS priority INTEGER NOT NULL DEFAULT 0;
ALTER TABLE facebook_group_target ADD COLUMN IF NOT EXISTS enabled BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE facebook_group_target ADD COLUMN IF NOT EXISTS import_batch TEXT;
ALTER TABLE facebook_group_target ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT now();
ALTER TABLE facebook_group_target ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();
ALTER TABLE facebook_group_target ADD COLUMN IF NOT EXISTS scope_updated_at TIMESTAMPTZ;
ALTER TABLE facebook_group_target ADD COLUMN IF NOT EXISTS scope_updated_by TEXT;

CREATE TABLE IF NOT EXISTS facebook_group_target_scope (
  group_url           TEXT NOT NULL REFERENCES facebook_group_target(group_url) ON DELETE CASCADE,
  account_group_label TEXT NOT NULL CHECK (account_group_label = btrim(account_group_label)
                                           AND char_length(account_group_label) BETWEEN 1 AND 64),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by          TEXT NOT NULL,
  PRIMARY KEY (group_url, account_group_label)
);
CREATE INDEX IF NOT EXISTS idx_fb_group_target_scope_label
  ON facebook_group_target_scope (account_group_label, group_url);

CREATE INDEX IF NOT EXISTS idx_fb_group_target_enabled_gating
  ON facebook_group_target (enabled, join_gating, priority DESC, created_at ASC);
CREATE INDEX IF NOT EXISTS idx_fb_group_target_region_park
  ON facebook_group_target (region, park)
  WHERE region IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_fb_group_target_direction
  ON facebook_group_target (direction)
  WHERE direction IS NOT NULL;

-- ==== 原样抽自 src/comment-agent/facebook-group-store.ts FACEBOOK_GROUP_MEMBERSHIP_SCHEMA_SQL ====
CREATE TABLE IF NOT EXISTS facebook_group_membership (
  id                  BIGSERIAL PRIMARY KEY,
  account_id          TEXT NOT NULL REFERENCES accounts(account_id) ON DELETE CASCADE,
  group_url           TEXT NOT NULL REFERENCES facebook_group_target(group_url) ON DELETE CASCADE,
  status              TEXT NOT NULL CHECK (status IN ('assigned','joining','joined','pending','gated','no_button','checkpoint','failed','left')),
  assigned_at         TIMESTAMPTZ,
  joined_at           TIMESTAMPTZ,
  last_attempt_at     TIMESTAMPTZ,
  attempts            INTEGER NOT NULL DEFAULT 0,
  last_reason         TEXT,
  last_commented_at   TIMESTAMPTZ,
  cooldown_until      TIMESTAMPTZ,
  comments_total      INTEGER NOT NULL DEFAULT 0,
  left_confirmations  INTEGER NOT NULL DEFAULT 0,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (group_url)
);

CREATE INDEX IF NOT EXISTS idx_fb_group_membership_account_status
  ON facebook_group_membership (account_id, status);
CREATE INDEX IF NOT EXISTS idx_fb_group_membership_status
  ON facebook_group_membership (status);
CREATE INDEX IF NOT EXISTS idx_fb_group_membership_coverage
  ON facebook_group_membership (account_id, status, last_commented_at NULLS FIRST);
CREATE INDEX IF NOT EXISTS idx_fb_group_membership_assigned_ttl
  ON facebook_group_membership (status, assigned_at);

-- ==== 原样抽自 src/comment-agent/facebook-group-store.ts FACEBOOK_GROUP_JOIN_AUDIT_SCHEMA_SQL ====
CREATE TABLE IF NOT EXISTS facebook_group_join_audit (
  id          BIGSERIAL PRIMARY KEY,
  account_id  TEXT NOT NULL,
  group_url   TEXT,
  outcome     TEXT NOT NULL,
  phase       TEXT,
  verdict     TEXT,
  reason      TEXT,
  shadow      BOOLEAN NOT NULL DEFAULT false,
  observation JSONB,
  trigger_source TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE facebook_group_join_audit ADD COLUMN IF NOT EXISTS trigger_source TEXT;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'facebook_group_join_audit_trigger_source_check') THEN
    ALTER TABLE facebook_group_join_audit
      ADD CONSTRAINT facebook_group_join_audit_trigger_source_check
      CHECK (trigger_source IS NULL OR trigger_source IN ('scheduled','manual_pool','manual_specific','shadow'));
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS idx_fb_group_join_audit_account
  ON facebook_group_join_audit (account_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_fb_group_join_audit_scheduled
  ON facebook_group_join_audit (account_id, created_at DESC)
  WHERE trigger_source = 'scheduled';
CREATE INDEX IF NOT EXISTS idx_fb_group_join_audit_group
  ON facebook_group_join_audit (group_url, created_at DESC);

-- ==== 原样抽自 src/config/facebook-group-join-automation-store.ts FACEBOOK_GROUP_JOIN_AUTOMATION_CONFIG_SCHEMA_SQL ====
CREATE TABLE IF NOT EXISTS facebook_group_join_automation_config (
  account_id  TEXT PRIMARY KEY,
  enabled     BOOLEAN NOT NULL DEFAULT false,
  daily_cap   INTEGER NOT NULL DEFAULT 0
              CHECK (daily_cap BETWEEN 0 AND 10),
  week_mask   TEXT
              CHECK (week_mask IS NULL OR week_mask ~ '^[01]{168}$'),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by  TEXT
);

-- ==== 原样抽自 src/publish-agent/facebook-publish-media-store.ts FACEBOOK_PUBLISH_MEDIA_SCHEMA_SQL ====
CREATE TABLE IF NOT EXISTS account_facebook_publish_image_set (
  id                     BIGSERIAL PRIMARY KEY,
  account_id             TEXT NOT NULL REFERENCES accounts(account_id) ON DELETE CASCADE,
  status                 TEXT NOT NULL DEFAULT 'available'
                         CHECK (status IN ('available','reserved','used','disabled','deleted','quarantine')),
  caption_hint           TEXT,
  sort_order             INTEGER NOT NULL DEFAULT 0,
  reserved_by            TEXT,
  reserved_at            TIMESTAMPTZ,
  used_by_publish_log_id INTEGER REFERENCES publish_log(id) ON DELETE SET NULL,
  last_error             TEXT,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS account_facebook_publish_image (
  id                    BIGSERIAL PRIMARY KEY,
  set_id                BIGINT NOT NULL REFERENCES account_facebook_publish_image_set(id) ON DELETE CASCADE,
  url                   TEXT NOT NULL,
  object_key            TEXT NOT NULL,
  filename              TEXT NOT NULL,
  content_type          TEXT NOT NULL,
  byte_size             INTEGER NOT NULL,
  sha256                TEXT NOT NULL,
  sort_order            INTEGER NOT NULL DEFAULT 0,
  duplicate_of_image_id BIGINT REFERENCES account_facebook_publish_image(id) ON DELETE SET NULL,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE account_facebook_publish_image_set ADD COLUMN IF NOT EXISTS caption_hint TEXT;
ALTER TABLE account_facebook_publish_image_set ADD COLUMN IF NOT EXISTS sort_order INTEGER NOT NULL DEFAULT 0;
ALTER TABLE account_facebook_publish_image_set ADD COLUMN IF NOT EXISTS reserved_by TEXT;
ALTER TABLE account_facebook_publish_image_set ADD COLUMN IF NOT EXISTS reserved_at TIMESTAMPTZ;
ALTER TABLE account_facebook_publish_image_set ADD COLUMN IF NOT EXISTS used_by_publish_log_id INTEGER REFERENCES publish_log(id) ON DELETE SET NULL;
ALTER TABLE account_facebook_publish_image_set ADD COLUMN IF NOT EXISTS last_error TEXT;
ALTER TABLE account_facebook_publish_image_set ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();
ALTER TABLE account_facebook_publish_image ADD COLUMN IF NOT EXISTS duplicate_of_image_id BIGINT REFERENCES account_facebook_publish_image(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_fb_publish_image_set_account_status_order
  ON account_facebook_publish_image_set (account_id, status, sort_order, id);
CREATE INDEX IF NOT EXISTS idx_fb_publish_image_set_reserved
  ON account_facebook_publish_image_set (status, reserved_at);
CREATE INDEX IF NOT EXISTS idx_fb_publish_image_set_used_log
  ON account_facebook_publish_image_set (used_by_publish_log_id);
CREATE INDEX IF NOT EXISTS idx_fb_publish_image_set_account_sha
  ON account_facebook_publish_image (sha256);
