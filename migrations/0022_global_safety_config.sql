-- 0022_global_safety_config.sql（change restore-auto-resume-and-global-safety-config，stream B，迁移号 0022）
--
-- 把「单场会话上限」与「自动续场护栏 + 看门狗阈值」从**按账号**收敛为**全局单例**：
-- 后台只设一份、对所有账号生效（用户 2026-06-27 拍板：取消账号维度、改全局通用单例，
-- 没有 default、没有按账号覆盖；早前「按账号/三级回落」方案作废）。
--
-- 形态：单行表（id INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1)），永远至多一行。
-- 迁入：把旧按账号表里 account_id='default' 行的值搬进全局行（保住后台早前给 default 设的
--       单场 30min 等覆盖）；无 default 行 → 全局表保持空 → 取值逐位回落写死默认（严格零回归）。
-- 幂等：CREATE TABLE IF NOT EXISTS + INSERT ... ON CONFLICT (id) DO NOTHING（重复执行不覆盖已迁入值）。
-- 旧表 session_config / resume_config **保留不动**，待真机验证全局生效后再单独清理（本迁移不删）。
--
-- 红线：只读写这两张配置表；绝不触风控状态单写路径（risk_state / setQuotaLevel / applySignal）；不经协议。
-- 与 src/config/session-config-store.ts / resume-config-store.ts 内 CREATE TABLE IF NOT EXISTS 同源。

-- ── 单场会话上限（全局单例） ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS session_config_global (
  id                   INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  max_duration_min     INTEGER NOT NULL,   -- 单场时长上限（分钟）
  budget_likes         INTEGER NOT NULL,   -- 单场互动预算：点赞
  budget_collects      INTEGER NOT NULL,   -- 收藏
  budget_follows       INTEGER NOT NULL,   -- 关注
  budget_searches      INTEGER NOT NULL,   -- 搜索
  budget_comments      INTEGER NOT NULL,   -- 评论
  budget_comment_likes INTEGER NOT NULL,   -- 评论赞
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by           TEXT
);

-- 迁入 default 行（若旧表与 default 行存在）。to_regclass 保证旧表不存在时整段跳过、不报错。
DO $$
BEGIN
  IF to_regclass('public.session_config') IS NOT NULL THEN
    INSERT INTO session_config_global (
      id, max_duration_min, budget_likes, budget_collects, budget_follows,
      budget_searches, budget_comments, budget_comment_likes, updated_at, updated_by
    )
    SELECT 1, max_duration_min, budget_likes, budget_collects, budget_follows,
           budget_searches, budget_comments, budget_comment_likes, updated_at,
           COALESCE(updated_by, 'migration_0022')
      FROM session_config
     WHERE account_id = 'default'
    ON CONFLICT (id) DO NOTHING;
  END IF;
END $$;

-- ── 自动续场护栏 + 看门狗阈值（全局单例） ────────────────────────────────────
CREATE TABLE IF NOT EXISTS resume_config_global (
  id                      INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  rest_ratio_pct          INTEGER,   -- 休息时长 = 单场时长 × (rest_ratio_pct/100)，缺/非法回落 10
  active_window_start_min INTEGER,   -- 活跃时段窗口起（自午夜分钟数 0..1440），缺回落 0
  active_window_end_min   INTEGER,   -- 活跃时段窗口止（自午夜分钟数 0..1440），缺回落 1440（全天）
  daily_max_sessions      INTEGER,   -- 每日自动续场场数上限，缺/0 = 不限
  daily_max_minutes       INTEGER,   -- 每日自动续场累计时长上限（分钟），缺/0 = 不限
  idle_nudge_ms           INTEGER,   -- 看门狗恢复轻推阈值（毫秒），缺/非法回落 130000，须 > 90s
  idle_end_ms             INTEGER,   -- 看门狗放弃结束阈值（毫秒），缺/非法回落 3600000，须 > idle_nudge
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by              TEXT
);

DO $$
BEGIN
  IF to_regclass('public.resume_config') IS NOT NULL THEN
    INSERT INTO resume_config_global (
      id, rest_ratio_pct, active_window_start_min, active_window_end_min,
      daily_max_sessions, daily_max_minutes, idle_nudge_ms, idle_end_ms, updated_at, updated_by
    )
    SELECT 1, rest_ratio_pct, active_window_start_min, active_window_end_min,
           daily_max_sessions, daily_max_minutes, idle_nudge_ms, idle_end_ms, updated_at,
           COALESCE(updated_by, 'migration_0022')
      FROM resume_config
     WHERE account_id = 'default'
    ON CONFLICT (id) DO NOTHING;
  END IF;
END $$;
