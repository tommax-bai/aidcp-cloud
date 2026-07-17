/**
 * 事件总线类型定义 — 定义系统内所有事件的结构与相关领域类型。
 */

import type { CommentCandidate, Envelope, NoteImagePayload, NotificationItem } from '../comm/protocol.js';
import type { MandatoryCommentApproval, MandatoryInteractionAction } from '../soul/types.js';

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
  /** 缺省按 image_text 兼容老边端。 */
  mediaType?: 'image_text' | 'video';
  author?: string;
  authorId?: string;
  likeCount: number;
  collectCount: number;
  /** 发布相对时刻原始文本（change feed-hot-lead-group-comment）；云端解析算热度速率。缺则诚实置空。 */
  publishedAtText?: string;
  /** 详情页带 xsec_token 的链接（change interaction-feed-enrichment）；缺则诚实置空。 */
  url?: string;
  /** Original carousel images observed by edge; empty/missing means unavailable. */
  images?: NoteImagePayload[];
  /** Refresh-only image snapshot; not a new view and not a normal browse-detail decision event. */
  refreshOnly?: boolean;
  /**
   * 帖子下他人评论正文样本（change platform-vocabulary-and-thresholds 2.1）：边缘就地读 / 详情深读采到多少报多少，
   * 采不到即缺省——MUST NOT 伪造。Facebook 图片帖常无正文，这些评论是撰写的主要文字依据。
   * 协议早有此字段（protocol.ts NoteDetailPayload.comments）、边缘 FB 三条路径均已上报，此前只因本事件类型
   * 未声明而在云端被静默丢弃。小红书的 note.detail 不带评论，其现场评论走 action.completed{scroll_comments}.candidates。
   */
  comments?: string[];
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
  /** 作者真实昵称（change interaction-feed-enrichment）；缺则诚实置空。 */
  nickname?: string;
  /** 作者主页链接（change interaction-feed-enrichment）；缺则诚实置空。 */
  url?: string;
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
  // targetId（change interaction-feed-enrichment）：展示账本去重键——笔记动作=noteId，关注=authorId。noteId 保留（喂 likedNoteStore）。
  'interaction.occurred': { action: 'view' | 'like' | 'collect' | 'follow' | 'comment' | 'comment_like' | 'join_group'; accountId?: string; noteId?: string; targetId?: string };
  'concept.discovered': { concepts: string[]; source: string };
  // Edge 上报事件（handler → RoleDispatcher）
  // accountId 穿透握手事件（multi-account-node-support D4）：决策层据此设该连接当前账号，不再钉死 default。
  'edge.hello': { edgeId: string; accountId?: string; ts: number };
  'page.cards.arrived': { cards: PageCardsData[]; startupId?: string; ts: number };
  // accountId（change interaction-feed-enrichment）：tee 到全局观测总线后，元数据 upsert 需按真实账号归属（缺则保留键）。
  'note.detail.arrived': { detail: NoteDetailData; accountId?: string; ts: number };
  /** Refresh-only note detail carrying newly observed carousel images; consumers MUST NOT count it as a new view. */
  'note.image_snapshot.arrived': { detail: NoteDetailData; accountId?: string; ts: number };
  'profile.detail.arrived': { detail: ProfileDetailData; accountId?: string; ts: number };
  // noteId/observation（change platform-browse-protocol）：边缘从被点 article 派生的规范 id + 独立见证包（现读被点卡）。
  // 归账仲裁（handler.ts）与迁移落地确认 / observedSurface 审计（dispatcher）消费；缺省=今天行为（回落 currentNoteId）。
  'action.completed': { action: string; ok: boolean; reason?: string; ts: number; candidates?: CommentCandidate[]; noteId?: string; observation?: unknown };
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

/** feed 浏览深度到阈值 → 改点右下「刷新」回顶换新批（change feed-refresh-on-depth）。
 *  内部角色事件，非协议消息；由 FeedScroller 发、RoleDispatcher 翻译成 feed.refresh 命令。 */
