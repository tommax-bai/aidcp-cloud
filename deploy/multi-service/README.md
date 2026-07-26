# aidcp-cloud 一机多服务部署（Block② 2e）

> **状态：additive / opt-in 部署工件。** 不改动、不替代现役单体 `aidcp-cloud.service`。
> 这套单元 + 脚本把「一份代码、一个进程」的单体，切成「一份代码、按 `AIDCP_SERVICE` 分段的多进程」，
> 并保留一键回切单体的能力。**同机 isales（80 / 8000 / 四服务）绝不触碰。**

本目录内容都是**新增文件**：3 个目标态单元 + 1 个中间态单元 + 1 个部署脚本 + 本文档。
不含任何 `.ts`，不影响 typecheck。

---

## 1. 拓扑

同一份 `/opt/aidcp/cloud` 代码、同一份 `/opt/aidcp/cloud/.env`，靠环境变量 `AIDCP_SERVICE`
选跑哪些组合根段（`src/gateway/service-mode.ts` 的纯选择器）。段划分：

| 段 | 承载 | 监听 |
| --- | --- | --- |
| segA 基础 | DB 池 / LLM / 存储 / 配置镜像 | — |
| segB content | 精选库 / 发布后处理 / 人设 / 账号 | content 读 API :8092（仅 content 进程起） |
| segC automation | 边缘 WS server / 风控 / 编排 / 通知巡视 | edge WS :8787 |
| segD api serving | 面板 API / 客户鉴权 / 飞书接收 / 数据网关收口 | panel / client-auth（沿用 .env 现值） |

### 目标态：3-service

```
                 ┌────────────────────────────┐
   edge  ──WS──▶ │ automation (AIDCP_SERVICE=  │   segA+segC
  8787           │            automation)      │
                 │  :8787 edge WS / 风控 / 编排 │
                 └────────────────────────────┘
                 ┌────────────────────────────┐
 console/飞书 ──▶ │ api (AIDCP_SERVICE=api)     │   segA+segD
  panel/         │  panel + client-auth        │   AIDCP_GATEWAY_MODE=http
  client-auth    │  数据网关 http ─────────────┼──┐  AIDCP_GATEWAY_BASE_URL=
                 └────────────────────────────┘  │  http://127.0.0.1:8092
                 ┌────────────────────────────┐  │
                 │ content (AIDCP_SERVICE=     │◀─┘  curated 读端点
                 │          content)           │   segA+segB
                 │  内部读 API :8092（127.0.0.1）│
                 └────────────────────────────┘
```

- `automation` 只跑 segC，**不构造数据网关**（网关在 segD 内），故不设 `AIDCP_GATEWAY_*`。
- `api` 跑 segD，把 curated 读端口经 HTTP remote 到 content 进程 `127.0.0.1:8092`；
  `delegatedTask` / `interaction` 属 automation 域、仍本地拥有（不 remote 到 content）。
- `content` 起内部读 API `127.0.0.1:8092`，只服务 curated 路由。

### 中间态：2-service（当前代码可用）

```
   edge ─WS→ [ core (AIDCP_SERVICE=core) segA+segC+segD  :8787 + panel + client-auth ]
                                         数据网关 http ──┐
             [ content (AIDCP_SERVICE=content) segA+segB │ 内部读 API :8092 ]◀──────┘
```

`core` = segC+segD 合跑（现役选择器已识别）。这是**今天就能跑**的非单体拓扑。

---

## 2. ⚠ 关键前置：3-service 依赖 runtime split 工作线

**本目录只负责部署编排；「每个 service 能各自 boot」由 runtime split 工作线负责。**
落地 3-service 前，代码侧必须先满足两条（当前**尚未**满足）：

1. **选择器识别 `api` / `automation`。** 现在 `serviceModeFromEnv` 只认 `content` / `core` /
   `monolith`，**未识别值一律回落 `monolith`**（跑全四段）。若此刻用 `AIDCP_SERVICE=api` 和
   `=automation` 起两个进程，两者都变单体、都抢 `:8787` → 第二个起不来。
