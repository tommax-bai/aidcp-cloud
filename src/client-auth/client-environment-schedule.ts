import type { EffectiveContentSchedule } from '../config/content-schedule-store.js';

export const CLIENT_SCHEDULE_DAYS = [
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
  'sunday',
] as const;

export type ClientScheduleDay = (typeof CLIENT_SCHEDULE_DAYS)[number];
export type ClientScheduleActionKey = 'post' | 'comment' | 'contact_comment';

export interface ClientScheduleRange {
  startHour: number;
  endHour: number;
}

export interface ClientScheduleDayView {
  day: ClientScheduleDay;
  activityRanges: ClientScheduleRange[];
  contentRanges: ClientScheduleRange[];
}

export interface ClientScheduleActionView {
  key: ClientScheduleActionKey;
  label: string;
  dailyCap: number;
  approval: 'review' | 'automatic';
  resultCopy: string;
}

export interface ClientScheduleOccurrence extends ClientScheduleRange {
  day: ClientScheduleDay;
  dayIndex: number;
  dayOffset: number;
  startsAt: number;
  endsAt: number;
}

export interface ClientEnvironmentScheduleView {
  timezone: string;
  weekStartsOn: 'monday';
  autoEnabled: boolean;
  days: ClientScheduleDayView[];
  actions: ClientScheduleActionView[];
  windows: {
    currentActivity: ClientScheduleOccurrence | null;
    currentContent: ClientScheduleOccurrence | null;
    nextActivity: ClientScheduleOccurrence | null;
    nextContent: ClientScheduleOccurrence | null;
  };
}

const FULL_MASK = '1'.repeat(168);
const EMPTY_MASK = '0'.repeat(168);

function isValidScheduleMask(value: unknown): value is string {
  return typeof value === 'string' && value.length === 168 && /^[01]+$/.test(value);
}

function mondayBasedDayIndex(date: Date): number {
  return (date.getDay() + 6) % 7;
}

function normalizedMasks(schedule: EffectiveContentSchedule): { activity: string; content: string } {
  const activity = isValidScheduleMask(schedule.effectiveActiveWeekMask)
    ? schedule.effectiveActiveWeekMask
    : FULL_MASK;
  const rawContent = isValidScheduleMask(schedule.effectiveMask) ? schedule.effectiveMask : EMPTY_MASK;
  const content = Array.from(rawContent, (cell, index) =>
    cell === '1' && activity[index] === '1' ? '1' : '0').join('');
  return { activity, content };
}

function rangesForDay(mask: string, dayIndex: number): ClientScheduleRange[] {
  const ranges: ClientScheduleRange[] = [];
  const start = dayIndex * 24;
  let rangeStart: number | null = null;
  for (let hour = 0; hour <= 24; hour += 1) {
    const active = hour < 24 && mask[start + hour] === '1';
    if (active && rangeStart === null) rangeStart = hour;
    if (!active && rangeStart !== null) {
      ranges.push({ startHour: rangeStart, endHour: hour });
      rangeStart = null;
    }
  }
  return ranges;
}

function localOccurrence(
  now: Date,
  todayIndex: number,
  dayOffset: number,
  range: ClientScheduleRange,
): ClientScheduleOccurrence {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() + dayOffset);
  start.setHours(range.startHour, 0, 0, 0);
  const end = new Date(start);
  end.setHours(range.endHour, 0, 0, 0);
  return {
    day: CLIENT_SCHEDULE_DAYS[(todayIndex + dayOffset) % 7],
    dayIndex: (todayIndex + dayOffset) % 7,
    dayOffset,
    startHour: range.startHour,
    endHour: range.endHour,
    startsAt: start.getTime(),
    endsAt: end.getTime(),
  };
}

function currentOccurrence(
  now: Date,
  days: ClientScheduleDayView[],
  kind: 'activityRanges' | 'contentRanges',
): ClientScheduleOccurrence | null {
  const dayIndex = mondayBasedDayIndex(now);
  const minuteOfDay = now.getHours() * 60 + now.getMinutes();
  const range = days[dayIndex][kind].find(
    (candidate) => minuteOfDay >= candidate.startHour * 60 && minuteOfDay < candidate.endHour * 60,
  );
  return range ? localOccurrence(now, dayIndex, 0, range) : null;
}

function nextOccurrence(
  now: Date,
  days: ClientScheduleDayView[],
  kind: 'activityRanges' | 'contentRanges',
): ClientScheduleOccurrence | null {
  const todayIndex = mondayBasedDayIndex(now);
  const nowMs = now.getTime();
  for (let dayOffset = 0; dayOffset <= 7; dayOffset += 1) {
    const day = days[(todayIndex + dayOffset) % 7];
    for (const range of day[kind]) {
      const occurrence = localOccurrence(now, todayIndex, dayOffset, range);
      if (occurrence.startsAt > nowMs) return occurrence;
    }
  }
  return null;
}

function actionView(
  key: ClientScheduleActionKey,
  enabled: boolean,
  mode: EffectiveContentSchedule['postMode'],
  dailyCap: number,
): ClientScheduleActionView | null {
  if (!enabled || mode === 'off' || dailyCap <= 0) return null;
  const automatic = mode === 'auto_approve';
  const labels: Record<ClientScheduleActionKey, string> = {
    post: '创作与发布',
    comment: '评论互动',
    contact_comment: '联系评论',
  };
  const reviewCopy: Record<ClientScheduleActionKey, string> = {
    post: '草稿完成后等你确认',
    comment: '互动内容完成后等你确认',
    contact_comment: '联系内容完成后等你确认',
  };
  const automaticCopy: Record<ClientScheduleActionKey, string> = {
    post: '检查通过后按安排发布',
    comment: '检查通过后按安排互动',
    contact_comment: '检查通过后按安排联系',
  };
  return {
    key,
    label: labels[key],
    dailyCap,
    approval: automatic ? 'automatic' : 'review',
    resultCopy: automatic ? automaticCopy[key] : reviewCopy[key],
  };
}

export function projectClientEnvironmentSchedule(
  schedule: EffectiveContentSchedule,
  options: { now?: number; timezone?: string } = {},
): ClientEnvironmentScheduleView {
  const now = new Date(options.now ?? Date.now());
  const timezone = options.timezone
    || Intl.DateTimeFormat().resolvedOptions().timeZone
    || 'system';
  const masks = normalizedMasks(schedule);
  const days = CLIENT_SCHEDULE_DAYS.map((day, dayIndex) => ({
    day,
    activityRanges: rangesForDay(masks.activity, dayIndex),
    contentRanges: rangesForDay(masks.content, dayIndex),
  }));
  const actions = schedule.autoEnabled
    ? [
        actionView('post', schedule.postEnabled, schedule.postMode, schedule.postDailyCap),
        actionView('comment', schedule.commentEnabled, schedule.commentMode, schedule.commentDailyCap),
        actionView(
          'contact_comment',
          schedule.contactCommentEnabled,
          schedule.contactCommentMode,
          schedule.contactCommentDailyCap,
        ),
      ].filter((action): action is ClientScheduleActionView => action !== null)
    : [];
  return {
    timezone,
    weekStartsOn: 'monday',
    autoEnabled: schedule.autoEnabled,
    days,
    actions,
    windows: {
      currentActivity: currentOccurrence(now, days, 'activityRanges'),
      currentContent: currentOccurrence(now, days, 'contentRanges'),
      nextActivity: nextOccurrence(now, days, 'activityRanges'),
      nextContent: nextOccurrence(now, days, 'contentRanges'),
    },
  };
}
