-- 0102_facebook_consumption_runtime.sql
-- aidcp:kind=expand
-- aidcp:objects=table:facebook_consumption_progress,table:facebook_consumption_view_fact,table:facebook_consumption_action,table:facebook_consumption_action_result_fact,constraint:facebook_group_join_audit.facebook_group_join_audit_trigger_source_check
-- aidcp:objects=index:uq_facebook_consumption_active_action,index:idx_facebook_consumption_action_revision,index:idx_facebook_consumption_result_source

-- Runtime configuration is environment-scoped, but execution facts remain owned by
-- account + execution_target + immutable policy_revision. No row in this migration
-- is shared as progress between DEV and OL.

ALTER TABLE facebook_group_join_audit
  DROP CONSTRAINT IF EXISTS facebook_group_join_audit_trigger_source_check;
ALTER TABLE facebook_group_join_audit
  ADD CONSTRAINT facebook_group_join_audit_trigger_source_check
  CHECK (
    trigger_source IS NULL
    OR trigger_source IN (
      'scheduled', 'manual_pool', 'manual_specific', 'consumption', 'shadow'
    )
  );

CREATE TABLE IF NOT EXISTS facebook_consumption_progress (
  account_id                              TEXT NOT NULL,
  execution_target                       TEXT NOT NULL CHECK (execution_target IN ('dev', 'ol')),
  policy_revision                        BIGINT NOT NULL CHECK (policy_revision > 0),
  policy_snapshot                        JSONB NOT NULL,
  revision_state                         TEXT NOT NULL DEFAULT 'active'
    CHECK (revision_state IN ('active', 'superseded')),
  collecting_sequence                    BIGINT NOT NULL DEFAULT 1
    CHECK (collecting_sequence > 0),
  views_since_like                       INTEGER NOT NULL DEFAULT 0
    CHECK (views_since_like BETWEEN 0 AND 99),
  confirmed_new_likes_since_join         INTEGER NOT NULL DEFAULT 0
    CHECK (confirmed_new_likes_since_join BETWEEN 0 AND 19),
  confirmed_new_joins_since_comment      INTEGER NOT NULL DEFAULT 0
    CHECK (confirmed_new_joins_since_comment BETWEEN 0 AND 19),
  next_action_sequence                   BIGINT NOT NULL DEFAULT 1
    CHECK (next_action_sequence > 0),
  active_action_id                       UUID,
  superseded_at                          TIMESTAMPTZ,
  created_at                             TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                             TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, execution_target, policy_revision),
  CHECK (
    policy_snapshot ?& ARRAY[
      'viewsPerLike',
      'confirmedLikesPerJoin',
      'confirmedJoinsPerComment'
    ]
  ),
  CHECK (
    (policy_snapshot->>'viewsPerLike')::INTEGER BETWEEN 1 AND 100
    AND (policy_snapshot->>'confirmedLikesPerJoin')::INTEGER BETWEEN 1 AND 20
    AND (policy_snapshot->>'confirmedJoinsPerComment')::INTEGER BETWEEN 1 AND 20
  ),
  CHECK (
    (revision_state = 'active' AND superseded_at IS NULL)
    OR (revision_state = 'superseded' AND superseded_at IS NOT NULL)
  )
);

CREATE TABLE IF NOT EXISTS facebook_consumption_view_fact (
  account_id             TEXT NOT NULL,
  execution_target      TEXT NOT NULL CHECK (execution_target IN ('dev', 'ol')),
  policy_revision       BIGINT NOT NULL CHECK (policy_revision > 0),
  collecting_sequence   BIGINT NOT NULL CHECK (collecting_sequence > 0),
  content_key           TEXT NOT NULL CHECK (length(btrim(content_key)) > 0),
  content_url           TEXT NOT NULL CHECK (length(btrim(content_url)) > 0),
  source_dedupe_key     TEXT NOT NULL CHECK (length(btrim(source_dedupe_key)) > 0),
  occurred_at           TIMESTAMPTZ NOT NULL,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (
    account_id, execution_target, policy_revision, collecting_sequence, content_key
  ),
  UNIQUE (
    account_id, execution_target, policy_revision, source_dedupe_key
  ),
  FOREIGN KEY (account_id, execution_target, policy_revision)
    REFERENCES facebook_consumption_progress (
      account_id, execution_target, policy_revision
    )
);

