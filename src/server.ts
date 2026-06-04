/**
 * aidcp-cloud 启动入口：装配 planner + Qwen + PG 缓存，起 WebSocket 服务端。
 *
 * 环境变量：
 * - AIDCP_PORT        WebSocket 监听端口（默认 8787）
 * - DASHSCOPE_API_KEY Qwen API Key
 * - FEISHU_APP_ID / FEISHU_APP_SECRET 飞书自建应用凭证
 * - FEISHU_CHAT_ID    默认推送群 chat_id
 * - PGHOST/PGPORT/... 可覆盖默认 PG 连接（默认 127.0.0.1:5432 aidcp/aidcp）
 *
 * 飞书事件接收走官方 SDK 长连接（WSClient），由本端主动连接飞书，无需公网 IP / 回调端口。
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
  FeishuWsReceiver,
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

  // 飞书事件接收（官方 SDK 长连接，主动连飞书，无需公网 IP / HTTP 端口）
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
  const handler = new DefaultMessageHandler({
    planner,
    llm,
    cache,
    session,
    messenger,
    approvalChatId: process.env.FEISHU_CHAT_ID,
  });
  const server = new EdgeCloudServer({ port, handler });
  await server.start();
  console.log(`[aidcp-cloud] 边-云 WebSocket 服务端已监听 :${port}`);
  const feishuReceiver = new FeishuWsReceiver({ commandRouter, messenger });
  try {
    await feishuReceiver.start();
    console.log('[aidcp-cloud] 飞书事件接收已启动（WSClient 长连接）');
  } catch (err) {
    console.warn('[aidcp-cloud] 飞书长连接启动失败（事件接收不可用）:', (err as Error).message);
  }
}

main().catch((err) => {
  console.error('[aidcp-cloud] 启动失败:', err);
  process.exitCode = 1;
});
