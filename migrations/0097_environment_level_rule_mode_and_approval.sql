-- aidcp:kind=expand
-- aidcp:objects=table:facebook_rule_mode_environment_config,table:environment_comment_approval_policy
-- aidcp:objects=column:facebook_rule_mode_environment_config.env_key,column:facebook_rule_mode_environment_config.enabled
-- aidcp:objects=column:facebook_rule_mode_environment_config.definition_id,column:facebook_rule_mode_environment_config.definition_version
-- aidcp:objects=column:facebook_rule_mode_environment_config.updated_at,column:facebook_rule_mode_environment_config.updated_by
-- aidcp:objects=column:environment_comment_approval_policy.env_key,column:environment_comment_approval_policy.mode
-- aidcp:objects=column:environment_comment_approval_policy.updated_by,column:environment_comment_approval_policy.updated_at
-- aidcp:objects=column:facebook_rule_mode_config.env_backfill_skip_reason
-- aidcp:objects=column:account_comment_approval_policy.env_backfill_skip_reason
--
-- change environment-level-rule-mode-and-approval，第 1 步 expand（design.md §2「键迁移形态」）。
--
-- 规则模式配置与评论审批覆盖策略的持久化主键从账号改为环境。本文件只做**非破坏性**的三件事：
--   ① 建两张以 env_key 为主键的配置表（唯一约束 = 主键，一个环境至多一行）；
--   ② 按 client_environments 现有**唯一**绑定，把存量账号行的配置回填到它所在的环境；
--   ③ 回填不了的存量行在原表上写下**具名跳过原因**，供人工处理。
-- 旧账号键表 facebook_rule_mode_config / account_comment_approval_policy **一行都不删、一列都不改语义**，
-- 只多挂一列跳过原因；它们自此停止参与运行时读写与判定，保留作可回滚数据。删表/删列是另一条 contract 变更。
--
-- **为什么是新表而不是给旧表加 env_key 列**（与任务清单 1.1 的字面表述有出入，理由登记于此）：
--   两张旧表的 account_id 都是 PRIMARY KEY（⇒ NOT NULL），account_comment_approval_policy 还
--   REFERENCES accounts(account_id) ON DELETE CASCADE。而本变更的核心诉求是「客户在批量创建环境那一刻
--   **还没有账号**就能落库」——env-only 的行在旧表里结构上插不进去（PK 非空、外键无账号可指）。
--   若强行改造，就要 DROP PRIMARY KEY + DROP NOT NULL + DROP 外键三次约束手术：既不再是非破坏性
--   （旧代码的 ON CONFLICT (account_id) 立刻失效），CASCADE 还会让「删账号」把**环境**的配置一起删掉，
--   与「换账号配置不丢」这条正相反。新表是唯一能同时满足 expand 与创建当刻落库的形态。
--
-- 回填的三条拒绝判据与运行期反查逐条同源（client-user-store 的绑定三态）：
--   environment_missing        该账号今天不绑在任何环境上——没有可写入的环境对象；
--   binding_conflict           同一账号出现在多个环境——任取一个就是猜；
--   cross_customer_contention  该账号所在环境归属多个客户——跨客户争用，回填等于替别人做决定。
-- 跳过的行 MUST NOT 回填。查「跳过了哪些」：
--   SELECT account_id, env_backfill_skip_reason FROM facebook_rule_mode_config       WHERE env_backfill_skip_reason IS NOT NULL;
--   SELECT account_id, env_backfill_skip_reason FROM account_comment_approval_policy WHERE env_backfill_skip_reason IS NOT NULL;
--
-- 进度 / 浏览去重事实 / 批次终态（facebook_rule_progress、facebook_rule_view_fact、facebook_rule_batch）
-- **按设计保持账号键，本文件一个字都不动它们**：配置回答「这个环境要不要跑规则」，进度回答
-- 「这个账号已经做到哪」，换账号后新账号从零收集才是真实语义。

