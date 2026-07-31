-- 0103_facebook_operation_global_policy.sql
-- aidcp:kind=expand
-- aidcp:objects=table:facebook_operation_global_policy,table:facebook_operation_global_policy_audit
-- aidcp:objects=table:facebook_environment_slow_start_completion,column:facebook_operation_policy.cadence_source
-- aidcp:objects=index:idx_facebook_operation_global_policy_audit_target_revision,index:idx_facebook_environment_slow_start_completion_target

ALTER TABLE facebook_operation_policy
  ADD COLUMN IF NOT EXISTS cadence_source TEXT NOT NULL DEFAULT 'environment'
    CHECK (cadence_source IN ('global', 'environment'));

-- Rows predating the global policy were explicitly edited/materialized per
-- environment. Preserve them as independent overrides.
ALTER TABLE facebook_operation_policy
  ALTER COLUMN cadence_source SET DEFAULT 'global';

CREATE TABLE IF NOT EXISTS facebook_environment_slow_start_completion (
  env_key            TEXT NOT NULL
    REFERENCES client_environments(env_key) ON DELETE CASCADE,
  execution_target   TEXT NOT NULL
    CHECK (execution_target IN ('dev', 'ol')),
  completed_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (env_key, execution_target)
);

CREATE INDEX IF NOT EXISTS idx_facebook_environment_slow_start_completion_target
  ON facebook_environment_slow_start_completion (execution_target, completed_at DESC);

CREATE TABLE IF NOT EXISTS facebook_operation_global_policy (
  execution_target                         TEXT PRIMARY KEY
    CHECK (execution_target IN ('dev', 'ol')),
  rule_views_per_like                      INTEGER NOT NULL DEFAULT 5
    CHECK (rule_views_per_like BETWEEN 1 AND 100),
  rule_join_every_n_rounds                 INTEGER NOT NULL DEFAULT 2
    CHECK (rule_join_every_n_rounds BETWEEN 1 AND 20),
  consumption_views_per_like               INTEGER NOT NULL DEFAULT 5
    CHECK (consumption_views_per_like BETWEEN 1 AND 100),
  consumption_confirmed_likes_per_join     INTEGER NOT NULL DEFAULT 2
    CHECK (consumption_confirmed_likes_per_join BETWEEN 1 AND 20),
  consumption_confirmed_joins_per_comment  INTEGER NOT NULL DEFAULT 2
    CHECK (consumption_confirmed_joins_per_comment BETWEEN 1 AND 20),
  slow_start_total_days                    INTEGER NOT NULL DEFAULT 7
    CHECK (slow_start_total_days BETWEEN 1 AND 30),
  slow_start_daily_caps                    JSONB NOT NULL
    CHECK (jsonb_typeof(slow_start_daily_caps) = 'array'),
  revision                                 BIGINT NOT NULL DEFAULT 1
    CHECK (revision >= 1),
  updated_at                               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by                               TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS facebook_operation_global_policy_audit (
  audit_id           BIGSERIAL PRIMARY KEY,
  execution_target   TEXT NOT NULL
    CHECK (execution_target IN ('dev', 'ol')),
  prior_revision     BIGINT NOT NULL CHECK (prior_revision >= 0),
  new_revision       BIGINT NOT NULL CHECK (new_revision >= 1),
  before_policy      JSONB,
  after_policy       JSONB NOT NULL,
  actor_class        TEXT NOT NULL,
  actor_id           TEXT NOT NULL,
  request_id         TEXT NOT NULL,
  reason             TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (execution_target, new_revision)
);

CREATE INDEX IF NOT EXISTS idx_facebook_operation_global_policy_audit_target_revision
  ON facebook_operation_global_policy_audit (execution_target, new_revision DESC);

INSERT INTO facebook_operation_global_policy (
  execution_target,
  rule_views_per_like,
  rule_join_every_n_rounds,
  consumption_views_per_like,
  consumption_confirmed_likes_per_join,
  consumption_confirmed_joins_per_comment,
  slow_start_total_days,
  slow_start_daily_caps,
  revision,
  updated_at,
  updated_by
)
SELECT
  target,
  5,
  2,
  5,
  2,
  2,
  7,
  '[
    {"day":1,"view":20,"like":2,"comment":0,"follow":1,"publish":0,"search":1,"joinGroup":0},
    {"day":2,"view":25,"like":3,"comment":0,"follow":1,"publish":0,"search":1,"joinGroup":0},
    {"day":3,"view":35,"like":6,"comment":1,"follow":2,"publish":0,"search":2,"joinGroup":1},
    {"day":4,"view":40,"like":8,"comment":2,"follow":2,"publish":0,"search":2,"joinGroup":1},
    {"day":5,"view":50,"like":12,"comment":3,"follow":3,"publish":1,"search":3,"joinGroup":2},
    {"day":6,"view":60,"like":15,"comment":4,"follow":4,"publish":1,"search":4,"joinGroup":2},
    {"day":7,"view":70,"like":18,"comment":5,"follow":5,"publish":1,"search":5,"joinGroup":3}
  ]'::jsonb,
  1,
  now(),
  'migration:0103'
FROM (VALUES ('dev'), ('ol')) AS targets(target)
ON CONFLICT (execution_target) DO NOTHING;

INSERT INTO facebook_operation_global_policy_audit (
  execution_target,
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
  p.execution_target,
  0,
  p.revision,
  NULL,
  jsonb_build_object(
    'rule', jsonb_build_object(
      'viewsPerLike', p.rule_views_per_like,
      'joinEveryNRounds', p.rule_join_every_n_rounds
    ),
    'consumption', jsonb_build_object(
      'viewsPerLike', p.consumption_views_per_like,
      'confirmedLikesPerJoin', p.consumption_confirmed_likes_per_join,
      'confirmedJoinsPerComment', p.consumption_confirmed_joins_per_comment
    ),
    'slowStart', jsonb_build_object(
      'totalDays', p.slow_start_total_days,
      'dailyCaps', p.slow_start_daily_caps
    ),
    'revision', p.revision
  ),
  'migration',
  '0103',
  'migration:0103:' || p.execution_target,
  'seed_global_numeric_policy',
  p.updated_at
FROM facebook_operation_global_policy p
ON CONFLICT (execution_target, new_revision) DO NOTHING;
