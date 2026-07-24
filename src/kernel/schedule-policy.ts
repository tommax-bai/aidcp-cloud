import type { PlatformId } from './platform-types.js';
import type { PublishMode } from './publish-pipeline-types.js';

export const XHS_SCHEDULE_MIN_AHEAD_MS = 60 * 60 * 1000;
export const XHS_SCHEDULE_MAX_AHEAD_MS = 14 * 24 * 60 * 60 * 1000;

export type ScheduleValidationError =
  | 'schedule_platform_unsupported'
  | 'schedule_time_required'
  | 'schedule_time_out_of_range';

/** cloud 权威策略：只有 XHS scheduled 需要时间；immediate/draft 必须清空时间。 */
export function validatePublishSchedule(
  platform: PlatformId,
  mode: PublishMode,
  publishTime: number | null,
  now: number,
): ScheduleValidationError | null {
  if (mode !== 'scheduled') return publishTime == null ? null : 'schedule_time_out_of_range';
  if (platform !== 'xiaohongshu') return 'schedule_platform_unsupported';
  if (publishTime == null || !Number.isFinite(publishTime)) return 'schedule_time_required';
  const ahead = publishTime - now;
  if (ahead < XHS_SCHEDULE_MIN_AHEAD_MS || ahead > XHS_SCHEDULE_MAX_AHEAD_MS) return 'schedule_time_out_of_range';
  return null;
}

