-- aidcp:kind=expand
-- aidcp:objects=column:llm_billing_price_snapshot.completion_cost_per_1k,column:llm_billing_price_snapshot.currency,column:llm_billing_price_snapshot.model,column:llm_billing_price_snapshot.prompt_cost_per_1k
-- aidcp:objects=column:llm_billing_price_snapshot.provider,column:llm_billing_price_snapshot.source,column:llm_billing_price_snapshot.source_period,column:llm_billing_price_snapshot.source_synced_at
-- aidcp:objects=column:llm_billing_price_snapshot.total_cost_per_1k,column:llm_billing_price_snapshot.updated_at,column:llm_billing_price_snapshot.usage_day,column:llm_token_usage.provider
-- aidcp:objects=index:idx_llm_billing_price_snapshot_day,index:idx_llm_token_usage_provider_model_bucket,table:llm_billing_price_snapshot
-- 0033_llm_billing_cost_estimates.sql
--
-- Keep token cost estimates billing-backed: token usage records include provider,
-- and cost estimates are derived only from billing price snapshots.

ALTER TABLE llm_token_usage
  ADD COLUMN IF NOT EXISTS provider TEXT NOT NULL DEFAULT 'unknown';

DO $$
DECLARE
  pk_name text;
  pk_def text;
BEGIN
  SELECT conname, pg_get_constraintdef(oid)
    INTO pk_name, pk_def
    FROM pg_constraint
   WHERE conrelid = 'llm_token_usage'::regclass
     AND contype = 'p'
   LIMIT 1;

  IF pk_name IS NULL THEN
    ALTER TABLE llm_token_usage
      ADD PRIMARY KEY (bucket_start, account_id, role, provider, model);
  ELSIF pk_def NOT LIKE '%provider%' THEN
    EXECUTE format('ALTER TABLE llm_token_usage DROP CONSTRAINT %I', pk_name);
    ALTER TABLE llm_token_usage
      ADD PRIMARY KEY (bucket_start, account_id, role, provider, model);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_llm_token_usage_provider_model_bucket
  ON llm_token_usage (provider, model, bucket_start);

CREATE TABLE IF NOT EXISTS llm_billing_price_snapshot (
  provider                  TEXT        NOT NULL,
  model                     TEXT        NOT NULL,
  usage_day                 DATE        NOT NULL,
  currency                  TEXT        NOT NULL DEFAULT 'CNY',
  prompt_cost_per_1k        NUMERIC(18, 8),
  completion_cost_per_1k    NUMERIC(18, 8),
  total_cost_per_1k         NUMERIC(18, 8),
  source                    TEXT        NOT NULL,
  source_period             TEXT,
  source_synced_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (provider, model, usage_day),
  CHECK (
    total_cost_per_1k IS NOT NULL
    OR (prompt_cost_per_1k IS NOT NULL AND completion_cost_per_1k IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_llm_billing_price_snapshot_day
  ON llm_billing_price_snapshot (usage_day);
