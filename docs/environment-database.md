# aidcp-cloud 环境与数据库连接说明

> 勘察日期：2026-06-04
> 状态：只读勘察确认

> 关键环境信息必须落档，避免再次沿用已废弃的本地起 cloud + SSH 隧道临时方案。

## 当前确认结论

- `aidcp-cloud` 只部署在云端 ECS：`121.89.85.150`
- cloud 部署目录：`/opt/aidcp/cloud`
- PostgreSQL 与 cloud 同机，监听 `127.0.0.1:5432`
- `aidcp` 数据库与 `aidcp` 角色已就绪
- cloud 在 ECS 本机直连 PostgreSQL，**不需要 SSH 隧道**
- 参数权威来源为 ECS 上 `/opt/aidcp/cloud/.env`
- 文档中只记录键名与凭证存放位置，**绝不记录密码、token、key 明文**

## 架构铁律

> **cloud 只部署在云端 ECS，本地永不再起 cloud；本地只跑 edge，edge 连接 ECS cloud：`ws://121.89.85.150:8787`。**

历史教训：

- 曾在本机启动 cloud，误连本机空 PostgreSQL，报错 `role "aidcp" does not exist`
- 根因不是 ECS 数据库缺失，而是违反了“cloud 仅运行在 ECS、本地只跑 edge”的架构约束

## ECS 上的数据库连接事实

- PostgreSQL 地址：`127.0.0.1:5432`
- 数据库名：`aidcp`
- 角色名：`aidcp`
- cloud 在 ECS 本机运行时，默认连接参数即为正确目标

代码侧已确认支持以下覆盖方式（标准 PG* 键，优先级最高）：

- `DATABASE_URL`
- `PGHOST`
- `PGPORT`
- `PGUSER`
- `PGPASSWORD`
- `PGDATABASE`

此外，`src/risk/pg-risk-store.ts`（`pgRiskConfigFromEnv`）另读取一组 `AIDCP_PG_*` 作为**次级回退**：

- `AIDCP_PG_HOST`
- `AIDCP_PG_PORT`
- `AIDCP_PG_DATABASE`（兼容 `AIDCP_PG_DB`）
- `AIDCP_PG_USER`
- `AIDCP_PG_PASSWORD`

注意生效优先级：在 ECS 上 `src/server.ts` 会把标准 `PG*` 键显式传给 `PgRiskStore`，因此实际顺序为 `PGHOST > AIDCP_PG_HOST > 硬编码默认`。也就是说，配好标准 `PG*` 后风控库即生效，并不会停留在硬编码默认值上。

默认值在当前 ECS 部署上即成立：

- host=`127.0.0.1`
- port=`5432`
- database=`aidcp`
- user=`aidcp`

敏感值说明：

- **数据库连接口令**采用源码内置默认值兜底（`src/cache/pg-anchor-cache.ts` 的 `DEFAULT_PG_CONFIG`，`src/risk/pg-risk-store.ts` 的 `pgRiskConfigFromEnv` 回退复用同一默认值）。这是一台**同机内网 PG**（`127.0.0.1:5432`，不对外暴露）的引导口令——它无法存进它自己要打开的库里，按现行设计内置兜底即可、不单独轮换；`PGPASSWORD` / `DATABASE_URL` 为**可选覆盖**（ECS `/opt/aidcp/cloud/.env` 已配 `PGPASSWORD`，优先级高于内置默认值）。
- **业务密钥**（DashScope / 模型 API key 等）走库内加密存储（`src/config/credential-store.ts`，AES-256-GCM，主密钥 `AIDCP_CRED_KEY`）或 ECS `.env`，不写入仓库文档。
- 本文档只保留键名与存放位置，不记录任何明文值。

## 环境变量权威来源

ECS 上 `aidcp-cloud` 的权威环境文件为：

- `/opt/aidcp/cloud/.env`

已确认包含以下键名：

- `AIDCP_PORT`
- `DASHSCOPE_API_KEY`
- `PGHOST`
- `PGPORT`
- `PGUSER`
- `PGPASSWORD`
- `PGDATABASE`
- `FEISHU_APP_ID`
- `FEISHU_APP_SECRET`
- `FEISHU_CHAT_ID`

说明：

- 业务敏感值（API key / token / 飞书密钥等）存放于 ECS `/opt/aidcp/cloud/.env` 或库内加密存储（见上文「敏感值说明」）
- 本文档只保留键名，不记录任何明文值

