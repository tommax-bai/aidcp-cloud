-- aidcp:kind=expand
-- aidcp:objects=table:task_runs,table:step_runs
-- aidcp:objects=index:idx_task_runs_target_status,index:idx_task_runs_target_task
-- aidcp:objects=index:uq_task_runs_target_idempotency,index:idx_task_runs_target_lease
-- aidcp:objects=index:uq_step_runs_target_run_node,index:idx_step_runs_target_run
--
-- change add-managed-automation-runtime（期1-2 核心表第 2/4 条：正交运行状态两张表；迁移 0107）。
--
--   1. task_runs —— 一次实际运行（design §2/§6）。三字段正交状态（contracts/task-run.ts）：
--        status='queued'|'running'|'waiting'|'cancel_requested'|'terminal'（在跑吗）
--        wait_reason（在等什么，仅 waiting 非空）
--        terminal_outcome（怎么结束的，仅 terminal 非空）
--      两条不变式在库侧也钉死（CHECK），store 层先行校验、库侧兜底——绕过 store 的
--      直写同样过不去，「正在等待 Edge」与「因 Edge 超窗而跳过」永远分得开。
--      claim_token / claim_expires_at 是单写者认领租约（store 实现细节，不属对象契约，
--      见 contracts/STATE-MAPPING.md §2.1），认领 = CAS 谓词式 UPDATE + FOR UPDATE SKIP LOCKED。
--   2. step_runs —— ExecutionPlan 节点的可恢复运行实例（design §2/§16 步骤 9）：
--      断线恢复靠 checkpoint_ref 从已确认进度继续，同一 (run, node) 只有一行。
--
-- wait_reason / terminal_outcome 的取值集合带 CHECK（契约层冻结数组，扩值走「放宽 CHECK」
-- 的 expand 先例，见 0095/0096）；reason_code 刻意不带 CHECK——原因码只增不改语义
-- （contracts/reason-codes.ts），逐值追 CHECK 只会制造迁移噪声。
-- 不写 REFERENCES、不 ALTER 任何既有表，理由同 0106。
CREATE TABLE IF NOT EXISTS task_runs (
  run_id                    UUID PRIMARY KEY,
  execution_target          TEXT NOT NULL CHECK (execution_target IN ('dev','ol')),
  task_id                   UUID NOT NULL,
  task_revision_id          UUID NOT NULL,
  execution_plan_id         UUID NOT NULL,
  cycle_id                  TEXT,
  correlation_id            TEXT NOT NULL,
  -- —— 创建时冻结块（design §6：意图冻结、安全实时）——
  plan_id                   TEXT,
  plan_version              INTEGER,
  task_definition_id        TEXT NOT NULL,
  task_definition_version   INTEGER NOT NULL,
  persona_version           TEXT,
  account_id                TEXT NOT NULL,
  env_key                   TEXT NOT NULL,
  platform                  TEXT NOT NULL,
  account_binding_revision  TEXT NOT NULL,
  candidate_version_id      TEXT,
  content_version           TEXT,
  approval_revision         TEXT,
  schedule                  JSONB NOT NULL,
  budgets                   JSONB NOT NULL DEFAULT '{}',
  idempotency_key           TEXT NOT NULL,
  -- —— 正交状态三元组 + 两条不变式 ——
  status                    TEXT NOT NULL CHECK (status IN ('queued','running','waiting','cancel_requested','terminal')),
  wait_reason               TEXT CHECK (wait_reason IN ('waiting_for_account','waiting_for_edge','waiting_for_content','waiting_for_approval','waiting_until','waiting_for_reconciliation')),
  terminal_outcome          TEXT CHECK (terminal_outcome IN ('succeeded','partially_succeeded','skipped','failed','cancelled','submitted_unknown')),
  reason_code               TEXT,
  CONSTRAINT task_runs_wait_reason_iff_waiting
    CHECK ((wait_reason IS NOT NULL) = (status = 'waiting')),
  CONSTRAINT task_runs_terminal_outcome_iff_terminal
    CHECK ((terminal_outcome IS NOT NULL) = (status = 'terminal')),
  -- —— 运行期字段 ——
  confirmed_count           INTEGER NOT NULL DEFAULT 0 CHECK (confirmed_count >= 0),
  target_count              INTEGER,
  attempt_count             INTEGER NOT NULL DEFAULT 0,
  skipped_count             INTEGER NOT NULL DEFAULT 0,
  failure_count             INTEGER NOT NULL DEFAULT 0,
  current_node_id           TEXT,
  superseded_by_run_id      UUID,
  claim_token               TEXT,
  claim_expires_at          TIMESTAMPTZ,
  aggregate_version         INTEGER NOT NULL DEFAULT 1,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at                TIMESTAMPTZ,
  finished_at               TIMESTAMPTZ
);

-- 主要读路径①：worker 按 (target, status) 扫队列认领（queued 顺序 = 创建序）。
CREATE INDEX IF NOT EXISTS idx_task_runs_target_status
  ON task_runs (execution_target, status, created_at);
-- 主要读路径②：按 task_id 投影一个任务的全部 run。
CREATE INDEX IF NOT EXISTS idx_task_runs_target_task
  ON task_runs (execution_target, task_id, created_at);
-- 运行幂等（design §5 / STATE-MAPPING dedupeKey 分层）：同 target 下运行幂等键唯一。
CREATE UNIQUE INDEX IF NOT EXISTS uq_task_runs_target_idempotency
  ON task_runs (execution_target, idempotency_key);
-- 租约回收扫描：只看还握着租约的行。
CREATE INDEX IF NOT EXISTS idx_task_runs_target_lease
  ON task_runs (execution_target, claim_expires_at)
  WHERE claim_token IS NOT NULL;

CREATE TABLE IF NOT EXISTS step_runs (
  step_run_id         UUID PRIMARY KEY,
  execution_target    TEXT NOT NULL CHECK (execution_target IN ('dev','ol')),
  run_id              UUID NOT NULL,
  node_id             TEXT NOT NULL,
  capability_id       TEXT NOT NULL,
  capability_version  INTEGER NOT NULL,
  status              TEXT NOT NULL CHECK (status IN ('queued','running','waiting','cancel_requested','terminal')),
  wait_reason         TEXT CHECK (wait_reason IN ('waiting_for_account','waiting_for_edge','waiting_for_content','waiting_for_approval','waiting_until','waiting_for_reconciliation')),
  terminal_outcome    TEXT CHECK (terminal_outcome IN ('succeeded','partially_succeeded','skipped','failed','cancelled','submitted_unknown')),
  reason_code         TEXT,
  CONSTRAINT step_runs_wait_reason_iff_waiting
    CHECK ((wait_reason IS NOT NULL) = (status = 'waiting')),
  CONSTRAINT step_runs_terminal_outcome_iff_terminal
    CHECK ((terminal_outcome IS NOT NULL) = (status = 'terminal')),
  input_ref           TEXT,
  result_ref          TEXT,
  checkpoint_ref      TEXT,
  attempt_count       INTEGER NOT NULL DEFAULT 0,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at          TIMESTAMPTZ,
  finished_at         TIMESTAMPTZ
);

-- 可恢复实例：同一 (target, run, node) 只有一行（恢复 = 续写同行，不另起一行重复计数）。
CREATE UNIQUE INDEX IF NOT EXISTS uq_step_runs_target_run_node
  ON step_runs (execution_target, run_id, node_id);
CREATE INDEX IF NOT EXISTS idx_step_runs_target_run
  ON step_runs (execution_target, run_id, created_at);
