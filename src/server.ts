/**
 * aidcp-cloud 启动入口：装配 planner + Qwen + PG 缓存，起 WebSocket 服务端。
 *
 * 环境变量：
 * - AIDCP_PORT        WebSocket 监听端口（默认 8787）
 * - FEISHU_WEBHOOK_PORT 飞书事件接收端口（默认 8788）
 * - DASHSCOPE_API_KEY Qwen API Key
 * - FEISHU_APP_ID / FEISHU_APP_SECRET 飞书自建应用凭证
 * - FEISHU_CHAT_ID    默认推送群 chat_id
 * - PGHOST/PGPORT/... 可覆盖默认 PG 连接（默认 127.0.0.1:5432 aidcp/aidcp）
 *
 * 运行：npm start
 */

import { QwenClient } from './llm/index.js';
import { SimplePlanner } from './planner/index.js';
import { PgAnchorCache } from './cache/index.js';
import { EdgeCloudServer, DefaultMessageHandler } from './comm/index.js';
import { loadSoul } from './soul/index.js';
import { SessionOrchestrator, EngagementDecider, ConceptExtractor } from './orchestrator/index.js';
import {
  CommandRouter,
  FeishuMessenger,
  FeishuWebhookServer,
  type CommandActions,
} from './feishu/index.js';

async function main(): Promise<void> {
  const port = Number(process.env.AIDCP_PORT ?? 8787);

  const llm = new QwenClient();
  const planner = new SimplePlanner({ llm });
  const cache = new PgAnchorCache();
  const soul = loadSoul();

  // 建表（幂等）；PG 不可用时打印告警但不阻塞启动协议处理
  try {
    await cache.init();
    console.log('[aidcp-cloud] PG 锚点缓存已就绪');
  } catch (err) {
    console.warn('[aidcp-cloud] PG 初始化失败（缓存相关消息将报错）:', (err as Error).message);
  }

  // 会话编排器（Soul 驱动浏览决策）
  const decider = new EngagementDecider({ soul, llm });
  const extractor = new ConceptExtractor({ llm });
  const noopSink = { send: () => {} }; // 决策通过 handler 回包，不需要额外 push
  const session = new SessionOrchestrator({ soul, decider, extractor, sink: noopSink });
  session.start();
  console.log(`[aidcp-cloud] Soul 会话编排器已启动（人设: ${soul.identity.name}）`);

  const handler = new DefaultMessageHandler({ planner, llm, cache, session });
  const server = new EdgeCloudServer({ port, handler });
  await server.start();
  console.log(`[aidcp-cloud] 边-云 WebSocket 服务端已监听 :${port}`);

  // 飞书事件接收（HTTP，端口与 WS 分开）
  const feishuPort = Number(process.env.FEISHU_WEBHOOK_PORT ?? 8788);
  // MVP：账号启停/查询动作先打桩（后续接云端调度器 → plan.request）
  const actions: CommandActions = {
    status: (accountId) => `账号 \`${accountId}\` 当前状态：normal 🟢（MVP 占位）`,
    pause: (accountId) => {
      console.log(`[feishu] 收到暂停指令：${accountId}`);
    },
    resume: (accountId) => {
      console.log(`[feishu] 收到恢复指令：${accountId}`);
    },
  };
  const commandRouter = new CommandRouter(actions);
  const messenger = new FeishuMessenger();
  const webhook = new FeishuWebhookServer({ port: feishuPort, commandRouter, messenger });
  await webhook.start();
  console.log(`[aidcp-cloud] 飞书事件接收 HTTP 服务端已监听 :${feishuPort}`);
}

main().catch((err) => {
  console.error('[aidcp-cloud] 启动失败:', err);
  process.exitCode = 1;
});
