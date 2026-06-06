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

import http from 'node:http';
import { randomUUID } from 'node:crypto';
import * as lark from '@larksuiteoapi/node-sdk';
import { QwenClient } from './llm/index.js';
import { SimplePlanner } from './planner/index.js';
import { PgAnchorCache, BotChatStore } from './cache/index.js';
import {
  EdgeCloudServer,
  DefaultMessageHandler,
  makeEnvelope,
  type PublishRequestPayload,
} from './comm/index.js';
import { loadSoul } from './soul/index.js';
import { SessionOrchestrator } from './orchestrator/index.js';
import { RiskController } from './risk/index.js';
import { EventBus } from './event-bus/index.js';
import { Blackboard, Arbiter } from './blackboard/index.js';
import {
  SessionMonitor,
  FeedScanner,
  ContentCurator,
  InteractionAppraiser,
  CommentReviewer,
} from './agents/index.js';
import {
  CommandRouter,
  FeishuBotChatEventHandler,
  FeishuMessenger,
  FeishuWsReceiver,
  buildFeishuEventDispatcher,
  type CommandActions,
} from './feishu/index.js';
import { PublishOrchestrator } from './publish-agent/index.js';
import { WanxiangClient } from './publish-agent/wanxiang-client.js';
import {
  ContentScoutRole,
  ContentCreatorRole,
  ImageDirectorRole,
  ContentAssemblerRole,
  ApprovalGatekeeperRole,
  PublishExecutorRole,
} from './publish-agent/roles/index.js';
import { PostProcessor } from './publish/post-processor.js';
import { PublishLogStore } from './publish/publisher.js';

function readEnvString(name: string): string | undefined {
  const value = process.env[name];
  return value && value.trim() ? value : undefined;
}

function readEnvPort(name: string): number | undefined {
  const value = readEnvString(name);
  if (!value) return undefined;
  const port = Number(value);
  return Number.isInteger(port) && port > 0 ? port : undefined;
}

