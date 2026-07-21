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
import type { CommentApprovalTrace, CommentAppraisingPayload, MandatoryInteractionContext, NoteDetailData, PageCardsData } from '../event-bus/types.js';
import {
  isNoteActionSupported,
  noteActionRefusalReason,
  isOrchestrationCapabilitySupported,
  platformFeedScrollFloorMs,
  resolveReadSurface,
  resolveCommentSurface,
  loopClosure,
  commentProfileForPlatform,
  type PlatformId,
  type NoteScopedAction,
  type Surface,
} from '../platform/index.js';
import type { LlmCallOpts } from '../llm/qwen.js';
import { SessionContext } from '../agents/session-context.js';
import { ContentEvaluator } from '../agents/content-evaluator.js';
import { FeedScroller } from '../agents/feed-scroller.js';
import { NoteOpener } from '../agents/note-opener.js';
import { BackToFeed } from '../agents/back-to-feed.js';
import { DeepReader } from '../agents/deep-reader.js';
import { CommentReviewer } from '../agents/comment-reviewer.js';
import { ContentCuratorRole } from '../agents/content-curator-role.js';
import { InteractionAppraiserRole, COLLECT_MIN_SAVE_LIKE_RATIO } from '../agents/interaction-appraiser-role.js';
import { AuthorEvaluator } from '../agents/author-evaluator.js';
import { CommentAppraiser } from '../agents/comment-appraiser.js';
import { CommentLikeAppraiser } from '../agents/comment-like-appraiser.js';
import { ValuableCommentArchivist } from '../agents/valuable-comment-archivist.js';
import { CuratedNoteEvaluator, type CuratedNoteSink } from '../agents/curated-note-evaluator.js';
import { CuratedCommentEvaluator, type CuratedCommentSink } from '../agents/curated-comment-evaluator.js';
import type { TextCardTranscriber } from '../publish-agent/text-card-transcriber.js';
import { HotLeadDetector } from '../hot-lead/hot-lead-detector.js';
import type { HotLeadGateConfig } from '../hot-lead/heat-velocity.js';
import type { ValuableCommentInput, ValuableCommentRef } from '../cache/valuable-comment-store.js';
import { CommentComposer } from '../agents/comment-composer.js';
import { CommentDeAiFlavor } from '../agents/comment-de-ai-flavor.js';
import { CommentApprovalGate, type CommentApprovalNoticeInput, type CommentApprovalPort } from '../agents/comment-approval-gate.js';
import { ProfileOpener } from '../agents/profile-opener.js';
import { ProfileBrowser } from '../agents/profile-browser.js';
import { NicknameEnricher } from '../agents/nickname-enricher.js';
import { FollowAgent, FOLLOW_MIN_FANS_ENGAGEMENT_RATIO } from '../agents/follow-agent.js';
import { SearchScroller, SEARCH_HOME_RETURN_AFTER } from '../agents/search-scroller.js';
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
import type { EdgeTaskLease, EdgeTaskLeaseClient } from '../comm/edge-task-lease-client.js';
import { isPreemptionReason } from '../comm/preemption.js';
import type { BaseRole } from '../agents/base-role.js';
import type { Soul } from '../soul/types.js';
import { computeDwellMs, computeThinkMs, computeFeedFloorMs, effectiveTempo, type PacingFloorProvider } from '../risk/pacing.js';
import { SearchFrequencyLimiter } from '../risk/search-frequency-limiter.js';
import { InteractionGuard, isGuardedInteraction, type GuardAction } from '../risk/interaction-guard.js';
import { ActionCooldownGate, type CooldownAction } from '../risk/action-cooldown.js';
import {
  DEFAULT_SESSION_DURATION_MS,
  defaultSessionBudget,
  isWeekActiveAt,
  msUntilNextActive,
  type SessionInteractionBudget,
  type SessionLimitProvider,
} from '../risk/session-limits.js';
import {
  DEFAULT_FB_DAILY_ONLINE_MINUTES,
  DEFAULT_IDLE_END_MS,
  DEFAULT_IDLE_NUDGE_MS,
  effectiveDailyMaxMinutes,
  isWithinActiveWindow,
  nextActiveWindowStartAt,
  nextLocalDayStartAt,
  type ResumeConfigProvider,
} from '../risk/resume-limits.js';
import type { ResumeGateVerdict } from '../comm/browser-standby.js';
import type { RiskStatus, RiskQuotaLevel } from '../risk/types.js';
import type { ConceptPool } from '../event-bus/types.js';
import type { NotificationItem } from '../comm/protocol.js';
import {
  FACEBOOK_PRESENTED_VIDEO_LIKE_PROBABILITY,
  facebookPostKey,
  hasObviousHighRiskFacebookCaption,
  isCanonicalFacebookFeedVideoNoteId,
  isCanonicalFacebookReelNoteId,
} from '../platform/facebook-presented-video.js';

export {
  FACEBOOK_REELS_LIKE_PROBABILITY,
  facebookPostKey,
  isCanonicalFacebookReelNoteId,
} from '../platform/facebook-presented-video.js';

/** 概念池读写下游（ConceptStore 的最小契约，便于注入桩单测）。 */
export interface ConceptStorePort extends ConceptSink {
  loadPool(): Promise<ConceptPool>;
  markSearched(keyword: string): Promise<void>;
}

const EMPTY_CONCEPT_POOL: ConceptPool = { known: [], candidates: [], source: new Map() };
const VIEW_QUOTA_RECHECK_FALLBACK_MS = 60_000;
const VIEW_QUOTA_WAKE_GRACE_MS = 250;
/** 评论角色单次 LLM 硬 deadline；不沿用面向慢 thinking 角色的全局 180s。 */
export const DEFAULT_COMMENT_LLM_TIMEOUT_MS = 30_000;
/** 整条评论子链的安全兜底；局部 LLM / 人审超时应更早结束。 */
export const DEFAULT_COMMENT_SUBLINE_TIMEOUT_MS = 5 * 60_000;
function positiveTimeoutMs(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

export interface ViewQuotaDecision {
  allowed: boolean;
  reason?: string;
  retryAfterMs?: number;
}

export type MandatoryCommentOutcome = 'confirmed' | 'pending' | 'failed' | 'unknown';

/** mandatory auto_approve 评论的操作员终态通知；同一 requestId 最多上报一次。 */
export interface MandatoryCommentOutcomeNoticeInput {
  requestId: string;
  noteId: string;
  text: string;
  outcome: MandatoryCommentOutcome;
  reason?: string;
  accountId?: string;
  accountName?: string;
  title?: string;
  authorName?: string;
}

interface PendingCommentDelivery {
  noteId: string;
  sourcePageType: 'feed' | 'search';
  actions: ('like' | 'collect')[];
  text: string;
  mandatoryInteraction?: MandatoryInteractionContext;
  approvalTrace?: CommentApprovalTrace;
}

type CommentSublineSnapshot = Pick<CommentAppraisingPayload, 'noteId' | 'sourcePageType' | 'actions'>;

export type SessionBudgetAction = 'like' | 'collect' | 'follow' | 'search' | 'comment' | 'comment_like' | 'join_group';

const SESSION_BUDGET_ACTION_KEYS: Record<SessionBudgetAction, keyof SessionInteractionBudget> = {
  like: 'likes',
  collect: 'collects',
  follow: 'follows',
  search: 'searches',
  comment: 'comments',
  comment_like: 'comment_likes',
  join_group: 'join_groups',
};

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
  /** 通知巡视的任务级执行权；缺省仅供旧测试兼容，生产必须注入。 */
  edgeTaskLeases?: Pick<EdgeTaskLeaseClient, 'acquire' | 'release'>;
  clock?: () => number;
  /** 外部事件总线（共享 handler 发射的 Edge 上报事件），缺省创建独立实例 */
  eventBus?: EventBus;
  /**
   * 读取当前账号风控状态（指令级节奏的 tempo 来源）。缺省 `'normal'`。
   * 由 server 接线为 `() => riskController.getState().status`。
   */
  getRiskStatus?: () => RiskStatus;
  /** 读取当前账号配额档（运营后台可配）；用于生效 tempo（与风控状态取更慢者）。缺省 normal。 */
  getQuotaLevel?: () => RiskQuotaLevel;
  /** 后台节奏兜底配置 provider；用于内容阅读/feed 新卡阅读的云端时长计算。 */
  pacingFloors?: PacingFloorProvider;
  /**
   * 互动前风控闸：下发 like/collect/follow 前判定是否允许。缺省始终允许（向后兼容）。
   * 由 server 接线为 `(action) => riskController.canDo(action)`。被拒则诚实跳过（不下发、不扣 budget）。
   */
  canInteract?: (action: 'like' | 'collect' | 'follow' | 'comment' | 'comment_like') => boolean;
  /** 互动风控解释口；mandatory 评论预检和最终闸共用同一 RiskController 判定来源。 */
  explainInteract?: (action: 'like' | 'collect' | 'follow' | 'comment' | 'comment_like') => ViewQuotaDecision;
  /** 浏览前风控闸：兼容旧测试/旧装配；优先使用 explainView。 */
  canView?: () => boolean;
  /**
   * 浏览前风控闸：下发 open_note 前判定是否允许新增一次 view，并给出 quota 窗口重试时间。
   * 由 server 接线为 `() => riskController.explain('view')`。被拒则进入浏览休眠，不打开下一篇。
   */
  explainView?: () => ViewQuotaDecision;
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
  /** 结构化 mandatory auto_approve 免审通知；通知成功才放行，缺省 fail-closed。 */
  commentAutoApproveNotify?: (input: CommentApprovalNoticeInput) => Promise<void>;
  /**
   * 「已批准未送达」操作员回报（change platform-browse-protocol）：评论迁移的 navigate 步失败 ⇒ 不发评论、
   * 显式回报操作员（人审成本已付）。缺省（未接线）→ 仅 warn 日志。阶段 0 迁移结构性不可达 ⇒ 从不触发。
   * 迁移灰度开启（C2）时由 server 接线到飞书出口。
   */
  notifyApprovedNotDelivered?: (input: { noteId: string; reason?: string }) => void | Promise<void>;
  /** mandatory auto_approve 评论的平台终态通知口；同一 requestId 最多调用一次。 */
  notifyMandatoryCommentOutcome?: (input: MandatoryCommentOutcomeNoticeInput) => void | Promise<void>;
  /** mandatory 预授权到平台终态的最长等待；缺省 120s。 */
  mandatoryCommentOutcomeTimeoutMs?: number;
  /** 该账号当日剩余评论上限（后台配置）。缺省 → 仅会话评论预算 + 风控配额生效。 */
  getCommentDailyRemaining?: () => number;
  /** 该账号当日剩余「评论赞」配额（接 riskController.dailyRemaining('comment_like')）。 */
  getCommentLikeDailyRemaining?: () => number;
  /** 优质评论归档闭包（接 ValuableCommentStore.archive）；缺省 → 不注册归档角色（语料库关闭）。 */
  archiveValuableComment?: (input: ValuableCommentInput) => Promise<void>;
  /** 按主题键召回语料库参考评论（接 ValuableCommentStore.retrieveByTopics）；缺省 → 撰写不注入参考。 */
  getCorpusReferences?: (topics: string[]) => Promise<ValuableCommentRef[]>;
  /** 可选语料召回等待上限；超时按空参考继续。 */
  commentCorpusLookupTimeoutMs?: number;
  /** 评论评估 / 撰写 / 去 AI 味的单次 LLM 硬 deadline。 */
  commentLlmTimeoutMs?: number;
  /** 整条评论支线等待上限；超时释放钉页与会话时钟。 */
  commentSublineTimeoutMs?: number;
  /**
   * 精选语料库（change curated-admission-eval-roles，Phase 3）：注入则注册两段式准入的模型评估角色
   * —— 正文角色（curated_note_evaluator，恒注册）+ 评论角色（curated_comment_evaluator，仅评论赞链路开启时）。
   * 缺省（如 PG 不可用）→ 两角色都不注册，准入退回全局处理器的自有收藏直纳路径（仿 concept_extractor 仅概念池可用时注册）。
   */
  curatedStore?: CuratedNoteSink & CuratedCommentSink;
  /** Optional admission-time text-card recognition/transcription service; its own flag remains authoritative. */
  textCardTranscriber?: TextCardTranscriber;
  /**
   * 引流线索自动触发（change feed-hot-lead-auto-group-comment）：注入 `fireAutoContactComment` 则注册 hot_lead_detector
   * （接稿件价值判定之后，quality.pass 命中热度闸 + 账号开自动联系评论 + 过统一安全闸 → 自动触发带联系方式评论 → 飞书人审）。
   * 缺省 → 不注册（仿 concept_extractor 仅资源可用时注册）。
   */
  hotLeadGateConfig?: () => HotLeadGateConfig;
  /** 账号是否开启自动联系评论（contactCommentEnabled）；缺则视为未开（不发，零回归）。 */
  isAutoContactEnabled?: (accountId: string) => Promise<boolean>;
  /** 引流线索「已评过」去重口（接 riskStore.hasInteraction(accountId,noteId,'comment')）。 */
  hasCommentedForLead?: (accountId: string, noteId: string) => Promise<boolean>;
  /** 触发一条受闸自动联系评论（内部走 helper：canDo+子上限+当前详情直评）。注入则注册 detector。 */
  fireAutoContactComment?: (args: {
    accountId: string;
    noteId: string;
    title: string;
    currentDetail: NoteDetailData;
    velocity: number;
    ageHours: number;
  }) => Promise<{ fired: boolean; reason?: string }>;
  /**
   * 诚实人设启动闸（multi-account-node-support D3）：以「人设存储中是否存在该账号的人设行」为独立判据
   * （getForAccount!==null，**不走会回落默认的解析器**）。缺省 → 不设闸（向后兼容单账号）。default 账号硬豁免（见 canStartSession）。
   */
  isPersonaBound?: (accountId: string) => boolean;
  /** 账号未绑人设被诚实拒绝时回调（记录 needs_persona_setup 拒绝）。 */
  onSessionRejected?: (accountId: string, reason: string) => void | Promise<void>;
  /** 全局调度开关（面板 /dispatch）：false 时不启动浏览会话。缺省 → 恒 true。 */
  isDispatchActive?: () => boolean;
  /**
   * 该连接账号的运行时平台（facebook-scheduled-comment 2.8）。设置后，若该平台注册表能力不含 'browse'
   * （如 Facebook v1 只声明 'comment'），canStartSession 诚实拒绝启动 xhs 浏览角色循环。缺省 → 不设闸（向后兼容）。
   */
  accountPlatform?: PlatformId;
  /**
   * 本连接边缘是否声明 `inline_targeting`（change facebook-feed-inline-browse 灰度接线）。就地读/赞的
   * 版本偏斜闸：registry 声明 read_content='feed' 时，**仅对声明该能力的边缘**（含 inline reader 的重打包）
   * 生效；老边端 / 未重打包回落 detail ⇒ 永不收到 surface:'feed'、逐位等于今天。由 server 快照本连接握手能力
   * 注入（重连按新连接重建、天然刷新）。缺省 → 恒 false（无就地读，=今天，保护测试与旧装配）。
   */
  hasInlineTargeting?: () => boolean;
  /**
   * Facebook 每日累计在线分钟默认（change account-nurture-discipline-spine §4.2）：全局每日时长阈值
   * （dailyCaps().maxMinutes）未显式设值（0=不限）时，Facebook 账号回落这个非零安全日窗（养号「每天在线
   * 0.5–6h」防长挂）。全局显式设值时以全局为准。缺省 DEFAULT_FB_DAILY_ONLINE_MINUTES。
   */
  facebookDailyOnlineMinutes?: number;
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
   * 单场上限提供者（全局单例，change restore-auto-resume-and-global-safety-config）：给出全局单场时长 + 单场互动预算
   * （安全限额层，热加载、后台改即生效、对所有账号生效）。缺省 → 回落写死默认（时长 10min + freshBudget 数字），
   * 与改造前逐位一致（严格零回归）。只读、不触风控状态单写、不经协议。
   */
  sessionLimitProvider?: SessionLimitProvider;
  /**
   * 自动续场护栏 + 看门狗阈值提供者（全局单例，change restore-auto-resume-and-global-safety-config）：给出全局
   * rest_ratio / 活跃时段窗口 / 每日上限 / 看门狗两阈值（热加载、后台改即生效、对所有账号生效）。
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
   * **同步**——采集收尾时做差异写库判定（不 await PG，避免阻塞回 feed）。
   * 由 server 注入读 AccountStore 进程内缓存；缺省 → 恒 null（无 PG 退化）。
   */
  getNickname?: (accountId: string) => string | null;
  /** 持久化账号昵称（change account-real-nickname）：nickname_enricher 采到非空时单写 upsert（拒空、不阻塞）。 */
  setNickname?: (accountId: string, nickname: string) => Promise<void> | void;
}

