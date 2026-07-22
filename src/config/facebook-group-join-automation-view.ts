import type { FacebookGroupJoinRecentScheduledResult } from '../comment-agent/facebook-group-store.js';
import { isValidWeekActiveMask } from '../risk/session-limits.js';
import type { FacebookJoinGroupAutomationCatalogView } from './content-schedule-store.js';
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
