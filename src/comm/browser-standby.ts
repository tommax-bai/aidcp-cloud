import type { UiBrowserStandbyPayload } from './protocol.js';
import type { RiskAction, RiskWindow } from '../risk/types.js';

export const DEFAULT_BROWSER_STANDBY_MIN_WAIT_MS = 20 * 60_000;
export const DEFAULT_BROWSER_STANDBY_WARMUP_MS = 90_000;

const WAIT_WINDOWS: RiskWindow[] = ['minute', 'hour', 'day'];
const STANDBY_ACTION: RiskAction = 'view';

export interface BrowserStandbyConfig {
  enabled: boolean;
  minWaitMs: number;
  warmupMs: number;
}

export interface BrowserStandbyRiskSource {
  explain(action: RiskAction): { allowed: boolean; reason?: string; retryAfterMs?: number };
  quotaReleaseAfterMs(action: RiskAction, window: RiskWindow): number | undefined;
}

export interface BuildBrowserStandbyHintOptions {
  now?: number;
  config?: BrowserStandbyConfig;
}

export function resolveBrowserStandbyConfig(env: NodeJS.ProcessEnv = process.env): BrowserStandbyConfig {
  return {
    enabled: parseEnabled(env.AIDCP_BROWSER_COLD_STANDBY, true),
    minWaitMs: parsePositiveMs(env.AIDCP_BROWSER_COLD_STANDBY_MIN_WAIT_MS, DEFAULT_BROWSER_STANDBY_MIN_WAIT_MS),
    warmupMs: parsePositiveMs(env.AIDCP_BROWSER_COLD_STANDBY_WARMUP_MS, DEFAULT_BROWSER_STANDBY_WARMUP_MS),
  };
}

export function buildBrowserStandbyHint(
  source: BrowserStandbyRiskSource,
  options: BuildBrowserStandbyHintOptions = {},
): UiBrowserStandbyPayload {
  const config = options.config ?? resolveBrowserStandbyConfig();
  const generatedAt = Math.floor(options.now ?? Date.now());
  const payload = (reason: string, waitMs: number, eligible = false): UiBrowserStandbyPayload => {
    const safeWaitMs = Number.isFinite(waitMs) && waitMs > 0 ? Math.ceil(waitMs) : 0;
    return {
      enabled: config.enabled,
      eligible,
      reason,
      waitMs: safeWaitMs,
      wakeAt: generatedAt + safeWaitMs,
      generatedAt,
      source: 'risk',
      minWaitMs: config.minWaitMs,
      warmupMs: config.warmupMs,
    };
  };

  if (!config.enabled) return payload('disabled', 0, false);

  const decision = source.explain(STANDBY_ACTION);
  if (decision.allowed) return payload('no_wait', 0, false);
  if (!decision.reason?.startsWith('quota:')) return payload('hard_blocker', 0, false);

  const waits = WAIT_WINDOWS
    .map((window) => ({ window, waitMs: source.quotaReleaseAfterMs(STANDBY_ACTION, window) }))
    .filter((entry): entry is { window: RiskWindow; waitMs: number } =>
      typeof entry.waitMs === 'number' && Number.isFinite(entry.waitMs) && entry.waitMs > 0,
    );
  if (waits.length === 0) {
    const fallback = typeof decision.retryAfterMs === 'number' && Number.isFinite(decision.retryAfterMs) && decision.retryAfterMs > 0
      ? decision.retryAfterMs
      : 0;
    if (fallback <= 0) return payload('unknown_wait', 0, false);
    const eligible = fallback >= config.minWaitMs;
    return payload(eligible ? 'view_quota:unknown' : 'short_wait', fallback, eligible);
  }

  const maxWait = Math.max(...waits.map((entry) => entry.waitMs));
  const blockers = waits
    .filter((entry) => Math.abs(entry.waitMs - maxWait) < 1)
    .map((entry) => entry.window)
    .join('+');
  const eligible = maxWait >= config.minWaitMs;
  return payload(eligible ? `view_quota:${blockers || 'unknown'}` : 'short_wait', maxWait, eligible);
}

function parseEnabled(raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined) return fallback;
  const v = raw.trim().toLowerCase();
  if (!v) return fallback;
  if (['0', 'false', 'off', 'no', 'disabled'].includes(v)) return false;
  if (['1', 'true', 'on', 'yes', 'enabled'].includes(v)) return true;
  return fallback;
}

function parsePositiveMs(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1_000) return fallback;
  return Math.floor(n);
}