export interface EdgeCommand {
  action: 'scroll' | 'refresh' | 'open_note' | 'close_note' | 'like' | 'collect' | 'follow' | 'comment' | 'comment_like' | 'search' | 'back' | 'browse_images' | 'scroll_comments' | 'profile_open' | 'open_notifications' | 'browse_notification_comments' | 'browse_notification_likes' | 'browse_notification_follows' | 'notification_back_home' | 'pacing_update' | 'session.end';
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

export interface SessionUsageSnapshot {
  active: boolean;
  startedAt?: number;
  totals: SessionInteractionBudget;
  quotas: SessionInteractionBudget;
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
  /** 帖子下他人评论正文样本（change platform-vocabulary-and-thresholds 2.1）：撰写器据此贴合评论区语境。
   *  Facebook 由 note.detail 直接透传；小红书 note.detail 不带评论，由 scroll_comments 回执候选归集到当前笔记。 */
  comments?: string[];
}

// ─── RoleDispatcher ─────────────────────────────────────────────────────────

export class RoleDispatcher {
  private readonly eventBus: EventBus;
  private readonly sessionContext: SessionContext;
  /** 人设：getSoul 取值口（热加载）优先，soulSnapshot 为兼容快照。经 resolveSoul() 统一取值。 */
  private readonly soulSnapshot?: Soul;
  private readonly getSoulFn?: (accountId?: string) => Soul;
  /** 当前账号（由连接真实账号经 setCurrentAccountId 设入）。绑定前为保留占位 '__unbound__'（retire-default-account：不再用 'default' 钉死）。 */
  private currentAccountId = '__unbound__';
  private readonly llm: { complete(prompt: string, opts?: LlmCallOpts): Promise<string> };
  private readonly rawSendCommand: (command: EdgeCommand) => void;
  private readonly clock: () => number;
  private readonly getRiskStatus: () => RiskStatus;
  private readonly getQuotaLevel: () => RiskQuotaLevel;
  /** 上次已推送给边缘的 tempo 档位（去抖基线）；构造期初始化为握手同源值，仅档位实变时经 pacing.update 补推。 */
  private lastPushedTempo = 1.0;
  private readonly pacingFloors?: PacingFloorProvider;
  private readonly canInteract: (action: 'like' | 'collect' | 'follow' | 'comment' | 'comment_like') => boolean;
  private readonly explainInteract: (action: 'like' | 'collect' | 'follow' | 'comment' | 'comment_like') => ViewQuotaDecision;
  private readonly canView: () => boolean;
  private readonly explainView: () => ViewQuotaDecision;
  private readonly commentApproval?: CommentApprovalPort;
  private readonly commentAutoApproveNotify?: (input: CommentApprovalNoticeInput) => Promise<void>;
  private readonly notifyApprovedNotDelivered?: (input: { noteId: string; reason?: string }) => void | Promise<void>;
  private readonly notifyMandatoryCommentOutcome?: (input: MandatoryCommentOutcomeNoticeInput) => void | Promise<void>;
  private readonly mandatoryCommentOutcomeTimeoutMs: number;
  private readonly getCommentDailyRemaining?: () => number;
  private readonly getCommentLikeDailyRemaining?: () => number;
  private readonly archiveValuableComment?: (input: ValuableCommentInput) => Promise<void>;
  private readonly curatedStore?: CuratedNoteSink & CuratedCommentSink;
  private readonly textCardTranscriber?: TextCardTranscriber;
  private readonly hotLeadGateConfig?: () => HotLeadGateConfig;
  private readonly isAutoContactEnabled?: (accountId: string) => Promise<boolean>;
  private readonly hasCommentedForLead?: (accountId: string, noteId: string) => Promise<boolean>;
  private readonly fireAutoContactComment?: (args: {
    accountId: string;
    noteId: string;
    title: string;
    currentDetail: NoteDetailData;
    velocity: number;
    ageHours: number;
  }) => Promise<{ fired: boolean; reason?: string }>;
  private readonly getCorpusReferences?: (topics: string[]) => Promise<ValuableCommentRef[]>;
  private readonly commentCorpusLookupTimeoutMs?: number;
  private readonly commentLlmTimeoutMs: number;
  private readonly commentSublineTimeoutMs: number;
  /** 已下发待回执的评论上下文：action.completed{comment} 据此扣额 + emit comment.done（→ 是否进主页评估）。 */
  private pendingComment: PendingCommentDelivery | null = null;
  /**
   * 回执驱动两步评论迁移（change platform-browse-protocol）：commentSurface≠readSurface 时先发 open_note{purpose:'navigate'}，
   * 待其 action.completed{ok, observation.surface:'detail', noteId 匹配} 才发 comment。阶段 0 两 surface 相等 ⇒ 结构性不可达。
   */
  private pendingMigration: PendingCommentDelivery | null = null;
  /** mandatory 预授权评论的有界终态等待计时器。 */
  private mandatoryCommentOutcomeTimer: unknown;
  /** requestId 级幂等：不论成功、失败还是未知，同一次预授权只尝试一次终态通知。 */
  private readonly reportedMandatoryCommentRequests = new Set<string>();
  /**
   * 评论支线在途标志（change comment-approval-target-hold）：comment.appraised（确立要评）置、
   * comment.approved（下发前）/comment.skipped 清。覆盖撰写 / 去 AI 味 / 审批全程，把账号钉在待评论帖上。
   * 经 sendCommand 统一出口生效：置位期扣住一切会离开待评论帖的 browse/互动命令（stale-target 重扫、idle_nudge 滚屏、
   * open_note 换帖、refresh、feed 续滚），只放行 session.end 与 excursion bypass。配合 SessionMonitor.pauseClock('comment_subline')
   * 推迟窗内 should_end（动作数/时长/配额触发的结束延后到评论支线终局，避免废掉在审/已授权评论）。
   */
  private commentInflight = false;
  /** 当前评论支线的总超时句柄与事件快照。 */
  private commentSublineTimer: unknown;
  private commentSublineSnapshot?: CommentSublineSnapshot;
  /** dispatcher 生命周期内保留墓碑，迟到异步结果不得重新授权或下发。 */
  private readonly expiredCommentSublineNoteIds = new Set<string>();
  /** feed 翻页按新卡数算的待发停留兜底（feed-scroll-card-floor）：page.cards.arrived 覆盖写、feed.scrolled 消费后归零。 */
  private pendingFeedFloorMs = 0;
  /** 当前会话已授权过首页空态→Reels；重复 empty 报告不得多次导航。 */
  private reelsFallbackAuthorized = false;
  private readonly isHardPaused: (edgeId?: string) => boolean;
  private readonly edgeTaskLeases?: Pick<EdgeTaskLeaseClient, 'acquire' | 'release'>;
  private currentEdgeId?: string;
  private notificationTaskLease?: EdgeTaskLease;
  private notificationTaskAcquire?: Promise<void>;
  private notificationTaskEnding = false;
  private pendingNotificationCommands: EdgeCommand[] = [];
  private readonly isPersonaBound?: (accountId: string) => boolean;
  private readonly onSessionRejected?: (accountId: string, reason: string) => void | Promise<void>;
  private readonly isDispatchActive: () => boolean;
  /** 该连接账号平台（2.8 会话平台闸）；缺省不设闸。 */
  private readonly accountPlatform?: PlatformId;
  /** 本连接边缘是否声明 inline_targeting（就地读/赞版本偏斜闸）；缺省 false = 老边端逐位等今天。 */
  private readonly hasInlineTargeting: () => boolean;
  /** Facebook 每日在线分钟默认（§4.2）；全局未设时 FB 账号回落此非零日窗。 */
  private readonly facebookDailyOnlineMinutes: number;
  /** 同账号并行互动去重 guard（按账号单例）；缺省不去重。 */
  private readonly interactionGuard?: InteractionGuard;
  /** 动作冷却闸（engagement-restraint）；缺省不冷却。 */
  private readonly cooldownGate?: ActionCooldownGate;
  /** 单场上限提供者（读全局单场时长 + 互动预算，热加载、对所有账号生效）；缺省回落写死默认。只读。 */
  private readonly sessionLimitProvider?: SessionLimitProvider;
  /** 续场护栏 + 看门狗阈值提供者（读全局配置，热加载、对所有账号生效）；未注入 → 自动续场关、看门狗回落默认。只读。 */
  private readonly resumeConfigProvider?: ResumeConfigProvider;
  private readonly setTimeoutFn: (fn: () => void, ms: number) => unknown;
  private readonly clearTimeoutFn: (handle: unknown) => void;
  private readonly randomFn: () => number;
  /** 同步读账号昵称（change account-real-nickname）：采集收尾差异写库用；缺省恒 null。 */
  private readonly getNickname: (accountId: string) => string | null;
  /** 持久化账号昵称（change account-real-nickname）：nickname_enricher 采到非空时调；缺省 → 不持久化。 */
  private readonly setNickname?: (accountId: string, nickname: string) => Promise<void> | void;
  /** 续场休息计时器句柄（每连接私有、unref，只重开本连接会话；绝不广播）。 */
  private restTimer: unknown;
  /** 「可活跃时间」窗口唤醒计时器句柄（休眠期排到下一个活跃整点主动续上；每连接私有、unref）。 */
  private wakeTimer: unknown;
  /** 浏览额度休眠计时器句柄（minute/hour/day 窗口释放后重驱浏览；每连接私有、unref）。 */
  private viewQuotaSleepTimer: unknown;
  private viewQuotaSleeping = false;
  /**
   * 本轮浏览额度休眠已扣下的命令数（change session-start-quota-honest-sleep）。
   * 每次进入休眠置 0；命令下发口按此节流打印（首条 + 每 N 条汇总），避免日窗数小时休眠 ×
   * 存活探针 240s nudge × 车队规模刷屏。红线：节流 ≠ 不打——这道闸从边角升为主刹车，静默丢弃即撞红线。
   */
  private viewQuotaSuppressedCount = 0;
  /** 每账号当日自动续场计数（场数 + 累计浏览毫秒），按本地日界重置。 */
  private readonly dailyResume = new Map<string, { dayKey: string; sessions: number; browseMs: number }>();
  /** SessionMonitor 引用（供 excursion → pauseClock/resumeClock；setup 时捕获）。 */
  private sessionMonitor?: SessionMonitorRole;
  /** 本次正常结束已对边端公布的续场休息时长；随后 armRestTimer 复用，避免 UI 与真实计时器漂移。 */
  private pendingAutoResumeInMs: number | undefined;
  /**
   * 登录账号真实昵称采集体：在 setup() 永久接线、独立于浏览会话，
   * 但只由完整浏览器启动后的首批 page.cards{startupId} 触发，不由 hello/session_start 触发。
   */
  private nicknameEnricher?: NicknameEnricher;
  /** 已下发占坑、待回执释放的互动键（按动作）：action.completed 据此 complete / releaseFailed。 */
  private readonly pendingInteractionKeys = new Map<GuardAction, string>();
  /**
   * like/collect 下发后的重试上下文（change fix-interaction-and-comment-capture）：回执带不带 noteId，
   * 故下发时按动作暂存 noteId + 已重试次数；可重试失败（点了没生效/互动栏一时缺失）时据此原地重发一次。
   */
  private readonly interactionRetry = new Map<'like' | 'collect', { noteId: string; attempts: number }>();
  private readonly notifyComments?: (items: NotificationItem[]) => Promise<void>;
  private readonly conceptStore?: ConceptStorePort;
  /** 搜索前限频闸（每关键词每会话/每天上限），dispatcher 持有单例，会话重启时清会话计数。 */
  private readonly searchLimiter: SearchFrequencyLimiter;
  /** 概念池快照：startSession 时 loadPool 刷新，供 SearchEvaluator 读取。 */
  private conceptPool: ConceptPool = EMPTY_CONCEPT_POOL;
  /** 会话开始时刻，用于估算会话进度（疲劳乘子）。时长上限改为从全局单场上限提供者惰性解析（见 maxDurationMs()）。 */
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
  /** Facebook 自然互动证据：必须先由 content_evaluator 选中，再由 content_curator 放行，interaction_appraiser 才能发 like。 */
  private readonly facebookContentSelectedNoteIds = new Set<string>();
  private readonly facebookQualityPassedNoteIds = new Set<string>();
  /** 已呈现 Facebook 视频的会话级一次性决策集合；命中/未命中/被安全闸挡住都不得因重报重抽。 */
  private readonly facebookPresentedVideoLikeDecisionNoteIds = new Set<string>();
  /** 当前会话剩余互动预算（从全局单场上限提供者派生，会话开始/重置时刷新）。 */
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
    this.edgeTaskLeases = options.edgeTaskLeases;
    this.clock = options.clock ?? Date.now;
    this.getRiskStatus = options.getRiskStatus ?? (() => 'normal');
    this.getQuotaLevel = options.getQuotaLevel ?? (() => 'normal');
    // 去抖基线 = 握手 welcome 快照同源的初始 tempo（读风控态 + 配额档取更慢者、异常回落 1.0）：会话初不冗余补推，仅后续档位实变才发。
    try {
      this.lastPushedTempo = effectiveTempo(this.getRiskStatus(), this.getQuotaLevel());
    } catch {
      this.lastPushedTempo = 1.0;
    }
    this.pacingFloors = options.pacingFloors;
    this.canInteract = options.canInteract ?? (() => true);
    this.explainInteract = options.explainInteract ?? ((action) => {
      const allowed = this.canInteract(action);
      return allowed ? { allowed } : { allowed, reason: 'risk_blocked' };
    });
    this.canView = options.canView ?? (() => true);
    this.explainView = options.explainView ?? (() => {
      const allowed = this.canView();
      return allowed ? { allowed } : { allowed, reason: 'view_quota_exhausted' };
    });
    this.commentApproval = options.commentApproval;
    this.commentAutoApproveNotify = options.commentAutoApproveNotify;
    this.notifyApprovedNotDelivered = options.notifyApprovedNotDelivered;
    this.notifyMandatoryCommentOutcome = options.notifyMandatoryCommentOutcome;
    this.mandatoryCommentOutcomeTimeoutMs = Math.max(1, options.mandatoryCommentOutcomeTimeoutMs ?? 120_000);
    this.getCommentDailyRemaining = options.getCommentDailyRemaining;
    this.getCommentLikeDailyRemaining = options.getCommentLikeDailyRemaining;
    this.archiveValuableComment = options.archiveValuableComment;
    this.getCorpusReferences = options.getCorpusReferences;
    this.commentCorpusLookupTimeoutMs = options.commentCorpusLookupTimeoutMs;
    this.commentLlmTimeoutMs = positiveTimeoutMs(options.commentLlmTimeoutMs, DEFAULT_COMMENT_LLM_TIMEOUT_MS);
    this.commentSublineTimeoutMs = positiveTimeoutMs(options.commentSublineTimeoutMs, DEFAULT_COMMENT_SUBLINE_TIMEOUT_MS);
    this.curatedStore = options.curatedStore;
    this.textCardTranscriber = options.textCardTranscriber;
    this.hotLeadGateConfig = options.hotLeadGateConfig;
    this.isAutoContactEnabled = options.isAutoContactEnabled;
    this.hasCommentedForLead = options.hasCommentedForLead;
    this.fireAutoContactComment = options.fireAutoContactComment;
    this.isHardPaused = options.isHardPaused ?? (() => false);
    this.isPersonaBound = options.isPersonaBound;
    this.onSessionRejected = options.onSessionRejected;
    this.isDispatchActive = options.isDispatchActive ?? (() => true);
    this.accountPlatform = options.accountPlatform;
    this.hasInlineTargeting = options.hasInlineTargeting ?? (() => false);
    this.facebookDailyOnlineMinutes = options.facebookDailyOnlineMinutes ?? DEFAULT_FB_DAILY_ONLINE_MINUTES;
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
   * persona-driven-content-pipeline 后取值口无默认人设回落——未绑账号已被 canStartSession 人设闸
   * 先行拒绝；若此后仍解析不到（如会话中被解绑），取值口抛 no_persona 诚实失败（EventBus 兜错、
   * 不崩进程），绝不以默认人设继续。soul / getSoul 两者皆缺则抛（构造契约违背，诚实失败不静默）。
   */
  private resolveSoul(): Soul {
    if (this.getSoulFn) return this.getSoulFn(this.currentAccountId);
    if (this.soulSnapshot) return this.soulSnapshot;
    throw new Error('RoleDispatcher 缺少人设注入（soul / getSoul 至少给一个）');
  }

  /** 会话时长上限（毫秒）：从全局单场上限提供者惰性解析（热加载，后台改即时生效、对所有账号生效）；缺省回落写死默认。 */
  private maxDurationMs(): number {
    return this.sessionLimitProvider?.sessionDurationMs() ?? DEFAULT_SESSION_DURATION_MS;
  }

  /** 收藏质量闸比例（热加载，后台改即时生效、对所有账号生效）；缺提供者回落角色内写死默认 1:3。 */
  private collectMinSaveLikeRatio(): number {
    return this.sessionLimitProvider?.collectSaveLikeRatio() ?? COLLECT_MIN_SAVE_LIKE_RATIO;
  }

  /** 关注质量闸比例（热加载）；缺提供者回落角色内写死默认 1:8。 */
  private followMinFansRatio(): number {
    return this.sessionLimitProvider?.followFansRatio() ?? FOLLOW_MIN_FANS_ENGAGEMENT_RATIO;
  }

  /** 会话进度 0..1（已用时长 / 时长上限），供节奏疲劳乘子使用。 */
  private progress(): number {
    const elapsed = this.clock() - this.sessionStartedAt;
    return Math.min(1, Math.max(0, elapsed / this.maxDurationMs()));
  }

  /** 动作前犹豫时间中心值（随风控状态 + 会话进度缩放）。familiar=true 对近期已评估内容按 1/3 折扣。 */
  private thinkNow(familiar = false): number {
    return computeThinkMs({ status: this.getRiskStatus(), quotaLevel: this.getQuotaLevel(), progress: this.progress(), familiar });
  }

  /** 通知巡视命令（巡视期放行，浏览类命令被暂停出口扣住）。 */
  private isExcursionCommand(action: EdgeCommand['action']): boolean {
    return action === 'open_notifications'
      || action === 'browse_notification_comments'
      || action === 'browse_notification_likes'
      || action === 'browse_notification_follows'
      || action === 'notification_back_home';
  }

