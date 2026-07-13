/**
 * 默认边-云消息处理器：把协议消息接到云端三大能力。
 *
 * - plan.request   → TaskPlanner（规划层）
 * - select.request → LlmClient（文本模型做选择题）
 * - anchor.get     → PgAnchorCache.get（主缓存）
 * - anchor.report  → 反污染晋升（命中统计 / 暂存→确认→晋升）
 * - hello          → 分配会话，回 welcome
 * - ping           → pong
 *
 * 所有外部能力都通过接口注入，便于单测打桩（无需真实 PG / 模型 / 网络）。
 */

import {
  makeEnvelope,
  type Envelope,
  type SelectRequestPayload,
  type PlanRequestPayload,
  type AnchorGetPayload,
  type AnchorReportPayload,
  type HelloPayload,
  type RemoteElement,
  type PublishApprovalRequestPayload,
  type PublishApprovalActionPayload,
  type PublishApprovalActionResultPayload,
  type RiskCanDoPayload,
  type RiskRecordPayload,
  type PageCardsPayload,
  type NoteDetailPayload,
  type ProfileDetailPayload,
  type ActionCompletedPayload,
  type CaptchaDetectedPayload,
  type CaptchaClearedPayload,
  type CaptchaAssistSnapshotPayload,
  type CaptchaAssistClickResultPayload,
  type NotificationDetectedPayload,
  type NotificationHomePayload,
  type NotificationItemsPayload,
  type PublishCommandResultPayload,
  type EdgeTaskAcquiredPayload,
  type EdgeTaskReleasedPayload,
  type PersonaGeneratePayload,
  type PersonaGenerateResultPayload,
  type PersonaPersistPayload,
} from './protocol.js';
import type { PersonaGenerator } from '../agents/persona-generator.js';
import type { PanelPersonaConfig } from '../panel/types.js';
import type { CommandSequencer } from '../publish-agent/command-sequencer.js';
import type { EdgeTaskLeaseClient } from './edge-task-lease-client.js';
import type { MessageHandler, EdgeSession, EdgePusher } from './ws-server.js';
import type { CaptchaCoordinator } from './captcha-coordinator.js';
import type { CaptchaAssistService } from './captcha-assist.js';
import type { TaskPlanner } from '../planner/types.js';
import type { LlmClient } from '../llm/qwen.js';
import type { EventBus } from '../event-bus/index.js';
import { buildPublishApprovalCard } from '../feishu/cards.js';
import type { FeishuMessenger } from '../feishu/messenger.js';
import type { BotChatStore } from '../cache/bot-chat-store.js';
import { RiskController, SessionBudget, buildPacingSnapshot } from '../risk/index.js';
import type { RiskAction, RiskStatus, RiskQuotaLevel, PacingFloorProvider } from '../risk/index.js';
import type { PacingSnapshotPayload } from './protocol.js';
import type { AccountStateManager } from '../account-state.js';

/**
 * action.completed 的 action 是云端角色的关联键，正常值是 `browse_images` 而非
 * `note.browse_images`。旧 edge 或平台会话若回传协议消息名，入口统一归一化，避免
 * DeepReader / CommentReviewer 漏消费失败回执并让 dispatcher 在详情页错误补发 feed scroll。
 */
const LEGACY_ACTION_COMPLETION_ALIASES: Readonly<Record<string, string>> = {
  'page.scroll': 'scroll',
  'feed.refresh': 'refresh',
  'interaction.like': 'like',
  'interaction.collect': 'collect',
  'interaction.follow': 'follow',
  'interaction.comment': 'comment',
  'interaction.like_comment': 'comment_like',
  'search.execute': 'search',
  'note.open': 'open_note',
  'note.close': 'close',
  'note.browse_images': 'browse_images',
  'note.scroll_comments': 'scroll_comments',
  'navigation.back': 'back',
  'profile.open': 'profile_open',
  'group.join': 'join_group',
  'notification.open': 'open_notifications',
  'notification.browse_comments': 'browse_notification_comments',
  'notification.browse_likes': 'browse_notification_likes',
  'notification.browse_follows': 'browse_notification_follows',
  'notification.back_home': 'notification_back_home',
  'pacing.update': 'pacing_update',
};

export function normalizeActionCompletedAction(action: string): string {
  return LEGACY_ACTION_COMPLETION_ALIASES[action] ?? action;
}

