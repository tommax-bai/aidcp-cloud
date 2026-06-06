import type { LlmClient } from '../llm/qwen.js';
import { QwenClient } from '../llm/qwen.js';
import type { Soul } from '../soul/types.js';
import { AgentOrchestrator } from './agent-orchestrator.js';
import { EventStream, EVENT_TYPES } from './events.js';
import { SessionMonitor } from './agents/session-monitor.js';
import { FeedScanner } from './agents/feed-scanner.js';
import { ContentCurator } from './agents/content-curator.js';
import { CommentReviewer } from './agents/comment-reviewer.js';
import { InteractionAppraiser } from './agents/interaction-appraiser.js';

export type PageType = 'feed' | 'note' | 'search' | 'profile' | 'unknown';
export type LoginState = 'logged_in' | 'logged_out' | 'unknown';
export type ManagerActionName =
  | 'browse_next'
  | 'scroll'
  | 'like'
  | 'collect'
  | 'search'
  | 'open_note'
  | 'close_note'
  | 'end_session';

export interface VisibleCard {
  index?: number;
  noteId?: string;
  title?: string;
  summary?: string;
  author?: string;
  likeCount?: number;
  collectCount?: number;
}

export interface PageAttributes {
  visibleCardsRange?: { start: number; end: number };
  visibleCards?: VisibleCard[];
  currentNote?: {
    noteId: string;
    title: string;
    content: string;
    author: string;
    likeCount: number;
    collectCount: number;
    isLiked: boolean;
    isCollected: boolean;
  };
  keyword?: string;
  comments?: string[];
}

export interface SessionStats {
  startedAt: number;
  durationMs: number;
  views: number;
  likes: number;
  collects: number;
  searches: number;
  follows: number;
}

export interface RiskStatus {
  status: string;
  quotaLevel: string;
  remainingActionsToday: Record<string, number>;
  viewOnly: boolean;
}

export interface ManagerContext {
  currentPage: { type: PageType };
  pageAttributes: PageAttributes;
  sessionStats: SessionStats;
  riskStatus: RiskStatus;
  loginState: LoginState;
  availableActions: ManagerActionName[];
}

export interface ManagerDecision {
  action: ManagerActionName;
  params?: Record<string, unknown>;
  reason: string;
}

export interface ContextBuilderInput {
  pageType?: PageType;
  loginState?: LoginState;
  note?: PageAttributes['currentNote'];
  visibleCards?: VisibleCard[];
  keyword?: string;
  comments?: string[];
  sessionStats: SessionStats;
  riskStatus: RiskStatus;
}

export class ContextBuilder {
  build(input: ContextBuilderInput): ManagerContext {
    const pageType = input.pageType ?? (input.note ? 'note' : 'feed');
    const visibleCards = input.visibleCards ?? (input.note ? [] : []);
    return {
      currentPage: { type: pageType },
      pageAttributes: {
        visibleCardsRange: visibleCards.length > 0 ? { start: visibleCards[0].index ?? 0, end: visibleCards[visibleCards.length - 1].index ?? visibleCards.length - 1 } : undefined,
        visibleCards,
        currentNote: input.note,
        keyword: input.keyword,
        comments: input.comments,
      },
      sessionStats: input.sessionStats,
      riskStatus: input.riskStatus,
      loginState: input.loginState ?? 'unknown',
      availableActions: this.availableActions(pageType, input.loginState ?? 'unknown', input.riskStatus, !!input.note),
    };
  }

  private availableActions(
    pageType: PageType,
    loginState: LoginState,
    risk: RiskStatus,
    hasNoteContent: boolean,
  ): ManagerActionName[] {
    const actions: ManagerActionName[] = ['browse_next', 'scroll', 'end_session'];
    if (pageType === 'feed' || pageType === 'search') actions.push('open_note');
    if (pageType === 'note') {
      actions.push('close_note');
      if (loginState !== 'logged_out' && !risk.viewOnly && hasNoteContent) {
        if ((risk.remainingActionsToday.like ?? 0) > 0) actions.push('like');
        if ((risk.remainingActionsToday.collect ?? 0) > 0) actions.push('collect');
      }
    }
    actions.push('search');
    return actions;
  }
}

