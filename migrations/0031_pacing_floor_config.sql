-- 0031_pacing_floor_config.sql（change pacing-floor-config-min-interval）
-- 人审文档：本仓无迁移执行器，实际 DDL 由 PacingConfigStore.init() 幂等自愈
-- （src/config/pacing-config-store.ts PACING_FLOOR_SCHEMA_SQL，与此同源、勿漂移）。
--
-- 语义：
-- - 四类操作（action / scroll / card_gap / detail_dwell）的最小间隔兜底区间 {min_ms, max_ms}，全局一套。
-- - 表空 / 某 op 缺行 → 逐项回落内置默认（BUILTIN_FLOOR，= 现役 timing.ts 预设 / DWELL_FLOOR_MS 量级），零回归。
-- - 范围约束**不靠 DB CHECK**：权威夹逼在读出口 clamp(floorFor) 到 [OP_MIN_FLOOR[op], CAP_MS(15000)]——
--   即便有人绕过面板 psql 直插 0/负数/超界，离开云端进程前被夹回非零合法。配置只能抬高延迟、抬不穿非零下限。
-- - operation 为主键（每 op 一行）；无 sigma_pct 列（防指纹改边缘反射采样，运营调 σ 属 YAGNI）。
--
-- 账号覆盖扩展缝（v1 不建）：ALTER TABLE ADD COLUMN IF NOT EXISTS scope TEXT NOT NULL DEFAULT 'global'，
--   主键改 (scope, operation)；floorFor(op, accountId?) 先查 (accountId, op) 缺则回落 ('global', op)。

CREATE TABLE IF NOT EXISTS pacing_floor_config (
  operation   TEXT PRIMARY KEY,        -- op 白名单：action | scroll | card_gap | detail_dwell
  min_ms      INTEGER NOT NULL,
  max_ms      INTEGER NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by  TEXT
);
