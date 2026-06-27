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
  type RiskCanDoPayload,
  type RiskRecordPayload,
  type PageCardsPayload,
  type NoteDetailPayload,
  type ProfileDetailPayload,
  type ActionCompletedPayload,
  type CaptchaDetectedPayload,
  type CaptchaClearedPayload,
  type NotificationDetectedPayload,
  type NotificationHomePayload,
  type NotificationItemsPayload,
  type PublishCommandResultPayload,
} from './protocol.js';
import type { CommandSequencer } from '../publish-agent/command-sequencer.js';
import type { MessageHandler, EdgeSession, EdgePusher } from './ws-server.js';
import type { CaptchaCoordinator } from './captcha-coordinator.js';
import type { TaskPlanner } from '../planner/types.js';
import type { LlmClient } from '../llm/qwen.js';
import type { EventBus } from '../event-bus/index.js';
import { buildPublishApprovalCard } from '../feishu/cards.js';
import type { FeishuMessenger } from '../feishu/messenger.js';
import type { BotChatStore } from '../cache/bot-chat-store.js';
import { RiskController, SessionBudget, buildPacingDefaults } from '../risk/index.js';
import type { RiskAction } from '../risk/index.js';
import type { AccountStateManager } from '../account-state.js';

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
  /** A 阶段1 发布指令编排器：消费 publish.command.result 关联回报（未注入则忽略，向后兼容）。 */
  commandSequencer?: Pick<CommandSequencer, 'onResult'>;
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

        // 暂停检查：已暂停则仅返回 ack，不触发 orchestrator。
        // 多租户：按连接真实账号判暂停（缺失回退 default，向后兼容 legacy edge）。
        if (this.deps.accountState?.isPaused(session.accountId ?? 'default')) {
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
      case 'session.budget.request':
        return this.onSessionBudgetRequest(env, session);
      case 'risk.canDo':
        return this.onRiskCanDo(env, session);
      case 'risk.record':
        return this.onRiskRecord(env, session);
      case 'risk.captcha_detected':
        await this.deps.captcha?.onDetected(env.payload as CaptchaDetectedPayload, session, pusher);
        return null;
      case 'risk.captcha_cleared':
        await this.deps.captcha?.onCleared(env.payload as CaptchaClearedPayload, session, pusher);
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
        // accountId 随事件带出（change interaction-feed-enrichment）：tee 到全局总线后元数据 upsert 按真实账号归属。
        this.bus(session).emit('note.detail.arrived', { detail, accountId: session.accountId ?? 'default', ts: this.clock() });
        // 浏览计数（fix view-count-zero）：成功打开并上报一篇笔记即一次 view。执行端不单独回执 view 动作，
        // 故在此唯一必经入口按账号驱动计数——与 like/collect 同走 interaction.occurred → record('view')，
        // 既补齐面板浏览数（risk_counters），又激活浏览配额与点赞/浏览比例闸门（内存窗口）。
        // view 不入 interaction_feed：其订阅方按动作白名单过滤，浏览不污染「已互动笔记」展示账本。
        this.bus(session).emit('interaction.occurred', {
          action: 'view',
          accountId: session.accountId ?? 'default',
          ...(detail.noteId ? { noteId: detail.noteId } : {}),
        });
        return null;
      }
      case 'profile.detail': {
        const detail = env.payload as ProfileDetailPayload;
        // 戳当前作者 id（change interaction-feed-enrichment）：action.completed 发 follow 时据此补 targetId（关注按作者）。
        if (detail.authorId) session.currentAuthorId = detail.authorId;
        this.bus(session).emit('profile.detail.arrived', { detail, accountId: session.accountId ?? 'default', ts: this.clock() });
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
        const result = env.payload as ActionCompletedPayload;
        this.bus(session).emit('action.completed', { ...result, ts: this.clock() });
        // 真实成功互动 → 驱动 RiskController 按账号计数（record 订在 interaction.occurred）。
        // already_followed 是良性 no-op，失败 ok=false，均不计——只记真实发生的互动。
        if (
          result.ok &&
          (result.action === 'like' || result.action === 'collect' || result.action === 'follow' || result.action === 'comment' || result.action === 'comment_like') &&
          result.reason !== 'already_followed'
        ) {
          // 展示账本目标 id（change interaction-feed-enrichment）：关注按作者（currentAuthorId），其余按笔记（currentNoteId）。
          const targetId = result.action === 'follow' ? session.currentAuthorId : session.currentNoteId;
          this.bus(session).emit('interaction.occurred', {
            action: result.action as 'like' | 'collect' | 'follow' | 'comment' | 'comment_like',
            // accountId 从会话填；缺失（legacy edge）回退保留键 'default'，绝不误并入真名账号（D3/D4）
            accountId: session.accountId ?? 'default',
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
    session.app = p.app;
    // 身份落到连接：用于风控归属与验证码事件定位（缺字段安全降级，卡片至少带 edgeId）。
    session.accountId = p.accountId;
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
    });
  }

  private onSessionBudgetRequest(env: Envelope, session: EdgeSession): Envelope {
    const state = this.controllerFor(session).getState();
    const budget = new SessionBudget({ quotaLevel: state.quotaLevel });
    return makeEnvelope('session.budget', env.id, this.clock(), {
      ...budget.snapshot(),
      viewOnly: state.status === 'restricted' || state.status === 'frozen',
      // 极薄节奏默认块（仅边缘自主动作 / 断连兜底用；内容相关时长随决策指令下发）
      pacing: buildPacingDefaults(state.status),
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



