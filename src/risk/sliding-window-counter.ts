import { RISK_ACTIONS, type CounterEvent, type RiskAction, type RiskWindow } from './types.js';
import { nextShanghaiDayStartMs, shanghaiDayStartMs } from '../time/shanghai-day.js';

const WINDOW_MS: Record<RiskWindow, number> = {
  minute: 60_000,
  hour: 60 * 60_000,
  day: 24 * 60 * 60_000,
};

function eventInWindow(event: CounterEvent, action: RiskAction, window: RiskWindow, at: number): boolean {
  if (event.action !== action || event.occurredAt > at) return false;
  if (window === 'day') return event.occurredAt >= shanghaiDayStartMs(at);
  return event.occurredAt > at - WINDOW_MS[window];
}

export class SlidingWindowCounter {
  private readonly events: CounterEvent[] = [];
  private readonly clock: () => number;

  constructor(options: { clock?: () => number; initialEvents?: CounterEvent[] } = {}) {
    this.clock = options.clock ?? Date.now;
    if (options.initialEvents) this.events.push(...options.initialEvents);
    this.prune();
  }

  record(action: RiskAction, at = this.clock(), count = 1): void {
    this.events.push({ action, occurredAt: at, count });
    this.prune(at);
  }

  count(action: RiskAction, window: RiskWindow, at = this.clock()): number {
    return this.events
      .filter((event) => eventInWindow(event, action, window, at))
      .reduce((sum, event) => sum + event.count, 0);
  }

  retryAfterMs(action: RiskAction, window: RiskWindow, quota: number, at = this.clock()): number | undefined {
    if (quota <= 0) return undefined;
    const active = this.events
      .filter((event) => eventInWindow(event, action, window, at))
      .sort((a, b) => a.occurredAt - b.occurredAt);
    const total = active.reduce((sum, event) => sum + event.count, 0);
    if (total < quota) return 0;
    if (window === 'day') return Math.max(0, nextShanghaiDayStartMs(at) - at);

    let remaining = total;
    for (const event of active) {
      remaining -= event.count;
      if (remaining < quota) {
        return Math.max(0, event.occurredAt + WINDOW_MS[window] - at);
      }
    }
    return 0;
  }

  counts(window: RiskWindow, at = this.clock()): Record<RiskAction, number> {
    return Object.fromEntries(RISK_ACTIONS.map((action) => [action, this.count(action, window, at)])) as Record<
      RiskAction,
      number
    >;
  }

  snapshot(at = this.clock()): Record<RiskWindow, Record<RiskAction, number>> {
    return {
      minute: this.counts('minute', at),
      hour: this.counts('hour', at),
      day: this.counts('day', at),
    };
  }

  prune(at = this.clock()): void {
    const oldest = at - WINDOW_MS.day;
    while (this.events.length > 0 && this.events[0].occurredAt <= oldest) this.events.shift();
  }
}

export { WINDOW_MS };
