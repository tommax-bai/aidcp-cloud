/**
 * RoleDispatcher 互动风控闸 — interaction-risk-gating 的可测场景。
 *
 * 验证：canInteract 拒绝时 like/collect/follow 不下发（诚实跳过、不假成功），
 * 而 scroll/back 等推进指令不受闸控（不死锁）；允许时正常下发。
 * 直接经 EventBus 注入 interaction.completed / profile.done / feed.scrolled，观测 sendCommand。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { RoleDispatcher } from '../../src/orchestrator/role-dispatcher.js';
import type { EdgeCommand, ViewQuotaDecision } from '../../src/orchestrator/role-dispatcher.js';
import { EventBus } from '../../src/event-bus/index.js';
import type { Soul } from '../../src/soul/types.js';

const mockSoul: Soul = {
  identity: { name: 'T', role: 'r', background: 'b', tone: 't' },
  interests: { primary: ['AI'], secondary: ['x'], seed_keywords: ['k'] },
};
const mockLlm = { complete: async () => 'pass' };

function setup(
  canInteract: (a: 'like' | 'collect' | 'follow' | 'comment' | 'comment_like') => boolean,
  opts: {
    canView?: () => boolean;
    explainView?: () => ViewQuotaDecision;
    clock?: () => number;
    setTimeoutFn?: (fn: () => void, ms: number) => unknown;
    clearTimeoutFn?: (handle: unknown) => void;
  } = {},
) {
  const commands: EdgeCommand[] = [];
  const bus = new EventBus();
  const d = new RoleDispatcher({
    soul: mockSoul,
    llm: mockLlm,
    eventBus: bus,
    canInteract,
    canView: opts.canView,
    explainView: opts.explainView,
    sendCommand: (c) => commands.push(c),
    clock: opts.clock ?? (() => 0),
    setTimeoutFn: opts.setTimeoutFn,
    clearTimeoutFn: opts.clearTimeoutFn,
  });
  d.setup();
  d.startSession(); // 反应链/指令翻译接线现随会话激活进行（不再在 setup 接线）
  return { bus, commands };
}

const actionsOf = (commands: EdgeCommand[]) => commands.map((c) => c.action);
const valuable = { index: 0, noteId: 'n1', title: 't', confidence: 0.9, sourcePageType: 'feed' as const, reason: 'test', ts: 0 };

describe('RoleDispatcher 互动风控闸', () => {
  it('canInteract=false：like/collect/follow 全部不下发，scroll 仍下发', () => {
    const { bus, commands } = setup(() => false);

    bus.emit('interaction.completed', { noteId: 'n1', sourcePageType: 'feed', actions: ['like', 'collect'], ts: 0 });
    bus.emit('profile.done', { authorId: 'a1', sourcePageType: 'feed', followed: true, ts: 0 });
    bus.emit('feed.scrolled', { pageType: 'feed', scrollCount: 1, ts: 0 });

    assert.ok(!actionsOf(commands).includes('like'), 'like 应被风控拦截');
    assert.ok(!actionsOf(commands).includes('collect'), 'collect 应被风控拦截');
    assert.ok(!actionsOf(commands).includes('follow'), 'follow 应被风控拦截');
    assert.ok(actionsOf(commands).includes('scroll'), 'scroll 不受闸控，应正常下发（不死锁）');
  });

  it('canInteract=true：like/collect/follow 正常下发', () => {
    const { bus, commands } = setup(() => true);

    bus.emit('interaction.completed', { noteId: 'n1', sourcePageType: 'feed', actions: ['like', 'collect'], ts: 0 });
    bus.emit('profile.done', { authorId: 'a1', sourcePageType: 'feed', followed: true, ts: 0 });

    assert.deepEqual(
      actionsOf(commands).filter((a) => a === 'like' || a === 'collect' || a === 'follow'),
      ['like', 'collect', 'follow'],
    );
  });

  it('选择性拦截：放行 like、拦 follow', () => {
    const { bus, commands } = setup((a) => a !== 'follow');

    bus.emit('interaction.completed', { noteId: 'n1', sourcePageType: 'feed', actions: ['like'], ts: 0 });
    bus.emit('profile.done', { authorId: 'a1', sourcePageType: 'feed', followed: true, ts: 0 });

    assert.ok(actionsOf(commands).includes('like'), 'like 应放行');
    assert.ok(!actionsOf(commands).includes('follow'), 'follow 应被拦');
  });

  it('view quota=false：content.valuable 不下发 open_note，也不结束会话', () => {
    const delays: number[] = [];
    const { bus, commands } = setup(() => true, {
      explainView: () => ({ allowed: false, reason: 'quota:minute', retryAfterMs: 10_000 }),
      setTimeoutFn: (_fn, ms) => {
        delays.push(ms);
        return { id: 'timer' };
      },
      clearTimeoutFn: () => {},
    });

    bus.emit('content.valuable', valuable);
    bus.emit('session.idle_nudge', { reason: 'test', ts: 0 });

    assert.ok(!actionsOf(commands).includes('open_note'), 'view 配额拒绝时不得打开下一篇');
    assert.ok(!actionsOf(commands).includes('scroll'), 'view 配额休眠期间不得用 idle nudge 重启滚动');
    assert.ok(!actionsOf(commands).includes('session.end'), '临时 view 配额拒绝应休眠浏览，不应结束会话');
    assert.equal(delays.length, 1, '应安排一次额度窗口唤醒');
    assert.ok(delays[0] >= 10_000, '唤醒时间应尊重 retryAfterMs');
  });

  it('view quota=false：content.no_valuable 的统一 scroll 出口也进入休眠，不得无限翻页', () => {
    const delays: number[] = [];
    const { bus, commands } = setup(() => true, {
      explainView: () => ({ allowed: false, reason: 'quota:day', retryAfterMs: 20_000 }),
      setTimeoutFn: (_fn, ms) => {
        delays.push(ms);
        return { id: 'timer' };
      },
      clearTimeoutFn: () => {},
    });

    bus.emit('feed.scrolled', { pageType: 'feed', scrollCount: 1, ts: 0 });

    assert.ok(!actionsOf(commands).includes('scroll'), '浏览额度耗尽后无价值内容也不得继续翻页');
    assert.equal(delays.length, 1, '统一 scroll 出口应安装一次额度窗口唤醒');
    assert.ok(delays[0] >= 20_000);
  });

  it('canView=true：content.valuable 正常下发 open_note', () => {
    const { bus, commands } = setup(() => true, { canView: () => true });

    bus.emit('content.valuable', valuable);

    assert.ok(actionsOf(commands).includes('open_note'), 'view 配额放行时应正常打开笔记');
  });

  it('view quota 休眠到期后重判，恢复时重驱浏览', () => {
    let allowed = false;
    let wake: (() => void) | undefined;
    const { bus, commands } = setup(() => true, {
      explainView: () => allowed ? { allowed: true } : { allowed: false, reason: 'quota:minute', retryAfterMs: 5_000 },
      setTimeoutFn: (fn) => {
        wake = fn;
        return { id: 'timer' };
      },
      clearTimeoutFn: () => {},
    });

    bus.emit('content.valuable', valuable);
    allowed = true;
    wake?.();

    assert.ok(actionsOf(commands).includes('scroll'), 'view 配额恢复时应滚动重驱浏览闭环');
    assert.equal(commands.find((c) => c.action === 'scroll')?.reason, 'resume_after_view_quota');
    bus.emit('content.valuable', valuable);
    assert.ok(actionsOf(commands).includes('open_note'), '恢复后新的候选应正常打开');
  });

  // ── change session-start-quota-honest-sleep：会话启动现问配额 + 休眠期扣命令可观测 ──
  // 全部经 edge.hello 入口（→ restartSession，生产路径），非 setup() 的 startSession（测试专用、不含新逻辑）。
  function helloDispatcher(opts: {
    explainView: () => ViewQuotaDecision;
    logs?: string[];
  }) {
    const commands: EdgeCommand[] = [];
    const delays: number[] = [];
    let wake: (() => void) | undefined;
    const bus = new EventBus();
    const d = new RoleDispatcher({
      soul: mockSoul,
      llm: mockLlm,
      eventBus: bus,
      canInteract: () => true,
      explainView: opts.explainView,
      sendCommand: (c) => commands.push(c),
      clock: () => 0,
      setTimeoutFn: (fn, ms) => { delays.push(ms); wake = fn; return { id: 'timer' }; },
      clearTimeoutFn: () => {},
    });
    d.setup();
    return { d, bus, commands, delays, wake: () => wake?.() };
  }

  it('启动即现问配额：day 窗耗尽 → hello 当场休眠，feed.entered 同步派发内零浏览命令下发（红线三）', () => {
    const { d, bus, commands, delays } = helloDispatcher({
      explainView: () => ({ allowed: false, reason: 'quota:day', retryAfterMs: 20_000 }),
    });

    // edge.hello 同步走完 restartSession（含 feed.entered 同步派发）。刹车须在派发前踩死。
    bus.emit('edge.hello', { edgeId: 'edge-1', accountId: 'acct-1', ts: 0 });

    assert.equal(d.active, true, '配额被拒不得拒签会话');
    assert.ok(delays.some((ms) => ms >= 20_000), '启动即安排一次到次日的休眠唤醒（尊重 retryAfterMs）');
    // feed.entered 的同步下游若在派发内走到 sendCommand，会漏出 open_note/scroll——刹车装在派发前即不会。
    assert.ok(!actionsOf(commands).includes('open_note'), '休眠下不得打开笔记');
    assert.ok(!actionsOf(commands).includes('scroll'), '休眠下不得滚动');
    assert.ok(!actionsOf(commands).includes('session.end'), '配额被拒 MUST 休眠、MUST NOT 结束会话（反向不变量）');

    // 休眠期再来候选/看门狗推进，仍全部被扣。
    bus.emit('content.valuable', valuable);
    bus.emit('session.idle_nudge', { reason: 'test', ts: 0 });
    assert.ok(!actionsOf(commands).includes('open_note'), '休眠期候选不得打开');
    assert.ok(!actionsOf(commands).includes('scroll'), '休眠期看门狗 nudge 不得唤醒滚动');
  });

  it('先清后问：陈旧休眠 + 额度已恢复 → 同连接重启清掉陈旧刹车、会话正常开跑（保留 :1556 取消）', () => {
    let allowed = false;
    const { bus, commands } = helloDispatcher({
      explainView: () => (allowed ? { allowed: true } : { allowed: false, reason: 'quota:day', retryAfterMs: 20_000 }),
    });

    // 第一次 hello：额度耗尽 → 装上休眠。
    bus.emit('edge.hello', { edgeId: 'edge-1', accountId: 'acct-1', ts: 0 });
    bus.emit('content.valuable', valuable);
    assert.ok(!actionsOf(commands).includes('open_note'), '首场休眠期不打开');

    // 额度恢复后同连接重启（第二次 hello）：cancelViewQuotaSleep 先清陈旧标记，现问发现已放行 → 不再装。
    allowed = true;
    bus.emit('edge.hello', { edgeId: 'edge-1', accountId: 'acct-1', ts: 0 });
    bus.emit('content.valuable', valuable);
    assert.ok(actionsOf(commands).includes('open_note'), '陈旧刹车须被清掉，新场按最新事实正常开跑');
  });

  it('休眠期扣命令留可观测记录且节流：多次看门狗 nudge 只打首条 + 每 50 条汇总（红线：不静默丢弃）', () => {
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...a: unknown[]) => { logs.push(a.join(' ')); };
    try {
      const { bus } = helloDispatcher({
        explainView: () => ({ allowed: false, reason: 'quota:day', retryAfterMs: 20_000 }),
      });
      bus.emit('edge.hello', { edgeId: 'edge-1', accountId: 'acct-1', ts: 0 });
      for (let i = 0; i < 120; i += 1) {
        bus.emit('session.idle_nudge', { reason: 'test', ts: 0 });
      }
      const suppressLines = logs.filter((l) => l.includes('command.suppressed') && l.includes('view_quota_sleep'));
      // 120 次扣命令 → 首条(1) + 每 50 条(50,100) = 恰 3 条；既证「不静默」又证「不逐条刷屏」。
      assert.equal(suppressLines.length, 3, '须节流为首条 + 每 50 条汇总（120 次 → 3 条）');
      assert.ok(suppressLines.some((l) => l.includes('account=acct-1')), '记录须含账号');
    } finally {
      console.log = origLog;
    }
  });

  it('edge.hello 启动入口不因临时 view 配额拒绝', () => {
    const commands: EdgeCommand[] = [];
    const bus = new EventBus();
    const d = new RoleDispatcher({
      soul: mockSoul,
      llm: mockLlm,
      eventBus: bus,
      canInteract: () => true,
      explainView: () => ({ allowed: false, reason: 'quota:minute', retryAfterMs: 60_000 }),
      sendCommand: (c) => commands.push(c),
      clock: () => 0,
      setTimeoutFn: () => ({ id: 'timer' }),
      clearTimeoutFn: () => {},
    });
    d.setup();

    bus.emit('edge.hello', { edgeId: 'edge-1', accountId: 'acct-1', ts: 0 });
    bus.emit('content.valuable', valuable);

    assert.equal(d.active, true, '临时 view 配额拒绝不应阻止会话启动');
    assert.ok(!actionsOf(commands).includes('open_note'), '但仍不得打开笔记');
    assert.ok(!actionsOf(commands).includes('session.end'), '也不应因 view 配额临时拒绝结束会话');
  });
});
