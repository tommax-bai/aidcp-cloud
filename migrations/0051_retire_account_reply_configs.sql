-- aidcp:kind=expand
-- aidcp:objects=
-- 0051_retire_account_reply_configs.sql
-- One-time retirement of account-scoped WeChat reply strategy test data.
-- Physical legacy tables remain for shared-schema compatibility; scoped strategy,
-- runtime controls, interaction records/jobs/attempts and risk data are untouched.

BEGIN;

DELETE FROM interaction_audit_events
 WHERE platform = 'wechat_channels'
   AND entity_type IN ('config', 'policy', 'template', 'rule', 'profile');

DELETE FROM reply_templates WHERE platform = 'wechat_channels';
DELETE FROM reply_rules WHERE platform = 'wechat_channels';
DELETE FROM account_reply_profiles WHERE platform = 'wechat_channels';
DELETE FROM interaction_reply_config_versions WHERE platform = 'wechat_channels';
DELETE FROM interaction_reply_configs WHERE platform = 'wechat_channels';

COMMIT;