/** 锚点缓存的最小接口（PgAnchorCache 实现它，单测可打桩） */
export interface AnchorStore {
  get(actionId: string): Promise<import('./protocol.js').RemoteAnchor | null>;
  recordHit(actionId: string): Promise<void>;
  recordFailure(actionId: string): Promise<void>;
  stage(anchor: import('./protocol.js').RemoteAnchor): Promise<void>;
  confirmStaged(actionId: string): Promise<{ promoted: boolean; successes: number; needed: number }>;
  dropStaged(actionId: string): Promise<void>;
}

/** 握手结果：ok 则建会话，否则按配置错误拒绝（结构兼容 connection-runtime.ts 的同名类型）。 */
export type HandshakeOutcome = { ok: true } | { ok: false; code: string; message: string };

export interface HandlerDeps {
  planner: TaskPlanner;
  llm: LlmClient;
  cache: AnchorStore;
  messenger?: Pick<FeishuMessenger, 'sendApprovalCard'>;
  botChatStore?: Pick<BotChatStore, 'getDefaultChat'>;
  approvalChatId?: string;
  logger?: Pick<Console, 'error' | 'warn' | 'log'>;
  clock?: () => number;
  serverVersion?: string;
  riskController?: RiskController;
  eventBus: EventBus;
  accountState?: AccountStateManager;
  /** 验证码事件协调器（risk.captcha_detected/cleared 的消费端）。未注入则两类上报被忽略（向后兼容）。 */
  captcha?: CaptchaCoordinator;
  /** 验证码协助通道：消费 edge 截图和人工点击复检结果。未注入则忽略（向后兼容）。 */
  captchaAssist?: Pick<CaptchaAssistService, 'onSnapshot' | 'onClickResult'>;
  /** A 阶段1 发布指令编排器：消费 publish.command.result 关联回报（未注入则忽略，向后兼容）。 */
  commandSequencer?: Pick<CommandSequencer, 'onResult'>;
  /** task.acquired/released 关联器；未注入时回执仅忽略，兼容纯协议测试。 */
  edgeTaskLeases?: Pick<EdgeTaskLeaseClient, 'onAcquired' | 'onReleased'>;
  // ── multi-account-node-support：按连接多租户路由 ─────────────────────────
  /**
   * 该连接的私有事件总线（缺省 → 回落 eventBus，单租户向后兼容）。入站事件发到此总线，
   * 经其 tee 到全局观测总线供风控记账 / 看板消费；连接间互不串味。
   */
  busFor?: (session: EdgeSession) => EventBus;
  /**
   * 握手钩子：校验账号身份、登记新账号、建该连接运行时（私有总线 + RoleDispatcher）。
   * 返回 ok=false（如缺 accountId）则按配置错误拒绝握手、不回 welcome、不建会话。缺省 → 视为 ok（向后兼容）。
   */
  onHandshake?: (session: EdgeSession) => Promise<HandshakeOutcome> | HandshakeOutcome;
  /** 按连接真实账号解析 RiskController（reserved risk 通道 / session.budget 用）；缺省回落 riskController。 */
  resolveController?: (session: EdgeSession) => RiskController | undefined;
  /**
   * 操作兜底 floor 提供者（change pacing-floor-config-min-interval）：welcome 握手现读组装 pacing 快照下发。
   * 未注入 → welcome 省略 `pacing` 字段（边缘回落内置非零默认，向后兼容）。纯读、不写任何状态。
   */
  pacingFloors?: PacingFloorProvider;
  /**
   * 建号自助人设生成器（change edge-persona-keyword-generation）：persona.generate 的处理端。
   * 未注入 → persona.generate 诚实回 { ok:false, reason:'unavailable' }（向后兼容）。
   */
  personaGenerator?: Pick<PersonaGenerator, 'generate'>;
  /**
   * 人设写入外观（复用 setPersona 的 FK 守护 / 空校验 / soul 校验 / 落库 / 绑定唤醒）：persona.persist 的处理端。
   * 未注入 → persona.persist 诚实回 { ok:false, reason:'unavailable' }（向后兼容）。
   */
  personaFacade?: Pick<PanelPersonaConfig, 'setPersona'>;
  /** 客户端稿件预览内的发布/取消审批动作。未注入则诚实返回 unavailable。 */
  publishApprovalAction?: (
    payload: PublishApprovalActionPayload,
    session: EdgeSession,
  ) => Promise<PublishApprovalActionResultPayload>;
}

/** 把元素清单渲染成给 LLM 的编号列表（与 edge selector 一致的格式） */
export function renderElementList(elements: RemoteElement[]): string {
  return elements
    .map((el) => {
      const attrs = Object.entries(el.attributes)
        .filter(([k]) => k !== 'value')
        .map(([k, v]) => `${k}="${v}"`)
        .join(' ');
      const text = el.text ? ` "${el.text}"` : '';
      return `[${el.index}] <${el.tag} role=${el.role}${text}${attrs ? ' ' + attrs : ''}>`;
    })
    .join('\n');
}

