-- aidcp:kind=expand
-- aidcp:objects=column:persona_auto_fill_runs.created_at,column:persona_auto_fill_runs.idempotency_key,column:persona_auto_fill_runs.persona_soul_yaml,column:persona_auto_fill_runs.platform
-- aidcp:objects=column:persona_auto_fill_runs.run_id,column:persona_auto_fill_runs.state,column:persona_auto_fill_runs.strategy,column:persona_auto_fill_runs.updated_at
-- aidcp:objects=column:persona_auto_fill_runs.user_id,column:persona_auto_fill_runs.writing_language,column:persona_auto_fill_targets.account_id,column:persona_auto_fill_targets.attempts
-- aidcp:objects=column:persona_auto_fill_targets.env_key,column:persona_auto_fill_targets.reason,column:persona_auto_fill_targets.run_id,column:persona_auto_fill_targets.state
-- aidcp:objects=column:persona_auto_fill_targets.updated_at,index:persona_auto_fill_targets_env_idx,index:persona_auto_fill_targets_run_state_idx,table:persona_auto_fill_runs
-- aidcp:objects=table:persona_auto_fill_targets
-- 补齐缺失迁移：人设自动补齐域（change cloud-schema-migration-executor 任务 3.1/3.2）。
-- DDL 原样抽自 src/config/persona-auto-fill-store.ts 的 PERSONA_AUTO_FILL_SCHEMA_SQL。本文件零运行时行为变化。

-- ==== 原样抽自 src/config/persona-auto-fill-store.ts PERSONA_AUTO_FILL_SCHEMA_SQL ====
CREATE TABLE IF NOT EXISTS persona_auto_fill_runs (
  run_id            UUID        PRIMARY KEY,
  user_id           TEXT        NOT NULL REFERENCES client_users(user_id) ON DELETE CASCADE,
  idempotency_key   TEXT        NOT NULL,
  platform          TEXT        NOT NULL CHECK (platform = 'facebook'),
  strategy          TEXT        NOT NULL CHECK (strategy IN ('facebook_auto_v1','selected_persona_v1')),
  writing_language  TEXT        NOT NULL CHECK (writing_language IN ('zh-CN','en','vi')),
  persona_soul_yaml TEXT,
  state             TEXT        NOT NULL DEFAULT 'running'
    CHECK (state IN ('running','completed','completed_with_failures')),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, idempotency_key)
);

CREATE TABLE IF NOT EXISTS persona_auto_fill_targets (
  run_id      UUID        NOT NULL REFERENCES persona_auto_fill_runs(run_id) ON DELETE CASCADE,
  env_key     TEXT        NOT NULL,
  account_id  TEXT,
  state       TEXT        NOT NULL DEFAULT 'pending'
    CHECK (state IN ('waiting_binding','pending','running','succeeded','skipped_existing','failed')),
  attempts    INTEGER     NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  reason      TEXT,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (run_id, env_key)
);
CREATE INDEX IF NOT EXISTS persona_auto_fill_targets_env_idx
  ON persona_auto_fill_targets (env_key, state);
CREATE INDEX IF NOT EXISTS persona_auto_fill_targets_run_state_idx
  ON persona_auto_fill_targets (run_id, state);

ALTER TABLE persona_auto_fill_runs
  ADD COLUMN IF NOT EXISTS persona_soul_yaml TEXT;
ALTER TABLE persona_auto_fill_runs
  DROP CONSTRAINT IF EXISTS persona_auto_fill_runs_strategy_check;
ALTER TABLE persona_auto_fill_runs
  ADD CONSTRAINT persona_auto_fill_runs_strategy_check
  CHECK (strategy IN ('facebook_auto_v1','selected_persona_v1'));
