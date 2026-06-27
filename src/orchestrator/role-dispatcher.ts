/**
 * RoleDispatcher — 事件驱动的角色调度器。
 *
 * 职责：
 * 1. 创建和管理所有角色实例
 * 2. 启动会话时发出 feed.entered 事件启动闭环
 * 3. 提供角色所需的外部依赖（getNoteData、getProfileData、getRemainingBudget 等）
 * 4. 与 Edge 通信层对接：
 *    - 接收 Edge 上报的页面数据 → 更新到数据层供角色读取
 *    - 角色产出执行事件 → 翻译为 Edge 协议指令下发
 * 5. SessionMonitor 集成（会话守护）
 */

import { EventBus } from '../event-bus/index.js';
import type { LlmCallOpts } from '../llm/qwen.js';
import { SessionContext } from '../agents/session-context.js';
import { ContentEvaluator } from '../agents/content-evaluator.js';
import { FeedScroller } from '../agents/feed-scroller.js';
import { NoteOpener } from '../agents/note-opener.js';
import { BackToFeed } from '../agents/back-to-feed.js';
import { DeepReader } from '../agents/deep-reader.js';
import { CommentReviewer } from '../agents/comment-reviewer.js';
import { ContentCuratorRole } from '../agents/content-curator-role.js';
import { InteractionAppraiserRole } from '../agents/interaction-appraiser-role.js';
import { AuthorEvaluator } from '../agents/author-evaluator.js';
import { CommentAppraiser } from '../agents/comment-appraiser.js';
import { CommentLikeAppraiser } from '../agents/comment-like-appraiser.js';
import { ValuableCommentArchivist } from '../agents/valuable-comment-archivist.js';
import type { ValuableCommentInput, ValuableCommentRef } from '../cache/valuable-comment-store.js';
import { CommentComposer } from '../agents/comment-composer.js';
import { CommentDeAiFlavor } from '../agents/comment-de-ai-flavor.js';
import { CommentApprovalGate, type CommentApprovalPort } from '../agents/comment-approval-gate.js';
import { ProfileOpener } from '../agents/profile-opener.js';
import { ProfileBrowser } from '../agents/profile-browser.js';
import { NicknameEnricher } from '../agents/nickname-enricher.js';
import { FollowAgent } from '../agents/follow-agent.js';
import { SearchScroller } from '../agents/search-scroller.js';
import { SearchEvaluator } from '../agents/search-evaluator.js';
import { SearchExecutor } from '../agents/search-executor.js';
import { ConceptExtractorRole, type ConceptSink } from '../agents/concept-extractor-role.js';
import { SessionMonitorRole } from '../agents/session-monitor-role.js';
// —— 通知巡视（消息查看）角色 ——
import { NotificationGatekeeper } from '../agents/notification-gatekeeper.js';
import { BrowseSuspender } from '../agents/browse-suspender.js';
import { NotificationHomeOpener } from '../agents/notification-home-opener.js';
import { NotificationTriage } from '../agents/notification-triage.js';
import { NotificationCommentBrowser } from '../agents/notification-comment-browser.js';
import { NotificationLikeBrowser } from '../agents/notification-like-browser.js';
import { NotificationFollowBrowser } from '../agents/notification-follow-browser.js';
import { NotificationClassifier } from '../agents/notification-classifier.js';
import { NotificationDeduper } from '../agents/notification-deduper.js';
import { NotificationNotifier } from '../agents/notification-notifier.js';
import { NotificationReturnHome } from '../agents/notification-return-home.js';
import { ExcursionResumer } from '../agents/excursion-resumer.js';
import type { BaseRole } from '../agents/base-role.js';
import type { Soul } from '../soul/types.js';
import { computeDwellMs, computeThinkMs } from '../risk/pacing.js';
import { SearchFrequencyLimiter } from '../risk/search-frequency-limiter.js';
import { InteractionGuard, isGuardedInteraction, type GuardAction } from '../risk/interaction-guard.js';
import { ActionCooldownGate, type CooldownAction } from '../risk/action-cooldown.js';
import {
  DEFAULT_SESSION_DURATION_MS,
  defaultSessionBudget,
  type SessionInteractionBudget,
  type SessionLimitProvider,
} from '../risk/session-limits.js';
import {
  DEFAULT_IDLE_END_MS,
  DEFAULT_IDLE_NUDGE_MS,
  isWithinActiveWindow,
  type ResumeConfigProvider,
} from '../risk/resume-limits.js';
import type { RiskStatus } from '../risk/types.js';
import type { ConceptPool } from '../event-bus/types.js';
import type { NotificationItem } from '../comm/protocol.js';

/** 概念池读写下游（ConceptStore 的最小契约，便于注入桩单测）。 */
export interface ConceptStorePort extends ConceptSink {
  loadPool(): Promise<ConceptPool>;
  markSearched(keyword: string): Promise<void>;
}

const EMPTY_CONCEPT_POOL: ConceptPool = { known: [], candidates: [], source: new Map() };

// ─── 公共接口 ────────────────────────────────────────────────────────────────

