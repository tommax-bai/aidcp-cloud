-- aidcp:kind=expand
-- aidcp:objects=table:facebook_rule_mode_config

CREATE TABLE IF NOT EXISTS facebook_rule_mode_config (
  account_id          TEXT PRIMARY KEY,
  enabled             BOOLEAN NOT NULL DEFAULT false,
  definition_id       TEXT NOT NULL DEFAULT 'facebook_browse_10_like_1_join_contact_1',
  definition_version  INTEGER NOT NULL DEFAULT 1,
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by          TEXT,
  CHECK (definition_id = 'facebook_browse_10_like_1_join_contact_1'),
  CHECK (definition_version = 1)
);
