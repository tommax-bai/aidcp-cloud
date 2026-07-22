-- aidcp:kind=expand
-- aidcp:objects=column:account_comment_approval_policy.account_id,column:account_comment_approval_policy.mode,column:account_comment_approval_policy.updated_at,column:account_comment_approval_policy.updated_by
-- aidcp:objects=column:group_publish_approval_policy.delivery,column:group_publish_approval_policy.group_label,column:group_publish_approval_policy.updated_at,column:group_publish_approval_policy.updated_by
-- aidcp:objects=table:account_comment_approval_policy,table:group_publish_approval_policy
-- scoped-approval-and-notification-policy (0056)
-- Runtime init() carries the same idempotent DDL because this repository does not
-- have a guaranteed migration runner. Missing rows deliberately preserve legacy behavior.

CREATE TABLE IF NOT EXISTS account_comment_approval_policy (
  account_id  TEXT PRIMARY KEY REFERENCES accounts(account_id) ON DELETE CASCADE,
  mode        TEXT NOT NULL CHECK (mode IN ('source_rules','auto_approve_all')),
  updated_by  TEXT,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS group_publish_approval_policy (
  group_label TEXT PRIMARY KEY,
  delivery    TEXT NOT NULL CHECK (delivery IN ('client_and_feishu','client_only')),
  updated_by  TEXT,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
