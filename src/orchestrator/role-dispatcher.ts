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
import { CommentComposer } from '../agents/comment-composer.js';
import { CommentDeAiFlavor } from '../agents/comment-de-ai-flavor.js';
import { CommentApprovalGate, type CommentApprovalPort } from '../agents/comment-approval-gate.js';
import { ProfileOpener } from '../agents/profile-opener.js';
import { ProfileBrowser } from '../agents/profile-browser.js';
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
  soul: Soul;
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
}

// ─── RoleDispatcher ─────────────────────────────────────────────────────────

export class RoleDispatcher {
  private readonly eventBus: EventBus;
  private readonly sessionContext: SessionContext;
  private readonly soul: Soul;
  private readonly llm: { complete(prompt: string, opts?: LlmCallOpts): Promise<string> };
  private readonly rawSendCommand: (command: EdgeCommand) => void;
  private readonly clock: () => number;
  private readonly getRiskStatus: () => RiskStatus;
  private readonly canInteract: (action: 'like' | 'collect' | 'follow' | 'comment' | 'comment_like') => boolean;
  private readonly commentApproval?: CommentApprovalPort;
  private readonly getCommentDailyRemaining?: () => number;
  private readonly getCommentLikeDailyRemaining?: () => number;
  /** 已下发待回执的评论上下文：action.completed{comment} 据此扣额 + emit comment.done（→ 是否进主页评估）。 */
  private pendingComment: { noteId: string; sourcePageType: 'feed' | 'search'; actions: ('like' | 'collect')[]; text: string } | null = null;
  private readonly isHardPaused: (edgeId?: string) => boolean;
  private readonly notifyComments?: (items: NotificationItem[]) => Promise<void>;
  private readonly conceptStore?: ConceptStorePort;
  /** 搜索前限频闸（每关键词每会话/每天上限），dispatcher 持有单例，会话重启时清会话计数。 */
  private readonly searchLimiter: SearchFrequencyLimiter;
  /** 概念池快照：startSession 时 loadPool 刷新，供 SearchEvaluator 读取。 */
  private conceptPool: ConceptPool = EMPTY_CONCEPT_POOL;
  /** 会话开始时刻与时长上限，用于估算会话进度（疲劳乘子）。 */
  private sessionStartedAt: number;
  private readonly maxDurationMs: number;
  private roles: BaseRole[] = [];
  private contentEvaluator!: ContentEvaluator;
  private commandUnsubscribers: (() => void)[] = [];

  // 数据存储（由 Edge 上报更新）
  private visibleCards: VisibleCard[] = [];
  private currentNote: NoteData | null = null;
  private budget = RoleDispatcher.freshBudget();
  private searchedKeywords: string[] = [];
  private sessionActive = false;

  constructor(options: RoleDispatcherOptions) {
    this.soul = options.soul;
    this.llm = options.llm;
    this.rawSendCommand = options.sendCommand;
    this.clock = options.clock ?? Date.now;
    this.getRiskStatus = options.getRiskStatus ?? (() => 'normal');
    this.canInteract = options.canInteract ?? (() => true);
    this.commentApproval = options.commentApproval;
    this.getCommentDailyRemaining = options.getCommentDailyRemaining;
    this.getCommentLikeDailyRemaining = options.getCommentLikeDailyRemaining;
    this.isHardPaused = options.isHardPaused ?? (() => false);
    this.notifyComments = options.notifyComments;
    this.conceptStore = options.conceptStore;
    this.searchLimiter = new SearchFrequencyLimiter(options.searchLimiterOptions);
    this.eventBus = options.eventBus ?? new EventBus();
    this.sessionContext = new SessionContext();
    this.maxDurationMs = (this.soul.session_limits?.max_duration_min ?? 10) * 60_000;
    this.sessionStartedAt = this.clock();
  }

