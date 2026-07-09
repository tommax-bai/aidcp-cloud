import type { ActionQuota, RiskAction } from './types.js';

export type QuotaRange = Record<RiskAction, [number, number]>;

export interface ColdStartDayPlan {
  day: number;
  quotas: QuotaRange;
}

export const COLD_START_PLANS: ColdStartDayPlan[] = [
  { day: 1, quotas: { view: [30, 50], like: [0, 3], collect: [0, 1], comment: [0, 0], follow: [0, 1], publish: [0, 0], comment_like: [0, 0], join_group: [0, 0] } },
  { day: 2, quotas: { view: [30, 50], like: [0, 3], collect: [0, 1], comment: [0, 0], follow: [0, 1], publish: [0, 0], comment_like: [0, 0], join_group: [0, 0] } },
  { day: 3, quotas: { view: [50, 80], like: [5, 10], collect: [1, 3], comment: [0, 1], follow: [1, 2], publish: [0, 0], comment_like: [0, 1], join_group: [0, 0] } },
  { day: 4, quotas: { view: [50, 80], like: [5, 10], collect: [1, 3], comment: [0, 1], follow: [1, 2], publish: [0, 0], comment_like: [0, 1], join_group: [0, 0] } },
  { day: 5, quotas: { view: [80, 120], like: [10, 20], collect: [3, 5], comment: [1, 3], follow: [2, 3], publish: [0, 1], comment_like: [0, 2], join_group: [0, 1] } },
  { day: 6, quotas: { view: [80, 120], like: [10, 20], collect: [3, 5], comment: [1, 3], follow: [2, 3], publish: [0, 1], comment_like: [0, 2], join_group: [0, 1] } },
  { day: 7, quotas: { view: [80, 120], like: [10, 20], collect: [3, 5], comment: [1, 3], follow: [2, 3], publish: [0, 1], comment_like: [0, 2], join_group: [0, 1] } },
];

export interface ColdStartPlannerOptions {
  random?: () => number;
}

export class ColdStartPlanner {
  private readonly random: () => number;

  constructor(options: ColdStartPlannerOptions = {}) {
    this.random = options.random ?? Math.random;
  }

  quotaForAccountAge(accountAgeDays: number): ActionQuota | null {
    const day = Math.floor(accountAgeDays) + 1;
    const plan = COLD_START_PLANS.find((candidate) => candidate.day === day);
    if (!plan) return null;
    return Object.fromEntries(
      Object.entries(plan.quotas).map(([action, range]) => [action, sampleInteger(range[0], range[1], this.random)]),
    ) as ActionQuota;
  }

  quotaOverride(createdAt: Date, now = new Date()): ActionQuota | null {
    const ageDays = Math.max(0, Math.floor((now.getTime() - createdAt.getTime()) / 86_400_000));
    return this.quotaForAccountAge(ageDays);
  }
}

function sampleInteger(min: number, max: number, random: () => number): number {
  if (min === max) return min;
  return min + Math.floor(random() * (max - min + 1));
}