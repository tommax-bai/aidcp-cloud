-- aidcp:kind=expand
-- aidcp:objects=table:facebook_rule_progress,table:facebook_rule_view_fact,table:facebook_rule_batch
-- aidcp:objects=index:idx_facebook_rule_batch_account_target

CREATE TABLE IF NOT EXISTS facebook_rule_progress (
  account_id          TEXT NOT NULL,
  execution_target    TEXT NOT NULL CHECK (execution_target IN ('dev', 'ol')),
  definition_id       TEXT NOT NULL,
  definition_version  INTEGER NOT NULL,
  collecting_sequence BIGINT NOT NULL DEFAULT 1,
  view_count           INTEGER NOT NULL DEFAULT 0 CHECK (view_count BETWEEN 0 AND 9),
  active_batch_id      UUID,
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, execution_target, definition_id, definition_version),
  CHECK (definition_id = 'facebook_browse_10_like_1_join_contact_1'),
  CHECK (definition_version = 1)
);

CREATE TABLE IF NOT EXISTS facebook_rule_view_fact (
  account_id          TEXT NOT NULL,
  execution_target    TEXT NOT NULL CHECK (execution_target IN ('dev', 'ol')),
  definition_id       TEXT NOT NULL,
  definition_version  INTEGER NOT NULL,
  collecting_sequence BIGINT NOT NULL,
  content_key         TEXT NOT NULL,
  source_dedupe_key   TEXT NOT NULL,
  occurred_at         TIMESTAMPTZ NOT NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (
    account_id, execution_target, definition_id, definition_version,
    collecting_sequence, content_key
  ),
  UNIQUE (
    account_id, execution_target, definition_id, definition_version,
    source_dedupe_key
  ),
  CHECK (definition_id = 'facebook_browse_10_like_1_join_contact_1'),
  CHECK (definition_version = 1)
);

CREATE TABLE IF NOT EXISTS facebook_rule_batch (
  batch_id            UUID PRIMARY KEY,
  account_id          TEXT NOT NULL,
  execution_target    TEXT NOT NULL CHECK (execution_target IN ('dev', 'ol')),
  definition_id       TEXT NOT NULL,
  definition_version  INTEGER NOT NULL,
  sequence            BIGINT NOT NULL,
  trigger_content_key TEXT NOT NULL,
  like_state          TEXT NOT NULL DEFAULT 'pending',
  join_state          TEXT NOT NULL DEFAULT 'pending',
  comment_state       TEXT NOT NULL DEFAULT 'pending',
  terminal            BOOLEAN NOT NULL DEFAULT false,
  blocker             TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (account_id, execution_target, definition_id, definition_version, sequence),
  CHECK (definition_id = 'facebook_browse_10_like_1_join_contact_1'),
  CHECK (definition_version = 1),
  CHECK (like_state IN (
    'pending', 'dispatched', 'confirmed', 'already_satisfied', 'risk_suppressed',
    'structural_skip', 'not_started', 'rejected', 'failed', 'ambiguous', 'submitted_unknown'
  )),
  CHECK (join_state IN (
    'pending', 'dispatched', 'confirmed', 'already_satisfied', 'risk_suppressed',
    'structural_skip', 'not_started', 'rejected', 'failed', 'ambiguous', 'submitted_unknown'
  )),
  CHECK (comment_state IN (
    'pending', 'dispatched', 'confirmed', 'already_satisfied', 'risk_suppressed',
    'structural_skip', 'not_started', 'rejected', 'failed', 'ambiguous', 'submitted_unknown'
  ))
);

CREATE INDEX IF NOT EXISTS idx_facebook_rule_batch_account_target
  ON facebook_rule_batch (account_id, execution_target, created_at DESC);
