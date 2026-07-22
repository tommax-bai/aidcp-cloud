-- aidcp:kind=expand
-- aidcp:objects=column:session_config_global.collect_save_like_denom,column:session_config_global.follow_fans_denom
-- 0023_engagement_ratio_config.sql（change engagement-ratio-config，迁移号 0023）
--
-- 把两道「互动质量比例闸」做成后台可配（全局单例，复用 session_config_global 单行表）：
--   收藏门槛：仅当笔记「收藏数 / 点赞数 >= 1:N」才收藏（N = collect_save_like_denom，默认 3 → 1:3）。
--   关注门槛：仅当作者「粉丝数 / 获赞与收藏 >= 1:N」才关注（N = follow_fans_denom，默认 8 → 1:8）。
-- 以「1:N 的整数分母 N」存储，与本表其余整数列同构；后台改即时热加载、对所有账号生效。
--
-- 形态：在既有全局单行表 session_config_global 上加两列。两列**可空**（NULL = 未覆盖 → 取值回落
--       写死默认 3 / 8），故无需 DEFAULT、对既有行严格零回归。校验侧要求 N >= 1（0 = 除零、会把闸搞坏）。
-- 幂等：ADD COLUMN IF NOT EXISTS，重复执行安全。
--       与 src/config/session-config-store.ts 内 SESSION_CONFIG_SCHEMA_SQL / SESSION_CONFIG_ALTER_SQL 同源
--       （store init() 亦跑同样的自愈 ALTER，使运行中的 store 永不领先于自己 schema）。
--
-- 红线：只动 session_config_global；绝不触风控状态单写路径（risk_state / setQuotaLevel / applySignal）；不经协议。

ALTER TABLE session_config_global ADD COLUMN IF NOT EXISTS collect_save_like_denom INTEGER;  -- 收藏门槛 1:N 的 N（NULL=回落默认 3）
ALTER TABLE session_config_global ADD COLUMN IF NOT EXISTS follow_fans_denom       INTEGER;  -- 关注门槛 1:N 的 N（NULL=回落默认 8）
