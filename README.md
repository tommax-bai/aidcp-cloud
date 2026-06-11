# aidcp-cloud

AIDCP 云端：**事件驱动多 Agent 浏览会话编排 + 任务规划 + 文本 LLM + 锚点主缓存 + 风控状态机 + 边-云通信 + 飞书集成 + 内容发布**。

边缘端（[`aidcp-edge`](../aidcp-edge)）负责把动作落到真实浏览器；云端负责"想"——
以 Soul 人设驱动 `RoleDispatcher` 注册的 **15 个角色**（通过进程内 `EventBus` 解耦协作），
逐动作编排浏览会话全生命周期（列表评估 → 开卡 → 质量关卡 → 互动决策 → 主页/关注 → 搜索拓展 → 返回续刷），
同时维护风控预算与状态机、锚点缓存、飞书运营通知与内容发布审批。

> **架构提示**：早期为"单体 `Planner → PlanStep[]` 单线规划 + Blackboard + Arbiter 仲裁"。
> 现已重构为**事件驱动多 Agent**：角色各自 `subscribe` EventBus、产出语义事件，由
> `command-bridge` 翻译为[协议 v2](../aidcp/docs/protocol.md) 指令下发边缘。
> 旧的 `session-orchestrator`/`state-machine`/`engagement-decider`/`concept-extractor`/`blackboard`/`src/publish` 已不存在。

## 模块

| 目录 | 职责 |
| --- | --- |
| `src/orchestrator/` | `RoleDispatcher`：事件驱动角色调度器，注册 15 角色、`feed.entered` 启动闭环、把 Edge 上报喂数据层、把角色事件翻译成 `EdgeCommand` 下发。 |
| `src/agents/` | 15 个角色（继承 `BaseRole`，经 EventBus 协作）：`ContentEvaluator`/`FeedScroller`/`SearchScroller`/`NoteOpener`/`DeepReader`/`ContentCuratorRole`/`InteractionAppraiserRole`/`AuthorEvaluator`/`ProfileOpener`/`ProfileBrowser`/`FollowAgent`/`SearchEvaluator`/`SearchExecutor`/`BackToFeed`/`SessionMonitorRole` + `SessionContext` 会话态。 |
| `src/event-bus/` | 进程内 typed 事件总线（`emit` fire-and-forget / `emitAsync` / `onAny`），模块间解耦异步通信，集中定义事件类型。 |
| `src/risk/` | 风控与会话预算：`RiskController`（动作许可判定）+ `RiskStateMachine`（`normal→warned→restricted→frozen`）+ 滑窗计数 + 三档配额 + 冷启动 + 时间窗 + 会话预算 + 互动去重 + PG 持久化。 |
| `src/soul/` | Soul 人设与行为规则加载（`soul.yaml` → 身份/兴趣/行为准则/会话上限），为所有角色决策提供人格化上下文。 |
| `src/feishu/` | 飞书集成（官方 SDK 长连接）：卡片构建、命令路由（`/status //pause //resume //bind`）、Bot 进退群自动入库、发布审批卡片回调写信号文件。 |
| `src/publish-agent/` | 内容发布角色管道：`ContentScout → ContentCreator → ImageDirector → ContentAssembler → ApprovalGatekeeper → PublishExecutor`，`pipeline-context` 串联，`wanxiang-client` 万象生图，`publish-log-store` 落库。 |
| `src/llm/` | Qwen（通义千问）文本模型 HTTP 客户端（DashScope 兼容 OpenAI 接口），仅用全局 `fetch`，无 SDK 依赖。 |
| `src/planner/` | 任务规划接口 `TaskPlanner` + `SimplePlanner`（规则优先，LLM 兜底）；服务"一句话目标→原子步骤"的定向场景。 |
| `src/cache/` | PostgreSQL 锚点主缓存 `PgAnchorCache`（+ 暂存晋升）+ 概念池 `ConceptStore` + Bot 群绑定 `BotChatStore`。 |
| `src/comm/` | 边-云 WebSocket 服务端 `EdgeCloudServer` + 协议定义 `protocol.ts`（v2，40 消息类型）+ `DefaultMessageHandler` 路由 + `command-bridge`（EdgeCommand→Envelope）。 |
| `src/account-state.ts` | 账号 active/paused 内存状态管理（暂停时跳过笔记处理）。 |
| `src/server.ts` | 启动入口：装配全部模块，监听 WebSocket + 启动飞书长连接。 |

