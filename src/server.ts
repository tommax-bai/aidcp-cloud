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

import { readFile, writeFile } from 'node:fs/promises';
import * as lark from '@larksuiteoapi/node-sdk';
import { QwenClient } from './llm/index.js';
import { SimplePlanner } from './planner/index.js';
import { PgAnchorCache, BotChatStore, ConceptStore, LikedNoteStore } from './cache/index.js';
import {
  EdgeCloudServer,
  DefaultMessageHandler,
  CaptchaCoordinator,
  edgeCommandToEnvelope,
  type Envelope,
} from './comm/index.js';


import { RiskController, PgRiskStore } from './risk/index.js';
import { EventBus } from './event-bus/index.js';
import { RoleDispatcher } from './orchestrator/index.js';
import { loadSoul } from './soul/index.js';


import {
  CommandRouter,
  FeishuBotChatEventHandler,
  FeishuMessenger,
  FeishuWsReceiver,
  buildFeishuEventDispatcher,
  resolveDefaultChatId,
  getApprovalSignalPath,
  writeApprovalSignal,
  type CommandActions,
} from './feishu/index.js';
import { CommandSequencer } from './publish-agent/command-sequencer.js';
import { PublishOrchestrator, PublishScheduler } from './publish-agent/index.js';
import { WanxiangClient } from './publish-agent/wanxiang-client.js';
import { AccountStateManager } from './account-state.js';
import { PgAccountStore, type AccountStore } from './account-store.js';
import {
  ContentScoutRole,
  ContentTypeSelectorRole,
  ContentCreatorRole,
  ImagePlannerRole,
  ImageGeneratorRole,
  CoverSelectorRole,
  ContentCleanerRole,
  AiFlavorScorerRole,
  QualityScorerRole,
  ContentAssemblerRole,
  TopicStrategistRole,
  MentionStrategistRole,
  LocationStrategistRole,
  CollectionStrategistRole,
  VisibilityDeciderRole,
  PermissionDeciderRole,
  PublishModeDeciderRole,
  ComplianceDeciderRole,
  MetadataAggregatorRole,
  ApprovalGatekeeperRole,
  PublishExecutorRole,
} from './publish-agent/roles/index.js';
import { PostProcessor } from './publish-agent/post-processor.js';
import { PublishLogStore } from './publish-agent/publish-log-store.js';
import { startPanelApi, parsePanelUsers, PgPanelStore } from './panel/index.js';

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

