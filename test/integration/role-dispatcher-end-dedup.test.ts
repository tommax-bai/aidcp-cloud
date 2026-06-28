/**
 * change restore-auto-resume-and-global-safety-config — stream A 回归断言（tasks §4）。
 *
 * 锁死缺陷 A 的两个不变量（经真实 SessionMonitorRole.triggerEnd 路径驱动，而非直接调 endSession，
 * 否则测不到「emit + onSessionEnd 双动作」导致的 endSession 双调）：
 *   A①：一次监测体结束 → 结束流程只走一次 → 为续场武装的休息计时器存活（未被同次结束取消）→ 到点真续场。
 *        （旧 bug：session.should_end 处理器与 onSessionEnd 各调一次 endSession，第二次 cancelRestTimer
 *         清掉刚武装的计时器并早退 → 续场永不触发。）
 *   A②：续场重开后云端主动下发一次 scroll(resume_redrive) 重驱已停的边端浏览循环。
 *
 * 关键：faithful 计时器桩——clearTimeoutFn 会把 timerFn 置空，使「已取消的计时器」真的不能再 fire，
 * 从而 bug 路径（计时器被取消）下 fire() 为 no-op、续场不发生，测试如实失败。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { RoleDispatcher } from '../../src/orchestrator/role-dispatcher.js';
import type { Soul } from '../../src/soul/types.js';
import type { ResumeConfigProvider } from '../../src/risk/resume-limits.js';

const mockSoul: Soul = {
  identity: { name: 'B', role: 'r', background: 'b', tone: 't' },
  interests: { primary: ['AI'], secondary: [], seed_keywords: ['x'] },
};

const fixedBudget = () => ({ likes: 10, collects: 5, follows: 3, searches: 5, comments: 2, comment_likes: 3 });

const resumeProvider: ResumeConfigProvider = {
  restRatio: () => 0.1,
  activeWindow: () => ({ startMin: 0, endMin: 1440 }),
  dailyCaps: () => ({ maxSessions: 0, maxMinutes: 0 }),
  idleNudgeMs: () => 130_000,
  idleEndMs: () => 3_600_000,
};

function make() {
  const commands: { action: string; reason?: string }[] = [];
  let now = 1_000_000;
  let timerFn: (() => void) | undefined;
  let timerMs: number | undefined;
  let cleared = 0;
  const d = new RoleDispatcher({
    soul: mockSoul,
    llm: { complete: async () => '{}' },
    sendCommand: (c) => commands.push(c),
    clock: () => now,
    resumeConfigProvider: resumeProvider,
    randomFn: () => 0.25, // 抖动乘子 ≈ 1（确定）
    setTimeoutFn: (fn, ms) => {
      timerFn = fn;
      timerMs = ms;
      return 'T';
    },
    // faithful：取消即清掉 timerFn，使被取消的计时器无法再 fire（如实模拟 clearTimeout）。
    clearTimeoutFn: () => {
      cleared++;
      timerFn = undefined;
      timerMs = undefined;
    },
    getRiskStatus: () => 'normal',
    isDispatchActive: () => true,
    sessionLimitProvider: {
      sessionDurationMs: () => 600_000, // 10min
      sessionBudget: fixedBudget,
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
    /** 模拟边端动作回执 → 驱动监测体 checkSession（时长超限即 triggerEnd）。 */
    emitAction: () => d.bus.emit('action.completed', { action: 'open_note', ok: true, ts: now }),
  };
}

describe('restore-auto-resume A①：监测体单次结束不自毁续场计时器', () => {
  it('时长超限（经 triggerEnd 的 emit + onSessionEnd 双动作）→ 续场计时器存活、未被取消', () => {
    const m = make();
    m.d.startSession();
    assert.equal(m.d.active, true);

    // 推进超过单场 10min，再来一条动作回执 → 监测体 checkSession 判时长超限 → triggerEnd
    // （emit session.should_end → dispatcher 处理器；onSessionEnd → endSession）。
    m.advance(600_001);
    m.emitAction();

    assert.equal(m.d.active, false, '监测体结束后会话非活跃');
    // 核心：休息计时器「已武装且未被取消」。旧 bug 下第二次 endSession 会取消它 → getCleared()===1。
    assert.equal(m.getCleared(), 0, 'A①：续场计时器 MUST NOT 被同次结束取消（双调会取消，cleared 应为 0）');
    assert.ok(
      Math.abs((m.getTimerMs() ?? 0) - 60_000) < 1_000,
      `续场休息计时器应≈60s（600s×10%），实得 ${m.getTimerMs()}`,
    );
    // 边端应收到一条 session.end（结束命令仍下发）。
    assert.ok(commandsHave(m.commands, 'session.end'), '应下发 session.end 命令给边端');
  });

  it('休息到点 → 真续场（会话重新活跃）', () => {
    const m = make();
    m.d.startSession();
    m.advance(600_001);
    m.emitAction(); // 监测体结束 → 武装续场计时器
    assert.equal(m.d.active, false);

    m.fire(); // 休息到点（bug 路径下计时器已被取消 → fire 为 no-op → 续场不发生）
    assert.equal(m.d.active, true, 'A①：续场计时器存活 → 到点过闸 → 会话重新活跃');
  });
});

describe('restore-auto-resume A②：续场后主动重驱边端', () => {
  it('续场重开 → 下发一次 scroll(resume_redrive) 唤醒边端浏览循环', () => {
    const m = make();
    m.d.startSession();
    m.advance(600_001);
    m.emitAction(); // 结束 → 武装续场计时器
    const beforeResume = m.commands.length;
    m.fire(); // 续场
    assert.equal(m.d.active, true, '续场成功');
    const afterResume = m.commands.slice(beforeResume);
    assert.ok(
      afterResume.some((c) => c.action === 'scroll' && c.reason === 'resume_redrive'),
      `A②：续场后应下发 scroll(resume_redrive)，实得 ${JSON.stringify(afterResume)}`,
    );
  });
});

function commandsHave(commands: { action: string }[], action: string): boolean {
  return commands.some((c) => c.action === action);
}
