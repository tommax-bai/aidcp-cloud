-- aidcp:kind=expand
-- aidcp:objects=table:execution_intents,table:execution_attempts
-- aidcp:objects=index:uq_execution_intents_target_idempotency,index:idx_execution_intents_target_run
-- aidcp:objects=index:uq_execution_attempts_intent_ordinal,index:idx_execution_attempts_target_status
-- aidcp:objects=index:idx_execution_attempts_target_run
--
-- change add-managed-automation-runtime（期1-2 核心表第 3/4 条：Execution Ledger 两张表；迁移 0108）。
--
--   1. execution_intents  —— **不可变**执行意图（design §11）：每次准备真实平台动作先建
--      intent；业务幂等键在同 target 下唯一——命中既有 intent 时 Ledger 返回既有关系或拒绝，
--      绝不产生第二个平台动作（唯一索引就是这条红线的库侧形态）。
--   2. execution_attempts —— 一次真实平台动作尝试（design §11/§12）。状态机见
--      contracts/execution-attempt.ts 文件头；同一 intent 下 ordinal 唯一（重试有界且共享
--      幂等键）。字段耦合不变式在库侧钉死：
--        - confirmed_not_applied_kind 仅 status='confirmed_not_applied' 时非空
--          （never_applied 与 platform_refused 两种事实 MUST 区分，后者终局）；
--        - non_start_reason 仅派发前状态（blocked / cancelled）可携带。
--      submitted_unknown 禁止重派、只交 Reconciler（reconciliation_count 有界对账计数）。
--
-- 取值集合 CHECK 与扩值纪律同 0107；不写 REFERENCES、不 ALTER 任何既有表，理由同 0106。
CREATE TABLE IF NOT EXISTS execution_intents (
  intent_id            UUID PRIMARY KEY,
  execution_target     TEXT NOT NULL CHECK (execution_target IN ('dev','ol')),
  account_id           TEXT NOT NULL,
  env_key              TEXT NOT NULL,
  binding_revision     TEXT NOT NULL,
  action_type          TEXT NOT NULL,
  action_domain        TEXT NOT NULL,
  execution_class      TEXT NOT NULL CHECK (execution_class IN ('read_only','platform_write')),
  target_stable_id     TEXT,
  content_version      TEXT,
  approval_revision    TEXT,
  scheduled_at         TIMESTAMPTZ NOT NULL,
  latest_start_at      TIMESTAMPTZ NOT NULL,
  miss_policy          TEXT NOT NULL CHECK (miss_policy IN ('skip','require_reapproval','execute_when_available')),
  required_capability  TEXT NOT NULL,
  protocol_version     TEXT NOT NULL,
  idempotency_key      TEXT NOT NULL,
  correlation_id       TEXT NOT NULL,
  run_id               UUID NOT NULL,
  step_id              UUID NOT NULL,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 幂等红线：同 target 下业务幂等键唯一（ledger spec：命中即返回既有关系，不建第二个 intent）。
CREATE UNIQUE INDEX IF NOT EXISTS uq_execution_intents_target_idempotency
  ON execution_intents (execution_target, idempotency_key);
CREATE INDEX IF NOT EXISTS idx_execution_intents_target_run
  ON execution_intents (execution_target, run_id, created_at);

CREATE TABLE IF NOT EXISTS execution_attempts (
  attempt_id                       UUID PRIMARY KEY,
  execution_target                 TEXT NOT NULL CHECK (execution_target IN ('dev','ol')),
  intent_id                        UUID NOT NULL,
  run_id                           UUID NOT NULL,
  step_id                          UUID NOT NULL,
  ordinal                          INTEGER NOT NULL CHECK (ordinal >= 1),
  status                           TEXT NOT NULL CHECK (status IN (
    'prepared','blocked','cancelled','dispatched',
    'platform_confirmed','confirmed_not_applied','submitted_unknown',
    'accepted_pending','held_for_moderation','precondition_already_satisfied'
  )),
  non_start_reason                 TEXT CHECK (non_start_reason IN ('executor_unavailable','browser_control_degraded','acquisition_timeout','resource_slot_wait')),
  confirmed_not_applied_kind       TEXT CHECK (confirmed_not_applied_kind IN ('never_applied','platform_refused')),
  reason_code                      TEXT,
  evidence_ref                     TEXT,
  strongest_progress_evidence_ref  TEXT,
  reconciliation_count             INTEGER NOT NULL DEFAULT 0 CHECK (reconciliation_count >= 0),
  prepared_at                      TIMESTAMPTZ NOT NULL DEFAULT now(),
  dispatched_at                    TIMESTAMPTZ,
  settled_at                       TIMESTAMPTZ,
  CONSTRAINT execution_attempts_not_applied_kind_iff_status
    CHECK ((confirmed_not_applied_kind IS NOT NULL) = (status = 'confirmed_not_applied')),
  CONSTRAINT execution_attempts_non_start_reason_pre_dispatch
    CHECK (non_start_reason IS NULL OR status IN ('blocked','cancelled'))
);

-- 同一 intent 下尝试序号唯一（重试有界、共享幂等键，design §11）。
CREATE UNIQUE INDEX IF NOT EXISTS uq_execution_attempts_intent_ordinal
  ON execution_attempts (intent_id, ordinal);
-- Reconciler 扫描路径：按 (target, status) 找 submitted_unknown / dispatched。
CREATE INDEX IF NOT EXISTS idx_execution_attempts_target_status
  ON execution_attempts (execution_target, status, prepared_at);
CREATE INDEX IF NOT EXISTS idx_execution_attempts_target_run
  ON execution_attempts (execution_target, run_id, prepared_at);