export interface RoleDispatcherOptions {
  /**
   * 人设注入（change account-persona-config）。两种形态，至少给一个：
   * - getSoul：派发时按当前账号解析的取值口（热加载，PUT 人设后即时生效）——生产路径；
   * - soul：构造期人设快照（向后兼容旧构造 / 测试桩）。两者皆给时 getSoul 优先。
   */
  soul?: Soul;
  getSoul?: (accountId?: string) => Soul;
  llm: { complete(prompt: string, opts?: LlmCallOpts): Promise<string> };
  sendCommand: (command: EdgeCommand) => void;
  clock?: () => number;
  /** 外部事件总线（共享 handler 发射的 Edge 上报事件），缺省创建独立实例 */
  eventBus?: EventBus;
  /**
   * 读取当前账号风控状态（指令级节奏的 tempo 来源）。缺省 `'normal'`。
   * 由 server 接线为 `() => riskController.getState().status`。
   */
  getRiskStatus?: () => RiskStatus;
  /**
   * 互动前风控闸：下发 like/collect/follow 前判定是否允许。缺省始终允许（向后兼容）。
   * 由 server 接线为 `(action) => riskController.canDo(action)`。被拒则诚实跳过（不下发、不扣 budget）。
   */
  canInteract?: (action: 'like' | 'collect' | 'follow' | 'comment' | 'comment_like') => boolean;
  /**
   * 硬暂停闸（验证码/人工接管）：边缘是否处于硬暂停态。缺省始终 false。
   * 由 server 接线为读 ws-server 的 pausedEdges（isEdgePaused）。通知准入角色据此放弃巡视——
   * 硬暂停期连帧都不发，不该再叠通知巡视。与 browseSuspended（软暂停）正交。
   */
  isHardPaused?: (edgeId?: string) => boolean;
  /**
   * 发飞书闭包（通知巡视用，复用 server 的 messenger + resolveChatId）。缺省不发（仅日志，仍收尾）。
   * 只对"评论和@"类生效；赞收藏/新增关注 v1 不发。
   */
  notifyComments?: (items: NotificationItem[]) => Promise<void>;
  /**
   * 概念池存储（跨会话记忆）：启动时 loadPool 喂 SearchEvaluator，
   * ConceptExtractorRole 抽到新概念 addCandidate，下发搜索后 markSearched。
   * 缺省（如 PG 不可用）→ 退化为仅 seed_keywords，不注册概念抽取角色。
   */
  conceptStore?: ConceptStorePort;
  /** 搜索限频闸参数（每会话/每天上限）；缺省用 SearchFrequencyLimiter 默认值。 */
  searchLimiterOptions?: { maxPerSession?: number; maxPerDay?: number };
  /**
   * 评论循环内人审端口（发飞书审批卡 + 查 /tmp 授权信号）。缺省（未接线）→ 评论一律诚实跳过，绝不裸发（AC-PUB）。
   * 由 server 接线为复用 messenger + isPublishApproved（评论专属 requestId 命名空间）。
   */
  commentApproval?: CommentApprovalPort;
  /** 该账号当日剩余评论上限（后台配置）。缺省 → 仅会话评论预算 + 风控配额生效。 */
  getCommentDailyRemaining?: () => number;
  /** 该账号当日剩余「评论赞」配额（接 riskController.dailyRemaining('comment_like')）。 */
  getCommentLikeDailyRemaining?: () => number;
  /** 优质评论归档闭包（接 ValuableCommentStore.archive）；缺省 → 不注册归档角色（语料库关闭）。 */
  archiveValuableComment?: (input: ValuableCommentInput) => Promise<void>;
  /** 按主题键召回语料库参考评论（接 ValuableCommentStore.retrieveByTopics）；缺省 → 撰写不注入参考。 */
  getCorpusReferences?: (topics: string[]) => Promise<ValuableCommentRef[]>;
  /**
   * 诚实人设启动闸（multi-account-node-support D3）：以「人设存储中是否存在该账号的人设行」为独立判据
   * （getForAccount!==null，**不走会回落默认的解析器**）。缺省 → 不设闸（向后兼容单账号）。default 账号硬豁免（见 canStartSession）。
   */
  isPersonaBound?: (accountId: string) => boolean;
  /** 账号未绑人设被诚实拒绝时回调（置 needs_persona_setup + 飞书告警）。 */
  onSessionRejected?: (accountId: string, reason: string) => void | Promise<void>;
  /** 全局调度开关（面板 /dispatch）：false 时不启动浏览会话。缺省 → 恒 true。 */
  isDispatchActive?: () => boolean;
  /**
   * 同账号并行（N:1）互动去重 guard（multi-account-node-support D7②）：按账号单例（同账号 N 连接共用）。
   * 下发互动前占坑去重，防两节点对同一笔记/作者重复点赞/关注/评论。缺省 → 不去重（单账号单节点向后兼容）。
   */
  interactionGuard?: InteractionGuard;
  /**
   * 动作冷却闸（engagement-restraint）：下发 like/collect/follow 前查冷却、真成功后落时间戳；
   * comment 冷却在 CommentAppraiser 早判（经 getCommentCooldownOk 闭包）。缺省 → 不冷却（向后兼容）。
   * 单例共享、内部按 accountId 分桶，附加只读节奏闸，不写风控终态。
   */
  cooldownGate?: ActionCooldownGate;
  /**
   * 单场上限提供者（change session-limits-to-quota-layer）：按账号给出单场时长 + 单场互动预算
   * （安全限额层，热加载、后台改即生效）。缺省 → 回落写死默认（时长 10min + freshBudget 数字），
   * 与改造前逐位一致（严格零回归）。只读、不触风控状态单写、不经协议。
   */
  sessionLimitProvider?: SessionLimitProvider;
  /**
   * 自动续场护栏 + 看门狗阈值提供者（change session-auto-resume-with-excursions）：按账号给出
   * rest_ratio / 活跃时段窗口 / 每日上限 / 看门狗两阈值（热加载、后台改即生效）。
   * **未注入 → 自动续场特性关（保持旧行为：单场结束即停、不续）**；看门狗回落写死默认（轻推~2min / 放弃 1h）。
   * 只读、不触风控状态单写、不经协议。
   */
  resumeConfigProvider?: ResumeConfigProvider;
  /** 续场休息计时器注入（测试桩）；生产用真 setTimeout/clearTimeout（unref）。 */
  setTimeoutFn?: (fn: () => void, ms: number) => unknown;
  clearTimeoutFn?: (handle: unknown) => void;
  /** 休息时长抖动用随机源（测试可注入定值）；缺省 Math.random。 */
  randomFn?: () => number;
  /**
   * 同步读账号昵称（change account-real-nickname）：返回 string|null（库内 NULL/未知=null）。
   * **同步**——握手时同步算「需采集」判定（不 await PG，杜绝异步窗口让 page.cards 插进采集绕路）。
   * 由 server 注入读 AccountStore 进程内缓存；缺省 → 恒 null（无 PG 退化）。
   */
  getNickname?: (accountId: string) => string | null;
  /** 持久化账号昵称（change account-real-nickname）：nickname_enricher 采到非空时单写 upsert（拒空、不阻塞）。 */
  setNickname?: (accountId: string, nickname: string) => Promise<void> | void;
}

export interface EdgeCommand {
  action: 'scroll' | 'open_note' | 'close_note' | 'like' | 'collect' | 'follow' | 'comment' | 'comment_like' | 'search' | 'back' | 'browse_images' | 'scroll_comments' | 'profile_open' | 'open_notifications' | 'browse_notification_comments' | 'browse_notification_likes' | 'browse_notification_follows' | 'notification_back_home' | 'session.end';
  params?: Record<string, unknown>;
  reason?: string;
}

export interface VisibleCard {
  index: number;
  title: string;
  author?: string;
  likeCount: number;
  collectCount: number;
  coverDesc?: string;
  noteId?: string;
}

export interface NoteData {
  noteId: string;
  title: string;
  content: string;
  author?: string;
  authorId?: string;
  likeCount: number;
  collectCount: number;
  /** 详情页作者区关注按钮当下真实态（change skip-profile-visit-if-followed）：已关注/互关→true。
   *  updateNoteData 从 note.detail 透传，AuthorEvaluator 据此在评估进主页前短路。缺省→原流程。 */
  authorFollowed?: boolean;
}

// ─── RoleDispatcher ─────────────────────────────────────────────────────────

export class RoleDispatcher {
  private readonly eventBus: EventBus;
  private readonly sessionContext: SessionContext;
  /** 人设：getSoul 取值口（热加载）优先，soulSnapshot 为兼容快照。经 resolveSoul() 统一取值。 */
  private readonly soulSnapshot?: Soul;
  private readonly getSoulFn?: (accountId?: string) => Soul;
  /** 当前账号（多账号 per-edge 多路复用就位后按会话切；当前单账号默认 default，留 getSoul(accountId?) 形参缝）。 */
  private currentAccountId = 'default';
  private readonly llm: { complete(prompt: string, opts?: LlmCallOpts): Promise<string> };
  private readonly rawSendCommand: (command: EdgeCommand) => void;
  private readonly clock: () => number;
  private readonly getRiskStatus: () => RiskStatus;
  private readonly canInteract: (action: 'like' | 'collect' | 'follow' | 'comment' | 'comment_like') => boolean;
  private readonly commentApproval?: CommentApprovalPort;
  private readonly getCommentDailyRemaining?: () => number;
  private readonly getCommentLikeDailyRemaining?: () => number;
  private readonly archiveValuableComment?: (input: ValuableCommentInput) => Promise<void>;
  private readonly getCorpusReferences?: (topics: string[]) => Promise<ValuableCommentRef[]>;
  /** 已下发待回执的评论上下文：action.completed{comment} 据此扣额 + emit comment.done（→ 是否进主页评估）。 */
  private pendingComment: { noteId: string; sourcePageType: 'feed' | 'search'; actions: ('like' | 'collect')[]; text: string } | null = null;
  private readonly isHardPaused: (edgeId?: string) => boolean;
  private readonly isPersonaBound?: (accountId: string) => boolean;
  private readonly onSessionRejected?: (accountId: string, reason: string) => void | Promise<void>;
  private readonly isDispatchActive: () => boolean;
  /** 同账号并行互动去重 guard（按账号单例）；缺省不去重。 */
  private readonly interactionGuard?: InteractionGuard;
  /** 动作冷却闸（engagement-restraint）；缺省不冷却。 */
  private readonly cooldownGate?: ActionCooldownGate;
  /** 单场上限提供者（按账号读单场时长 + 互动预算，热加载）；缺省回落写死默认。只读。 */
  private readonly sessionLimitProvider?: SessionLimitProvider;
  /** 续场护栏 + 看门狗阈值提供者（按账号读，热加载）；未注入 → 自动续场关、看门狗回落默认。只读。 */
  private readonly resumeConfigProvider?: ResumeConfigProvider;
  private readonly setTimeoutFn: (fn: () => void, ms: number) => unknown;
  private readonly clearTimeoutFn: (handle: unknown) => void;
  private readonly randomFn: () => number;
  /** 同步读账号昵称（change account-real-nickname）：握手同步算「需采集」用；缺省恒 null。 */
  private readonly getNickname: (accountId: string) => string | null;
  /** 持久化账号昵称（change account-real-nickname）：nickname_enricher 采到非空时调；缺省 → 不持久化。 */
  private readonly setNickname?: (accountId: string, nickname: string) => Promise<void> | void;
  /** 续场休息计时器句柄（每连接私有、unref，只重开本连接会话；绝不广播）。 */
  private restTimer: unknown;
  /** 每账号当日自动续场计数（场数 + 累计浏览毫秒），按本地日界重置。 */
  private readonly dailyResume = new Map<string, { dayKey: string; sessions: number; browseMs: number }>();
  /** SessionMonitor 引用（供 excursion → pauseClock/resumeClock；setup 时捕获）。 */
  private sessionMonitor?: SessionMonitorRole;
  /** 已下发占坑、待回执释放的互动键（按动作）：action.completed 据此 complete / releaseFailed。 */
  private readonly pendingInteractionKeys = new Map<GuardAction, string>();
  private readonly notifyComments?: (items: NotificationItem[]) => Promise<void>;
  private readonly conceptStore?: ConceptStorePort;
  /** 搜索前限频闸（每关键词每会话/每天上限），dispatcher 持有单例，会话重启时清会话计数。 */
  private readonly searchLimiter: SearchFrequencyLimiter;
  /** 概念池快照：startSession 时 loadPool 刷新，供 SearchEvaluator 读取。 */
  private conceptPool: ConceptPool = EMPTY_CONCEPT_POOL;
  /** 会话开始时刻，用于估算会话进度（疲劳乘子）。时长上限改为按当前人设惰性解析（见 maxDurationMs()）。 */
  private sessionStartedAt: number;
  private roles: BaseRole[] = [];

