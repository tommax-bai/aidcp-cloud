# aidcp-cloud ECS 部署现状

> 勘察日期：2026-06-04
> 状态：只读勘察确认

## 一页结论

- `aidcp-cloud` 当前部署在 ECS `121.89.85.150`
- 部署目录为 `/opt/aidcp/cloud`
- 由 systemd 单元 `aidcp-cloud.service` 托管，当前状态为 active running
- 启动命令为 `npm exec tsx src/server.ts --env-file=.env`
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
- 启动命令：`npm exec tsx src/server.ts --env-file=.env`

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

## 更新与回滚命令草案

> 以下仅为文档草案，供后续正式变更时参考；本次未执行。

### 更新前备份草案

```bash
cp -a /opt/aidcp/cloud /opt/aidcp/cloud.backup-2026-06-04
```

### 重启草案

```bash
systemctl restart aidcp-cloud
systemctl status aidcp-cloud --no-pager
```

### 回滚草案

```bash
rm -rf /opt/aidcp/cloud
cp -a /opt/aidcp/cloud.backup-2026-06-04 /opt/aidcp/cloud
systemctl restart aidcp-cloud
systemctl status aidcp-cloud --no-pager
```

## 明确禁止事项

- 不要在本机启动 cloud
- 不要再把 cloud 指向本地临时 PostgreSQL
- 不要把数据库密码、飞书密钥、任何 token 写入 git
- 不要在 aidcp 维护过程中修改、重启、迁移或排查 `isales` 相关服务
