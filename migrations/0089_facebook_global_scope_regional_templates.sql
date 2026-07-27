-- aidcp:kind=expand
-- aidcp:objects=column:facebook_group_target.account_scope_mode,constraint:facebook_group_target_account_scope_mode_check
-- aidcp:objects=table:facebook_region_comment_template_config
-- aidcp:objects=column:facebook_region_comment_template_config.region,column:facebook_region_comment_template_config.comment_templates
-- aidcp:objects=column:facebook_region_comment_template_config.updated_at,column:facebook_region_comment_template_config.updated_by
--
-- Additive schema plus the operator-requested one-time data migration:
-- every target present when this migration runs becomes global. New targets keep
-- the restricted/empty default. The migration executor wraps this file in one
-- transaction. Existing label mappings remain dormant compatibility data so
-- an older OL process sharing this database keeps its pre-upgrade eligibility
-- semantics until OL is separately upgraded.

ALTER TABLE facebook_group_target
  ADD COLUMN IF NOT EXISTS account_scope_mode TEXT NOT NULL DEFAULT 'restricted';

ALTER TABLE facebook_group_target
  DROP CONSTRAINT IF EXISTS facebook_group_target_account_scope_mode_check;
ALTER TABLE facebook_group_target
  ADD CONSTRAINT facebook_group_target_account_scope_mode_check
  CHECK (account_scope_mode IN ('restricted','global'));

CREATE TABLE IF NOT EXISTS facebook_region_comment_template_config (
  region            TEXT PRIMARY KEY
                    CHECK (region = btrim(region) AND char_length(region) BETWEEN 1 AND 120),
  comment_templates JSONB NOT NULL DEFAULT '[]'::jsonb
                    CHECK (jsonb_typeof(comment_templates) = 'array'),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by        TEXT NOT NULL
);

CREATE TEMP TABLE aidcp_0089_facebook_target_snapshot ON COMMIT DROP AS
SELECT group_url, group_name, region, park, direction, join_gating, priority,
       enabled, import_batch, created_at, updated_at
  FROM facebook_group_target;

CREATE TEMP TABLE aidcp_0089_membership_count ON COMMIT DROP AS
SELECT count(*)::bigint AS total
  FROM facebook_group_membership;

CREATE TEMP TABLE aidcp_0089_scope_snapshot ON COMMIT DROP AS
SELECT group_url, account_group_label, updated_at, updated_by
  FROM facebook_group_target_scope
 WHERE group_url IN (SELECT group_url FROM aidcp_0089_facebook_target_snapshot);

UPDATE facebook_group_target
   SET account_scope_mode = 'global',
       scope_updated_at = now(),
       scope_updated_by = 'migration:0089_facebook_global_scope_regional_templates'
 WHERE group_url IN (SELECT group_url FROM aidcp_0089_facebook_target_snapshot);

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM aidcp_0089_facebook_target_snapshot before
      LEFT JOIN facebook_group_target after USING (group_url)
     WHERE after.group_url IS NULL
        OR after.account_scope_mode <> 'global'
        OR after.group_name IS DISTINCT FROM before.group_name
        OR after.region IS DISTINCT FROM before.region
        OR after.park IS DISTINCT FROM before.park
        OR after.direction IS DISTINCT FROM before.direction
        OR after.join_gating IS DISTINCT FROM before.join_gating
        OR after.priority IS DISTINCT FROM before.priority
        OR after.enabled IS DISTINCT FROM before.enabled
        OR after.import_batch IS DISTINCT FROM before.import_batch
        OR after.created_at IS DISTINCT FROM before.created_at
        OR after.updated_at IS DISTINCT FROM before.updated_at
  ) THEN
    RAISE EXCEPTION '0089 facebook target global migration changed protected target facts';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM aidcp_0089_scope_snapshot before
      FULL JOIN (
        SELECT group_url, account_group_label, updated_at, updated_by
          FROM facebook_group_target_scope
         WHERE group_url IN (SELECT group_url FROM aidcp_0089_facebook_target_snapshot)
      ) after USING (group_url, account_group_label)
     WHERE before.group_url IS NULL
        OR after.group_url IS NULL
        OR after.updated_at IS DISTINCT FROM before.updated_at
        OR after.updated_by IS DISTINCT FROM before.updated_by
  ) THEN
    RAISE EXCEPTION '0089 facebook target global migration changed compatibility scopes';
  END IF;

  IF (SELECT count(*)::bigint FROM facebook_group_membership)
     IS DISTINCT FROM
     (SELECT total FROM aidcp_0089_membership_count) THEN
    RAISE EXCEPTION '0089 facebook target global migration changed membership facts';
  END IF;
END $$;
