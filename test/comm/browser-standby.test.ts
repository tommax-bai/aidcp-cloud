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
  // Cloud is the single threshold authority and keeps the product default at five minutes.
  assert.equal(DEFAULT_BROWSER_STANDBY_MIN_WAIT_MS, 5 * 60_000);
});

test('browser-standby: resolved Cloud threshold is emitted and used for short-wait admission', () => {
  const minWaitMs = 7 * 60_000;
  const config = resolveBrowserStandbyConfig({
    AIDCP_BROWSER_COLD_STANDBY_MIN_WAIT_MS: String(minWaitMs),
  });

  const short = buildBrowserStandbyHint(source({ waits: { minute: minWaitMs - 1 } }), {
    now: 1_000,
    config,
  });
  assert.equal(short.minWaitMs, minWaitMs);
  assert.equal(short.eligible, false);
  assert.equal(short.reason, 'short_wait');

  const eligible = buildBrowserStandbyHint(source({ waits: { minute: minWaitMs } }), {
    now: 1_000,
    config,
  });
  assert.equal(eligible.minWaitMs, minWaitMs);
  assert.equal(eligible.eligible, true);
  assert.equal(eligible.reason, 'view_quota:minute');
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

test('browser-standby: 未知的非配额阻塞 MUST NOT 让位（兜底：不认识就不动）', () => {
  // **这条测试证明不了「验证码不让位」。** 下面这些 reason 是构造出来的：生产环境的 explain('view') 只可能
  // 回 allowed / 'state:frozen' / 'quota:*'（risk-controller.ts），所以它守的是一段生产不可达的兜底分支。
  // 上一版台账把它当成「验证码不让位」的覆盖——那是不实的记账，真正的验证码路径见下面 needsBrowserToUnblock 那几条。
  for (const reason of ['some_unknown_blocker', 'ratio:like_view']) {
    const hint = buildBrowserStandbyHint(source({ reason }), { now: 1_000, config: CFG });
    assert.equal(hint.eligible, false, `${reason} 绝不能让位`);
    assert.equal(hint.reason, 'hard_blocker');
    assert.equal(hint.waitMs, 0);
  }
});

// ─── 验证码：真正可达的那条路（change standby-captcha-must-not-yield）──────────────────────
//
// 验证码上报 → 云端信号升为 confirmed → 状态机 normal → **restricted** → 续场闸判停工 → 待机判定说「该让位」。
// 而 ui.snapshot **有意豁免**验证码暂停闸（它是界面数据、不是页面命令），提示照样送到那个卡着验证码的边缘。
// 于是浏览器会在运维正被要求去解验证码时被关掉。这是 standby-covers-idle-waits 引入的可达回归。

test('browser-standby: 边缘卡在验证码上 → MUST NOT 让位（哪怕 restricted 已判停工）', () => {
  const hint = buildBrowserStandbyHint(source({ allowed: true, status: 'restricted' }), {
    now: 1_000,
    config: CFG,
    resumeGate: { blocked: true, reason: 'risk_state' }, // 验证码把它打成了 restricted
    needsBrowserToUnblock: true, // 云端权威事实：这个边缘正卡在验证码上
  });
  assert.equal(hint.eligible, false, '绝不能关掉运维正要去解验证码的那个浏览器');
  assert.equal(hint.reason, 'hard_blocker');
  assert.equal(hint.waitMs, 0);
});

test('browser-standby: 验证码期间任何停工原因都不让位（闸压在所有来源之前）', () => {
  // 范围比 restricted 更宽：验证码期间账号同样可能「排期外」「时长满」「配额耗尽」——这些原本都会让位。
  const now = 1_000_000;
  const gates = [
    ['排期外', { blocked: true, reason: 'active_window', resumeAt: now + 8 * 3_600_000 }],
    ['时长满', { blocked: true, reason: 'daily_minutes', resumeAt: now + 5 * 3_600_000 }],
    ['整周全关', { blocked: true, reason: 'week' }],
  ] as const;
  for (const [label, gate] of gates) {
    const hint = buildBrowserStandbyHint(source({ allowed: true }), {
      now,
      config: CFG,
      resumeGate: gate,
      needsBrowserToUnblock: true,
    });
    assert.equal(hint.eligible, false, `${label} + 验证码 → 绝不让位`);
    assert.equal(hint.reason, 'hard_blocker');
  }
  // 配额耗尽走的是另一条分支，同样必须被压住。
  const quota = buildBrowserStandbyHint(source({ waits: { hour: 42 * 60_000 } }), {
    now,
    config: CFG,
    needsBrowserToUnblock: true,
  });
  assert.equal(quota.eligible, false, '配额耗尽 + 验证码 → 绝不让位');
  assert.equal(quota.reason, 'hard_blocker');
});

test('browser-standby: 验证码解除后恢复正常让位（闸不得永久禁用让位）', () => {
  const hint = buildBrowserStandbyHint(source({ allowed: true, status: 'restricted' }), {
    now: 1_000,
    config: CFG,
    resumeGate: { blocked: true, reason: 'risk_state' },
    needsBrowserToUnblock: false, // 验证码已解
  });
  assert.equal(hint.eligible, true);
  assert.equal(hint.reason, 'risk_state:restricted');
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
