/**
 * Agents 统一导出 — 事件驱动角色系统。
 */

// ─── 事件驱动角色基础设施 ───
export { BaseRole } from './base-role.js';
export type { RoleOptions } from './base-role.js';
export { SessionContext } from './session-context.js';

// ─── Phase 2：核心闭环角色 ───
export { ContentEvaluator } from './content-evaluator.js';
export type { VisibleCard } from './content-evaluator.js';
export { FeedScroller, SEARCH_THRESHOLD } from './feed-scroller.js';
export { NoteOpener } from './note-opener.js';
export { BackToFeed } from './back-to-feed.js';

// ─── Phase 3：详情页深度链路角色 ───
export { DeepReader } from './deep-reader.js';
export type { DeepReaderOptions } from './deep-reader.js';
export { CommentReviewer } from './comment-reviewer.js';
export type { CommentReviewerOptions } from './comment-reviewer.js';
export { ContentCuratorRole } from './content-curator-role.js';
export type { NoteData, ContentCuratorRoleOptions } from './content-curator-role.js';
export { InteractionAppraiserRole } from './interaction-appraiser-role.js';
export type { InteractionAppraiserRoleOptions } from './interaction-appraiser-role.js';

// ─── Phase 4：作者评估 + Profile 链路角色 ───
export { AuthorEvaluator } from './author-evaluator.js';
export type { AuthorEvaluatorOptions } from './author-evaluator.js';
export { ProfileOpener } from './profile-opener.js';
export { ProfileBrowser } from './profile-browser.js';
export { FollowAgent } from './follow-agent.js';
export type { FollowAgentOptions } from './follow-agent.js';
export { FacebookGroupJoinJudge } from './facebook-group-join-judge.js';
export type {
  FacebookGroupJoinJudgeOptions,
  FacebookGroupJoinJudgeResult,
  FacebookGroupJoinObservation,
  FacebookJoinPostClickVerdict,
  FacebookJoinPreClickVerdict,
} from './facebook-group-join-judge.js';

// ─── Phase 5：搜索链路角色 ───
export { SearchScroller, SEARCH_SCROLL_THRESHOLD } from './search-scroller.js';
export { SearchEvaluator } from './search-evaluator.js';
export type { SearchEvaluatorOptions } from './search-evaluator.js';
export { SearchExecutor } from './search-executor.js';
export type { SearchExecutorOptions } from './search-executor.js';

// ─── Phase 6：会话守护角色（事件驱动版） ───
export { SessionMonitorRole } from './session-monitor-role.js';
export type { SessionMonitorRoleOptions } from './session-monitor-role.js';