CREATE TABLE IF NOT EXISTS facebook_consumption_action (
  action_id                    UUID PRIMARY KEY,
  account_id                   TEXT NOT NULL,
  execution_target            TEXT NOT NULL CHECK (execution_target IN ('dev', 'ol')),
  policy_revision             BIGINT NOT NULL CHECK (policy_revision > 0),
  policy_snapshot             JSONB NOT NULL,
  action_sequence             BIGINT NOT NULL CHECK (action_sequence > 0),
  action_type                 TEXT NOT NULL CHECK (action_type IN ('like', 'join', 'comment')),
  idempotency_key             TEXT NOT NULL CHECK (length(btrim(idempotency_key)) > 0),
  trigger_source_dedupe_key   TEXT NOT NULL
    CHECK (length(btrim(trigger_source_dedupe_key)) > 0),
  state                       TEXT NOT NULL
    CHECK (state IN ('waiting_target', 'waiting_gate', 'ready', 'dispatched', 'terminal')),
  dispatch_phase              TEXT NOT NULL DEFAULT 'not_started'
    CHECK (dispatch_phase IN ('not_started', 'dispatched', 'settled')),
  outcome                     TEXT CHECK (outcome IN (
    'confirmed_new_like', 'confirmed_new_join', 'confirmed_comment',
    'already_liked', 'already_reacted', 'already_member',
    'pending', 'ambiguous', 'submitted_unknown', 'gated', 'not_started',
    'structural', 'rejected', 'failed', 'policy_superseded'
  )),
  blocker                     TEXT,
  downstream_enabled          BOOLEAN NOT NULL DEFAULT true,
  group_key                   TEXT,
  group_url                   TEXT,
  content_key                 TEXT,
  content_url                 TEXT,
  selection_strategy          TEXT CHECK (
    selection_strategy IS NULL OR selection_strategy = 'first_commentable_group_post'
  ),
  target_evidence             JSONB,
  owner_id                    TEXT,
  owner_expires_at            TIMESTAMPTZ,
  version                     BIGINT NOT NULL DEFAULT 1 CHECK (version > 0),
  dispatched_at               TIMESTAMPTZ,
  settled_at                  TIMESTAMPTZ,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (action_id, account_id, execution_target, policy_revision),
  UNIQUE (account_id, execution_target, policy_revision, action_sequence),
  UNIQUE (account_id, execution_target, policy_revision, action_type, trigger_source_dedupe_key),
  UNIQUE (idempotency_key),
  FOREIGN KEY (account_id, execution_target, policy_revision)
    REFERENCES facebook_consumption_progress (
      account_id, execution_target, policy_revision
    ),
  CHECK (
    policy_snapshot ?& ARRAY[
      'viewsPerLike',
      'confirmedLikesPerJoin',
      'confirmedJoinsPerComment'
    ]
  ),
  CHECK (
    (policy_snapshot->>'viewsPerLike')::INTEGER BETWEEN 1 AND 100
    AND (policy_snapshot->>'confirmedLikesPerJoin')::INTEGER BETWEEN 1 AND 20
    AND (policy_snapshot->>'confirmedJoinsPerComment')::INTEGER BETWEEN 1 AND 20
  ),
  CHECK (group_key IS NULL OR length(btrim(group_key)) > 0),
  CHECK (group_url IS NULL OR length(btrim(group_url)) > 0),
  CHECK (content_key IS NULL OR length(btrim(content_key)) > 0),
  CHECK (content_url IS NULL OR length(btrim(content_url)) > 0),
  CHECK (
    action_type <> 'like'
    OR (content_key IS NOT NULL AND content_url IS NOT NULL)
  ),
  CHECK (
    state NOT IN ('ready', 'dispatched')
    OR (action_type = 'like' AND content_key IS NOT NULL AND content_url IS NOT NULL)
    OR (action_type = 'join' AND group_url IS NOT NULL)
    OR (
      action_type = 'comment'
      AND group_url IS NOT NULL
      AND content_key IS NOT NULL
      AND content_url IS NOT NULL
      AND selection_strategy = 'first_commentable_group_post'
    )
  ),
  CHECK (
    (state = 'terminal'
      AND dispatch_phase = 'settled'
      AND outcome IS NOT NULL
      AND outcome <> 'pending'
      AND settled_at IS NOT NULL)
    OR (state = 'dispatched'
      AND dispatch_phase = 'dispatched'
      AND (outcome IS NULL OR outcome = 'pending')
      AND dispatched_at IS NOT NULL
      AND settled_at IS NULL)
    OR (state IN ('waiting_target', 'waiting_gate', 'ready')
      AND dispatch_phase = 'not_started'
      AND outcome IS NULL
      AND dispatched_at IS NULL
      AND settled_at IS NULL)
  ),
  CHECK (
    (owner_id IS NULL AND owner_expires_at IS NULL)
    OR (owner_id IS NOT NULL AND owner_expires_at IS NOT NULL)
  )
);

-- One account may have historical rows in many revisions, but only one live
-- consumption obligation across all of them on the local deployment target.
CREATE UNIQUE INDEX IF NOT EXISTS uq_facebook_consumption_active_action
  ON facebook_consumption_action (account_id, execution_target)
  WHERE state <> 'terminal';

CREATE INDEX IF NOT EXISTS idx_facebook_consumption_action_revision
  ON facebook_consumption_action (
    account_id, execution_target, policy_revision, action_sequence DESC
  );

CREATE TABLE IF NOT EXISTS facebook_consumption_action_result_fact (
  action_id              UUID NOT NULL,
  account_id             TEXT NOT NULL,
  execution_target      TEXT NOT NULL CHECK (execution_target IN ('dev', 'ol')),
  policy_revision       BIGINT NOT NULL CHECK (policy_revision > 0),
  source_dedupe_key     TEXT NOT NULL CHECK (length(btrim(source_dedupe_key)) > 0),
  outcome               TEXT NOT NULL CHECK (outcome IN (
    'confirmed_new_like', 'confirmed_new_join', 'confirmed_comment',
    'already_liked', 'already_reacted', 'already_member',
    'pending', 'ambiguous', 'submitted_unknown', 'gated', 'not_started',
    'structural', 'rejected', 'failed', 'policy_superseded'
  )),
  evidence              JSONB,
  occurred_at           TIMESTAMPTZ NOT NULL,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (action_id, source_dedupe_key),
  UNIQUE (
    account_id, execution_target, policy_revision, source_dedupe_key
  ),
  FOREIGN KEY (action_id, account_id, execution_target, policy_revision)
    REFERENCES facebook_consumption_action (
      action_id, account_id, execution_target, policy_revision
    )
);

CREATE INDEX IF NOT EXISTS idx_facebook_consumption_result_source
  ON facebook_consumption_action_result_fact (
    account_id, execution_target, policy_revision, source_dedupe_key
  );
