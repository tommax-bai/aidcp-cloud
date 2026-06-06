export interface SearchFrequencyLimiterOptions {
  clock?: () => number;
  maxPerSession?: number;
  maxPerDay?: number;
  recentLimit?: number;
}

export interface SearchDecision {
  allowed: boolean;
  reason?: 'session_limit' | 'daily_limit';
}

interface SearchRecord {
  keyword: string;
  searchedAt: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

export class SearchFrequencyLimiter {
  private readonly clock: () => number;
  private readonly maxPerSession: number;
  private readonly maxPerDay: number;
  private readonly recentLimit: number;
  private readonly sessionCounts = new Map<string, number>();
  private readonly dailyRecords: SearchRecord[] = [];
  private readonly recentKeywords: string[] = [];

  constructor(options: SearchFrequencyLimiterOptions = {}) {
    this.clock = options.clock ?? Date.now;
    this.maxPerSession = options.maxPerSession ?? 1;
    this.maxPerDay = options.maxPerDay ?? 3;
    this.recentLimit = options.recentLimit ?? 20;
  }

  canSearch(keyword: string): boolean {
    return this.explain(keyword).allowed;
  }

  explain(keyword: string): SearchDecision {
    const normalizedKeyword = this.normalize(keyword);
    this.pruneDailyRecords();
    if ((this.sessionCounts.get(normalizedKeyword) ?? 0) >= this.maxPerSession) {
      return { allowed: false, reason: 'session_limit' };
    }
    if (this.dailyRecords.filter((record) => record.keyword === normalizedKeyword).length >= this.maxPerDay) {
      return { allowed: false, reason: 'daily_limit' };
    }
    return { allowed: true };
  }

  recordSearch(keyword: string): boolean {
    const decision = this.explain(keyword);
    if (!decision.allowed) return false;
    const normalizedKeyword = this.normalize(keyword);
    this.sessionCounts.set(normalizedKeyword, (this.sessionCounts.get(normalizedKeyword) ?? 0) + 1);
    this.dailyRecords.push({ keyword: normalizedKeyword, searchedAt: this.clock() });
    this.recentKeywords.push(normalizedKeyword);
    while (this.recentKeywords.length > this.recentLimit) this.recentKeywords.shift();
    return true;
  }

  resetSession(): void {
    this.sessionCounts.clear();
  }

  recentSearches(): string[] {
    return [...this.recentKeywords];
  }

  private pruneDailyRecords(): void {
    const earliest = this.clock() - DAY_MS;
    while (this.dailyRecords[0] && this.dailyRecords[0].searchedAt <= earliest) this.dailyRecords.shift();
  }

  private normalize(keyword: string): string {
    return keyword.trim().toLowerCase();
  }
}