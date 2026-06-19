/**
 * 事件总线类型定义 — 定义系统内所有事件的结构与相关领域类型。
 */

import type { Envelope } from '../comm/protocol.js';

// Agent 角色枚举
export type AgentRole = 'session_monitor' | 'feed_scanner' | 'content_curator' | 'interaction_appraiser' | 'comment_reviewer';

// Edge 上报数据结构
export interface PageCardsData {
  index: number;
  title: string;
  author?: string;
  likeCount: number;
  collectCount: number;
  coverDesc?: string;
  noteId?: string;
}

export interface NoteDetailData {
  noteId: string;
  title: string;
  content: string;
  author?: string;
  authorId?: string;
  likeCount: number;
  collectCount: number;
}

export interface ProfileDetailData {
  authorId: string;
  /** 作品数：小红书主页不公开，恒 0=未知；关注决策不依赖（保留向后兼容） */
  postsCount: number;
  followersCount: number;
  /** 获赞与收藏数（主页真实提供）：关注决策的质量信号 */
  likesCollects?: number;
  /** 作者资料是否成功抽取（区分"数据缺失"与"真 0 粉丝"） */
  extracted?: boolean;
}

// 页面类型
export type PageType = 'feed' | 'note' | 'search' | 'profile' | 'unknown';
export type LoginState = 'logged_in' | 'logged_out' | 'unknown';

// 动作名
export type ManagerActionName =
  | 'browse_next'
  | 'scroll'
  | 'like'
  | 'collect'
  | 'search'
  | 'open_note'
  | 'close_note'
  | 'end_session';

// Agent 决策结构
export interface AgentDecision {
  agent: AgentRole;
  action: ManagerActionName | 'pass';  // 'pass' = 无意见
  params?: Record<string, unknown>;
  reason: string;
  confidence: number;         // 0-1
  veto?: boolean;             // true = 否决其他所有决策
  gate?: { blocks: AgentRole[] };  // 质量门控：阻断下游 Agent
  ts: number;
}

// 会话统计
export interface SessionStats {
  startedAt: number;
  durationMs: number;
  views: number;
  likes: number;
  collects: number;
  searches: number;
  follows: number;
}

// 风控状态
export interface RiskStatus {
  status: string;
  quotaLevel: string;
  remainingActionsToday: Record<string, number>;
  viewOnly: boolean;
}

// 收到的笔记
export interface IncomingNote {
  noteId: string;
  title: string;
  summary: string;
  likeCount: number;
  collectCount: number;
  author?: string;
}

// 概念池
export interface ConceptPool {
  known: string[];
  candidates: string[];
  source: Map<string, string>;
}

// Manager 决策（仲裁器产出）
export interface ManagerDecision {
  action: ManagerActionName;
  params?: Record<string, unknown>;
  reason: string;
  interaction?: 'like' | 'collect';  // 附加互动动作
}

// 事件映射表
export interface EventMap {
  'note.arrived': { note: IncomingNote; ts: number };
  'blackboard.updated': { field: string };
  'agent.decided': { agent: AgentRole; decision: AgentDecision };
  'round.complete': { decisions: Map<AgentRole, AgentDecision> };
  'command.ready': { command: ManagerDecision; envelope: Envelope };
  // 跨模块通知
  'session.started': { sessionId: string };
  'session.ended': { stats: SessionStats };
  'interaction.occurred': { action: 'like' | 'collect' | 'follow'; noteId?: string };
  'concept.discovered': { concepts: string[]; source: string };
  // Edge 上报事件（handler → RoleDispatcher）
  'edge.hello': { edgeId: string; ts: number };
  'page.cards.arrived': { cards: PageCardsData[]; ts: number };
  'note.detail.arrived': { detail: NoteDetailData; ts: number };
  'profile.detail.arrived': { detail: ProfileDetailData; ts: number };
  'action.completed': { action: string; ok: boolean; reason?: string; ts: number };
  // 会话控制事件
  'session.should_end': { reason: string; ts: number };
}

// ─── 角色事件系统（新架构） ─────────────────────────────────────

// 角色事件 Payload 定义
export interface FeedScrolledPayload {
  pageType: 'feed';
  scrollCount: number;
  ts: number;
}

export interface SearchScrolledPayload {
  pageType: 'search';
  scrollCount: number;
  ts: number;
}

export interface ContentValuablePayload {
  index: number;
  noteId?: string;
  title: string;
  reason: string;
  confidence: number;
  sourcePageType: 'feed' | 'search';
  ts: number;
}

export interface ContentNoValuablePayload {
  pageType: 'feed' | 'search';
  reason: string;
  ts: number;
}

export interface NoteEnteredPayload {
  noteId: string;
  sourcePageType: 'feed' | 'search';
  ts: number;
}

export interface QualityPassPayload {
  noteId: string;
  sourcePageType: 'feed' | 'search';
  reason: string;
  ts: number;
}

export interface QualityRejectPayload {
  noteId: string;
  sourcePageType: 'feed' | 'search';
  reason: string;
  ts: number;
}

export interface ReadingDonePayload {
  noteId: string;
  sourcePageType: 'feed' | 'search';
  imagesBrowsed: number;
  commentsRead: number;
  keyPoints: string[];
  readDurationMs: number;
  ts: number;
}

