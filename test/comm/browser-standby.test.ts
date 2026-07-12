import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_BROWSER_STANDBY_MIN_WAIT_MS,
  DEFAULT_BROWSER_STANDBY_WARMUP_MS,
  buildBrowserStandbyHint,
  resolveBrowserStandbyConfig,
  type BrowserStandbyRiskSource,
} from '../../src/comm/browser-standby.js';
import type { RiskAction, RiskWindow } from '../../src/risk/types.js';

function source(opts: {
  allowed?: boolean;
  reason?: string;
  retryAfterMs?: number;
  waits?: Partial<Record<RiskWindow, number | undefined>>;
}): BrowserStandbyRiskSource {
  return {
    explain(_action: RiskAction) {
      return {
        allowed: opts.allowed ?? false,
        reason: opts.reason ?? 'quota:minute',
        retryAfterMs: opts.retryAfterMs,
      };
    },
    quotaReleaseAfterMs(_action: RiskAction, window: RiskWindow) {
      return opts.waits?.[window] ?? 0;
    },
  };
}

test('browser-standby: env config defaults enabled with 20min threshold and warmup', () => {
  const cfg = resolveBrowserStandbyConfig({});
  assert.equal(cfg.enabled, true);
  assert.equal(cfg.minWaitMs, DEFAULT_BROWSER_STANDBY_MIN_WAIT_MS);
  assert.equal(cfg.warmupMs, DEFAULT_BROWSER_STANDBY_WARMUP_MS);
});

test('browser-standby: disabled switch produces ineligible hint', () => {
  const hint = buildBrowserStandbyHint(source({ waits: { hour: 60 * 60_000 } }), {
    now: 1_000,
    config: { enabled: false, minWaitMs: 20 * 60_000, warmupMs: 90_000 },
  });
  assert.equal(hint.enabled, false);
  assert.equal(hint.eligible, false);
  assert.equal(hint.reason, 'disabled');
  assert.equal(hint.wakeAt, 1_000);
});

test('browser-standby: allowed view means no wait', () => {
  const hint = buildBrowserStandbyHint(source({ allowed: true }), {
    now: 1_000,
    config: { enabled: true, minWaitMs: 20 * 60_000, warmupMs: 90_000 },
  });
  assert.equal(hint.eligible, false);
  assert.equal(hint.reason, 'no_wait');
  assert.equal(hint.waitMs, 0);
});

test('browser-standby: hard blocker is not converted into eligible wake time', () => {
  const hint = buildBrowserStandbyHint(source({ reason: 'state:frozen' }), {
    now: 1_000,
    config: { enabled: true, minWaitMs: 20 * 60_000, warmupMs: 90_000 },
  });
  assert.equal(hint.eligible, false);
  assert.equal(hint.reason, 'hard_blocker');
  assert.equal(hint.waitMs, 0);
});

test('browser-standby: short quota wait remains ineligible', () => {
  const hint = buildBrowserStandbyHint(source({ waits: { minute: 5 * 60_000 } }), {
    now: 1_000,
    config: { enabled: true, minWaitMs: 20 * 60_000, warmupMs: 90_000 },
  });
  assert.equal(hint.eligible, false);
  assert.equal(hint.reason, 'short_wait');
  assert.equal(hint.waitMs, 5 * 60_000);
});

test('browser-standby: eligible quota wait uses the longest saturated window', () => {
  const hint = buildBrowserStandbyHint(source({ waits: { minute: 45_000, hour: 42 * 60_000, day: 0 } }), {
    now: 10_000,
    config: { enabled: true, minWaitMs: 20 * 60_000, warmupMs: 90_000 },
  });
  assert.equal(hint.enabled, true);
  assert.equal(hint.eligible, true);
  assert.equal(hint.reason, 'view_quota:hour');
  assert.equal(hint.waitMs, 42 * 60_000);
  assert.equal(hint.wakeAt, 10_000 + 42 * 60_000);
  assert.equal(hint.generatedAt, 10_000);
  assert.equal(hint.source, 'risk');
});
