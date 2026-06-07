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
import { SessionContext } from '../agents/session-context.js';
import { ContentEvaluator } from '../agents/content-evaluator.js';
import { FeedScroller } from '../agents/feed-scroller.js';
import { NoteOpener } from '../agents/note-opener.js';
import { BackToFeed } from '../agents/back-to-feed.js';
import { DeepReader } from '../agents/deep-reader.js';
import { ContentCuratorRole } from '../agents/content-curator-role.js';
import { InteractionAppraiserRole } from '../agents/interaction-appraiser-role.js';
import { AuthorEvaluator } from '../agents/author-evaluator.js';
import { ProfileOpener } from '../agents/profile-opener.js';
import { ProfileBrowser } from '../agents/profile-browser.js';
import { FollowAgent } from '../agents/follow-agent.js';
import { SearchScroller } from '../agents/search-scroller.js';
import { SearchEvaluator } from '../agents/search-evaluator.js';
import { SearchExecutor } from '../agents/search-executor.js';
import { SessionMonitorRole } from '../agents/session-monitor-role.js';
import type { BaseRole } from '../agents/base-role.js';
import type { Soul } from '../soul/types.js';

// ─── 公共接口 ────────────────────────────────────────────────────────────────

export interface RoleDispatcherOptions {
  soul: Soul;
  llm: { complete(prompt: string): Promise<string> };
  sendCommand: (command: EdgeCommand) => void;
  clock?: () => number;
  /** 外部事件总线（共享 handler 发射的 Edge 上报事件），缺省创建独立实例 */
  eventBus?: EventBus;
}

export interface EdgeCommand {
  action: 'scroll' | 'open_note' | 'close_note' | 'like' | 'collect' | 'follow' | 'search' | 'back' | 'browse_images' | 'scroll_comments' | 'session.end';
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
  private readonly llm: { complete(prompt: string): Promise<string> };
  private readonly sendCommand: (command: EdgeCommand) => void;
  private readonly clock: () => number;
  private roles: BaseRole[] = [];
  private contentEvaluator!: ContentEvaluator;
  private commandUnsubscribers: (() => void)[] = [];

  // 数据存储（由 Edge 上报更新）
  private visibleCards: VisibleCard[] = [];
  private currentNote: NoteData | null = null;
  private profileData: { postsCount: number; followersCount: number } | null = null;
  private budget = { likes: 10, collects: 5, follows: 3, searches: 5 };
  private searchedKeywords: string[] = [];
  private sessionActive = false;

  constructor(options: RoleDispatcherOptions) {
    this.soul = options.soul;
    this.llm = options.llm;
    this.sendCommand = options.sendCommand;
    this.clock = options.clock ?? Date.now;
    this.eventBus = options.eventBus ?? new EventBus();
    this.sessionContext = new SessionContext();
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

    // 数据访问闭包
    const getNoteData = (noteId: string) =>
      this.currentNote?.noteId === noteId ? this.currentNote : null;
    const getProfileData = (_authorId: string) => this.profileData;
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
      new DeepReader(commonOptions),
      new ContentCuratorRole({ ...commonOptions, sessionContext: this.sessionContext }),
      new InteractionAppraiserRole({ ...commonOptions, sessionContext: this.sessionContext, getNoteData, getRemainingBudget }),
      new AuthorEvaluator({ ...commonOptions, sessionContext: this.sessionContext, getNoteData }),
      new ProfileOpener(commonOptions),
      new ProfileBrowser({ ...commonOptions, sessionContext: this.sessionContext, getProfileData }),
      new FollowAgent({ ...commonOptions, sessionContext: this.sessionContext, getRemainingFollows: () => this.budget.follows }),
      new SearchScroller(commonOptions, this.sessionContext),
      new SearchEvaluator({ ...commonOptions, sessionContext: this.sessionContext, getSearchedKeywords }),
      new SearchExecutor({ ...commonOptions, sessionContext: this.sessionContext }),
      new SessionMonitorRole({
        ...commonOptions,
        maxDurationMs: (this.soul.session_limits?.max_duration_min ?? 10) * 60_000,
        onSessionEnd: (reason: string) => this.endSession(reason),
        getRemainingBudget: () => this.budget,
        clock: this.clock,
      }),
    ];

    // 注册所有角色的事件订阅
    this.roles.forEach((r) => r.subscribe());

    // 注册 Edge 指令翻译层
    this.setupCommandTranslation();

    // 订阅 Edge 上报事件
    this.setupEdgeEventSubscriptions();
  }

  /** 启动会话 */
  startSession(): void {
    this.sessionActive = true;
    this.eventBus.emit('feed.entered', {
      pageType: 'feed',
      trigger: 'session_start',
      ts: this.clock(),
    });
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

  /** Edge 上报个人主页数据 */
  updateProfileData(data: { postsCount: number; followersCount: number }): void {
    this.profileData = data;
  }

  /** Edge 上报互动预算消耗 */
  consumeBudget(action: 'like' | 'collect' | 'follow' | 'search'): void {
    if (action === 'like' && this.budget.likes > 0) this.budget.likes--;
    else if (action === 'collect' && this.budget.collects > 0) this.budget.collects--;
    else if (action === 'follow' && this.budget.follows > 0) this.budget.follows--;
    else if (action === 'search' && this.budget.searches > 0) this.budget.searches--;
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

      // note.entered 不再发送指令：content.valuable 已经发送了带 index 的 open_note
      // quality.reject 不再直接发 back：BackToFeed 角色会通过 feed.entered 统一发送

      this.eventBus.on('interaction.completed', (payload) => {
        for (const action of payload.actions) {
          this.sendCommand({ action, params: { noteId: payload.noteId } });
          this.consumeBudget(action);
        }
      }),

      this.eventBus.on('profile.entered', () => {
        this.sendCommand({ action: 'open_note', params: { type: 'profile' } });
      }),

      this.eventBus.on('profile.done', (payload) => {
        if (payload.followed) {
          this.sendCommand({ action: 'follow', params: { authorId: payload.authorId } });
          this.consumeBudget('follow');
        }
        // back 指令由 BackToFeed 角色通过 feed.entered 统一发送，此处不再重复
      }),

      this.eventBus.on('feed.entered', (payload) => {
        if (payload.trigger === 'back_to_feed') {
          this.sendCommand({ action: 'back', reason: 'back_to_feed' });
        }
      }),

      this.eventBus.on('search.approved', (payload) => {
        this.searchedKeywords.push(payload.keyword);
        this.consumeBudget('search');
        this.sendCommand({ action: 'search', params: { keyword: payload.keyword } });
      }),

      // 角色产出事件 → Edge 指令翻译
      this.eventBus.on('content.valuable', (payload) => {
        this.sendCommand({ action: 'open_note', params: { index: payload.index }, reason: payload.reason });
      }),

      this.eventBus.on('content.no_valuable', () => {
        this.sendCommand({ action: 'scroll', reason: 'no_valuable_content' });
      }),

      this.eventBus.on('session.should_end', (payload) => {
        this.sendCommand({ action: 'session.end', reason: payload.reason });
        this.endSession(payload.reason);
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

      // Edge 确认动作完成 → 通知 SessionMonitor
      this.eventBus.on('action.completed', (payload) => {
        console.log(`[RoleDispatcher] action.completed: ${payload.action} ok=${payload.ok}`);
      }),
    );
  }
}