2. **segD 可脱离 segC 独立 boot。** 现在 `segDApiServing` 引用大量由 `segCAutomation` 构造的
   `ctx` 字段（eventBus / publishDispatcher / riskRegistry / messenger 等）；segD 单跑会拿到 undefined。

**在这两条落地前，用 2-service（content + core）作为中间态。** `deploy-multi.sh` 切 3-service 前会做
**能力探测**（grep 已同步的 `service-mode.ts` 是否含 `api`/`automation` 分支），未满足即拒绝切换、
**保持单体不停机**——不会把你推进「双单体抢 8787」的坑。

---

## 3. 端口与 .env 核对清单（TODO：部署前逐项确认）

| 键 | 用途 | 本工件处理 | 需核对 |
| --- | --- | --- | --- |
| `AIDCP_CONTENT_PORT` | content 读 API | 单元写死 `8092`（避开 isales 80/8000） | 确认 8092 在 ECS 空闲 |
| `AIDCP_PORT` | edge WS | automation/core 单元写 `8787`（与单体一致） | 已是现役口，通常无需改 |
| `AIDCP_PANEL_PORT` | 面板 API | **不在单元设定，沿用 .env 现值**（默认 127.0.0.1:8090） | 核对 .env 现值 + 与 isales 不冲突 |
| `AIDCP_CLIENT_AUTH_PORT` | 客户鉴权 | **不在单元设定，沿用 .env 现值** | 核对 .env 现值；未设=该端口禁用（预期） |
| `AIDCP_PUBLISH_APPROVAL_INTERNAL_TOKEN` | publish approval 内部调用方鉴权 | **不在单元设定，由共享 .env 注入** | api/content/automation 必须取得同一非空 secret；缺失即拒绝多进程启动，secret 不入库 |
| `AIDCP_GATEWAY_MODE` | 数据网关模式 | api/core 单元写 `http` | — |
| `AIDCP_GATEWAY_BASE_URL` | 网关指向 content | api/core 单元写 `http://127.0.0.1:8092` | 与 content 端口一致即可 |

> `.env` 是**多服务共享同一份**。同一 `.env` 里同时含 `AIDCP_PORT` / `AIDCP_PANEL_PORT` /
> `AIDCP_CLIENT_AUTH_PORT` 不会冲突：靠**段门控**——只有跑对应段的进程才 bind 对应端口
> （content 不跑 segC/segD → 不 bind 8787/panel；automation 不跑 segD → 不 bind panel）。
> 这层隔离**仅在选择器正确识别各 service 值时成立**（见第 2 节）。

---

## 4. Runbook

所有命令在**中控仓或 cloud 仓的 worktree 内**跑（脚本用 `git archive HEAD` 取干净树快照，
不吃工作区脏文件）。目标 `<dev|ol>`：dev=121.89.85.150，ol=123.56.253.183。
**ol 只从 release 分支 / clean SHA 部署**（同现役铁律）。

### 4.1 单体 → 多服务（切换）

```bash
# 先只探测、不改状态（强烈建议）：
deploy/multi-service/deploy-multi.sh dev check                 # 3-service 能力探测
deploy/multi-service/deploy-multi.sh dev --topology 2 check    # 2-service 能力探测

# 目标态（需 runtime split 已落地，否则能力探测会拒绝并保持单体不动）：
deploy/multi-service/deploy-multi.sh dev                       # = up --topology 3

# 今天可用的中间态：
deploy/multi-service/deploy-multi.sh dev --topology 2
```

`up` 内部序列（幂等、先备份、失败自动回滚到单体）：
备份 `cloud.bak.<ts>.tar.gz` + `.env.bak` → `git archive HEAD` 快照 rsync（exclude .env/
node_modules/.git）→ `npm install` → 能力探测 → 装 4 个单元 + `daemon-reload` →
`disable --now` 单体 → 起 content →（automation→api | core），每步 `ss` 端口健康检查，
任一步失败即停多服务、`enable --now` 单体、恢复到切换前。

### 4.2 多服务 → 单体（回切）

```bash
deploy/multi-service/deploy-multi.sh dev rollback
```

停用并 `disable` 全部 aidcp-cloud 多服务单元 → `enable --now aidcp-cloud.service` →
等 `:8787` 就绪。多服务单元文件不删，随时可再切回。

