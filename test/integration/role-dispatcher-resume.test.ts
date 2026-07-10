/**
 * change session-auto-resume-with-excursions — 自动续场（task 3.5）。
 * 验证 RoleDispatcher：正常结束 arm 休息计时器（≈单场×rest_ratio）、运营停不 arm、
 * 计时器到点过续场各闸（风控/每日上限）→ 续场，闸不过诚实不续。
 * 另含活跃时段窗口纯函数测试（TZ 无关）。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { RoleDispatcher } from '../../src/orchestrator/role-dispatcher.js';
import { isWithinActiveWindow } from '../../src/risk/resume-limits.js';
import type { Soul } from '../../src/soul/types.js';
import type { ResumeConfigProvider } from '../../src/risk/resume-limits.js';
import type { RiskStatus } from '../../src/risk/types.js';

const mockSoul: Soul = {
  identity: { name: 'B', role: 'r', background: 'b', tone: 't' },
  interests: { primary: ['AI'], secondary: [], seed_keywords: ['x'] },
};

const fixedBudget = () => ({ likes: 10, collects: 5, follows: 3, searches: 5, comments: 2, comment_likes: 3, join_groups: 1 });

function makeProvider(over?: Partial<ResumeConfigProvider>): ResumeConfigProvider {
  return {
    restRatio: () => 0.1,
    activeWindow: () => ({ startMin: 0, endMin: 1440 }), // 全天不限
    dailyCaps: () => ({ maxSessions: 0, maxMinutes: 0 }), // 不限
    idleNudgeMs: () => 130_000,
    idleEndMs: () => 3_600_000,
    ...over,
  };
}

function make(opts?: {
  provider?: Partial<ResumeConfigProvider>;
  getRiskStatus?: () => RiskStatus;
  isDispatchActive?: () => boolean;
  weekMask?: string | null;
}) {
  const commands: { action: string }[] = [];
  let now = 1_000_000;
  let timerFn: (() => void) | undefined;
  let timerMs: number | undefined;
  let cleared = 0;
  const d = new RoleDispatcher({
    soul: mockSoul,
    llm: { complete: async () => '{}' },
    sendCommand: (c) => commands.push(c),
    clock: () => now,
    resumeConfigProvider: makeProvider(opts?.provider),
    randomFn: () => 0.25, // → 抖动乘子 ≈ 1（确定）
    setTimeoutFn: (fn, ms) => {
      timerFn = fn;
      timerMs = ms;
      return 'T';
    },
    clearTimeoutFn: () => {
      cleared++;
    },
    getRiskStatus: opts?.getRiskStatus ?? (() => 'normal'),
    isDispatchActive: opts?.isDispatchActive ?? (() => true),
    sessionLimitProvider: {
      sessionDurationMs: () => 600_000, // 10min
      sessionBudget: fixedBudget,
      collectSaveLikeRatio: () => 1 / 3,
      followFansRatio: () => 1 / 8,
      weekActiveMask: () => opts?.weekMask ?? null, // 「可活跃时间」周历掩码；缺省 null = 全天活跃（不约束）
    },
  });
  d.setup();
  return {
    d,
    commands,
    fire: () => timerFn?.(),
    getTimerMs: () => timerMs,
    getCleared: () => cleared,
    advance: (ms: number) => (now += ms),
  };
}

describe('RoleDispatcher 自动续场', () => {
  it('正常结束（autoResumeEligible）→ arm 休息计时器 ≈ 单场×rest_ratio', () => {
    const m = make();
    m.d.startSession();
    assert.equal(m.d.active, true);
    m.d.endSession('会话时长已超限', { autoResumeEligible: true });
    assert.equal(m.d.active, false, '结束后会话非活跃');
    // 600_000 × 0.10 × 抖动(≈1) = 60_000
    assert.ok(
      Math.abs((m.getTimerMs() ?? 0) - 60_000) < 1_000,
      `休息时长应≈60s，实得 ${m.getTimerMs()}`,
    );
  });

  it('运营停（无 eligible）→ 不 arm 休息计时器', () => {
    const m = make();
    m.d.startSession();
    m.d.endSession('panel_dispatch_stop');
    assert.equal(m.getTimerMs(), undefined, '运营停不安排续场');
  });

  it('休息到点 → 过闸 → 续场（会话重新活跃）', () => {
    const m = make();
    m.d.startSession();
    m.d.endSession('timeout', { autoResumeEligible: true });
    assert.equal(m.d.active, false);
    m.fire(); // 休息到点
    assert.equal(m.d.active, true, '过续场各闸 → 会话重新活跃');
  });

  it('撞风控（frozen）→ 不续场', () => {
    const m = make({ getRiskStatus: () => 'frozen' });
    m.d.startSession();
    m.d.endSession('timeout', { autoResumeEligible: true });
    m.fire();
    assert.equal(m.d.active, false, 'frozen → 诚实不续');
  });

  it('调度全局停（isDispatchActive=false）→ 不续场', () => {
    const m = make({ isDispatchActive: () => false });
    m.d.startSession();
    // isDispatchActive=false 时 startSession 仍可被显式调；但续场闸 canStartSession 会拦。
    m.d.endSession('timeout', { autoResumeEligible: true });
    m.fire();
    assert.equal(m.d.active, false, '调度停 → 不续');
  });

  it('每日上限到顶 → 不再续场', () => {
    const m = make({ provider: { dailyCaps: () => ({ maxSessions: 1, maxMinutes: 0 }) } });
    // 第 1 轮：结束 → 续场成功（当日计数 → 1）
    m.d.startSession();
    m.d.endSession('timeout', { autoResumeEligible: true });
    m.fire();
    assert.equal(m.d.active, true, '首轮续场成功');
    // 第 2 轮：结束 → 续场被每日上限拦
    m.d.endSession('timeout', { autoResumeEligible: true });
    m.fire();
    assert.equal(m.d.active, false, '当日已达 1 场上限 → 不再续');
  });
});

describe('RoleDispatcher「可活跃时间」周历闸（change weekly-active-window）', () => {
  const ALL_OFF = '0'.repeat(168); // 全周休眠（与具体时刻无关，判定确定）
  const ALL_ON = '1'.repeat(168); // 全周活跃

  it('掩码全休眠 → restartSession 不开会话（所有启动的统一收口被拦）', () => {
    const m = make({ weekMask: ALL_OFF });
    m.d.restartSession();
    assert.equal(m.d.active, false, '不在可活跃时段 → 不启动浏览会话');
  });

  it('掩码全活跃 → restartSession 正常开会话', () => {
    const m = make({ weekMask: ALL_ON });
    m.d.restartSession();
    assert.equal(m.d.active, true, '可活跃时段内 → 正常启动');
  });

  it('缺掩码（null）→ 不设闸，restartSession 正常开会话（零回归）', () => {
    const m = make(); // weekMask 缺省 = null
    m.d.restartSession();
    assert.equal(m.d.active, true);
  });

  it('掩码全休眠 → 续场被同闸拦（休息到点不续）', () => {
    const m = make({ weekMask: ALL_OFF });
    m.d.startSession(); // startSession 本身不过周历闸；用它起一场再验续场被拦
    m.d.endSession('timeout', { autoResumeEligible: true });
    m.fire(); // 休息到点 → doAutoResume → canAutoResume（周历闸）
    assert.equal(m.d.active, false, '可活跃时段外 → canAutoResume 拦，不续');
  });

  // 窗口唤醒增强：休眠期排到「下一个活跃整点」主动续上，不再干等边端重连。
  // 掩码按 make() 内固定的起始时钟（1_000_000ms）推导，保证「当前休眠、下一整点活跃」与时区无关。
  const NOW0 = 1_000_000;
  const idxOf = (d: Date) => (((d.getDay() + 6) % 7) * 24 + d.getHours());
  const maskDormantNowActiveNextHour = () => {
    const next = new Date(NOW0);
    next.setMinutes(0, 0, 0);
    next.setHours(next.getHours() + 1);
    const arr = '0'.repeat(168).split('');
    arr[idxOf(next)] = '1'; // 仅下一整点活跃；当前及其余休眠
    return arr.join('');
  };

  it('窗口唤醒：窗口外排唤醒计时器，到点（窗口已开）→ 主动起会话续上', () => {
    const m = make({ weekMask: maskDormantNowActiveNextHour() });
    m.d.restartSession(); // 当前休眠 → 被拦 + 排窗口唤醒计时器
    assert.equal(m.d.active, false, '窗口外不开会话');
    const wakeMs = m.getTimerMs();
    assert.ok(typeof wakeMs === 'number' && wakeMs > 0, `应排了窗口唤醒计时器，实得 ${wakeMs}`);
    m.advance(wakeMs); // 推进到下一活跃整点（含至多 1min 抖动，仍落在该活跃小时内）
    m.fire(); // 唤醒到点 → doAutoResume（窗口已开）→ 起会话 + 重驱
    assert.equal(m.d.active, true, '窗口重开 → 主动起一场会话续上');
  });

  it('窗口唤醒：整周全休眠 → 不排唤醒（尊重运营显式关停）', () => {
    const m = make({ weekMask: ALL_OFF });
    m.d.restartSession();
    assert.equal(m.d.active, false);
    assert.equal(m.getTimerMs(), undefined, '全休眠无「下一活跃」→ 不排唤醒计时器');
  });
});

describe('isWithinActiveWindow（活跃时段窗口纯函数）', () => {
  it('全天不限：(0,1440) 任意时刻为真', () => {
    assert.equal(isWithinActiveWindow(0, { startMin: 0, endMin: 1440 }), true);
    assert.equal(isWithinActiveWindow(720, { startMin: 0, endMin: 1440 }), true);
    assert.equal(isWithinActiveWindow(1439, { startMin: 0, endMin: 1440 }), true);
  });

  it('普通窗口 [08:00,24:00)：窗内真、窗外假', () => {
    const w = { startMin: 480, endMin: 1440 };
    assert.equal(isWithinActiveWindow(600, w), true, '10:00 在窗内');
    assert.equal(isWithinActiveWindow(60, w), false, '01:00 在窗外');
  });

  it('跨午夜窗口 [22:00,06:00)：22:00–24:00 与 00:00–06:00 为真', () => {
    const w = { startMin: 1320, endMin: 360 };
    assert.equal(isWithinActiveWindow(1380, w), true, '23:00 在窗内');
    assert.equal(isWithinActiveWindow(120, w), true, '02:00 在窗内');
    assert.equal(isWithinActiveWindow(720, w), false, '12:00 在窗外');
  });

  it('start==end 视作全天不限', () => {
    assert.equal(isWithinActiveWindow(123, { startMin: 600, endMin: 600 }), true);
  });
});
