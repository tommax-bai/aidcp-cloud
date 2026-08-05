-- 0111_facebook_consumption_obligation_per_type.sql
-- aidcp:kind=contract
-- 索引名在 PG 里反推不出所属表，只声明索引会让归属推断落进「残留」分支、把这条迁移派去**每一个**
-- 属主库跑（0110 的头注释为约束名记过同一个坑）。这张表是 automation 属主，故表声明必须写上。
-- aidcp:objects=table:facebook_consumption_action,index:uq_facebook_consumption_active_action
--
-- change unblock-facebook-consumption-comment-segment（槽位重新定义）。
--
-- 原索引把「每账号至多一个未终结消费动作」写死在库里。配合应用层的单槽推进，
-- 它的实际后果是：评论义务一旦停在等待态（等目标 / 等闸），同一账号的**点赞与加群一并永久停摆**，
-- 且跨重启不恢复。2026-08-05 生产实测 12 个账号（dev 2 / OL 10）全部卡在
-- `comment / waiting_gate / facebook_group_comment_policy_unavailable`，最早一个卡了一天多、
-- 期间 3325 次浏览零点赞，日志无一行报错。
--
-- 唯一性改按**动作类型**分：
--   * 「同类未终结义务至多一份」= 原先对点赞的保证逐字保住（点赞仍至多一条在途），
--     同时给评论 / 加群各加了一道积压上限（让位之后「到点造义务」会反复到点）；
--   * 跨类型的互斥交回应用层：可下发 / 在途的动作至多一个（槽位判据），
--     且一次浏览至多驱动一个面向边缘的动作。
--
-- **索引名刻意不变**。启动期 schema 契约门按名字查索引，改名会让回滚到旧码的进程直接起不来，
-- 而回滚是部署安全序列的最后一步。旧码的行为不因这次放宽而改变：它在插入点赞之前先查
-- 「本账号有没有未终结动作」，命中就直接返回、根本走不到 INSERT，所以放宽的那一格它碰不到。
--
-- 标 contract 而不是 expand：语句里有 DROP INDEX。判据虽是「旧码会不会坏」（这里不会），
-- 但把 DROP 藏进 expand 去骗过机械闸，正是本仓反复付过代价的那类操作。

DROP INDEX IF EXISTS uq_facebook_consumption_active_action;

CREATE UNIQUE INDEX IF NOT EXISTS uq_facebook_consumption_active_action
  ON facebook_consumption_action (account_id, execution_target, action_type)
  WHERE state <> 'terminal';