  /** 只读暴露已注册角色实例（change role-prompt-visibility，仅供后台 prompt 预览借读；不改分发逻辑）。 */
  getRoles(): readonly BaseRole[] {
    return this.roles;
  }

  private contentEvaluator!: ContentEvaluator;
  private commandUnsubscribers: (() => void)[] = [];

  // 数据存储（由 Edge 上报更新）
  private visibleCards: VisibleCard[] = [];
  private currentNote: NoteData | null = null;
  /** 当前会话剩余互动预算（按账号从单场上限提供者派生，会话开始/重置时刷新）。 */
  private budget!: SessionInteractionBudget;
  /** 会话开始/重置时的预算快照（供比率闸：init−剩余；会话中途改预算不漂移）。 */
  private budgetInit!: SessionInteractionBudget;
  private searchedKeywords: string[] = [];
  private sessionActive = false;

  constructor(options: RoleDispatcherOptions) {
    this.soulSnapshot = options.soul;
    this.getSoulFn = options.getSoul;
    this.llm = options.llm;
    this.rawSendCommand = options.sendCommand;
    this.clock = options.clock ?? Date.now;
    this.getRiskStatus = options.getRiskStatus ?? (() => 'normal');
    this.canInteract = options.canInteract ?? (() => true);
    this.commentApproval = options.commentApproval;
    this.getCommentDailyRemaining = options.getCommentDailyRemaining;
    this.getCommentLikeDailyRemaining = options.getCommentLikeDailyRemaining;
    this.archiveValuableComment = options.archiveValuableComment;
    this.getCorpusReferences = options.getCorpusReferences;
    this.isHardPaused = options.isHardPaused ?? (() => false);
    this.isPersonaBound = options.isPersonaBound;
    this.onSessionRejected = options.onSessionRejected;
    this.isDispatchActive = options.isDispatchActive ?? (() => true);
    this.interactionGuard = options.interactionGuard;
    this.cooldownGate = options.cooldownGate;
    this.sessionLimitProvider = options.sessionLimitProvider;
    this.resumeConfigProvider = options.resumeConfigProvider;
    this.setTimeoutFn = options.setTimeoutFn ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimeoutFn = options.clearTimeoutFn ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
    this.randomFn = options.randomFn ?? Math.random;
    this.getNickname = options.getNickname ?? (() => null);
    this.setNickname = options.setNickname;
    this.notifyComments = options.notifyComments;
    this.conceptStore = options.conceptStore;
    this.searchLimiter = new SearchFrequencyLimiter(options.searchLimiterOptions);
    this.eventBus = options.eventBus ?? new EventBus();
    this.sessionContext = new SessionContext();
    this.sessionStartedAt = this.clock();
    // 初始预算按当前账号从提供者派生（缺省回落写死默认）；budgetInit 留作比率闸快照。
    this.budget = this.freshBudget();
    this.budgetInit = { ...this.budget };
  }

  /**
   * 按当前账号解析人设（getSoul 取值口优先 → 兼容快照）。永不返回 undefined：
   * 取值口内部已回落打包默认 soul；两者皆缺则抛（构造契约违背，诚实失败不静默）。
   */
  private resolveSoul(): Soul {
    if (this.getSoulFn) return this.getSoulFn(this.currentAccountId);
    if (this.soulSnapshot) return this.soulSnapshot;
    throw new Error('RoleDispatcher 缺少人设注入（soul / getSoul 至少给一个）');
  }

  /** 会话时长上限（毫秒）：按当前账号从单场上限提供者惰性解析（热加载，后台改即时生效）；缺省回落写死默认。 */
  private maxDurationMs(): number {
    return this.sessionLimitProvider?.sessionDurationMsFor(this.currentAccountId) ?? DEFAULT_SESSION_DURATION_MS;
  }

  /** 会话进度 0..1（已用时长 / 时长上限），供节奏疲劳乘子使用。 */
  private progress(): number {
    const elapsed = this.clock() - this.sessionStartedAt;
    return Math.min(1, Math.max(0, elapsed / this.maxDurationMs()));
  }

  /** 动作前犹豫时间中心值（随风控状态 + 会话进度缩放）。familiar=true 对近期已评估内容按 1/3 折扣。 */
  private thinkNow(familiar = false): number {
    return computeThinkMs({ status: this.getRiskStatus(), progress: this.progress(), familiar });
  }

  /** 通知巡视命令（巡视期放行，浏览类命令被暂停出口扣住）。 */
  private isExcursionCommand(action: EdgeCommand['action']): boolean {
    return action === 'open_notifications'
      || action === 'browse_notification_comments'
      || action === 'browse_notification_likes'
      || action === 'browse_notification_follows'
      || action === 'notification_back_home';
  }

  /**
   * 发命令的统一出口（软暂停闸）。巡视期（browseSuspended）扣住 browse 类命令——它们会从下次
   * page.cards 自行重来——只放行巡视命令与 session.end；非巡视期照常下发。所有翻译块都经此。
   */
  private sendCommand(command: EdgeCommand): boolean {
    if (
      this.sessionContext.browseSuspended &&
      command.action !== 'session.end' &&
      !this.isExcursionCommand(command.action) &&
      // 本人昵称采集放行（change account-real-nickname）：仅放行采集在途时的 self profile_open；
      // open_note/like/scroll 在绕路中照丢（下次 page.cards 无害重来）。非 blanket 关 suspension。
      !(this.sessionContext.selfCaptureInFlight && command.action === 'profile_open')
    ) {
      return false; // 软暂停：丢弃 browse 命令（不入队、由 page.cards 续刷自然重来）
    }
    // 同账号并行（N:1）互动前按账号去重（D7②）：占坑——已在途/已完成则跳过下发（不假成功、不扣额）。
    // 覆盖 follow/comment/comment_like（无 per-note 落库去重）。缺目标键时放行（不去重）。
    if (this.interactionGuard && isGuardedInteraction(command.action)) {
      const key = InteractionGuard.keyFor(command.action, command.params);
      if (!this.interactionGuard.tryClaim(key)) {
        console.log(
          `[RoleDispatcher] 互动按账号去重：${key} 已在途/已完成 → 跳过下发（account=${this.currentAccountId}）`,
        );
        return false;
      }
      if (key) this.pendingInteractionKeys.set(command.action, key);
    }
    this.rawSendCommand(command);
    return true;
  }

  /**
   * 当前笔记的停留时长中心值（随正文长度 + 风控状态 + 进度缩放）。
   * 无当前笔记（如非详情页返回）时返回 undefined，由边缘走默认兜底。
   */
  private dwellForCurrentNote(mode: 'read' | 'glance'): number | undefined {
    if (!this.currentNote) return undefined;
    return computeDwellMs({
      textLen: this.currentNote.content.length,
      mode,
      status: this.getRiskStatus(),
      progress: this.progress(),
    });
  }

  /** 设置该连接（运行时）的当前账号（multi-account-node-support D4：去掉 default 钉死，由连接真实账号设入）。 */
  setCurrentAccountId(accountId: string): void {
    this.currentAccountId = accountId;
    // 握手同步算「需采集登录账号真实昵称」（change account-real-nickname）：真实账号(非 default) 且库内昵称为 NULL。
    // 同步算（不 await PG）→ 存 SessionContext 布尔，杜绝会话开始再 await 留下的异步窗口（在途 page.cards 会插 open_note 绕路）。
    this.sessionContext.setPendingNicknameCapture(accountId !== 'default' && this.getNickname(accountId) === null);
  }

  /** 当前账号（供测试 / 观测）。 */
  get accountId(): string {
    return this.currentAccountId;
  }

  /** 获取 EventBus（供测试用） */
  get bus(): EventBus {
    return this.eventBus;
  }

  /** 获取会话上下文（供测试用） */
  get context(): SessionContext {
    return this.sessionContext;
  }

