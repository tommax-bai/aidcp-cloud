# aidcp-cloud

AIDCP 云端：**ManagerAgent 浏览会话编排 + 任务规划 + 文本 LLM + 锚点主缓存 + 边-云通信 + 飞书集成 + 内容发布**。

边缘端（[`aidcp-edge`](../aidcp-edge)）负责把动作落到真实浏览器；云端负责"想"——
以 Soul 人设驱动 ManagerAgent 动态角色链，编排浏览会话全生命周期（浏览 → 互动决策 → 概念抽取 → 搜索拓展），
同时维护风控预算、锚点缓存、飞书运营通知与内容发布审批。

## 模块

| 目录 | 职责 |
| --- | --- |
| `src/orchestrator/` | 浏览会话编排：`SessionOrchestrator` 管理会话生命周期，`ManagerAgent` 动态角色链驱动决策，`EngagementDecider` 互动决策，`ConceptExtractor` 概念抽取。 |
| `src/soul/` | Soul 人设与行为规则加载（`soul.yaml` → 身份/兴趣/行为准则/会话上限），为所有智能决策提供人格化上下文。 |
| `src/risk/` | 风控与会话预算管理：`RiskController` 状态机 + 滑窗计数 + 频率限制 + 冷启动规划，约束可用动作配额。 |
| `src/feishu/` | 飞书集成：卡片消息构建、运营命令路由（状态/暂停/恢复）、Bot 群事件接收（官方 SDK 长连接）。 |
| `src/publish/` | 内容发布与审批流程：生成发布内容 → 飞书卡片审批 → 通过后触发 Edge 执行发布。 |
| `src/llm/` | Qwen（通义千问）文本模型 HTTP 客户端（DashScope 兼容 OpenAI 接口），仅用全局 `fetch`，无 SDK 依赖。 |
| `src/planner/` | 任务规划接口 `TaskPlanner` + 简单实现 `SimplePlanner`（规则优先，LLM 兜底）。 |
| `src/cache/` | PostgreSQL 锚点主缓存 `PgAnchorCache` + 概念池持久化 `ConceptStore` + Bot 群绑定存储。 |
| `src/comm/` | 边-云 WebSocket 服务端 + 协议定义（`protocol.ts`，消息类型）+ 默认消息处理器。 |
| `src/server.ts` | 启动入口：装配全部模块，监听 WebSocket + 启动飞书长连接。 |

## 浏览会话编排

系统核心采用 **ManagerAgent 模式**，由 `SessionOrchestrator` + `ManagerAgent` 驱动一次完整的浏览会话：

1. **SessionOrchestrator** — 管理浏览会话生命周期（启动 → 循环处理笔记 → 结束），协调各组件协作。
2. **ManagerAgent 动态角色链** — 根据当前页面类型激活不同角色：
   - `SessionMonitor`（始终活跃）：监控会话时长与预算；
   - `FeedScanner`（列表页）：从 Feed/搜索结果中筛选值得打开的卡片；
   - `ContentCurator`（详情页）：评估笔记内容质量（原创性、深度、数据支撑）；
   - `InteractionAppraiser`（详情页，ContentCurator 通过后）：决定 like / collect / 跳过。
3. **EngagementDecider** — 对单条笔记做互动决策（硬门槛 + Qwen 模型评估）。
4. **ConceptExtractor** — 从优质内容中抽取新概念，扩展兴趣探索边界。
5. **Soul** — 以 `soul.yaml` 定义人设（身份/兴趣/行为准则/会话上限），驱动所有智能决策的人格化表达。
6. **风控预算** — `RiskController` 通过状态机 + 滑窗计数约束每日/每会话可用动作配额，防止异常行为。

数据流：边缘上报 `note.content` → 互动决策 → 概念抽取 → ContextBuilder 汇总上下文 → ManagerAgent 产出下一步命令 → 翻译为协议消息下发给边缘。

## 运行

```bash
npm install
npm run typecheck   # tsc --noEmit
npm test            # node:test（24 个用例，不依赖真实 PG / 网络）
npm start           # 起 WebSocket 服务端（默认 :8787）
```

### 环境变量

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `AIDCP_PORT` | `8787` | WebSocket 监听端口 |
| `DASHSCOPE_API_KEY` | — | Qwen API Key |
| `FEISHU_APP_ID` | — | 飞书自建应用 App ID |
| `FEISHU_APP_SECRET` | — | 飞书自建应用 App Secret |
| `FEISHU_CHAT_ID` | — | 默认推送群 chat_id（审批/通知） |
| PG 连接 | `127.0.0.1:5432` / `aidcp` / `aidcp` | `DATABASE_URL` 或 `PGHOST/PGPORT/PGDATABASE/PGUSER/PGPASSWORD` |

## 边-云协议

消息基于统一信封 `{v, type, id, ts, payload}`，请求/响应以 `id` 关联。完整定义见
[`../aidcp`（umbrella）的 `docs/protocol.md`](../../.verdent/verdent-projects/aidcp/docs/protocol.md)
与本仓 `src/comm/protocol.ts`。

核心消息：`hello/welcome`、`plan.request/response`、`select.request/response`、
`anchor.get/anchor.get.result`、`anchor.report`、`action.result`、`ping/pong`、`error`。
