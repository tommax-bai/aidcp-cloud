-- aidcp:kind=expand
-- aidcp:objects=table:automation_account_projection,column:automation_account_projection.account_id,column:automation_account_projection.platform,column:automation_account_projection.group_label,column:automation_account_projection.projected_at,index:idx_automation_account_projection_platform_label,table:automation_account_projection_state,column:automation_account_projection_state.singleton,column:automation_account_projection_state.refreshed_at,column:automation_account_projection_state.fresh_until,column:automation_account_projection_state.source_rows
--
-- change: automation 域对 api 属主 accounts 的**去规范化守卫投影**（Block③ 物理拆库前置）。
--
-- ============================================================================
-- 这条迁移干什么、为什么
-- ============================================================================
-- accounts 属 api（boundaries/table-ownership.json：§5.1「账号主数据 → aidcp-api 单写」）。
-- automation 侧原本有 10 处在自己的查询里**内联** accounts：多数是「这个账号还在 / 属不属于这个
-- 分组」的守卫读，其中两处夹在写路径里（群成员认领的候选 CTE、按 scope 撤销 assigned 成员行的
-- DELETE），一处夹在写事务内（导入 / 改 scope 前校验分组标签存在）。
--
-- 把这类守卫改成一次跨进程调用是错的：既拆掉了「校验与写在同一事务里」的原子性，又给写路径加了
-- 一跳网络。正解是**去规范化**——把 accounts 上守卫真正需要的那三列冷备进 automation 自己的库，
-- 守卫改读本域投影表 ⇒ 守卫回到同库、原子性保住、零跨库。
--
-- ============================================================================
-- 只收三列，且**原样存**（这一点是语义等价的关键）
-- ============================================================================
--   account_id  —— 守卫的主键（「这个账号存在吗」）
--   platform    —— 原样文本，MUST NOT 归一。消费方的谓词有两种写法并存：
--                  `lower(btrim(platform)) IN ('facebook','fb')`（9 处）与 `platform = 'facebook'`
--                  （账号进度汇总 1 处）。存原值，两种谓词逐字照搬即可等价；存归一值会让后者的
--                  行为悄悄改变。
--   group_label —— 原样文本，MUST NOT trim。消费方自己带 `btrim(group_label) <> ''` 与等值 join。
-- 其余列（label / nickname / status / quota_level / contact_info / …）**不搬**：投影只服务这批守卫，
-- 不做 accounts 的影子副本。
--
-- ============================================================================
-- MUST NOT 建到 accounts 的外键
-- ============================================================================
-- 投影表刻意**不**引 accounts。加外键等于把刚拆掉的跨属主耦合原样加回来，物理拆库后必然失效。
-- 投影与 accounts 的一致性由应用层刷新器负责（最终一致 + 陈旧即 fail-closed），不由 PG 约束负责。
--
-- ============================================================================
-- 陈旧窗口与 fail-closed 的落点：_state 表
-- ============================================================================
-- 单行状态表记「最近一次成功刷新的时刻」与「据此推出的新鲜期截止」。守卫的 SQL 一律附带
-- `fresh_until > now()`：刷新器挂了、api 不可达、投影从未刷过 —— 三种情况下 fresh_until 自然过期，
-- 全部守卫当场转为拒绝。**宁可拒绝操作，也不因为投影没跟上就放行**。
-- 注意方向：投影**缺行**天然拒绝（EXISTS 假）；投影**陈旧**靠 fresh_until 拒绝。两者都不会放行。
--
-- singleton 列的 CHECK 保证这张表最多一行——状态是全局的，不按 target 分行：accounts 本身就不带
-- execution_target（dev / ol 共享同一份账号主数据），投影随之也不分 target。
-- ============================================================================

CREATE TABLE IF NOT EXISTS automation_account_projection (
  account_id   TEXT PRIMARY KEY,
  platform     TEXT NOT NULL,
  group_label  TEXT,
  projected_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_automation_account_projection_platform_label
  ON automation_account_projection (platform, group_label);

CREATE TABLE IF NOT EXISTS automation_account_projection_state (
  singleton    BOOLEAN PRIMARY KEY DEFAULT true CHECK (singleton),
  refreshed_at TIMESTAMPTZ NOT NULL,
  fresh_until  TIMESTAMPTZ NOT NULL,
  source_rows  INTEGER NOT NULL DEFAULT 0
);
