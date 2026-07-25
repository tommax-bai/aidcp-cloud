-- aidcp:kind=expand
-- aidcp:objects=column:client_env_revocation_holds.offboard_id,column:client_env_revocation_holds.materialized_at
-- aidcp:objects=column:client_env_revocation_holds.unbound_terminal_ok
-- aidcp:objects=index:client_env_revocation_holds_unmaterialized_idx
--
-- change block3-l3-offboard-eventual-consistency：把「这个环境正在清理 / 已被撤权」这条**准入事实**
-- 收进 api 自己的库。
--
-- 改造前，管理员改派环境（setScope）的两道闸分居两个属主：
--   ① client_env_revocation_holds（api）—— 撤权了但还没拿到互动绑定的环境；
--   ② interaction_offboards state <> 'purged'（automation）—— 离场台账还没清完的环境。
-- 今天两闸同事务、原子；三库一拆，两闸各在一库，跨库行锁**两边各自加锁都会成功、互斥消失且不报错**
-- （同一教训见 src/db/environment-row-lock.ts 文件头），于是「有清理在飞的环境不可改派」这条不变量
-- 会在没有任何错误信号的情况下失效——正在清理的环境会被改派给新客户。
--
-- 本迁移把 ② 的准入含义搬进 ①：holds 表从「只记录缺绑定的撤权」升格为**环境清理准入表**，
-- 每一个未了结的清理（无论有没有台账行）在 api 库里都有且只有一行（既有 UNIQUE(env_key) 不变）。
-- automation 的 interaction_offboards 随之退化为**执行台账**（边缘清理进行到哪一步），不再兼任准入闸。
-- 既有的 client_env_scope_cleanup_hold_guard 触发器因此自动覆盖整个清理窗口，无需改触发器。
--
-- 全部 additive：三列 + 一个部分索引 + 两处约束**放宽**（reason 取值域加一个、user_id 去 NOT NULL）。
-- 放宽方向对旧二进制安全：旧代码写入的行仍然合法，旧代码的读取不依赖这两条约束。
ALTER TABLE client_env_revocation_holds
  ADD COLUMN IF NOT EXISTS offboard_id         TEXT,
  ADD COLUMN IF NOT EXISTS materialized_at     TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS unbound_terminal_ok BOOLEAN NOT NULL DEFAULT false;

-- 客户自助解绑（reason='environment_unbind'）此前只写 automation 的台账、不写 api 的 hold；
-- 准入收口后它也要在这张表里留一行，故取值域必须容得下它。
ALTER TABLE client_env_revocation_holds DROP CONSTRAINT IF EXISTS client_env_revocation_holds_reason_check;
ALTER TABLE client_env_revocation_holds ADD CONSTRAINT client_env_revocation_holds_reason_check
  CHECK (reason IN ('environment_unbind','customer_terminated','admin_revoked'));

-- 「认领既有台账」路径（对账循环发现 automation 有未清除离场、api 却没有准入行时补一行）拿不到
-- 发起客户：台账的 user_id 本身可空，而 MUST NOT 编造一个 userId。故这一列放宽为可空，
-- NULL 明确表示「这条准入是从执行台账反向认领来的，发起客户不可考」。
ALTER TABLE client_env_revocation_holds ALTER COLUMN user_id DROP NOT NULL;

-- 对账循环每轮扫「已受理、尚未物化」的准入（materialized_at IS NULL），按请求时间推进。
CREATE INDEX IF NOT EXISTS client_env_revocation_holds_unmaterialized_idx
  ON client_env_revocation_holds (requested_at, env_key) WHERE materialized_at IS NULL;
