# aidcp-cloud

AIDCP 云端：**任务规划 + 文本 LLM + 锚点主缓存 + 边-云通信**。

边缘端（[`aidcp-edge`](../aidcp-edge)）负责把动作落到真实浏览器；云端负责"想"——
把高层目标拆成步骤、缓存缺口时用文本模型选元素、用 PostgreSQL 维护跨节点共享的锚点主缓存。

## 模块

| 目录 | 职责 |
| --- | --- |
| `src/llm/` | Qwen（通义千问）文本模型 HTTP 客户端（DashScope 兼容 OpenAI 接口），仅用全局 `fetch`，无 SDK 依赖。 |
| `src/planner/` | 任务规划接口 `TaskPlanner` + 简单实现 `SimplePlanner`（规则优先，LLM 兜底）。 |
| `src/cache/` | PostgreSQL 锚点主缓存 `PgAnchorCache`，含反污染晋升（暂存→连续确认→晋升）。 |
| `src/comm/` | 边-云 WebSocket 服务端 + 协议定义（`protocol.ts`，消息类型）+ 默认消息处理器。 |
| `src/server.ts` | 启动入口：装配上述四块，监听 WebSocket。 |

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
| PG 连接 | `127.0.0.1:5432` / `aidcp` / `aidcp` | 见 `src/cache/pg-anchor-cache.ts` 默认配置 |

## 边-云协议

消息基于统一信封 `{v, type, id, ts, payload}`，请求/响应以 `id` 关联。完整定义见
[`../aidcp`（umbrella）的 `docs/protocol.md`](../../.verdent/verdent-projects/aidcp/docs/protocol.md)
与本仓 `src/comm/protocol.ts`。

核心消息：`hello/welcome`、`plan.request/response`、`select.request/response`、
`anchor.get/anchor.get.result`、`anchor.report`、`action.result`、`ping/pong`、`error`。
