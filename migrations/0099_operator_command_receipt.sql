-- aidcp:kind=expand
-- aidcp:objects=table:operator_command_receipt,column:operator_command_receipt.execution_target
-- aidcp:objects=column:operator_command_receipt.command_id,column:operator_command_receipt.command_kind
-- aidcp:objects=column:operator_command_receipt.scope,column:operator_command_receipt.state
-- aidcp:objects=column:operator_command_receipt.receipt,column:operator_command_receipt.created_at
-- aidcp:objects=column:operator_command_receipt.decided_at
-- aidcp:objects=index:operator_command_receipt_target_created_idx
--
-- change split-cloud-automation-production-runtime（1.7③；形状照 0079_risk_command_outcome 的判例）。
--
-- 运营指令的**幂等台账**。同一次运营意图（一条飞书消息 / 一次面板点击）无论被投递几次，
-- 副作用只发生一次，重放拿回**首次那一次的结果原文**。
--
-- 为什么必须落库、不能只活在内存里：接收方是「本地注入」与「HTTP 路由」共用的**同一份实现**，
-- 而运营指令的副作用是真的（落一条委托任务并可能自动入队 / 整条发帖编排 / 评论任务）。
-- 进程内的表在重启后一片空白，于是重启前后的同一条消息会被当成两次意图执行两遍。
--
-- 为什么领域层既有的判重挡不住这件事（实测推翻过一次「有唯一索引就够了」的想法）：
-- `delegated_tasks` 上那条唯一索引的去重键含**由当前时刻算出的截止时间**，同一条消息几分钟后重投，
-- now() 变了 ⇒ 去重键变了 ⇒ 建出第二条任务。它挡得住「同一秒内两次点击」，挡不住「稍后重投」。
--
-- 三个 state（CHECK 钉死，绝不留第四种含义暧昧的态）：
--   in_flight —— 抢到了、正在跑。**对外既不是成功也不是失败。**
--   applied   —— 处理器跑完并给了回执，`receipt` 存**首次回执原文**（重放靠它原样回放）。
--   rejected  —— 处理器明确说不，`receipt` 存拒绝三字段（code / message / status）。
--                **status 存处理器给的那个**：客户端补默认 400 会把 409 / 422 一并压平。
--
-- 关于「崩在 in_flight 上」那一格（唯一需要显式裁的一格）：重放读到 in_flight 时
--   MUST NOT 回 duplicate —— 那是在断言首次成功了；
--   MUST NOT 直接重跑     —— 副作用可能已经发生，重跑就是双发；
--   MUST     回「结果未知」。
-- 这一格没有别的诚实解：我们确实不知道那一次的结局，而编一个结局比说不知道更贵。
-- （同进程内还有一层更准的答案：接收方持着那次调用的 promise，重放可以等它拿到真结果。
--   落到本表这一格的只有「进程真的死过」或「是另一个进程」两种情况。）
--
-- scope 存的是**入参里那个作用域**（账号），不是从 command_id 反解出来的那个：
-- 同一把键被用在两个不同账号上是调用方的错，接收方要能当场判出 collision 而不是照着跑。
-- 判据形态逐字照 4a 的既有判例（`src/comm/edge-resume-command-receiver.ts` 比 `input.accountId`）。
--
-- execution_target 隔离（CLAUDE.md §2）：dev/ol 长期共库。它进**主键**——命令键本身不含 target，
-- 两台机器上的同一条运营消息是两次独立意图，绝不能互相判成重复。
--
-- 属主 automation（`boundaries/table-ownership.json` 已登记）。api 侧 MUST NOT 直连回读本表：
-- 跨属主读没有豁免通道（AC-OWN-06），回读一律经内部 API 向属主域要。
--
-- 保留期：created_at 供剪裁用。**本刀不加剪裁器**——键空间按运营消息增长、量级极小（人手动发的指令），
-- 现在加一个定时器属于给一个还不存在的问题镀金。真需要时按 event_outbox 那套主题剪裁办。
CREATE TABLE IF NOT EXISTS operator_command_receipt (
  execution_target  TEXT        NOT NULL,
  command_id        TEXT        NOT NULL,
  command_kind      TEXT        NOT NULL,
  -- 入参给的作用域（账号）。同键不同 scope ⇒ collision。
  scope             TEXT        NOT NULL,
  state             TEXT        NOT NULL CHECK (state IN ('in_flight', 'applied', 'rejected')),
  -- applied：首次回执原文；rejected：拒绝三字段。in_flight 时为 NULL（**绝不填推断值**）。
  receipt           JSONB,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- 结局落定的时刻；in_flight 时为 NULL。
  decided_at        TIMESTAMPTZ,
  PRIMARY KEY (execution_target, command_id)
);

-- 审计与剪裁用（按 target 看最近的指令）。
CREATE INDEX IF NOT EXISTS operator_command_receipt_target_created_idx
  ON operator_command_receipt (execution_target, created_at DESC);
