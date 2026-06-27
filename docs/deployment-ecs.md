# aidcp-cloud ECS 部署现状

> 勘察日期：2026-06-04
> 状态：只读勘察确认

## 一页结论

- `aidcp-cloud` 当前部署在 ECS `121.89.85.150`
- 部署目录为 `/opt/aidcp/cloud`
- 由 systemd 单元 `aidcp-cloud.service` 托管，当前状态为 active running
- 由 systemd 启动：`ExecStart=/usr/bin/npx tsx src/server.ts`，环境变量经 `EnvironmentFile=/opt/aidcp/cloud/.env` 注入
- 工作目录为 `/opt/aidcp/cloud`
- 服务对外监听 `0.0.0.0:8787`
- edge 公网直连地址为 `ws://121.89.85.150:8787`
- PostgreSQL 与 cloud 同机，cloud 直连 `127.0.0.1:5432`
- 本地不再启动 cloud，本地只运行 edge

## 架构铁律

> **cloud 只部署在云端 ECS，本地永不再起 cloud；本地只跑 edge，edge 连接 ECS cloud：`ws://121.89.85.150:8787`。**

历史教训：

- 曾在本机启动 cloud，误连本机空 PostgreSQL，报错 `role "aidcp" does not exist`
- 根因是违反了“cloud 仅运行在 ECS、本地只跑 edge”的架构约束

## 当前部署事实

### 1. 服务托管方式

- systemd 单元：`aidcp-cloud.service`
- 服务状态：active running
- 工作目录：`/opt/aidcp/cloud`
- 启动命令（systemd）：`ExecStart=/usr/bin/npx tsx src/server.ts`，环境变量由 `EnvironmentFile=/opt/aidcp/cloud/.env` 注入（不使用 `--env-file`）
- 手动 / 调试启动（package.json 的 `start` 脚本形式）：`tsx --env-file=.env src/server.ts`（`--env-file` 必须位于脚本之前，否则会被 tsx 当作脚本参数）

### 2. 网络与访问

- cloud 对外监听：`0.0.0.0:8787`
- edge 连接地址：`ws://121.89.85.150:8787`
- 当前确认信息中未引入额外反向代理，edge 为公网直连 ECS cloud

### 3. 数据库连接

- PostgreSQL 位于同一台 ECS
- 地址：`127.0.0.1:5432`
- 数据库：`aidcp`
- 角色：`aidcp`
- cloud 在 ECS 本机直连即可，**不需要 SSH 隧道**

代码侧已确认支持以下数据库配置覆盖方式：

- `DATABASE_URL`
- `PGHOST`
- `PGPORT`
- `PGUSER`
- `PGPASSWORD`
- `PGDATABASE`

补充：`src/risk/pg-risk-store.ts` 另接受一组可选兜底键 `AIDCP_PG_HOST` / `AIDCP_PG_PORT` / `AIDCP_PG_DATABASE` / `AIDCP_PG_USER` / `AIDCP_PG_PASSWORD`；但 ECS 上 `src/server.ts` 已显式传入标准 `PG*` 键，优先级更高，因此风控存储与其余组件走同一套 PG 连接，无需单独配置该兜底族。

当前 ECS 部署下，默认值即正确：

- `127.0.0.1:5432`
- database=`aidcp`
- user=`aidcp`

### 4. 权威环境文件

权威来源：

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

模型与凭据配置（change console-model-provider-config，可选）：

- `AIDCP_CRED_KEY`：后台「模型配置」页加密保存 API 密钥用的主加密密钥（AES-256-GCM）。值为 **32 字节随机、base64 编码**，生成法：`openssl rand -base64 32`。仅存放于 ECS `.env`，**绝不入库 / 入仓 / 进日志**。
  - 未配置时：后台仍可改模型名（热加载即时生效），但「保存密钥」禁用并提示主密钥缺失；系统继续用 `DASHSCOPE_API_KEY`（env）。
  - 已配置时：后台可改 DashScope API 密钥（加密落 `provider_credentials` 表），**改密钥后需 `systemctl restart aidcp-cloud.service` 才生效**；模型名改动无需重启。

敏感信息规则：

- 所有密码、token、key 仅存放于 ECS `/opt/aidcp/cloud/.env`
- 不入 git
- 不在仓库文档中记录明文

### 5. 运行时环境

- Node.js：`v20.20.2`
- npm：`10.8.2`
- 未安装：`pnpm`
- 未安装：`pm2`
- 未安装：`lsof`

## 运维红线

> **任何 aidcp-cloud 的 ECS 操作，绝不能碰 isales。**

同机还独立运行 `isales` 项目，包含：

- `isales-scheduler`
- `api`
- `worker`
- `engine`
- 独立 `isales` 数据库

已确认：

- `isales` 与 `aidcp` 相互独立
- 当前无端口、数据库、服务托管冲突
- 后续对 `aidcp-cloud` 的更新、重启、备份、回滚，均不得影响 `isales`

## 当前隐患与后续动作

### 已确认隐患

- `/opt/aidcp/cloud` 当前不是 git 仓库
- 现状更像 zip 解压上传后的目录
- ECS 上代码大概率偏旧，不包含近期修复

已知可能缺失的近期修复包括：

- commit `18c6f2b`：飞书审批卡 raw 包装修复
- 发卡时 `FEISHU_CHAT_ID` 的兜底降级处理

### 后续建议动作

后续若要更新 ECS 部署，应按以下顺序执行：

1. 先备份当前 `/opt/aidcp/cloud`
2. 将 ECS 部署目录 git 化或以受控方式替换为仓库版本
3. 更新到目标代码版本
4. 执行 `systemctl restart aidcp-cloud`
5. 验证服务恢复与 edge 连通

