# aidcp-cloud 环境与数据库连接说明

> 关键环境信息落档，防止换开发机后反复搞错。本文记录 aidcp 项目 PostgreSQL 的真实部署位置与连接方式。
> 注意：当前为**开发环境**，密码明文入档已获确认。**上生产前必须轮换密码，并改为只记凭证存放位置。**

## PostgreSQL 部署位置

- **部署在阿里云 ECS**：`121.89.85.150`
- SSH 登录：`ssh -i ~/codes/isales-4.pem root@121.89.85.150`
- PostgreSQL 版本：13.23
- 同一台 PG 上有两个项目库：`isales`（isales 项目）和 `aidcp`（本项目）。两库 owner 各为同名角色，互不影响。**操作 aidcp 时绝不触碰 isales 库。**

## aidcp 库连接参数

| 参数 | 值 |
| --- | --- |
| host | `127.0.0.1`（仅本机回环，见下） |
| port | `5432` |
| database | `aidcp` |
| user | `aidcp` |
| password | `***REMOVED***`（开发环境，已确认可入档；生产前轮换） |

- 参数权威来源：ECS 上 `/opt/aidcp/cloud/.env`（由 systemd 服务 `/etc/systemd/system/aidcp-cloud.service` 通过 `EnvironmentFile=/opt/aidcp/cloud/.env` 加载）。

## 访问方式：必须走 SSH 隧道（不能公网直连）

PG 仅监听 `127.0.0.1:5432`（`listen_addresses=localhost`），`pg_hba.conf` 只放行 `127.0.0.1/32`。因此：

- ❌ 公网直连 `121.89.85.150:5432` 失败（实测错误：`server closed the connection unexpectedly`）。
- ✅ 必须用 SSH 本地端口转发到 ECS 的 `127.0.0.1:5432`。

### 本地建隧道（推荐本地端口 15432，避开本机 5432 冲突）

```bash
ssh -i ~/codes/isales-4.pem -f -N -L 15432:127.0.0.1:5432 root@121.89.85.150
```

### cloud 指向隧道

aidcp-cloud 代码默认连 `127.0.0.1:5432/aidcp/aidcp`（`src/cache/pg-anchor-cache.ts` 的 `DEFAULT_PG_CONFIG`）。本机开发连 ECS 库时，让连接指向隧道本地端口：

- host=`127.0.0.1`、port=`15432`、user=`aidcp`、password=见上、database=`aidcp`

> **重要（已核实）**：`pg-anchor-cache.ts` 的 `PgAnchorCache` **当前没有从环境变量读取连接参数的入口**。`DEFAULT_PG_CONFIG` 把 host/port/user/password/database 全部硬编码（host=127.0.0.1 port=5432，密码即上表值），且 `server.ts` 中 `new PgAnchorCache()` 未传任何 options。`server.ts` 注释虽写"可由 PGHOST/PGPORT/... 覆盖"，但代码并未实现读取。
>
> **后果**：默认连的是本机 `127.0.0.1:5432`（本机空 PG → 报 `role "aidcp" does not exist`）。要让 cloud 走隧道连 ECS，有两种改法（接入时二选一）：
> 1. 给 `PgAnchorCache` 加 env 读取入口（PGHOST/PGPORT/PGUSER/PGPASSWORD/PGDATABASE 或 DATABASE_URL），再用环境变量指向隧道端口 `127.0.0.1:15432`；或
> 2. 在 `server.ts` 装配处显式 `new PgAnchorCache({ host, port, user, password, database })` 传入隧道参数。
> 推荐方案 1（更通用，便于区分本地/隧道/生产）。

## 连通验证（已实测通过）

经隧道后从本机成功只读连接：

```bash
PGPASSWORD='***REMOVED***' psql "host=127.0.0.1 port=15432 dbname=aidcp user=aidcp connect_timeout=5" -Atqc "SELECT current_database(), current_user;"
# 返回: aidcp|aidcp
```

## 常见坑

- 本机 `.env` 无 PG 覆盖变量时，cloud 会连本机空 PG，启动报 `role "aidcp" does not exist`。真库在 ECS，需先建隧道再让 cloud 指向 `127.0.0.1:15432`。
