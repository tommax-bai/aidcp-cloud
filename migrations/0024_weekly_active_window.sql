-- 0024_weekly_active_window.sql（change weekly-active-window，迁移号 0024）
--
-- 「可活跃时间」全局周历闸：管理后台「安全」页可按**周 × 天 × 小时**配置允许活跃的时段，对所有账号生效。
--   7 天 × 24 小时 = 168 格，存为定长 168 的 '0'/'1' 串（active_week_mask）：
--     '1' = 该小时活跃（允许开 / 续浏览会话）、'0' = 休眠（不开；运行中跨入则结束会话）。
--   索引 = 周内天 × 24 + 小时；周内天 0=周一 … 6=周日（贴合中文周序与后台展示），小时 0..23。
--   按**服务器本地时间**判定（与既有「每日活跃窗口」同口径，单地域、无时区参数）。
--
-- 形态：在既有全局单行表 session_config_global 上加一列 TEXT。该列**可空**（NULL = 未配置 → 取值
--       回落「全周全天活跃 = 不限」，严格零回归），故无需 DEFAULT、对既有行零影响。
--       校验侧（facade）要求：传则必须为长度 168、仅含 '0'/'1' 的串；非法整块拒、绝不落脏掩码。
-- 幂等：ADD COLUMN IF NOT EXISTS，重复执行安全。
--       与 src/config/session-config-store.ts 内 SESSION_CONFIG_SCHEMA_SQL / SESSION_CONFIG_ALTER_SQL 同源
--       （store init() 亦跑同样的自愈 ALTER，使运行中的 store 永不领先于自己 schema）。
--
-- 红线：只动 session_config_global；绝不触风控状态单写路径（risk_state / setQuotaLevel / applySignal）；不经协议。

ALTER TABLE session_config_global ADD COLUMN IF NOT EXISTS active_week_mask TEXT;  -- 168 格 '0'/'1' 周历掩码（NULL=回落全天活跃/不限）
