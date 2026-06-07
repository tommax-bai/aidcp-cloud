/**
 * 事件驱动编排器的事件类型定义与 EventStream 实现。
 *
 * 所有 Agent 的输入和输出都是事件：
 * - 原始事件：由 edge 上报或 Orchestrator 注入（如 note.content、feed.cards、session.stats）
 * - Agent 产出事件：由各角色 Agent 处理后写回（如 session.verdict、content.verdict、interaction.decision）
 */

import type { SessionStats, RiskStatus } from '../event-bus/types.js';

export interface VisibleCard {
  index?: number;
  noteId?: string;
  title?: string;
  summary?: string;
  author?: string;
  likeCount?: number;
  collectCount?: number;
}

/** 事件流中的一条事件 */
export interface OrchestratorEvent<T = unknown> {
  type: string;
  source: string;
  timestamp: number;
  payload: T;
}

// ─── 原始事件 payload ───────────────────────────────

export interface SessionStatsPayload {
  stats: SessionStats;
  risk: RiskStatus;
}

export interface NoteContentPayload {
  note: {
    noteId: string;
    title: string;
    content: string;
    author: string;
    likeCount: number;
    collectCount: number;
    isLiked: boolean;
    isCollected: boolean;
  };
}

export interface FeedCardsPayload {
  cards: VisibleCard[];
}

export interface NoteCommentsPayload {
  comments: string[];
}

// ─── Agent 产出事件 payload ─────────────────────────

export interface SessionVerdictPayload {
  allow: boolean;
  forceAction?: string;
  warnings: string[];
}

export interface ContentVerdictPayload {
  quality: 'high' | 'medium' | 'low';
  reason: string;
}

export interface CommentAdjustmentPayload {
  boost: boolean;
  downgrade: boolean;
  reason: string;
}

export interface InteractionDecisionPayload {
  action: 'like' | 'collect' | 'close_note';
  reason: string;
}

export interface FeedDecisionPayload {
  action: 'open_note' | 'scroll' | 'browse_next';
  params?: Record<string, unknown>;
  reason: string;
}

// ─── 事件类型常量 ───────────────────────────────────

export const EVENT_TYPES = {
  SESSION_STATS: 'session.stats',
  NOTE_CONTENT: 'note.content',
  FEED_CARDS: 'feed.cards',
  NOTE_COMMENTS: 'note.comments',
  SESSION_VERDICT: 'session.verdict',
  CONTENT_VERDICT: 'content.verdict',
  COMMENT_ADJUSTMENT: 'comment.adjustment',
  INTERACTION_DECISION: 'interaction.decision',
  FEED_DECISION: 'feed.decision',
} as const;

// ─── EventStream ────────────────────────────────────

/** 事件流：一个决策回合内的所有事件 */
export class EventStream {
  private events: OrchestratorEvent[] = [];

  get size(): number {
    return this.events.length;
  }

  /** 写入一条事件 */
  emit<T>(event: OrchestratorEvent<T>): void {
    this.events.push(event as OrchestratorEvent);
  }

  /** 按类型查找最新一条事件 */
  find<T>(type: string): OrchestratorEvent<T> | undefined {
    for (let i = this.events.length - 1; i >= 0; i--) {
      if (this.events[i].type === type) return this.events[i] as OrchestratorEvent<T>;
    }
    return undefined;
  }

  /** 按类型查找所有事件 */
  findAll<T>(type: string): OrchestratorEvent<T>[] {
    return this.events.filter(e => e.type === type) as OrchestratorEvent<T>[];
  }

  /** 检查某类型事件是否已存在 */
  has(type: string): boolean {
    return this.events.some(e => e.type === type);
  }

  /** 获取所有事件的只读副本 */
  all(): readonly OrchestratorEvent[] {
    return this.events;
  }

  /** 清空（新回合） */
  reset(): void {
    this.events = [];
  }
}
