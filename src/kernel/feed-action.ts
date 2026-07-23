/**
 * 展示账本四类互动动作契约（从 src/cache/interaction-feed-store.ts 抬入 kernel）。
 *
 * 纯类型，零 import、无 SQL、无活状态。被 api 面板层 type-only 共导。
 * comment_like 刻意不进：无按笔记/作者语义。
 */
export type FeedAction = 'like' | 'collect' | 'comment' | 'follow';
