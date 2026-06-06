import { DAILY_QUOTAS } from './quotas.js';
import type { RiskQuotaLevel } from './types.js';

export interface SessionBudgetOptions {
  quotaLevel: RiskQuotaLevel;
  random?: () => number;
  naturalLeaveProbability?: number;
}

export interface SessionBudgetSnapshot {
  quotaLevel: RiskQuotaLevel;
  durationMs: number;
  maxActions: number;
  naturalLeaveProbability: number;
  startedAt: number;
}

const SESSION_LIMITS: Record<RiskQuotaLevel, { minutes: number; actions: number }> = {
  conservative: { minutes: 15, actions: 30 },
  normal: { minutes: 30, actions: 60 },
  aggressive: { minutes: 60, actions: 120 },
};

export class SessionBudget {
  readonly quotaLevel: RiskQuotaLevel;
  readonly durationMs: number;
  readonly maxActions: number;
  readonly naturalLeaveProbability: number;
  readonly startedAt: number;

  private readonly random: () => number;
  private actions = 0;

  constructor(options: SessionBudgetOptions) {
    this.random = options.random ?? Math.random;
    this.quotaLevel = options.quotaLevel;
    const limit = SESSION_LIMITS[options.quotaLevel];
    this.durationMs = sampleSessionDurationMs(limit.minutes, this.random);
    this.maxActions = limit.actions;
    this.naturalLeaveProbability = clamp(options.naturalLeaveProbability ?? sampleUniform(0.02, 0.05, this.random), 0.02, 0.05);
    this.startedAt = Date.now();
  }

  recordAction(): void {
    this.actions += 1;
  }

  shouldEnd(now = Date.now()): boolean {
    if (now - this.startedAt >= this.durationMs) return true;
    if (this.actions >= this.maxActions) return true;
    return this.random() < this.naturalLeaveProbability;
  }

  remainingActions(): number {
    return Math.max(0, this.maxActions - this.actions);
  }

  snapshot(): SessionBudgetSnapshot {
    return {
      quotaLevel: this.quotaLevel,
      durationMs: this.durationMs,
      maxActions: this.maxActions,
      naturalLeaveProbability: this.naturalLeaveProbability,
      startedAt: this.startedAt,
    };
  }
}

export function hourlyDecayFactor(consecutiveActiveHours: number): number {
  return Math.max(0.3, 1 - 0.25 * (Math.max(1, consecutiveActiveHours) - 1));
}

export function applyHourlyDecay(baseQuota: number, consecutiveActiveHours: number): number {
  return Math.floor(baseQuota * hourlyDecayFactor(consecutiveActiveHours));
}

export function levelDailyActionLimit(level: RiskQuotaLevel): number {
  return Object.values(DAILY_QUOTAS[level]).reduce((sum, value) => sum + value, 0);
}

function sampleSessionDurationMs(maxMinutes: number, random: () => number): number {
  const minMinutes = 15;
  const median = Math.sqrt(minMinutes * maxMinutes);
  const minutes = Math.exp(Math.log(median) + gaussian(random) * 0.45);
  return Math.round(clamp(minutes, minMinutes, maxMinutes) * 60_000);
}

function sampleUniform(min: number, max: number, random: () => number): number {
  return min + (max - min) * random();
}

function gaussian(random: () => number): number {
  const u1 = Math.max(Number.EPSILON, random());
  const u2 = Math.max(Number.EPSILON, random());
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}