/** 供 SessionOrchestrator 注入的决策接口（ManagerAgent 实现，测试可打桩） */
export interface ManagerDecider {
  decide(context: ManagerContext): Promise<ManagerDecision>;
}

export interface ManagerAgentOptions {
  soul: Soul;
  client?: LlmClient;
  timeoutMs?: number;
}

export class ManagerAgent implements ManagerDecider {
  private readonly orchestrator: AgentOrchestrator;
  private readonly soul: Soul;

  constructor(options: ManagerAgentOptions) {
    const client: LlmClient = options.client ?? new QwenClient({ model: 'qwen-turbo', timeoutMs: options.timeoutMs ?? 3000 });
    this.soul = options.soul;
    this.orchestrator = new AgentOrchestrator({
      agents: [
        new SessionMonitor(),
        new FeedScanner(client),
        new ContentCurator(client),
        new CommentReviewer(client),
        new InteractionAppraiser(client),
      ],
    });
  }

  async decide(context: ManagerContext): Promise<ManagerDecision> {
    try {
      const stream = new EventStream();
      this.injectRawEvents(stream, context);
      return await this.orchestrator.decide(stream, this.soul);
    } catch {
      return fallbackDecision();
    }
  }

  private injectRawEvents(stream: EventStream, ctx: ManagerContext): void {
    const now = Date.now();
    stream.emit({
      type: EVENT_TYPES.SESSION_STATS,
      source: 'orchestrator',
      timestamp: now,
      payload: { stats: ctx.sessionStats, risk: ctx.riskStatus },
    });
    if (ctx.pageAttributes.currentNote) {
      stream.emit({
        type: EVENT_TYPES.NOTE_CONTENT,
        source: 'edge',
        timestamp: now,
        payload: { note: ctx.pageAttributes.currentNote },
      });
    }
    if (ctx.pageAttributes.visibleCards && ctx.pageAttributes.visibleCards.length > 0) {
      stream.emit({
        type: EVENT_TYPES.FEED_CARDS,
        source: 'edge',
        timestamp: now,
        payload: { cards: ctx.pageAttributes.visibleCards },
      });
    }
    if (ctx.pageAttributes.comments && ctx.pageAttributes.comments.length > 0) {
      stream.emit({
        type: EVENT_TYPES.NOTE_COMMENTS,
        source: 'edge',
        timestamp: now,
        payload: { comments: ctx.pageAttributes.comments },
      });
    }
  }
}

export function fallbackDecision(): ManagerDecision {
  return { action: 'browse_next', reason: 'manager_fallback' };
}

export function parseManagerDecision(raw: string, availableActions: ManagerActionName[]): ManagerDecision {
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) return fallbackDecision();
  let data: unknown;
  try {
    data = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return fallbackDecision();
  }
  if (!data || typeof data !== 'object') return fallbackDecision();
  const obj = data as Record<string, unknown>;
  if (typeof obj.action !== 'string' || !availableActions.includes(obj.action as ManagerActionName)) {
    return fallbackDecision();
  }
  const action = obj.action as ManagerActionName;
  const params = obj.params && typeof obj.params === 'object' && !Array.isArray(obj.params)
    ? obj.params as Record<string, unknown>
    : {};
  if (action === 'search' && (typeof params.keyword !== 'string' || params.keyword.trim() === '')) {
    return fallbackDecision();
  }
  if (action === 'open_note' && params.index !== undefined && typeof params.index !== 'number') {
    return fallbackDecision();
  }
  return {
    action,
    params,
    reason: typeof obj.reason === 'string' && obj.reason.trim() ? obj.reason.trim() : 'manager_selected',
  };
}