### 4.3 只跑健康检查

```bash
deploy/multi-service/deploy-multi.sh dev healthcheck                # 检查 3-service
deploy/multi-service/deploy-multi.sh dev healthcheck --topology 2   # 检查 2-service
```

### 4.4 手动对照命令（脚本背后等价物，供排障）

```bash
# 装单元（从已同步的仓内副本，单一真源）
cp /opt/aidcp/cloud/deploy/multi-service/aidcp-cloud-*.service /etc/systemd/system/
systemctl daemon-reload
# 切 2-service
systemctl disable --now aidcp-cloud.service
systemctl enable  --now aidcp-cloud-content.service
systemctl enable  --now aidcp-cloud-core.service
# 回切单体
systemctl disable --now aidcp-cloud-core.service aidcp-cloud-content.service
systemctl enable  --now aidcp-cloud.service
```

---

## 5. Healthcheck 清单

切换 / 回切后逐项确认（脚本已自动化端口/active 两类；带 TODO 的深检需补端点路径）：

- [ ] 各 service `systemctl is-active` = active
  - 3-service：`aidcp-cloud-content` / `-automation` / `-api`
  - 2-service：`aidcp-cloud-content` / `-core`
- [ ] content 读 API 端口监听：`ss -ltn | grep :8092`
- [ ] edge WS 端口监听：`ss -ltn | grep :8787`（automation 或 core）
- [ ] panel 端口监听（若 .env 设了 `AIDCP_PANEL_PORT`）：`ss -ltn | grep :<panel-port>`
- [ ] client-auth 端口监听（若 .env 设了 `AIDCP_CLIENT_AUTH_PORT`）
- [ ] **TODO 深检**：content 读 API 直连通 —— `curl -fsS http://127.0.0.1:8092/<curated-read-route>`
      （route 路径需与 `registerCuratedContentRoutes` 对齐后填入，勿臆造）
- [ ] **TODO 深检**：api 经网关读 content 通 —— 命中一个「读 curated 内容」的 panel 路由并期望 200
- [ ] edge 能连上 `ws://<host>:8787`（现役 e2e 口径）
- [ ] PG 连接正常：`psql -h 127.0.0.1 -U aidcp -d aidcp -c 'select 1;'`
- [ ] **isales 未受影响**：`systemctl is-active isales-*`（80/8000）仍 active，端口未被抢

---

## 6. 与现有部署文档的关系

- **`aidcp-cloud/docs/deployment-ecs.md`**：现役**单体**部署的权威事实（目录 / EnvironmentFile /
  ExecStart / 备份·回滚·验证清单 / isales 红线）。本目录**沿用**其全部约定（rsync exclude、
  备份命名、ss 检查、Node/npm 环境、不碰 isales），只在其上叠加「多进程编排」这一层，
  **不修改**该文档描述的单体路径。
- **中控仓 `aidcp/docs/deployment-environments.md` + `scripts/deploy-target`**：dev/ol 目标元数据
  权威源。`deploy-multi.sh` 内联了同一份 dev/ol host+key 映射以保持自包含，值与 `deploy-target` 一致；
  如目标元数据变更，两处需同步。
- **单体 `aidcp-cloud.service`**：本目录的单元与它**互斥共存**——文件都在，同一时刻只启用一套。
  切换/回切只改「谁 enabled + running」，不删任何单元文件。

---

## 7. 设计约束回顾（为什么这么做）

- **纯 additive**：不改任何现有文件；单体路径逐字不变（`AIDCP_SERVICE` 未设 = monolith = 现状）。
- **先备份、可回滚**：每次 `up` 先打 `cloud.bak.<ts>.tar.gz` + `.env.bak`；任何健康检查失败自动回滚单体。
- **幂等**：重复 `up` = 重新同步 + 重启；`enable`/`restart`/`daemon-reload` 皆幂等；rsync 不带 `--delete`。
- **不写死不确定值**：panel / client-auth 端口沿用 .env 现值，脚本运行时从 ECS `.env` 读，不臆造。
- **isales 红线**：所有 systemctl 目标经 `assert_aidcp_unit` 断言前缀；脚本从不碰 80/8000/isales 单元。
