import { RISK_ACTIONS, type ActionQuota, type RiskAction } from './types.js';

export type QuotaRange = Record<RiskAction, [number, number]>;

export interface ColdStartDayPlan {
  day: number;
  quotas: QuotaRange;
}

export const COLD_START_PLANS: ColdStartDayPlan[] = [
  { day: 1, quotas: { view: [30, 50], like: [0, 3], collect: [0, 1], comment: [0, 0], follow: [0, 1], publish: [0, 0], comment_like: [0, 0], join_group: [0, 0], dm_reply: [0, 0] } },
  { day: 2, quotas: { view: [30, 50], like: [0, 3], collect: [0, 1], comment: [0, 0], follow: [0, 1], publish: [0, 0], comment_like: [0, 0], join_group: [0, 0], dm_reply: [0, 0] } },
  { day: 3, quotas: { view: [50, 80], like: [5, 10], collect: [1, 3], comment: [0, 1], follow: [1, 2], publish: [0, 0], comment_like: [0, 1], join_group: [0, 0], dm_reply: [0, 0] } },
  { day: 4, quotas: { view: [50, 80], like: [5, 10], collect: [1, 3], comment: [0, 1], follow: [1, 2], publish: [0, 0], comment_like: [0, 1], join_group: [0, 0], dm_reply: [0, 0] } },
  { day: 5, quotas: { view: [80, 120], like: [10, 20], collect: [3, 5], comment: [1, 3], follow: [2, 3], publish: [0, 1], comment_like: [0, 2], join_group: [0, 1], dm_reply: [0, 0] } },
  { day: 6, quotas: { view: [80, 120], like: [10, 20], collect: [3, 5], comment: [1, 3], follow: [2, 3], publish: [0, 1], comment_like: [0, 2], join_group: [0, 1], dm_reply: [0, 0] } },
  { day: 7, quotas: { view: [80, 120], like: [10, 20], collect: [3, 5], comment: [1, 3], follow: [2, 3], publish: [0, 1], comment_like: [0, 2], join_group: [0, 1], dm_reply: [0, 0] } },
];

/**
 * Facebook 冷启动曲线（change account-nurture-discipline-spine）：比小红书更保守。
 * FB 封号比小红书激进，养号教程要求「新号前几天低量、按天数逐步放开」。约束：
 * D1-3 仅浏览 + 极少点赞、无评论无发布；comment 不早于 D3；publish/join_group 不早于 D5。
 * collect / comment_like 是小红书特有语义，FB 无对应概念 → 恒 0。区间上界即当日天花板。
 */
export const FB_COLD_START_PLANS: ColdStartDayPlan[] = [
  { day: 1, quotas: { view: [10, 20], like: [0, 2], collect: [0, 0], comment: [0, 0], follow: [0, 1], publish: [0, 0], comment_like: [0, 0], join_group: [0, 0], dm_reply: [0, 0] } },
  { day: 2, quotas: { view: [15, 25], like: [0, 3], collect: [0, 0], comment: [0, 0], follow: [0, 1], publish: [0, 0], comment_like: [0, 0], join_group: [0, 0], dm_reply: [0, 0] } },
  { day: 3, quotas: { view: [20, 35], like: [3, 6], collect: [0, 0], comment: [0, 1], follow: [1, 2], publish: [0, 0], comment_like: [0, 0], join_group: [0, 1], dm_reply: [0, 0] } },
  { day: 4, quotas: { view: [25, 40], like: [5, 8], collect: [0, 0], comment: [1, 2], follow: [1, 2], publish: [0, 0], comment_like: [0, 0], join_group: [0, 1], dm_reply: [0, 0] } },
  { day: 5, quotas: { view: [30, 50], like: [6, 12], collect: [0, 0], comment: [1, 3], follow: [2, 3], publish: [0, 1], comment_like: [0, 0], join_group: [1, 2], dm_reply: [0, 0] } },
  { day: 6, quotas: { view: [40, 60], like: [8, 15], collect: [0, 0], comment: [2, 4], follow: [2, 4], publish: [0, 1], comment_like: [0, 0], join_group: [1, 2], dm_reply: [0, 0] } },
  { day: 7, quotas: { view: [50, 70], like: [10, 18], collect: [0, 0], comment: [2, 5], follow: [3, 5], publish: [1, 1], comment_like: [0, 0], join_group: [1, 3], dm_reply: [0, 0] } },
];

/**
 * 确定性冷启动当日配额天花板（change account-nurture-discipline-spine）。
 * 用区间**上界**作当日天花板——`effectiveQuotas()` 每次调用都要现算, 绝不能像
 * `quotaForAccountAge` 那样随机采样(会让配额逐调用抖动)。account 年龄超冷启动窗口(7天) → null(毕业)。
 * platform === 'facebook' → 更保守 FB 曲线, 否则小红书曲线。
 *
 * **平台未确认（platform == null）→ 返回 null（不 clamp），MUST NOT 回落小红书曲线**
 * （change account-level-slow-start，design D5）。旧行为是「非 facebook 一律 XHS」，于是平台解析
 * 失败的 FB 号会按 XHS 曲线跑：D1 上限取 view=50 而非 FB 的 20（差 2.5 倍），且无日志无告警。
 * FB 那条更保守的曲线正是慢启动唯一的存在理由，静默按更松的曲线跑比不 clamp 更危险。
 * 调用方据 null 判 eligible=false 并如实说明，绝不静默假装在压低。
 */
export function coldStartDailyCap(accountAgeDays: number, platform?: string): ActionQuota | null {
  if (platform == null) return null;
  const day = Math.floor(Math.max(0, accountAgeDays)) + 1;
  const plans = platform === 'facebook' ? FB_COLD_START_PLANS : COLD_START_PLANS;
  const plan = plans.find((candidate) => candidate.day === day);
  if (!plan) return null;
  return Object.fromEntries(RISK_ACTIONS.map((action) => [action, plan.quotas[action][1]])) as ActionQuota;
}

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