  private beginNotificationTask(): void {
    if (!this.edgeTaskLeases || this.notificationTaskLease || this.notificationTaskAcquire) return;
    const edgeId = this.currentEdgeId;
    if (!edgeId) {
      this.pendingNotificationCommands = [];
      this.eventBus.emit('action.completed', {
        action: 'notification_back_home', ok: false, reason: 'task_acquire_missing_edge', ts: this.clock(),
      });
      return;
    }
    this.notificationTaskEnding = false;
    this.notificationTaskAcquire = this.edgeTaskLeases
      .acquire({ edgeId, kind: 'notification', priority: 'automatic', leaseMs: 2 * 60_000 })
      .then(async (lease) => {
        if (this.notificationTaskEnding) {
          await this.edgeTaskLeases!.release(lease, 'cancelled').catch(() => {});
          return;
        }
        this.notificationTaskLease = lease;
        const queued = this.pendingNotificationCommands;
        this.pendingNotificationCommands = [];
        for (const command of queued) {
          this.rawSendCommand({
            ...command,
            params: { ...(command.params ?? {}), taskId: lease.taskId },
          });
        }
      })
      .catch((err) => {
        this.pendingNotificationCommands = [];
        console.warn(`[RoleDispatcher] 通知巡视未取得 edge task lease：${(err as Error).message}`);
        // 走既有 excursion resumer 失败出口，解除 browseSuspended，不永久挂起。
        this.eventBus.emit('action.completed', {
          action: 'notification_back_home', ok: false, reason: 'task_acquire_failed', ts: this.clock(),
        });
      })
      .finally(() => {
        this.notificationTaskAcquire = undefined;
      });
  }

  private async endNotificationTask(): Promise<void> {
    this.notificationTaskEnding = true;
    this.pendingNotificationCommands = [];
    const acquiring = this.notificationTaskAcquire;
    if (acquiring) await acquiring.catch(() => {});
    const lease = this.notificationTaskLease;
    this.notificationTaskLease = undefined;
    if (lease && this.edgeTaskLeases) {
      await this.edgeTaskLeases.release(lease, 'completed').catch((err) => {
        console.warn(`[RoleDispatcher] 通知巡视 task release 未确认：${(err as Error).message}`);
      });
    }
  }

  /**
   * 进入评论支线在途暂停态（change comment-approval-target-hold）：置 commentInflight（经 sendCommand 扣住一切离页命令）
   * + pauseClock（推迟窗内 should_end）。只在 currentNote 命中该 noteId 时置位（守卫下游同 tick 同步 skip 卡死，见调用处注释）。
   * comment.appraising / comment.appraised 两入口共用；幂等（布尔 + pauseReasons Set），终局单次 resumeClock 解除。
   */
  private enterCommentSubline(payload: CommentSublineSnapshot): void {
    if (this.currentNote?.noteId !== payload.noteId) return;
    if (this.expiredCommentSublineNoteIds.has(payload.noteId)) return;
    // appraising + appraised 会先后抵达；总期限只从第一个有效入口起算，不允许后续阶段续期。
    if (this.commentInflight) return;
    this.commentInflight = true;
    this.commentSublineSnapshot = {
      noteId: payload.noteId,
      sourcePageType: payload.sourcePageType,
      actions: [...payload.actions],
    };
    this.sessionMonitor?.pauseClock('comment_subline');
    this.commentSublineTimer = this.setTimeoutFn(
      () => this.expireCommentSubline(payload.noteId),
      this.commentSublineTimeoutMs,
    );
    (this.commentSublineTimer as { unref?: () => void } | undefined)?.unref?.();
  }

  private isCommentSublineExpired(noteId: string): boolean {
    return this.expiredCommentSublineNoteIds.has(noteId);
  }

  private clearCommentSublineHold(resumeClock: boolean): void {
    if (this.commentSublineTimer !== undefined) {
      this.clearTimeoutFn(this.commentSublineTimer);
      this.commentSublineTimer = undefined;
    }
    this.commentSublineSnapshot = undefined;
    this.commentInflight = false;
    if (resumeClock) this.sessionMonitor?.resumeClock('comment_subline');
  }

  private expireCommentSubline(noteId: string): void {
    const snapshot = this.commentSublineSnapshot;
    if (!this.commentInflight || !snapshot || snapshot.noteId !== noteId) return;
    this.expiredCommentSublineNoteIds.add(noteId);
    // 当前回调已经触发；先清态再发唯一终局事件，避免同步监听器看到仍在途或重复清理。
    this.commentSublineTimer = undefined;
    this.commentSublineSnapshot = undefined;
    this.commentInflight = false;
    this.sessionMonitor?.resumeClock('comment_subline');
    console.warn(`[RoleDispatcher] comment_subline_timeout note=${noteId} timeoutMs=${this.commentSublineTimeoutMs}`);
    this.eventBus.emit('comment.skipped', {
      ...snapshot,
      reason: 'comment_subline_timeout',
      ts: this.clock(),
    });
  }

  private isQuotaSleepBypass(command: EdgeCommand): boolean {
    return command.action === 'session.end'
      || this.isExcursionCommand(command.action)
      || (this.sessionContext.selfCaptureInFlight && command.action === 'profile_open');
  }

  /**
   * 评论支线自己的命令（change fb-comment-migration-hold）：两步迁移的 navigate open 与随后的授权 comment。
   * 它们是迁移在途暂停要保护的对象，MUST 豁免自身暂停——否则会被自己设的 pendingMigration 闸扣住而静默丢弃。
   */
  private isCommentSublineCommand(command: EdgeCommand): boolean {
    return command.action === 'comment'
      || (command.action === 'open_note'
        && (command.params as { purpose?: string } | undefined)?.purpose === 'navigate');
  }

  /**
   * 发命令的统一出口（软暂停闸）。巡视期（browseSuspended）扣住 browse 类命令——它们会从下次
   * page.cards 自行重来——只放行巡视命令与 session.end；非巡视期照常下发。所有翻译块都经此。
   */
  /**
   * 中途档位补推（change pacing-fallback-hardening）：会话稳定连接期间风控档位变化时，把新 tempo
   * 经原始下发通道直发 `pacing.update` 给边缘（**不过**软暂停/配额/去重闸——控制消息不应被抑制、不占配额）。
   * 去抖：仅当 tempo 相对上次已推送值变化才发；握手已下发初始值、构造期已设基线，故无变化不冗余。
   * 经 `rawSendCommand`（不回流 `sendCommand`）→ 无递归。读风控态异常则跳过（不推、不改基线）。
   */
  private maybePushTempo(): void {
    let tempo: number;
    try {
      tempo = effectiveTempo(this.getRiskStatus(), this.getQuotaLevel());
    } catch {
      return;
    }
    if (tempo === this.lastPushedTempo) return;
    this.lastPushedTempo = tempo;
    this.rawSendCommand({ action: 'pacing_update', params: { tempo } });
  }

  private sendCommand(command: EdgeCommand): boolean {
    // 中途档位补推：先于软暂停/配额/去重闸——控制消息不应被抑制、不占配额（见 maybePushTempo）。
    this.maybePushTempo();
    if (this.viewQuotaSleeping && !this.isQuotaSleepBypass(command)) {
      // 浏览额度休眠：不打开/滚动/互动，等窗口释放后重驱。
      // 🔴 红线：MUST NOT 静默丢弃——节流打印首条 + 每 50 条汇总（key=account+reason，同一轮休眠）。
      this.viewQuotaSuppressedCount += 1;
      if (this.viewQuotaSuppressedCount === 1 || this.viewQuotaSuppressedCount % 50 === 0) {
        const noteId = typeof command.params?.noteId === 'string' ? command.params.noteId : '-';
        console.log(
          `[RoleDispatcher] command.suppressed reason=view_quota_sleep action=${command.action} note=${noteId} account=${this.currentAccountId} suppressed=${this.viewQuotaSuppressedCount}`,
        );
      }
      return false;
    }
    if (
      this.sessionContext.browseSuspended &&
      !this.isQuotaSleepBypass(command)
    ) {
      return false; // 软暂停：丢弃 browse 命令（不入队、由 page.cards 续刷自然重来）
    }
    if (this.commentInflight && !this.isQuotaSleepBypass(command)) {
      // 评论支线在途（change comment-approval-target-hold）：钉在待评论帖上，扣住一切会离页的 browse/互动命令
      // （stale-target 重扫 / idle_nudge 滚屏 / open_note 换帖 / refresh / feed 续滚）。session.end 与 excursion 仍放行。
      // 与 browseSuspended 并列取并集：巡视/昵称采集用 browseSuspended（布尔），评论支线用本标志（dispatcher 私有），互不覆盖。
      const noteId = typeof command.params?.noteId === 'string' ? command.params.noteId : '-';
      console.log(
        `[RoleDispatcher] command.suppressed reason=comment_inflight action=${command.action} note=${noteId} account=${this.currentAccountId}`,
      );
      return false;
    }
    if (
      this.pendingMigration
      && !this.isQuotaSleepBypass(command)
      && !this.isCommentSublineCommand(command)
    ) {
      // 评论迁移在途（change fb-comment-migration-hold）：钉在待迁移帖上，扣住一切会离页的 browse/互动命令
      // （page.scroll / 换帖 open_note / refresh / feed 续滚 / stale-target 重扫）——否则迁移落地前后并发的
      // scroll 会经 ensureFeed 把浏览器整页拽回首页、迁移拿不到详情、已批准评论被丢。本评论支线自己的
      // 迁移 open_note{purpose:'navigate'} 与后续 comment 经 isCommentSublineCommand 放行。pendingMigration
      // 已在所有终局（落地回执/migrateSent=false/reset/suppression/preempt）清空，故此闸不会泄漏钉死会话。
      return false;
    }
    if (this.edgeTaskLeases && this.isExcursionCommand(command.action)) {
      if (!this.notificationTaskLease) {
        this.pendingNotificationCommands.push(command);
        return true;
      }
      command = {
        ...command,
        params: { ...(command.params ?? {}), taskId: this.notificationTaskLease.taskId },
      };
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
   * note-scoped 动作的唯一显式拒绝点（change platform-registry-shape）：平台声明该动作 unsupported ⇒
   * 根本不下发 + 审计 reason（不占往返、不占 LLM、不假成功）。**fail-open**：registry 查不到/异常 ⇒ 照常
   * 下发（今天行为），绝不静默砍支持平台。like/collect/comment/comment_like/browse_images/scroll_comments 经此。
   */
  private sendNoteScopedCommand(action: NoteScopedAction, command: EdgeCommand): boolean {
    if (this.accountPlatform && !isNoteActionSupported(this.accountPlatform, action)) {
      const reason = noteActionRefusalReason(this.accountPlatform, action) ?? 'unsupported';
      console.log(
        `[RoleDispatcher] note-scoped 动作被平台能力闸拒绝：action=${action} platform=${this.accountPlatform} reason=${reason}（不下发、不占配额）`,
      );
      return false;
    }
    return this.sendCommand(command);
  }

  /**
   * 「已批准未送达」操作员回报（change platform-browse-protocol）：评论迁移 navigate 步失败 ⇒ 评论没发出，
   * 但人审成本已付 ⇒ 显式回报操作员。接线 notifyApprovedNotDelivered 则走飞书出口；缺省仅 warn 日志（阶段 0 不触发）。
   */
  private reportApprovedNotDelivered(noteId: string, reason?: string): void {
    if (this.notifyApprovedNotDelivered) {
      void Promise.resolve(this.notifyApprovedNotDelivered({ noteId, ...(reason ? { reason } : {}) })).catch((err) => {
        console.warn(`[RoleDispatcher] 已批准未送达回报失败：${(err as Error).message}`);
      });
      return;
    }
    console.warn(`[RoleDispatcher] 已批准未送达（未接线操作员回报口，仅日志）note=${noteId} reason=${reason ?? 'nav_failed'}`);
  }

  private mandatoryApprovalTrace(delivery: PendingCommentDelivery): CommentApprovalTrace | null {
    const mandatory = delivery.mandatoryInteraction;
    if (
      mandatory?.commentApproval !== 'auto_approve' ||
      !mandatory.actions.includes('comment') ||
      !delivery.approvalTrace?.requestId
    ) {
      return null;
    }
    return delivery.approvalTrace;
  }

  /**
   * 预授权只是“允许尝试”，不是平台成功。这里以 requestId 幂等地补一张且仅一张终态卡；
   * 通知失败只告警，不反向伪造平台状态，也不重试刷屏。
   */
  private reportMandatoryCommentOutcome(
    delivery: PendingCommentDelivery,
    outcome: MandatoryCommentOutcome,
    reason?: string,
  ): void {
    const trace = this.mandatoryApprovalTrace(delivery);
    if (!trace || this.reportedMandatoryCommentRequests.has(trace.requestId)) return;
    this.reportedMandatoryCommentRequests.add(trace.requestId);
    // dispatcher 可能常驻数月；保留最近一批 requestId 足以挡迟到回执，避免幂等集合无界增长。
    if (this.reportedMandatoryCommentRequests.size > 2_000) {
      const oldest = this.reportedMandatoryCommentRequests.values().next().value;
      if (oldest) this.reportedMandatoryCommentRequests.delete(oldest);
    }
    if (!this.notifyMandatoryCommentOutcome) {
      console.warn(
        `[RoleDispatcher] mandatory 评论终态通知口未接线 requestId=${trace.requestId} outcome=${outcome} reason=${reason ?? '-'}`,
      );
      return;
    }
    try {
      const notification = this.notifyMandatoryCommentOutcome({
        requestId: trace.requestId,
        noteId: delivery.noteId,
        text: delivery.text,
        outcome,
        ...(reason ? { reason } : {}),
        ...(trace.accountId ? { accountId: trace.accountId } : {}),
        ...(trace.accountName ? { accountName: trace.accountName } : {}),
        ...(trace.title ? { title: trace.title } : {}),
        ...(trace.authorName ? { authorName: trace.authorName } : {}),
      });
      void Promise.resolve(notification).catch((err) => {
        console.warn(
          `[RoleDispatcher] mandatory 评论终态通知失败 requestId=${trace.requestId}: ${(err as Error).message}`,
        );
      });
    } catch (err) {
      console.warn(
        `[RoleDispatcher] mandatory 评论终态通知失败 requestId=${trace.requestId}: ${(err as Error).message}`,
      );
    }
  }

  private clearMandatoryCommentOutcomeTimer(): void {
    if (this.mandatoryCommentOutcomeTimer === undefined) return;
    this.clearTimeoutFn(this.mandatoryCommentOutcomeTimer);
    this.mandatoryCommentOutcomeTimer = undefined;
  }

  private armMandatoryCommentOutcomeTimer(delivery: PendingCommentDelivery): void {
    const trace = this.mandatoryApprovalTrace(delivery);
    if (!trace) return;
    this.clearMandatoryCommentOutcomeTimer();
    this.mandatoryCommentOutcomeTimer = this.setTimeoutFn(() => {
      this.mandatoryCommentOutcomeTimer = undefined;
      const pending = this.pendingComment ?? this.pendingMigration;
      if (!pending || this.mandatoryApprovalTrace(pending)?.requestId !== trace.requestId) return;
      this.pendingComment = null;
      this.pendingMigration = null;
      this.reportMandatoryCommentOutcome(pending, 'unknown', 'receipt_timeout');
      this.eventBus.emit('comment.done', {
        noteId: pending.noteId,
        sourcePageType: pending.sourcePageType,
        actions: pending.actions,
        ok: false,
        reason: 'receipt_timeout',
        ...(pending.mandatoryInteraction ? { mandatoryInteraction: pending.mandatoryInteraction } : {}),
        ts: this.clock(),
      });
    }, this.mandatoryCommentOutcomeTimeoutMs);
    (this.mandatoryCommentOutcomeTimer as { unref?: () => void } | undefined)?.unref?.();
  }

  /** 掉线/重启/会话结束时不把“边缘没回执”误报成功；只发 unknown，不再驱动浏览链。 */
  private settlePendingMandatoryCommentAsUnknown(reason: string): void {
    const pending = this.pendingComment ?? this.pendingMigration;
    this.clearMandatoryCommentOutcomeTimer();
    if (pending) this.reportMandatoryCommentOutcome(pending, 'unknown', reason);
    this.pendingComment = null;
    this.pendingMigration = null;
  }

  /** 平台是否支持「浏览多图」（注入给 DeepReader；fail-open：无平台/查表失败 ⇒ true）。 */
  private canBrowseImages(): boolean {
    return !this.accountPlatform || isNoteActionSupported(this.accountPlatform, 'browse_images');
  }

  /** 平台是否支持「滚动评论区」（注入给 CommentReviewer；fail-open）。 */
  private canScrollComments(): boolean {
    return !this.accountPlatform || isNoteActionSupported(this.accountPlatform, 'scroll_comments');
  }

  /** 平台是否支持 feed 刷新（gate FeedScroller 构造；fail-open）。 */
  private canRefresh(): boolean {
    return !this.accountPlatform || isOrchestrationCapabilitySupported(this.accountPlatform, 'feed_refresh');
  }

  /**
   * 平台是否做通知巡视（gate 12 通知巡视角色注册；change platform-orchestration-capability-gates）。
   * 需**同时**支持 notification（有通知面可巡）与 patrol（做巡视外出）；任一不支持 ⇒ 不注册整套巡视子系统。
   * fail-open：无平台 / 查表失败 ⇒ true（=今天注册，绝不因查表失败静默砍小红书巡视）。
   */
  private canPatrol(): boolean {
    if (!this.accountPlatform) return true;
    return (
      isOrchestrationCapabilitySupported(this.accountPlatform, 'notification') &&
      isOrchestrationCapabilitySupported(this.accountPlatform, 'patrol')
    );
  }

  /** 平台是否访作者主页（gate ProfileOpener 注册 + 注入 AuthorEvaluator 抑制 profile.worth_visiting；fail-open）。 */
  private canVisitProfile(): boolean {
    return !this.accountPlatform || isOrchestrationCapabilitySupported(this.accountPlatform, 'profile_visit');
  }

  /** 平台是否关注作者（注入 FollowAgent：不支持则跳过关注、仍产 profile.done 保返回链；fail-open）。 */
  private canFollow(): boolean {
    return !this.accountPlatform || isOrchestrationCapabilitySupported(this.accountPlatform, 'follow');
  }

  /**
   * 版本偏斜闸后的**有效**读 surface（change facebook-feed-inline-browse 灰度接线）。
   * registry 声明 read_content='feed'（就地读）**且本连接边缘声明 inline_targeting**（含 inline reader 的重打包）
   * 才生效；老边端 / 未重打包回落 'detail' ⇒ 永不收到 surface:'feed'、逐位等于今天。
   * 全部控制流（下发 surface / 循环闭合 / 评论迁移触发 / feed no_target 重扫）一律读本方法，**不读**裸
   * resolveReadSurface——使「云端以为 feed、边缘却在 detail」这类不一致结构性不可能发生。
   */
  private effectiveReadSurface(): Surface {
    const declared = resolveReadSurface(this.accountPlatform);
    return declared === 'feed' && !this.hasInlineTargeting() ? 'detail' : declared;
  }

  /**
   * 循环闭合读静态表（change platform-registry-shape）：读完一篇返回列表用 back 还是继续 scroll。
   * 一律读 effectiveReadSurface（版本偏斜后）+ per-note 迁移标志，**绝不读运行时 observedSurface**（消时序竞态）。
   * 小红书 / 阶段 0 FB read=detail（或 feed 但老边端）且迁移不可达 ⇒ 恒 back，零回归。
   */
  private shouldCloseWithScroll(): boolean {
    return (
      loopClosure(
        this.effectiveReadSurface(),
        this.sessionContext.currentNoteMigratedToDetail,
      ) === 'scroll'
    );
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
      quotaLevel: this.getQuotaLevel(),
      progress: this.progress(),
      pacing: this.pacingFloors,
    });
  }