## 浏览会话编排

系统核心采用**事件驱动 + 多角色 + 闭环往复**模式：

1. **RoleDispatcher** — 注册 15 角色并 `setup()` 订阅；`feed.entered` 事件启动闭环；接收 Edge 结构化上报（`page.cards`/`note.detail`/`profile.detail`）更新到数据层供角色读取。
2. **角色按事件链协作**（节选）：`ContentEvaluator`（卡片价值）→ `NoteOpener`（开卡）→ `ContentCuratorRole`（质量关卡，`quality.pass/reject`）→ `InteractionAppraiserRole`（点赞/收藏决策）→ `AuthorEvaluator`/`ProfileOpener`/`ProfileBrowser`/`FollowAgent`（主页与关注）→ `BackToFeed`（返回续刷）。
3. **SessionMonitorRole** — 会话守护：超时长/超预算时 `veto`，产出 `session.should_end`。
4. **command-bridge** — 把角色产出的 `EdgeCommand` 翻译为协议 Envelope，经 `ws-server.pushToEdges` 下发。
5. **Soul** — 以 `soul.yaml` 定义人设，驱动各角色的人格化决策。
6. **RiskController** — 通过状态机 + 滑窗计数约束可用动作配额，账号风控状态权威单写。

数据流：边缘 `page.cards`/`note.detail` 上报 → `handler` emit 事件 → 角色并发决策 → 角色事件 → `command-bridge` 翻译 → 下发边缘 `interaction.like`/`page.scroll`/`navigation.back` 等。会话以 `feed.entered` 闭环往复，直到 `SessionMonitorRole` 判结束。

## 运行

```bash
npm install
npm run typecheck   # tsc --noEmit
npm test            # node:test（不依赖真实 PG / 网络）
npm start           # 起 WebSocket 服务端（默认 :8787）
```

> 部署口径：cloud 只部署在 ECS（systemd `aidcp-cloud.service`，`:8787`，同机 PG 直连），
> 本地不要起 cloud。详见 `docs/deployment-ecs.md` 与总览仓 `aidcp/docs/handoff-2026-06-05.md`。

### 环境变量

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `AIDCP_PORT` | `8787` | WebSocket 监听端口 |
| `DASHSCOPE_API_KEY` | — | Qwen API Key |
| `FEISHU_APP_ID` | — | 飞书自建应用 App ID |
| `FEISHU_APP_SECRET` | — | 飞书自建应用 App Secret |
| `FEISHU_CHAT_ID` | — | 默认推送群 chat_id（审批/通知，可由 `/bind` 注册的默认群兜底） |
| PG 连接 | `127.0.0.1:5432` / `aidcp` / `aidcp` | `DATABASE_URL` 或 `PGHOST/PGPORT/PGDATABASE/PGUSER/PGPASSWORD` |

## 边-云协议

消息基于统一信封 `{v, type, id, ts, payload}`（`v=2`），请求/响应以 `id` 关联。
完整定义见总览仓 [`aidcp/docs/protocol.md`](../aidcp/docs/protocol.md) 与本仓 `src/comm/protocol.ts`。

核心消息分组：握手（`hello/welcome`）、定向规划（`plan.*`/`select.*`/`anchor.*`/`action.result`）、
浏览编排（`note.content`/`browse.*`/`note.open`/`search.execute`/`session.end`）、
角色驱动指令（`page.scroll`/`interaction.like|collect|follow`/`navigation.back`/`note.browse_images|scroll_comments`）、
结构化上报（`page.cards`/`note.detail`/`profile.detail`/`action.completed`）、
风控预算（`session.budget.*`/`risk.canDo.*`/`risk.record.*`）、发布（`publish.request`/`publish.approval_request`/`publish.result`）。