function parseForbiddenPorts(raw: string | undefined): number[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isInteger(n) && n > 0);
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

  // 点赞笔记存储（liked_notes 表，发帖来源血缘）。init 失败留 undefined（血缘退化、不阻塞启动）。
  let likedNoteStore: LikedNoteStore | undefined;
  try {
    const ls = new LikedNoteStore({
      host: readEnvString('PGHOST'),
      port: readEnvPort('PGPORT'),
      database: readEnvString('PGDATABASE'),
      user: readEnvString('PGUSER'),
      password: readEnvString('PGPASSWORD'),
    });
    await ls.init();
    likedNoteStore = ls;
    console.log('[aidcp-cloud] LikedNoteStore 已就绪（liked_notes 表）');
  } catch (err) {
    console.warn('[aidcp-cloud] LikedNoteStore 初始化失败，来源血缘退化:', (err as Error).message);
  }

  // 概念池存储（concepts 表，跨会话搜索记忆）。init 失败则留 undefined：
  // RoleDispatcher 不注册概念抽取角色、搜索退化为仅 seed_keywords（不崩闭环）。
  let conceptStore: ConceptStore | undefined;
  try {
    const cs = new ConceptStore({
      host: readEnvString('PGHOST'),
      port: readEnvPort('PGPORT'),
      database: readEnvString('PGDATABASE'),
      user: readEnvString('PGUSER'),
      password: readEnvString('PGPASSWORD'),
    });
    await cs.init();
    conceptStore = cs;
    console.log('[aidcp-cloud] ConceptStore 已就绪（concepts 表）');
  } catch (err) {
    console.warn('[aidcp-cloud] ConceptStore 初始化失败，搜索退化为仅 seed_keywords:', (err as Error).message);
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

  // 事件总线
  const eventBus = new EventBus();

  // 账号主表 + 暂停态持久化（accounts 表，seed 一个 default 行）。
  // PG 不可用则退化为纯内存（重启丢暂停态，告警但不阻塞启动）。
  let accountStore: AccountStore | undefined;
  try {
    const store = new PgAccountStore({
      host: readEnvString('PGHOST'),
      port: readEnvPort('PGPORT'),
      database: readEnvString('PGDATABASE'),
      user: readEnvString('PGUSER'),
      password: readEnvString('PGPASSWORD'),
    });
    await store.init();
    accountStore = store;
    console.log('[aidcp-cloud] AccountStore 已就绪（accounts 表，seed default）');
  } catch (err) {
    console.warn(
      '[aidcp-cloud] AccountStore 初始化失败，账号暂停态退化为纯内存（重启丢失）:',
      (err as Error).message,
    );
  }
  // 启动加载持久化暂停态进内存缓存：被暂停账号重启后仍为 paused，不静默复活。
  const accountState = new AccountStateManager(accountStore);
  await accountState.init();

  // RiskController：以 PgRiskStore 持久化账号风控态与滑动窗计数（跨重启回放）；PG 不可用则回退内存态。
  let riskController: RiskController;
  try {
    // 用与锚点缓存相同的 PG* 连接口径，避免 PgRiskStore 回退到 AIDCP_PG_*/硬编码默认而连错库。
    riskController = await RiskController.create({
      store: new PgRiskStore({
        host: readEnvString('PGHOST'),
        port: readEnvPort('PGPORT'),
        database: readEnvString('PGDATABASE'),
        user: readEnvString('PGUSER'),
        password: readEnvString('PGPASSWORD'),
      }),
    });
    console.log('[aidcp-cloud] RiskController 已就绪（PgRiskStore 持久化）');
  } catch (err) {
    console.warn('[aidcp-cloud] RiskController 持久化初始化失败，回退内存态:', (err as Error).message);
    riskController = new RiskController();
  }

  // RiskController 订阅跨模块事件：真实互动发生时按账号计数（record 内部再过 canDo）。
  eventBus.on('interaction.occurred', (evt) => {
    riskController.record(evt.action).catch((err) => {
      console.warn('[aidcp-cloud] RiskController record error:', err);
    });
    // A 阶段4 来源血缘：真实点赞落 liked_notes（noteId 才落；详情缺则空字段如实，不编造）。
    if (evt.action === 'like' && evt.noteId && likedNoteStore) {
      likedNoteStore.recordLike(evt.noteId).catch((err) => {
        console.warn('[aidcp-cloud] LikedNoteStore recordLike error:', err);
      });
    }
  });
  console.log('[aidcp-cloud] 事件订阅已建立（RiskController）');

  // A 阶段4 发帖触发器（下方实例化；actions.publish 运行时引用，前向安全）。
  let publishScheduler: PublishScheduler | undefined;

  // 飞书事件接收（官方 SDK 长连接，主动连飞书，无需公网 IP / HTTP 端口）
  // MVP：账号启停/查询动作先打桩（后续接云端调度器 → plan.request）
  const actions: CommandActions = {
    status: (accountId) => {
      const state = accountState.getStatus(accountId);
      const emoji = state.status === 'paused' ? '⏸️' : '🟢';
      const statusText = state.status === 'paused' ? 'paused' : 'active';
      const extra = state.pausedAt ? `\n暂停时间：${new Date(state.pausedAt).toLocaleString()}` : '';
      return `账号 \`${accountId}\` 当前状态：${statusText} ${emoji}${extra}`;
    },
    pause: async (accountId) => {
      await accountState.pause(accountId);
      console.log(`[feishu] 已暂停账号：${accountId}`);
    },
    resume: async (accountId) => {
      await accountState.resume(accountId);
      // 验证码人工恢复快路：解除该账号名下被暂停的 edge（server 在下方初始化，命令运行时才触发，引用安全）。
      const resumedEdges = server.resumeEdgesForAccount(accountId);
      console.log(`[feishu] 已恢复账号：${accountId}（恢复 edge 数=${resumedEdges}）`);
    },
    bindChat: (record) => botChatStore.setDefault(record),
    // 手动 /publish：越过风控 canDo（人工授权），发布前飞书人审仍铁定生效（AC-PUB）。
    publish: async () => {
      if (!publishScheduler) return '发帖触发器未就绪（PG/概念池不可用）';
      const o = await publishScheduler.triggerManual();
      return `已触发（${o.reason}）→ 编排状态 ${'status' in o ? o.status : '-'}`;
    },
  };
  const commandRouter = new CommandRouter(actions);
  const messenger = new FeishuMessenger();
  // 验证码事件协调器：消费 risk.captcha_detected/cleared（迁状态 + 按 edge 暂停 + 去重发飞书）。
  const captcha = new CaptchaCoordinator({
    riskController,
    messenger,
    resolveChatId: () =>
      resolveDefaultChatId({ botChatStore, fallbackChatId: process.env.FEISHU_CHAT_ID, logger: console }),
  });
  // A 阶段1 发布指令编排器：逐条下发 publish.command、按 recordId+seq 关联 publish.command.result。
  // pusher 经 edgeServer 转发（server 在下方构造，运行时已就绪——前向引用安全，仿 sendCommand）。
  let edgeServer: EdgeCloudServer | undefined;
  const commandSequencer = new CommandSequencer({
    pusher: { pushToEdges: (env, edgeId) => (edgeServer ? edgeServer.pushToEdges(env as Envelope, edgeId) : 0) },
    logger: console,
  });
  // AC-PUB 第1道：按 requestId 读审批信号文件，approved===true 才放行（缺失/解析失败 → 未授权）。
  const isPublishApproved = async (requestId: string): Promise<boolean> => {
    try {
      const raw = await readFile(getApprovalSignalPath(requestId), 'utf8');
      const parsed = JSON.parse(raw) as { approved?: boolean };
      return parsed?.approved === true;
    } catch {
      return false;
    }
  };

  const handler = new DefaultMessageHandler({
    planner,
    llm,
    cache,
    messenger,
    botChatStore,
    approvalChatId: process.env.FEISHU_CHAT_ID,
    riskController,
    eventBus,
    accountState,
    captcha,
    commandSequencer,
  });
  const server = new EdgeCloudServer({ port, handler });
  edgeServer = server;
  await server.start();
  console.log(`[aidcp-cloud] 边-云 WebSocket 服务端已监听 :${port}`);

  // ── RoleDispatcher：事件驱动决策链路 ─────────────────────────────────
  const soul = loadSoul();
  const roleDispatcher = new RoleDispatcher({
    soul,
    llm,
    eventBus,
    // 指令级节奏：把当前风控状态喂给决策点，驱动 dwellMs/thinkMs 的 tempo
    getRiskStatus: () => riskController.getState().status,
    // 互动前风控闸：被拒则诚实跳过（不下发、不扣 budget）。验证码→restricted 后互动被此闸真正拦住。
    canInteract: (action) => riskController.canDo(action),
    // 概念池：跨会话搜索记忆 + 从浏览学新关键词（undefined 时退化为仅 seed_keywords）。
    conceptStore,
    // 硬暂停闸（验证码/人工接管）：通知准入据此放弃巡视——硬暂停期连帧都不发。
    isHardPaused: (edgeId) => (edgeId ? server.isEdgePaused(edgeId) : false),
    // 通知巡视发飞书（仅"评论和@"）：复用 messenger + 默认群解析；无群则记错不吞。
    notifyComments: async (items) => {
      const chatId = await resolveDefaultChatId({
        botChatStore,
        fallbackChatId: process.env.FEISHU_CHAT_ID,
        logger: console,
      });
      if (!chatId) {
        console.error('[notification] 无可用飞书群，评论/@ 通知未发出');
        return;
      }
      const lines = items.map(
        (it) =>
          `• ${it.fromUser || '某用户'}（${it.kind === 'mention' ? '@你' : '评论'}）：${it.content}` +
          (it.noteTitle ? ` · 《${it.noteTitle}》` : ''),
      );
      await messenger.sendText(chatId, `📬 小红书新消息（${items.length}）\n${lines.join('\n')}`);
    },
    sendCommand: (command) => {
      const envelope = edgeCommandToEnvelope(command);
      const sent = server.pushToEdges(envelope);
      console.log(`[RoleDispatcher] sendCommand action=${command.action} sent=${sent}`);
    },
  });
  roleDispatcher.setup();
  roleDispatcher.startSession();
  console.log('[aidcp-cloud] RoleDispatcher 已启动，决策链路就绪');

  // 注册发布编排器的生产段角色（A 阶段2 细拆：6→11，下游 Gatekeeper/Executor 不变）。
  // 注册顺序无关正确性（黑板靠键就绪触发），按拓扑排列便于阅读。
  publishOrchestrator.registerRole(new ContentScoutRole({ llmClient: llm }));
  publishOrchestrator.registerRole(new ContentTypeSelectorRole());
  publishOrchestrator.registerRole(new ContentCreatorRole({ llmClient: llm }));
  // 配图：决策（ImagePlanner）↔ 执行（ImageGenerator）↔ 封面（CoverSelector）
  publishOrchestrator.registerRole(new ImagePlannerRole({ llmClient: llm }));
  publishOrchestrator.registerRole(new ImageGeneratorRole({
    imageProvider: wanxiangClient,
    enableImageGeneration: !!readEnvString('WANXIANG_API_KEY'),
  }));
  publishOrchestrator.registerRole(new CoverSelectorRole());
  // 后处理：清洗（ContentCleaner）→ AI味分（AiFlavorScorer）/ 质量分（QualityScorer）
  publishOrchestrator.registerRole(new ContentCleanerRole({ postProcessor }));
  publishOrchestrator.registerRole(new AiFlavorScorerRole());
  publishOrchestrator.registerRole(new QualityScorerRole({ llmClient: llm }));
  // 汇合：瘦身 ContentAssembler（纯组装，waitAll 五键）
  publishOrchestrator.registerRole(new ContentAssemblerRole());
  // 阶段3 元数据 + 合规决策（并行于发布链，规则式确定性；产出 publishMetadata，本阶段不应用到边缘）。
  publishOrchestrator.registerRole(new TopicStrategistRole());
  publishOrchestrator.registerRole(new MentionStrategistRole());
  publishOrchestrator.registerRole(new LocationStrategistRole());
  publishOrchestrator.registerRole(new CollectionStrategistRole());
  publishOrchestrator.registerRole(new VisibilityDeciderRole());
  publishOrchestrator.registerRole(new PermissionDeciderRole());
  publishOrchestrator.registerRole(new PublishModeDeciderRole());
  publishOrchestrator.registerRole(new ComplianceDeciderRole());
  publishOrchestrator.registerRole(new MetadataAggregatorRole());
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
      async updateStatus(id, status) {
        await publishLogStore.updateStatus(id, status as 'draft' | 'published' | 'failed' | 'needs_review');
      },
      async updatePostId(id, postId) {
        await publishLogStore.updatePostId(id, postId);
      },
    },
    pusher: server,
    messenger,
    botChatStore,
    // A 阶段1：注入 sequencer + 审批读取 → auto_publish 走指令驱动 + AC-PUB 闸 + 结果回写。
    sequencer: commandSequencer,
    isApproved: isPublishApproved,
  }));
  console.log(`[aidcp-cloud] PublishOrchestrator 已就绪，角色: ${publishOrchestrator.getRoles().join(', ')}`);

  // A 阶段4 发帖触发器：复用已持久化的 ConceptStore/LikedNoteStore/PublishLogStore/RiskController 单例。
  // 缺概念池/点赞库（PG 不可用）则不建——manual /publish 回"未就绪"，不静默假发布。
  if (conceptStore && likedNoteStore) {
    publishScheduler = new PublishScheduler({
      conceptStore,
      likedStore: likedNoteStore,
      publishLog: publishLogStore,
      risk: riskController,
      orchestrator: publishOrchestrator,
      soul,
      conceptThreshold: Number(process.env.AIDCP_PUBLISH_CONCEPT_THRESHOLD ?? 20),
      minHoursBetween: Number(process.env.AIDCP_PUBLISH_MIN_HOURS ?? 24),
      logger: console,
    });
    console.log('[aidcp-cloud] PublishScheduler 已就绪（手动 /publish 即用）');
    // 自动扳机轮询默认关闭（须显式 AIDCP_PUBLISH_AUTO=true 才开），避免未到部署/edge 就绪即自动发。
    if (readEnvString('AIDCP_PUBLISH_AUTO') === 'true') {
      const everyMin = Number(process.env.AIDCP_PUBLISH_AUTO_INTERVAL_MIN ?? 30);
      setInterval(() => {
        publishScheduler!.checkAndMaybeTrigger().then(
          (o) => o.result !== 'skipped' && console.log(`[aidcp-cloud] PublishScheduler auto: ${o.result} (${o.reason})`),
          (err) => console.warn('[aidcp-cloud] PublishScheduler auto error:', err),
        );
      }, everyMin * 60_000);
      console.log(`[aidcp-cloud] PublishScheduler 自动扳机已开启（每 ${everyMin} 分钟）`);
    }
  } else {
    console.warn('[aidcp-cloud] PublishScheduler 未建（ConceptStore/LikedNoteStore 不可用），发帖触发不可用');
  }
  // 旧 TODO(temp) /debug/publish 调试口已删除（A 阶段4）：发帖只经 PublishScheduler 三扳机 + 发布前人审。
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

  // ── 面板 API 层（管理后台后端，进程内、独立端口、JWT）──────────────────────
  // 未设置 AIDCP_PANEL_PORT 则禁用（默认不开新端口）；启动失败非致命，绝不连累边-云闭环。
  const panelPort = readEnvPort('AIDCP_PANEL_PORT');
  if (panelPort) {
    try {
      const panel = await startPanelApi(
        {
          riskController,
          publishLogStore,
          conceptStore,
          botChatStore,
          eventBus,
          edgeServer: server,
          panelStore: new PgPanelStore({
            host: readEnvString('PGHOST'),
            port: readEnvPort('PGPORT'),
            database: readEnvString('PGDATABASE'),
            user: readEnvString('PGUSER'),
            password: readEnvString('PGPASSWORD'),
          }),
          publishOrchestrator,
          writeApprovalSignal: (requestId, approved, payload) =>
            writeApprovalSignal({ writeFile, readFile }, requestId, approved, payload),
          commandActions: {
            pause: async (accountId) => {
              await accountState.pause(accountId);
              return { accountId, status: 'paused' as const };
            },
            resume: async (accountId) => {
              await accountState.resume(accountId);
              const resumedEdges = server.resumeEdgesForAccount(accountId);
              return { accountId, status: 'active' as const, resumedEdges };
            },
          },
        },
        {
          port: panelPort,
          jwtSecret: readEnvString('AIDCP_PANEL_JWT_SECRET') ?? '',
          users: parsePanelUsers(readEnvString('AIDCP_PANEL_USERS')),
          jwtTtlSeconds: readEnvPort('AIDCP_PANEL_JWT_TTL_SECONDS') ?? 3600,
          // 自检拒绝绑定：边-云 8787 / PG 5432 / 调试 8788 / 部署时经 env 补充的 isales 等端口。
          forbiddenPorts: [port, debugPort, 5432, ...parseForbiddenPorts(readEnvString('AIDCP_PANEL_FORBIDDEN_PORTS'))],
          logger: console,
        },
      );
      if (panel.started) {
        console.log(`[aidcp-cloud] 面板 API 已启动（127.0.0.1:${panel.port}，经 Nginx 反代 /api）`);
      } else {
        console.warn(
          `[aidcp-cloud] 面板 API 未启动（${panel.reason}${panel.detail ? ':' + panel.detail : ''}）——边-云闭环与飞书不受影响`,
        );
      }
    } catch (err) {
      console.warn('[aidcp-cloud] 面板 API 启动异常（非致命）:', (err as Error).message);
    }
  } else {
    console.log('[aidcp-cloud] 面板 API 已禁用（未设置 AIDCP_PANEL_PORT）');
  }
}

main().catch((err) => {
  console.error('[aidcp-cloud] 启动失败:', err);
  process.exitCode = 1;
});
