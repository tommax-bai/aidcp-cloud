/**
 * Platform source-published-time normalization.
 *
 * The raw platform text is evidence. The normalized timestamp is a derived value anchored to the
 * Cloud event timestamp and an explicit fixed UTC offset. Consumers must honor `precision` and
 * must not present a day-level representative timestamp as an exact time of day.
 */

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

export const SHANGHAI_UTC_OFFSET_MINUTES = 8 * 60;

export type SourcePublishedAtPrecision = 'minute' | 'hour' | 'day';
export type SourcePublishedAtStatus = 'parsed' | 'unparseable';

export interface SourcePublishedTime {
  rawText: string;
  status: SourcePublishedAtStatus;
  publishedAt: number | null;
  precision: SourcePublishedAtPrecision | null;
  observedAt: number;
}

export interface NormalizeSourcePublishedTimeOptions {
  observedAt: number;
  /** Fixed platform-local UTC offset. XHS uses Asia/Shanghai (+08:00). */
  utcOffsetMinutes?: number;
}

interface LocalDateParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
}

function assertOptions(options: NormalizeSourcePublishedTimeOptions): number {
  if (!Number.isFinite(options.observedAt) || options.observedAt <= 0) {
    throw new RangeError('observedAt must be a positive finite epoch timestamp');
  }
  const offset = options.utcOffsetMinutes ?? SHANGHAI_UTC_OFFSET_MINUTES;
  if (!Number.isInteger(offset) || offset < -14 * 60 || offset > 14 * 60) {
    throw new RangeError('utcOffsetMinutes must be an integer between -840 and 840');
  }
  return offset;
}

function localParts(epochMs: number, utcOffsetMinutes: number): LocalDateParts {
  const shifted = new Date(epochMs + utcOffsetMinutes * MINUTE_MS);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
    hour: shifted.getUTCHours(),
    minute: shifted.getUTCMinutes(),
  };
}

function localEpoch(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  utcOffsetMinutes: number,
): number | null {
  if (
    !Number.isInteger(year) ||
    !Number.isInteger(month) ||
    !Number.isInteger(day) ||
    !Number.isInteger(hour) ||
    !Number.isInteger(minute) ||
    year < 1970 ||
    year > 9999 ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > 31 ||
    hour < 0 ||
    hour > 23 ||
    minute < 0 ||
    minute > 59
  ) {
    return null;
  }
  const epoch = Date.UTC(year, month - 1, day, hour, minute) - utcOffsetMinutes * MINUTE_MS;
  const roundTrip = localParts(epoch, utcOffsetMinutes);
  return roundTrip.year === year &&
    roundTrip.month === month &&
    roundTrip.day === day &&
    roundTrip.hour === hour &&
    roundTrip.minute === minute
    ? epoch
    : null;
}

function parsed(
  rawText: string,
  observedAt: number,
  publishedAt: number,
  precision: SourcePublishedAtPrecision,
): SourcePublishedTime {
  return { rawText, status: 'parsed', publishedAt, precision, observedAt };
}

function unparseable(rawText: string, observedAt: number): SourcePublishedTime {
  return { rawText, status: 'unparseable', publishedAt: null, precision: null, observedAt };
}

