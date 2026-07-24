-- aidcp:kind=expand
-- aidcp:objects=table:event_outbox,column:event_outbox.id,column:event_outbox.topic,column:event_outbox.payload
-- aidcp:objects=column:event_outbox.execution_target,column:event_outbox.created_at,index:event_outbox_target_id_idx
-- aidcp:objects=table:event_outbox_cursor,column:event_outbox_cursor.consumer,column:event_outbox_cursor.execution_target
-- aidcp:objects=column:event_outbox_cursor.last_id,column:event_outbox_cursor.updated_at
--
-- change block2-outbox-transport（Block② 拆进程用的异步事件承重地基）。
--
-- 数据库事件 outbox 的持久底座。两张表，全部 additive（dev/ol 共库期禁破坏性 DDL）：
--   1. event_outbox        —— 事务型 outbox：写方在自己的业务事务内 INSERT 一条事件，
--                             提交即持久、跨重启不丢；消费方按 id 单调游标拉取。
--   2. event_outbox_cursor —— 每个 (消费者, target) 一行的消费进度。崩溃后从落库的 last_id 之后
--                             重放（at-least-once，幂等由 handler 负责）。游标只进不退（GREATEST 守）。
--
-- execution_target 隔离（CLAUDE.md §2 / docs/deployment-environments.md）：dev/ol 长期共库，
-- 事件与游标都带 target，消费只读本 target 的行（dev 不消费 ol、反之）。这是行级持久任务数据，
-- 属 §2 target 隔离约束的范畴（与 schema 账本那种「库级单序列」不同）。
--
-- 本 change 只建原语 + 测试，不接 server.ts、不接任何业务写方/消费方（EventBus / 风控一律不碰）。
-- 存储不自建表：等价建表只活在本迁移，运行时按迁移执行器纪律先 migrate 再起服务。
CREATE TABLE IF NOT EXISTS event_outbox (
  id                BIGSERIAL PRIMARY KEY,
  topic             TEXT NOT NULL,
  payload           JSONB NOT NULL,
  execution_target  TEXT NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 消费扫描：target 打头、id 递增（WHERE execution_target=$t AND id > $lastId ORDER BY id ASC）。
CREATE INDEX IF NOT EXISTS event_outbox_target_id_idx ON event_outbox (execution_target, id);

CREATE TABLE IF NOT EXISTS event_outbox_cursor (
  consumer          TEXT NOT NULL,
  execution_target  TEXT NOT NULL,
  last_id           BIGINT NOT NULL DEFAULT 0,
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (consumer, execution_target)
);
