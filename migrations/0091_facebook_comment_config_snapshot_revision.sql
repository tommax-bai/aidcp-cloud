-- aidcp:kind=expand
-- aidcp:objects=table:config_mirror_version
--
-- 0090 adds comment_mode_configured to the API-owned
-- facebook_comment_config sync-read snapshot. Advancing the owner cursor is
-- required even when no operator writes the config: otherwise a restarted
-- consumer sees a different full payload at the old cursor and correctly
-- rejects it as same_cursor_payload_drift.
--
-- The version is shared configuration authority, so advance it monotonically
-- in the API owner database. Target-local consumer checkpoints remain separate.

INSERT INTO config_mirror_version (mirror_key, version, updated_at)
VALUES ('facebook_comment_config', 1, now())
ON CONFLICT (mirror_key)
DO UPDATE SET
  version = config_mirror_version.version + 1,
  updated_at = now();
