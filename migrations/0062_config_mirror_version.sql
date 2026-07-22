-- aidcp:kind=expand
-- aidcp:objects=column:config_mirror_stale_refusal.execution_target,column:config_mirror_stale_refusal.hour_bucket,column:config_mirror_stale_refusal.mirror_key,column:config_mirror_stale_refusal.refusal_count
-- aidcp:objects=column:config_mirror_stale_refusal.updated_at,column:config_mirror_version.mirror_key,column:config_mirror_version.updated_at,column:config_mirror_version.version
-- aidcp:objects=index:idx_config_mirror_stale_refusal_hour,table:config_mirror_stale_refusal,table:config_mirror_version
-- 0062_config_mirror_version.sql（change config-mirror-cross-process-invalidation）
--
-- 文档性迁移：本仓无迁移执行器，实际由 src/config/mirror-version-store.ts 的
-- CONFIG_MIRROR_VERSION_SCHEMA_SQL 在 init() 时以逐字同义的幂等 DDL 自愈式建表。
-- 此文件与那段 SQL 同源（勿漂移），仅作台账。
--
-- 语义：跨进程配置镜像的失效通道。写方在**持久化配置的同一个事务内**把对应 mirror_key 的
--       version 加一；消费方每进程一个刷新器按固定周期整表拉取版本比对，只对版本变化的 key
--       触发对应存储重载。陈旧上限 = 轮询周期 + 一次查询耗时，与通知是否送达无关。
--
-- 版本由**库侧自增**（version = config_mirror_version.version + 1），MUST NOT 用任何主机时钟：
-- 三服务 × 两 target 跨主机部署下时钟不可信，时钟回拨会让版本倒退、失效通道静默失灵。
--
-- 本表 MUST NOT 有 execution_target 列：CLAUDE.md §2 的 target 隔离约束的是「由后台扫描、认领、
-- 重试或恢复的持久任务」；本表不是任务表、没有认领语义。配置本身 dev/ol 共享，两个 target 的
-- 进程各自独立轮询同一张表、各自维护自己的副本，这是正确行为而非缺陷。
--
-- 纯 additive DDL（无 DROP / RENAME / 类型收窄），符合 docs/deployment-environments.md:66 的
-- 破坏性 DDL 冻结约束。回滚：整体开关 AIDCP_CONFIG_MIRROR_REFRESH=false + restart，无数据回退步骤。

BEGIN;

CREATE TABLE IF NOT EXISTS config_mirror_version (
  mirror_key TEXT PRIMARY KEY,
  version    BIGINT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 「因镜像陈旧而拒绝一次真实平台动作」的可计量记录（按 mirrorKey、按小时可查）。
-- 与设计内克制（配额耗尽、模型判定不做、冷却未过）分别计数，MUST NOT 混计。
CREATE TABLE IF NOT EXISTS config_mirror_stale_refusal (
  mirror_key       TEXT NOT NULL,
  hour_bucket      TIMESTAMPTZ NOT NULL,
  execution_target TEXT NOT NULL,
  refusal_count    BIGINT NOT NULL DEFAULT 0,
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (mirror_key, hour_bucket, execution_target)
);

CREATE INDEX IF NOT EXISTS idx_config_mirror_stale_refusal_hour
  ON config_mirror_stale_refusal (hour_bucket DESC);

COMMIT;
