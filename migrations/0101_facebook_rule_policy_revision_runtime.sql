-- 0101_facebook_rule_policy_revision_runtime.sql
-- aidcp:kind=expand
-- aidcp:objects=table:facebook_rule_progress,table:facebook_rule_view_fact,table:facebook_rule_batch
-- aidcp:objects=column:facebook_rule_progress.policy_revision,column:facebook_rule_progress.policy_snapshot
-- aidcp:objects=column:facebook_rule_view_fact.policy_revision
-- aidcp:objects=column:facebook_rule_batch.policy_revision,column:facebook_rule_batch.policy_snapshot

-- Configurable rule cadence keeps one stable runtime algorithm identity. The immutable
-- policy revision and snapshot, rather than numbers embedded in definition_id, decide
-- how many confirmed views create a round and which round includes join-contact.

ALTER TABLE facebook_rule_progress
  ADD COLUMN IF NOT EXISTS policy_revision BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS policy_snapshot JSONB;

ALTER TABLE facebook_rule_view_fact
  ADD COLUMN IF NOT EXISTS policy_revision BIGINT NOT NULL DEFAULT 0;

ALTER TABLE facebook_rule_batch
  ADD COLUMN IF NOT EXISTS policy_revision BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS policy_snapshot JSONB;

DO $$
DECLARE
  target_table TEXT;
  constraint_name TEXT;
BEGIN
  FOREACH target_table IN ARRAY ARRAY[
    'facebook_rule_progress',
    'facebook_rule_view_fact',
    'facebook_rule_batch'
  ]
  LOOP
    FOR constraint_name IN
      SELECT conname
        FROM pg_constraint
       WHERE conrelid = target_table::regclass
         AND contype = 'c'
         AND (pg_get_constraintdef(oid) LIKE '%definition_id%'
              OR pg_get_constraintdef(oid) LIKE '%definition_version%')
    LOOP
      EXECUTE format('ALTER TABLE %I DROP CONSTRAINT %I', target_table, constraint_name);
    END LOOP;

    EXECUTE format(
      'ALTER TABLE %I ADD CONSTRAINT %I CHECK (definition_id IN (%L, %L, %L))',
      target_table,
      target_table || '_definition_id_check',
      'facebook_browse_10_like_1_join_contact_1',
      'facebook_browse_5_like_1_join_contact_every_2',
      'facebook_rule_cadence'
    );

    EXECUTE format(
      'ALTER TABLE %I ADD CONSTRAINT %I CHECK (definition_version IN (1, 2, 3))',
      target_table,
      target_table || '_definition_version_check'
    );
  END LOOP;
END $$;

DO $$
DECLARE constraint_name TEXT;
BEGIN
  FOR constraint_name IN
    SELECT conname
      FROM pg_constraint
     WHERE conrelid = 'facebook_rule_progress'::regclass
       AND contype = 'c'
       AND pg_get_constraintdef(oid) LIKE '%view_count%'
  LOOP
    EXECUTE format('ALTER TABLE facebook_rule_progress DROP CONSTRAINT %I', constraint_name);
  END LOOP;

  ALTER TABLE facebook_rule_progress
    ADD CONSTRAINT facebook_rule_progress_view_count_check
    CHECK (view_count BETWEEN 0 AND 99);
END $$;

ALTER TABLE facebook_rule_progress
  DROP CONSTRAINT IF EXISTS facebook_rule_progress_pkey;
ALTER TABLE facebook_rule_progress
  ADD CONSTRAINT facebook_rule_progress_pkey
  PRIMARY KEY (
    account_id, execution_target, definition_id, definition_version, policy_revision
  );

ALTER TABLE facebook_rule_view_fact
  DROP CONSTRAINT IF EXISTS facebook_rule_view_fact_pkey;

DO $$
DECLARE constraint_name TEXT;
BEGIN
  FOR constraint_name IN
    SELECT conname
      FROM pg_constraint
     WHERE conrelid = 'facebook_rule_view_fact'::regclass
       AND contype = 'u'
  LOOP
    EXECUTE format('ALTER TABLE facebook_rule_view_fact DROP CONSTRAINT %I', constraint_name);
  END LOOP;
END $$;

ALTER TABLE facebook_rule_view_fact
  ADD CONSTRAINT facebook_rule_view_fact_pkey
  PRIMARY KEY (
    account_id, execution_target, definition_id, definition_version,
    policy_revision, collecting_sequence, content_key
  );
ALTER TABLE facebook_rule_view_fact
  ADD CONSTRAINT facebook_rule_view_fact_source_dedupe_key
  UNIQUE (
    account_id, execution_target, definition_id, definition_version,
    policy_revision, source_dedupe_key
  );

DO $$
DECLARE constraint_name TEXT;
BEGIN
  FOR constraint_name IN
    SELECT conname
      FROM pg_constraint
     WHERE conrelid = 'facebook_rule_batch'::regclass
       AND contype = 'u'
       AND pg_get_constraintdef(oid) LIKE '%sequence%'
  LOOP
    EXECUTE format('ALTER TABLE facebook_rule_batch DROP CONSTRAINT %I', constraint_name);
  END LOOP;
END $$;

ALTER TABLE facebook_rule_batch
  ADD CONSTRAINT facebook_rule_batch_revision_sequence_key
  UNIQUE (
    account_id, execution_target, definition_id, definition_version,
    policy_revision, sequence
  );

DO $$
DECLARE
  target_column TEXT;
  constraint_name TEXT;
BEGIN
  FOREACH target_column IN ARRAY ARRAY['like_state', 'join_state', 'comment_state']
  LOOP
    FOR constraint_name IN
      SELECT conname
        FROM pg_constraint
       WHERE conrelid = 'facebook_rule_batch'::regclass
         AND contype = 'c'
         AND pg_get_constraintdef(oid) LIKE '%' || target_column || '%'
    LOOP
      EXECUTE format('ALTER TABLE facebook_rule_batch DROP CONSTRAINT %I', constraint_name);
    END LOOP;

    EXECUTE format(
      'ALTER TABLE facebook_rule_batch ADD CONSTRAINT %I CHECK (%I IN ('
      || '''pending'', ''dispatched'', ''confirmed'', ''already_satisfied'', ''risk_suppressed'', '
      || '''structural_skip'', ''not_started'', ''rejected'', ''failed'', ''ambiguous'', '
      || '''submitted_unknown'', ''not_scheduled'', ''confirmed_without_contact'', '
      || '''policy_superseded''))',
      'facebook_rule_batch_' || target_column || '_check',
      target_column
    );
  END LOOP;
END $$;
