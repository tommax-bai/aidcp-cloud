-- aidcp:kind=expand
-- aidcp:objects=table:risk_command_outcome,column:risk_command_outcome.command_id
-- aidcp:objects=column:risk_command_outcome.execution_target,column:risk_command_outcome.account_id
-- aidcp:objects=column:risk_command_outcome.command_kind,column:risk_command_outcome.state
-- aidcp:objects=column:risk_command_outcome.status,column:risk_command_outcome.quota_level
-- aidcp:objects=column:risk_command_outcome.reason,column:risk_command_outcome.requested_by
-- aidcp:objects=column:risk_command_outcome.decided_at,index:risk_command_outcome_target_decided_idx
--
-- change cloud-coupling-phase5（P5-1：面板写风控改异步，用户 2026-07-25 拍板）。
--
-- 风控写命令的**结果账本**。命令本身走 event_outbox（topic=risk.command）；本表记的是
-- 单写者应用完之后的**真实结局**，供提交方（面板 / api）回读。
--
-- 为什么必须有这张表：异步之后，提交那一刻 api 不可能知道结果。若不落结果，界面只有两个选择——
-- 要么编一个乐观的「已生效」（红线：静默假成功），要么永远显示「处理中」（失败永不可见）。
-- 两者都不可接受，故结局必须落库、必须可回读。
--
-- 三个 state：
--   submitted —— 提交时就落的占位行，带提交人（审计链的起点）。对外呈现为 processing。
--   applied   —— 单写者应用成功，status / quota_level 是它写完**回读的真态**，非提交方推断。
--   failed    —— 单写者明确判失败，reason 具名。
-- **没有「重试中」态**：outbox 消费者是 at-least-once，失败即卡住重放，那期间行仍停在
-- submitted、对外就是 processing，如实。
--
-- 「本表无行」是第三种情况：占位行没写成。此时由查询侧回落去问 event_outbox 这条命令在不在——
-- 在即 processing，不在即 unknown。把 unknown 当 processing 会让界面永远转圈且永不报错。
--
-- execution_target 隔离（CLAUDE.md §2）：dev/ol 长期共库，结果按 target 分行，各自只读自己的。
--
-- 保留期跟随 event_outbox 的 risk.command 主题（30 天审计窗），由该主题的剪裁器一并处理。
CREATE TABLE IF NOT EXISTS risk_command_outcome (
  command_id        BIGINT PRIMARY KEY,
  execution_target  TEXT NOT NULL,
  account_id        TEXT NOT NULL,
  command_kind      TEXT NOT NULL,
  state             TEXT NOT NULL CHECK (state IN ('submitted', 'applied', 'failed')),
  -- 应用成功时由单写者写完后回读的真态；submitted / failed 时为 NULL（绝不填推断值）。
  status            TEXT,
  quota_level       TEXT,
  -- 失败原因（含风控层拒绝的具名原因）。成功时为 NULL。
  reason            TEXT,
  -- 提交人（面板用户），入审计链。
  requested_by      TEXT,
  decided_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 审计翻查：按 target + 时间倒序。
CREATE INDEX IF NOT EXISTS risk_command_outcome_target_decided_idx
  ON risk_command_outcome (execution_target, decided_at DESC);
