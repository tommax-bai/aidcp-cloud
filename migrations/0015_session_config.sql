-- 0015_session_config.sql（change session-limits-to-quota-layer，迁移号 0015）
--
-- 把「单场会话上限」从人设 / 写死常量搬进安全限额层：按账号一行，单场时长 + 六项单场互动预算。
-- 维度=按账号（account_id 主键，沿用单场时长现有按账号语义，非档位）。
-- 初始不预填行——缺行即回落写死默认（时长 10min + 现 freshBudget 数字），全新部署 / 迁移刚跑完
-- 行为与现状逐位一致（严格零回归）。与 src/config/session-config-store.ts 内 CREATE TABLE IF NOT EXISTS 同源、幂等。
--
-- 红线：单场上限编辑只写本表；绝不触风控状态单写路径（risk_state / setQuotaLevel / applySignal）；不经协议。

CREATE TABLE IF NOT EXISTS session_config (
  account_id           TEXT PRIMARY KEY,
  max_duration_min     INTEGER NOT NULL,   -- 单场时长上限（分钟），默认回落 10
  budget_likes         INTEGER NOT NULL,   -- 单场互动预算：点赞
  budget_collects      INTEGER NOT NULL,   -- 收藏
  budget_follows       INTEGER NOT NULL,   -- 关注
  budget_searches      INTEGER NOT NULL,   -- 搜索
  budget_comments      INTEGER NOT NULL,   -- 评论
  budget_comment_likes INTEGER NOT NULL,   -- 评论赞
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by           TEXT
);
