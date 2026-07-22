-- aidcp:kind=expand
-- aidcp:objects=
-- 0050_wechat_group_reply_config_privileges.sql
-- Restore runtime DML access when 0048 was applied by an administrative role.
-- The runtime role is derived from the owner of the legacy reply-config table,
-- avoiding an environment-specific hard-coded role name.

DO $$
DECLARE
  runtime_role NAME;
BEGIN
  SELECT pg_get_userbyid(c.relowner)
    INTO runtime_role
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public'
     AND c.relname = 'interaction_reply_configs'
     AND c.relkind IN ('r', 'p');

  IF runtime_role IS NULL THEN
    RAISE EXCEPTION 'interaction_reply_configs owner not found';
  END IF;

  EXECUTE format(
    'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE '
    'interaction_reply_config_scopes, interaction_reply_scope_versions, interaction_reply_scope_audit TO %I',
    runtime_role
  );
END
$$;