async function main(): Promise<void> {
  const port = Number(process.env.AIDCP_PORT ?? 8787);
  const debugPort = Number(process.env.AIDCP_DEBUG_PORT ?? 8788);

  const llm = new QwenClient();
  const planner = new SimplePlanner({ llm });
  const cache = new PgAnchorCache({
    connectionString: readEnvString('DATABASE_URL'),
    host: readEnvString('PGHOST'),
    port: readEnvPort('PGPORT'),
    database: readEnvString('PGDATABASE'),
    user: readEnvString('PGUSER'),
    password: readEnvString('PGPASSWORD'),
  });
  const soul = loadSoul();
  const botChatStore = new BotChatStore();
  const botChatEventHandler = new FeishuBotChatEventHandler(botChatStore);

  // 建表（幂等）；PG 不可用时打印告警但不阻塞启动协议处理
  try {
    await cache.init();
    console.log('[aidcp-cloud] PG 锚点缓存已就绪');
  } catch (err) {
    console.warn('[aidcp-cloud] PG 初始化失败（缓存相关消息将报错）:', (err as Error).message);
  }

  // 发布日志存储（publish_log 表）
  const publishLogStore = new PublishLogStore({
    host: readEnvString('PGHOST'),
    port: readEnvPort('PGPORT'),
    database: readEnvString('PGDATABASE'),
    user: readEnvString('PGUSER'),
    password: readEnvString('PGPASSWORD'),
  });
  try {
    await publishLogStore.init();
    console.log('[aidcp-cloud] PublishLogStore 已就绪');
  } catch (err) {
    console.warn('[aidcp-cloud] PublishLogStore 初始化失败:', (err as Error).message);
  }

  // 去 AI 味后处理器
  const postProcessor = new PostProcessor({
    rewrite: async (content, flagged) => {
      const prompt = `请重写以下内容，去除AI味过重的表达（${flagged.join('、')}），保持原意和自然口吾：\n\n${content}`;
      return llm.complete(prompt);
    },
  });

  // 通义万相客户端（图片生成）
  const wanxiangClient = new WanxiangClient({
    apiKey: readEnvString('WANXIANG_API_KEY'),
  });

  // 发布编排器（PublishOrchestrator）
  const publishOrchestrator = new PublishOrchestrator({
    logger: console,
  });

  // 事件总线 + 黑板 + 仲裁器
  const eventBus = new EventBus();
  const blackboard = new Blackboard({ eventBus });
  const arbiter = new Arbiter();

  // 多 Agent 实例化
  const agents = [
    new SessionMonitor({ soul }),
    new FeedScanner({ soul, llm }),
    new ContentCurator({ soul, llm }),
    new InteractionAppraiser({ soul, llm }),
    new CommentReviewer({ soul, llm }),
  ];

  // 会话编排器（事件驱动）
  const noopSink = { send: () => {} }; // 决策通过 handler 回包，不需要额外 push
  const session = new SessionOrchestrator({
    soul,
    eventBus,
    blackboard,
    agents,
    arbiter,
    sink: noopSink,
  });
  session.start();
  console.log(`[aidcp-cloud] Soul 会话编排器已启动（人设: ${soul.identity.name}）`);

  const riskController = new RiskController();

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
    bindChat: (record) => botChatStore.setDefault(record),
  };
  const commandRouter = new CommandRouter(actions);
  const messenger = new FeishuMessenger();
  const handler = new DefaultMessageHandler({
    planner,
    llm,
    cache,
    messenger,
    botChatStore,
    approvalChatId: process.env.FEISHU_CHAT_ID,
    riskController,
    eventBus,
  });
  const server = new EdgeCloudServer({ port, handler });
  await server.start();
  console.log(`[aidcp-cloud] 边-云 WebSocket 服务端已监听 :${port}`);

  // 注册发布编排器的 6 个角色（需在 server 启动后，因为 PublishExecutorRole 依赖 server 作为 pusher）
  publishOrchestrator.registerRole(new ContentScoutRole({ llmClient: llm }));
  publishOrchestrator.registerRole(new ContentCreatorRole({ llmClient: llm }));
  publishOrchestrator.registerRole(new ImageDirectorRole({
    llmClient: llm,
    imageProvider: wanxiangClient,
    enableImageGeneration: !!readEnvString('WANXIANG_API_KEY'),
  }));
  publishOrchestrator.registerRole(new ContentAssemblerRole({
    llmClient: llm,
    postProcessor,
  }));
  publishOrchestrator.registerRole(new ApprovalGatekeeperRole({ llmClient: llm }));
  publishOrchestrator.registerRole(new PublishExecutorRole({
    store: {
      async insert(record) {
        return publishLogStore.insert({
          title: record.title,
          content: record.content,
          sourceConcepts: record.tags,
          sourceLikedIds: [],
          status: record.status as 'draft' | 'published' | 'failed' | 'needs_review',
        });
      },
    },
    pusher: server,
    messenger,
    botChatStore,
  }));
  console.log(`[aidcp-cloud] PublishOrchestrator 已就绪，角色: ${publishOrchestrator.getRoles().join(', ')}`);
  const debugPayload: PublishRequestPayload = {
    title: '【测试请忽略】AIDCP 主动审批联调',
    content: '自动化测试请忽略',
    tags: ['测试'],
  };
  const debugServer = http.createServer((req, res) => {
    if (req.method !== 'POST' || req.url !== '/debug/publish') {
      res.statusCode = 404;
      res.end('not_found');
      return;
    }
    const env = makeEnvelope('publish.request', `temp-publish-${randomUUID()}`, Date.now(), debugPayload);
    const sent = server.pushToEdges(env);
    console.log(
      `[aidcp-cloud] TODO(temp) debug publish trigger sent=${sent} title=${debugPayload.title}`,
    );
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ ok: sent > 0, sent, payload: debugPayload }));
  });
  debugServer.listen(debugPort, '127.0.0.1', () => {
    console.log(`[aidcp-cloud] TODO(temp) debug publish trigger listening on 127.0.0.1:${debugPort}`);
  });
  const feishuReceiver = new FeishuWsReceiver({ commandRouter, messenger });
  try {
    const wsClient = new lark.WSClient({
      appId: process.env.FEISHU_APP_ID ?? '',
      appSecret: process.env.FEISHU_APP_SECRET ?? '',
      onReady: () => console.log('[aidcp-cloud] 飞书长连接已建立（WSClient onReady）'),
      onError: (err) => console.error('[aidcp-cloud] 飞书长连接错误:', err.message),
      onReconnecting: () => console.warn('[aidcp-cloud] 飞书长连接重连中…'),
      onReconnected: () => console.log('[aidcp-cloud] 飞书长连接已重连'),
    });
    await wsClient.start({
      eventDispatcher: buildFeishuEventDispatcher(feishuReceiver, botChatEventHandler, console),
    });
    console.log('[aidcp-cloud] 飞书事件接收已启动（WSClient 长连接）');
  } catch (err) {
    console.warn('[aidcp-cloud] 飞书长连接启动失败（事件接收不可用）:', (err as Error).message);
  }
}

main().catch((err) => {
  console.error('[aidcp-cloud] 启动失败:', err);
  process.exitCode = 1;
});
