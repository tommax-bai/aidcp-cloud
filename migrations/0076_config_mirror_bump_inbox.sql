-- aidcp:kind=expand
-- aidcp:objects=table:config_mirror_bump_inbox,column:config_mirror_bump_inbox.dedup_key
-- aidcp:objects=column:config_mirror_bump_inbox.mirror_key,column:config_mirror_bump_inbox.applied_at
-- aidcp:objects=index:idx_config_mirror_bump_inbox_applied
--
-- 0076_config_mirror_bump_inbox.sql（change block3-l3-config-mirror-bump-decouple）
--
-- 跨域配置镜像失效信号的**消费方去重表**（api 属主，与 config_mirror_version 同库）。
--
-- 背景：四个属 automation 的限频配置 store 原本在自己的写事务里、同一条物理连接上直接递增属 api
-- 的 config_mirror_version。单库时看不出问题；两库一分，这一笔断成两笔独立提交，且没有任何错误、
-- 没有任何日志 —— 配置已改而版本没进，别的进程的镜像永远停在旧值。本 change 把它改成：
--   automation 库内「配置写 + event_outbox 行」同事务  →  进程内中继  →  api 库内「inbox 去重 + 推版本」同事务。
--
-- 本表就是最后那一步的去重侧。中继是 at-least-once 的（投递成功但游标没落库、进程崩溃、HTTP 超时
-- 后对端其实已成功，都会重放），dedup_key 取生产方 outbox 行的持久 id（`event_outbox:<target>:<id>`），
-- 重放多少次都只推一次版本。去重记录与版本推进在**同一笔 api 事务**内，不可能各自成立一半。
--
-- MUST NOT 有 execution_target 列：dedup_key 里已含生产侧 target，且本表不是认领型持久任务表、
-- 无扫描/认领语义（与 config_mirror_version 同一条判据，见 0062 头注）。
--
-- 纯 additive DDL（无 DROP / RENAME / 类型收窄），符合 dev/ol 共库期的破坏性 DDL 冻结约束。
-- 回滚：本表只增不读旧值，回退代码即可，表留着无害。

CREATE TABLE IF NOT EXISTS config_mirror_bump_inbox (
  dedup_key  TEXT PRIMARY KEY,
  mirror_key TEXT NOT NULL,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 超期去重记录的清理扫描（PgConfigMirrorBumpSink.pruneInbox，按 applied_at 裁剪）。
CREATE INDEX IF NOT EXISTS idx_config_mirror_bump_inbox_applied
  ON config_mirror_bump_inbox (applied_at);