export function buildSelectionPrompt(goal: string, elements: RemoteElement[]): string {
  return [
    '你是页面元素定位助手。下面是当前页面（或当前作用域）内的可交互元素清单。',
    '请从清单中选出最符合目标的唯一元素编号。',
    '只输出一个整数编号；如果没有任何元素符合目标，输出 -1。不要输出其他文字。',
    '',
    `目标：${goal}`,
    '',
    '元素清单：',
    renderElementList(elements),
    '',
    '编号：',
  ].join('\n');
}

/** 从模型输出解析整数编号 */
export function parseIndex(raw: string): number | null {
  const m = raw.match(/-?\d+/);
  if (!m) return null;
  const n = Number.parseInt(m[0], 10);
  return Number.isNaN(n) ? null : n;
}

export class DefaultMessageHandler implements MessageHandler {
  private readonly clock: () => number;
  private readonly serverVersion: string;
  private readonly logger: Pick<Console, 'error' | 'warn' | 'log'>;
  private readonly riskController: RiskController;
  /**
   * persona.generate 幂等在途缓存（键 = accountId:idempotencyKey）。
   * 同键复用同一 Promise → 重连/重试不重复调大模型、不双计费；成功结果保留、失败逐出（允许后续重试）。
   */
  private readonly personaGenInflight = new Map<string, Promise<PersonaGenerateResultPayload>>();

  constructor(private readonly deps: HandlerDeps) {
    this.clock = deps.clock ?? Date.now;
    this.serverVersion = deps.serverVersion ?? '0.1.0';
    this.logger = deps.logger ?? console;
    this.riskController = deps.riskController ?? new RiskController();
  }

  /** 该连接的事件总线（多租户私有通道）；未接线则回落全局总线（单租户向后兼容）。 */
  private bus(session: EdgeSession): EventBus {
    return this.deps.busFor?.(session) ?? this.deps.eventBus;
  }

  /** 该连接真实账号的 RiskController；未接线则回落注入的单一 controller（向后兼容）。 */
  private controllerFor(session: EdgeSession): RiskController {
    return this.deps.resolveController?.(session) ?? this.riskController;
  }