-- 定义身份的 DEFAULT / CHECK 逐条对齐账号键旧表被 0094_facebook_rule_two_tier_config 改成的现状：
-- DEFAULT 跟当前定义（两级节奏 `facebook_browse_5_like_1_join_contact_every_2`@2），CHECK 新旧都接受。
--
-- 为什么 CHECK MUST NOT 只钉当前定义：下面的回填**原样拷贝**旧表的定义身份，而旧表里同时可能存在
-- 已被 0094 迁到 v2 的行与（回滚 / 补跑次序不同的库上）仍停在 v1 的行。只允许一个值时，必有一批
-- 在 INSERT 时被 23514 拒绝、整条迁移失败。反过来若先拷贝再统一改写成当前定义，又会把「这一行原本
-- 处在哪套节奏」这条事实抹掉，让旧定义的存量行被谎报成当前定义。接受新旧两值 + 回读如实带出，
-- 才能让定义漂移在读回时被具名报出来，而不是被悄悄抹平。
CREATE TABLE IF NOT EXISTS facebook_rule_mode_environment_config (
  env_key             TEXT PRIMARY KEY REFERENCES client_environments(env_key) ON DELETE CASCADE,
  enabled             BOOLEAN NOT NULL DEFAULT false,
  definition_id       TEXT NOT NULL DEFAULT 'facebook_browse_5_like_1_join_contact_every_2',
  definition_version  INTEGER NOT NULL DEFAULT 2,
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by          TEXT,
  CHECK (definition_id IN (
    'facebook_browse_10_like_1_join_contact_1',
    'facebook_browse_5_like_1_join_contact_every_2'
  )),
  CHECK (definition_version IN (1, 2))
);

