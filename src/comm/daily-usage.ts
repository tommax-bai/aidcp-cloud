import { UI_DAILY_USAGE_ACTIONS } from './protocol.js';
import type { UiDailyUsageAction, UiDailyUsageCounts } from './protocol.js';

/**
 * Materialize the complete client metric union before platform projection.
 * Missing risk totals are real zeroes only at this Cloud-owned aggregation boundary.
 */
export function pickDailyUsageCounts(source: Partial<Record<string, number>>): UiDailyUsageCounts {
  const counts: UiDailyUsageCounts = {};
  for (const action of UI_DAILY_USAGE_ACTIONS) {
    const value = source[action];
    counts[action] = Number.isFinite(value) ? Math.max(0, Math.floor(Number(value))) : 0;
  }
  return counts;
}

/** Runtime session counters use historical plural field names; the client contract uses RiskAction names. */
const SESSION_USAGE_MAPPINGS: ReadonlyArray<readonly [UiDailyUsageAction, string]> = [
  ['search', 'searches'],
  ['like', 'likes'],
  ['collect', 'collects'],
  ['comment', 'comments'],
  ['follow', 'follows'],
];

export function pickSessionUsageCounts(source: object | null | undefined): UiDailyUsageCounts {
  const values = (source ?? {}) as Partial<Record<string, number>>;
  const counts: UiDailyUsageCounts = {};
  for (const [action, key] of SESSION_USAGE_MAPPINGS) {
    const value = values[key];
    if (Number.isFinite(value)) counts[action] = Math.max(0, Math.floor(Number(value)));
  }
  return counts;
}

/**
 * Session interactions are authoritative for their plural budget counters; risk totals fill the remaining actions.
 * This prevents a session search KPI from silently borrowing the since-start risk count when the session snapshot exists.
 */
export function completeSessionUsageCounts(
  budgetTotals: object | null | undefined,
  riskTotals: Partial<Record<string, number>> | null,
  publishCount: number | null,
): UiDailyUsageCounts {
  const totals = pickDailyUsageCounts(riskTotals ?? {});
  const interactions = pickSessionUsageCounts(budgetTotals);
  for (const action of ['search', 'like', 'collect', 'comment', 'follow'] as const) {
    totals[action] = interactions[action] ?? totals[action] ?? 0;
  }
  totals.publish = typeof publishCount === 'number' && Number.isFinite(publishCount)
    ? Math.max(0, Math.floor(publishCount))
    : (totals.publish ?? 0);
  return totals;
}
