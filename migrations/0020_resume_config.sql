-- 0020_resume_config.sql（change session-auto-resume-with-excursions，迁移号 0020）
--
-- 按账号的「自动续场护栏 + 看门狗阈值」配置：单场正常结束后歇 N% 再续场，受活跃时段窗口 +
-- 每日上限约束；看门狗两段阈值（恢复轻推 / 放弃结束）也按账号可调、热加载。
-- 维度=按账号（account_id 主键，与 session_config 同口径，但独立表、零改动已部署的 session_config）。
-- 初始不预填行——缺行 / 缺列 / 非法值即逐位回落写死默认（rest 10% / 窗口全天 / 每日不限 /
-- 轻推 130s / 放弃 1h），全新部署 / 迁移刚跑完行为与「无续场配置」逐位一致（严格零回归）。
-- 与 src/config/resume-config-store.ts 内 CREATE TABLE IF NOT EXISTS 同源、幂等。
--
-- 红线：本表只读写自身；绝不触风控状态单写路径（risk_state / setQuotaLevel / applySignal）；不经协议。

CREATE TABLE IF NOT EXISTS resume_config (
  account_id              TEXT PRIMARY KEY,
  rest_ratio_pct          INTEGER,   -- 休息时长 = 单场时长 × (rest_ratio_pct/100)，缺/非法回落 10
  active_window_start_min INTEGER,   -- 活跃时段窗口起（自午夜分钟数，0..1440），缺回落 0
  active_window_end_min   INTEGER,   -- 活跃时段窗口止（自午夜分钟数，0..1440），缺回落 1440（全天）
  daily_max_sessions      INTEGER,   -- 每日自动续场场数上限，缺/0 = 不限
  daily_max_minutes       INTEGER,   -- 每日自动续场累计时长上限（分钟），缺/0 = 不限
  idle_nudge_ms           INTEGER,   -- 看门狗恢复轻推阈值（毫秒），缺/非法回落 130000，须 > 90s
  idle_end_ms             INTEGER,   -- 看门狗放弃结束阈值（毫秒），缺/非法回落 3600000，须 > idle_nudge
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by              TEXT
);