  /** 会话是否活跃 */
  get active(): boolean {
    return this.sessionActive;
  }

  /** 注册所有角色并启动事件订阅 */
  setup(): void {
    // 人设以取值口下发（热加载）：每个 agent 读 this.soul 时按当前账号即时解析，PUT 人设后无需重启。
    const commonOptions = { eventBus: this.eventBus, getSoul: () => this.resolveSoul(), llm: this.llm };
    // 详情页「评论点赞」特性总开关（默认关；线上灰度时置 AIDCP_COMMENT_LIKE=true）。
    // 关闭时：既不注册 CommentLikeAppraiser、也不接线 comment_like.intended 下发——彻底惰性。
    const commentLikeEnabled = process.env.AIDCP_COMMENT_LIKE === 'true';

    // 数据访问闭包
    const getNoteData = (noteId: string) =>
      this.currentNote?.noteId === noteId ? this.currentNote : null;
    const getRemainingBudget = () => this.budget;
    const getSearchedKeywords = () => this.searchedKeywords;

    // ContentEvaluator 需要特殊处理：通过 setVisibleCards 注入数据
    const contentEvaluator = new ContentEvaluator(commonOptions, this.sessionContext);
    contentEvaluator.setVisibleCards(this.visibleCards);
    this.contentEvaluator = contentEvaluator;

    this.roles = [
      contentEvaluator,
      new FeedScroller(commonOptions, this.sessionContext),
      new NoteOpener(commonOptions, this.sessionContext),
      new BackToFeed(commonOptions, this.sessionContext),
      new DeepReader({ ...commonOptions, getNoteData }),
      new CommentReviewer({ ...commonOptions, sessionContext: this.sessionContext, getNoteData }),
      new ContentCuratorRole({ ...commonOptions, sessionContext: this.sessionContext }),
      new InteractionAppraiserRole({ ...commonOptions, sessionContext: this.sessionContext, getNoteData, getRemainingBudget }),
      new AuthorEvaluator({ ...commonOptions, sessionContext: this.sessionContext, getNoteData }),
      // —— 发评论支线（接在互动完成与「是否进主页评估」之间）：评估→撰写→去AI味→循环内人审 ——
      new CommentAppraiser({
        ...commonOptions,
        getNoteData,
        getRemainingComments: () => this.budget.comments,
        ...(this.getCommentDailyRemaining ? { getDailyRemaining: this.getCommentDailyRemaining } : {}),
        // 评论冷却前置到评估阶段（engagement-restraint）：按当前账号查冷却闸（无 gate 时恒放行）。
        getCommentCooldownOk: () => this.cooldownPasses('comment'),
      }),
      new CommentComposer({
        ...commonOptions,
        getNoteData,
        ...(this.getCorpusReferences ? { getCorpusReferences: this.getCorpusReferences } : {}),
      }),
      new CommentDeAiFlavor(commonOptions),
      new CommentApprovalGate({
        ...commonOptions,
        ...(this.commentApproval ? { approval: this.commentApproval } : {}),
        getNoteTitle: (id) => getNoteData(id)?.title ?? null,
        now: this.clock,
      }),
      // —— 评论点赞（comment-like-on-detail，默认关）：自有单航班，结合正文偶尔给一条评论点赞 ——
      ...(commentLikeEnabled
        ? [
            new CommentLikeAppraiser({
              ...commonOptions,
              getNoteData,
              getRemainingCommentLikes: () => this.budget.comment_likes,
              getSessionLikeCounts: () => this.sessionLikeCounts(),
              ...(this.getCommentLikeDailyRemaining ? { getCommentLikeDailyRemaining: this.getCommentLikeDailyRemaining } : {}),
            }),
          ]
        : []),
      // 优质评论归档（语料库 B）：仅在特性开 + 归档闭包就绪时注册；只在 comment_like.confirmed 上落库。
      ...(commentLikeEnabled && this.archiveValuableComment
        ? [new ValuableCommentArchivist({ ...commonOptions, getNoteData, archive: this.archiveValuableComment })]
        : []),
      new ProfileOpener(commonOptions),
      new ProfileBrowser(commonOptions),
      // 登录账号真实昵称采集（change account-real-nickname）：会话开始驱动一次本人主页直驱采昵称、回 feed。
      new NicknameEnricher({
        ...commonOptions,
        sessionContext: this.sessionContext,
        getAccountId: () => this.currentAccountId,
        ...(this.setNickname ? { setNickname: this.setNickname } : {}),
        setTimeoutFn: this.setTimeoutFn,
        clearTimeoutFn: this.clearTimeoutFn,
      }),
      new FollowAgent({ ...commonOptions, sessionContext: this.sessionContext, getRemainingFollows: () => this.budget.follows }),
      new SearchScroller(commonOptions, this.sessionContext),
      new SearchEvaluator({
        ...commonOptions,
        sessionContext: this.sessionContext,
        getSearchedKeywords,
        getConceptPool: () => this.conceptPool,
      }),
      new SearchExecutor({ ...commonOptions, sessionContext: this.sessionContext }),
      // 时长上限统一经调度器 maxDurationMs() 解析（按账号读单场上限提供者，热加载）；
      // SessionMonitorRole 不再直读人设，复用同一路径，使后台改即时生效、缺省回落写死默认。
      new SessionMonitorRole({
        ...commonOptions,
        // 监测体判结束 = 正常结束（时长/动作数/配额/idle）→ 可续场（与运营 stop/暂停/发布让位区分）。
        onSessionEnd: (reason: string) => this.endSession(reason, { autoResumeEligible: true }),
        getRemainingBudget: () => this.budget,
        getMaxDurationMs: () => this.maxDurationMs(),
        // 看门狗两段阈值按账号现读（热加载）；未注入续场提供者 → 回落写死默认（轻推~2min / 放弃 1h）。
        getIdleNudgeMs: () => this.resumeConfigProvider?.idleNudgeMsFor(this.currentAccountId) ?? DEFAULT_IDLE_NUDGE_MS,
        getIdleEndMs: () => this.resumeConfigProvider?.idleEndMsFor(this.currentAccountId) ?? DEFAULT_IDLE_END_MS,
        clock: this.clock,
      }),
      // —— 通知巡视（消息查看）12 角色：检测→准入→暂停→开首页→分诊→按类浏览→分类→去重→发飞书→返回→恢复 ——
      new NotificationGatekeeper({ ...commonOptions, isHardPaused: this.isHardPaused }, this.sessionContext),
      new BrowseSuspender(commonOptions, this.sessionContext),
      new NotificationHomeOpener(commonOptions, this.sessionContext),
      new NotificationTriage(commonOptions, this.sessionContext),
      new NotificationCommentBrowser(commonOptions, this.sessionContext),
      new NotificationLikeBrowser(commonOptions, this.sessionContext),
      new NotificationFollowBrowser(commonOptions, this.sessionContext),
      new NotificationClassifier(commonOptions, this.sessionContext),
      new NotificationDeduper(commonOptions, this.sessionContext),
      new NotificationNotifier({ ...commonOptions, notify: this.notifyComments }, this.sessionContext),
      new NotificationReturnHome(commonOptions, this.sessionContext),
      new ExcursionResumer(commonOptions, this.sessionContext),
    ];

    // 概念抽取角色：仅在概念池可用时注册（PG 不可用则不抽取，搜索退化为仅 seed_keywords）。
    if (this.conceptStore) {
      const sink = this.conceptStore;
      this.roles.push(new ConceptExtractorRole({ ...commonOptions, conceptStore: sink }));
    }

    // 捕获 SessionMonitor 引用：供 excursion（巡视）起止 → 暂停/恢复其时钟（唯一实例）。
    this.sessionMonitor = this.roles.find((r) => r instanceof SessionMonitorRole) as
      | SessionMonitorRole
      | undefined;

    // 角色订阅 / 指令翻译 / Edge 事件接线**推迟到会话激活**（startSession / restartSession）才进行——
    // 多租户（multi-account-node-support）：setup() 仅构造角色 + 注册「边缘 hello → 启动闸」入口监听，
    // 绝不在此接线浏览反应链、也绝不启动 SessionMonitor 看门狗。否则：
    //  (1) 未绑人设被诚实拒绝的账号，仍会因边缘自发上报 page.cards 而经反应链在**默认人设上空跑**（红线）；
    //  (2) 仅供预览 / 从未启动会话的 dispatcher，其 SessionMonitor 定时器会向**所有**边缘误广播 idle_nudge/session.end；
    //  (3) 从未启动的连接断开时 endSession 因 !sessionActive 早退、定时器永不清理而泄漏。
    // 反应链/看门狗的生命周期由此与「会话是否激活」严格绑定（激活才接线、endSession 即拆除）。

    // 永久监听：边缘 hello → 设当前账号 + 诚实人设/调度闸 → 启动/重启会话。刻意注册在 commandUnsubscribers 之外，
    // 故即使会话因超时/动作数 endSession 拆除其余订阅，此监听仍在，重连/恢复后可重新驱动。
    // 多租户（multi-account-node-support）：每连接私有总线上恰好一条 edge.hello（handler 携 accountId 发），此监听即该连接的启动入口。
    this.eventBus.on('edge.hello', (payload) =>
      this.onHelloEvent(payload as { edgeId: string; accountId?: string; ts: number }),
    );
  }