## 超时旋钮（可选覆盖，均有安全默认，缺省/非法回落、绝不 brick）

> change `raise-model-call-timeouts-for-thinking-models`（2026-07-01）：为 thinking 类模型整体抬高单次调用天花板并联动放大外层时限。以下键**不设即用默认值**，只在需要按部署调优时写入 ECS `.env`。毫秒。

- `AIDCP_LLM_TIMEOUT_MS`（默认 `180000`）：云端单次文本模型调用天花板（QwenClient 构造默认）。thinking 模型复杂提示常需 60–150s+，故 ≥180s。**联动不变量**：看门狗恢复轻推阈值必须严格大于此值（见下）。
- `AIDCP_COMMENT_LLM_TIMEOUT_MS`（默认 `30000`）：浏览评论评估、撰写与去 AI 味改写的单次模型硬 deadline；只覆盖评论三角色，不下调其它 thinking 角色的全局天花板。
- `AIDCP_COMMENT_CORPUS_LOOKUP_TIMEOUT_MS`（默认 `3000`）：评论撰写前可选参考语料查询上限；超时按空参考继续。
- `AIDCP_COMMENT_SUBLINE_TIMEOUT_MS`（默认 `300000`）：整条 `commentInflight` 暂停窗最后保险；到期诚实 skip 并释放浏览，迟到授权失效。
- `AIDCP_PUBLISH_PIPELINE_TIMEOUT_MS`（默认 `600000`）：发布流水线总闸，须 ≥ 关键路径各模型角色预算之和（容器不得小于内容物）。
- 发布角色执行超时（各角色闸；均须 ≥ 单次模型天花板且会同传进该角色的模型调用）：
  - `AIDCP_PUBLISH_GATE_TIMEOUT_MS`（默认 `180000`，ApprovalGatekeeper）
  - `AIDCP_PUBLISH_QUALITY_TIMEOUT_MS`（默认 `180000`，QualityScorer）
  - `AIDCP_PUBLISH_CLEAN_TIMEOUT_MS`（默认 `180000`，ContentCleaner 去 AI 味重写）
  - `AIDCP_PUBLISH_IMGSETPLAN_TIMEOUT_MS`（默认 `180000`，ImageSetPlanner 配图选题，文本 LLM）
  - `AIDCP_PUBLISH_IMGPROMPT_TIMEOUT_MS`（默认 `180000`，ImagePromptComposer 配图指令，文本 LLM）
  - `AIDCP_PUBLISH_SCOUT_TIMEOUT_MS`（默认 `180000`，ContentScout）
  - `AIDCP_PUBLISH_CONTENT_TIMEOUT_MS`（默认 `180000`，ContentCreator）
  - `AIDCP_PUBLISH_TITLE_TIMEOUT_MS`（默认 `180000`，TitleCreator）
- 看门狗空转阈值（浏览闭环，代码写死默认；生产按账号值走后台配置管线、非 env）：恢复轻推默认 240s（`DEFAULT_IDLE_NUDGE_MS`，须 > 单次模型天花板）、轻推配置下限 200s（`IDLE_NUDGE_MIN_MS`，读时钳制：DB 存旧值自动抬到默认）、放弃结束生产值须显式设 ≥480s（否则 ≤ 轻推时读时回落写死默认 1h）。
- 生图相关（未随本次改动，列此便于对照）：`AIDCP_WANXIANG_MAX_POLL`（默认 34，×5s=170s 轮询预算）、`AIDCP_PUBLISH_PER_IMAGE_TIMEOUT_MS`（默认 100000，每图）。

## 已废弃方案：本地起 cloud + SSH 隧道

> **状态：已废弃，仅供历史本地调试背景参考，不再作为现行方案。**

历史上曾使用以下临时方式：

- 在本机启动 cloud
- 通过 SSH 隧道把本地端口转发到 ECS 的 `127.0.0.1:5432`
- 再让本地 cloud 指向 `127.0.0.1:15432`

该方案已纠偏，原因如下：

- 现行架构要求 cloud 固定运行在 ECS
- ECS 上 cloud 与 PostgreSQL 同机，直连即可
- 本地只需要运行 edge，并连接 `ws://121.89.85.150:8787`

因此，以下说法均已过时：

- “PG 必须通过 SSH 隧道访问”
- “cloud 应指向 `127.0.0.1:15432`”

这些内容仅代表历史调试阶段，不再适用于当前部署。