  /**
   * feed/search 翻页的平台保底停留（泛化自旧 facebookScrollDwellMs；平台地板由 registry 的
   * pacing.feedScrollDwellFloorMs 声明，替代裸 platform==='facebook' 分支）。某些平台首屏/滚动后 noteId
   * 因虚拟化或 permalink 水合重复、feed-scroll-card-floor 会算成 0，给一个更接近真人扫屏的保底、避免 2 秒一滚。
   * 未声明地板的平台（如小红书）返回 undefined，走内置默认。
   */
  private feedScrollDwellMs(): number | undefined {
    const floorMs = platformFeedScrollFloorMs(this.accountPlatform);
    if (floorMs === undefined) return undefined;
    const cardFloor = computeFeedFloorMs({
      newCount: 8,
      status: this.getRiskStatus(),
      quotaLevel: this.getQuotaLevel(),
      progress: this.progress(),
      pacing: this.pacingFloors,
    });
    const screenGlanceFloor = Math.round(floorMs * effectiveTempo(this.getRiskStatus(), this.getQuotaLevel()));
    return Math.max(cardFloor, screenGlanceFloor);
  }

  private scrollDwellParams(floorMs: number): Record<string, unknown> | undefined {
    const fbFloor = this.feedScrollDwellMs() ?? 0;
    const dwellMs = Math.max(floorMs, fbFloor);
    return dwellMs > 0 ? { dwellMs } : undefined;
  }

  private sendScrollCommand(reason: string, floorMs = 0): boolean {
    // 翻页也是一次「准备消费下一条内容」：统一在 scroll 出口现问 view 配额。旧路径只在
    // content.valuable/open_note 前检查，导致连续 content.no_valuable（Reels 外语/不匹配最常见）可以绕过
    // view 上限无限滚。已经处于休眠时仍让命令进入 sendCommand，由既有节流日志记录 suppressed 事实。
    if (!this.viewQuotaSleeping) {
      const decision = this.explainView();
      if (!decision.allowed) {
        this.sleepForViewQuota(decision);
        return false;
      }
    }
    const params = this.scrollDwellParams(floorMs);
    return this.sendCommand(params ? { action: 'scroll', reason, params } : { action: 'scroll', reason });
  }

  /**
   * Facebook Feed 已无可继续浏览内容时，由 Cloud 单点授权切到 Reels。
   *
   * `empty_feed_reels_fallback` 是已部署 Edge 认识的兼容握手名：既承载首页明确空态，也承载非空 Feed
   * 确认到底。只有命令真正下发后才置幂等闸；若被软暂停/评论支线等抑制，后续诚实重报仍可重试。
   */
  private authorizeFacebookReelsFallback(source: 'empty_feed' | 'feed_exhausted'): boolean {
    if (this.accountPlatform !== 'facebook' || !this.sessionActive || this.reelsFallbackAuthorized) return false;
    const sent = this.sendCommand({ action: 'scroll', reason: 'empty_feed_reels_fallback' });
    if (!sent) {
      console.log(`[RoleDispatcher] Facebook ${source} → Reels fallback 命令被当前调度闸抑制，保留后续重试资格`);
      return false;
    }
    this.reelsFallbackAuthorized = true;
    console.log(
      source === 'empty_feed'
        ? '[RoleDispatcher] Facebook 首页明确空 Feed → 授权切换 Reels 列表'
        : '[RoleDispatcher] Facebook 普通 Feed 已确认到底 → 授权切换 Reels 列表',
    );
    return true;
  }

  private emitSearchSkippedAfterIntercept(currentPageType: 'feed' | 'search', reason: string): void {
    this.eventBus.emit('search.skipped', { currentPageType, reason, ts: this.clock() });
  }

  /** 设置该连接（运行时）的当前账号（multi-account-node-support D4：去掉 default 钉死，由连接真实账号设入）。 */
  setCurrentAccountId(accountId: string): void {
    this.currentAccountId = accountId;
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

  /** Current single-session budget usage for read-only UI snapshots. */
  sessionUsageSnapshot(): SessionUsageSnapshot {
    const empty: SessionInteractionBudget = {
      likes: 0,
      collects: 0,
      follows: 0,
      searches: 0,
      comments: 0,
      comment_likes: 0,
      join_groups: 0,
    };
    if (!this.sessionActive) {
      return { active: false, totals: empty, quotas: this.freshBudget() };
    }
    return {
      active: true,
      startedAt: this.sessionStartedAt,
      totals: {
        likes: Math.max(0, this.budgetInit.likes - this.budget.likes),
        collects: Math.max(0, this.budgetInit.collects - this.budget.collects),
        follows: Math.max(0, this.budgetInit.follows - this.budget.follows),
        searches: Math.max(0, this.budgetInit.searches - this.budget.searches),
        comments: Math.max(0, this.budgetInit.comments - this.budget.comments),
        comment_likes: Math.max(0, this.budgetInit.comment_likes - this.budget.comment_likes),
        join_groups: Math.max(0, this.budgetInit.join_groups - this.budget.join_groups),
      },
      quotas: { ...this.budgetInit },
    };
  }

  /** 注册所有角色并启动事件订阅 */
  setup(): void {
    // 人设以取值口下发（热加载）：每个 agent 读 this.soul 时按当前账号即时解析，PUT 人设后无需重启。
    // token 用量账号归属（fix llm-token-usage account attribution）：把本连接「当前账号」穿进每次 LLM 调用，
    // 使记账按真实账号归属、不再全记 default。currentAccountId 按连接稳定、调用时现读（并发安全：每连接独立
    // dispatcher，无共享可变态）；调用方已显式给 accountId（如探活）则尊重之。只追加一个字段，绝不改请求体、
    // 不进 LLM 失败路径（记账红线）。
    const accountBoundLlm = {
      complete: (prompt: string, opts?: LlmCallOpts): Promise<string> =>
        this.llm.complete(prompt, { ...opts, accountId: opts?.accountId ?? this.currentAccountId }),
    };
    // 平台词汇 profile（change platform-vocabulary-and-thresholds C3）：按本连接账号平台解析站点名 / 内容名词 /
    // 指标名词，随 commonOptions 注入所有浏览闭环角色（缺该字段的角色因 spread 豁免 excess-check、天然忽略）。
    // 浏览闭环角色据此去「小红书 / 笔记 / 收藏」硬编码；缺省（无平台）回落小红书 profile = 今天。
    const commonOptions = {
      eventBus: this.eventBus,
      getSoul: () => this.resolveSoul(),
      llm: accountBoundLlm,
      platformProfile: commentProfileForPlatform(this.accountPlatform),
    };
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
      // feed_refresh 能力闸（fail-open）：仅平台**显式**声明不支持刷新时禁用 FeedScroller 的刷新支线
      //（enabled:false）；支持 / 查表失败 ⇒ 不传 config，沿用 FeedScroller 的 env 默认（不覆盖 kill-switch）。
      new FeedScroller(commonOptions, this.sessionContext, this.canRefresh() ? undefined : { enabled: false }),
      new NoteOpener(commonOptions, this.sessionContext),
      new BackToFeed(commonOptions, this.sessionContext),
      new DeepReader({ ...commonOptions, getNoteData, canBrowseImages: () => this.canBrowseImages() }),
      new CommentReviewer({
        ...commonOptions,
        sessionContext: this.sessionContext,
        getNoteData,
        canScrollComments: () => this.canScrollComments(),
      }),
      new ContentCuratorRole({ ...commonOptions, sessionContext: this.sessionContext }),
      new InteractionAppraiserRole({
        ...commonOptions,
        sessionContext: this.sessionContext,
        getNoteData,
        getRemainingBudget,
        getMinSaveLikeRatio: () => this.collectMinSaveLikeRatio(),
        isInteractionEligible: (noteId) => this.facebookNaturalInteractionEligibility(noteId),
        isInteractionHandledExternally: (noteId) => this.facebookPresentedVideoLikeDecisionNoteIds.has(facebookPostKey(noteId)),
      }),
      // AuthorEvaluator 恒注册（它是「评论结算 → 返回 feed」的桥，emit profile.skipped 触发 BackToFeed，非纯主页角色）。
      // 注入 canVisitProfile：平台不访主页时它只产 profile.skipped、绝不产 profile.worth_visiting ⇒ 主页子链结构不触发，
      // 桥保留（零 loop 停摆）。change platform-orchestration-capability-gates。
      new AuthorEvaluator({ ...commonOptions, sessionContext: this.sessionContext, getNoteData, canVisitProfile: () => this.canVisitProfile() }),
      // —— 发评论支线（接在互动完成与「是否进主页评估」之间）：评估→撰写→去AI味→循环内人审 ——
      new CommentAppraiser({
        ...commonOptions,
        llmTimeoutMs: this.commentLlmTimeoutMs,
        getNoteData,
        getRemainingComments: () => this.budget.comments,
        ...(this.getCommentDailyRemaining ? { getDailyRemaining: this.getCommentDailyRemaining } : {}),
        // 评论冷却前置到评估阶段（engagement-restraint）：按当前账号查冷却闸（无 gate 时恒放行）。
        getCommentCooldownOk: () => this.cooldownPasses('comment'),
        // mandatory 评论仍跳过普通策略门，但在生成正文/发预授权卡之前先读最终风控同源解释。
        getMandatoryRiskDecision: () => this.explainInteract('comment'),
        isCommentSublineExpired: (noteId) => this.isCommentSublineExpired(noteId),
      }),
      new CommentComposer({
        ...commonOptions,
        llmTimeoutMs: this.commentLlmTimeoutMs,
        getNoteData,
        ...(this.getCorpusReferences ? { getCorpusReferences: this.getCorpusReferences } : {}),
        ...(this.commentCorpusLookupTimeoutMs !== undefined
          ? { corpusLookupTimeoutMs: this.commentCorpusLookupTimeoutMs }
          : {}),
        isCommentSublineExpired: (noteId) => this.isCommentSublineExpired(noteId),
        setTimeoutFn: this.setTimeoutFn,
        clearTimeoutFn: this.clearTimeoutFn,
      }),
      new CommentDeAiFlavor({
        ...commonOptions,
        llmTimeoutMs: this.commentLlmTimeoutMs,
        isCommentSublineExpired: (noteId) => this.isCommentSublineExpired(noteId),
      }),
      new CommentApprovalGate({
        ...commonOptions,
        ...(this.commentApproval ? { approval: this.commentApproval } : {}),
        ...(this.commentAutoApproveNotify ? { autoApproveNotify: this.commentAutoApproveNotify } : {}),
        getAccountId: () => this.currentAccountId,
        getAccountName: () => this.getNickname(this.currentAccountId),
        getNoteTitle: (id) => getNoteData(id)?.title ?? null,
        getNoteAuthor: (id) => getNoteData(id)?.author ?? null,
        now: this.clock,
        isCommentSublineExpired: (noteId) => this.isCommentSublineExpired(noteId),
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
      // ProfileOpener 只订 profile.worth_visiting（本人昵称采集走独立的 profile_open{direct}、不经此角色）⇒ 平台不访主页时
      // 安全不注册（AuthorEvaluator 已抑制 worth_visiting，本就永不触发）。change platform-orchestration-capability-gates。
      ...(this.canVisitProfile() ? [new ProfileOpener(commonOptions)] : []),
      // ProfileBrowser 恒注册（无害）：它处理作者主页的 profile.detail.arrived；FB 经 canVisitProfile 结构不访作者主页
      // ⇒ 对 FB 实为惰性。本人昵称采集不经此角色（另由永久接线的 NicknameEnricher 消费，ProfileBrowser 对本人 early-return）。
      new ProfileBrowser(commonOptions),
      // FollowAgent 恒注册（其 profile.done 是主页子链的返回信号，缺席会断返回链）；注入 canFollow：平台不关注时
      // 跳过关注动作、仍产 profile.done 保返回链。FB 因主页子链结构不触发，实为惰性；小红书正常关注。
      new FollowAgent({ ...commonOptions, sessionContext: this.sessionContext, getRemainingFollows: () => this.budget.follows, getMinFansRatio: () => this.followMinFansRatio(), canFollow: () => this.canFollow() }),
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
        // 「可活跃时间」周历闸（change weekly-active-window）：会话进行中现读，跨入非活跃时段则结束会话（热加载）。
        getActiveWindowOpen: () => this.isWithinActiveWeek(this.clock()),
        // 看门狗两段阈值按账号现读（热加载）；未注入续场提供者 → 回落写死默认（轻推~2min / 放弃 1h）。
        getIdleNudgeMs: () => this.resumeConfigProvider?.idleNudgeMs() ?? DEFAULT_IDLE_NUDGE_MS,
        getIdleEndMs: () => this.resumeConfigProvider?.idleEndMs() ?? DEFAULT_IDLE_END_MS,
        clock: this.clock,
      }),
      // —— 通知巡视（消息查看）12 角色：检测→准入→暂停→开首页→分诊→按类浏览→分类→去重→发飞书→返回→恢复 ——
      // 整套子系统由 NotificationGatekeeper 收 notification.detected 唯一触发（excursion.requested 亦仅它 emit）；
      // 平台无通知面（如 Facebook 不上报 notification.detected）时全套惰性。C4：canPatrol()（notification && patrol）
      // 不支持则整套不注册（fail-open：无平台/查表失败仍注册=今天，绝不静默砍小红书巡视）。
      ...(this.canPatrol()
        ? [
            new NotificationGatekeeper({ ...commonOptions, isHardPaused: this.isHardPaused, isCommentInflight: () => this.commentInflight }, this.sessionContext),
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
          ]
        : []),
    ];

    // 概念抽取角色：仅在概念池可用时注册（PG 不可用则不抽取，搜索退化为仅 seed_keywords）。
    if (this.conceptStore) {
      const sink = this.conceptStore;
      this.roles.push(new ConceptExtractorRole({ ...commonOptions, conceptStore: sink }));
    }

    // 精选准入「两段式」模型评估角色（change curated-admission-eval-roles，Phase 3）：
    // 仅在精选库可用时注册（仿 concept_extractor）。第一段共鸣预筛在角色内零 LLM 短路、第二段读全文 LLM 评估。
    // 评估总开关 AIDCP_CURATED_LLM_EVAL 缺省开；置 'false' 回退「仅共鸣」（等价 Phase 2b 行为）。
    if (this.curatedStore) {
      const store = this.curatedStore;
      const llmEvalEnabled = process.env.AIDCP_CURATED_LLM_EVAL !== 'false';
      this.roles.push(
        new CuratedNoteEvaluator({
          ...commonOptions,
          curatedStore: store,
          getAccountId: () => this.currentAccountId,
          llmEvalEnabled,
          ...(this.textCardTranscriber ? { textCardTranscriber: this.textCardTranscriber } : {}),
        }),
      );
      // 评论评估角色仅在评论赞链路开启时注册——其源事件 comment_like.confirmed 仅该链路产出。
      if (commentLikeEnabled) {
        this.roles.push(
          new CuratedCommentEvaluator({
            ...commonOptions,
            curatedStore: store,
            getNoteData,
            getAccountId: () => this.currentAccountId,
            llmEvalEnabled,
          }),
        );
      }
    }

    // 引流线索自动触发（change feed-hot-lead-auto-group-comment）：接稿件价值判定之后（订阅 quality.pass + note.detail.arrived）。
    // 纯确定性、不调 LLM；仅在 fireAutoContactComment 注入时注册。账号未开自动联系评论 → 仅记日志、不发（零回归）。
    if (this.fireAutoContactComment) {
      this.roles.push(
        new HotLeadDetector({
          ...commonOptions,
          getAccountId: () => this.currentAccountId,
          fireAutoContactComment: this.fireAutoContactComment,
          getSessionCommentBudgetRemaining: () => this.budget?.comments ?? Number.POSITIVE_INFINITY,
          consumeSessionCommentBudget: () => {
            if (this.budget && this.budget.comments > 0) this.budget.comments -= 1;
          },
          ...(this.hotLeadGateConfig ? { getGateConfig: this.hotLeadGateConfig } : {}),
          ...(this.isAutoContactEnabled ? { isAutoContactEnabled: this.isAutoContactEnabled } : {}),
          ...(this.hasCommentedForLead ? { hasCommented: this.hasCommentedForLead } : {}),
        }),
      );
    }

    // 捕获 SessionMonitor 引用：供 excursion（巡视）起止 → 暂停/恢复其时钟（唯一实例）。
    this.sessionMonitor = this.roles.find((r) => r instanceof SessionMonitorRole) as
      | SessionMonitorRole
      | undefined;

    // 登录账号真实昵称采集：只由完整浏览器启动后的首批 page.cards{startupId} 触发。
    // hello / reconnect / session_start 都不再武装采集，避免冷待机云端恢复反复打断浏览器。
    // 采集体 + 其本人主页命令出口永久接线；真正采集由 startupId 去重和平台闸控制。
    // 平台闸（change facebook-nickname-capture-timing）：时机统一到「首个 feed 卡片」这套、放宽到 XHS + Facebook；
    // 读法按平台分叉——XHS 进本人主页读、Facebook 就地读（边端对 profile_open{direct} 就地读身份、不导航）。
    // 未知平台仍 fail-open 放行（与既有语义一致）。
    this.nicknameEnricher = new NicknameEnricher({
      ...commonOptions,
      sessionContext: this.sessionContext,
      getAccountId: () => this.currentAccountId,
      isCaptureEligible: () =>
        this.isDispatchActive() &&
        (!this.accountPlatform ||
          this.accountPlatform === 'xiaohongshu' ||
          this.accountPlatform === 'facebook'),
      getNickname: this.getNickname,
      ...(this.setNickname ? { setNickname: this.setNickname } : {}),
      setTimeoutFn: this.setTimeoutFn,
      clearTimeoutFn: this.clearTimeoutFn,
    });
    this.nicknameEnricher.subscribe();
    // 本人主页采集命令出口（云端内部事件 → profile_open{direct:true}）：永久接线（采集不依赖浏览会话）。
    // **不复用** profile.entered（它会把自己拖进浏览管线）；direct=true 让边端直驱 /user/profile/<accountId>、纯执行；
    // 授信经 selfCaptureInFlight 在 chokepoint 放行（见 sendCommand）。
    this.eventBus.on('self.profile.capture', (payload) => {
      this.sendCommand({ action: 'profile_open', params: { authorId: payload.accountId, direct: true, thinkMs: this.thinkNow() } });
    });

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
    this.currentEdgeId = payload.edgeId;
    if (payload.accountId) this.currentAccountId = payload.accountId;
    if (this.canStartSession()) {
      this.restartSession();
      return;
    }
  }