  /** 会话进度 0..1（已用时长 / 时长上限），供节奏疲劳乘子使用。 */
  private progress(): number {
    const elapsed = this.clock() - this.sessionStartedAt;
    return Math.min(1, Math.max(0, elapsed / this.maxDurationMs));
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
  private sendCommand(command: EdgeCommand): void {
    if (
      this.sessionContext.browseSuspended &&
      command.action !== 'session.end' &&
      !this.isExcursionCommand(command.action)
    ) {
      return; // 软暂停：丢弃 browse 命令（不入队、由 page.cards 续刷自然重来）
    }
    this.rawSendCommand(command);
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
    const commonOptions = { eventBus: this.eventBus, soul: this.soul, llm: this.llm };
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
      }),
      new CommentComposer({ ...commonOptions, getNoteData }),
      new CommentDeAiFlavor(commonOptions),
      new CommentApprovalGate({
        ...commonOptions,
        ...(this.commentApproval ? { approval: this.commentApproval } : {}),
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
      new ProfileOpener(commonOptions),
      new ProfileBrowser(commonOptions),
      new FollowAgent({ ...commonOptions, sessionContext: this.sessionContext, getRemainingFollows: () => this.budget.follows }),
      new SearchScroller(commonOptions, this.sessionContext),
      new SearchEvaluator({
        ...commonOptions,
        sessionContext: this.sessionContext,
        getSearchedKeywords,
        getConceptPool: () => this.conceptPool,
      }),
      new SearchExecutor({ ...commonOptions, sessionContext: this.sessionContext }),
      new SessionMonitorRole({
        ...commonOptions,
        maxDurationMs: (this.soul.session_limits?.max_duration_min ?? 10) * 60_000,
        onSessionEnd: (reason: string) => this.endSession(reason),
        getRemainingBudget: () => this.budget,
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

    // 注册所有角色的事件订阅
    this.roles.forEach((r) => r.subscribe());

    // 注册 Edge 指令翻译层
    this.setupCommandTranslation();

    // 订阅 Edge 上报事件
    this.setupEdgeEventSubscriptions();

    // 永久监听：边缘新 hello → 重启会话。刻意注册在 commandUnsubscribers 之外，
    // 故即使会话因超时/动作数 endSession 拆除其余订阅，此监听仍在，新边缘连接可重新驱动。
    this.eventBus.on('edge.hello', () => this.restartSession());
  }

  /** 单次浏览会话的初始互动预算（供初始化与重置复用，避免口径漂移）。 */
  private static freshBudget(): { likes: number; collects: number; follows: number; searches: number; comments: number; comment_likes: number } {
    return { likes: 10, collects: 5, follows: 3, searches: 5, comments: 2, comment_likes: 3 };
  }

  /** 本场已发生的 笔记赞 / 评论赞 计数（= 初始预算 - 当前剩余），供 CommentLikeAppraiser 的频率比率闸。 */
  private sessionLikeCounts(): { noteLikes: number; commentLikes: number } {
    const init = RoleDispatcher.freshBudget();
    return {
      noteLikes: Math.max(0, init.likes - this.budget.likes),
      commentLikes: Math.max(0, init.comment_likes - this.budget.comment_likes),
    };
  }

  /** 启动会话 */
  startSession(): void {
    this.sessionActive = true;
    this.sessionStartedAt = this.clock();
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
    // 若仍活跃，先拆除旧订阅，避免重复注册
    if (this.sessionActive) {
      this.roles.forEach((r) => r.unsubscribe());
      for (const unsub of this.commandUnsubscribers) unsub();
      this.commandUnsubscribers = [];
    }
    // 重置会话态（visitedNoteIds 由 SessionContext.reset 跨轮保留）
    this.budget = RoleDispatcher.freshBudget();
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

  /** 结束会话 */
  endSession(reason?: string): void {
    if (!this.sessionActive) return;
    this.sessionActive = false;
    this.roles.forEach((r) => r.unsubscribe());
    for (const unsub of this.commandUnsubscribers) unsub();
    this.commandUnsubscribers = [];
    console.log(`[RoleDispatcher] 会话结束: ${reason ?? 'manual'}`);
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
          // 互动前犹豫时间（time directive）：边缘据此在执行前等待并叠抖动
          this.sendCommand({ action, params: { noteId: payload.noteId, thinkMs: this.thinkNow() } });
          this.consumeBudget(action);
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

      this.eventBus.on('profile.done', (payload) => {
        if (payload.followed) {
          // 风控闸：被拒则诚实跳过（不下发）。follow 配额本就由 action.completed 真实回执扣减，跳过即不会产生回执、不扣额。
          if (!this.canInteract('follow')) {
            console.log('[RoleDispatcher] 关注被风控拦截，跳过 follow');
          } else {
            this.sendCommand({ action: 'follow', params: { authorId: payload.authorId, thinkMs: this.thinkNow() } });
            // follow 配额改由 action.completed 真实回执扣减（仅真实新关注；already_followed no-op 与失败均不扣）。
          }
        }
        // back 指令由 BackToFeed 角色通过 feed.entered 统一发送，此处不再重复
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
        this.endSession(payload.reason);
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
        // follow 的回执由 BackToFeed 接管去"返回"，不在此兜底滑动——否则 follow 失败会
        // 既滑一屏又返回，两条指令打架。
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
