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
  CLIENT_CORE_BROWSER_EXECUTOR_CAPABILITY,
  CLIENT_DATA_PLANE_AUTOMATION_ENGINE_CAPABILITY,
  SEARCH_ACTIVITY_RECEIPT_CAPABILITY,
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
  type PublishDraftImageRemovePayload,
  type PublishDraftImageRemoveResultPayload,
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
import {
  MAX_PERSONA_KEYWORDS,
  MAX_PERSONA_KEYWORD_LENGTH,
  type AccountPersonaService,
} from '../config/account-persona-service.js';
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
import { normalizePlatformId, resolveReadSurface } from '../platform/index.js';
import {
  facebookPostKey,
  isCanonicalFacebookFeedVideoNoteId,
} from '../platform/facebook-presented-video.js';
import { isWritingLanguage } from '../soul/writing-language.js';
import type { WritingLanguage } from '../soul/types.js';
import type { PacingSnapshotPayload } from './protocol.js';
import type { AccountStateManager } from '../account-state.js';
import {
  parseAuthStatusPayload,
  parseOffboardResultPayload,
  parseReplyReconcileResultPayload,
  parseReplyResultPayload,
  parseSyncBatchPayload,
} from '../interactions/contract.js';
import {
  INTERACTION_CAPABILITY,
  INTERACTION_BROWSER_CONTROL_CAPABILITY,
  INTERACTION_OFFBOARDING_CAPABILITY,
  INTERACTION_PLATFORM,
  INTERACTION_REPLY_RECOVERY_CAPABILITY,
  INTERACTION_RUNTIME_CONTROLS_CAPABILITY,
  INTERACTION_TEST_DATA_RESET_CAPABILITY,
  InteractionError,
  type InteractionAuthStatusPayload,
  type InteractionOffboardAckPayload,
  type InteractionOffboardResultPayload,
  type InteractionReplyReconcileResultPayload,
  type InteractionReplyResultPayload,
  type InteractionReplyResultAckPayload,
  type InteractionRuntimeControlsPayload,
  type InteractionSyncAckPayload,
  type InteractionSyncBatchPayload,
} from '../interactions/types.js';

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
  /**
   * 卡片目标统一解析（change unify-card-routing-origin-then-team）：来源会话 → 账号团队群 → 默认群。
   * 注入后取代下面 botChatStore.getDefaultChat 的默认群兜底——边缘发起的发布审批卡由此按会话账号
   * 进入团队群。未注入（桩 / 旧构造）→ 保持既有默认群链，行为逐字不变。
   */
  resolveCardChatId?: (originChatId: string | undefined, accountId: string | undefined) => Promise<string>;
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
   * 风控记账漏斗（change risk-state-cross-process-integrity，design D5）。
   *
   * 边缘确认真实动作后，**先同步把既成事实提交进持久 outbox，再 emit 推进浏览闭环**。
   * 入队失败 MUST 抛给调用方（ws 层会回一条 error 帧并触发该账号 fail-closed），
   * MUST NOT 吞掉后照常 emit——那正是改动前那条 fire-and-forget 链路的病：崩在
   * 「回执已到、计数未提交」之间就静默丢账，后续配额判定据此以为尚有余量而放行更多真实动作。
   *
   * 未注入（纯协议测试 / 旧装配）→ 保持改动前行为：直接 emit，记账由订阅者承担。
   */
  riskAccounting?: {
    enqueue(input: {
      accountId: string;
      action: RiskAction;
      occurredAt?: number;
      dedupeKey: string;
    }): Promise<void>;
    /** 入队 + 立即 apply，返回写入前判定（保留通道 `risk.record` 用）。 */
    record(input: {
      accountId: string;
      action: RiskAction;
      occurredAt?: number;
      dedupeKey: string;
    }): Promise<{ allowed: boolean }>;
  };
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
  /**
   * Durable first-post onboarding state. `armFirstBind` returns true only when this
   * persist created the account's lifetime row; unavailable storage disables the
   * promise instead of showing a UI whose automatic follow-up cannot run.
   */
  firstPostOnboarding?: { armFirstBind(accountId: string): Promise<boolean> };
  /** Production single-account persona path shared by WebSocket and customer-auth HTTP. */
  personaService?: Pick<AccountPersonaService, 'generate' | 'persist'>;
  /** 客户端稿件预览内的发布/取消审批动作。未注入则诚实返回 unavailable。 */
  publishApprovalAction?: (
    payload: PublishApprovalActionPayload,
    session: EdgeSession,
  ) => Promise<PublishApprovalActionResultPayload>;
  /** 客户端稿件预览内删除待审稿件的某张配图。未注入则诚实返回 unavailable。 */
  publishDraftImageRemove?: (
    payload: PublishDraftImageRemovePayload,
    session: EdgeSession,
  ) => Promise<PublishDraftImageRemoveResultPayload>;
  /** 冻结 interaction v1 入站消费端；未注入时 capability 不在 welcome 中启用。 */
  interactionInbox?: {
    onAuthStatus(payload: InteractionAuthStatusPayload): Promise<void>;
    onSyncBatch(payload: InteractionSyncBatchPayload): Promise<InteractionSyncAckPayload>;
    onReplyResult(payload: InteractionReplyResultPayload): Promise<{ duplicate: boolean }>;
    onReplyReconcileResult(payload: InteractionReplyReconcileResultPayload): Promise<void>;
    onOffboardResult(payload: InteractionOffboardResultPayload): Promise<{ duplicate: boolean }>;
    hasPendingOffboard?(accountId: string): Promise<boolean>;
  };
  /** Versioned account controls included in welcome only after capability negotiation. */
  interactionRuntimeControls?: {
    getSnapshot(accountId: string): Promise<InteractionRuntimeControlsPayload>;
  };
}