/** DeepReader 多图阶段产出的意图：请求边缘浏览多图（dispatcher 翻译为 browse_images 指令）。 */
export interface ReadingBrowseImagesPayload {
  noteId: string;
  sourcePageType: 'feed' | 'search';
  /** 期望浏览的图片张数（边缘按实际可见数截断） */
  count: number;
  ts: number;
}

/** 多图阶段完成（看完或决定不看），comment_reviewer 据此进入评论阶段。 */
export interface ReadingImagesDonePayload {
  noteId: string;
  sourcePageType: 'feed' | 'search';
  imagesBrowsed: number;
  ts: number;
}

/** comment_reviewer 产出的意图：请求边缘滚动评论区（dispatcher 翻译为 scroll_comments 指令）。 */
export interface ReadingScrollCommentsPayload {
  noteId: string;
  sourcePageType: 'feed' | 'search';
  ts: number;
}

export interface InteractionCompletedPayload {
  noteId: string;
  sourcePageType: 'feed' | 'search';
  actions: ('like' | 'collect')[];
  ts: number;
}

export interface InteractionSkippedPayload {
  noteId: string;
  sourcePageType: 'feed' | 'search';
  reason: string;
  ts: number;
}

export interface ProfileWorthVisitingPayload {
  noteId: string;
  authorId: string;
  sourcePageType: 'feed' | 'search';
  reason: string;
  ts: number;
}

export interface ProfileSkippedPayload {
  noteId: string;
  sourcePageType: 'feed' | 'search';
  reason: string;
  ts: number;
}

export interface ProfileEnteredPayload {
  authorId: string;
  sourcePageType: 'feed' | 'search';
  ts: number;
}

export interface ProfileBrowsedPayload {
  authorId: string;
  sourcePageType: 'feed' | 'search';
  postsCount: number;
  followersCount: number;
  /** 获赞与收藏数（主页真实提供）：FollowAgent 决策的质量信号 */
  likesCollects?: number;
  /** 作者资料是否成功抽取（false → FollowAgent 保守 skip，不当作真 0 粉丝） */
  extracted?: boolean;
  ts: number;
}

export interface ProfileDonePayload {
  authorId: string;
  sourcePageType: 'feed' | 'search';
  followed: boolean;
  ts: number;
}

export interface SearchNeededPayload {
  consecutiveScrolls: number;
  currentPageType: 'feed' | 'search';
  ts: number;
}

export interface SearchApprovedPayload {
  keyword: string;
  reason: string;
  /**
   * 关键词来源策略（如实回报，供 SearchExecutePayload.source 填充）。
   * - `new_concept`：来自概念池 candidate（从浏览内容学到的新概念）
   * - `random_from_interests`：来自 soul.yaml 的 seed_keywords
   * - `extract_from_liked` / `manager`：保留来源（本变更暂不产生）
   */
  source?: 'extract_from_liked' | 'random_from_interests' | 'new_concept' | 'manager';
  ts: number;
}

export interface SearchSkippedPayload {
  currentPageType: 'feed' | 'search';
  reason: string;
  ts: number;
}

export interface FeedEnteredPayload {
  pageType: 'feed' | 'search';
  trigger: 'back_to_feed' | 'search_completed' | 'session_start';
  ts: number;
}

// 角色事件映射
export interface RoleEventMap {
  'feed.scrolled': FeedScrolledPayload;
  'search.scrolled': SearchScrolledPayload;
  'content.valuable': ContentValuablePayload;
  'content.no_valuable': ContentNoValuablePayload;
  'note.entered': NoteEnteredPayload;
  'quality.pass': QualityPassPayload;
  'quality.reject': QualityRejectPayload;
  'reading.browse_images': ReadingBrowseImagesPayload;
  'reading.images_done': ReadingImagesDonePayload;
  'reading.scroll_comments': ReadingScrollCommentsPayload;
  'reading.done': ReadingDonePayload;
  'interaction.completed': InteractionCompletedPayload;
  'interaction.skipped': InteractionSkippedPayload;
  'profile.worth_visiting': ProfileWorthVisitingPayload;
  'profile.skipped': ProfileSkippedPayload;
  'profile.entered': ProfileEnteredPayload;
  'profile.browsed': ProfileBrowsedPayload;
  'profile.done': ProfileDonePayload;
  'search.needed': SearchNeededPayload;
  'search.approved': SearchApprovedPayload;
  'search.skipped': SearchSkippedPayload;
  'feed.entered': FeedEnteredPayload;
  'session.should_end': { reason: string; ts: number };
  // idle 看门狗短 idle 时发的恢复 nudge（由 RoleDispatcher 翻译为一次 scroll 命令）
  'session.idle_nudge': { reason: string; ts: number };
}

// 角色名类型
export type RoleName =
  | 'feed_scroller'
  | 'search_scroller'
  | 'profile_browser'
  | 'content_evaluator'
  | 'note_opener'
  | 'content_curator'
  | 'deep_reader'
  | 'comment_reviewer'
  | 'interaction_appraiser'
  | 'author_evaluator'
  | 'profile_opener'
  | 'follow_agent'
  | 'search_evaluator'
  | 'search_executor'
  | 'concept_extractor'
  | 'back_to_feed'
  | 'session_monitor';
