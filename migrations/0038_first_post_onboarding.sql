-- 0038_first_post_onboarding.sql (change persona-first-post-onboarding)
-- Durable per-account first-post state. The row is lifetime evidence that the
-- first-persona onboarding has already been created; persona unbind/rebind does
-- not delete it. Conditional UPDATE transitions provide the cross-event claim.

CREATE TABLE IF NOT EXISTS first_post_onboarding (
  account_id   TEXT PRIMARY KEY REFERENCES accounts(account_id) ON DELETE CASCADE,
  state        TEXT NOT NULL DEFAULT 'searching'
               CHECK (state IN ('searching', 'generating', 'generated')),
  started_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  source_id    TEXT,
  last_error   TEXT,
  generated_at TIMESTAMPTZ,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_first_post_onboarding_state
  ON first_post_onboarding (state, updated_at);
