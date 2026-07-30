-- aidcp:kind=expand
-- aidcp:objects=table:decision_traces
-- aidcp:objects=index:idx_decision_traces_target_run,index:idx_decision_traces_target_step
-- aidcp:objects=index:idx_decision_traces_target_attempt,index:idx_decision_traces_target_correlation
--
-- change add-managed-automation-runtime（期1-2 核心表第 4/4 条：Decision Trace；迁移 0109）。
--
-- decision_traces —— 解释原因，但不成为状态真相（design §19，contracts/decision-trace.ts）。
-- 红线：**仅 append**。本表没有任何 UPDATE / DELETE 语义，store 只提供追加与查询；
-- Trace 不能反向覆盖 TaskRun / Ledger 状态，删除 Trace 也不能让平台结果消失。
-- seq（BIGSERIAL）给同 subject 的 trace 一个稳定全序——created_at 毫秒级可并列，
-- 排序靠它不靠时间戳。
--
-- 敏感原文不落库：input_refs / candidates / snapshot_refs 全部存引用、哈希与必要摘要
-- （design §22 分层授权与保留期）。versions 是决策时相关版本引用块（planVersion /
-- taskDefinitionVersion / personaVersion / policyRevision / approvalRevision）。
-- 不写 REFERENCES（run/step/attempt 引用可空、按决策层级缺省，且删 Trace 不得连坐状态表）、
-- 不 ALTER 任何既有表，理由同 0106。
CREATE TABLE IF NOT EXISTS decision_traces (
  trace_id          UUID PRIMARY KEY,
  execution_target  TEXT NOT NULL CHECK (execution_target IN ('dev','ol')),
  seq               BIGSERIAL,
  correlation_id    TEXT NOT NULL,
  causation_id      TEXT,
  versions          JSONB NOT NULL DEFAULT '{}',
  run_id            UUID,
  step_id           UUID,
  attempt_id        UUID,
  decision_type     TEXT NOT NULL CHECK (decision_type IN (
    'creation','selection','admission','delay','denial','skip','supersession','dispatch','reconciliation'
  )),
  input_refs        JSONB NOT NULL DEFAULT '[]',
  candidates        JSONB NOT NULL DEFAULT '[]',
  outcome           TEXT NOT NULL CHECK (outcome IN ('selected','allowed','denied','delayed','skipped','superseded')),
  reason_code       TEXT NOT NULL,
  snapshot_refs     JSONB NOT NULL DEFAULT '[]',
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 主要读路径：按 subject（run / step / attempt / correlation）查询，追加序回放。
CREATE INDEX IF NOT EXISTS idx_decision_traces_target_run
  ON decision_traces (execution_target, run_id, seq)
  WHERE run_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_decision_traces_target_step
  ON decision_traces (execution_target, step_id, seq)
  WHERE step_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_decision_traces_target_attempt
  ON decision_traces (execution_target, attempt_id, seq)
  WHERE attempt_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_decision_traces_target_correlation
  ON decision_traces (execution_target, correlation_id, seq);
