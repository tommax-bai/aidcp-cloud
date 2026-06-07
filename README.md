# aidcp-cloud

AIDCP 云端：**事件驱动多 Agent 浏览会话编排 + 任务规划 + 文本 LLM + 锚点主缓存 + 边-云通信 + 飞书集成 + 内容发布**。

边缘端（[`aidcp-edge`](../aidcp-edge)）负责把动作落到真实浏览器；云端负责"想"——
以 Soul 人设驱动 5 个独立 Agent（通过 EventBus + Blackboard + Arbiter 协作），编排浏览会话全生命周期（浏览 → 内容评估 → 互动决策 → 概念抽取 → 搜索拓展），
同时维护风控预算、锚点缓存、飞书运营通知与内容发布审批。

## 模块

| 目录 | 职责 |
| --- | --- |
| `src/orchestrator/` | 浏览会话编排：`SessionOrchestrator` 管理会话生命周期（事件驱动 + 黑板 + 多 Agent 并行 + 仲裁器），`ConceptExtractor` 概念抽取。 |
| `src/agents/` | 5 个独立 Agent：`SessionMonitor`（会话监控）、`FeedScanner`（信息流筛选）、`ContentCurator`（内容质量评估）、`InteractionAppraiser`（互动决策）、`CommentReviewer`（评论审查，预留）。 |
| `src/blackboard/` | 黑板（Agent 间共享状态）+ 仲裁器（`Arbiter`，合并多 Agent 决策为最终命令）。 |
| `src/event-bus/` | 内存事件总线（typed EventEmitter），模块间解耦异步通信，定义所有领域类型。 |
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

系统核心采用**事件驱动 + 黑板 + 多 Agent 并行 + 仲裁器**模式：

1. **SessionOrchestrator** — 管理浏览会话生命周期，订阅 EventBus `note.arrived` 事件，协调黑板、Agent、仲裁器协作。
2. **5 个独立 Agent**（并行 decide，通过 Blackboard 共享上下文）：
   - `SessionMonitor`（每轮必激活）：会话时长与预算监控，超限时 veto 否决；
   - `FeedScanner`（列表页）：从 Feed/搜索结果中筛选值得打开的卡片；
   - `ContentCurator`（详情页）：评估笔记内容质量，质量差时 gate 阻断互动 Agent；
   - `InteractionAppraiser`（详情页）：综合笔记内容与预算决定 like / collect / pass；
   - `CommentReviewer`（预留）：评论区质量审查。
3. **Arbiter（仲裁器）** — 纯逻辑合并所有 Agent 决策（veto > gate > confidence 排序 > fallback）。
4. **ConceptExtractor** — 订阅 `interaction.occurred` 事件，从优质内容中异步抽取新概念。
5. **Soul** — 以 `soul.yaml` 定义人设（身份/兴趣/行为准则/会话上限），驱动所有 Agent 的人格化表达。
6. **风控预算** — `RiskController` 通过状态机 + 滑窗计数约束每日/每会话可用动作配额，防止异常行为。

数据流：边缘上报 `note.content` → handler.ts emit `note.arrived` → SessionOrchestrator 写入黑板 → Agent 并行决策 → Arbiter 仲裁 → 翻译为协议消息下发给边缘。

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