  /**
   * 边缘 hello 事件入口：把连接账号设入当前账号，过启动闸后启动/重启会话。
   * 启动闸在角色重订阅 / 指令翻译重连**之前**短路——未绑人设的账号不开浏览循环、不发巡刷信号（D3）。
   */
  private onHelloEvent(payload: { edgeId: string; accountId?: string; ts: number }): void {
    if (payload.accountId) this.currentAccountId = payload.accountId;
    if (!this.canStartSession()) return;
    this.restartSession();
  }

  /**
   * 会话启动闸（诚实人设 + 全局调度开关）。`default` 账号**硬豁免**（始终可启动、沿用打包默认人设回落）。
   * 未绑人设的非 default 账号：发 onSessionRejected（置 needs_persona_setup + 告警）并短路，绝不以默认人设静默开跑。
   * 人设存储读不到时 isPersonaBound 返回 false（fail-closed）→ 一并诚实拒绝。
   */
  private canStartSession(): boolean {
    if (!this.isDispatchActive()) return false;
    if (this.currentAccountId !== 'default' && this.isPersonaBound && !this.isPersonaBound(this.currentAccountId)) {
      console.warn(
        `[RoleDispatcher] 账号 ${this.currentAccountId} 未绑定人设 → 拒绝启动浏览会话（needs_persona_setup）：不开循环、不发巡刷信号`,
      );
      void this.onSessionRejected?.(this.currentAccountId, 'needs_persona_setup');
      return false;
    }
    return true;
  }

  /** 外部触发会话启动（经启动闸）：供面板恢复调度 / 显式启动用；已在跑则不重复。 */
  tryStartSession(): void {
    if (this.sessionActive) return;
    if (!this.canStartSession()) return;
    this.restartSession();
  }

  /**
   * 单次浏览会话的初始互动预算：按当前账号从单场上限提供者读（热加载），缺省回落写死默认。
   * 返回新拷贝（live budget 会被逐项扣减）。供初始化与会话重置复用，避免口径漂移。
   */
  private freshBudget(): SessionInteractionBudget {
    return this.sessionLimitProvider?.sessionBudgetFor(this.currentAccountId) ?? defaultSessionBudget();
  }

  /**
   * 本场已发生的 笔记赞 / 评论赞 计数（= 会话初始预算快照 - 当前剩余），供 CommentLikeAppraiser 的频率比率闸。
   * 用会话开始/重置时存的 budgetInit 快照（不现读提供者），杜绝会话中途运营改预算致 init−剩余 漂移。
   */
  private sessionLikeCounts(): { noteLikes: number; commentLikes: number } {
    return {
      noteLikes: Math.max(0, this.budgetInit.likes - this.budget.likes),
      commentLikes: Math.max(0, this.budgetInit.comment_likes - this.budget.comment_likes),
    };
  }

  /** 启动会话：接线角色 / 指令翻译 / Edge 事件（看门狗在此随 SessionMonitor.subscribe 启动），再发 feed.entered。 */
  startSession(): void {
    // 会话开始 → 取消任何待发休息计时器（已重开，无需续场）。
    this.cancelRestTimer();
    // 幂等：已活跃则先拆旧订阅，避免重复接线（正常路径下 setup 后首次启动无需拆除）。
    if (this.sessionActive) {
      this.roles.forEach((r) => r.unsubscribe());
      for (const unsub of this.commandUnsubscribers) unsub();
      this.commandUnsubscribers = [];
    }
    // 会话激活才接线浏览反应链 + 看门狗（见 setup() 注释：未激活的 dispatcher 绝不接线/起定时器）。
    this.roles.forEach((r) => r.subscribe());
    this.setupCommandTranslation();
    this.setupEdgeEventSubscriptions();
    this.sessionActive = true;
    this.sessionStartedAt = this.clock();
    // 按当前账号刷新单场预算 + 快照（热加载：会话开始即取最新配置）。
    this.budget = this.freshBudget();
    this.budgetInit = { ...this.budget };
    this.searchLimiter.resetSession();
    // 跨会话概念记忆：异步刷新，不阻塞 feed.entered（首次搜索发生在连刷阈值之后，届时池已就绪）。
    void this.refreshConceptPool();
    this.eventBus.emit('feed.entered', {
      pageType: 'feed',
      trigger: 'session_start',
      ts: this.clock(),
    });
  }

