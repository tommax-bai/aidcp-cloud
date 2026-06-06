import { RISK_ACTIONS, type CounterEvent, type RiskAction, type RiskWindow } from './types.js';

const WINDOW_MS: Record<RiskWindow, number> = {
  minute: 60_000,
  hour: 60 * 60_000,
  day: 24 * 60 * 60_000,
};

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
    const since = at - WINDOW_MS[window];
    return this.events
      .filter((event) => event.action === action && event.occurredAt > since && event.occurredAt <= at)
      .reduce((sum, event) => sum + event.count, 0);
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