export interface FeedRefreshNeededPayload {
  cardsBrowsed: number;
  currentPageType: 'feed';
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

/** 详情全文已确认的结构化强制互动上下文；随因果 payload 透传，避免同级订阅共享态竞态。 */
export interface MandatoryInteractionContext {
  ruleId: string;
  actions: MandatoryInteractionAction[];
  commentGuidance?: string;
  commentApproval?: MandatoryCommentApproval;
}

/** mandatory auto_approve 的一次性通知/终态关联键；仅携操作员可读展示上下文。 */
export interface CommentApprovalTrace {
  requestId: string;
  accountId?: string;
  accountName?: string;
  title?: string;
  authorName?: string;
}

export interface QualityPassPayload {
  noteId: string;
  sourcePageType: 'feed' | 'search';
  reason: string;
  mandatoryInteraction?: MandatoryInteractionContext;
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
  mandatoryInteraction?: MandatoryInteractionContext;
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
  /** 未看图的诚实原因（如平台不支持 browse_images 时的 'surface_unsupported'）；正常路径不带。 */
  reason?: string;
  mandatoryInteraction?: MandatoryInteractionContext;
  ts: number;
}

/** comment_reviewer 产出的意图：请求边缘滚动评论区（dispatcher 翻译为 scroll_comments 指令）。 */
export interface ReadingScrollCommentsPayload {
  noteId: string;
  sourcePageType: 'feed' | 'search';
  /** 期望滚动评论区的次数（边缘按实际可滚动状态截断/如实回报） */
  count: number;
  ts: number;
}

export interface InteractionCompletedPayload {
  noteId: string;
  sourcePageType: 'feed' | 'search';
  actions: ('like' | 'collect')[];
  mandatoryInteraction?: MandatoryInteractionContext;
  ts: number;
}

export interface InteractionSkippedPayload {
  noteId: string;
  sourcePageType: 'feed' | 'search';
  reason: string;
  ts: number;
}

// —— 发评论支线（评估→撰写→去AI味→审批→下发；接在互动完成与「是否进主页评估」之间）——
// 所有事件携带原 like/collect actions，供 AuthorEvaluator 在评论支线终结后构 prompt。

/** 评估角色过完便宜阈值闸、即将调 LLM 判定是否值得评（change comment-approval-target-hold）：
 *  dispatcher 据此提前把账号钉在待评论帖上，覆盖 appraiser-LLM 这段残留窗（否则并行点赞 no_target
 *  重扫会把目标帖滚走）。仅便宜阈值全过者才 emit，未过阈者同步 skip、不会置在途标志（不过度抑制）。 */
export interface CommentAppraisingPayload {
  noteId: string;
  sourcePageType: 'feed' | 'search';
  actions: ('like' | 'collect')[];
  ts: number;
}

export interface CommentAppraisedPayload {
  noteId: string;
  sourcePageType: 'feed' | 'search';
  actions: ('like' | 'collect')[];
  /** 评估角色判「值得评」的理由（change humanize-interaction-prompts）：穿透给撰写角色作语境，
   *  让撰写不必从零重推切入点。可选、向后兼容——无 reason 时撰写 prompt 省略该片段。 */
  reason?: string;
  mandatoryInteraction?: MandatoryInteractionContext;
  ts: number;
}

export interface CommentComposedPayload {
  noteId: string;
  sourcePageType: 'feed' | 'search';
  actions: ('like' | 'collect')[];
  draft: string;
  /** 撰写时取用的语料库参考评论原文（comment-like-on-detail B）；供 de-ai 撞车护栏判近似照搬。可空。 */
  references?: string[];
  mandatoryInteraction?: MandatoryInteractionContext;
  ts: number;
}

export interface CommentClearedPayload {
  noteId: string;
  sourcePageType: 'feed' | 'search';
  actions: ('like' | 'collect')[];
  text: string;
  mandatoryInteraction?: MandatoryInteractionContext;
  ts: number;
}

export interface CommentApprovedPayload {
  noteId: string;
  sourcePageType: 'feed' | 'search';
  actions: ('like' | 'collect')[];
  text: string;
  mandatoryInteraction?: MandatoryInteractionContext;
  /** mandatory auto_approve 从预授权通知穿透到平台终态回执的关联上下文。 */
  approvalTrace?: CommentApprovalTrace;
  ts: number;
}

/** 评论支线成功终结（执行端真回执后）→ 触发「是否进主页评估」。 */
export interface CommentDonePayload {
  noteId: string;
  sourcePageType: 'feed' | 'search';
  actions: ('like' | 'collect')[];
  ok: boolean;
  /** 平台或调度层的诚实终结原因；缺省保持旧消费者兼容。 */
  reason?: string;
  mandatoryInteraction?: MandatoryInteractionContext;
  ts: number;
}

/** 评论支线任意阶段诚实跳过（含不评/失败/超时/未授权）→ 触发「是否进主页评估」。 */
export interface CommentSkippedPayload {
  noteId: string;
  sourcePageType: 'feed' | 'search';
  actions: ('like' | 'collect')[];
  reason: string;
  mandatoryInteraction?: MandatoryInteractionContext;
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

/**
 * 主页子链结束信号（内部事件，非协议消息）。由 RoleDispatcher 在「主页关注评估完成」这一**单一时序点**
 * 发出（先下发关注命令——仅当决定关注且风控放行——后 emit 本事件），BackToFeed 据此返回信息流。
 * 返回不再死等关注回执，治「关注被风控拦截 → 永无回执 → 死等卡在作者主页」。
 */
export interface ProfileExitPayload {
  sourcePageType: 'feed' | 'search';
  /** 观测用：followed=关注已下发 / follow_blocked=关注被风控拦 / not_followed=决定不关注 */
  reason: 'followed' | 'follow_blocked' | 'not_followed';
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
  /** 搜索需求来自哪个列表页；拦截/失败时按原始页型续滚，不能从 SearchExecutor 改后的上下文猜。 */
  currentPageType: 'feed' | 'search';
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
  'feed.refresh.needed': FeedRefreshNeededPayload;
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
  'comment.appraising': CommentAppraisingPayload;
  'comment.appraised': CommentAppraisedPayload;
  'comment.composed': CommentComposedPayload;
  'comment.cleared': CommentClearedPayload;
  'comment.approved': CommentApprovedPayload;
  'comment.done': CommentDonePayload;
  'comment.skipped': CommentSkippedPayload;
  // 评论点赞（comment-like-on-detail）：appraiser 选中一条 → intended（dispatcher 下发）；
  // 真点成功 → confirmed（archivist 归档）；任何不点 → skipped（仅观测）。
  'comment_like.intended': { noteId: string; commentAnchorId: string; author?: string; text: string; reason: string; ts: number };
  'comment_like.confirmed': { noteId: string; commentAnchorId: string; author?: string; text: string; reason: string; likeCount?: number; ts: number };
  'comment_like.skipped': { noteId?: string; reason: string; ts: number };
  'profile.worth_visiting': ProfileWorthVisitingPayload;
  'profile.skipped': ProfileSkippedPayload;
  'profile.entered': ProfileEnteredPayload;
  'profile.browsed': ProfileBrowsedPayload;
  'profile.done': ProfileDonePayload;
  'profile.exit': ProfileExitPayload;
  /** 本人主页昵称采集意图（change account-real-nickname）：云端内部事件，**NOT 协议消息**——不入 protocol.ts、
   *  不计 MessageType（计数恒 56）、无四处同步。nickname_enricher 在会话开始(需采集时)emit；
   *  dispatcher 翻译为 profile_open{direct:true}。payload.accountId = 本人主页 id。 */
  'self.profile.capture': { accountId: string };
  'search.needed': SearchNeededPayload;
  'search.approved': SearchApprovedPayload;
  'search.skipped': SearchSkippedPayload;
  'feed.entered': FeedEnteredPayload;
  'session.should_end': { reason: string; ts: number };
  // idle 看门狗短 idle 时发的恢复 nudge（由 RoleDispatcher 翻译为一次 scroll 命令）
  'session.idle_nudge': { reason: string; ts: number };
  // —— 通知巡视（消息查看）：边缘上报入口转换 + 角色间衔接 ——
  'notification.detected.arrived': { edgeId?: string; epoch: number; unreadCount?: number; ts: number };
  'notification.home.arrived': { comments: number; likes: number; follows: number; epoch?: number; ts: number };
  'notification.items.arrived': { items: NotificationItem[]; epoch?: number; ts: number };
  'excursion.requested': { epoch: number; ts: number };
  'browse.suspended': { epoch: number; ts: number };
  /** 去通知首页意图：reason='open' 首次进入（→ open_notifications）；'back' 一类处理完返回（→ notification_back_home）。 */
  'notification.opening': { epoch: number; reason: 'open' | 'back'; ts: number };
  'notification.category_selected': { category: NotificationCategory; epoch: number; ts: number };
  /** per-category 浏览意图（各浏览角色产出，dispatcher 按 category 翻译为 browse_notification_* 命令）。 */
  'notification.browse_category': { category: NotificationCategory; epoch: number; scrollMax?: number; ts: number };
  'notification.category_handled': { category: NotificationCategory; epoch: number; ts: number };
  'notification.classified': { worthy: NotificationItem[]; epoch: number; ts: number };
  'notification.classify_empty': { epoch: number; ts: number };
  'notification.classify_failed': { epoch: number; reason: string; ts: number };
  'notification.worthy': { items: NotificationItem[]; epoch: number; ts: number };
  'notification.all_seen': { epoch: number; ts: number };
  'notification.notified': { count: number; epoch: number; ts: number };
  'notification.triage_done': { epoch: number; ts: number };
  'excursion.ended': { epoch: number; reason: string; ts: number };
}

/** 通知分类（与通知首页三栏对应）。 */
export type NotificationCategory = 'comments' | 'likes' | 'follows';

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
  | 'comment_appraiser'
  | 'comment_composer'
  | 'comment_de_ai_flavor'
  | 'comment_approval_gate'
  | 'comment_like_appraiser'
  | 'facebook_group_join_judge'
  | 'valuable_comment_archivist'
  | 'curated_note_evaluator'
  | 'curated_comment_evaluator'
  // —— 引流线索评估（change feed-hot-lead-group-comment）：纯确定性、不调 LLM、不进 role-catalog ——
  | 'hot_lead_detector'
  // —— 按需评论任务角色（change comment-search-command，飞书 /comment）——
  | 'comment_search_term_generator'
  | 'comment_target_picker'
  // —— 建号自助人设生成（change edge-persona-keyword-generation，命令式，客户端 onboarding 触发）——
  | 'persona_generator'
  | 'profile_opener'
  | 'nickname_enricher'
  | 'follow_agent'
  | 'search_evaluator'
  | 'search_executor'
  | 'concept_extractor'
  | 'back_to_feed'
  | 'session_monitor'
  // —— 通知巡视（消息查看）角色 ——
  | 'notification_gatekeeper'
  | 'browse_suspender'
  | 'notification_home_opener'
  | 'notification_triage'
  | 'notification_comment_browser'
  | 'notification_like_browser'
  | 'notification_follow_browser'
  | 'notification_classifier'
  | 'notification_deduper'
  | 'notification_notifier'
  | 'notification_return_home'
  | 'excursion_resumer';
