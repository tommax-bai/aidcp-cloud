-- aidcp:kind=expand
-- aidcp:objects=column:publish_approval_decision.approved,column:publish_approval_decision.candidate_ref,column:publish_approval_decision.content_version,column:publish_approval_decision.decided_at
-- aidcp:objects=column:publish_approval_decision.decided_by,column:publish_approval_decision.decided_via,column:publish_approval_decision.dispatch_blocked_reason,column:publish_approval_decision.dispatch_state
-- aidcp:objects=column:publish_approval_decision.dispatch_state_at,column:publish_approval_decision.env_key,column:publish_approval_decision.execution_target,column:publish_approval_decision.frozen_payload
-- aidcp:objects=column:publish_approval_decision.request_id,column:publish_approval_decision.revision,column:publish_approval_decision.subject_kind,column:publish_approval_decision.void_reason
-- aidcp:objects=column:publish_approval_outbox.command,column:publish_approval_outbox.consumed_at,column:publish_approval_outbox.created_at,column:publish_approval_outbox.execution_target
-- aidcp:objects=column:publish_approval_outbox.id,column:publish_approval_outbox.payload,column:publish_approval_outbox.request_id,column:publish_approval_outbox.revision
-- aidcp:objects=index:idx_publish_approval_decision_active,index:idx_publish_approval_decision_pending,index:idx_publish_approval_outbox_unconsumed,table:publish_approval_decision
-- aidcp:objects=table:publish_approval_outbox
-- change publish-approval-signal-to-database
-- 人审授权的唯一权威载体：从本机文件 /tmp/aidcp-publish-approve-<requestId>.json 迁到持久记录。
-- first-writer-wins 由「活跃行唯一」的部分唯一索引承担（替代文件系统 O_EXCL）。
-- 作废是状态迁移（dispatch_state='void' + void_reason），MUST NOT 删行——保留审计轨迹。
CREATE TABLE IF NOT EXISTS publish_approval_decision (
  request_id              TEXT NOT NULL,
  revision                INT  NOT NULL CHECK (revision >= 1),
  subject_kind            TEXT NOT NULL CHECK (subject_kind IN ('publish','comment')),
  candidate_ref           TEXT NOT NULL,
  content_version         INT  NOT NULL DEFAULT 0,
  approved                BOOLEAN NOT NULL,
  decided_by              TEXT NOT NULL,
  decided_via             TEXT NOT NULL CHECK (
                            decided_via IN ('feishu','console','client','delegated_task','schedule_auto_approve')
                          ),
  decided_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  env_key                 TEXT,
  execution_target        TEXT NOT NULL CHECK (execution_target IN ('dev','ol')),
  frozen_payload          JSONB NOT NULL DEFAULT '{}'::jsonb,
  dispatch_state          TEXT NOT NULL CHECK (
                            dispatch_state IN ('pending_dispatch','dispatching','consumed','void')
                          ),
  dispatch_blocked_reason TEXT,
  dispatch_state_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  void_reason             TEXT,
  PRIMARY KEY (request_id, revision)
);

-- 活跃行唯一 = first-writer-wins 的原子性来源（等价于旧 O_EXCL，但不依赖文件系统）。
CREATE UNIQUE INDEX IF NOT EXISTS idx_publish_approval_decision_active
  ON publish_approval_decision (request_id)
  WHERE dispatch_state <> 'void';

-- 兜底扫描 / 待下发告警：只查本机 execution_target 的待下发活跃行。
CREATE INDEX IF NOT EXISTS idx_publish_approval_decision_pending
  ON publish_approval_decision (execution_target, decided_at)
  WHERE dispatch_state = 'pending_dispatch';

-- 「授权 → 下发」的跨服务命令（替代进程内直调 triggerPublishDispatchOnApprove）。
-- 与授权行同事务写出；消费侧按 (request_id, revision) 原子认领去重（至少一次投递 + 幂等消费）。
CREATE TABLE IF NOT EXISTS publish_approval_outbox (
  id               BIGSERIAL PRIMARY KEY,
  command          TEXT NOT NULL DEFAULT 'PublishApproved',
  request_id       TEXT NOT NULL,
  revision         INT  NOT NULL,
  execution_target TEXT NOT NULL CHECK (execution_target IN ('dev','ol')),
  payload          JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  consumed_at      TIMESTAMPTZ,
  UNIQUE (command, request_id, revision)
);

CREATE INDEX IF NOT EXISTS idx_publish_approval_outbox_unconsumed
  ON publish_approval_outbox (execution_target, id)
  WHERE consumed_at IS NULL;