function nonNegativeInt(match: RegExpMatchArray | null): number | null {
  if (!match?.[1]) return null;
  const value = Number(match[1]);
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function localDayStartFromDelta(observedAt: number, daysAgo: number, utcOffsetMinutes: number): number | null {
  const observed = localParts(observedAt, utcOffsetMinutes);
  const observedDayStart = localEpoch(observed.year, observed.month, observed.day, 0, 0, utcOffsetMinutes);
  return observedDayStart === null ? null : observedDayStart - daysAgo * DAY_MS;
}

/**
 * Normalize a platform time string. Missing/blank text returns null; an unknown non-empty string is
 * retained as `unparseable`. This function never reads the ambient clock.
 */
export function normalizeSourcePublishedTime(
  text: string | null | undefined,
  options: NormalizeSourcePublishedTimeOptions,
): SourcePublishedTime | null {
  const rawText = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (!rawText) return null;
  const utcOffsetMinutes = assertOptions(options);
  const { observedAt } = options;
  const comparable = rawText.replace(/^(?:编辑于|发布于)\s*/, '');

  if (/刚刚/.test(comparable)) {
    return parsed(rawText, observedAt, observedAt, 'minute');
  }

  const minutesAgo = nonNegativeInt(comparable.match(/(\d+)\s*分钟前/));
  if (minutesAgo !== null) {
    return parsed(rawText, observedAt, observedAt - minutesAgo * MINUTE_MS, 'minute');
  }

  const hoursAgo = nonNegativeInt(comparable.match(/(\d+)\s*小时前/));
  if (hoursAgo !== null) {
    return parsed(rawText, observedAt, observedAt - hoursAgo * HOUR_MS, 'hour');
  }

  const relativeDay = comparable.match(/(昨天|前天|\d+\s*天前)(?:\s+(\d{1,2}):(\d{2}))?/);
  if (relativeDay) {
    const token = relativeDay[1];
    const daysAgo = token === '昨天' ? 1 : token === '前天' ? 2 : nonNegativeInt(token.match(/(\d+)/));
    if (daysAgo === null) return unparseable(rawText, observedAt);
    const dayStart = localDayStartFromDelta(observedAt, daysAgo, utcOffsetMinutes);
    if (dayStart === null) return unparseable(rawText, observedAt);
    if (relativeDay[2] !== undefined || relativeDay[3] !== undefined) {
      const hour = Number(relativeDay[2]);
      const minute = Number(relativeDay[3]);
      if (!Number.isInteger(hour) || hour < 0 || hour > 23 || !Number.isInteger(minute) || minute < 0 || minute > 59) {
        return unparseable(rawText, observedAt);
      }
      return parsed(rawText, observedAt, dayStart + hour * HOUR_MS + minute * MINUTE_MS, 'minute');
    }
    return parsed(rawText, observedAt, dayStart, 'day');
  }

  const explicitDate = comparable.match(/(?:(\d{4})[-/年])?(\d{1,2})[-/月](\d{1,2})日?(?:\s+(\d{1,2}):(\d{2}))?/);
  if (explicitDate) {
    const observed = localParts(observedAt, utcOffsetMinutes);
    let year = explicitDate[1] ? Number(explicitDate[1]) : observed.year;
    const month = Number(explicitDate[2]);
    const day = Number(explicitDate[3]);
    const hasTime = explicitDate[4] !== undefined || explicitDate[5] !== undefined;
    const hour = hasTime ? Number(explicitDate[4]) : 0;
    const minute = hasTime ? Number(explicitDate[5]) : 0;
    let epoch = localEpoch(year, month, day, hour, minute, utcOffsetMinutes);
    if (epoch === null) return unparseable(rawText, observedAt);
    // A month-day without a year means the most recent matching local date, never a future date.
    if (!explicitDate[1] && epoch > observedAt) {
      year -= 1;
      epoch = localEpoch(year, month, day, hour, minute, utcOffsetMinutes);
      if (epoch === null) return unparseable(rawText, observedAt);
    }
    // Explicit future dates are evidence of an unsupported/invalid platform string, not a publication time.
    if (epoch > observedAt) return unparseable(rawText, observedAt);
    return parsed(rawText, observedAt, epoch, hasTime ? 'minute' : 'day');
  }

  return unparseable(rawText, observedAt);
}

/** Derive a conservative minimum age in hours from a normalized result. */
export function sourcePublishedAgeHours(value: SourcePublishedTime): number | null {
  if (value.status !== 'parsed' || value.publishedAt === null || value.precision === null) return null;
  const youngestPublishedAt = value.precision === 'day' ? value.publishedAt + DAY_MS - 1 : value.publishedAt;
  return Math.max(0, (value.observedAt - youngestPublishedAt) / HOUR_MS);
}