function disabledInteractionRuntimeControls(accountId: string): InteractionRuntimeControlsPayload {
  return {
    accountId,
    envKey: accountId,
    version: 0,
    commentsReadEnabled: false,
    commentsReplyEnabled: false,
    dmReadEnabled: false,
    dmSendTextEnabled: false,
    dmSendImageEnabled: false,
  };
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

/** 非空、非数组的普通对象判定（用于收窄 action.completed 的 observation 独立见证包）。 */
function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
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

  /**
   * 灰度回滚计数（change platform-browse-protocol）：独立见证与选中卡不符（target_mismatch）累计次数。
   * 聚合指标（跨连接），供信息流就地点赞灰度期观测「点错卡」率；只增不控制流。
   */
  private targetMismatchCount = 0;

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

  /**
   * 把一次「边缘已确认真实发生」的动作同步提交进记账 outbox（change risk-state-cross-process-integrity）。
   * 缺 accountId → 不入队（与既有 honest-fail 一致：绝不把脏流量记到退役键名下）。
   * 漏斗未注入 → no-op（旧装配与纯协议测试保持改动前行为）。
   * **入队失败刻意向上抛**：调用点据此不 emit、不推进闭环。
   */
  private async enqueueRiskFact(session: EdgeSession, action: RiskAction, dedupeKey: string): Promise<void> {
    const accountId = session.accountId?.trim();
    if (!accountId || !this.deps.riskAccounting) return;
    await this.deps.riskAccounting.enqueue({ accountId, action, occurredAt: this.clock(), dedupeKey });
  }

  /**
   * note-scoped 互动（like/collect）的血缘归账仲裁（change platform-browse-protocol）。
   * 返回写入 interaction.occurred 的 noteId（undefined=拒写血缘；风控仍按真实发生计数、不写 liked_notes 血缘）。
   * 阶段 0（readSurface 恒 detail、无派生 noteId、无 observation）逐位回落 session.currentNoteId=今天行为。
   *
   * 优先级：
   *  1) 回执带独立见证 observation ⇒ 逐字段比对选中卡：不符=target_mismatch⇒拒写血缘+审计+灰度回滚计数；
   *     相符=选中卡被独立见证证实⇒用派生 noteId ?? currentNoteId；查不到选中卡=无法证实⇒拒写（fail-closed）。
   *  2) 无 observation 但带派生 noteId ⇒ 用派生 noteId（信息流就地互动的权威被点 id）。
   *  3) 无 observation 无派生 noteId 且 readSurface==='feed' 且边缘声明 inline_targeting ⇒ 拒写血缘+审计
   *     （feed 上无法证实点了哪张，MUST NOT 回落 currentNoteId——版本偏斜闸）。
   *  4) 其余（详情页 / 老边端）⇒ session.currentNoteId（今天行为，零回归）。
   */
  private attributeNoteScopedNoteId(
    session: EdgeSession,
    result: ActionCompletedPayload,
    readSurface: 'feed' | 'detail',
  ): string | undefined {
    const derived = typeof result.noteId === 'string' && result.noteId.length > 0 ? result.noteId : undefined;
    if (isRecord(result.observation)) {
      const verdict = this.witnessVerdict(session, result.observation);
      if (verdict === 'mismatch') {
        this.targetMismatchCount += 1;
        this.logger.warn(
          `[comm] 互动 target_mismatch：独立见证与选中卡不符 → 拒写血缘（风控仍计数）action=${result.action} mismatchCount=${this.targetMismatchCount}`,
        );
        return undefined;
      }
      if (verdict === 'match') return derived ?? session.currentNoteId;
      // 'unknown'：回执带见证却定位不到选中卡 → 无法证实归属，fail-closed 拒写血缘（绝不猜）。
      this.logger.warn('[comm] 互动带独立见证却无匹配选中卡 → 拒写血缘（无法证实归属）');
      return undefined;
    }
    if (derived) return derived;
    if (readSurface === 'feed' && (session.capabilities ?? []).includes('inline_targeting')) {
      this.logger.warn(
        `[comm] feed-surface 互动回执缺派生 noteId → 拒记账（不回落 currentNoteId）action=${result.action}`,
      );
      return undefined;
    }
    return session.currentNoteId;
  }

  /**
   * 逐字段比对回执独立见证（现读被点 article）与最近一批 page.cards 里的选中卡（编排本意要点的那张，
   * 按 session.currentNoteId 在 lastCards 中定位）。author / textPreviewHead 任一实证不符 ⇒ 'mismatch'；
   * 定位不到选中卡 ⇒ 'unknown'；否则 'match'。字段缺失不下负面结论（缺席≠不符）。
   */
  private witnessVerdict(
    session: EdgeSession,
    observation: Record<string, unknown>,
  ): 'match' | 'mismatch' | 'unknown' {
    const selected = session.lastCards?.find((c) => c.noteId && c.noteId === session.currentNoteId);
    if (!selected) return 'unknown';
    const obsAuthor = typeof observation.author === 'string' ? observation.author.trim() : undefined;
    const cardAuthor = typeof selected.author === 'string' ? selected.author.trim() : undefined;
    if (obsAuthor && cardAuthor && obsAuthor !== cardAuthor) return 'mismatch';
    const obsHead = typeof observation.textPreviewHead === 'string' ? observation.textPreviewHead.trim() : undefined;
    const cardTitle = typeof selected.title === 'string' ? selected.title.trim() : undefined;
    if (obsHead && cardTitle && !obsHead.startsWith(cardTitle) && !cardTitle.startsWith(obsHead)) return 'mismatch';
    return 'match';
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
      case 'interaction.auth.status':
        return this.onInteractionAuthStatus(env, session);
      case 'interaction.sync.batch':
        return this.onInteractionSyncBatch(env, session);
      case 'interaction.reply.result':
        return this.onInteractionReplyResult(env, session);
      case 'interaction.reply.reconcile.result':
        return this.onInteractionReplyReconcileResult(env, session);
      case 'interaction.offboard.result':
        return this.onInteractionOffboardResult(env, session);
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
      case 'publish.draft_image_remove': {
        const payload = env.payload as PublishDraftImageRemovePayload;
        const result = this.deps.publishDraftImageRemove
          ? await this.deps.publishDraftImageRemove(payload, session)
          : { requestId: payload?.requestId ?? '', ok: false, reason: 'unavailable' };
        return makeEnvelope('publish.draft_image_remove.result', env.id, this.clock(), result);
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
        const { cards, startupId, documentGeneration, listKind, listState } = env.payload as PageCardsPayload;
        // 留存最近一批卡快照（change platform-browse-protocol）：note-scoped 互动回执带独立见证 observation 时，
        // 归账仲裁据此逐字段比对选中卡（信息流就地点赞防点错卡）。详情页/无 observation 时不消费——阶段 0 惰性。
        session.lastCards = cards;
        // Reels 与普通 feed 的语义不同：单卡就是当前已经呈现、正在播放的内容，不需要等 content_evaluator
        // 再决定「打开」才算浏览。每次 Edge 上报的新活动 Reel 当场记一次 view，避免不感兴趣/外语内容全部
        // skip 后 view 永远为 0、会话只剩无限 scroll。Edge 的 Reels session 已保证每次 cards 是一个新活动
        // 视频；Cloud 只接受单卡形态，畸形多卡/空卡 fail-closed 不记。
        //
        // 仍保留 page.cards.arrived：内容选择、点赞与目标见证继续走现有链路，浏览事实绝不强迫点赞。
        const facebook = normalizePlatformId(session.platform) === 'facebook';
        if (facebook && listKind === 'reels' && cards.length === 1) {
          const noteId = cards[0]?.noteId;
          session.countedReelViewNoteId = noteId;
          this.bus(session).emit('interaction.occurred', {
            action: 'view',
            accountId: session.accountId,
            ...(noteId ? { noteId } : {}),
          });
        } else {
          // 任一后续普通/空/畸形列表都结束「当前 Reel 已记 view」关联，不能抑制未来普通详情记账。
          session.countedReelViewNoteId = undefined;
        }
        // 普通 Feed 的严格主视频也已真实呈现：同一连接按规范视频身份只记一次，后续 detail 不重复。
        // 畸形多视频批次、非规范目标或其它平台不记，避免把 mounted rail / 错误标记扩成浏览事实。
        if (facebook && listKind === 'feed') {
          const videos = cards.filter((card) => card.isVideo === true);
          const noteId = videos.length === 1 ? videos[0]?.noteId : undefined;
          if (isCanonicalFacebookFeedVideoNoteId(noteId)) {
            const key = facebookPostKey(noteId);
            const counted = session.countedFacebookFeedVideoViewKeys ?? new Set<string>();
            session.countedFacebookFeedVideoViewKeys = counted;
            if (!counted.has(key)) {
              counted.add(key);
              this.bus(session).emit('interaction.occurred', {
                action: 'view',
                accountId: session.accountId,
                noteId,
              });
            }
          }
        }
        // 只有 Facebook + 现有 feed 列表 + 0 卡 + Edge 明确 empty 四条件同时满足才产生 fallback 候选。
        // 未确认 0 卡、Reels 空批、其它平台或畸形 empty+cards 均走普通 page.cards，绝不扩大为空态。
        if (normalizePlatformId(session.platform) === 'facebook' && listKind === 'feed' && listState === 'empty' && cards.length === 0) {
          this.bus(session).emit('feed.empty.confirmed', {
            ...(startupId ? { startupId } : {}),
            ...(documentGeneration ? { documentGeneration } : {}),
            ts: this.clock(),
          });
          return null;
        }
        // 只有 Facebook 首页 Feed 的 0 卡结构观察可触发该事件。它不进入内容评估，也不冒充 empty；
        // Cloud 仅把它视为一次列表选择候选，最终 Reels 导航仍由 dispatcher 单点授权。
        if (
          normalizePlatformId(session.platform) === 'facebook' &&
          listKind === 'feed' &&
          listState === 'present_unreportable' &&
          cards.length === 0
        ) {
          this.bus(session).emit('feed.present_unreportable.confirmed', {
            ...(startupId ? { startupId } : {}),
            ...(documentGeneration ? { documentGeneration } : {}),
            ts: this.clock(),
          });
          return null;
        }
        this.bus(session).emit('page.cards.arrived', {
          cards,
          ...(startupId ? { startupId } : {}),
          ...(listKind ? { listKind } : {}),
          ts: this.clock(),
        });
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
        const reelViewAlreadyCounted =
          !!detail.noteId && detail.noteId === session.countedReelViewNoteId;
        const feedVideoViewAlreadyCounted =
          !!detail.noteId && !!session.countedFacebookFeedVideoViewKeys?.has(facebookPostKey(detail.noteId));
        if (!reelViewAlreadyCounted && !feedVideoViewAlreadyCounted) {
          this.bus(session).emit('interaction.occurred', {
            action: 'view',
            accountId: session.accountId,
            ...(detail.noteId ? { noteId: detail.noteId } : {}),
          });
        }
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
        let emitActionCompleted = true;
        if (result.action === 'search' && (session.capabilities ?? []).includes(SEARCH_ACTIVITY_RECEIPT_CAPABILITY)) {
          const activityId = typeof result.activityId === 'string' ? result.activityId.trim() : '';
          const outcome = result.searchOutcome;
          if (!activityId) {
            this.logger.warn('[comm] search action.completed 缺 activityId — 不记平台事实（honest-fail）');
            emitActionCompleted = false;
          } else if (outcome === 'results_ready' || outcome === 'no_results' || outcome === 'failed_after_submit' || outcome === 'not_submitted') {
            const completed = session.completedSearchActivityIds ??= new Set<string>();
            if (completed.has(activityId)) {
              this.logger.warn(`[comm] search action.completed 重复 activityId=${activityId} — 不重复记账`);
              emitActionCompleted = false;
            } else {
              const pending = session.pendingSearchActivities;
              const expected = pending?.get(activityId);
              if (!expected) {
                this.logger.warn(`[comm] search action.completed 未知 activityId=${activityId} — 不记平台事实`);
                emitActionCompleted = false;
              } else {
                pending!.delete(activityId);
                if (completed.size >= 256) {
                  const oldest = completed.values().next().value as string | undefined;
                  if (oldest) completed.delete(oldest);
                }
                completed.add(activityId);
                const purposeMatches = result.purpose === undefined || result.purpose === expected.purpose;
                const scopeMatches = result.scope === undefined || result.scope === expected.scope;
                const resultCountValid = result.resultCount === undefined
                  || (Number.isInteger(result.resultCount) && result.resultCount >= 0);
                const terminalValid =
                  ((outcome === 'results_ready' || outcome === 'no_results') && result.ok === true && result.actuated === true)
                  || (outcome === 'failed_after_submit' && result.ok === false && result.actuated === true)
                  || (outcome === 'not_submitted' && result.ok === false && result.actuated === false);
                if (!purposeMatches || !scopeMatches || !resultCountValid || !terminalValid) {
                  this.logger.warn(`[comm] search action.completed 矛盾终态 activityId=${activityId} — 已消费但不记平台事实`);
                  emitActionCompleted = false;
                } else if (result.actuated === true && outcome !== 'not_submitted') {
                  // 先落持久 outbox，再推进（design D5）。搜索的去重键用 activityId：它每次搜索唯一，
                  // 且边缘重连重发同一条终态时携带同一个 activityId ⇒ 天然只记一次。
                  await this.enqueueRiskFact(session, 'search', `${env.id}:search:${activityId}`);
                  this.bus(session).emit('search.occurred', {
                    accountId: session.accountId,
                    activityId,
                    purpose: expected.purpose,
                    scope: expected.scope,
                    outcome,
                    ...(result.resultCount !== undefined
                      ? { resultCount: result.resultCount }
                      : {}),
                  });
                }
              }
            }
          } else {
            this.logger.warn(`[comm] search action.completed 非法/缺失 searchOutcome activityId=${activityId || '-'} — 不记平台事实`);
            emitActionCompleted = false;
          }
        }
        if (emitActionCompleted) this.bus(session).emit('action.completed', { ...result, ts: this.clock() });
        // 真实发生的动作 → 驱动 RiskController 按账号计数（record 订在 interaction.occurred）。
        // 判据分两轴（change fb-join-quota-counts-attempts）：
        //   · like/collect/follow/comment/comment_like —— ok=true 才算真实互动（already_followed 是良性 no-op，不计）。
        //   · join_group —— 配额是**风控预算**，计的是「真的抵达 Facebook 的入群动作」，故判据是 clicked 而非 ok：
        //     clicked=true 是边缘**事后回执**说它在真实页面上点了（既成事实）；ok 只是平台对我们**已做之事**的回答
        //     （批了 / 待管理员审批 / 要答题），MUST NOT 决定这次动作算不算数。于是点了但待审批（ok:false,
        //     clicked:true）照计；没抵达平台的（点前就已待审批 / already_member / observation_only / 导航登录
        //     在点击前先失败）clicked 非 true，天然不计——无需任何 reason 分支。
        //   注：`ok` 这一轴仍逐位管着其余五个动作，MUST NOT 整条删除（删了 = 失败的点赞/评论被记成真互动，
        //   直接踩「绝不静默假成功」红线）。这里只把 join_group 从它的合取下解出来。
        //   注：本闸只决定 emit；真正的计数在 interaction.occurred 的订阅者里。**emit 即落数**——
        //   record 已改为无条件写入既成事实（change risk-record-actuated-facts），账号被限 / 配额已耗尽
        //   时它照样记下（只是返回 false 表示「超策略」）。此前它会在那两种情况下静默丢弃，那是本闸
        //   上一层的同一个病：拿「该不该」去回答「有没有」。
        if (
          (result.ok || result.action === 'join_group') &&
          (result.action === 'like' || result.action === 'collect' || result.action === 'follow' || result.action === 'comment' || result.action === 'comment_like' || result.action === 'join_group') &&
          result.reason !== 'already_followed' &&
          (result.action !== 'join_group' || (result.clicked === true && result.reason !== 'already_member' && result.reason !== 'observation_only'))
        ) {
          // 血缘归账 noteId（change platform-browse-protocol）：like/collect 走独立见证仲裁（派生 id / 见证比对 /
          // feed-surface 拒记账），follow/comment/comment_like/join_group 保持 currentNoteId（今天行为，逐位不变）。
          // 阶段 0（readSurface 恒 detail、无派生 id、无 observation）⇒ 仲裁恒回落 currentNoteId ⇒ 零回归。
          const readSurface = resolveReadSurface(session.platform);
          const attributedNoteId =
            result.action === 'like' || result.action === 'collect'
              ? this.attributeNoteScopedNoteId(session, result, readSurface)
              : session.currentNoteId;
          // 展示账本目标 id（change interaction-feed-enrichment）：关注按作者（currentAuthorId），其余按笔记。
          const targetId =
            result.action === 'follow'
              ? session.currentAuthorId
              : result.action === 'join_group'
                ? undefined
                : attributedNoteId;
          // **先落持久 outbox，再 emit 推进浏览闭环**（design D5）。顺序不可换：emit 之后再记账
          // 就回到了「回执已到、计数未提交」那段真空——崩在那里这次真实动作就此从账本上消失。
          // 入队失败会抛出（并已在漏斗内告警 + 对该账号 fail-closed），此处刻意不 catch。
          await this.enqueueRiskFact(session, result.action as RiskAction, `${env.id}:${result.action}`);
          this.bus(session).emit('interaction.occurred', {
            action: result.action as 'like' | 'collect' | 'follow' | 'comment' | 'comment_like' | 'join_group',
            // accountId 从会话填（握手已保证存在）；缺失=上游缺陷，下游 consumer honest-fail 丢弃，绝不回落 default
            accountId: session.accountId,
            // noteId：归账仲裁产出（拒写血缘时为 undefined，此时省略字段——风控仍计数、liked_notes 不写）。
            // like/collect 总在 note.detail 之后（详情页）或就地互动后发生；缺则不带（如 follow 在主页）。
            ...(attributedNoteId ? { noteId: attributedNoteId } : {}),
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
    // 边缘能力位（change platform-browse-protocol）：含 inline_targeting 时启用 feed-surface 归账版本偏斜闸。
    session.capabilities = Array.isArray(p.capabilities) ? p.capabilities : undefined;
    // 身份落到连接：用于风控归属与验证码事件定位（缺字段安全降级，卡片至少带 edgeId）。
    session.accountId = p.accountId;
    session.accountNickname = typeof p.accountNickname === 'string' ? p.accountNickname.trim() || undefined : undefined;
    session.machineLabel = p.machineLabel;
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
    // 这里只完成传输协商。浏览业务运行时与 edge.hello 在 ws-server 写出 welcome、登记在线路由后激活，
    // 防止人设/调度/角色构造等业务异常反向把合法连接升级成握手失败。
    const negotiated = [
      ...((session.capabilities ?? []).includes(CLIENT_CORE_BROWSER_EXECUTOR_CAPABILITY)
        ? [CLIENT_CORE_BROWSER_EXECUTOR_CAPABILITY]
        : []),
      ...((session.capabilities ?? []).includes(CLIENT_DATA_PLANE_AUTOMATION_ENGINE_CAPABILITY)
        ? [CLIENT_DATA_PLANE_AUTOMATION_ENGINE_CAPABILITY]
        : []),
      ...((session.capabilities ?? []).includes(SEARCH_ACTIVITY_RECEIPT_CAPABILITY)
        ? [SEARCH_ACTIVITY_RECEIPT_CAPABILITY]
        : []),
      ...(this.deps.interactionInbox
        ? [
          INTERACTION_CAPABILITY,
          INTERACTION_REPLY_RECOVERY_CAPABILITY,
          INTERACTION_OFFBOARDING_CAPABILITY,
          INTERACTION_BROWSER_CONTROL_CAPABILITY,
          INTERACTION_TEST_DATA_RESET_CAPABILITY,
          ...(this.deps.interactionRuntimeControls ? [INTERACTION_RUNTIME_CONTROLS_CAPABILITY] : []),
        ].filter((capability) => (session.capabilities ?? []).includes(capability))
        : []),
    ];
    const negotiatedCapabilities = negotiated.length > 0 ? negotiated : undefined;
    let offboardPending: boolean | undefined;
    if (negotiatedCapabilities?.includes(INTERACTION_OFFBOARDING_CAPABILITY)) {
      try {
        offboardPending = !session.accountId || !this.deps.interactionInbox?.hasPendingOffboard
          ? true
          : await this.deps.interactionInbox.hasPendingOffboard(session.accountId);
      } catch {
        offboardPending = true;
      }
    }
    let interactionRuntime: InteractionRuntimeControlsPayload | undefined;
    if (negotiatedCapabilities?.includes(INTERACTION_RUNTIME_CONTROLS_CAPABILITY) && session.accountId) {
      try {
        interactionRuntime = await this.deps.interactionRuntimeControls!.getSnapshot(session.accountId);
      } catch {
        interactionRuntime = disabledInteractionRuntimeControls(session.accountId);
      }
    }
    return makeEnvelope('welcome', env.id, this.clock(), {
      sessionId: session.sessionId,
      serverVersion: this.serverVersion,
      capabilities: negotiatedCapabilities,
      interactionRecovery: offboardPending === undefined ? undefined : { offboardPending },
      interactionRuntime,
      // 节奏快照（change pacing-floor-config-min-interval）：tempo + 每类操作兜底 floor 区间。
      // 纯读风控 status（不写风控态）；握手早于风控态建立 / 解析失败 → 回落 normal(tempo=1.0)。
      // buildPacingSnapshot 是 total 函数：provider 抛错一律返 undefined，绝不 brick 握手。
      pacing: this.buildWelcomePacing(session),
    });
  }

  private interactionAvailable(session: EdgeSession): boolean {
    return !!this.deps.interactionInbox && (session.capabilities ?? []).includes(INTERACTION_CAPABILITY);
  }

  private interactionScopeMatches(session: EdgeSession, accountId: string): boolean {
    return !!session.accountId && session.accountId === accountId && session.platform === INTERACTION_PLATFORM;
  }

  private interactionExtensionAvailable(session: EdgeSession, capability: string): boolean {
    return this.interactionAvailable(session) && (session.capabilities ?? []).includes(capability);
  }

  private async onInteractionAuthStatus(env: Envelope, session: EdgeSession): Promise<Envelope | null> {
    if (!this.interactionAvailable(session)) {
      return makeEnvelope('error', env.id, this.clock(), {
        code: 'INTERACTION_FEATURE_DISABLED', message: 'interaction_inbox_v1 capability 未协商。',
      });
    }
    const payload = parseAuthStatusPayload(env.payload);
    if (!payload) return makeEnvelope('error', env.id, this.clock(), {
      code: 'INTERACTION_VALIDATION_FAILED', message: 'interaction.auth.status payload 不合法。',
    });
    if (!this.interactionScopeMatches(session, payload.accountId)) {
      return makeEnvelope('error', env.id, this.clock(), {
        code: 'INTERACTION_SCOPE_MISMATCH', message: '连接账号/平台与 payload 不匹配。',
      });
    }
    try {
      await this.deps.interactionInbox!.onAuthStatus(payload);
      return null;
    } catch (error) {
      const code = error instanceof InteractionError ? error.code : 'INTERACTION_INTERNAL_ERROR';
      return makeEnvelope('error', env.id, this.clock(), { code, message: 'interaction.auth.status 未持久化。' });
    }
  }

  private async onInteractionSyncBatch(env: Envelope, session: EdgeSession): Promise<Envelope> {
    const raw = env.payload && typeof env.payload === 'object' ? env.payload as Record<string, unknown> : {};
    const rejected = (code: InteractionSyncAckPayload['errorCode']): Envelope => makeEnvelope(
      'interaction.sync.ack', env.id, this.clock(), {
        batchId: typeof raw.batchId === 'string' && raw.batchId ? raw.batchId : 'invalid',
        envKey: typeof raw.envKey === 'string' && raw.envKey ? raw.envKey : 'invalid',
        accountId: typeof raw.accountId === 'string' && raw.accountId ? raw.accountId : 'invalid',
        platform: INTERACTION_PLATFORM,
        channel: raw.channel === 'dm' ? 'dm' : 'comment',
        scopeExternalId: typeof raw.scopeExternalId === 'string' ? raw.scopeExternalId : null,
        status: 'rejected', cursorAfter: null, persisted: { threads: 0, messages: 0 },
        errorCode: code, receivedAt: this.clock(),
      },
    );
    if (!this.interactionAvailable(session)) return rejected('INTERACTION_FEATURE_DISABLED');
    const payload = parseSyncBatchPayload(env.payload);
    if (!payload) return rejected('INTERACTION_VALIDATION_FAILED');
    if (!this.interactionScopeMatches(session, payload.accountId)) return rejected('INTERACTION_SCOPE_MISMATCH');
    try {
      const ack = await this.deps.interactionInbox!.onSyncBatch(payload);
      return makeEnvelope('interaction.sync.ack', env.id, this.clock(), ack);
    } catch (error) {
      return rejected(error instanceof InteractionError ? error.code : 'INTERACTION_INTERNAL_ERROR');
    }
  }

  private async onInteractionReplyResult(env: Envelope, session: EdgeSession): Promise<Envelope | null> {
    if (!this.interactionAvailable(session)) return makeEnvelope('error', env.id, this.clock(), {
      code: 'INTERACTION_FEATURE_DISABLED', message: 'interaction_inbox_v1 capability 未协商。',
    });
    const payload = parseReplyResultPayload(env.payload);
    if (!payload) return makeEnvelope('error', env.id, this.clock(), {
      code: 'INTERACTION_VALIDATION_FAILED', message: 'interaction.reply.result payload 不合法。',
    });
    const recovery = this.interactionExtensionAvailable(session, INTERACTION_REPLY_RECOVERY_CAPABILITY);
    const ack = (status: InteractionReplyResultAckPayload['status'], errorCode: InteractionReplyResultAckPayload['errorCode']): Envelope =>
      makeEnvelope('interaction.reply.result.ack', env.id, this.clock(), {
        jobId: payload.jobId, attemptId: payload.attemptId, idempotencyKey: payload.idempotencyKey,
        envKey: payload.envKey, accountId: payload.accountId, platform: INTERACTION_PLATFORM,
        status, errorCode, receivedAt: this.clock(),
      });
    if (!this.interactionScopeMatches(session, payload.accountId)) return recovery
      ? ack('rejected', 'INTERACTION_SCOPE_MISMATCH')
      : makeEnvelope('error', env.id, this.clock(), {
        code: 'INTERACTION_SCOPE_MISMATCH', message: '连接账号/平台与 payload 不匹配。',
      });
    try {
      const applied = await this.deps.interactionInbox!.onReplyResult(payload);
      return recovery ? ack(applied.duplicate ? 'duplicate' : 'accepted', null) : null;
    } catch (error) {
      const code = error instanceof InteractionError ? error.code : 'INTERACTION_INTERNAL_ERROR';
      return recovery ? ack('rejected', code) :
        makeEnvelope('error', env.id, this.clock(), { code, message: 'interaction.reply.result 未接收。' });
    }
  }

  private async onInteractionReplyReconcileResult(env: Envelope, session: EdgeSession): Promise<Envelope | null> {
    if (!this.interactionExtensionAvailable(session, INTERACTION_REPLY_RECOVERY_CAPABILITY)) {
      return makeEnvelope('error', env.id, this.clock(), {
        code: 'INTERACTION_FEATURE_DISABLED', message: 'interaction_reply_recovery_v1 capability 未协商。',
      });
    }
    const payload = parseReplyReconcileResultPayload(env.payload);
    if (!payload) return makeEnvelope('error', env.id, this.clock(), {
      code: 'INTERACTION_VALIDATION_FAILED', message: 'interaction.reply.reconcile.result payload 不合法。',
    });
    if (!this.interactionScopeMatches(session, payload.accountId)) return makeEnvelope('error', env.id, this.clock(), {
      code: 'INTERACTION_SCOPE_MISMATCH', message: '连接账号/平台与恢复 payload 不匹配。',
    });
    try {
      await this.deps.interactionInbox!.onReplyReconcileResult(payload as InteractionReplyReconcileResultPayload);
      return null;
    } catch (error) {
      const code = error instanceof InteractionError ? error.code : 'INTERACTION_INTERNAL_ERROR';
      return makeEnvelope('error', env.id, this.clock(), { code, message: '恢复观察未接收。' });
    }
  }

  private async onInteractionOffboardResult(env: Envelope, session: EdgeSession): Promise<Envelope> {
    const raw = env.payload && typeof env.payload === 'object' ? env.payload as Record<string, unknown> : {};
    if (!this.interactionExtensionAvailable(session, INTERACTION_OFFBOARDING_CAPABILITY)) {
      return makeEnvelope('error', env.id, this.clock(), {
        code: 'INTERACTION_FEATURE_DISABLED', message: 'interaction_offboarding_v1 capability 未协商。',
      });
    }
    const payload = parseOffboardResultPayload(raw);
    if (!payload) return makeEnvelope('error', env.id, this.clock(), {
      code: 'INTERACTION_VALIDATION_FAILED', message: 'interaction.offboard.result payload 不合法。',
    });
    const ack = (status: InteractionOffboardAckPayload['status'], errorCode: InteractionOffboardAckPayload['errorCode']): Envelope =>
      makeEnvelope('interaction.offboard.ack', env.id, this.clock(), {
        offboardId: payload.offboardId, envKey: payload.envKey, accountId: payload.accountId,
        platform: INTERACTION_PLATFORM, status, errorCode, receivedAt: this.clock(),
      });
    if (!this.interactionScopeMatches(session, payload.accountId)) return ack('rejected', 'INTERACTION_SCOPE_MISMATCH');
    try {
      const applied = await this.deps.interactionInbox!.onOffboardResult(payload as InteractionOffboardResultPayload);
      return ack(applied.duplicate ? 'duplicate' : 'accepted', null);
    } catch (error) {
      return ack('rejected', error instanceof InteractionError ? error.code : 'INTERACTION_INTERNAL_ERROR');
    }
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
    const action = p.action;
    const result = this.controllerFor(session).explain(action);
    return makeEnvelope('risk.canDo.result', env.id, this.clock(), {
      action,
      allowed: result.allowed,
      reason: result.reason,
    });
  }

  private async onRiskRecord(env: Envelope, session: EdgeSession): Promise<Envelope> {
    const p = env.payload as RiskRecordPayload;
    const action = p.action;
    // 保留通道（边缘尚未接线）。记账仍 MUST 经同一个漏斗，否则这里会递增内存计数却不落库，
    // 下一次对账会把它当成偏差抹掉 ⇒ 一次真实动作凭空消失。
    const accountId = session.accountId?.trim();
    const recorded =
      this.deps.riskAccounting && accountId
        ? (
            await this.deps.riskAccounting.record({
              accountId,
              action,
              occurredAt: this.clock(),
              dedupeKey: `${env.id}:risk.record:${action}`,
            })
          ).allowed
        : await this.controllerFor(session).record(action);
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
    if (this.deps.personaService) {
      if (!session.accountId) {
        this.logger.warn('[persona] persona.generate 会话缺 accountId（握手应已保证）— 诚实回 unknown_account');
        return makeEnvelope('persona.generate.result', env.id, this.clock(), { ok: false, reason: 'unknown_account' });
      }
      const result = await this.deps.personaService.generate({
        accountId: session.accountId,
        // 旧 WS 客户端的历史 session 可能没有平台字段；该兼容入口维持旧默认。新的 customer-auth
        // 环境接口必须由账号仓给出权威平台，缺失时 AccountPersonaService 会 fail-closed。
        platform: session.platform ?? 'xiaohongshu',
        keywordSelections: p.keywordSelections,
        writingLanguage: p.writingLanguage,
        idempotencyKey: p.idempotencyKey ?? '',
      });
      return makeEnvelope(
        'persona.generate.result',
        env.id,
        this.clock(),
        result.ok
          ? { ok: true, soulYaml: result.soulYaml, identitySummary: result.identitySummary }
          : { ok: false, reason: result.reason },
      );
    }
    if (!this.deps.personaGenerator) {
      return makeEnvelope('persona.generate.result', env.id, this.clock(), { ok: false, reason: 'unavailable' });
    }
    if (!session.accountId) {
      this.logger.warn('[persona] persona.generate 会话缺 accountId（握手应已保证）— 诚实回 unknown_account');
      return makeEnvelope('persona.generate.result', env.id, this.clock(), { ok: false, reason: 'unknown_account' });
    }
    const accountId = session.accountId;
    const platform = normalizePlatformId(session.platform);
    const requestedWritingLanguage = p.writingLanguage;
    if (platform === 'facebook') {
      if (requestedWritingLanguage === undefined) {
        return makeEnvelope('persona.generate.result', env.id, this.clock(), { ok: false, reason: 'writing_language_required' });
      }
      if (!isWritingLanguage(requestedWritingLanguage)) {
        return makeEnvelope('persona.generate.result', env.id, this.clock(), { ok: false, reason: 'writing_language_invalid' });
      }
    } else if (requestedWritingLanguage !== undefined) {
      return makeEnvelope('persona.generate.result', env.id, this.clock(), { ok: false, reason: 'writing_language_not_supported' });
    }
    const idempotencyKey = (p.idempotencyKey ?? '').trim();
    if (!idempotencyKey) {
      return makeEnvelope('persona.generate.result', env.id, this.clock(), { ok: false, reason: 'missing_idempotency_key' });
    }
    // 轻量输入校验（change persona-wizard-onboarding-fixes）：垂类/兴趣自由文本引入弱注入面 → 有界爆炸面。
    // 单项长度上限 + 条数上限，超限诚实拒绝、绝不把超长/超量文本原样喂进生成 prompt（accountId 已取握手绑定值、产物另经结构复验）。
    const kws = (p.keywordSelections ?? []).filter((k) => typeof k === 'string');
    if (
      kws.length > MAX_PERSONA_KEYWORDS
      || kws.some((k) => k.length > MAX_PERSONA_KEYWORD_LENGTH)
    ) {
      return makeEnvelope('persona.generate.result', env.id, this.clock(), { ok: false, reason: 'input_too_large' });
    }
    const cacheKey = `${accountId}:${idempotencyKey}`;
    let inflight = this.personaGenInflight.get(cacheKey);
    if (!inflight) {
      inflight = this.runPersonaGenerate(
        accountId,
        idempotencyKey,
        kws,
        platform === 'facebook' ? requestedWritingLanguage as WritingLanguage : undefined,
      )
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
    writingLanguage?: WritingLanguage,
  ): Promise<PersonaGenerateResultPayload> {
    // 每账号差异化种子：拌 accountId + 幂等键（每次「生成/重新生成」都带新键 → 有区分度），抗跨账号同质化。
    const diversitySeed = `account:${accountId}|nonce:${idempotencyKey}`;
    const outcome = await this.deps.personaGenerator!.generate({ accountId, keywordSelections, diversitySeed, writingLanguage });
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
    if (this.deps.personaService) {
      if (!session.accountId) {
        this.logger.warn('[persona] persona.persist 会话缺 accountId（握手应已保证）— 诚实回 unknown_account');
        return makeEnvelope('persona.persist.result', env.id, this.clock(), { ok: false, reason: 'unknown_account' });
      }
      const result = await this.deps.personaService.persist(
        session.accountId,
        p.soulYaml ?? '',
        `edge-onboarding:${session.accountId}`,
      );
      return makeEnvelope(
        'persona.persist.result',
        env.id,
        this.clock(),
        result.ok
          ? { ok: true, firstPostOnboarding: result.firstPostOnboarding }
          : { ok: false, reason: result.reason },
      );
    }
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
    let firstPostOnboarding = false;
    if (result.ok && this.deps.firstPostOnboarding) {
      try {
        firstPostOnboarding = await this.deps.firstPostOnboarding.armFirstBind(session.accountId);
      } catch (err) {
        // Persona persistence already succeeded. Do not roll it back, but also do
        // not promise an automatic first-post flow whose durable state was not armed.
        this.logger.warn(`[persona] 首作引导状态建立失败 account=${session.accountId}: ${(err as Error).message}`);
      }
    }
    return makeEnvelope(
      'persona.persist.result',
      env.id,
      this.clock(),
      result.ok ? { ok: true, firstPostOnboarding } : { ok: false, reason: result.reason },
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
    // change unify-card-routing-origin-then-team：优先走统一解析（本路径无命令来源会话 → 落账号团队群
    // → 默认群；解析器内部已把未绑团队 / 读失败补集回落，绝不外抛）。未注入解析器时保持既有默认群链。
    let chatId = '';
    if (this.deps.resolveCardChatId) {
      chatId = await this.deps.resolveCardChatId(undefined, session.accountId);
      this.logger.log('[comm] publish.approval_request 目标群解析完成:', {
        requestId: payload.requestId,
        accountId: session.accountId ?? null,
        chatId: chatId || null,
      });
    } else {
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
      chatId = defaultChat?.chatId ?? this.deps.approvalChatId ?? process.env.FEISHU_CHAT_ID ?? '';
    }
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
        // 只声称走了哪条解析路径；落点如实由 chatId 呈现（account_scope 内部可能已补集回落默认群）。
        source: this.deps.resolveCardChatId ? 'account_scope' : 'default_chat_chain',
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
