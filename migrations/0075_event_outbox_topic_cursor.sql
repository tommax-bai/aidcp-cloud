-- aidcp:kind=expand
-- aidcp:objects=table:event_outbox_topic_cursor,column:event_outbox_topic_cursor.consumer
-- aidcp:objects=column:event_outbox_topic_cursor.execution_target,column:event_outbox_topic_cursor.topic
-- aidcp:objects=column:event_outbox_topic_cursor.last_id,column:event_outbox_topic_cursor.updated_at
-- aidcp:objects=index:event_outbox_target_topic_id_idx
--
-- change outbox-listen-and-topic-cursor：消费游标从 (consumer, target) 扩到 (consumer, target, topic)。
--
-- 目的：一条毒消息只堵**它自己那条主题**，不堵队头。今天 handler 抛错会让整个 (consumer, target)
-- 的游标停在失败条之前，同一消费者的其它主题一并饿死；分维之后各主题各走各的游标。
--
-- ## 为什么是新表，而不是给 event_outbox_cursor 改主键
--
-- 就地改主键必须先 `ALTER TABLE … DROP CONSTRAINT event_outbox_cursor_pkey`。旧代码的游标推进写的是
-- `ON CONFLICT (consumer, execution_target)`，该子句要求存在**恰好覆盖这两列**的唯一索引；主键一掉，
-- 旧代码当场 42P10 报错。dev 与 ol **共用同一台物理 PostgreSQL**（而且那台就是生产库），两边的代码版本
-- 不保证同批推进——按 migrations/README.md §5 的判据（「旧版本代码在这条迁移之后会坏」），那是 contract，
-- MUST 独立 change、独立部署。故本条走 expand 路线：新建分维表，旧表原样保留、旧代码零感知。
--
-- ## execution_target 与「另一台会不会被影响」
--
-- event_outbox_cursor 本来就有 execution_target 且在主键内，新表原样保留该维（游标是行级持久任务进度，
-- 属 CLAUDE.md §2 target 隔离范畴）。本迁移只新增一张表 + 一条索引、不改任何既有对象，
-- 另一 target 上运行的旧代码读写的仍是 event_outbox_cursor，行为逐字节不变。
--
-- ## 存量回填的方向：精确续接（既不重放、也不跳过）
--
-- 旧的聚合行 (c, t, N) 的语义是「id ≤ N 的**全部**主题都已被消费者 c 消费」。因此对任意主题 T，
-- 「T 的游标 = N」既不会漏掉未消费的（≤N 的 T 事件都消费过了），也不会重放已消费的。故回填 =
-- 拿聚合值给该 target 下**每个已出现过的主题**播种。
--
-- 这里 MUST NOT 用「回填成 0、反正重放是安全的」那条常见捷径：本仓的消费方**实测不幂等** ——
-- risk.command 的 applySignal 会把 light 信号一路推成 normal→warned→restricted 且 signalCount 单调累加
-- （src/risk/risk-state-machine.ts:27,56）。重放对它是真实的状态损坏，不是无害的重复。
-- 运行时另有第二道保险：读游标时若该主题行不存在，回落到旧聚合行而不是 0（src/transport/event-outbox.ts
-- 的 readCursor），所以即便本回填漏了某个主题，起点仍然精确。
--
-- 幂等 + 可重复执行：建表/建索引都是 IF NOT EXISTS；回填走 ON CONFLICT DO UPDATE + GREATEST，
-- 重复执行只会把游标往前带（绝不倒退），可以在重启前再跑一次以追平旧代码这期间的推进。

CREATE TABLE IF NOT EXISTS event_outbox_topic_cursor (
  consumer          TEXT NOT NULL,
  execution_target  TEXT NOT NULL,
  topic             TEXT NOT NULL,
  last_id           BIGINT NOT NULL DEFAULT 0,
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (consumer, execution_target, topic)
);

-- 分维之后的扫描形状：WHERE execution_target=$t AND topic=$k AND id > $lastId ORDER BY id ASC。
-- 原 event_outbox_target_id_idx (execution_target, id) 保留（遗留聚合路径与运维查询仍用）。
CREATE INDEX IF NOT EXISTS event_outbox_target_topic_id_idx
  ON event_outbox (execution_target, topic, id);

-- 存量回填：每个 (consumer, target) 聚合行 × 该 target 下已出现过的每个主题，播种为聚合的 last_id。
INSERT INTO event_outbox_topic_cursor (consumer, execution_target, topic, last_id, updated_at)
SELECT c.consumer, c.execution_target, t.topic, c.last_id, now()
  FROM event_outbox_cursor c
  JOIN (SELECT DISTINCT execution_target, topic FROM event_outbox) t
    ON t.execution_target = c.execution_target
ON CONFLICT (consumer, execution_target, topic)
DO UPDATE SET last_id = GREATEST(event_outbox_topic_cursor.last_id, EXCLUDED.last_id),
              updated_at = now();
