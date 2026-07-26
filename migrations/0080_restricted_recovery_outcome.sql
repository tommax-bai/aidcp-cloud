-- aidcp:kind=expand
-- aidcp:objects=column:risk_command_outcome.signal_count,column:risk_command_outcome.last_signal_at
-- aidcp:objects=column:risk_command_outcome.status_since,column:risk_command_outcome.state_updated_at
-- aidcp:objects=column:risk_command_outcome.recovery_changed,column:risk_command_outcome.recovery_refusal
-- aidcp:objects=column:risk_command_outcome.resumed_edges,column:risk_command_outcome.resume_failure
-- aidcp:objects=column:risk_command_outcome.env_key,column:risk_command_outcome.resume_state
--
-- change split-cloud-api-composition-root-3b：restricted-only recovery 的账号绑定结局。
--
-- 现有 signal/quota outcome 继续只使用 status/quota_level/reason；新增列全部 nullable，旧代码可忽略。
-- recovery 的写后状态、业务拒绝与 Edge 恢复事实分别落列，不能拼进 reason 后再由调用方猜。
ALTER TABLE risk_command_outcome
  ADD COLUMN IF NOT EXISTS env_key TEXT,
  ADD COLUMN IF NOT EXISTS signal_count INTEGER,
  ADD COLUMN IF NOT EXISTS last_signal_at BIGINT,
  ADD COLUMN IF NOT EXISTS status_since BIGINT,
  ADD COLUMN IF NOT EXISTS state_updated_at BIGINT,
  ADD COLUMN IF NOT EXISTS recovery_changed BOOLEAN,
  ADD COLUMN IF NOT EXISTS recovery_refusal TEXT,
  ADD COLUMN IF NOT EXISTS resumed_edges INTEGER,
  ADD COLUMN IF NOT EXISTS resume_failure TEXT,
  ADD COLUMN IF NOT EXISTS resume_state TEXT;

-- `refused` 是 restricted recovery 的稳定业务终态：不重试、正常推进 risk.command cursor。
ALTER TABLE risk_command_outcome
  DROP CONSTRAINT IF EXISTS risk_command_outcome_state_check;

ALTER TABLE risk_command_outcome
  ADD CONSTRAINT risk_command_outcome_state_check
  CHECK (state IN ('submitted', 'applying', 'applied', 'refused', 'failed'));

ALTER TABLE risk_command_outcome
  ADD CONSTRAINT risk_command_outcome_recovery_refusal_check
  CHECK (recovery_refusal IS NULL OR recovery_refusal = 'state_not_restricted');

ALTER TABLE risk_command_outcome
  ADD CONSTRAINT risk_command_outcome_resumed_edges_check
  CHECK (resumed_edges IS NULL OR resumed_edges >= 0);

ALTER TABLE risk_command_outcome
  ADD CONSTRAINT risk_command_outcome_resume_state_check
  CHECK (resume_state IS NULL OR resume_state IN ('pending', 'claimed', 'completed'));

ALTER TABLE risk_command_outcome
  ADD CONSTRAINT risk_command_outcome_resume_failure_check
  CHECK (
    resume_failure IS NULL
    OR resume_failure IN ('edge_resume_failed', 'edge_resume_result_unknown')
  );

-- 0080 前可能已有 operator recoverRestricted 账本，没有 env/resume 阶段；保留它们供审计但客户读 fail-closed。
-- NOT VALID 让旧行不阻断 expand migration，同时保证 0080 后任何新增/更新的 recovery 行必须完整。
ALTER TABLE risk_command_outcome
  ADD CONSTRAINT risk_command_outcome_recovery_env_required
  CHECK (command_kind <> 'recoverRestricted' OR env_key IS NOT NULL) NOT VALID;

ALTER TABLE risk_command_outcome
  ADD CONSTRAINT risk_command_outcome_applied_resume_state_required
  CHECK (
    command_kind <> 'recoverRestricted'
    OR state <> 'applied'
    OR resume_state IN ('pending', 'claimed', 'completed')
  ) NOT VALID;