## 部署准备与更新流程

> 本节记录 2026-06-04 已完成的 ECS 部署准备评估结果，仅作为后续正式更新时的执行依据。

### ECS SSH 连接方式

- 登录命令：`ssh -i ~/codes/isales-4.pem root@121.89.85.150`
- 注意：默认 SSH key 会被拒绝，必须显式指定 `~/codes/isales-4.pem`
- 私钥文件位置：`~/codes/isales-4.pem`
- 私钥权限要求：`600`
- 文档只记录私钥路径与权限要求，不记录私钥内容

`rsync` 部署示例：

```bash
rsync -av -e 'ssh -i ~/codes/isales-4.pem' \
  --exclude '.env' \
  --exclude 'node_modules' \
  --exclude '.git' \
  <本地src/等> \
  root@121.89.85.150:/opt/aidcp/cloud/
```

部署后验证清单：

- `journalctl -u aidcp-cloud --no-pager -n 50` 中看到“飞书长连接已建立”
- `ss -ltnp | grep 8787` 中看到 `0.0.0.0:8787`
- `systemctl status aidcp-cloud` 显示 `active (running)`
- `psql -h 127.0.0.1 -U aidcp -d aidcp -c 'select 1;'` 可成功返回结果

### 1. 备份与回滚准备

已确认 ECS 侧备份已就绪：

- 代码备份：`/opt/aidcp/cloud.bak.20260604-1655.tar.gz`
- 备份体积：约 13M
- 备份内容说明：不含 `node_modules`
- `.env` 单独备份：`/opt/aidcp/cloud/.env.bak.20260604`
- `.env` 备份体积：约 298B

回滚原则：

- 恢复对应代码备份与 `.env` 备份
- 然后执行 `systemctl restart aidcp-cloud`

### 2. `.env` 关键键核实结果

以下键已确认存在，且要求值非空：

- `DASHSCOPE_API_KEY`
- `FEISHU_APP_ID`
- `FEISHU_APP_SECRET`
- `FEISHU_CHAT_ID`
- `PGHOST`
- `PGPORT`
- `PGUSER`
- `PGDATABASE`

说明：

- `DASHSCOPE_API_KEY` 已配且非空，真发链路依赖该 key，ECS 当前已具备
- 文档仅记录“已配/非空”这一事实，不记录任何具体值

### 3. systemd 单元关键字段

已确认 `/etc/systemd/system/aidcp-cloud.service` 关键字段如下：

- `WorkingDirectory=/opt/aidcp/cloud`
- `EnvironmentFile=/opt/aidcp/cloud/.env`
- `ExecStart=/usr/bin/npx tsx src/server.ts`
- `Restart=on-failure`
- `RestartSec=5`

更新代码后的重启命令：

```bash
systemctl restart aidcp-cloud
```

### 4. 更新方式评估

已确认 ECS 运行环境：

- 可访问 npm registry
- `npm view tsx version` 已成功
- Node.js 为 `v20.20.2`
- npm 为 `10.8.2`
- 未安装 `pnpm`
- 未安装 `pm2`
- 未安装 `lsof`

当前重要约束：

- ECS 当前无法访问 GitHub 私库
- `git@github.com:tommax-bai/aidcp-cloud.git` 的 SSH 方式因缺少凭证被拒绝
- HTTPS 方式同样因缺少凭证无法拉取

因此，当前推荐更新方式为：

1. 在本地打包最新代码
2. 使用 `rsync` 上传到 `/opt/aidcp/cloud`
3. 上传时保留 ECS 原有 `.env`
4. 在 ECS 上执行 `npm install`
5. 执行 `systemctl restart aidcp-cloud`

治本方向（TODO）：

- 为 ECS 配置 GitHub deploy key
- 将部署方式改为 `git clone` / `git pull`
- 使部署过程具备版本可追溯性

## 更新与回滚命令草案

> 以下仅为文档草案，供后续正式变更时参考；本次未执行。

### 更新流程草案

```bash
tar -czf /opt/aidcp/cloud.bak.$(date +%Y%m%d-%H%M).tar.gz -C /opt/aidcp cloud
rsync -av --delete \
  --exclude '.env' \
  --exclude 'node_modules' \
  ./ /opt/aidcp/cloud/
cd /opt/aidcp/cloud && npm install
systemctl restart aidcp-cloud
```

说明：

- 若沿用已存在备份，也可不重复创建 tar 备份
- 上传时应覆盖最新代码与依赖声明文件，例如 `src/`、`package.json`、锁文件（若后续仓库采用）
- 必须保留 ECS 原有 `.env`

### 回滚草案

```bash
tar -xzf /opt/aidcp/cloud.bak.20260604-1655.tar.gz -C /opt/aidcp
cp -f /opt/aidcp/cloud/.env.bak.20260604 /opt/aidcp/cloud/.env
systemctl restart aidcp-cloud
```

### 验证清单

更新或回滚后，应至少完成以下验证：

- `journalctl -u aidcp-cloud` 中看到“飞书长连接已建立”
- 使用 `ss -tlnp` 确认监听 `0.0.0.0:8787`
- edge 到 cloud 连通正常
- 发卡链路正常
- PostgreSQL 连接正常

## 明确禁止事项

- 不要在本机启动 cloud
- 不要再把 cloud 指向本地临时 PostgreSQL
- 不要把数据库密码、飞书密钥、任何 token 写入 git
- 不要在 aidcp 维护过程中修改、重启、迁移或排查 `isales` 相关服务