  /**
   * 从 ConceptStore 载入概念池快照供 SearchEvaluator 使用。
   * PG 不可用 / loadPool 失败 → 回退空池（退化为仅 seed_keywords），不崩浏览闭环。
   */
  private async refreshConceptPool(): Promise<void> {
    if (!this.conceptStore) {
      this.conceptPool = EMPTY_CONCEPT_POOL;
      return;
    }
    try {
      this.conceptPool = await this.conceptStore.loadPool();
      console.log(
        `[RoleDispatcher] 概念池已载入：candidates=${this.conceptPool.candidates.length} known=${this.conceptPool.known.length}`,
      );
    } catch (err) {
      this.conceptPool = EMPTY_CONCEPT_POOL;
      console.warn(`[RoleDispatcher] 概念池载入失败，退化为仅 seed_keywords: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * 边缘新 hello 时重置并重启会话。
   *
   * 修复 bug：会话原本只在云端启动时 setup()+startSession() 一次性开启，
   * SessionMonitor 的 startedAt 即云端进程启动时刻，会话时长随墙钟一直累计；
   * 达 max_duration_min 后 endSession 拆除全部订阅，此后任何重连的边缘都不再被驱动
   * （page.cards 无人处理 → 静默）。现在每次边缘 hello 都重置会话，使会话时长从
   * 连接时刻起算，超时结束后下次连接也能重新驱动。
   */
  restartSession(): void {
    // 会话重开 → 取消待发休息计时器（边缘先自连重连即走此路，竞态由此化解）。
    this.cancelRestTimer();
    // 若仍活跃，先拆除旧订阅，避免重复注册
    if (this.sessionActive) {
      this.roles.forEach((r) => r.unsubscribe());
      for (const unsub of this.commandUnsubscribers) unsub();
      this.commandUnsubscribers = [];
    }
    // 重置会话态（visitedNoteIds 由 SessionContext.reset 跨轮保留）
    // 按当前账号刷新单场预算 + 快照（热加载；currentAccountId 已在 onHelloEvent 设入）。
    this.budget = this.freshBudget();
    this.budgetInit = { ...this.budget };
    this.searchedKeywords = [];
    this.searchLimiter.resetSession();
    void this.refreshConceptPool();
    this.sessionContext.reset();
    // 重新订阅角色与接线（SessionMonitor.subscribe 重置 startedAt/actionCount）
    this.roles.forEach((r) => r.subscribe());
    this.setupCommandTranslation();
    this.setupEdgeEventSubscriptions();
    this.sessionActive = true;
    this.sessionStartedAt = this.clock();
    this.eventBus.emit('feed.entered', {
      pageType: 'feed',
      trigger: 'session_start',
      ts: this.clock(),
    });
    console.log('[RoleDispatcher] 边缘 hello → 会话已重置并重启');
  }

  /**
   * 结束会话。
   * @param opts.autoResumeEligible 本次结束是否「正常结束」可自动续场（时长/动作数/配额/idle）。
   *   运营 stop / 验证码-风控暂停 / 掉线 / 发布让位 → 缺省 false（不续）。
   */
  endSession(reason?: string, opts?: { autoResumeEligible?: boolean }): void {
    // 不论是否活跃，先取消任何待发休息计时器（运营 stop / 掉线 / 发布让位都不该残留续场）。
    this.cancelRestTimer();
    if (!this.sessionActive) return;
    const account = this.currentAccountId;
    // 记当日累计浏览时长（含 excursion，仅供每日上限近似）。
    const elapsed = this.clock() - this.sessionStartedAt;
    if (elapsed > 0) this.dailyTally(account, this.clock()).browseMs += elapsed;
    this.sessionActive = false;
    this.roles.forEach((r) => r.unsubscribe());
    for (const unsub of this.commandUnsubscribers) unsub();
    this.commandUnsubscribers = [];
    console.log(`[RoleDispatcher] 会话结束: ${reason ?? 'manual'}`);
    // 仅「正常结束」且续场特性已开（注入提供者）才安排休息+续场。
    if (opts?.autoResumeEligible) this.armRestTimer(account);
  }

  // ─── 自动续场（change session-auto-resume-with-excursions）─────────────────────
  // 单场正常结束 → 歇 rest（= 单场时长 × rest_ratio，叠抖动）→ 过续场各闸 → tryStartSession。
  // 休息计时器每连接私有、unref、只重开本连接会话，绝不广播；任何 (re)start / endSession 即取消。

  private cancelRestTimer(): void {
    if (this.restTimer !== undefined) {
      this.clearTimeoutFn(this.restTimer);
      this.restTimer = undefined;
    }
  }

  /** 安排休息计时器。未注入续场提供者 → 特性关、保持旧行为（不续）。 */
  private armRestTimer(account: string): void {
    this.cancelRestTimer();
    if (!this.resumeConfigProvider) return; // 特性未开 → 不续（零回归）。
    const ratio = this.resumeConfigProvider.restRatioFor(account);
    const base = this.maxDurationMs() * ratio; // maxDurationMs 按 currentAccountId 读
    const restMs = Math.max(0, Math.round(base * this.restJitter()));
    this.restTimer = this.setTimeoutFn(() => {
      this.restTimer = undefined;
      this.onRestElapsed(account);
    }, restMs);
    (this.restTimer as { unref?: () => void } | undefined)?.unref?.();
  }

  /** 休息到点：过续场各闸 → 续场。账号已切换 → 放弃（重连到别的账号）。 */
  private onRestElapsed(account: string): void {
    if (this.currentAccountId !== account) return; // 重连到别的账号，放弃
    this.doAutoResume(account);
  }

  /**
   * 续场（发布让位结束后由连接注册表按账号调用）：过续场各闸（含活跃时段/每日上限/风控）→ 起新场。
   * 与休息到点共用同一闸；闸不过（如发布发生在活跃窗口外）→ 诚实不续，等边缘重连/下一窗口。
   */
  tryAutoResume(): void {
    this.doAutoResume(this.currentAccountId);
  }

  private doAutoResume(account: string): void {
    if (this.sessionActive) return; // 边缘已先自连重开
    if (!this.canAutoResume(account)) return; // 护栏不过：诚实不续
    this.dailyTally(account, this.clock()).sessions += 1;
    this.tryStartSession();
  }

  /** 续场闸：调度开关 + 人设（canStartSession）+ 风控状态 + 活跃时段窗口 + 每日上限。 */
  private canAutoResume(account: string): boolean {
    if (!this.canStartSession()) return false; // dispatchActive + 人设绑定
    const risk = this.getRiskStatus();
    if (risk === 'restricted' || risk === 'frozen') return false; // 撞风控不续
    if (!this.resumeConfigProvider) return false; // 无提供者 = 特性关
    const now = this.clock();
    const win = this.resumeConfigProvider.activeWindowFor(account);
    if (!isWithinActiveWindow(this.minuteOfDay(now), win)) return false; // 过活跃时段窗口
    const caps = this.resumeConfigProvider.dailyCapsFor(account);
    const tally = this.dailyTally(account, now);
    if (caps.maxSessions > 0 && tally.sessions >= caps.maxSessions) return false; // 每日场数到顶
    if (caps.maxMinutes > 0 && tally.browseMs >= caps.maxMinutes * 60_000) return false; // 每日时长到顶
    return true;
  }

  /** 取/重置某账号当日续场计数（按本地日界重置）。 */
  private dailyTally(account: string, now: number): { dayKey: string; sessions: number; browseMs: number } {
    const dayKey = this.localDayKey(now);
    let t = this.dailyResume.get(account);
    if (!t || t.dayKey !== dayKey) {
      t = { dayKey, sessions: 0, browseMs: 0 };
      this.dailyResume.set(account, t);
    }
    return t;
  }

  private localDayKey(now: number): string {
    const d = new Date(now);
    return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
  }

  private minuteOfDay(now: number): number {
    const d = new Date(now);
    return d.getHours() * 60 + d.getMinutes();
  }

  /** 休息时长抖动（lognormal，中心 1.0），使每次休息不等长（拟人）。randomFn 可注入定值（测试）。 */
  private restJitter(): number {
    // Box–Muller 取标准正态 → exp(σ·z)，σ 取 0.25（约 ±25% 一档）。clamp 防极端。
    const u1 = Math.max(1e-9, this.randomFn());
    const u2 = this.randomFn();
    const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
    const mult = Math.exp(0.25 * z);
    return Math.min(2, Math.max(0.5, mult));
  }

  // ─── Edge 数据注入接口 ────────────────────────────────────────

  /** Edge 上报可见卡片数据 */
  updateVisibleCards(cards: VisibleCard[]): void {
    this.visibleCards = cards;
    if (this.contentEvaluator) {
      this.contentEvaluator.setVisibleCards(cards);
    }
  }

  /** Edge 上报笔记详情数据 */
  updateNoteData(note: NoteData): void {
    this.currentNote = note;
  }

  /** Edge 上报互动预算消耗 */
  consumeBudget(action: 'like' | 'collect' | 'follow' | 'search' | 'comment' | 'comment_like'): void {
    if (action === 'like' && this.budget.likes > 0) this.budget.likes--;
    else if (action === 'collect' && this.budget.collects > 0) this.budget.collects--;
    else if (action === 'follow' && this.budget.follows > 0) this.budget.follows--;
    else if (action === 'search' && this.budget.searches > 0) this.budget.searches--;
    else if (action === 'comment' && this.budget.comments > 0) this.budget.comments--;
    else if (action === 'comment_like' && this.budget.comment_likes > 0) this.budget.comment_likes--;
  }

  /** 剩余关注配额（测试可观测）。 */
  get remainingFollows(): number {
    return this.budget.follows;
  }

  /**
   * 冷却闸判定（engagement-restraint）：true=已过冷却可下发；false=未到点（已记中性日志「按冷却跳过」）。
   * 无 cooldownGate（向后兼容）时恒 true。用 this.clock() 取时（注入时钟便于单测）。
   */
  private cooldownPasses(action: CooldownAction): boolean {
    if (!this.cooldownGate) return true;
    const now = this.clock();
    if (this.cooldownGate.canAct(this.currentAccountId, action, now)) return true;
    const remainS = Math.ceil(this.cooldownGate.remainingMs(this.currentAccountId, action, now) / 1000);
    console.log(`[RoleDispatcher] 按冷却跳过 action=${action}（还需 ${remainS}s，account=${this.currentAccountId}）`);
    return false;
  }

  /** 记一次真实成功动作的冷却时间戳（仅 ok:true、follow 非 already_followed 时调用）。无 gate 则 no-op。 */
  private markCooldown(action: CooldownAction): void {
    this.cooldownGate?.markActed(this.currentAccountId, action, this.clock());
  }

  // ─── 内部：Edge 指令翻译层 ────────────────────────────────────

  private setupCommandTranslation(): void {
    this.commandUnsubscribers.push(
      this.eventBus.on('feed.scrolled', () => {
        this.sendCommand({ action: 'scroll', reason: 'feed_scroll' });
      }),

      this.eventBus.on('search.scrolled', () => {
        this.sendCommand({ action: 'scroll', reason: 'search_scroll' });
      }),

      // idle 看门狗的恢复 nudge → 一次 scroll，重新驱动停滞的浏览循环（reason 仅作日志区分）。
      this.eventBus.on('session.idle_nudge', () => {
        this.sendCommand({ action: 'scroll', reason: 'idle_recover_nudge' });
      }),

      // note.entered 不再发送指令：content.valuable 已经发送了带 index 的 open_note
      // quality.reject 不再直接发 back：BackToFeed 角色会通过 feed.entered 统一发送

      this.eventBus.on('interaction.completed', (payload) => {
        for (const action of payload.actions) {
          // 风控闸：被拒则诚实跳过——不下发、不扣 budget（红线：不假成功、budget 不漂移）。
          if (!this.canInteract(action)) {
            console.log(`[RoleDispatcher] 互动被风控拦截，跳过 action=${action} note=${payload.noteId}`);
            continue;
          }
          // 冷却闸（engagement-restraint）：未到点诚实跳过——不下发、不扣 budget（与风控拦截同口径，红线：不假成功）。
          if (!this.cooldownPasses(action)) continue;
          // 互动前犹豫时间（time directive）：边缘据此在执行前等待并叠抖动。
          // 下发被去重跳过（同账号已在途/已完成）则不扣会话预算（不漂移）。
          const sent = this.sendCommand({ action, params: { noteId: payload.noteId, thinkMs: this.thinkNow() } });
          if (sent) this.consumeBudget(action);
        }
      }),

      // 人审通过的评论 → 下发 comment 指令。风控闸：被拒则诚实跳过（不下发、不扣额），仍 emit comment.skipped 走「是否进主页评估」。
      // 配额改由 action.completed 真实回执扣减（对齐 follow）。
      this.eventBus.on('comment.approved', (payload) => {
        if (!this.canInteract('comment')) {
          console.log(`[RoleDispatcher] 评论被风控拦截，跳过 note=${payload.noteId}`);
          this.eventBus.emit('comment.skipped', {
            noteId: payload.noteId,
            sourcePageType: payload.sourcePageType,
            actions: payload.actions,
            reason: 'risk_blocked',
            ts: this.clock(),
          });
          return;
        }
        this.pendingComment = {
          noteId: payload.noteId,
          sourcePageType: payload.sourcePageType,
          actions: payload.actions,
          text: payload.text,
        };
        this.sendCommand({ action: 'comment', params: { noteId: payload.noteId, text: payload.text, thinkMs: this.thinkNow() } });
      }),

      // 进作者主页：专用 profile_open 指令（取代 open_note{type:'profile'}——
      // type 字段在 NoteOpenPayload 不存在会被静默丢弃，导致边缘开错笔记、从不进主页）。
      this.eventBus.on('profile.entered', (payload) => {
        this.sendCommand({ action: 'profile_open', params: { authorId: payload.authorId, thinkMs: this.thinkNow() } });
      }),

      // 本人主页昵称采集（change account-real-nickname）：云端内部事件 → profile_open{direct:true}。
      // **不复用** profile.entered（它会 seed ProfileBrowser.pending 把自己拖进浏览管线）；direct=true 让 edge 直 navi
      // 到 /user/profile/<accountId>、纯执行。授信经 selfCaptureInFlight 在 chokepoint 放行（见 sendCommand）。
      this.eventBus.on('self.profile.capture', (payload) => {
        this.sendCommand({ action: 'profile_open', params: { authorId: payload.accountId, direct: true, thinkMs: this.thinkNow() } });
      }),

      // 深读：多图浏览意图 → browse_images 指令（dwellMs 按正文量级，thinkMs 为开始前犹豫）。
      this.eventBus.on('reading.browse_images', (payload) => {
        const dwellMs = this.dwellForCurrentNote('glance');
        this.sendCommand({
          action: 'browse_images',
          params: { noteId: payload.noteId, count: payload.count, thinkMs: this.thinkNow(), ...(dwellMs === undefined ? {} : { dwellMs }) },
        });
      }),

      // 深读：评论浏览意图 → scroll_comments 指令。
      this.eventBus.on('reading.scroll_comments', (payload) => {
        const dwellMs = this.dwellForCurrentNote('glance');
        this.sendCommand({
          action: 'scroll_comments',
          params: { noteId: payload.noteId, thinkMs: this.thinkNow(), ...(dwellMs === undefined ? {} : { dwellMs }) },
        });
      }),

      // 评论点赞意图 → comment_like 指令。风控闸 + 每场预算：被拒诚实跳过（不下发、不扣额）。
      // 预算按真实回执扣减（见 action.completed），thinkMs 为点前犹豫（边缘只叠抖动，不另加停留）。
      // 开关关时 CommentLikeAppraiser 未注册 → 不会有 comment_like.intended，此订阅天然惰性。
      this.eventBus.on('comment_like.intended', (payload) => {
        if (!this.canInteract('comment_like')) {
          console.log(`[RoleDispatcher] 评论赞被风控拦截，跳过 note=${payload.noteId}`);
          return;
        }
        if (this.budget.comment_likes <= 0) {
          console.log('[RoleDispatcher] 评论赞会话预算已耗尽，跳过');
          return;
        }
        this.sendCommand({
          action: 'comment_like',
          params: { noteId: payload.noteId, commentAnchorId: payload.commentAnchorId, thinkMs: this.thinkNow() },
        });
      }),

      // 主页关注评估完成 → **单一时序点**：先下发关注（仅当决定关注且风控放行时），紧接着 emit profile.exit
      // 让 BackToFeed 返回信息流。靠边缘 FIFO 命令队列保证「关注先入队先执行、返回后执行」，返回不再死等关注回执
      // （修：关注被风控拦截 → 永不产生 follow 回执 → 旧的「等回执再返回」死等 → 会话卡死在作者主页）。
      // 三分支（关注且放行 / 关注被拦 / 决定不关注）都收敛到恰好一次 profile.exit → 恰好一次返回。
      this.eventBus.on('profile.done', (payload) => {
        // 隔离守卫②（change account-real-nickname 兜底网）：本人绝不自关注。自路径正常不到这里
        // （ProfileBrowser 已早退、不 emit profile.browsed → 无 profile.done），此为非标记可达消费者的兜底；
        // 仍须 emit 恰好一次 profile.exit 离开主页，绝不早退（否则会话卡死在主页）。
        if (payload.authorId === this.currentAccountId) {
          this.eventBus.emit('profile.exit', { sourcePageType: payload.sourcePageType, reason: 'not_followed', ts: this.clock() });
          return;
        }
        let reason: 'followed' | 'follow_blocked' | 'not_followed';
        if (payload.followed) {
          // 风控闸：被拒则诚实跳过（不下发、不扣额；follow 配额仍由 action.completed 真实回执扣减）。
          if (!this.canInteract('follow')) {
            console.log('[RoleDispatcher] 关注被风控拦截，跳过 follow');
            reason = 'follow_blocked';
          } else if (!this.cooldownPasses('follow')) {
            // 冷却闸：未到点诚实跳过——不下发关注；仍收敛到 profile.exit 返回信息流（不死锁）。
            reason = 'follow_blocked';
          } else {
            this.sendCommand({ action: 'follow', params: { authorId: payload.authorId, thinkMs: this.thinkNow() } });
            reason = 'followed';
          }
        } else {
          reason = 'not_followed';
        }
        // 关注命令（若有）已入队；MUST 在同一处理点紧接着 emit 返回信号——不可拆散到另一个响应 profile.done
        // 的地方，否则返回可能抢在关注前下发导致关注落空（这正是原先用「等回执」绕开的竞态）。
        this.eventBus.emit('profile.exit', { sourcePageType: payload.sourcePageType, reason, ts: this.clock() });
      }),

      this.eventBus.on('feed.entered', (payload) => {
        if (payload.trigger === 'back_to_feed') {
          // 返回前停留下限（time directive）：笔记已被打开并阅读过（curator 关卡），按 read 量级
          // 给停留，治「无价值秒退」。无当前笔记时 dwellMs=undefined，边缘走内置默认兜底。
          const dwellMs = this.dwellForCurrentNote('read');
          // 透传来源页型 → targetPage：搜索来源会话回搜索结果、feed 来源回 explore（此前一律丢失被错误拽回 explore）。
          const params: Record<string, unknown> = dwellMs === undefined ? {} : { dwellMs };
          if (payload.pageType) params.targetPage = payload.pageType;
          this.sendCommand({ action: 'back', reason: 'back_to_feed', params });
        }
      }),

      this.eventBus.on('search.approved', (payload) => {
        const keyword = payload.keyword;
        // 搜索前两道闸（红线：被拦则诚实跳过——不下发、不扣 budget、不 markSearched，绝不假成功）。
        // 闸一：会话搜索预算。
        if (this.budget.searches <= 0) {
          console.log(`[RoleDispatcher] 搜索被拦截，跳过 keyword=${keyword} reason=budget_exhausted`);
          return;
        }
        // 闸二：限频（每关键词每会话/每天上限）。
        const decision = this.searchLimiter.explain(keyword);
        if (!decision.allowed) {
          console.log(`[RoleDispatcher] 搜索被拦截，跳过 keyword=${keyword} reason=${decision.reason}`);
          return;
        }
        // 两道闸通过 → 记账 + 下发（如实带上 source）。
        this.searchLimiter.recordSearch(keyword);
        this.searchedKeywords.push(keyword);
        this.consumeBudget('search');
        const params: Record<string, unknown> = { keyword };
        if (payload.source) params.source = payload.source;
        this.sendCommand({ action: 'search', params });
        // 跨会话标记已搜（fire-and-forget，失败不影响本次下发）。
        this.conceptStore?.markSearched(keyword).catch((err) =>
          console.warn(`[RoleDispatcher] markSearched 失败 keyword=${keyword}: ${err instanceof Error ? err.message : String(err)}`),
        );
      }),

      // 角色产出事件 → Edge 指令翻译
      this.eventBus.on('content.valuable', (payload) => {
        // 带上 noteId：edge 据此在「当前快照」里按稳定主键定位目标卡。
        // 否则 feed 在云端决策与 edge 执行之间滚动后，纯 index 寻址会开成同序号上的邻座（stale index）。
        // 熟悉度折扣：返回 feed 后再次打开一张近期已评估过的卡片 → 思考时间降至 1/3（首次打开仍全量）。
        const familiar = payload.noteId ? this.sessionContext.isRecentlyEvaluated(payload.noteId) : false;
        this.sendCommand({ action: 'open_note', params: { index: payload.index, noteId: payload.noteId, thinkMs: this.thinkNow(familiar) }, reason: payload.reason });
      }),

      // content.no_valuable 不在此直接翻页：翻页由 FeedScroller / SearchScroller 角色独家处理
      // （它们带 pageType 过滤 + 连续滚动计数，到阈值转搜索）。曾在此再直接发一条 scroll，导致一次
      // “没价值”判定被双发两条 scroll：第二条落在尚未判定的新页上、把它（可能含 AI 卡）直接滚过，
      // 且污染了“连续滚 N 次转搜索”的阈值。删除以恢复单一翻页决策者。
      this.eventBus.on('session.should_end', (payload) => {
        this.sendCommand({ action: 'session.end', reason: payload.reason });
        // 监测体判结束（时长/动作数/配额/idle）= 正常结束 → 可自动续场（歇 N% 后续刷）。
        this.endSession(payload.reason, { autoResumeEligible: true });
      }),

      // —— 通知巡视：角色意图 → 边缘命令（均为 excursion 来源，巡视暂停期照常放行）——
      // 去通知首页：首次 open（→ open_notifications）/ 一类处理完返回（→ notification_back_home）。
      this.eventBus.on('notification.opening', (payload) => {
        if (payload.reason === 'back') {
          this.sendCommand({ action: 'notification_back_home', params: { thinkMs: this.thinkNow() } });
        } else {
          this.sendCommand({ action: 'open_notifications', params: { thinkMs: this.thinkNow() } });
        }
      }),

      // 进入某分类浏览：按 category 翻译为各自命令（边缘 handler 各知各的选择器）。
      this.eventBus.on('notification.browse_category', (payload) => {
        if (payload.category === 'comments') {
          this.sendCommand({
            action: 'browse_notification_comments',
            params: { thinkMs: this.thinkNow(), ...(payload.scrollMax === undefined ? {} : { scrollMax: payload.scrollMax }) },
          });
        } else if (payload.category === 'likes') {
          this.sendCommand({ action: 'browse_notification_likes', params: { thinkMs: this.thinkNow() } });
        } else {
          this.sendCommand({ action: 'browse_notification_follows', params: { thinkMs: this.thinkNow() } });
        }
      }),
    );
  }

  // ─── 内部：Edge 上报事件订阅 ─────────────────────

  private setupEdgeEventSubscriptions(): void {
    this.commandUnsubscribers.push(
      // 通知巡视（excursion）起止 → 暂停/恢复会话时钟（change session-auto-resume-with-excursions）：
      // 巡视进行中延期时限/动作数/配额判定（不打断巡视），结束时把巡视耗时从单场时长扣除。
      // 只暂停时限判定，**不冻空闲看门狗**（巡视上报自喂、卡死巡视由看门狗兜底）。token 用常量 'patrol'
      //（gatekeeper 以 ctx.excursionActive 闸禁并发巡视，全程至多一个活动巡视，常量 token 天然正确）。
      this.eventBus.on('excursion.requested', () => this.sessionMonitor?.pauseClock('patrol')),
      this.eventBus.on('excursion.ended', () => this.sessionMonitor?.resumeClock('patrol')),

      // Edge 上报可见卡片 → 更新数据并触发评估
      this.eventBus.on('page.cards.arrived', (payload) => {
        this.updateVisibleCards(payload.cards);
        void this.contentEvaluator?.evaluate(this.sessionContext.sourcePageType);
      }),

      // Edge 上报笔记详情 → 更新当前笔记数据
      this.eventBus.on('note.detail.arrived', (payload) => {
        this.updateNoteData(payload.detail);
      }),

      // Edge 上报作者主页资料 → ProfileBrowser 直接消费 profile.detail.arrived 产出 profile.browsed
      // （携带真实 counts + extracted 标记），此处无需 dispatcher 中转存储。

      // Edge 确认动作完成。失败动作（如 open_note modal_timeout）边缘不会再产生
      // note.detail/page.cards，事件循环会因无触发而死等；统一以一次 scroll 续刷兜底。
      this.eventBus.on('action.completed', (payload) => {
        console.log(`[RoleDispatcher] action.completed: ${payload.action} ok=${payload.ok}`);
        // 冷却时间戳（engagement-restraint）：仅在真实成功（ok:true）时落；下发失败不起算（不白占冷却窗）。
        // follow 排除 already_followed 良性 no-op（与「no-op 不烧配额」同口径，不算一次真关注）。
        if (payload.ok === true) {
          if (payload.action === 'like' || payload.action === 'collect' || payload.action === 'comment') {
            this.markCooldown(payload.action);
          } else if (payload.action === 'follow' && payload.reason !== 'already_followed') {
            this.markCooldown('follow');
          }
        }
        // 同账号并行（N:1）：释放该动作的在途去重坑。成功且非 already_followed no-op → 记已完成（不再重复对同目标动作）；
        // 失败 / already_followed → 仅释放在途坑（允许后续重试）。靠边缘 FIFO 回执与 per-动作单坑对齐，TTL 兜底防丢回执永久占坑。
        if (this.interactionGuard && isGuardedInteraction(payload.action)) {
          const key = this.pendingInteractionKeys.get(payload.action);
          if (key) {
            if (payload.ok === true && payload.reason !== 'already_followed') this.interactionGuard.complete(key);
            else this.interactionGuard.releaseFailed(key);
            this.pendingInteractionKeys.delete(payload.action);
          }
        }
        // follow 配额按真实回执扣减：仅当发生了真实的新关注点击（ok:true 且非 already_followed no-op）。
        // already_followed（良性 no-op）与各类失败（ok:false）均不扣额，使配额对齐真实平台动作。
        if (payload.action === 'follow' && payload.ok === true && payload.reason !== 'already_followed') {
          this.consumeBudget('follow');
        }
        // 评论赞回执：真点成功才扣每场预算（对齐 follow/comment）。CommentLikeAppraiser 自行据回执 emit
        // comment_like.confirmed 供归档；此处只管会话预算，风控记账走 handler→interaction.occurred。
        if (payload.action === 'comment_like' && payload.ok === true) {
          this.consumeBudget('comment_like');
        }
        // 评论回执：真发成功才扣额（对齐 follow）；无论成功/失败都 emit comment.done 触发「是否进主页评估」
        // （评论支线唯一出口、每篇只一次），失败不死锁、不兜底滑动（否则把详情页滚走）。
        if (payload.action === 'comment' && this.pendingComment) {
          const pc = this.pendingComment;
          this.pendingComment = null;
          if (payload.ok === true) this.consumeBudget('comment');
          this.eventBus.emit('comment.done', {
            noteId: pc.noteId,
            sourcePageType: pc.sourcePageType,
            actions: pc.actions,
            ok: payload.ok === true,
            ts: this.clock(),
          });
        }
        // follow 失败不在此兜底滑动：返回信息流已由 profile.done 单一时序点经 profile.exit 触发
        // （与 follow 回执解耦，回执此处只用于配额扣减）；若再滑一屏会与已在途的返回命令打架。
        // browse_images / scroll_comments 在详情页内执行，失败由 DeepReader / CommentReviewer
        // 自行推进（emit reading.images_done / reading.done），此处不发 feed 滚动（否则会把详情页滚走）。
        const noRecoverScroll = payload.action === 'follow' || payload.action === 'browse_images' || payload.action === 'scroll_comments' || payload.action === 'comment' || payload.action === 'comment_like';
        if (payload.ok === false && !noRecoverScroll && this.sessionActive) {
          console.log(`[RoleDispatcher] 动作失败兜底 → scroll（recover_after_${payload.action}_failed）`);
          this.sendCommand({ action: 'scroll', reason: `recover_after_${payload.action}_failed` });
        }
      }),
    );
  }
}