  async handle(
    env: Envelope,
    session: EdgeSession,
    pusher?: EdgePusher,
  ): Promise<Envelope | null> {
    switch (env.type) {
      case 'hello':
        return this.onHello(env, session);
      case 'ping':
        return makeEnvelope('pong', env.id, this.clock(), {});
      case 'plan.request':
        return this.onPlan(env, pusher);
      case 'select.request':
        return this.onSelect(env);
      case 'anchor.get':
        return this.onAnchorGet(env);
      case 'anchor.report':
        return this.onAnchorReport(env);
      case 'note.content': {
        // 字段映射：edge payload (likes/collects/body) → IncomingNote (likeCount/collectCount/summary)
        const p = env.payload as Record<string, unknown>;
        const incomingNote = {
          noteId: (p.noteId as string) || '',
          title: (p.title as string) || '',
          summary: (p.body as string) || (p.summary as string) || '',
          likeCount: (p.likes as number) ?? (p.likeCount as number) ?? 0,
          collectCount: (p.collects as number) ?? (p.collectCount as number) ?? 0,
          author: (p.author as string) || undefined,
        };
        // 戳当前笔记 id：随后 action.completed 发射 interaction.occurred 时据此补 noteId（V1 task 9.2）。
        if (incomingNote.noteId) session.currentNoteId = incomingNote.noteId;

        // retire-default-account：按连接真实账号判暂停；会话账号握手已保证存在，
        // 缺失=上游缺陷，honest-fail 跳过该笔记 + 告警，绝不回落 default。
        if (!session.accountId) {
          this.logger.warn('[comm] note.arrived 会话缺 accountId（握手应已保证）— 跳过该笔记，绝不回落 default');
          return makeEnvelope('note.ack', env.id, this.clock(), { received: true });
        }
        // 暂停检查：已暂停则仅返回 ack，不触发 orchestrator。
        if (this.deps.accountState?.isPaused(session.accountId)) {
          this.logger.log('[comm] 账号已暂停，跳过笔记处理:', incomingNote.title);
          return makeEnvelope('note.ack', env.id, this.clock(), { received: true });
        }

        // 异步发射事件（fire-and-forget）
        this.bus(session).emit('note.arrived', { note: incomingNote, ts: this.clock() });
        // 立即返回 ack
        return makeEnvelope('note.ack', env.id, this.clock(), { received: true });
      }
      case 'publish.approval_request':
        await this.onPublishApprovalRequest(env, session);
        return null;
      case 'publish.approval_action': {
        const payload = env.payload as PublishApprovalActionPayload;
        const result = this.deps.publishApprovalAction
          ? await this.deps.publishApprovalAction(payload, session)
          : { requestId: payload?.requestId ?? '', ok: false, reason: 'unavailable' };
        return makeEnvelope('publish.approval_action.result', env.id, this.clock(), result);
      }
      case 'session.budget.request':
        return this.onSessionBudgetRequest(env, session);
      case 'risk.canDo':
        return this.onRiskCanDo(env, session);
      case 'risk.record':
        return this.onRiskRecord(env, session);
      case 'persona.generate':
        return this.onPersonaGenerate(env, session);
      case 'persona.persist':
        return this.onPersonaPersist(env, session);
      case 'risk.captcha_detected':
        await this.deps.captcha?.onDetected(env.payload as CaptchaDetectedPayload, session, pusher);
        return null;
      case 'risk.captcha_cleared':
        await this.deps.captcha?.onCleared(env.payload as CaptchaClearedPayload, session, pusher);
        return null;
      case 'captcha.assist.snapshot':
        this.deps.captchaAssist?.onSnapshot(env.payload as CaptchaAssistSnapshotPayload);
        return null;
      case 'captcha.assist.click_result':
        this.deps.captchaAssist?.onClickResult(env.payload as CaptchaAssistClickResultPayload);
        return null;
      case 'edge.task.acquired':
        this.deps.edgeTaskLeases?.onAcquired(env.payload as EdgeTaskAcquiredPayload, session.edgeId);
        return null;
      case 'edge.task.released':
        this.deps.edgeTaskLeases?.onReleased(env.payload as EdgeTaskReleasedPayload, session.edgeId);
        return null;
      case 'page.cards': {
        const { cards } = env.payload as PageCardsPayload;
        this.bus(session).emit('page.cards.arrived', { cards, ts: this.clock() });
        return null;
      }
      case 'note.detail': {
        const detail = env.payload as NoteDetailPayload;
        // 戳当前笔记 id（v2 现役路径）：action.completed 据此补 noteId（V1 task 9.2）。
        if (detail.noteId) session.currentNoteId = detail.noteId;
        if (detail.refreshOnly) {
          this.bus(session).emit('note.image_snapshot.arrived', { detail, accountId: session.accountId, ts: this.clock() });
          return null;
        }
        // accountId 随事件带出（change interaction-feed-enrichment）：tee 到全局总线后元数据 upsert 按真实账号归属。
        this.bus(session).emit('note.detail.arrived', { detail, accountId: session.accountId, ts: this.clock() });
        // 浏览计数（fix view-count-zero）：成功打开并上报一篇笔记即一次 view。执行端不单独回执 view 动作，
        // 故在此唯一必经入口按账号驱动计数——与 like/collect 同走 interaction.occurred → record('view')，
        // 既补齐面板浏览数（risk_counters），又激活浏览配额与点赞/浏览比例闸门（内存窗口）。
        // view 不入 interaction_feed：其订阅方按动作白名单过滤，浏览不污染「已互动笔记」展示账本。
        this.bus(session).emit('interaction.occurred', {
          action: 'view',
          accountId: session.accountId,
          ...(detail.noteId ? { noteId: detail.noteId } : {}),
        });
        return null;
      }
      case 'profile.detail': {
        const detail = env.payload as ProfileDetailPayload;
        // 戳当前作者 id（change interaction-feed-enrichment）：action.completed 发 follow 时据此补 targetId（关注按作者）。
        if (detail.authorId) session.currentAuthorId = detail.authorId;
        this.bus(session).emit('profile.detail.arrived', { detail, accountId: session.accountId, ts: this.clock() });
        return null;
      }
      // —— 通知巡视（消息查看）：边缘上报 → 入口事件转换 ——
      case 'notification.detected': {
        const p = env.payload as NotificationDetectedPayload;
        this.bus(session).emit('notification.detected.arrived', {
          edgeId: p.edgeId,
          epoch: p.epoch,
          unreadCount: p.unreadCount,
          ts: this.clock(),
        });
        return null;
      }
      case 'notification.home': {
        const p = env.payload as NotificationHomePayload;
        this.bus(session).emit('notification.home.arrived', {
          comments: p.comments,
          likes: p.likes,
          follows: p.follows,
          epoch: p.epoch,
          ts: this.clock(),
        });
        return null;
      }
      case 'notification.items': {
        const p = env.payload as NotificationItemsPayload;
        this.bus(session).emit('notification.items.arrived', {
          items: p.items,
          epoch: p.epoch,
          ts: this.clock(),
        });
        return null;
      }
      case 'action.completed': {
        const rawResult = env.payload as ActionCompletedPayload;
        const result: ActionCompletedPayload = {
          ...rawResult,
          action: normalizeActionCompletedAction(rawResult.action),
        };
        this.bus(session).emit('action.completed', { ...result, ts: this.clock() });
        // 真实成功互动 → 驱动 RiskController 按账号计数（record 订在 interaction.occurred）。
        // already_followed 是良性 no-op，失败 ok=false，均不计——只记真实发生的互动。
        if (
          result.ok &&
          (result.action === 'like' || result.action === 'collect' || result.action === 'follow' || result.action === 'comment' || result.action === 'comment_like' || result.action === 'join_group') &&
          result.reason !== 'already_followed' &&
          (result.action !== 'join_group' || (result.clicked === true && result.reason !== 'already_member' && result.reason !== 'observation_only'))
        ) {
          // 展示账本目标 id（change interaction-feed-enrichment）：关注按作者（currentAuthorId），其余按笔记（currentNoteId）。
          const targetId =
            result.action === 'follow'
              ? session.currentAuthorId
              : result.action === 'join_group'
                ? undefined
                : session.currentNoteId;
          this.bus(session).emit('interaction.occurred', {
            action: result.action as 'like' | 'collect' | 'follow' | 'comment' | 'comment_like' | 'join_group',
            // accountId 从会话填（握手已保证存在）；缺失=上游缺陷，下游 consumer honest-fail 丢弃，绝不回落 default
            accountId: session.accountId,
            // noteId 从会话当前笔记填（V1 task 9.2）：编排已知当前笔记，喂 likedNoteStore + 按笔记互动历史。
            // like/collect 总在 note.detail 之后发生，故 currentNoteId 即被互动笔记；缺则不带（如 follow 在主页）。
            ...(session.currentNoteId ? { noteId: session.currentNoteId } : {}),
            // targetId：喂展示账本 interaction_feed（笔记动作=noteId，关注=authorId）。
            ...(targetId ? { targetId } : {}),
          });
        }
        return null;
      }
      case 'publish.command.result':
        // A 阶段1：按 recordId+seq 关联回 CommandSequencer，驱动序列推进。
        this.deps.commandSequencer?.onResult(env.payload as PublishCommandResultPayload, env.id);
        return null;
      case 'publish.result':
      case 'action.result':
        // 观测类消息：记录即可，不强制回包
        return null;
      default:
        return makeEnvelope('error', env.id, this.clock(), {
          code: 'unsupported_type',
          message: `不支持的消息类型: ${env.type}`,
        });
    }
  }

