/**
 * Agents 统一导出 — 5 个独立 Agent 与基础类型。
 */

export { BaseAgent } from './types.js';
export type { BaseAgentOptions } from './types.js';
export { SessionMonitor } from './session-monitor.js';
export { FeedScanner } from './feed-scanner.js';
export { ContentCurator } from './content-curator.js';
export { InteractionAppraiser } from './interaction-appraiser.js';
export { CommentReviewer } from './comment-reviewer.js';

// ─── 新架构：事件驱动角色基础设施 ───
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
export { ContentCuratorRole } from './content-curator-role.js';
export type { NoteData, ContentCuratorRoleOptions } from './content-curator-role.js';
export { InteractionAppraiserRole } from './interaction-appraiser-role.js';
export type { InteractionAppraiserRoleOptions } from './interaction-appraiser-role.js';

// ─── Phase 4：作者评估 + Profile 链路角色 ───
export { AuthorEvaluator } from './author-evaluator.js';
export type { AuthorEvaluatorOptions } from './author-evaluator.js';
export { ProfileOpener } from './profile-opener.js';
export { ProfileBrowser } from './profile-browser.js';
export type { ProfileBrowserOptions } from './profile-browser.js';
export { FollowAgent } from './follow-agent.js';
export type { FollowAgentOptions } from './follow-agent.js';

// ─── Phase 5：搜索链路角色 ───
export { SearchScroller, SEARCH_SCROLL_THRESHOLD } from './search-scroller.js';
export { SearchEvaluator } from './search-evaluator.js';
export type { SearchEvaluatorOptions } from './search-evaluator.js';
export { SearchExecutor } from './search-executor.js';
export type { SearchExecutorOptions } from './search-executor.js';
