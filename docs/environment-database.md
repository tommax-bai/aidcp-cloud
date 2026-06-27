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