  private async onHello(env: Envelope, session: EdgeSession): Promise<Envelope> {
    const p = env.payload as HelloPayload;
    session.edgeId = p.edgeId;
    session.platform = p.platform;
    session.app = p.app;
    // 身份落到连接：用于风控归属与验证码事件定位（缺字段安全降级，卡片至少带 edgeId）。
    session.accountId = p.accountId;
    session.accountNickname = typeof p.accountNickname === 'string' ? p.accountNickname.trim() || undefined : undefined;
    session.machineLabel = p.machineLabel;
    session.remoteAddr = p.remoteAddr;
    // 多租户握手（multi-account-node-support）：校验账号身份、登记新账号、建该连接运行时（私有总线 + RoleDispatcher）。
    // 缺/空 accountId → 配置错误拒绝握手（不回 welcome、不建会话、绝不偷映射成 default 开跑，D4）。
    const outcome = (await this.deps.onHandshake?.(session)) ?? ({ ok: true } as const);
    if (!outcome.ok) {
      this.logger.warn('[comm] 握手被拒（配置错误）:', {
        edgeId: p.edgeId,
        code: outcome.code,
        message: outcome.message,
      });
      return makeEnvelope('error', env.id, this.clock(), { code: outcome.code, message: outcome.message });
    }
    // 通知该连接决策层：上线 → 携 accountId emit edge.hello（进私有通道）触发会话启动（经诚实人设/调度闸 D3）。
    this.bus(session).emit('edge.hello', { edgeId: p.edgeId, accountId: session.accountId, ts: this.clock() });
    return makeEnvelope('welcome', env.id, this.clock(), {
      sessionId: session.sessionId,
      serverVersion: this.serverVersion,
      // 节奏快照（change pacing-floor-config-min-interval）：tempo + 每类操作兜底 floor 区间。
      // 纯读风控 status（不写风控态）；握手早于风控态建立 / 解析失败 → 回落 normal(tempo=1.0)。
      // buildPacingSnapshot 是 total 函数：provider 抛错一律返 undefined，绝不 brick 握手。
      pacing: this.buildWelcomePacing(session),
    });
  }

