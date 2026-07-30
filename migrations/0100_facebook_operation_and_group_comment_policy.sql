-- 0100_facebook_operation_and_group_comment_policy.sql
-- aidcp:kind=expand
-- aidcp:objects=table:facebook_operation_policy,table:facebook_operation_policy_audit
-- aidcp:objects=table:facebook_group_comment_policy,table:facebook_group_comment_policy_audit
-- aidcp:objects=index:idx_facebook_operation_policy_audit_env_revision,index:uq_facebook_operation_policy_audit_revision,index:idx_facebook_group_comment_policy_audit_target_revision

-- Environment-scoped base operation mode. Slow start remains authoritative in
-- client_environments.slow_start_since and overlays this base policy at read time.
CREATE SEQUENCE IF NOT EXISTS facebook_operation_policy_revision_seq
  AS BIGINT
  START WITH 1
  INCREMENT BY 1
  NO CYCLE;

CREATE TABLE IF NOT EXISTS facebook_operation_policy (
  env_key                                TEXT PRIMARY KEY
    REFERENCES client_environments(env_key) ON DELETE CASCADE,
  base_mode                              TEXT NOT NULL
    CHECK (base_mode IN ('persona', 'rule', 'consumption')),
  rule_views_per_like                    INTEGER NOT NULL DEFAULT 5
    CHECK (rule_views_per_like BETWEEN 1 AND 100),
  rule_join_every_n_rounds               INTEGER NOT NULL DEFAULT 2
    CHECK (rule_join_every_n_rounds BETWEEN 1 AND 20),
  consumption_views_per_like             INTEGER NOT NULL DEFAULT 5
    CHECK (consumption_views_per_like BETWEEN 1 AND 100),
  consumption_confirmed_likes_per_join   INTEGER NOT NULL DEFAULT 2
    CHECK (consumption_confirmed_likes_per_join BETWEEN 1 AND 20),
  consumption_confirmed_joins_per_comment INTEGER NOT NULL DEFAULT 2
    CHECK (consumption_confirmed_joins_per_comment BETWEEN 1 AND 20),
  policy_schema_version                  INTEGER NOT NULL DEFAULT 1
    CHECK (policy_schema_version = 1),
  policy_revision                        BIGINT NOT NULL
    DEFAULT nextval('facebook_operation_policy_revision_seq')
    CHECK (policy_revision >= 1),
  updated_at                             TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by                             TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS facebook_operation_policy_audit (
  audit_id             BIGSERIAL PRIMARY KEY,
  env_key              TEXT NOT NULL
    REFERENCES client_environments(env_key) ON DELETE CASCADE,
  prior_revision       BIGINT NOT NULL CHECK (prior_revision >= 0),
  new_revision         BIGINT NOT NULL UNIQUE CHECK (new_revision >= 1),
  before_policy        JSONB,
  after_policy         JSONB NOT NULL,
  actor_class          TEXT NOT NULL,
  actor_id             TEXT NOT NULL,
  request_id           TEXT NOT NULL,
  reason               TEXT,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (env_key, new_revision)
);

CREATE INDEX IF NOT EXISTS idx_facebook_operation_policy_audit_env_revision
  ON facebook_operation_policy_audit (env_key, new_revision DESC);

CREATE UNIQUE INDEX IF NOT EXISTS uq_facebook_operation_policy_audit_revision
  ON facebook_operation_policy_audit (new_revision);

-- Preserve the released rule-mode behavior as the resumable base. Active slow
-- start is deliberately not copied into base_mode; it remains an overlay.
INSERT INTO facebook_operation_policy (
  env_key,
  base_mode,
  rule_views_per_like,
  rule_join_every_n_rounds,
  consumption_views_per_like,
  consumption_confirmed_likes_per_join,
  consumption_confirmed_joins_per_comment,
  policy_schema_version,
  policy_revision,
  updated_at,
  updated_by
)
SELECT
  e.env_key,
  CASE WHEN COALESCE(r.enabled, false) THEN 'rule' ELSE 'persona' END,
  5,
  2,
  5,
  2,
  2,
  1,
  nextval('facebook_operation_policy_revision_seq'),
  COALESCE(r.updated_at, now()),
  COALESCE(r.updated_by, 'migration:0100')
FROM client_environments e
LEFT JOIN facebook_rule_mode_environment_config r ON r.env_key = e.env_key
WHERE lower(btrim(COALESCE(e.platform, ''))) IN ('facebook', 'fb')
ON CONFLICT (env_key) DO NOTHING;

INSERT INTO facebook_operation_policy_audit (
  env_key,
  prior_revision,
  new_revision,
  before_policy,
  after_policy,
  actor_class,
  actor_id,
  request_id,
  reason,
  created_at
)
SELECT
  p.env_key,
  0,
  p.policy_revision,
  NULL,
  jsonb_build_object(
    'baseMode', p.base_mode,
    'rule', jsonb_build_object(
      'viewsPerLike', p.rule_views_per_like,
      'joinEveryNRounds', p.rule_join_every_n_rounds
    ),
    'consumption', jsonb_build_object(
      'viewsPerLike', p.consumption_views_per_like,
      'confirmedLikesPerJoin', p.consumption_confirmed_likes_per_join,
      'confirmedJoinsPerComment', p.consumption_confirmed_joins_per_comment
    ),
    'policySchemaVersion', p.policy_schema_version,
    'policyRevision', p.policy_revision
  ),
  'migration',
  '0100',
  'migration:0100:' || p.env_key,
  'seed_from_environment_rule_mode',
  p.updated_at
FROM facebook_operation_policy p
ON CONFLICT (env_key, new_revision) DO NOTHING;

-- Target-local first-comment wait. Absence is meaningful during migration:
-- readers use legacy env configuration, then the compiled default, and report
-- the source. Therefore this migration does not fabricate DEV/OL rows.
CREATE TABLE IF NOT EXISTS facebook_group_comment_policy (
  execution_target                  TEXT PRIMARY KEY
    CHECK (execution_target IN ('dev', 'ol')),
  join_to_first_comment_hours       INTEGER NOT NULL DEFAULT 24
    CHECK (join_to_first_comment_hours BETWEEN 1 AND 168),
  revision                          BIGINT NOT NULL DEFAULT 1
    CHECK (revision >= 1),
  updated_at                        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by                        TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS facebook_group_comment_policy_audit (
  audit_id                          BIGSERIAL PRIMARY KEY,
  execution_target                  TEXT NOT NULL
    CHECK (execution_target IN ('dev', 'ol')),
  prior_revision                    BIGINT NOT NULL CHECK (prior_revision >= 0),
  new_revision                      BIGINT NOT NULL CHECK (new_revision >= 1),
  before_policy                     JSONB,
  after_policy                      JSONB NOT NULL,
  actor_class                       TEXT NOT NULL,
  actor_id                          TEXT NOT NULL,
  request_id                        TEXT NOT NULL,
  reason                            TEXT,
  created_at                        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (execution_target, new_revision)
);

CREATE INDEX IF NOT EXISTS idx_facebook_group_comment_policy_audit_target_revision
  ON facebook_group_comment_policy_audit (execution_target, new_revision DESC);