  /**
   * 会话启动闸（诚实人设 + 全局调度开关）。retire-default-account：所有账号一视同仁，无 default 豁免。
   * 临时 view 配额耗尽不在这里拒签；它在 open_note 前进入浏览休眠，窗口释放后自动重驱。
   * 未绑人设的账号：发 onSessionRejected（置 needs_persona_setup + 告警）并短路，绝不以默认人设静默开跑。
   * 人设存储读不到时 isPersonaBound 返回 false（fail-closed）→ 一并诚实拒绝。
   */
  private canStartSession(): boolean {
    const verdict = this.sessionStartVerdict();
    if (verdict === 'ok') return true;
    // facebook-scheduled-comment 2.8：平台不具备 browse 能力（如 Facebook v1 只声明 'comment'）→ 诚实拒绝启动
    // xhs 浏览角色循环。判在人设闸之前，避免 FB 账号被误判 needs_persona_setup。不复用 onSessionRejected
    //（那会硬编码按「未绑人设」拒绝并误报）；FB 账号不浏览是正常预期、非事故，只 console.warn。
    if (verdict === 'platform_no_browse') {
      console.warn(
        `[RoleDispatcher] 账号 ${this.currentAccountId} 平台=${this.accountPlatform} 无 browse 能力 → 拒绝启动浏览会话（platform_no_browse）：不挂 xhs 浏览循环、不起看门狗`,
      );
      return false;
    }
    if (verdict === 'needs_persona_setup') {
      console.warn(
        `[RoleDispatcher] 账号 ${this.currentAccountId} 未绑定人设 → 拒绝启动浏览会话（needs_persona_setup）：不开循环、不发巡刷信号`,
      );
      void this.onSessionRejected?.(this.currentAccountId, 'needs_persona_setup');
      return false;
    }
    return false; // dispatch_inactive：调度开关关着，静默即可（既有行为，无告警）
  }

  /**
   * 会话启动闸的**纯判定**——不打日志、不发回调（change standby-captcha-must-not-yield）。
   *
   * 拆出来是因为 `resumeGateSnapshot()` 是**只读**裁决，却被 `ui.snapshot` 那条约 60s 的周期链每跳调用一次。
   * 它若直接复用带副作用的 `canStartSession()`，未绑人设 / 无 browse 能力的账号就会**每分钟**刷一行告警、并
   * **每分钟触发一次「会话被拒」回调**——一个只读方法不该有这种脉冲。
   */
  private sessionStartVerdict(): 'ok' | 'dispatch_inactive' | 'platform_no_browse' | 'needs_persona_setup' {
    if (!this.isDispatchActive()) return 'dispatch_inactive';
    if (this.accountPlatform && !isOrchestrationCapabilitySupported(this.accountPlatform, 'browse')) {
      return 'platform_no_browse';
    }
    if (this.isPersonaBound && !this.isPersonaBound(this.currentAccountId)) return 'needs_persona_setup';
    return 'ok';
  }

  /** 外部触发会话启动（经启动闸）：供面板恢复调度 / 显式启动用；已在跑则不重复。 */
  tryStartSession(): void {
    if (this.sessionActive) return;
    if (!this.canStartSession()) return;
    this.restartSession();
  }

  /**
   * 后台为本账号绑定人设后，由连接注册表按账号调用（change auto-start-on-persona-bind）：
   * 若本连接此前因未绑人设被启动闸短路（未在跑）、现重判可启动，则就地开会话——与边缘重连(onHelloEvent)
   * 等价，过同一启动闸（canStartSession=调度开关+人设；不受续场的活跃时段/每日上限约束），绝不以默认人设静默开跑。
   * 关键：被闸住的边端已发过一次 page.cards 在干等命令，restartSession 的 feed.entered{session_start} 是
   * 哑事件、不产首命令；故起会话后补一条滚动唤醒它重报 page.cards → 评估 → 浏览循环秒级续上（复用
   * doAutoResume 同款 scroll→page.scroll 重驱，不新增协议；省去 idle 看门狗 ~2min 兜底）。
   * 顶部 active 守卫：对已在跑的会话是 no-op、绝不打断、绝不多发重驱滚动。
   */
  startOnPersonaBound(): void {
    if (this.sessionActive) return; // 已在跑 → 不打断、不重驱
    this.tryStartSession(); // 过启动闸（人设此刻已绑 → 放行）
    if (this.sessionActive) this.sendScrollCommand('resume_redrive');
  }

  /**
   * 单次浏览会话的初始互动预算：从全局单场上限提供者读（热加载，对所有账号生效），缺省回落写死默认。
   * 返回新拷贝（live budget 会被逐项扣减）。供初始化与会话重置复用，避免口径漂移。
   */
  private freshBudget(): SessionInteractionBudget {
    return this.sessionLimitProvider?.sessionBudget() ?? defaultSessionBudget();
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
    // 会话开始 → 取消任何待发休息计时器 + 窗口唤醒计时器（已重开，无需续场 / 唤醒）。
    this.cancelRestTimer();
    this.cancelWakeTimer();
    this.cancelViewQuotaSleep(false);
    this.settlePendingMandatoryCommentAsUnknown('session_restarted');
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
    this.clearFacebookNaturalInteractionEvidence();
    this.reelsFallbackAuthorized = false;
    // 跨会话残留清理（change platform-browse-protocol）：迁移在途 / 审批在途标志不得跨会话粘连。
    this.clearCommentSublineHold(false);
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
    // 「可活跃时间」闸（change weekly-active-window）：当前本地时刻不在后台配置的可活跃时段内 → 不开会话、保持休眠。
    // 此处为所有会话(重)启动的统一收口（边缘 hello / 绑人设自启 / 续场 / 面板手动），缺配置 / 非法掩码 = 全天活跃（零回归）。
    // 续场路径已先经 canAutoResume 同闸（此为防御性二次拦）。被拦后排一个窗口唤醒计时器：到下一个活跃整点
    // 主动续上（窗口唤醒增强），不再干等边端重连。
    if (!this.isWithinActiveWeek(this.clock())) {
      console.log('[RoleDispatcher] 当前不在可活跃时段（可活跃时间闸）→ 不启动浏览会话，保持休眠');
      this.armWakeTimerIfWindowed(this.currentAccountId);
      return;
    }
    // 会话重开 → 取消待发休息计时器 + 窗口唤醒计时器（边缘先自连重连即走此路，竞态由此化解）。
    this.cancelRestTimer();
    this.cancelWakeTimer();
    this.cancelViewQuotaSleep(false);
    this.settlePendingMandatoryCommentAsUnknown('session_restarted');
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
    // 清在途互动状态（change fix-interaction-and-comment-capture）：新场从干净的重试/去重态开始。
    this.interactionRetry.clear();
    this.pendingInteractionKeys.clear();
    // 跨会话残留清理（change platform-browse-protocol）：迁移在途 / 审批在途标志不得跨会话粘连。
    // **生产的会话(重)启动统一走 restartSession**（edge hello / 绑人设自启 / 续场 / 面板），startSession 仅测试用——
    // 故此处的清理才是生产实际生效的那一份（红线修复：防审批标志卡死跨会话粘连、迁移在途被后续 open_note 误消费）。
    this.clearCommentSublineHold(false);
    this.clearFacebookNaturalInteractionEvidence();
    this.reelsFallbackAuthorized = false;
    // 重新订阅角色与接线（SessionMonitor.subscribe 重置 startedAt/actionCount）
    this.roles.forEach((r) => r.subscribe());
    this.setupCommandTranslation();
    this.setupEdgeEventSubscriptions();
    this.sessionActive = true;
    this.sessionStartedAt = this.clock();
    // 会话启动现问一次 view 配额（change session-start-quota-honest-sleep）：被拒即当场休眠。
    // 🔴 为什么在 feed.entered 之前：EventBus 进程内同步派发，下游角色链可能在这次 emit 内同步走到
    //    sendCommand ⇒ 刹车装在 emit 之后 = 首批命令从休眠闸底下漏出，且间歇、测试可全绿（同族判例：
    //    点赞闸集合同步 emit 顺序竞态）。故刹车必须先于 emit 踩死。
    // 🔴 为什么不区分窗口 / 不拒签会话：minute/hour 被拒睡 60s 后自动重驱（净行为同今日、只是提前），
    //    day 被拒睡到明天；会话照开、只踩刹车，守既有反向不变量（配额满 MUST 休眠、MUST NOT session.end）。
    // 上面 :1556 的 cancelViewQuotaSleep(false) 已先清掉同连接重启路径的陈旧标记；此处按最新事实重装。
    const startupViewDecision = this.explainView();
    if (!startupViewDecision.allowed) {
      this.sleepForViewQuota(startupViewDecision);
    }
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
    // 不论是否活跃，先取消任何待发休息计时器 + 窗口唤醒计时器（运营 stop / 掉线 / 发布让位都不该残留续场；
    // 「可活跃时间」结束的正常路径会经 armRestTimer→续场拒签 重排唤醒，故此处清掉是安全的）。
    this.cancelRestTimer();
    this.cancelWakeTimer();
    this.cancelViewQuotaSleep(false);
    this.settlePendingMandatoryCommentAsUnknown(`session_ended:${reason ?? 'manual'}`);
    this.clearCommentSublineHold(false);
    void this.endNotificationTask();
    if (!this.sessionActive) return;
    const account = this.currentAccountId;
    // 记当日累计浏览时长（含 excursion，仅供每日上限近似）。
    const elapsed = this.clock() - this.sessionStartedAt;
    if (elapsed > 0) this.dailyTally(account, this.clock()).browseMs += elapsed;
    this.sessionActive = false;
    this.roles.forEach((r) => r.unsubscribe());
    for (const unsub of this.commandUnsubscribers) unsub();
    this.commandUnsubscribers = [];
    // 清在途互动状态（change fix-interaction-and-comment-capture）：防上一场极晚到的回执驱动新场重发/误扣。
    this.interactionRetry.clear();
    this.pendingInteractionKeys.clear();
    this.clearFacebookNaturalInteractionEvidence();
    this.reelsFallbackAuthorized = false;
    console.log(`[RoleDispatcher] 会话结束: ${reason ?? 'manual'}`);
    // 仅「正常结束」且续场特性已开（注入提供者）才安排休息+续场。
    if (opts?.autoResumeEligible) this.armRestTimer(account, this.takePendingAutoResumeInMs());
    else this.pendingAutoResumeInMs = undefined;
  }

  private sleepForViewQuota(decision: ViewQuotaDecision): void {
    if (this.viewQuotaSleeping) return;
    const delay = this.viewQuotaSleepDelay(decision);
    this.viewQuotaSleeping = true;
    this.viewQuotaSuppressedCount = 0; // 新一轮休眠：抑制计数归零，节流键随之重置
    this.sessionMonitor?.pauseClock('view_quota');
    console.log(
      `[RoleDispatcher] view 配额暂不可用 → 休眠浏览 ${Math.ceil(delay / 1000)}s（account=${this.currentAccountId}, reason=${decision.reason ?? 'unknown'}）`,
    );
    const account = this.currentAccountId;
    this.viewQuotaSleepTimer = this.setTimeoutFn(() => {
      this.viewQuotaSleepTimer = undefined;
      this.onViewQuotaSleepElapsed(account);
    }, delay);
    (this.viewQuotaSleepTimer as { unref?: () => void } | undefined)?.unref?.();
  }

  private viewQuotaSleepDelay(decision: ViewQuotaDecision): number {
    const retryAfterMs =
      typeof decision.retryAfterMs === 'number' && Number.isFinite(decision.retryAfterMs)
        ? decision.retryAfterMs
        : VIEW_QUOTA_RECHECK_FALLBACK_MS;
    return Math.max(1_000, Math.round(retryAfterMs + VIEW_QUOTA_WAKE_GRACE_MS));
  }

  private onViewQuotaSleepElapsed(account: string): void {
    if (this.currentAccountId !== account) {
      this.clearViewQuotaSleep(false);
      return;
    }
    const decision = this.explainView();
    if (!decision.allowed) {
      this.viewQuotaSleeping = false;
      this.sleepForViewQuota(decision);
      return;
    }
    this.clearViewQuotaSleep(true);
    console.log(`[RoleDispatcher] view 配额已恢复 → 重驱浏览（account=${this.currentAccountId}）`);
    if (this.sessionActive) this.sendScrollCommand('resume_after_view_quota');
  }

  private cancelViewQuotaSleep(resumeClock: boolean): void {
    if (this.viewQuotaSleepTimer !== undefined) {
      this.clearTimeoutFn(this.viewQuotaSleepTimer);
      this.viewQuotaSleepTimer = undefined;
    }
    this.clearViewQuotaSleep(resumeClock);
  }