  /**
   * 组装 welcome 的节奏快照。未注入 pacingFloors → undefined（省略字段、向后兼容）。
   * 纯读该连接风控 status（getState 只读）；解析/读态抛错 → 回落 normal。整体不 brick 握手。
   */
  private buildWelcomePacing(session: EdgeSession): PacingSnapshotPayload | undefined {
    const provider = this.deps.pacingFloors;
    if (!provider) return undefined;
    let status: RiskStatus = 'normal';
    let quotaLevel: RiskQuotaLevel = 'normal';
    try {
      const state = this.controllerFor(session).getState();
      status = state.status;
      quotaLevel = state.quotaLevel;
    } catch {
      status = 'normal';
      quotaLevel = 'normal';
    }
    return buildPacingSnapshot(status, quotaLevel, provider);
  }

  private onSessionBudgetRequest(env: Envelope, session: EdgeSession): Envelope {
    const state = this.controllerFor(session).getState();
    const budget = new SessionBudget({ quotaLevel: state.quotaLevel });
    return makeEnvelope('session.budget', env.id, this.clock(), {
      ...budget.snapshot(),
      viewOnly: state.status === 'restricted' || state.status === 'frozen',
      // 注：曾在此挂极薄节奏默认块 pacing: buildPacingDefaults(...)，实为双死通道（边缘从不请求
      // session.budget、也不消费该字段），已于 change pacing-fallback-hardening 移除；兜底默认唯一
      // 下发路径为 welcome 快照，会话中途档位变化经 pacing.update 补推。
    });
  }

  private onRiskCanDo(env: Envelope, session: EdgeSession): Envelope {
    const p = env.payload as RiskCanDoPayload;
    const action = p.action as RiskAction;
    const result = this.controllerFor(session).explain(action);
    return makeEnvelope('risk.canDo.result', env.id, this.clock(), {
      action,
      allowed: result.allowed,
      reason: result.reason,
    });
  }

  private async onRiskRecord(env: Envelope, session: EdgeSession): Promise<Envelope> {
    const p = env.payload as RiskRecordPayload;
    const action = p.action as RiskAction;
    const recorded = await this.controllerFor(session).record(action);
    return makeEnvelope('risk.record.result', env.id, this.clock(), {
      action,
      recorded,
      reason: recorded ? undefined : 'denied',
    });
  }

  /**
   * persona.generate（change edge-persona-keyword-generation）：建号自助人设生成。
   * 以握手绑定 session.accountId 为准（忽略 payload 自报）；幂等在途去重防双计费；生成失败硬 fail-closed。
   */
  private async onPersonaGenerate(env: Envelope, session: EdgeSession): Promise<Envelope> {
    const p = env.payload as PersonaGeneratePayload;
    if (!this.deps.personaGenerator) {
      return makeEnvelope('persona.generate.result', env.id, this.clock(), { ok: false, reason: 'unavailable' });
    }
    if (!session.accountId) {
      this.logger.warn('[persona] persona.generate 会话缺 accountId（握手应已保证）— 诚实回 unknown_account');
      return makeEnvelope('persona.generate.result', env.id, this.clock(), { ok: false, reason: 'unknown_account' });
    }
    const accountId = session.accountId;
    const idempotencyKey = (p.idempotencyKey ?? '').trim();
    if (!idempotencyKey) {
      return makeEnvelope('persona.generate.result', env.id, this.clock(), { ok: false, reason: 'missing_idempotency_key' });
    }
    // 轻量输入校验（change persona-wizard-onboarding-fixes）：垂类/兴趣自由文本引入弱注入面 → 有界爆炸面。
    // 单项长度上限 + 条数上限，超限诚实拒绝、绝不把超长/超量文本原样喂进生成 prompt（accountId 已取握手绑定值、产物另经结构复验）。
    const kws = (p.keywordSelections ?? []).filter((k) => typeof k === 'string');
    const MAX_KEYWORDS = 24;
    const MAX_KEYWORD_LEN = 40;
    if (kws.length > MAX_KEYWORDS || kws.some((k) => k.length > MAX_KEYWORD_LEN)) {
      return makeEnvelope('persona.generate.result', env.id, this.clock(), { ok: false, reason: 'input_too_large' });
    }
    const cacheKey = `${accountId}:${idempotencyKey}`;
    let inflight = this.personaGenInflight.get(cacheKey);
    if (!inflight) {
      inflight = this.runPersonaGenerate(accountId, idempotencyKey, kws)
        .then((res) => {
          // 成功结果保留缓存（重连/重试复用、防双计费）；失败逐出（允许客户重试）。
          if (!res.ok) this.personaGenInflight.delete(cacheKey);
          return res;
        })
        .catch((err) => {
          this.personaGenInflight.delete(cacheKey);
          this.logger.warn(`[persona] persona.generate 异常: ${(err as Error).message}`);
          return { ok: false, reason: 'generation_failed' } as PersonaGenerateResultPayload;
        });
      this.personaGenInflight.set(cacheKey, inflight);
    }
    const result = await inflight;
    return makeEnvelope('persona.generate.result', env.id, this.clock(), result);
  }

