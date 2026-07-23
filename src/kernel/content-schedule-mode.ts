/**
 * 内容排期动作模式契约（从 src/config/content-schedule-store.ts 抬入 kernel）。
 *
 * 纯常量 + 纯类型，零 import、无 SQL、无活状态。排期存储（含建表与读写 SQL）留在
 * src/config/content-schedule-store.ts（automation）。ContentScheduleApprovalMode 被 automation/content
 * 多边 type-only 共导（comment-scheduler / compose-approve / publish-agent types）。
 */
export const CONTENT_SCHEDULE_ACTION_MODES = ['off', 'review', 'auto_approve'] as const;
export type ContentScheduleActionMode = (typeof CONTENT_SCHEDULE_ACTION_MODES)[number];
export type ContentScheduleApprovalMode = Exclude<ContentScheduleActionMode, 'off'>;
