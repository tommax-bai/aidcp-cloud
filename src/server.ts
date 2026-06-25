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

import { readFile, writeFile, unlink } from 'node:fs/promises';
import * as lark from '@larksuiteoapi/node-sdk';
import { QwenClient, DEFAULT_BASE_URL as QWEN_BASE_URL, type ChatLlmClient } from './llm/index.js';
import { TokenUsageStore } from './metrics/token-usage-store.js';
import { SimplePlanner } from './planner/index.js';
import { PgAnchorCache, BotChatStore, ConceptStore, LikedNoteStore, ValuableCommentStore, NotificationContactStore } from './cache/index.js';
import {
  EdgeCloudServer,
  DefaultMessageHandler,
  CaptchaCoordinator,
  edgeCommandToEnvelope,
  type Envelope,
} from './comm/index.js';


import { RiskController, RiskControllerRegistry, PgRiskStore, InteractionGuardRegistry, ActionCooldownGate } from './risk/index.js';
import { EventBus } from './event-bus/index.js';
import { RoleDispatcher } from './orchestrator/index.js';
import { ConnectionRuntimeRegistry, type DispatcherBuildContext } from './orchestrator/connection-runtime.js';
import type { CommentApprovalPort } from './agents/comment-approval-gate.js';
import { buildCommentApprovalCard } from './feishu/comment-approval-card.js';
import { loadSoul, type Soul } from './soul/index.js';


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
  TitleCreatorRole,
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
import { PgAlertStore } from './alerts/index.js';
import { ModelConfigStore } from './config/model-config-store.js';
import { RoleConfigStore } from './config/role-config-store.js';
import { createRoleConfigPanel } from './config/role-config-facade.js';
import { CategoryConfigStore } from './config/category-config-store.js';
import { createCategoryConfigPanel } from './config/category-config-facade.js';
import { categoryOf } from './config/role-catalog.js';
// 账号人设（change account-persona-config，stream F）：按账号可配 + 热加载，回落打包 soul.yaml 不 brick。
import { PersonaStore, createPersonaResolver } from './config/persona-store.js';
import { createPersonaPanel } from './config/persona-facade.js';
// 安全限额（change safety-quota-config，stream D）：三档×动作×三窗口限额数字后台可改+热加载，缺值回落写死默认。
import { QuotaConfigStore } from './config/quota-config-store.js';
import { createQuotaConfigPanel } from './config/quota-config-facade.js';
import { createRolePromptProvider } from './config/role-prompt-preview.js';
import { CredentialStore } from './config/credential-store.js';
import type { ModelConfigView } from './panel/types.js';

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

  // 模型配置 + 加密凭据（change console-model-provider-config）。
  // 先于 LLM 客户端构造：模型名经 getCached() 运行时解析（热加载）；DashScope 密钥库内优先、回退 env。
  const modelConfigStore = new ModelConfigStore({
    host: readEnvString('PGHOST'),
    port: readEnvPort('PGPORT'),
    database: readEnvString('PGDATABASE'),
    user: readEnvString('PGUSER'),
    password: readEnvString('PGPASSWORD'),
  });
  const credentialStore = new CredentialStore({
    host: readEnvString('PGHOST'),
    port: readEnvPort('PGPORT'),
    database: readEnvString('PGDATABASE'),
    user: readEnvString('PGUSER'),
    password: readEnvString('PGPASSWORD'),
  });
  // 角色级模型/温度覆盖（change console-role-model-config）。缺/空/无效一律回落全局，绝不 brick。
  const roleConfigStore = new RoleConfigStore({
    host: readEnvString('PGHOST'),
    port: readEnvPort('PGPORT'),
    database: readEnvString('PGDATABASE'),
    user: readEnvString('PGUSER'),
    password: readEnvString('PGPASSWORD'),
  });
  // 分类级模型默认（change role-model-category-config，item 5/6）。缺/空/异常一律返「无覆盖」，绝不 brick。
  const categoryConfigStore = new CategoryConfigStore({
    host: readEnvString('PGHOST'),
    port: readEnvPort('PGPORT'),
    database: readEnvString('PGDATABASE'),
    user: readEnvString('PGUSER'),
    password: readEnvString('PGPASSWORD'),
  });
  // 安全限额（change safety-quota-config，stream D）。缺行/非法值一律回落 deriveWindowQuotas 写死默认，绝不 brick。
  const quotaConfigStore = new QuotaConfigStore({
    host: readEnvString('PGHOST'),
    port: readEnvPort('PGPORT'),
    database: readEnvString('PGDATABASE'),
    user: readEnvString('PGUSER'),
    password: readEnvString('PGPASSWORD'),
  });
  try {
    await modelConfigStore.init();
    await credentialStore.init();
    await roleConfigStore.init();
    await categoryConfigStore.init();
    await quotaConfigStore.init();
    console.log('[aidcp-cloud] 模型配置 + 凭据 + 角色配置 + 分类默认 + 安全限额存储已就绪（model_config / provider_credentials / role_config / category_config / quota_config）');
  } catch (err) {
    console.warn('[aidcp-cloud] 模型/凭据/角色/分类/限额配置存储初始化失败（回退代码默认模型 + env 密钥；限额回退派生写死默认）:', (err as Error).message);
  }
  // 启动期解密 DashScope 密钥（库内优先、回退 env）；明文仅用于构造客户端，绝不日志化、绝不回前端。
  const dashscopeApiKey =
    (await credentialStore.getSecretForRuntime('dashscope', 'dashscope_api_key').catch(() => null)) ??
    readEnvString('DASHSCOPE_API_KEY');

  // 按角色解析模型（change role-model-category-config）：四层回落
  //   per-role 覆盖 → 分类默认 → 全局 textModel（「默认模型」）→ 代码默认（store 缺省）。
  // 逐层缺/空向下回落，任一层不可达都不 brick。role 缺省（planner/select/探活）→ 直接走全局，零回归。
  // 账号维度（item 9）：分类存储读路径恒 account_id IS NULL，本期不接 accountId。
  const resolveModelForRole = (role?: string): string => {
    const roleOverride = role ? roleConfigStore.getForRole(role).model : null;
    if (roleOverride?.trim()) return roleOverride.trim(); // 2. per-role 覆盖
    const catId = role ? categoryOf(role) : undefined;
    const catDefault = catId ? categoryConfigStore.getForCategory(catId).model : null;
    if (catDefault?.trim()) return catDefault.trim(); // 3. 分类默认
    return modelConfigStore.getCached().textModel; // 4. 全局默认（store 缺省回 5. 代码默认）
  };
  // 温度本期不引入分类层（温度只对少数生成/改写角色开放，按角色配已足够，YAGNI）。保持两层。
  const resolveTempForRole = (role?: string): number | undefined => {
    const t = role ? roleConfigStore.getForRole(role).temperature : null;
    return t ?? undefined;
  };
  // token 用量记账（change llm-token-usage-stats）：出口 onCall 钩子只做纯内存累加，
  // 定时 flush 到 llm_token_usage 预聚合表（专用池隔离热路径）。须早于接受 LLM 调用/探活建好。
  const tokenUsageStore = new TokenUsageStore();
  try {
    await tokenUsageStore.init();
    console.log('[aidcp-cloud] token 用量记账已就绪（llm_token_usage，按账号/角色/模型/10分钟桶预聚合）');
  } catch (err) {
    console.warn('[aidcp-cloud] token 用量记账初始化失败（用量将不落库，绝不影响 LLM 调用）:', (err as Error).message);
  }
  // 退出前 flush 末窗（有界 3s，防 PG 不可达时 close 挂住退出）。
  const flushTokenUsageOnExit = (sig: string): void => {
    console.log(`[aidcp-cloud] 收到 ${sig}，flush token 用量后退出`);
    void Promise.race([
      tokenUsageStore.close().catch(() => {}),
      new Promise((resolve) => setTimeout(resolve, 3000)),
    ]).finally(() => process.exit(0));
  };
  process.once('SIGTERM', () => flushTokenUsageOnExit('SIGTERM'));
  process.once('SIGINT', () => flushTokenUsageOnExit('SIGINT'));

  const llm = new QwenClient({
    apiKey: dashscopeApiKey,
    getModel: resolveModelForRole,
    getTemperature: resolveTempForRole,
    // 保留原 console.log（加 tokens 维度）；记账 add() 受 try/catch 双保险，绝不抛进/拖垮 LLM 调用路径。
    onCall: (info) => {
      console.log(
        `[llm] role=${info.role ?? '-'} model=${info.model} ms=${info.ms} ok=${info.ok} tokens=${info.totalTokens ?? 0}`,
      );
      try {
        tokenUsageStore.add(info);
      } catch {
        /* metrics never breaks llm */
      }
    },
  });
  // 把共享文本客户端按角色绑定成 thin wrapper（发布侧用；角色内部代码零改动）。
  const roleLlm = (roleId: string): ChatLlmClient => ({
    complete: (prompt, opts) => llm.complete(prompt, { ...opts, role: opts?.role ?? roleId }),
    chat: (messages, opts) => llm.chat(messages, { ...opts, role: opts?.role ?? roleId }),
  });
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

  // 优质评论语料库（valuable_comments 表，comment-like-on-detail B）。仅特性开启时建表/接线；
  // init 失败留 undefined（语料库退化：不归档、撰写不注入参考，不崩闭环）。
  let valuableCommentStore: ValuableCommentStore | undefined;
  if (process.env.AIDCP_COMMENT_LIKE === 'true') {
    try {
      const vs = new ValuableCommentStore({
        host: readEnvString('PGHOST'),
        port: readEnvPort('PGPORT'),
        database: readEnvString('PGDATABASE'),
        user: readEnvString('PGUSER'),
        password: readEnvString('PGPASSWORD'),
      });
      await vs.init();
      valuableCommentStore = vs;
      console.log('[aidcp-cloud] ValuableCommentStore 已就绪（valuable_comments 表）');
    } catch (err) {
      console.warn('[aidcp-cloud] ValuableCommentStore 初始化失败，评论语料库退化:', (err as Error).message);
    }
  }

  // 通知联系人名册（notification-contact-registry，迁移 0016）：记录给本账号发过通知的人（评论/@/点赞/收藏/关注）。
  // 无条件接线（核心特性）；init 失败留 undefined（记录与面板退化，绝不崩闭环）。
  let notificationContactStore: NotificationContactStore | undefined;
  try {
    const ncs = new NotificationContactStore({
      host: readEnvString('PGHOST'),
      port: readEnvPort('PGPORT'),
      database: readEnvString('PGDATABASE'),
      user: readEnvString('PGUSER'),
      password: readEnvString('PGPASSWORD'),
    });
    await ncs.init();
    notificationContactStore = ncs;
    console.log('[aidcp-cloud] NotificationContactStore 已就绪（notification_event / notification_contact_meta 表）');
  } catch (err) {
    console.warn('[aidcp-cloud] NotificationContactStore 初始化失败，通知联系人记录退化:', (err as Error).message);
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

  // 通义万相客户端（图片生成）。万相文生图与 Qwen 同属阿里云百炼、同一 DashScope key——
  // 未单设 WANXIANG_API_KEY 时回退 DASHSCOPE_API_KEY（已实测该 key 可提交万相 wanx-v1 任务并产出 OSS 图）。
  const wanxiangClient = new WanxiangClient({
    apiKey: readEnvString('WANXIANG_API_KEY') ?? dashscopeApiKey,
    getModel: () => modelConfigStore.getCached().imageModel,
    // 慢图容忍：轮询次数 env 可调（默认 34×5s=170s；须 < ImageGenerator 角色闸 200s）。change publish-image-required-or-fail。
    maxPollAttempts: Number(process.env.AIDCP_WANXIANG_MAX_POLL ?? 34),
  });

  // 发布编排器（PublishOrchestrator）。超时须容纳 executor 的人审等待窗口（默认 240s）+ 指令序列，故放大到 360s。
  const publishOrchestrator = new PublishOrchestrator({
    logger: console,
    pipelineTimeoutMs: Number(process.env.AIDCP_PUBLISH_PIPELINE_TIMEOUT_MS ?? 1_080_000),
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

  // ── 账号人设（change account-persona-config，stream F，迁移 0011）─────────────
  // 须在 accounts 表建好之后（persona_config FK 到 accounts）。打包 soul.yaml 为永不 brick 的最终回落。
  // PG 不可用 / init 失败 → 全程回落打包默认，不影响浏览 / 发布。
  const fallbackSoul = loadSoul();
  const personaStore = new PersonaStore({
    host: readEnvString('PGHOST'),
    port: readEnvPort('PGPORT'),
    database: readEnvString('PGDATABASE'),
    user: readEnvString('PGUSER'),
    password: readEnvString('PGPASSWORD'),
  });
  try {
    await personaStore.init();
    console.log('[aidcp-cloud] 账号人设存储已就绪（persona_config，按账号热加载）');
  } catch (err) {
    console.warn(
      '[aidcp-cloud] 人设存储初始化失败（全程回落打包 soul.yaml，不 brick）:',
      (err as Error).message,
    );
  }
  // 按账号解析人设的取值口（派发 / 发布热路径用；永不抛、缺则回落打包默认）。
  const resolvePersona = createPersonaResolver({ store: personaStore, fallbackSoul, logger: console });
  const getSoul = (accountId?: string): Soul => resolvePersona(accountId);
  // 人设面板外观（后台按账号编辑 + soul 校验 + 写非乐观回真态）。
  const personaPanel = createPersonaPanel({ store: personaStore });

  // RiskController 注册表（V1 task 9.1）：每账号一个 controller、单写 PER ACCOUNT、共享 PgRiskStore。
  // 现役路径用其 default controller（单一来源，避免双 controller 写同一 risk_state）；PG 不可用则现役回退内存态。
  // PgRiskStore 单例：既喂 registry（按账号风控单写），又作 InteractionStore 接线孤儿
  // risk_interactions 去重表（V1 task 9.2，按笔记互动历史）。
  const riskStore = new PgRiskStore({
    host: readEnvString('PGHOST'),
    port: readEnvPort('PGPORT'),
    database: readEnvString('PGDATABASE'),
    user: readEnvString('PGUSER'),
    password: readEnvString('PGPASSWORD'),
  });
  // quotaConfigStore 作 QuotaProvider 注入：每账号 controller 的 effectiveQuotas 热加载读限额数字
  // （change safety-quota-config）；init 失败时其镜像为空 → 退化派生写死默认，绝不 brick。
  const riskRegistry = new RiskControllerRegistry(riskStore, undefined, quotaConfigStore);
  let riskController: RiskController;
  try {
    riskController = await riskRegistry.getController('default');
    console.log('[aidcp-cloud] RiskController 已就绪（registry default，PgRiskStore 持久化）');
  } catch (err) {
    console.warn('[aidcp-cloud] RiskController 持久化初始化失败，回退内存态:', (err as Error).message);
    riskController = new RiskController();
  }

  // RiskController 订阅跨模块事件：真实互动发生时按账号计数（record 内部再过 canDo）。
  eventBus.on('interaction.occurred', (evt) => {
    // V1 task 9.1：按 evt.accountId 路由到对应账号 controller（缺失回退 default）；单账号现实即 default。
    riskRegistry
      .getController(evt.accountId ?? 'default')
      .then((c) => c.record(evt.action))
      .catch((err) => {
        console.warn('[aidcp-cloud] RiskController record error:', err);
      });
    // A 阶段4 来源血缘：真实点赞落 liked_notes（noteId 才落；详情缺则空字段如实，不编造）。
    if (evt.action === 'like' && evt.noteId && likedNoteStore) {
      likedNoteStore.recordLike(evt.noteId).catch((err) => {
        console.warn('[aidcp-cloud] LikedNoteStore recordLike error:', err);
      });
    }
    // V1 task 9.2：按笔记互动落去重表（接线孤儿 risk_interactions）。
    // 仅 like/collect（InteractionAction，follow 无 per-note 语义）；ON CONFLICT DO NOTHING 天然去重。
    if (evt.noteId && (evt.action === 'like' || evt.action === 'collect')) {
      riskStore
        .recordInteraction(evt.accountId ?? 'default', evt.noteId, evt.action, Date.now())
        .catch((err) => {
          console.warn('[aidcp-cloud] recordInteraction error:', err);
        });
    }
  });
  console.log('[aidcp-cloud] 事件订阅已建立（RiskController）');

  // 告警日志存储（alerts 表，V1 task 9.5）。init 失败留 undefined（告警不落库、不阻塞启动；飞书告警仍发）。
  let alertStore: PgAlertStore | undefined;
  try {
    const as = new PgAlertStore({
      host: readEnvString('PGHOST'),
      port: readEnvPort('PGPORT'),
      database: readEnvString('PGDATABASE'),
      user: readEnvString('PGUSER'),
      password: readEnvString('PGPASSWORD'),
    });
    await as.init();
    alertStore = as;
    console.log('[aidcp-cloud] AlertStore 已就绪（alerts 表）');
  } catch (err) {
    console.warn('[aidcp-cloud] AlertStore 初始化失败，告警不落库（飞书告警仍发）:', (err as Error).message);
  }

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
    // 手动 /publish [accountId]：越过风控 canDo（人工授权），发布前飞书人审仍铁定生效（AC-PUB）。
    // accountId 指定以哪个账号发帖（落 publish_log.account_id + 命令定向到该账号在线节点）；缺省 default。
    publish: async (accountId?: string) => {
      if (!publishScheduler) return '发帖触发器未就绪（PG/概念池不可用）';
      const o = await publishScheduler.triggerManual(accountId);
      return `已触发（${o.reason}）→ 编排状态 ${'status' in o ? o.status : '-'}`;
    },
  };
  const commandRouter = new CommandRouter(actions);
  const messenger = new FeishuMessenger();
  // 验证码事件协调器：消费 risk.captcha_detected/cleared（迁状态 + 按 edge 暂停 + 去重发飞书）。
  const captcha = new CaptchaCoordinator({
    riskController,
    messenger,
    // V1 task 9.5：验证码告警落库（飞书卡发送点写入、清除点 resolveByEdge）。
    alertStore,
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

  // ── 多租户连接运行时（multi-account-node-support）：每连接私有 EventBus + RoleDispatcher ──────────
  // 前向声明：handler / server 经闭包引用 runtimes（runtimes 在下方装配后才被调用，运行时安全）。
  let runtimes: ConnectionRuntimeRegistry | undefined;
  // 调度启停态（面板 /dispatch 全局开关）：false 时新 / 现有连接不启动浏览会话。
  let dispatchActive = true;
  // 未绑人设告警去重（避免重连 / 空转 churn 反复刷飞书）：每账号每进程仅告警一次。
  const personaSetupAlerted = new Set<string>();

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
    // 多租户路由：私有总线（入站事件灌本连接通道）/ 握手建运行时 / 按连接真实账号解析 controller。
    busFor: (session) => runtimes!.busFor(session),
    onHandshake: (session) => runtimes!.onHandshake(session),
    resolveController: (session) => runtimes?.controllerForSession(session),
  });
  const server = new EdgeCloudServer({ port, handler, onClose: (session) => runtimes?.onDisconnect(session) });
  edgeServer = server;
  await server.start();
  console.log(`[aidcp-cloud] 边-云 WebSocket 服务端已监听 :${port}`);

  // ── 评论循环内人审端口（env 闸：默认 dormant，绝不裸发）─────────────────
  // 同形复用 AC-PUB 接收端（parseApprovalActionValue + writeApprovalSignal）+ 读侧 isPublishApproved，
  // 用评论专属 requestId（comment-<noteId>-<ts>），零改 AC-PUB 共享代码。
  // 90s 超时 < idle 看门狗 idleNudgeMs(130s)，故审批等待期不会触发 idle nudge，无需显式暂停态。
  const commentApprovalEnabled = process.env.AIDCP_COMMENT_APPROVAL === 'true';
  const commentApproval: CommentApprovalPort = {
    request: async ({ requestId, noteId, text, title }) => {
      const chatId = await resolveDefaultChatId({ botChatStore, fallbackChatId: process.env.FEISHU_CHAT_ID, logger: console });
      if (!chatId) {
        console.error('[comment] 无可用飞书群，评论审批卡未发出（将超时跳过、不发）');
        return;
      }
      await messenger.sendApprovalCard(chatId, buildCommentApprovalCard({ requestId, noteId, text, title }));
    },
    isApproved: isPublishApproved,
    timeoutMs: 90_000,
    pollMs: 2_000,
  };

  // ── 按连接多租户编排（multi-account-node-support D1/D2/D3/D4/D6）─────────────────
  // 未绑人设 / 配置错误 → 飞书通知 + 后台状态（D6，不新增 cloud→edge 命令、不动协议）。
  // 「needs_persona_setup 态」是派生字段（persona_config 行不存在即未绑），无需额外落库；这里只负责告警。
  const onNeedsPersonaSetup = async (accountId: string, edgeId: string | undefined, reason: string): Promise<void> => {
    console.warn(`[aidcp-cloud] 账号 ${accountId}（edge=${edgeId ?? '-'}）${reason}：未绑人设，拒绝启动浏览会话`);
    if (personaSetupAlerted.has(accountId)) return; // 每账号每进程仅告警一次，避免空转 churn 刷屏
    personaSetupAlerted.add(accountId);
    try {
      const chatId = await resolveDefaultChatId({ botChatStore, fallbackChatId: process.env.FEISHU_CHAT_ID, logger: console });
      if (chatId) {
        await messenger.sendText(
          chatId,
          `⚠️ 账号 \`${accountId}\` 节点已上线但**未绑定人设**，已拒绝启动（needs_persona_setup）。\n请到后台「人设」页为该账号设置人设后，节点重连即可开始浏览。`,
        );
      }
    } catch (err) {
      console.error('[aidcp-cloud] needs_persona_setup 飞书告警发送失败:', (err as Error).message);
    }
  };
  // 缺 / 空 accountId 握手 → 配置错误（拒绝握手在 handler/registry 完成，这里只发飞书把人叫去修启动器）。
  const onConfigError = async (session: { edgeId?: string; machineLabel?: string }, message: string): Promise<void> => {
    console.error(`[aidcp-cloud] 握手配置错误 edge=${session.edgeId ?? '-'}: ${message}`);
    try {
      const chatId = await resolveDefaultChatId({ botChatStore, fallbackChatId: process.env.FEISHU_CHAT_ID, logger: console });
      if (chatId) {
        await messenger.sendText(
          chatId,
          `⚠️ 边缘节点握手被拒（配置错误）：edge=\`${session.edgeId ?? '-'}\`${session.machineLabel ? `（${session.machineLabel}）` : ''} 未声明 accountId。\n请为该节点启动器显式设置 AIDCP_ACCOUNT_ID（默认账号写 default）。`,
        );
      }
    } catch (err) {
      console.error('[aidcp-cloud] 配置错误飞书告警发送失败:', (err as Error).message);
    }
  };

  // 同账号并行（N:1）互动去重 guard 注册表（按账号单例）：同账号 N 连接共用一个 guard，
  // 下发互动前占坑去重，防两节点对同一笔记/作者重复点赞/关注/评论（D7②）。
  const interactionGuardRegistry = new InteractionGuardRegistry();

  // 动作冷却闸（engagement-restraint）：单例共享（内部按 accountId 分桶）——同账号 N 连接共用同一冷却时间线，
  // 不同账号互不影响。附加只读节奏闸，不写风控终态；判定全在云端、内存态、不经协议、无迁移。
  const actionCooldownGate = new ActionCooldownGate();

  // 每个连接握手时由 buildDispatcher 造一束 RoleDispatcher：私有总线 / 该连接真实账号 controller / 定向下发。
  // 人设以取值口注入（account-persona-config）：派发时按当前账号热加载，PUT 后无需重启。
  const buildDispatcher = (ctx: DispatcherBuildContext): RoleDispatcher => {
    // 通知联系人名册（notification-contact-registry）：订阅该连接私有总线的 notification.items.arrived
    // （评论/@/点赞/收藏/关注发送者），按该连接真实账号追加进事件流水。每连接握手 buildDispatcher 调一次 →
    // 一连接订阅一次（避免 setup/restart 重复订阅重复记录）。记录失败只吞 + 准确日志：绝不冒充飞书失败、
    // 绝不阻塞巡视；append 幂等，下轮安全重试。预览 dispatcher 无边缘会话 → 永不触发（不在默认账号空记）。
    if (notificationContactStore) {
      ctx.bus.on('notification.items.arrived', (p) => {
        const items = p?.items ?? [];
        if (!items.length) return;
        notificationContactStore!.appendEvents(ctx.accountId, items).catch((err) =>
          console.warn(
            `[notification-contacts] 记录失败 account=${ctx.accountId}（巡视照常，下轮幂等重试）:`,
            (err as Error).message,
          ),
        );
      });
    }
    return new RoleDispatcher({
      getSoul,
      llm,
      // 私有事件通道（连接间互不串味）；其上事件经 tee 汇入全局观测总线供风控记账 / 看板消费。
      eventBus: ctx.bus,
      // 指令级节奏：喂当前（该账号）风控状态，驱动 dwellMs/thinkMs 的 tempo。
      getRiskStatus: () => ctx.controller.getState().status,
      // 互动前风控闸：按该连接真实账号的 controller 判定（不再钉死 default）。被拒诚实跳过。
      canInteract: (action) => ctx.controller.canDo(action),
      // 评论人审端口（env 闸开启时注入；未开启 → 评论一律诚实跳过、不发）。
      ...(commentApprovalEnabled ? { commentApproval } : {}),
      // 评论 / 评论赞当日配额预闸：按该账号 controller 当日剩余。
      getCommentDailyRemaining: () => ctx.controller.dailyRemaining('comment'),
      getCommentLikeDailyRemaining: () => ctx.controller.dailyRemaining('comment_like'),
      // 优质评论语料库（comment-like-on-detail B）：归档闭包 + 按主题召回参考闭包（store 缺失则不接线）。
      ...(valuableCommentStore
        ? {
            archiveValuableComment: (input) => valuableCommentStore!.archive(input),
            getCorpusReferences: (topics) => valuableCommentStore!.retrieveByTopics(topics, 3),
          }
        : {}),
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
      // 下行指令只发回**发起该决策的连接**（按 edgeId 定向，不再广播 → 不串号）。单连接时等价于原广播。
      sendCommand: (command) => {
        const envelope = edgeCommandToEnvelope(command);
        const sent = server.pushToEdges(envelope, ctx.edgeId);
        console.log(
          `[RoleDispatcher] sendCommand account=${ctx.accountId} edgeId=${ctx.edgeId ?? '-'} action=${command.action} sent=${sent}`,
        );
      },
      // 诚实人设启动闸（D3）：以 persona_config 行存在为独立判据（不走会回落的解析器）；default 硬豁免（在
      // RoleDispatcher.canStartSession 内）；存储读不到 → false（fail-closed，诚实拒绝、不偷用默认人设）。
      isPersonaBound: (accountId) => personaStore.getForAccount(accountId) !== null,
      onSessionRejected: (accountId, reason) => onNeedsPersonaSetup(accountId, ctx.edgeId, reason),
      // 全局调度开关（面板 /dispatch）。
      isDispatchActive: () => dispatchActive,
      // 同账号并行互动去重（按账号单例 guard；同账号 N 连接共用 → 共享 in-flight/completed，不重复动作）。
      interactionGuard: interactionGuardRegistry.forAccount(ctx.accountId),
      // 动作冷却闸（engagement-restraint）：单例共享，内部按 ctx.accountId 分桶。下发互动前查、真成功后落时间戳。
      cooldownGate: actionCooldownGate,
    });
  };

  runtimes = new ConnectionRuntimeRegistry({
    observerBus: eventBus,
    getController: (accountId) => riskRegistry.getController(accountId),
    buildDispatcher,
    ensureAccount: async (accountId) => {
      try {
        await accountStore?.ensureAccount?.(accountId);
      } catch (err) {
        console.warn(`[aidcp-cloud] ensureAccount(${accountId}) 失败（不阻塞握手）:`, (err as Error).message);
      }
    },
    onConfigError,
    closeEdge: (sessionId) => server.closeEdge(sessionId),
    logger: console,
  });
  console.log('[aidcp-cloud] 连接运行时注册表就绪（按连接多租户编排，握手建运行时、断连拆除）');

  // 角色 prompt 只读预览（role-prompt-visibility）：用一个仅供预览的 RoleDispatcher 渲染真实 prompt
  // （独立私有总线、从不启动会话 / 从不下发指令；多租户下不再有单一全局 dispatcher 可借）。
  const previewDispatcher = buildDispatcher({
    bus: new EventBus(),
    controller: riskController,
    accountId: 'default',
    edgeId: undefined,
  });
  previewDispatcher.setup();

  // 注册发布编排器的生产段角色（A 阶段2 细拆：6→11，下游 Gatekeeper/Executor 不变）。
  // 注册顺序无关正确性（黑板靠键就绪触发），按拓扑排列便于阅读。
  publishOrchestrator.registerRole(new ContentScoutRole({ llmClient: roleLlm('publish:ContentScout') }));
  publishOrchestrator.registerRole(new ContentTypeSelectorRole());
  publishOrchestrator.registerRole(new ContentCreatorRole({ llmClient: roleLlm('publish:ContentCreator') }));
  // 配图：决策（ImagePlanner）↔ 执行（ImageGenerator）↔ 封面（CoverSelector）
  publishOrchestrator.registerRole(new ImagePlannerRole({ llmClient: roleLlm('publish:ImagePlanner') }));
  publishOrchestrator.registerRole(new ImageGeneratorRole({
    imageProvider: wanxiangClient,
    // 配图与 Qwen 同用百炼 key：WANXIANG_API_KEY 或 DASHSCOPE_API_KEY 任一就绪即启用（与 wanxiangClient 的 key 解析一致）。
    enableImageGeneration: !!(readEnvString('WANXIANG_API_KEY') ?? dashscopeApiKey),
  }));
  publishOrchestrator.registerRole(new CoverSelectorRole());
  // 后处理：清洗（ContentCleaner）→ AI味分（AiFlavorScorer）/ 质量分（QualityScorer）
  publishOrchestrator.registerRole(new ContentCleanerRole({ postProcessor }));
  publishOrchestrator.registerRole(new AiFlavorScorerRole());
  publishOrchestrator.registerRole(new QualityScorerRole({ llmClient: roleLlm('publish:QualityScorer') }));
  // 汇合：瘦身 ContentAssembler（纯组装，waitAll 五键）
  publishOrchestrator.registerRole(new ContentAssemblerRole());
  // 标题链路：定稿后单独生成标题（watch assembledContent → titleSelection）；发布门 waitAll 依赖此键（注册顺序无关）。
  publishOrchestrator.registerRole(new TitleCreatorRole({ llmClient: roleLlm('publish:TitleCreator') }));
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
  publishOrchestrator.registerRole(new ApprovalGatekeeperRole({ llmClient: roleLlm('publish:ApprovalGatekeeper') }));
  publishOrchestrator.registerRole(new PublishExecutorRole({
    store: {
      async insert(record) {
        return publishLogStore.insert({
          title: record.title,
          content: record.content,
          // 真血缘：用 executor 计算的真概念/真点赞 id（无则空数组），不再用 tags / [] 充数（修 stage-4 适配器漏接）。
          sourceConcepts: record.sourceConcepts ?? [],
          sourceLikedIds: record.sourceLikedIds ?? [],
          status: record.status as 'draft' | 'published' | 'failed' | 'needs_review',
          // 审计用 image_url；是否真附着插入时为 false，上传成功后由 markImagesAttached 置 true。
          imageUrl: record.imageUrl,
          // 真实发布账号（change publish-history-account-and-detail）：来自触发上下文，缺省 'default'。
          accountId: record.accountId,
        });
      },
      async updateStatus(id, status) {
        await publishLogStore.updateStatus(id, status as 'draft' | 'published' | 'failed' | 'needs_review');
      },
      async updatePostId(id, postId, postUrl) {
        // 详情页分享 URL（带 xsec_token）一并回写；边缘抓不到则为 null（COALESCE 不覆盖、诚实置空）。
        await publishLogStore.updatePostId(id, postId, postUrl);
      },
      // stage-4 元数据落库 + 防篡改审计（补接 server 适配器漏接，使 executor 的 recordMetadata 真生效）。
      async recordMetadata(id, metadata, aiEnforced) {
        await publishLogStore.recordMetadata(id, metadata, aiEnforced);
      },
      // 配图收口：降级纯文字时如实标记，杜绝纯文字帖留「有图」假信号。
      async markImagesAttached(id, attached) {
        await publishLogStore.markImagesAttached(id, attached);
      },
    },
    pusher: server,
    messenger,
    botChatStore,
    // A 阶段1：注入 sequencer + 审批读取 → auto_publish 走指令驱动 + AC-PUB 闸 + 结果回写。
    sequencer: commandSequencer,
    isApproved: isPublishApproved,
    // 人审等待窗口给足真实人工延迟（默认 15min，env 可调）；角色超时须 > 窗口 + 指令序列。
    approvalWaitMs: Number(process.env.AIDCP_PUBLISH_APPROVAL_WAIT_MS ?? 900_000),
    roleTimeoutMs: Number(process.env.AIDCP_PUBLISH_ROLE_TIMEOUT_MS ?? 1_080_000),
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
      // 人设取值口（change account-persona-config）：构建发布输入时按当前账号热加载。
      getSoul,
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
    // Mock 触发（仅 AIDCP_MOCK_PUBLISH=true；无飞书时驱动一次发帖，诊断/联调用）：
    // 监视信号文件 → 等价飞书 /publish 的 triggerManual(forced)；文件触发后即删避免重复。
    // 红线不旁路：发布前 AC-PUB 人审信号（/tmp/aidcp-publish-approve-<requestId>.json）仍铁定生效，未授权绝不发布。
    if (readEnvString('AIDCP_MOCK_PUBLISH') === 'true') {
      const triggerFile = '/tmp/aidcp-mock-publish-trigger';
      setInterval(async () => {
        try {
          await readFile(triggerFile, 'utf8');
        } catch {
          return; // 文件不存在 → 不触发
        }
        await unlink(triggerFile).catch(() => {});
        console.log('[aidcp-cloud] MOCK publish 触发命中 → triggerManual');
        publishScheduler!.triggerManual().catch((e) => console.warn('[aidcp-cloud] MOCK triggerManual err:', e));
      }, 3000);
      console.log('[aidcp-cloud] MOCK publish 触发已开启（touch /tmp/aidcp-mock-publish-trigger 触发一次）');
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

  // 组装模型配置视图（GET /api/config/model 与 setModel 回真态共用）。永不含明文密钥。
  const buildModelConfigView = async (): Promise<ModelConfigView> => {
    const cfg = modelConfigStore.getCached();
    const field = 'dashscope_api_key';
    const stored = await credentialStore.getStored('dashscope', field).catch(() => null);
    const envPresent = !!readEnvString('DASHSCOPE_API_KEY');
    const credential = stored
      ? { field, configured: true, maskedHint: stored.maskedHint, source: 'db' as const }
      : envPresent
        ? { field, configured: true, maskedHint: '（来自环境变量）', source: 'env' as const }
        : { field, configured: false, maskedHint: null, source: 'none' as const };
    return {
      provider: 'dashscope',
      baseUrl: QWEN_BASE_URL,
      textModel: cfg.textModel,
      imageModel: cfg.imageModel,
      credential,
      canEditCredential: credentialStore.canEdit(),
    };
  };

  // 显式 model 覆盖 + 短超时；探活失败抛错 → facade 报 model_invalid，绝不落库。
  // role 'system:model_probe'：探活真实消耗 token，如实记、可区分、不静默丢（change llm-token-usage-stats）。
  const probeModel = async (model: string): Promise<void> => {
    await llm.chat([{ role: 'user', content: 'ping' }], { model, timeoutMs: 8000, role: 'system:model_probe' });
  };
  // 角色配置面板外观（change console-role-model-config）：白名单 + 生效值视图 + 写校验 + 保存前探活。
  const roleConfigPanel = createRoleConfigPanel({
    store: roleConfigStore,
    getGlobalTextModel: () => modelConfigStore.getCached().textModel,
    getGlobalImageModel: () => modelConfigStore.getCached().imageModel,
    getCategoryModel: (categoryId) => categoryConfigStore.getForCategory(categoryId).model,
    probeModel,
  });
  // 分类默认模型面板外观（change role-model-category-config）：白名单 + 生效值视图 + 写校验 + 保存前探活。
  const categoryConfigPanel = createCategoryConfigPanel({
    store: categoryConfigStore,
    getGlobalTextModel: () => modelConfigStore.getCached().textModel,
    probeModel,
  });
  // 安全限额面板外观（change safety-quota-config）：三档×动作×三窗口生效值 + 写校验（非法整块拒）+ 非乐观回真态。
  const quotaConfigPanel = createQuotaConfigPanel({ store: quotaConfigStore });
  // 角色 prompt 只读预览（change role-prompt-visibility）：借仅供预览的 RoleDispatcher 渲染真实 prompt。
  const rolePromptProvider = createRolePromptProvider(() => previewDispatcher.getRoles());

  // ── 面板 API 层（管理后台后端，进程内、独立端口、JWT）──────────────────────
  // 未设置 AIDCP_PANEL_PORT 则禁用（默认不开新端口）；启动失败非致命，绝不连累边-云闭环。
  const panelPort = readEnvPort('AIDCP_PANEL_PORT');
  if (panelPort) {
    try {
      const panel = await startPanelApi(
        {
          riskController,
          riskRegistry,
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
            // 调度启停全局开关：切所有连接运行时的会话（start 经诚实人设闸 / stop 全停）；回报真实在线 edge 数，绝不乐观。
            // accountId 信息性（当前为全局开关）；no-op（已 active/已 stop）以 changed=false 诚实可辨。
            dispatch: async (accountId, action) => {
              const want = action === 'start';
              const changed = dispatchActive !== want;
              if (changed) {
                dispatchActive = want; // 先置标志，使 startAll 的启动闸看到 active
                if (want) runtimes?.startAll();
                else runtimes?.endAll('panel_dispatch_stop');
              }
              return {
                accountId,
                dispatch: want ? ('started' as const) : ('stopped' as const),
                changed,
                edgesOnline: server.onlineEdgeCount(),
              };
            },
            dispatchActive: () => dispatchActive,
          },
          // 模型与凭据配置（change console-model-provider-config）。明文密钥绝不经此回传。
          modelConfig: {
            getView: buildModelConfigView,
            setModel: async (patch, updatedBy) => {
              await modelConfigStore.set(patch, updatedBy);
              return buildModelConfigView();
            },
            setCredential: async (field, value, updatedBy) => {
              if (!credentialStore.canEdit()) return { ok: false, reason: 'cred_key_missing' as const };
              const { maskedHint } = await credentialStore.setSecret('dashscope', field, value, updatedBy);
              return { ok: true, field, maskedHint };
            },
          },
          // 角色级模型/温度配置（change console-role-model-config）。白名单 + 探活 + 写非乐观回真态。
          roleConfig: roleConfigPanel,
          // 分类级模型默认配置（change role-model-category-config，item 5/6）。白名单 + 探活 + 写非乐观回真态。
          categoryConfig: categoryConfigPanel,
          // 安全限额配置（change safety-quota-config，stream D）。三档×动作×三窗口可改 + 热加载 + 非乐观回真态。
          quotaConfig: quotaConfigPanel,
          // 角色 prompt 只读预览（change role-prompt-visibility）。纯读，无写路径。
          rolePromptPreview: rolePromptProvider,
          // 账号人设配置（change account-persona-config，stream F）。按账号编辑 + soul 校验 + 写非乐观回真态。
          persona: personaPanel,
          // token 用量统计（change llm-token-usage-stats）。同一记账 store 实例（共享专用池），纯只读查询。
          tokenUsage: tokenUsageStore,
          // 通知联系人名册（change notification-contact-registry）。同一记录 store 实例：读=按账号联系人列表、写=人工字段（微信/标签/备注）。
          notificationContact: notificationContactStore,
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
