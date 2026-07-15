export class InteractionMetrics {
  private readonly counters = new Map<string, number>();
  private readonly gauges = new Map<string, number>();

  increment(name: string, labels: Record<string, string> = {}, by = 1): void {
    const key = `${name}|${Object.entries(labels).sort().map(([k, v]) => `${k}=${v}`).join(',')}`;
    this.counters.set(key, (this.counters.get(key) ?? 0) + by);
  }

  gauge(name: string, value: number, labels: Record<string, string> = {}): void {
    const key = `${name}|${Object.entries(labels).sort().map(([k, v]) => `${k}=${v}`).join(',')}`;
    this.gauges.set(key, value);
  }

  snapshot(): { counters: Record<string, number>; gauges: Record<string, number> } {
    return { counters: Object.fromEntries(this.counters), gauges: Object.fromEntries(this.gauges) };
  }
}
