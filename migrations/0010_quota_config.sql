-- 0010_quota_config.sql（change safety-quota-config，stream D，迁移号 0010）
--
-- 安全限额数字做成管理后台可改：按 (tier, action) 一行，三窗口（每日 / 每分 / 每时）三列。
-- 初始不预填行——缺行即回落 quotas.ts 写死默认（deriveWindowQuotas），全新部署 / 迁移刚跑完
-- 行为与现状逐位一致（零回归）。与 src/config/quota-config-store.ts 内 CREATE TABLE IF NOT EXISTS 同源、幂等。
--
-- 红线：限额数字编辑只写本表；绝不触风控状态单写路径（risk_state / setQuotaLevel / applySignal）。

CREATE TABLE IF NOT EXISTS quota_config (
  tier        TEXT NOT NULL,   -- 'conservative' | 'normal' | 'aggressive'
  action      TEXT NOT NULL,   -- view|like|collect|comment|follow|publish|comment_like
  daily       INTEGER NOT NULL,
  per_minute  INTEGER NOT NULL,
  per_hour    INTEGER NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by  TEXT,
  PRIMARY KEY (tier, action)
);
