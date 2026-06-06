export interface TimeSlot {
  name: string;
  startMinute: number;
  endMinute: number;
  weekdayProbability: number;
  weekendProbability: number;
}

export interface ScheduledSession {
  slot: TimeSlot;
  startAt: Date;
  probability: number;
  shouldStart: boolean;
  viewOnly: boolean;
}

export interface TimeSchedulerOptions {
  random?: () => number;
}

export const ACTIVE_TIME_SLOTS: TimeSlot[] = [
  { name: 'late-night', startMinute: 0, endMinute: 390, weekdayProbability: 0.02, weekendProbability: 0.05 },
  { name: 'morning', startMinute: 390, endMinute: 540, weekdayProbability: 0.35, weekendProbability: 0.2 },
  { name: 'forenoon', startMinute: 540, endMinute: 720, weekdayProbability: 0.3, weekendProbability: 0.45 },
  { name: 'noon', startMinute: 720, endMinute: 840, weekdayProbability: 0.55, weekendProbability: 0.5 },
  { name: 'afternoon', startMinute: 840, endMinute: 1080, weekdayProbability: 0.3, weekendProbability: 0.55 },
  { name: 'dinner', startMinute: 1080, endMinute: 1200, weekdayProbability: 0.4, weekendProbability: 0.45 },
  { name: 'prime', startMinute: 1200, endMinute: 1410, weekdayProbability: 0.85, weekendProbability: 0.9 },
  { name: 'bedtime', startMinute: 1410, endMinute: 1440, weekdayProbability: 0.3, weekendProbability: 0.45 },
];

export class TimeScheduler {
  private readonly random: () => number;

  constructor(options: TimeSchedulerOptions = {}) {
    this.random = options.random ?? Math.random;
  }

  evaluate(date: Date): ScheduledSession {
    const slot = slotForDate(date);
    const weekend = isWeekend(date);
    const probability = weekend ? slot.weekendProbability : slot.weekdayProbability;
    return {
      slot,
      startAt: jitteredStart(date, slot, this.random),
      probability,
      shouldStart: this.random() < probability,
      viewOnly: slot.name === 'late-night',
    };
  }

  planDay(date: Date): ScheduledSession[] {
    return ACTIVE_TIME_SLOTS.map((slot) => {
      const probability = isWeekend(date) ? slot.weekendProbability : slot.weekdayProbability;
      return {
        slot,
        startAt: jitteredStart(date, slot, this.random),
        probability,
        shouldStart: this.random() < probability,
        viewOnly: slot.name === 'late-night',
      };
    });
  }
}

export function slotForDate(date: Date): TimeSlot {
  const minute = date.getHours() * 60 + date.getMinutes();
  return ACTIVE_TIME_SLOTS.find((slot) => minute >= slot.startMinute && minute < slot.endMinute) ?? ACTIVE_TIME_SLOTS[0];
}

export function isWeekend(date: Date): boolean {
  const day = date.getDay();
  return day === 0 || day === 6;
}

function jitteredStart(date: Date, slot: TimeSlot, random: () => number): Date {
  const result = new Date(date);
  result.setHours(0, 0, 0, 0);
  const jitterMinutes = clamp(gaussian(random) * 12, -30, 30);
  result.setTime(result.getTime() + (slot.startMinute + Math.round(jitterMinutes)) * 60_000);
  return result;
}

function gaussian(random: () => number): number {
  const u1 = Math.max(Number.EPSILON, random());
  const u2 = Math.max(Number.EPSILON, random());
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}