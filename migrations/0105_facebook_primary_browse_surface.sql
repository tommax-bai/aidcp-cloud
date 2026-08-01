-- 0105_facebook_primary_browse_surface.sql
-- aidcp:kind=expand
-- aidcp:objects=table:facebook_primary_browse_surface_policy,table:facebook_primary_browse_surface_policy_audit
-- aidcp:objects=index:idx_facebook_primary_browse_surface_audit_env_revision

CREATE TABLE IF NOT EXISTS facebook_primary_browse_surface_policy (
  env_key          TEXT PRIMARY KEY
    REFERENCES client_environments(env_key) ON DELETE CASCADE,
  primary_surface  TEXT NOT NULL DEFAULT 'reels'
    CHECK (primary_surface IN ('feed', 'reels')),
  revision         BIGINT NOT NULL DEFAULT 1 CHECK (revision >= 1),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by       TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS facebook_primary_browse_surface_policy_audit (
  audit_id         BIGSERIAL PRIMARY KEY,
  env_key          TEXT NOT NULL
    REFERENCES client_environments(env_key) ON DELETE CASCADE,
  prior_revision   BIGINT NOT NULL CHECK (prior_revision >= 0),
  new_revision     BIGINT NOT NULL CHECK (new_revision >= 1),
  before_policy    JSONB,
  after_policy     JSONB NOT NULL,
  actor_class      TEXT NOT NULL,
  actor_id         TEXT NOT NULL,
  request_id       TEXT NOT NULL,
  reason           TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (env_key, new_revision)
);

CREATE INDEX IF NOT EXISTS idx_facebook_primary_browse_surface_audit_env_revision
  ON facebook_primary_browse_surface_policy_audit (env_key, new_revision DESC);

INSERT INTO facebook_primary_browse_surface_policy (
  env_key,
  primary_surface,
  revision,
  updated_at,
  updated_by
)
SELECT
  e.env_key,
  'reels',
  1,
  now(),
  'migration:0105'
FROM client_environments e
WHERE lower(btrim(COALESCE(e.platform, ''))) IN ('facebook', 'fb')
ON CONFLICT (env_key) DO NOTHING;

INSERT INTO facebook_primary_browse_surface_policy_audit (
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
  p.revision,
  NULL,
  jsonb_build_object(
    'primarySurface', p.primary_surface,
    'surfaceRevision', p.revision
  ),
  'migration',
  '0105',
  'migration:0105:' || p.env_key,
  'seed_existing_facebook_environment_to_reels',
  p.updated_at
FROM facebook_primary_browse_surface_policy p
WHERE p.updated_by = 'migration:0105'
ON CONFLICT (env_key, new_revision) DO NOTHING;
