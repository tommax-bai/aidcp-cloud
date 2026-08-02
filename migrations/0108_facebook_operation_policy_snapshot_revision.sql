-- aidcp:kind=expand
-- aidcp:objects=table:config_mirror_version
--
-- Two changes just altered the full payload of the API-owned
-- facebook_operation_policy sync-read snapshot without any operator writing the
-- config: the global slow-start curve became a required sibling field, and the
-- per-environment baseline gained the slow-start Reel like cadence.
--
-- The cursor for this stream comes from config_mirror_version, which only moves
-- when someone writes the config. So on restart a consumer that already holds a
-- checkpoint sees a *different* full payload at the *same* cursor and correctly
-- refuses it as same_cursor_payload_drift — which aborts monolith startup
-- (observed on dev). Advancing the owner cursor is what makes the new payload
-- shape take effect. Same reasoning and same shape as
-- 0091_facebook_comment_config_snapshot_revision.
--
-- The version is shared configuration authority, so advance it monotonically in
-- the API owner database. Target-local consumer checkpoints remain separate.

INSERT INTO config_mirror_version (mirror_key, version, updated_at)
VALUES ('facebook_operation_policy', 1, now())
ON CONFLICT (mirror_key)
DO UPDATE SET
  version = config_mirror_version.version + 1,
  updated_at = now();
