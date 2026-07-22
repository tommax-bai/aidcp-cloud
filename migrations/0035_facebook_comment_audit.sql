-- aidcp:kind=expand
-- aidcp:objects=column:facebook_comment_audit.account_id,column:facebook_comment_audit.container,column:facebook_comment_audit.created_at,column:facebook_comment_audit.id
-- aidcp:objects=column:facebook_comment_audit.keyword,column:facebook_comment_audit.outcome,column:facebook_comment_audit.reason,column:facebook_comment_audit.shadow
-- aidcp:objects=column:facebook_comment_audit.text_length,index:idx_fb_comment_audit_account,table:facebook_comment_audit
-- 0035_facebook_comment_audit.sql
-- change facebook-scheduled-comment (2.7): per-trigger audit row for Facebook scheduled comments.
-- Makes shadow results + silent stalls queryable (not journalctl-only) and feeds the
-- consecutive-blocking-outcome alerter. No secrets: comment body is not stored (length only).
-- Idempotent; verbatim-same as FACEBOOK_COMMENT_AUDIT_SCHEMA_SQL in
-- src/comment-agent/facebook-comment-audit-store.ts (store self-heals via CREATE TABLE IF NOT EXISTS).

CREATE TABLE IF NOT EXISTS facebook_comment_audit (
  id           BIGSERIAL PRIMARY KEY,
  account_id   TEXT NOT NULL,
  outcome      TEXT NOT NULL,
  reason       TEXT,
  shadow       BOOLEAN NOT NULL DEFAULT false,
  keyword      TEXT,
  container    TEXT,
  text_length  INTEGER,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_fb_comment_audit_account ON facebook_comment_audit (account_id, created_at DESC);