CREATE TABLE IF NOT EXISTS environment_comment_approval_policy (
  env_key     TEXT PRIMARY KEY REFERENCES client_environments(env_key) ON DELETE CASCADE,
  mode        TEXT NOT NULL CHECK (mode IN ('source_rules','auto_approve_all')),
  updated_by  TEXT,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE facebook_rule_mode_config
  ADD COLUMN IF NOT EXISTS env_backfill_skip_reason TEXT;
ALTER TABLE account_comment_approval_policy
  ADD COLUMN IF NOT EXISTS env_backfill_skip_reason TEXT;

-- 回填。env_count / owner_count 都按 DISTINCT 计，避免 client_env_scope 的一对多把计数放大成假冲突。
-- ON CONFLICT DO NOTHING：环境上已有配置（例如新代码已经先写过一次）时**不覆盖**，重跑安全。
WITH bindings AS (
  SELECT e.account_id                AS account_id,
         count(DISTINCT e.env_key)   AS env_count,
         min(e.env_key)              AS env_key,
         count(DISTINCT s.user_id)   AS owner_count
    FROM client_environments e
    LEFT JOIN client_env_scope s
      ON s.env_key = e.env_key AND s.source = 'admin'
   WHERE e.account_id IS NOT NULL AND btrim(e.account_id) <> ''
   GROUP BY e.account_id
)
INSERT INTO facebook_rule_mode_environment_config
  (env_key, enabled, definition_id, definition_version, updated_at, updated_by)
SELECT b.env_key, c.enabled, c.definition_id, c.definition_version, c.updated_at, c.updated_by
  FROM facebook_rule_mode_config c
  JOIN bindings b ON b.account_id = c.account_id
 WHERE b.env_count = 1 AND b.owner_count <= 1
ON CONFLICT (env_key) DO NOTHING;

WITH bindings AS (
  SELECT e.account_id                AS account_id,
         count(DISTINCT e.env_key)   AS env_count,
         min(e.env_key)              AS env_key,
         count(DISTINCT s.user_id)   AS owner_count
    FROM client_environments e
    LEFT JOIN client_env_scope s
      ON s.env_key = e.env_key AND s.source = 'admin'
   WHERE e.account_id IS NOT NULL AND btrim(e.account_id) <> ''
   GROUP BY e.account_id
)
INSERT INTO environment_comment_approval_policy (env_key, mode, updated_by, updated_at)
SELECT b.env_key, p.mode, p.updated_by, p.updated_at
  FROM account_comment_approval_policy p
  JOIN bindings b ON b.account_id = p.account_id
 WHERE b.env_count = 1 AND b.owner_count <= 1
ON CONFLICT (env_key) DO NOTHING;

-- 具名跳过原因：没能进新表的存量行逐行标注为什么。回填成功的行显式清成 NULL，
-- 使「有原因」严格等价于「这一行的配置没有跟到环境上」，重跑后结论仍成立。
WITH bindings AS (
  SELECT e.account_id                AS account_id,
         count(DISTINCT e.env_key)   AS env_count,
         min(e.env_key)              AS env_key,
         count(DISTINCT s.user_id)   AS owner_count
    FROM client_environments e
    LEFT JOIN client_env_scope s
      ON s.env_key = e.env_key AND s.source = 'admin'
   WHERE e.account_id IS NOT NULL AND btrim(e.account_id) <> ''
   GROUP BY e.account_id
)
UPDATE facebook_rule_mode_config c
   SET env_backfill_skip_reason = resolved.skip_reason
  FROM (
    SELECT target.account_id AS account_id,
           CASE
             WHEN b.account_id IS NULL THEN 'environment_missing'
             WHEN b.env_count > 1      THEN 'binding_conflict'
             WHEN b.owner_count > 1    THEN 'cross_customer_contention'
             WHEN NOT EXISTS (
               SELECT 1 FROM facebook_rule_mode_environment_config x WHERE x.env_key = b.env_key
             ) THEN 'environment_missing'
           END AS skip_reason
      FROM facebook_rule_mode_config target
      LEFT JOIN bindings b ON b.account_id = target.account_id
  ) resolved
 WHERE c.account_id = resolved.account_id;

WITH bindings AS (
  SELECT e.account_id                AS account_id,
         count(DISTINCT e.env_key)   AS env_count,
         min(e.env_key)              AS env_key,
         count(DISTINCT s.user_id)   AS owner_count
    FROM client_environments e
    LEFT JOIN client_env_scope s
      ON s.env_key = e.env_key AND s.source = 'admin'
   WHERE e.account_id IS NOT NULL AND btrim(e.account_id) <> ''
   GROUP BY e.account_id
)
UPDATE account_comment_approval_policy c
   SET env_backfill_skip_reason = resolved.skip_reason
  FROM (
    SELECT target.account_id AS account_id,
           CASE
             WHEN b.account_id IS NULL THEN 'environment_missing'
             WHEN b.env_count > 1      THEN 'binding_conflict'
             WHEN b.owner_count > 1    THEN 'cross_customer_contention'
             WHEN NOT EXISTS (
               SELECT 1 FROM environment_comment_approval_policy x WHERE x.env_key = b.env_key
             ) THEN 'environment_missing'
           END AS skip_reason
      FROM account_comment_approval_policy target
      LEFT JOIN bindings b ON b.account_id = target.account_id
  ) resolved
 WHERE c.account_id = resolved.account_id;

-- 跳过清单不靠人去猜：迁移自己把两张表的跳过条数喊出来。
-- MUST NOT 静默——回填不全时运营要立刻知道有多少个账号的配置没有跟到环境上。
DO $$
DECLARE
  rule_skipped     BIGINT;
  approval_skipped BIGINT;
BEGIN
  SELECT count(*) INTO rule_skipped
    FROM facebook_rule_mode_config WHERE env_backfill_skip_reason IS NOT NULL;
  SELECT count(*) INTO approval_skipped
    FROM account_comment_approval_policy WHERE env_backfill_skip_reason IS NOT NULL;
  RAISE NOTICE '[0097] facebook_rule_mode_config 未回填 % 行；account_comment_approval_policy 未回填 % 行。'
    ' 按 env_backfill_skip_reason 查具名原因（environment_missing / binding_conflict / cross_customer_contention）。',
    rule_skipped, approval_skipped;
END
$$;
