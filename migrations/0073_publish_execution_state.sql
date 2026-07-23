-- aidcp:kind=expand
-- aidcp:objects=column:publish_execution_state.platform_post_id,column:publish_execution_state.post_url,column:publish_execution_state.record_id,column:publish_execution_state.status
-- aidcp:objects=column:publish_execution_state.updated_at,table:publish_execution_state
-- change publish-log-split-prep（拆 publish_log 七态表：执行态那半）。
--
-- 背景：publish_log 一张七态 status 同时装着审批态与执行态（docs/cloud-service-decomposition-proposal.md
-- §4.6.3 :307、§5.1 :527）。审批那半已由 publish_approval_decision（migrations/0063）承接；
-- 本表承接**执行态那半**——发布下发与执行结果的投影，以 record_id（= publish_log.id）关联。
--
-- 阶段边界（MUST NOT 误读）：本 change 只做「建表 + 双写」两步（§5.4.6 模板的 M1+M2），
-- 不切读、不停旧写、不删旧表。publish_log 仍是权威、一步不少地照写。
-- 本表是**影子**：写它失败只告警、绝不连累 publish_log 的写与发布链路（fail-safe，唯一写者在
-- src/publish-agent/publish-log-store.ts 的双写里 try/catch 兜住）。
--
-- 无外键（刻意）：跨属主外键在后续拆 schema 时会静默失效（§5.4.5），影子表以 record_id 软关联即可，
-- 且外键会把「影子写」硬绑到主行存在，与 fail-safe 相悖。
--
-- 无 execution_target 分区（刻意）：本表是逐 record 的投影、不是被后台扫描/认领/重试的持久任务队列
-- （扫描仍发生在 publish_log），CLAUDE.md §2 的 target 隔离约束的是行级持久任务数据，投影不在其列（YAGNI）。
CREATE TABLE IF NOT EXISTS publish_execution_state (
  record_id        INT PRIMARY KEY,
  status           TEXT NOT NULL
                   CHECK (status IN ('draft','pending_approval','scheduled','submitted','published','failed','needs_review')),
  platform_post_id TEXT,
  post_url         TEXT,
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