  private clearViewQuotaSleep(resumeClock: boolean): void {
    const wasSleeping = this.viewQuotaSleeping;
    this.viewQuotaSleeping = false;
    if (resumeClock && wasSleeping) this.sessionMonitor?.resumeClock('view_quota');
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

  private cancelWakeTimer(): void {
    if (this.wakeTimer !== undefined) {
      this.clearTimeoutFn(this.wakeTimer);
      this.wakeTimer = undefined;
    }
  }

  /**
   * 「可活跃时间」窗口唤醒（change weekly-active-window 增强）：当前处于休眠格时，算出下一个活跃整点、
   * 到点主动起一场会话续上，不再干等边端重连 / 下一次 hello。
   * 不安排的情形（msUntilNextActive 返回 null）：全天活跃 / 当前已活跃 / 整周全休眠（运营显式关停）。
   * 与续场同一特性闸：未注入续场提供者（续场关）→ 不主动唤醒，保持零回归。每连接私有、unref。
   * 抖动至多 1min：避免整点多连接齐发（防关联 + 拟人），落点仍在窗口内。
   */
  private armWakeTimerIfWindowed(account: string): void {
    this.cancelWakeTimer();
    if (!this.resumeConfigProvider) return; // 续场特性关 → 不主动唤醒（零回归）
    const mask = this.sessionLimitProvider?.weekActiveMask() ?? null;
    const ms = msUntilNextActive(mask, this.clock());
    if (ms == null) return; // 无需唤醒
    const jitter = Math.floor(this.randomFn() * 60_000);
    this.wakeTimer = this.setTimeoutFn(() => {
      this.wakeTimer = undefined;
      this.onWakeElapsed(account);
    }, ms + jitter);
    (this.wakeTimer as { unref?: () => void } | undefined)?.unref?.();
  }

  /** 窗口唤醒到点：账号已切换 / 已在跑 → 放弃；否则过续场各闸（窗口此刻已开）→ 起会话 + 重驱边端。 */
  private onWakeElapsed(account: string): void {
    if (this.currentAccountId !== account) return; // 重连到别的账号
    if (this.sessionActive) return; // 已在跑（边端可能已自连重开）
    this.doAutoResume(account); // 窗口已开 → canAutoResume 放行 → 起会话 + scroll 重驱
  }

  /** 安排休息计时器。未注入续场提供者 → 特性关、保持旧行为（不续）。 */
  private armRestTimer(account: string, plannedRestMs?: number): void {
    this.cancelRestTimer();
    if (!this.resumeConfigProvider) return; // 特性未开 → 不续（零回归）。
    const restMs = plannedRestMs ?? this.computeAutoResumeInMs();
    if (restMs === undefined) return;
    this.restTimer = this.setTimeoutFn(() => {
      this.restTimer = undefined;
      this.onRestElapsed(account);
    }, restMs);
    (this.restTimer as { unref?: () => void } | undefined)?.unref?.();
  }

  private computeAutoResumeInMs(): number | undefined {
    if (!this.resumeConfigProvider) return undefined;
    const ratio = this.resumeConfigProvider.restRatio();
    const base = this.maxDurationMs() * ratio; // 单场时长全局；休息 = 时长 × 全局休息比例
    return Math.max(0, Math.round(base * this.restJitter()));
  }

  private takePendingAutoResumeInMs(): number | undefined {
    const ms = this.pendingAutoResumeInMs;
    this.pendingAutoResumeInMs = undefined;
    return ms;
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
    if (!this.canAutoResume(account)) {
      // 护栏不过：诚实不续。若因「可活跃时间」窗口外被拦 → 排到下一个窗口开启时主动唤醒续上
      // （armWakeTimerIfWindowed 在「全天活跃 / 当前已活跃 / 全休眠」时自动 no-op，故非窗口原因被拦不会误排）。
      this.armWakeTimerIfWindowed(account);
      return;
    }
    this.dailyTally(account, this.clock()).sessions += 1;
    this.tryStartSession();
    // 续场重开后主动重驱边端（change restore-auto-resume A②）：边端浏览循环在 session.end 后已停、
    // 不会自发重报 page.cards，故下发一次滚动唤醒（复用既有 scroll→page.scroll 通道，不新增协议；
    // 边端循环已停时据此重启）。仅续场路径发：fresh start 边端自驱、且本人昵称采集期 browseSuspended
    // 会经 sendCommand 软暂停闸自动扣住此滚动，二者不相扰。idle 看门狗的 nudge 仍作 ~2min 兜底。
    if (this.sessionActive) this.sendScrollCommand('resume_redrive');
  }

  /** 续场闸：调度开关 + 人设（canStartSession）+ 风控状态 + 活跃时段窗口 + 每日上限。 */
  private canAutoResume(account: string): boolean {
    // announce=true：这是**真的在尝试续场**，未绑人设时必须照旧发出「需要设置人设」信号（既有行为，不可静默）。
    return !this.resumeGate(account, this.clock(), true).blocked;
  }

  /**
   * 续场闸的**结构化裁决**（change standby-covers-idle-waits）：与 canAutoResume 同一套判据，多回「为什么停」
   * 与「何时恢复」。`canAutoResume` 已改为基于本方法实现，**两套判据在结构上不可能漂移**。
   *
   * 这是「停工」与「让出浏览器槽位」两套判断接上线的那根线：过去只有风控配额耗尽会让边缘关浏览器，
   * 而排期外 / 时长满 / 冻结这几类停工完全不产出待机提示——账号安静下来了，浏览器却一直开着占 700MB。
   *
   * `resumeAt` 缺省 = **算不出恢复时刻**（当前有二：风控 restricted/frozen——全仓无人调用自动恢复、唯一出口是
   * 运营手动；周历整周全关——运营显式停号）。调用方 MUST NOT 据此伪造一个恢复时刻，见 browser-standby.ts 的
   * 「回访」语义。
   *
   * `not_ready`（调度未开 / 人设未绑 / 无续场配置提供者）**不是「没活干」**，而是「还没准备好」——它 MUST NOT
   * 产出待机提示（人设绑定等动作可能要用到浏览器）。
   */
  private resumeGate(account: string, now: number, announce: boolean): ResumeGateVerdict {
    // announce 区分两类调用方（change standby-captcha-must-not-yield）：
    //  - 真的在尝试续场（canAutoResume）→ true：未绑人设时照旧告警 + 发「需要设置人设」信号，行为零变化。
    //  - 只读裁决（resumeGateSnapshot，被 ~60s 周期链每跳调用）→ false：**绝不能**每分钟刷一行告警、
    //    更不能每分钟触发一次「会话被拒」回调。一个只读方法不该有这种脉冲。
    const ready = announce ? this.canStartSession() : this.sessionStartVerdict() === 'ok';
    if (!ready) return { blocked: true, reason: 'not_ready' };
    const weekMask = this.sessionLimitProvider?.weekActiveMask() ?? null;
    if (!isWeekActiveAt(weekMask, new Date(now))) {
      // 「可活跃时间」周历闸（全局，change weekly-active-window）。整周全关 → msUntilNextActive 回 null（无恢复时刻）。
      const ms = msUntilNextActive(weekMask, now);
      return typeof ms === 'number'
        ? { blocked: true, reason: 'week', resumeAt: now + ms }
        : { blocked: true, reason: 'week' };
    }
    const risk = this.getRiskStatus();
    // 撞风控不续。无恢复时刻：状态机虽有恢复常量与 recoverIfEligible，但全仓无人调用、也从不发恢复信号。
    if (risk === 'restricted' || risk === 'frozen') return { blocked: true, reason: 'risk_state' };
    if (!this.resumeConfigProvider) return { blocked: true, reason: 'not_ready' }; // 无提供者 = 特性关
    const win = this.resumeConfigProvider.activeWindow();
    if (!isWithinActiveWindow(this.minuteOfDay(now), win)) {
      // 过活跃时段窗口（全局，旧每日窗口）。
      const at = nextActiveWindowStartAt(now, win);
      return typeof at === 'number'
        ? { blocked: true, reason: 'active_window', resumeAt: at }
        : { blocked: true, reason: 'active_window' };
    }
    const caps = this.resumeConfigProvider.dailyCaps(); // 阈值全局；计数 dailyTally 仍按账号按日
    const tally = this.dailyTally(account, now);
    // 每日额度按 localDayKey（**服务器本地**日界）重置 → 恢复时刻只能用 nextLocalDayStartAt，绝不能用上海日界。
    if (caps.maxSessions > 0 && tally.sessions >= caps.maxSessions) {
      return { blocked: true, reason: 'daily_sessions', resumeAt: nextLocalDayStartAt(now) };
    }
    // 每日在线时长（§4.2）：全局阈值优先；全局未设(0)时 FB 账号回落非零安全日窗（养号「每天在线 0.5-6h」）。
    const maxMinutes = effectiveDailyMaxMinutes(caps.maxMinutes, this.accountPlatform, this.facebookDailyOnlineMinutes);
    if (maxMinutes > 0 && tally.browseMs >= maxMinutes * 60_000) {
      return { blocked: true, reason: 'daily_minutes', resumeAt: nextLocalDayStartAt(now) };
    }
    return { blocked: false };
  }

  /** 公开只读裁决（供云端产出浏览器冷待机提示）。只读、无副作用（dailyTally 的换日重置除外，与既有闸同源）。 */
  resumeGateSnapshot(now: number = this.clock()): ResumeGateVerdict {
    return this.resumeGate(this.currentAccountId, now, false);
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

  /**
   * 「可活跃时间」闸（change weekly-active-window）：判当前本地时刻是否落在后台配置的可活跃周历时段内。
   * 缺单场上限提供者 / 未配置 / 掩码非法 → 视作全天活跃（零回归、不设闸）。掩码 7×24 格，周一起头，按服务器本地时间。
   */
  private isWithinActiveWeek(now: number): boolean {
    return isWeekActiveAt(this.sessionLimitProvider?.weekActiveMask() ?? null, new Date(now));
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

  private clearFacebookNaturalInteractionEvidence(): void {
    this.facebookContentSelectedNoteIds.clear();
    this.facebookQualityPassedNoteIds.clear();
    this.facebookPresentedVideoLikeDecisionNoteIds.clear();
  }

  /**
   * Facebook 当前呈现视频立即做一次普通点赞决策；Feed 额外要求唯一视频、规范身份和安全摘要。
   * 固定概率只选择意图：所有既有预算/风控/冷却/去重/回执闸保持原样，绝不把命中写成成功。
   */
  private maybeDispatchFacebookPresentedVideoLike(
    cards: PageCardsData[],
    listKind: 'feed' | 'reels' | undefined,
  ): void {
    if (this.accountPlatform !== 'facebook') return;
    let card: PageCardsData | undefined;
    let source: 'reels' | 'feed_video';
    if (listKind === 'reels' && cards.length === 1) {
      card = cards[0];
      source = 'reels';
      if (!isCanonicalFacebookReelNoteId(card?.noteId)) {
        console.log(`[interaction_appraiser] skip reason=facebook_reel_invalid_target action=like note=${card?.noteId ?? ''}`);
        return;
      }
    } else if (listKind === 'feed') {
      const videos = cards.filter((candidate) => candidate.isVideo === true);
      if (videos.length !== 1) return;
      card = videos[0];
      source = 'feed_video';
      if (!isCanonicalFacebookFeedVideoNoteId(card.noteId)) {
        console.log(`[interaction_appraiser] skip reason=facebook_feed_video_invalid_target action=like note=${card.noteId ?? ''}`);
        return;
      }
    } else {
      return;
    }
    if (!card) return;
    const noteId = card.noteId!;
    const key = facebookPostKey(noteId);
    if (this.facebookPresentedVideoLikeDecisionNoteIds.has(key)) {
      console.log(`[interaction_appraiser] skip reason=facebook_presented_video_duplicate_decision action=like source=${source} note=${noteId}`);
      return;
    }
    // 必须先占决策坑：任何后续预算/风控/冷却/下发失败都不能靠重报重新掷骰。
    this.facebookPresentedVideoLikeDecisionNoteIds.add(key);
    if (source === 'feed_video') {
      const caption = card.title.trim();
      if (!caption) {
        console.log(`[interaction_appraiser] skip reason=facebook_feed_video_missing_caption action=like note=${noteId}`);
        return;
      }
      if (hasObviousHighRiskFacebookCaption(caption)) {
        console.log(`[interaction_appraiser] skip reason=facebook_feed_video_obvious_risk action=like note=${noteId}`);
        return;
      }
    }
    if (this.remainingBudget('like') <= 0) {
      console.log(`[interaction_appraiser] skip reason=no_budget action=like source=${source} note=${noteId}`);
      return;
    }
    const roll = this.randomFn();
    if (!Number.isFinite(roll) || roll < 0 || roll >= 1) {
      console.log(`[interaction_appraiser] skip reason=facebook_presented_video_invalid_random action=like source=${source} note=${noteId}`);
      return;
    }
    if (roll >= FACEBOOK_PRESENTED_VIDEO_LIKE_PROBABILITY) {
      console.log(
        `[interaction_appraiser] skip reason=facebook_presented_video_probability_abstain action=like source=${source} probability=${FACEBOOK_PRESENTED_VIDEO_LIKE_PROBABILITY} roll=${roll} note=${noteId}`,
      );
      return;
    }
    if (!this.canInteract('like')) {
      console.log(`[interaction_appraiser] skip reason=risk_blocked action=like source=${source} note=${noteId}`);
      return;
    }
    if (!this.cooldownPasses('like')) {
      console.log(`[interaction_appraiser] skip reason=cooldown action=like source=${source} note=${noteId}`);
      return;
    }
    const reason = source === 'reels' ? 'facebook_reel_probability_hit' : 'facebook_feed_video_probability_hit';
    const sent = this.sendNoteScopedCommand('like', {
      action: 'like',
      reason,
      params: { noteId, thinkMs: this.thinkNow() },
    });
    if (sent) {
      this.interactionRetry.set('like', { noteId, attempts: 0 });
      console.log(
        `[interaction_appraiser] ${reason} action=like probability=${FACEBOOK_PRESENTED_VIDEO_LIKE_PROBABILITY} roll=${roll} note=${noteId}`,
      );
    } else {
      console.log(`[interaction_appraiser] skip reason=facebook_presented_video_dispatch_suppressed action=like source=${source} note=${noteId}`);
    }
  }

  private facebookNaturalInteractionEligibility(noteId: string): { ok: true } | { ok: false; reason: string } {
    if (this.accountPlatform !== 'facebook') return { ok: true };
    if (!noteId) return { ok: false, reason: 'fb_missing_note_id' };
    // 归一到帖规范身份键再比对：见证集合的 noteId 来自 page.cards / note.detail 两种形态，裸字符串会漂移（防御性加固）。
    const key = facebookPostKey(noteId);
    const selected = this.facebookContentSelectedNoteIds.has(key);
    const passed = this.facebookQualityPassedNoteIds.has(key); // 仅观测（见下：不再硬闸）
    console.log(`[fb-gate] eligibility key=${key} selected=${selected} passed(advisory)=${passed} raw=${noteId}`);
    if (!selected) return { ok: false, reason: 'fb_content_not_selected' };
    // **不再硬闸「已放行」集合**（change facebook-natural-interaction-gate-key，真机取证根因）：interaction_appraiser 由
    // reading.done 触发，而 reading.done 只可能在 content_curator quality.pass → deep_reader → comment_reviewer 链走通后
    // 发出——**能走到点赞判定，本身就证明 curator 已放行**。且「已放行」集合的写入是 quality.pass 的**同级订阅者**，FB
    // （不看图 / 不滚评论）下 deep_reader 在自己的 quality.pass 处理器里**同步**一路驱动到本资格检查，早于同级的集合写入
    // → 检查时集合恒为空 → 曾**恒判 fb_quality_not_passed、系统性挡掉全部点赞**（取证：eligibility passed=false 紧接着
    // 才打 [fb-gate] quality_passed add）。故「已选中」+「已走到点赞判定」即为充分的自然互动证据；「已放行」集合降级为观测。
    return { ok: true };
  }

  /** 当前会话某动作剩余预算（join_group 供 Facebook 加群调度器在 cloud 侧消费）。 */
  remainingBudget(action: SessionBudgetAction): number {
    const key = SESSION_BUDGET_ACTION_KEYS[action];
    return Math.max(0, Number(this.budget[key] ?? 0));
  }

  /** Edge / cloud 上报互动预算消耗。返回 true 表示本次确实扣减了预算。 */
  consumeBudget(action: SessionBudgetAction): boolean {
    const key = SESSION_BUDGET_ACTION_KEYS[action];
    if (this.budget[key] > 0) {
      this.budget[key]--;
      return true;
    }
    return false;
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
        // feed-scroll-card-floor：消费 page.cards.arrived 算好的停留兜底（floor>0 才挂 dwellMs），随即归零。
        const floor = this.pendingFeedFloorMs;
        this.pendingFeedFloorMs = 0;
        this.sendScrollCommand('feed_scroll', floor);
      }),

      // feed 深度到阈值 → 点右下「刷新」回顶换新批（change feed-refresh-on-depth）。
      // 复用 action 档节奏（thinkMs 点前犹豫）；经 sendCommand 统一出口，软暂停期自动被抑制。
      this.eventBus.on('feed.refresh.needed', () => {
        this.sendCommand({ action: 'refresh', reason: 'feed_refresh', params: { thinkMs: this.thinkNow() } });
      }),

      this.eventBus.on('search.scrolled', () => {
        this.sendScrollCommand('search_scroll');
      }),

      // idle 看门狗的恢复 nudge → 一次 scroll，重新驱动停滞的浏览循环（reason 仅作日志区分）。
      // 评论支线在途抑制（change comment-approval-target-hold）：评论支线在途窗内 idle_nudge MUST NOT 翻译成滚动，
      // 否则会把账号从待评论目标滚离。此处早退兼作准确日志；即便漏到 sendScrollCommand，sendCommand 的 commentInflight 闸也会兜住。
      this.eventBus.on('session.idle_nudge', () => {
        if (this.commentInflight) {
          console.log('[RoleDispatcher] idle_nudge 落评论支线在途窗内 → 抑制（不滚动，保持在待评论帖上）');
          return;
        }
        this.sendScrollCommand('idle_recover_nudge');
      }),

      // 评论支线在途起点（change comment-approval-target-hold）：把账号钉在待评论帖上，覆盖评估-LLM / 撰写 / 去 AI 味 / 审批全程，
      // 由 comment.approved（下发前）/ comment.skipped 清位。起点前移到评论支线最早稳定信号（comment.appraising：便宜阈值全过、
      // 即将调 LLM 判定；与 comment.appraised 二者都置、幂等），因为撰写窗内并行点赞回 no_target 的重扫滚屏是主要滚走源、旧的
      // comment.cleared 起点太晚。取代旧的 comment.cleared→approvalInFlight（含 mandatory persona 的 auto_approve 豁免）：
      // mandatory 强制评论也走 comment.appraised（comment-appraiser force-compose 分支），故本起点同样覆盖之；auto_approve 的
      // 免人审逻辑仍在 CommentApprovalGate（未动），此处只负责「钉在帖上」、auto_approve 时窗极短（gate 立即通过）无副作用。
      // 浏览闭环严格串行（返回 feed 必等评论支线终局）⇒ 无重叠窗。
      // **只在下游不会同 tick 同步 skip 时置位**（防「卡死 true」永久抑制，镜像旧 comment.cleared 的防御）：以 currentNote 命中
      // 当前 noteId 为守卫——命中 ⇒ appraiser/composer 均走 await（唯一同步 skip 是 note 数据缺失），本处理器后置为真、终局再清；
      // 未命中 ⇒ 下游同步 emit comment.skipped 先清标志，此时不置真、避免置真后无人清（浏览被扣住无法前进 → 无终局 → 永久卡死）。
      // pauseClock('comment_subline') refcount by reason、幂等；两个入口重复置真/暂停均无副作用，终局单次 resumeClock 解除。
      this.eventBus.on('comment.appraising', (payload) => this.enterCommentSubline(payload)),
      this.eventBus.on('comment.appraised', (payload) => this.enterCommentSubline(payload)),

      // 评论支线终局之一（跳过/拒绝/超时/撰写弃权）→ 清在途标志 + 恢复时钟（末次解除会补发延期的 should_end）。
      this.eventBus.on('comment.skipped', () => {
        this.clearCommentSublineHold(true);
      }),

      // 评论支线终局之一（评论已投，成功/失败均计一次）→ 恢复时钟。此时评论已真正下发（含 FB 两步迁移后的直发），
      // 补发的 should_end（若窗内触及动作数/时长/配额）不再抢在评论之前（change comment-approval-target-hold）。
      // commentInflight 已在 comment.approved 清（放行评论/迁移下发），故此处只恢复时钟。resumeClock 对未置的 reason 幂等 no-op。
      this.eventBus.on('comment.done', () => {
        this.sessionMonitor?.resumeClock('comment_subline');
      }),

      // note.entered 不再发送指令：content.valuable 已经发送了带 index 的 open_note
      // quality.reject 不再直接发 back：BackToFeed 角色会通过 feed.entered 统一发送

      this.eventBus.on('interaction.completed', (payload) => {
        for (const action of payload.actions) {
          // 风控闸：被拒则诚实跳过——不下发、不扣 budget（红线：不假成功、budget 不漂移）。
          if (!this.canInteract(action)) {
            // 稳定 token（change skip-reason-buckets）：与 interaction_appraiser 同口径,journalctl grep 'skip reason=' 可统一分桶。
            console.log(`[interaction_appraiser] skip reason=risk_blocked action=${action} note=${payload.noteId}`);
            continue;
          }
          // 冷却闸（engagement-restraint）：未到点诚实跳过——不下发、不扣 budget（与风控拦截同口径，红线：不假成功）。
          const mandatoryAction = action === 'like' && payload.mandatoryInteraction?.actions.includes('like') === true;
          if (!mandatoryAction && !this.cooldownPasses(action)) {
            // 原本完全静默(直接 continue)→ 补一行稳定 token,让「冷却吞掉的互动」也可见。
            console.log(`[interaction_appraiser] skip reason=cooldown action=${action} note=${payload.noteId}`);
            continue;
          }
          // 互动前犹豫时间（time directive）：边缘据此在执行前等待并叠抖动。
          // change fix-interaction-and-comment-capture：预算不再在下发时乐观扣（失败/去重跳过不该烧预算），
          // 改按 action.completed{ok:true} 扣（对齐 follow/comment）；此处仅登记重试上下文（noteId + 次数）。
          const sent = this.sendNoteScopedCommand(action, { action, params: { noteId: payload.noteId, thinkMs: this.thinkNow() } });
          if (sent && (action === 'like' || action === 'collect')) {
            this.interactionRetry.set(action, { noteId: payload.noteId, attempts: 0 });
          }
        }
      }),

      // 人审通过的评论 → 下发 comment 指令。风控闸：被拒则诚实跳过（不下发、不扣额），仍 emit comment.skipped 走「是否进主页评估」。
      // 配额改由 action.completed 真实回执扣减（对齐 follow）。
      this.eventBus.on('comment.approved', (payload) => {
        if (this.isCommentSublineExpired(payload.noteId)) {
          console.warn(`[RoleDispatcher] comment.approved ignored reason=late_after_comment_subline_timeout note=${payload.noteId}`);
          return;
        }
        // 评论支线在途终局之一（人审通过）：**先清在途标志再下发**——评论/迁移命令也经 sendCommand，
        // 不先清会被自己的 commentInflight 闸扣住而静默丢弃（镜像 nickname-enricher 先解除暂停再 emit 的顺序）。
        // 时钟不在此恢复：resumeClock 会补发延期的 should_end；须晚于评论真正下发（见 comment.done），
        // 否则补发的 session.end 会抢在（FB 两步迁移的）评论之前结束会话、废掉已授权评论。
        this.clearCommentSublineHold(false);
        const approvedDelivery: PendingCommentDelivery = {
          noteId: payload.noteId,
          sourcePageType: payload.sourcePageType,
          actions: payload.actions,
          text: payload.text,
          ...(payload.mandatoryInteraction ? { mandatoryInteraction: payload.mandatoryInteraction } : {}),
          ...(payload.approvalTrace ? { approvalTrace: payload.approvalTrace } : {}),
        };
        const risk = this.explainInteract('comment');
        if (!risk.allowed) {
          const reason = `risk:${risk.reason ?? 'risk_blocked'}`;
          console.log(`[RoleDispatcher] 评论被风控拦截，跳过 note=${payload.noteId} reason=${reason}`);
          this.reportMandatoryCommentOutcome(approvedDelivery, 'failed', reason);
          this.eventBus.emit('comment.skipped', {
            noteId: payload.noteId,
            sourcePageType: payload.sourcePageType,
            actions: payload.actions,
            reason,
            ...(payload.mandatoryInteraction ? { mandatoryInteraction: payload.mandatoryInteraction } : {}),
            ts: this.clock(),
          });
          return;
        }
        // 回执驱动两步评论迁移（change platform-browse-protocol）：评论 surface≠读 surface（如 FB 就地读、评论进详情）
        // ⇒ 先 open_note{purpose:'navigate'} 把浏览器带到详情、等其 action.completed 落地确认后才发 comment。
        // 读侧用 effectiveReadSurface（版本偏斜后）：就地读打开时评论必迁移；老边端 read 回落 detail ⇒ 与 comment 相等
        // ⇒ 结构性不可达（=今天，逐位直发）。XHS 两 surface 皆 detail ⇒ 恒相等 ⇒ 零回归。
        if (resolveCommentSurface(this.accountPlatform) !== this.effectiveReadSurface()) {
          this.pendingMigration = approvedDelivery;
          this.armMandatoryCommentOutcomeTimer(approvedDelivery);
          const migrateSent = this.sendCommand({
            action: 'open_note',
            params: { noteId: payload.noteId, purpose: 'navigate', thinkMs: this.thinkNow() },
          });
          if (!migrateSent) {
            // 迁移 open_note 被软暂停（如并发通知巡视 browseSuspended）/ 配额闸拦下（未真正下发）→ 诚实收敛：
            // 清 pendingMigration（不等永不到来的回执，也防悬挂 pendingMigration 劫持后续无关 open_note 完成回执）、
            // emit comment.skipped 触发 resumeClock('comment_subline')。与直发路径的守卫对称
            // （change comment-approval-target-hold）：否则评论支线无终局 → 时钟永冻 should_end。
            this.pendingMigration = null;
            this.clearMandatoryCommentOutcomeTimer();
            this.reportMandatoryCommentOutcome(approvedDelivery, 'failed', 'comment_migration_suppressed');
            this.eventBus.emit('comment.skipped', {
              noteId: payload.noteId,
              sourcePageType: payload.sourcePageType,
              actions: payload.actions,
              reason: 'comment_migration_suppressed',
              ...(payload.mandatoryInteraction ? { mandatoryInteraction: payload.mandatoryInteraction } : {}),
              ts: this.clock(),
            });
          }
          return;
        }
        this.pendingComment = approvedDelivery;
        this.armMandatoryCommentOutcomeTimer(approvedDelivery);
        const commentSent = this.sendNoteScopedCommand('comment', { action: 'comment', params: { noteId: payload.noteId, text: payload.text, thinkMs: this.thinkNow() } });
        if (!commentSent) {
          // 评论命令被去重/配额/软暂停闸拦下（未真正下发）→ 诚实收敛评论支线：清 pendingComment（不等永不到来的回执）、
          // emit comment.skipped 走「是否进主页评估」。否则评论支线无终局 → resumeClock('comment_subline') 永不调用、
          // 时钟永冻 should_end（change comment-approval-target-hold）；且旧行为下会话卡死在此帖直到看门狗。
          this.pendingComment = null;
          this.clearMandatoryCommentOutcomeTimer();
          this.reportMandatoryCommentOutcome(approvedDelivery, 'failed', 'comment_dispatch_suppressed');
          this.eventBus.emit('comment.skipped', {
            noteId: payload.noteId,
            sourcePageType: payload.sourcePageType,
            actions: payload.actions,
            reason: 'comment_dispatch_suppressed',
            ...(payload.mandatoryInteraction ? { mandatoryInteraction: payload.mandatoryInteraction } : {}),
            ts: this.clock(),
          });
        }
      }),

      // 进作者主页：专用 profile_open 指令（取代 open_note{type:'profile'}——
      // type 字段在 NoteOpenPayload 不存在会被静默丢弃，导致边缘开错笔记、从不进主页）。
      this.eventBus.on('profile.entered', (payload) => {
        this.sendCommand({ action: 'profile_open', params: { authorId: payload.authorId, thinkMs: this.thinkNow() } });
      }),

      // 深读：多图浏览意图 → browse_images 指令（dwellMs 按正文量级，thinkMs 为开始前犹豫）。
      this.eventBus.on('reading.browse_images', (payload) => {
        const dwellMs = this.dwellForCurrentNote('glance');
        this.sendNoteScopedCommand('browse_images', {
          action: 'browse_images',
          params: { noteId: payload.noteId, count: payload.count, thinkMs: this.thinkNow(), ...(dwellMs === undefined ? {} : { dwellMs }) },
        });
      }),

      // 深读：评论浏览意图 → scroll_comments 指令。
      this.eventBus.on('reading.scroll_comments', (payload) => {
        const dwellMs = this.dwellForCurrentNote('glance');
        this.sendNoteScopedCommand('scroll_comments', {
          action: 'scroll_comments',
          params: { noteId: payload.noteId, count: payload.count, thinkMs: this.thinkNow(), ...(dwellMs === undefined ? {} : { dwellMs }) },
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
        this.sendNoteScopedCommand('comment_like', {
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
          // 就地读平台（read surface='feed' 且未迁移详情）读完从未离开列表 ⇒ 用 scroll 续刷、不 back（back 会
          // 误离开 feed）。读静态表 + per-note 迁移标志，绝不读 observedSurface。小红书 / 阶段 0 FB ⇒ 恒 back。
          if (this.shouldCloseWithScroll()) {
            this.sendScrollCommand('feed_inline_continue');
            return;
          }
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
          this.emitSearchSkippedAfterIntercept(payload.currentPageType, 'budget_exhausted');
          return;
        }
        // 闸二：限频（每关键词每会话/每天上限）。
        const decision = this.searchLimiter.explain(keyword);
        if (!decision.allowed) {
          const reason = decision.reason ?? 'search_limited';
          console.log(`[RoleDispatcher] 搜索被拦截，跳过 keyword=${keyword} reason=${reason}`);
          this.emitSearchSkippedAfterIntercept(payload.currentPageType, reason);
          return;
        }
        // 两道闸通过 → 记账 + 下发（如实带上 source）。
        this.searchLimiter.recordSearch(keyword);
        this.searchedKeywords.push(keyword);
        this.consumeBudget('search');
        const params: Record<string, unknown> = { keyword };
        if (payload.source) params.source = payload.source;
        this.sendCommand({ action: 'search', params });
        // change bounded-search-excursion（#2 修页型自指 bug）：唯一权威写入点——**真正下发了搜索指令**
        // 才把当前列表页型标为 search（被上面两道闸拦下、未下发的搜索绝不到这里，故不会误翻转）。
        // 由此搜索结果页被 SearchScroller 正确驱动、搜索卡不再计入 feed 深度；回首页时在 page.cards 处标回 feed。
        this.sessionContext.setSourcePageType('search');
        // 跨会话标记已搜（fire-and-forget，失败不影响本次下发）。
        this.conceptStore?.markSearched(keyword).catch((err) =>
          console.warn(`[RoleDispatcher] markSearched 失败 keyword=${keyword}: ${err instanceof Error ? err.message : String(err)}`),
        );
      }),

      this.eventBus.on('quality.pass', (payload) => {
        if (this.accountPlatform === 'facebook' && payload.noteId) {
          const key = facebookPostKey(payload.noteId);
          this.facebookQualityPassedNoteIds.add(key);
          console.log(`[fb-gate] quality_passed add key=${key} raw=${payload.noteId}`);
        }
      }),

      // 角色产出事件 → Edge 指令翻译
      this.eventBus.on('content.valuable', (payload) => {
        const viewDecision = this.explainView();
        if (!viewDecision.allowed) {
          this.sleepForViewQuota(viewDecision);
          return;
        }
        // 带上 noteId：edge 据此在「当前快照」里按稳定主键定位目标卡。
        // 否则 feed 在云端决策与 edge 执行之间滚动后，纯 index 寻址会开成同序号上的邻座（stale index）。
        // 熟悉度折扣：返回 feed 后再次打开一张近期已评估过的卡片 → 思考时间降至 1/3（首次打开仍全量）。
        const familiar = payload.noteId ? this.sessionContext.isRecentlyEvaluated(payload.noteId) : false;
        // 就地读 surface（change facebook-feed-inline-browse 灰度接线）：effectiveReadSurface==='feed'
        // （registry 翻转 read_content='feed' 且本连接边缘声明 inline_targeting）才带 surface:'feed'，让边缘就地
        // 展开读全文；否则**省略字段** ⇒ 边缘按缺省走 detail（=今天，逐位不变、老边端零回归）。
        const openParams: Record<string, unknown> = {
          index: payload.index,
          noteId: payload.noteId,
          thinkMs: this.thinkNow(familiar),
        };
        if (this.effectiveReadSurface() === 'feed') openParams.surface = 'feed';
        const sent = this.sendCommand({
          action: 'open_note',
          params: openParams,
          reason: payload.reason,
        });
        if (sent && this.accountPlatform === 'facebook' && payload.noteId) {
          const key = facebookPostKey(payload.noteId);
          this.facebookContentSelectedNoteIds.add(key);
          console.log(`[fb-gate] content_selected add key=${key} raw=${payload.noteId}`);
        }
      }),

      // content.no_valuable 不在此直接翻页：翻页由 FeedScroller / SearchScroller 角色独家处理
      // （它们带 pageType 过滤 + 连续滚动计数，到阈值转搜索）。曾在此再直接发一条 scroll，导致一次
      // “没价值”判定被双发两条 scroll：第二条落在尚未判定的新页上、把它（可能含 AI 卡）直接滚过，
      // 且污染了“连续滚 N 次转搜索”的阈值。删除以恢复单一翻页决策者。
      this.eventBus.on('session.should_end', (payload) => {
        // 仅发结束命令给边端。结束流程（含正常结束的续场武装）由监测体注入的 onSessionEnd 回调
        // （见构造处 :532，携 autoResumeEligible:true）唯一负责——此处 MUST NOT 再调 endSession。
        // 否则一次监测体结束会被双调：triggerEnd 先 emit（本处理器同步跑完 endSession#1 武装续场计时器），
        // 后走 onSessionEnd（endSession#2 在 sessionActive 守卫前无条件 cancelRestTimer 清掉刚武装的计时器、
        // 随即因 sessionActive=false 早退不再武装）→ 续场永不触发（change restore-auto-resume A①）。
        const autoResumeInMs = this.computeAutoResumeInMs();
        this.pendingAutoResumeInMs = autoResumeInMs;
        this.sendCommand({
          action: 'session.end',
          reason: payload.reason,
          params: autoResumeInMs === undefined ? undefined : { autoResumeInMs },
        });
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
      this.eventBus.on('excursion.requested', () => {
        this.sessionMonitor?.pauseClock('patrol');
        this.beginNotificationTask();
      }),
      this.eventBus.on('excursion.ended', () => {
        this.sessionMonitor?.resumeClock('patrol');
        void this.endNotificationTask();
      }),

      // Facebook 首页显式空态：Edge 只观察，Cloud 才选择列表。每场只授权一次，复用现有 scroll 命令。
      this.eventBus.on('feed.empty.confirmed', () => {
        this.authorizeFacebookReelsFallback('empty_feed');
      }),

      // Edge 上报可见卡片 → 更新数据并触发评估
      this.eventBus.on('page.cards.arrived', (payload) => {
        this.updateVisibleCards(payload.cards);
        this.maybeDispatchFacebookPresentedVideoLike(payload.cards, payload.listKind);
        // feed-scroll-card-floor：仅 feed 来源——按本批 noteId 差分"上一批"算新卡数（缺 noteId 计为非新卡），
        // 覆盖写 pendingFeedFloorMs（含写 0），避免 open→return 残留旧值；search 上报不写不消费 feed 集合。
        if (this.sessionContext.sourcePageType === 'feed') {
          const noteIds = payload.cards
            .map((c) => c.noteId)
            .filter((id): id is string => typeof id === 'string' && id.length > 0);
          const newCount = this.sessionContext.feedBatchNewCount(noteIds);
          // feed 深度累计（change feed-refresh-on-depth）：累加本批新卡数，达阈值时 FeedScroller 改发刷新。
          // 只在 feed 来源累加（搜索批不计），复用已算好的去重增量。
          this.sessionContext.addFeedCardsBrowsed(newCount);
          this.pendingFeedFloorMs = computeFeedFloorMs({
            newCount,
            status: this.getRiskStatus(),
            quotaLevel: this.getQuotaLevel(),
            progress: this.progress(),
            pacing: this.pacingFloors,
          });
        } else if (this.sessionContext.sourcePageType === 'search') {
          // change bounded-search-excursion（#3 搜索行程有界退出）：搜索结果页累计浏览的不重复卡数达阈值 → 回首页。
          // 用独立的搜索卡差分基准（不污染 feed 集合）；差分累计天然覆盖「搜索页一篇都点不开」的空转（照样计卡）。
          const searchNoteIds = payload.cards
            .map((c) => c.noteId)
            .filter((id): id is string => typeof id === 'string' && id.length > 0);
          this.sessionContext.addSearchCardsBrowsed(this.sessionContext.searchBatchNewCount(searchNoteIds));
          if (
            this.sessionContext.searchCardsBrowsed >= SEARCH_HOME_RETURN_AFTER &&
            this.canRefresh() &&
            this.sessionActive
          ) {
            // 结束搜索行程：标回 feed + 清搜索/滚动/feed 深度计数，复用既有 refresh（回顶换首页）指令回首页。
            // canRefresh()===false 的平台诚实降级（不回首页、继续评估当前页），绝不伪造已回首页。
            const cardsSeen = this.sessionContext.searchCardsBrowsed;
            this.sessionContext.setSourcePageType('feed');
            this.sessionContext.resetSearchCardsBrowsed();
            this.sessionContext.resetScrolls();
            this.sessionContext.resetFeedCardsBrowsed();
            console.log(`[RoleDispatcher] 搜索行程累计 ${cardsSeen} 张卡 ≥ ${SEARCH_HOME_RETURN_AFTER} → 回首页（search_home_return）`);
            this.sendCommand({ action: 'refresh', reason: 'search_home_return', params: { thinkMs: this.thinkNow() } });
            return; // 已发回首页指令：跳过对本批搜索卡的评估（正离开搜索页）
          }
        }
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
        // 7.8（change lease-strict-preemption；co-deploy 于 edge §8.1 批 D 之前必落）：被抢占是**调度事件**、不是动作失败。
        // 原因级短路 MUST 插在按动作名匹配的 noRecoverScroll 名单**之前**——open_note / refresh / profile_open 不在名单里、
        // 仅靠动作名匹配会漏网，一旦边缘补上诚实回执就会触发一次恢复滚动、滚到抢占方页面。被抢占：不兜底滚动、不重试、
        // 不清计数、不计互动失败与配额、不 emit comment.done（否则把评论供线终结成「已投但失败」）。留待抢占方释放后自然重决策。
        if (payload.ok === false && isPreemptionReason(payload.reason)) {
          console.log(`[RoleDispatcher] 动作 ${payload.action} 被抢占（${payload.reason}）→ 原因级短路：不兜底滚动、不重试、不计失败与配额`);
          // 评论支线时钟不泄漏（change comment-approval-target-hold）：被抢占的 comment/open_note{navigate} 在此短路 return，
          // 早于 comment.done/skipped 的补发点 ⇒ 若其为评论支线在飞命令，resumeClock('comment_subline') 永不触发、
          // pauseClock 永冻 → should_end 被无限延期。此处解除时钟暂停并清在飞评论态（避免悬挂 pending 劫持后续无关回执），
          // **仍尊重抢占语义**：不 emit comment.done（不把评论终结成「已投但失败」）、不发恢复滚动、不重试、不计配额。
          // **只在被抢占的是评论支线命令（comment / 迁移 open_note）时解冻**：评论支线在途期唯一在飞的换页命令就是这二者
          // （其余离页命令已被 commentInflight 闸扣住）；非评论动作（如 like/scroll）被抢占绝不误清一个正当在途的 commentInflight。
          if (payload.action === 'comment' || payload.action === 'open_note') {
            const preempted = payload.action === 'comment' ? this.pendingComment : this.pendingMigration;
            if (preempted) this.reportMandatoryCommentOutcome(preempted, 'unknown', 'preempted_by_task');
            this.clearMandatoryCommentOutcomeTimer();
            if (payload.action === 'comment') this.pendingComment = null;
            if (payload.action === 'open_note') this.pendingMigration = null;
            this.clearCommentSublineHold(true);
          }
          return;
        }
        // observedSurface 仅审计（change platform-browse-protocol）：回执回声 surface 与期望不符 → warn（检测漂移）；
        // 绝不参与控制流（控制流一律读 effectiveReadSurface，见 shouldCloseWithScroll）。期望取版本偏斜后的有效值：
        // 老边端 read 回落 detail 时期望亦 detail，避免对未开就地读的边缘误报漂移。阶段 0 无 surface 回声 ⇒ 惰性。
        if (typeof payload.observation === 'object' && payload.observation !== null) {
          const echoed = (payload.observation as { surface?: unknown }).surface;
          const expected = this.effectiveReadSurface();
          if (typeof echoed === 'string' && echoed !== expected) {
            console.warn(
              `[RoleDispatcher] observedSurface 漂移：回声=${echoed} 期望=${expected} action=${payload.action}（仅审计、不改控制流）`,
            );
          }
        }
        // 回执驱动评论迁移·第二步（change platform-browse-protocol）：navigate 步回执落地目标详情 ⇒ 才发 comment；
        // 未落地 ⇒ 绝不在当前页发评论（fail-closed）+ 显式回报操作员。阶段 0 pendingMigration 恒 null（迁移不可达）⇒ 不触发。
        if (this.pendingMigration && payload.action === 'open_note') {
          const mig = this.pendingMigration;
          this.pendingMigration = null;
          const echoedSurface =
            typeof payload.observation === 'object' && payload.observation !== null
              ? (payload.observation as { surface?: unknown }).surface
              : undefined;
          // fail-closed（红线加固）：spec 要求 detail-surface 观测**且 noteId 匹配**才算落地。缺派生 noteId 也判失败
          // ⇒ 不发评论、回报操作员（绝不把已批准评论发到未经证实的目标）。C2 边缘 navigate 回执 MUST 带派生 noteId。
          const landed =
            payload.ok === true && echoedSurface === 'detail' && !!payload.noteId && payload.noteId === mig.noteId;
          if (landed) {
            this.sessionContext.markNoteMigratedToDetail();
            this.pendingComment = {
              noteId: mig.noteId,
              sourcePageType: mig.sourcePageType,
              actions: mig.actions,
              text: mig.text,
              ...(mig.mandatoryInteraction ? { mandatoryInteraction: mig.mandatoryInteraction } : {}),
              ...(mig.approvalTrace ? { approvalTrace: mig.approvalTrace } : {}),
            };
            const migCommentSent = this.sendNoteScopedCommand('comment', {
              action: 'comment',
              params: { noteId: mig.noteId, text: mig.text, thinkMs: this.thinkNow() },
            });
            if (!migCommentSent) {
              // navigate 已落地，但第二步 comment 被去重/配额/软暂停闸拦下（未真正下发）→ 诚实收敛：清 pendingComment、
              // 回报操作员 + emit comment.done{ok:false} 触发 resumeClock('comment_subline')（change comment-approval-target-hold）。
              // 否则评论支线无终局、时钟永冻 should_end。mandatoryInteraction 透传（与下方 nav-failed 分支一致）。
              this.pendingComment = null;
              this.clearMandatoryCommentOutcomeTimer();
              this.reportMandatoryCommentOutcome(mig, 'failed', 'comment_dispatch_suppressed');
              if (!this.mandatoryApprovalTrace(mig)) this.reportApprovedNotDelivered(mig.noteId, payload.reason);
              this.eventBus.emit('comment.done', {
                noteId: mig.noteId,
                sourcePageType: mig.sourcePageType,
                actions: mig.actions,
                ok: false,
                reason: 'comment_dispatch_suppressed',
                ...(mig.mandatoryInteraction ? { mandatoryInteraction: mig.mandatoryInteraction } : {}),
                ts: this.clock(),
              });
            }
          } else {
            console.warn(
              `[RoleDispatcher] 评论迁移 navigate 失败 → 不发评论、回报操作员 note=${mig.noteId} reason=${payload.reason ?? 'nav_failed'}`,
            );
            const reason = payload.reason ?? 'nav_failed';
            this.clearMandatoryCommentOutcomeTimer();
            this.reportMandatoryCommentOutcome(mig, 'failed', reason);
            if (!this.mandatoryApprovalTrace(mig)) this.reportApprovedNotDelivered(mig.noteId, payload.reason);
            this.eventBus.emit('comment.done', {
              noteId: mig.noteId,
              sourcePageType: mig.sourcePageType,
              actions: mig.actions,
              ok: false,
              reason,
              ...(mig.mandatoryInteraction ? { mandatoryInteraction: mig.mandatoryInteraction } : {}),
              ts: this.clock(),
            });
          }
          return;
        }
        // Facebook 普通 Feed 确认到底：复用已部署 Reels fallback 握手，每场只授权一次；重复到底回执直接吞掉，
        // 不再刷新同一普通 Feed。其他平台保持既有 refresh 自愈，避免转 idle → 240s nudge 循环。
        if (
          payload.action === 'scroll' &&
          payload.reason === 'feed_exhausted' &&
          this.accountPlatform === 'facebook' &&
          this.sessionActive
        ) {
          this.authorizeFacebookReelsFallback('feed_exhausted');
          return;
        }
        // 阶段 0 边缘不上报 feed_exhausted ⇒ 惰性；feed_refresh 能力关时 canRefresh()===false ⇒ 不误发。
        if (payload.reason === 'feed_exhausted' && this.canRefresh() && this.sessionActive) {
          console.log('[RoleDispatcher] feed_exhausted → 立即刷新换新批（避免 idle 空转）');
          this.sendCommand({ action: 'refresh', reason: 'feed_exhausted_refresh', params: { thinkMs: this.thinkNow() } });
          return;
        }
        // 信息流就地互动目标已从 DOM 消失（change platform-browse-protocol）：no_target(stale) 视快照过期 ⇒ 重扫换批重选，
        // MUST NOT 计互动配额失败（budget 只按 ok:true 扣，天然不烧）。仅就地读态（effectiveReadSurface==='feed'）触发；
        // 详情页 like/collect（读 detail 或老边端回落 detail）⇒ 不触发（=今天）。
        if (
          payload.ok === false &&
          (payload.action === 'like' || payload.action === 'collect') &&
          typeof payload.reason === 'string' &&
          payload.reason.startsWith('no_target') &&
          this.effectiveReadSurface() === 'feed' &&
          this.sessionActive
        ) {
          this.interactionRetry.delete(payload.action);
          if (this.commentInflight) {
            // 评论支线在途（change comment-approval-target-hold）：该并行互动回 no_target 是撰写窗内最主要的滚走源——
            // 此刻账号正等对本帖发评论，MUST NOT 重扫滚屏把它滚离。评论 approved 后会按 permalink 重定位（FB 两步迁移），
            // 故这次重扫于评论投递零收益、纯破坏「停在目标上」。（sendCommand 的 commentInflight 闸亦会兜住，此处显式早退兼准确日志。）
            console.log('[RoleDispatcher] feed-surface 互动 no_target(stale) 落评论支线在途窗 → 不重扫，保持在待评论帖上');
            return;
          }
          console.log('[RoleDispatcher] feed-surface 互动 no_target(stale) → 快照过期，重扫换批重选');
          this.sendScrollCommand('rescan_after_stale_target');
          return;
        }
        // 现场评论归集（change platform-vocabulary-and-thresholds 2.1）：小红书的 note.detail 不带评论，
        // 评论区正文只在 scroll_comments 回执的 candidates 里。归到当前笔记上，供撰写器贴合评论区语境
        // （Facebook 不走这里——其 note.detail 直接带 comments）。只认属于当前笔记的回执，采到多少记多少。
        if (
          payload.action === 'scroll_comments' &&
          payload.ok === true &&
          payload.candidates?.length &&
          this.currentNote &&
          (!payload.noteId || payload.noteId === this.currentNote.noteId)
        ) {
          const texts = payload.candidates.map((c) => c.text).filter((t): t is string => Boolean(t && t.trim()));
          if (texts.length) this.currentNote.comments = texts;
        }
        // 冷却时间戳（engagement-restraint）：仅在真实成功（ok:true）时落；下发失败不起算（不白占冷却窗）。
        // follow 排除 already_followed 良性 no-op（与「no-op 不烧配额」同口径，不算一次真关注）。
        if (payload.ok === true) {
          if (payload.action === 'like' || payload.action === 'collect' || payload.action === 'comment') {
            this.markCooldown(payload.action);
          } else if (payload.action === 'follow' && payload.reason !== 'already_followed') {
            this.markCooldown('follow');
          }
        }
        // change fix-interaction-and-comment-capture：like/collect 预算按真成功回执扣（对齐 follow/comment）。
        // 下发时不再乐观扣；失败/去重跳过不烧预算；重试成功也只在此扣一次（失败回执 ok:false 不进此分支）。
        if (payload.ok === true && (payload.action === 'like' || payload.action === 'collect')) {
          this.consumeBudget(payload.action);
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
          this.clearMandatoryCommentOutcomeTimer();
          const pendingApproval = payload.reason === 'pending_group_approval';
          const ambiguous = payload.reason === 'submitted_unconfirmed' || payload.reason === 'verification_ambiguous';
          if (pendingApproval) {
            this.reportMandatoryCommentOutcome(pc, 'pending', payload.reason);
          } else if (payload.ok === true) {
            this.reportMandatoryCommentOutcome(pc, 'confirmed', payload.reason);
          } else if (ambiguous) {
            this.reportMandatoryCommentOutcome(pc, 'unknown', payload.reason);
          } else {
            this.reportMandatoryCommentOutcome(pc, 'failed', payload.reason ?? 'edge_failed');
          }
          if (payload.ok === true && !pendingApproval) this.consumeBudget('comment');
          this.eventBus.emit('comment.done', {
            noteId: pc.noteId,
            sourcePageType: pc.sourcePageType,
            actions: pc.actions,
            ok: payload.ok === true && !pendingApproval,
            ...(payload.reason ? { reason: payload.reason } : {}),
            ...(pc.mandatoryInteraction ? { mandatoryInteraction: pc.mandatoryInteraction } : {}),
            ts: this.clock(),
          });
        }
        // follow 失败不在此兜底滑动：返回信息流已由 profile.done 单一时序点经 profile.exit 触发
        // （与 follow 回执解耦，回执此处只用于配额扣减）；若再滑一屏会与已在途的返回命令打架。
        // browse_images / scroll_comments 在详情页内执行，失败由 DeepReader / CommentReviewer
        // 自行推进（emit reading.images_done / reading.done），此处不发 feed 滚动（否则会把详情页滚走）。
        // change fix-interaction-and-comment-capture：like/collect 可重试失败（点了没生效 state_unchanged /
        // 互动栏一时缺失 btn_no-bar·btn_no-btn）原地有界重试一次；不可重试（验证码/已点过）诚实终止。
        // 重试或终止都不发兜底滚动——like/collect 在详情页内执行，滚动会把详情页滚走。
        if (payload.action === 'like' || payload.action === 'collect') {
          const RETRIABLE_INTERACTION_REASONS = new Set(['state_unchanged', 'btn_no-bar', 'btn_no-btn']);
          const tracker = this.interactionRetry.get(payload.action);
          if (
            payload.ok === false &&
            this.sessionActive &&
            typeof payload.reason === 'string' &&
            RETRIABLE_INTERACTION_REASONS.has(payload.reason) &&
            tracker &&
            tracker.attempts < 1
          ) {
            // 只有重发真发出（未被软暂停/去重丢弃）才消耗这次重试名额；否则不烧名额、落下方清理。
            const resent = this.sendCommand({ action: payload.action, params: { noteId: tracker.noteId, thinkMs: this.thinkNow() } });
            if (resent) {
              tracker.attempts += 1;
              console.log(
                `[RoleDispatcher] ${payload.action} 失败可重试 → 原地重发（note=${tracker.noteId} attempt=${tracker.attempts} reason=${payload.reason}）`,
              );
              return; // 重发已发出，等下一个回执，不落兜底滚动、不清 tracker
            }
            console.log(`[RoleDispatcher] ${payload.action} 重发被软暂停/去重丢弃 → 不消耗重试名额`);
          }
          // 成功 / 不可重试 / 重试用尽 / 重发被丢弃：清理重试上下文。
          this.interactionRetry.delete(payload.action);
        }
        const noRecoverScroll =
          payload.action === 'scroll' ||
          payload.action === 'follow' ||
          payload.action === 'join_group' ||
          payload.action === 'browse_images' ||
          payload.action === 'scroll_comments' ||
          payload.action === 'comment' ||
          payload.action === 'comment_like' ||
          payload.action === 'like' ||
          payload.action === 'collect';
        if (payload.ok === false && !noRecoverScroll && this.sessionActive) {
          console.log(`[RoleDispatcher] 动作失败兜底 → scroll（recover_after_${payload.action}_failed）`);
          this.sendScrollCommand(`recover_after_${payload.action}_failed`);
        }
      }),
    );
  }
}