  private async runPersonaGenerate(
    accountId: string,
    idempotencyKey: string,
    keywordSelections: string[],
  ): Promise<PersonaGenerateResultPayload> {
    // 每账号差异化种子：拌 accountId + 幂等键（每次「生成/重新生成」都带新键 → 有区分度），抗跨账号同质化。
    const diversitySeed = `account:${accountId}|nonce:${idempotencyKey}`;
    const outcome = await this.deps.personaGenerator!.generate({ accountId, keywordSelections, diversitySeed });
    if (outcome.ok) {
      return { ok: true, soulYaml: outcome.soulYaml, identitySummary: outcome.identitySummary };
    }
    return { ok: false, reason: outcome.reason };
  }

  /**
   * persona.persist（change edge-persona-keyword-generation）：落库客户确认后的人设。
   * 复用 setPersona 全套（FK/空/soul 校验/落库/绑定唤醒）；以握手绑定 accountId 为准防越权；unknown_account 为正常分支诚实回执。
   */
  private async onPersonaPersist(env: Envelope, session: EdgeSession): Promise<Envelope> {
    const p = env.payload as PersonaPersistPayload;
    if (!this.deps.personaFacade) {
      return makeEnvelope('persona.persist.result', env.id, this.clock(), { ok: false, reason: 'unavailable' });
    }
    if (!session.accountId) {
      this.logger.warn('[persona] persona.persist 会话缺 accountId（握手应已保证）— 诚实回 unknown_account');
      return makeEnvelope('persona.persist.result', env.id, this.clock(), { ok: false, reason: 'unknown_account' });
    }
    const result = await this.deps.personaFacade.setPersona(
      session.accountId,
      p.soulYaml ?? '',
      `edge-onboarding:${session.accountId}`,
    );
    return makeEnvelope(
      'persona.persist.result',
      env.id,
      this.clock(),
      result.ok ? { ok: true } : { ok: false, reason: result.reason },
    );
  }

  private async onPlan(env: Envelope, pusher?: EdgePusher): Promise<Envelope> {
    const p = env.payload as PlanRequestPayload;
    const plan = await this.deps.planner.plan({ goal: p.goal, context: p.context });
    const response = makeEnvelope('plan.response', env.id, this.clock(), {
      steps: plan.steps,
      reason: plan.reason,
    });
    // 控制端（如 trigger-like）可要求把命令主动下发给已上线边缘：
    // context.dispatch === 'edge' 时，把规划结果推给边缘（可选 context.edgeId 定向）。
    if (pusher && p.context && p.context.dispatch === 'edge' && plan.steps.length > 0) {
      const sent = pusher.pushToEdges(response, p.context.edgeId);
      return makeEnvelope('plan.response', env.id, this.clock(), {
        steps: plan.steps,
        reason: plan.reason + ';dispatched_to=' + sent,
      });
    }
    return response;
  }

  private async onSelect(env: Envelope): Promise<Envelope> {
    const p = env.payload as SelectRequestPayload;
    if (!p.elements || p.elements.length === 0) {
      return makeEnvelope('select.response', env.id, this.clock(), {
        index: null,
        reason: 'empty_element_list',
      });
    }
    let raw: string;
    try {
      raw = await this.deps.llm.complete(buildSelectionPrompt(p.goal, p.elements));
    } catch (err) {
      return makeEnvelope('select.response', env.id, this.clock(), {
        index: null,
        reason: `llm_error:${(err as Error).message}`,
      });
    }
    const n = parseIndex(raw);
    if (n === null) {
      return makeEnvelope('select.response', env.id, this.clock(), {
        index: null,
        reason: `unparsable_output:${raw.slice(0, 40)}`,
      });
    }
    if (n < 0) {
      return makeEnvelope('select.response', env.id, this.clock(), {
        index: null,
        reason: 'llm_no_match',
      });
    }
    const exists = p.elements.some((e) => e.index === n);
    if (!exists) {
      return makeEnvelope('select.response', env.id, this.clock(), {
        index: null,
        reason: `index_out_of_range:${n}`,
      });
    }
    return makeEnvelope('select.response', env.id, this.clock(), {
      index: n,
      reason: 'llm_selected',
    });
  }

