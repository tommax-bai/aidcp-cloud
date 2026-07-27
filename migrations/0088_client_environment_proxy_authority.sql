-- aidcp:kind=expand
-- aidcp:objects=table:client_environment_proxy_authorities
-- aidcp:objects=column:client_environment_proxy_authorities.env_key,column:client_environment_proxy_authorities.state
-- aidcp:objects=column:client_environment_proxy_authorities.proxy_type,column:client_environment_proxy_authorities.proxy_host
-- aidcp:objects=column:client_environment_proxy_authorities.proxy_port,column:client_environment_proxy_authorities.proxy_user
-- aidcp:objects=column:client_environment_proxy_authorities.proxy_password,column:client_environment_proxy_authorities.revision
-- aidcp:objects=column:client_environment_proxy_authorities.source,column:client_environment_proxy_authorities.updated_by
-- aidcp:objects=column:client_environment_proxy_authorities.updated_at

CREATE TABLE IF NOT EXISTS client_environment_proxy_authorities (
  env_key        TEXT        PRIMARY KEY REFERENCES client_environments(env_key) ON DELETE CASCADE,
  state          TEXT        NOT NULL CHECK (state IN ('configured','no_proxy')),
  proxy_type     TEXT        CHECK (proxy_type IS NULL OR proxy_type IN ('http','https','socks5')),
  proxy_host     TEXT,
  proxy_port     INTEGER     CHECK (proxy_port IS NULL OR proxy_port BETWEEN 1 AND 65535),
  proxy_user     TEXT,
  proxy_password TEXT,
  revision       INTEGER     NOT NULL DEFAULT 1 CHECK (revision > 0),
  source         TEXT        NOT NULL CHECK (source IN ('provisioning','edge_edit','local_migration','admin')),
  updated_by     TEXT        NOT NULL,
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (
    (
      state = 'configured'
      AND proxy_type IS NOT NULL
      AND proxy_host IS NOT NULL
      AND proxy_port IS NOT NULL
      AND proxy_user IS NOT NULL
      AND proxy_password IS NOT NULL
    )
    OR
    (
      state = 'no_proxy'
      AND proxy_type IS NULL
      AND proxy_host IS NULL
      AND proxy_port IS NULL
      AND proxy_user IS NULL
      AND proxy_password IS NULL
    )
  )
);
