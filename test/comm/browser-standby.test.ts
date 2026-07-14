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
  status?: string;
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
    getState() {
      return { status: opts.status };
    },
  };
}

/** 门槛 5 分钟（change standby-covers-idle-waits）；旧值 20 分钟。 */
const CFG = { enabled: true, minWaitMs: 5 * 60_000, warmupMs: 90_000 };

test('browser-standby: env config defaults enabled with 5min threshold and warmup', () => {
  const cfg = resolveBrowserStandbyConfig({});
  assert.equal(cfg.enabled, true);
  assert.equal(cfg.minWaitMs, DEFAULT_BROWSER_STANDBY_MIN_WAIT_MS);
  assert.equal(cfg.warmupMs, DEFAULT_BROWSER_STANDBY_WARMUP_MS);
  // 门槛两端各有一份默认值，边缘取的是较大值 —— 只改一端不生效且无报错。这条钉死云端这份是 5 分钟；
  // 边缘那份由 aidcp-edge 的 browser-slot-scheduling.test.ts 断言，两处必须同为 5 分钟。
  assert.equal(DEFAULT_BROWSER_STANDBY_MIN_WAIT_MS, 5 * 60_000);
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

// —— change standby-covers-idle-waits：判据从「reason 是不是配额」改成「解除阻塞需不需要浏览器」 ——
//
// 这条测试的**旧版本把 bug 写成了断言**：它要求 `state:frozen` → `hard_blocker` / 不让位。而冻结恰恰是
// 等待最长、可能永远不再干活的一类，解除它只需要运营在后台改状态、根本不需要浏览器。旧判据让最不该
// 占着浏览器的账号占得最牢。现在反过来。

test('browser-standby: 冻结账号 SHALL 让出槽位（旧判据把它排除在让位之外 —— 那是 bug）', () => {
  const hint = buildBrowserStandbyHint(source({ reason: 'state:frozen', status: 'frozen' }), {
    now: 1_000,
    config: CFG,
  });
  assert.equal(hint.eligible, true);
  assert.equal(hint.reason, 'risk_state:frozen');
  assert.equal(hint.source, 'risk');
  // 回访语义：wakeAt 是「多久后回来再问一次」，不是恢复承诺（冻结全仓无自动恢复、只能运营手动解）。
  assert.ok(hint.waitMs >= 5 * 60_000, '回访跨度至少要跨过门槛，否则边缘会当成短等待拒绝待机');
});

test('browser-standby: 需要浏览器才能解除的阻塞 MUST NOT 让位', () => {
  // 验证码 / 登录 / 人工在浏览器里介入 / 未知状态 —— 关掉浏览器就没法解除了。
  for (const reason of ['captcha_required', 'login_required', 'unknown_scheduler_state']) {
    const hint = buildBrowserStandbyHint(source({ reason }), { now: 1_000, config: CFG });
    assert.equal(hint.eligible, false, `${reason} 绝不能让位`);
    assert.equal(hint.reason, 'hard_blocker');
    assert.equal(hint.waitMs, 0);
  }
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

// ─── 续场闸这一整片盲区（change standby-covers-idle-waits）────────────────────────────────
//
// 关键：风控对 `view` 动作的判定说「能浏览」，账号却已经被续场闸停下来了。旧代码到这里就 `no_wait` 收工，
// 于是排期外 / 时长满 / restricted 的账号一律攥着浏览器不放——这才是槽位不轮转的真正原因。

test('browser-standby: 排期外停工 SHALL 让位（source=session，wakeAt=下一个可活跃时刻）', () => {
  const now = 1_000_000;
  const resumeAt = now + 8 * 3_600_000; // 明早窗口重开
  const hint = buildBrowserStandbyHint(source({ allowed: true }), {
    now,
    config: CFG,
    resumeGate: { blocked: true, reason: 'active_window', resumeAt },
  });
  assert.equal(hint.eligible, true);
  assert.equal(hint.reason, 'session:active_window');
  assert.equal(hint.source, 'session');
  assert.equal(hint.wakeAt, resumeAt);
});

test('browser-standby: 每日时长跑满 SHALL 让位（wakeAt=下一个本地日界）', () => {
  const now = 1_000_000;
  const resumeAt = now + 5 * 3_600_000;
  const hint = buildBrowserStandbyHint(source({ allowed: true }), {
    now,
    config: CFG,
    resumeGate: { blocked: true, reason: 'daily_minutes', resumeAt },
  });
  assert.equal(hint.eligible, true);
  assert.equal(hint.reason, 'session:daily_minutes');
  assert.equal(hint.source, 'session');
  assert.equal(hint.wakeAt, resumeAt);
});

test('browser-standby: restricted 只能在续场闸这一问里被抓到（风控对 view 豁免它）', () => {
  // 这是最容易漏的一条：explain('view') 对 restricted 返回 allowed —— 账号明明已经不再续场了，
  // 风控那一问却说「能浏览」。只看风控的旧判据在这里必然判 no_wait、浏览器一直开着。
  const hint = buildBrowserStandbyHint(source({ allowed: true, status: 'restricted' }), {
    now: 1_000,
    config: CFG,
    resumeGate: { blocked: true, reason: 'risk_state' }, // 无恢复时刻
  });
  assert.equal(hint.eligible, true);
  assert.equal(hint.reason, 'risk_state:restricted');
  assert.ok(hint.waitMs >= 5 * 60_000);
});

test('browser-standby: 算不出恢复时刻（周历整周全关）→ 让位 + 回访', () => {
  const hint = buildBrowserStandbyHint(source({ allowed: true }), {
    now: 1_000,
    config: CFG,
    resumeGate: { blocked: true, reason: 'week' }, // 运营显式停号，无 resumeAt
  });
  assert.equal(hint.eligible, true);
  assert.equal(hint.reason, 'session:week');
  assert.equal(hint.source, 'session');
  assert.ok(hint.waitMs >= 5 * 60_000, '回访跨度必须跨过门槛');
});

test('browser-standby: 「还没准备好」MUST NOT 让位（人设未绑等动作可能要用浏览器）', () => {
  const hint = buildBrowserStandbyHint(source({ allowed: true }), {
    now: 1_000,
    config: CFG,
    resumeGate: { blocked: true, reason: 'not_ready' },
  });
  assert.equal(hint.eligible, false);
  assert.equal(hint.reason, 'not_ready');
  assert.equal(hint.waitMs, 0);
});

test('browser-standby: 续场闸短等待不触发待机（门槛 5 分钟）', () => {
  const now = 1_000_000;
  const hint = buildBrowserStandbyHint(source({ allowed: true }), {
    now,
    config: CFG,
    resumeGate: { blocked: true, reason: 'active_window', resumeAt: now + 4 * 60_000 },
  });
  assert.equal(hint.eligible, false);
  assert.equal(hint.reason, 'short_wait');
  assert.equal(hint.waitMs, 4 * 60_000);
});

test('browser-standby: 拿不到续场闸裁决（边缘离线）→ 退化为只按风控判，不让位', () => {
  const hint = buildBrowserStandbyHint(source({ allowed: true }), { now: 1_000, config: CFG, resumeGate: null });
  assert.equal(hint.eligible, false);
  assert.equal(hint.reason, 'no_wait');
});