  private async onAnchorGet(env: Envelope): Promise<Envelope> {
    const p = env.payload as AnchorGetPayload;
    const anchor = await this.deps.cache.get(p.actionId);
    return makeEnvelope('anchor.get.result', env.id, this.clock(), { anchor });
  }

  private async onAnchorReport(env: Envelope): Promise<Envelope | null> {
    const p = env.payload as AnchorReportPayload;
    if (p.source === 'cache') {
      if (p.validated) await this.deps.cache.recordHit(p.actionId);
      else await this.deps.cache.recordFailure(p.actionId);
    } else {
      // llm 来源：反污染暂存→确认→晋升
      if (p.validated && p.candidate) {
        await this.deps.cache.stage(p.candidate);
        await this.deps.cache.confirmStaged(p.actionId);
      } else {
        await this.deps.cache.dropStaged(p.actionId);
      }
    }
    return null;
  }

  private async onPublishApprovalRequest(env: Envelope, session: EdgeSession): Promise<void> {
    const payload = env.payload as Partial<PublishApprovalRequestPayload>;
    if (
      typeof payload.requestId !== 'string' ||
      typeof payload.title !== 'string' ||
      typeof payload.content !== 'string' ||
      !Array.isArray(payload.tags) ||
      payload.tags.some((tag) => typeof tag !== 'string')
    ) {
      throw new Error('invalid_publish_approval_request');
    }
    if (!this.deps.messenger) {
      throw new Error('publish_approval_chat_not_configured');
    }
    this.logger.log('[comm] 收到 publish.approval_request:', {
      requestId: payload.requestId,
      edgeId: payload.edgeId ?? session.edgeId,
      sessionId: session.sessionId,
    });
    let defaultChat = null;
    try {
      defaultChat = await this.deps.botChatStore?.getDefaultChat();
      this.logger.log('[comm] publish.approval_request 默认群查询完成:', {
        requestId: payload.requestId,
        defaultChatId: defaultChat?.chatId ?? null,
        defaultChatName: defaultChat?.chatName ?? null,
      });
    } catch (error) {
      this.logger.warn('[comm] publish.approval_request 默认群查询失败，回退 FEISHU_CHAT_ID:', {
        requestId: payload.requestId,
        message: error instanceof Error ? error.message : String(error),
      });
    }
    const chatId = defaultChat?.chatId ?? this.deps.approvalChatId ?? process.env.FEISHU_CHAT_ID ?? '';
    if (!chatId) {
      const message = '未配置默认审批群：请先在目标飞书群发送 /bind 设为默认审批群，或配置 FEISHU_CHAT_ID 作为兜底。';
      this.logger.error('[comm] publish.approval_request 缺少目标群:', {
        requestId: payload.requestId,
        edgeId: payload.edgeId ?? session.edgeId,
        hint: message,
      });
      throw new Error(message);
    }
    try {
      this.logger.log('[comm] publish.approval_request 目标群解析完成:', {
        requestId: payload.requestId,
        edgeId: payload.edgeId ?? session.edgeId,
        chatId,
        source: defaultChat?.chatId ? 'bot_chats.default' : this.deps.approvalChatId || process.env.FEISHU_CHAT_ID ? 'env.FEISHU_CHAT_ID' : 'none',
        chatName: defaultChat?.chatName ?? null,
      });
      await this.deps.messenger.sendApprovalCard(
        chatId,
        buildPublishApprovalCard({
          requestId: payload.requestId,
          title: payload.title,
          content: payload.content,
          tags: payload.tags,
        }),
      );
      this.logger.log('[comm] publish.approval_request 发卡成功:', {
        requestId: payload.requestId,
        edgeId: payload.edgeId ?? session.edgeId,
        chatId,
      });
    } catch (error) {
      this.logger.error('[comm] publish.approval_request 发卡失败:', {
        requestId: payload.requestId,
        edgeId: payload.edgeId ?? session.edgeId,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
