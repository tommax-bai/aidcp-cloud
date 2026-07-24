import type {
  FacebookGroupJoinRecentScheduledResult,
  FacebookGroupScopedTargetCount,
} from '../kernel/facebook-group-types.js';
import { isValidWeekActiveMask } from '../risk/session-limits.js';
import type {
  ContentScheduleCatalogRow,
  FacebookJoinGroupAutomationCatalogView,
} from './content-schedule-store.js';
import type { FacebookGroupJoinAutomationConfigRow } from './facebook-group-join-automation-store.js';

export interface FacebookGroupJoinAutomationViewInput {
  config: FacebookGroupJoinAutomationConfigRow;
  riskDailyCap: number;
  effectiveActiveWeekMask: string | null;
  effectiveContentActiveMask: string | null;
  accountGroupLabel: string | null;
  scopedTargetCount: number;
  recentResult: FacebookGroupJoinRecentScheduledResult | null;
}

export interface FacebookGroupJoinAutomationFailClosedProjectionInput {
  config: FacebookGroupJoinAutomationConfigRow;
  effectiveActiveWeekMask: string | null;
  effectiveContentActiveMask: string | null;
  loadRiskDailyCap(): Promise<number>;
  loadScope(): Promise<{ accountGroupLabel: string | null; count: number }>;
  loadRecentResult(): Promise<FacebookGroupJoinRecentScheduledResult | null>;
}

export const FACEBOOK_JOIN_CATALOG_RISK_CONCURRENCY = 2;

export interface FacebookGroupJoinAutomationCatalogProjectionDeps {
  getConfig(accountId: string): FacebookGroupJoinAutomationConfigRow;
  loadRiskDailyCap(accountId: string): Promise<number>;
  loadScopes(accountIds: readonly string[]): Promise<Map<string, FacebookGroupScopedTargetCount>>;
  loadRecentResults(
    accountIds: readonly string[],
  ): Promise<Map<string, FacebookGroupJoinRecentScheduledResult>>;
  riskConcurrency?: number;
}

export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  mapper: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) return [];
  const requested = Number.isFinite(concurrency) ? Math.trunc(concurrency) : 1;
  const limit = Math.min(items.length, Math.max(1, requested));
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  const worker = async (): Promise<void> => {
    while (nextIndex < items.length) {
      const index = nextIndex++;
      results[index] = await mapper(items[index]!, index);
    }
  };
  await Promise.all(Array.from({ length: limit }, () => worker()));
  return results;
}

/** null means the required content mask is missing/invalid, so catalog and runtime both fail closed. */
export function intersectFacebookGroupJoinAutomationMasks(
  activeMask: string | null,
  contentMask: string | null,
  joinMask: string | null,
): string | null {
  if (!isValidWeekActiveMask(contentMask)) return null;
  if (activeMask !== null && !isValidWeekActiveMask(activeMask)) return null;
  if (joinMask !== null && !isValidWeekActiveMask(joinMask)) return null;
  const active = activeMask ?? '1'.repeat(168);
  const action = joinMask ?? '1'.repeat(168);
  return [...contentMask]
    .map((cell, index) => cell === '1' && active[index] === '1' && action[index] === '1' ? '1' : '0')
    .join('');
}

export function buildFacebookGroupJoinAutomationCatalogView(
  input: FacebookGroupJoinAutomationViewInput,
): FacebookJoinGroupAutomationCatalogView {
  const scopedTargetCount = Math.max(0, Math.trunc(input.scopedTargetCount));
  return {
    enabled: input.config.enabled,
    dailyCap: input.config.dailyCap,
    effectiveDailyCap: Math.max(0, Math.min(input.config.dailyCap, Math.trunc(input.riskDailyCap))),
    weekMask: input.config.weekMask,
    weekMaskSource: input.config.weekMask === null ? 'content' : 'custom',
    effectiveWeekMask: intersectFacebookGroupJoinAutomationMasks(
      input.effectiveActiveWeekMask,
      input.effectiveContentActiveMask,
      input.config.weekMask,
    ),
    accountGroupLabel: input.accountGroupLabel,
    scopedTargetCount,
    scopeReady: input.accountGroupLabel !== null && scopedTargetCount > 0,
    recentResult: input.recentResult,
    updatedAt: input.config.updatedAt,
    updatedBy: input.config.updatedBy,
  };
}

/**
 * A config UPSERT has already committed when this helper is used. Read-side failures therefore
 * degrade only derived fields and must never turn a successful durable write into a fake 500.
 */
export async function buildFacebookGroupJoinAutomationCatalogViewFailClosed(
  input: FacebookGroupJoinAutomationFailClosedProjectionInput,
): Promise<FacebookJoinGroupAutomationCatalogView> {
  const [riskDailyCap, scope, recentResult] = await Promise.all([
    input.loadRiskDailyCap().catch(() => 0),
    input.loadScope().catch(() => ({ accountGroupLabel: null, count: 0 })),
    input.loadRecentResult().catch(() => null),
  ]);
  return buildFacebookGroupJoinAutomationCatalogView({
    config: input.config,
    riskDailyCap,
    effectiveActiveWeekMask: input.effectiveActiveWeekMask,
    effectiveContentActiveMask: input.effectiveContentActiveMask,
    accountGroupLabel: scope.accountGroupLabel,
    scopedTargetCount: scope.count,
    recentResult,
  });
}

/**
 * Projects all Facebook rows without an O(accounts) connection burst: scope and audit each use one
 * batch query, while RiskController resolution is capped at a small fixed worker count.
 */
export async function projectFacebookGroupJoinAutomationCatalog(
  rows: readonly ContentScheduleCatalogRow[],
  deps: FacebookGroupJoinAutomationCatalogProjectionDeps,
): Promise<ContentScheduleCatalogRow[]> {
  const facebookRows = rows.filter((row) => row.platform === 'facebook');
  if (facebookRows.length === 0) return [...rows];
  const accountIds = facebookRows.map((row) => row.accountId);
  const riskConcurrency = deps.riskConcurrency ?? FACEBOOK_JOIN_CATALOG_RISK_CONCURRENCY;
  const [scopes, recentResults, riskEntries] = await Promise.all([
    deps.loadScopes(accountIds),
    deps.loadRecentResults(accountIds),
    mapWithConcurrency(facebookRows, riskConcurrency, async (row) => [
      row.accountId,
      await deps.loadRiskDailyCap(row.accountId),
    ] as const),
  ]);
  const riskCaps = new Map(riskEntries);
  return rows.map((row) => {
    if (row.platform !== 'facebook') return row;
    const scope = scopes.get(row.accountId) ?? { accountGroupLabel: null, count: 0 };
    return {
      ...row,
      joinGroupAutomation: buildFacebookGroupJoinAutomationCatalogView({
        config: deps.getConfig(row.accountId),
        riskDailyCap: riskCaps.get(row.accountId) ?? 0,
        effectiveActiveWeekMask: row.effectiveActiveWeekMask,
        effectiveContentActiveMask: row.effectiveContentActiveMask,
        accountGroupLabel: scope.accountGroupLabel,
        scopedTargetCount: scope.count,
        recentResult: recentResults.get(row.accountId) ?? null,
      }),
    };
  });
}
