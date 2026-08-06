import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  RoleDispatcher,
  resolveFacebookPrimarySurfacePin,
  type EdgeCommand,
} from '@automation/orchestrator/role-dispatcher.js';
import type { Soul } from '@kernel/kernel/soul-types.js';

const soul: Soul = {
  identity: { name: 'Test', role: 'tester', background: 'test', tone: 'plain' },
  interests: { primary: ['video'], secondary: [], seed_keywords: [] },
};

const llm = { complete: async () => '{"verdict":"skip","reason":"test"}' };

const isReelsRedrive = (command: EdgeCommand): boolean =>
  command.action === 'scroll'
  && command.reason === 'resume_redrive'
  && command.params?.targetSurface === 'reels';

interface FakeTimer { fn: () => void; ms: number; cancelled: boolean; fired: boolean }

/**
 * 复判通道用注入的定时器驱动，故整条通道可确定性验证、不睡真实时间。
 * `decisions` 按调用次序取用；末位重复使用，模拟「基线一直问不到」。
 */
function harness(decisions: Array<Record<string, unknown>>) {
  const commands: EdgeCommand[] = [];
  const timers: FakeTimer[] = [];
  const warnings: string[] = [];
  const logs: string[] = [];
  let call = 0;
  const dispatcher = new RoleDispatcher({
    soul,
    llm,
    accountPlatform: 'facebook',
    facebookRuleModeDecision: () => {
      const decision = decisions[Math.min(call, decisions.length - 1)]!;
      call += 1;
      return decision as never;
    },
    sendCommand: (command: EdgeCommand) => commands.push(command),
    setTimeoutFn: (fn: () => void, ms: number) => {
      timers.push({ fn, ms, cancelled: false, fired: false });
      return timers.length - 1;
    },
    clearTimeoutFn: (handle: unknown) => {
      const timer = timers[handle as number];
      if (timer) timer.cancelled = true;
    },
  } as never);

  const pending = (): FakeTimer[] => timers.filter((t) => !t.cancelled && !t.fired);
  const fireNext = (): void => {
    const next = pending()[0];
    assert.ok(next, 'expected a pending recheck hop');
    next.fired = true;
    next.fn();
  };
  const capture = <T>(body: () => T): T => {
    const warn = console.warn;
    const log = console.log;
    console.warn = (...args: unknown[]) => void warnings.push(args.join(' '));
    console.log = (...args: unknown[]) => void logs.push(args.join(' '));
    try {
      return body();
    } finally {
      console.warn = warn;
      console.log = log;
    }
  };

  return { dispatcher, commands, timers, warnings, logs, pending, fireNext, capture };
}

const UNRESOLVED = { mode: 'blocked', blocker: 'facebook_operation_environment_binding_unknown' };
const AUTHORITATIVE_REELS = { mode: 'persona', blocker: null, primarySurface: 'reels', surfaceRevision: 1 };
const AUTHORITATIVE_FEED = { mode: 'persona', blocker: null, primarySurface: 'feed', surfaceRevision: 1 };

test('钉定缺面值 → 记具名回执并武装复判，MUST NOT 静默回落', () => {
  const h = harness([UNRESOLVED]);
  h.dispatcher.setup();
  h.capture(() => h.dispatcher.startSession());

  assert.equal(h.pending().length, 1, '未解析的钉定必须武装复判');
  assert.equal(h.pending()[0]!.ms, 2_000, '首跳用退避表首位');
  assert.ok(
    h.warnings.some((line) => line.includes('facebook_operation_environment_binding_unknown')),
    '回执必须逐字带出裁决给的具名原因',
  );
  h.dispatcher.endSession('test');
});

test('权威钉定的会话中途改配置 → 本场不改钉（复判 MUST NOT 扩成「配置中途生效」）', () => {
  // 本 change 让钉定第一次成为**可改**的，故这条既有保证从「结构上不可能违反」降为「靠一道闸守住」，
  // 必须有用例守着：权威钉定不武装复判 ⇒ 没有任何路径能在本场改钉。
  const h = harness([AUTHORITATIVE_REELS, AUTHORITATIVE_FEED]);
  h.dispatcher.setup();
  h.capture(() => h.dispatcher.startSession());
  assert.equal(h.pending().length, 0, '权威钉定不得武装复判');

  const before = h.commands.length;
  h.capture(() => h.dispatcher.redriveBrowse());
  const issued = h.commands.slice(before);

  assert.equal(issued.length, 1, '重驱恰好一条');
  assert.equal(
    issued[0]!.params?.targetSurface,
    'reels',
    '裁决已改成 feed，但本场仍用启动时钉的 reels——新配置只对下一场生效',
  );
  h.dispatcher.endSession('test');
});

test('带面值但 mode=blocked 仍算权威 → 不武装、不记账', () => {
  const h = harness([{ mode: 'blocked', blocker: 'slow_start_binding_unknown', primarySurface: 'reels' }]);
  h.dispatcher.setup();
  h.capture(() => h.dispatcher.startSession());

  assert.equal(h.pending().length, 0, '浏览面是确定的，MUST NOT 因 blocked 就去复判');
  assert.equal(
    h.warnings.some((line) => line.includes('主浏览入口未解析')),
    false,
    '权威钉定不得产出未解析回执',
  );
  h.dispatcher.endSession('test');
});

test('复判问到 reels → 改钉并恰好发一条 Reels 重驱，通道解除', () => {
  const h = harness([UNRESOLVED, AUTHORITATIVE_REELS]);
  h.dispatcher.setup();
  h.capture(() => h.dispatcher.startSession());
  const before = h.commands.filter(isReelsRedrive).length;

  h.capture(() => h.fireNext());

  assert.equal(h.commands.filter(isReelsRedrive).length, before + 1, '纠正必须恰好一条重驱');
  assert.equal(h.pending().length, 0, '问到即解除通道');
  h.dispatcher.endSession('test');
});

test('复判问到 feed → 只升为权威，零命令', () => {
  const h = harness([UNRESOLVED, AUTHORITATIVE_FEED]);
  h.dispatcher.setup();
  h.capture(() => h.dispatcher.startSession());
  const before = h.commands.length;

  h.capture(() => h.fireNext());

  assert.equal(h.commands.length, before, '纠正面与正在浏览的面相同时不得发任何命令');
  assert.equal(h.pending().length, 0, '问到即解除通道');
  h.dispatcher.endSession('test');
});

test('复判到上限仍问不到 → 一条终态回执后停手，不再有跳', () => {
  const h = harness([UNRESOLVED]);
  h.dispatcher.setup();
  h.capture(() => h.dispatcher.startSession());

  h.capture(() => {
    for (let hop = 0; hop < 5; hop += 1) h.fireNext();
  });

  assert.equal(h.pending().length, 0, '预算耗尽后不得再排跳');
  assert.equal(
    h.warnings.filter((line) => line.includes('复判已到上限仍问不到')).length,
    1,
    '到顶必须记且只记一条终态回执',
  );
  assert.equal(
    h.warnings.filter((line) => line.includes('主浏览入口未解析')).length,
    1,
    '同一个 blocker 每场只说一次，复判不得把它变成日志脉冲',
  );
  h.dispatcher.endSession('test');
});

test('会话结束时解除复判，MUST NOT 让一跳活过会话', () => {
  const h = harness([UNRESOLVED]);
  h.dispatcher.setup();
  h.capture(() => h.dispatcher.startSession());
  assert.equal(h.pending().length, 1);

  h.capture(() => h.dispatcher.endSession('test'));

  assert.equal(h.pending().length, 0, '会话结束必须解除通道');
});

test('钉定判据纯函数：只看有没有面值，缺原因要显式报未识别', () => {
  assert.deepEqual(
    resolveFacebookPrimarySurfacePin({ primarySurface: 'reels', blocker: 'anything' }),
    { surface: 'reels', resolution: 'authoritative', blocker: null },
  );
  assert.deepEqual(
    resolveFacebookPrimarySurfacePin({ blocker: 'facebook_operation_policy_stale' }),
    { surface: 'feed', resolution: 'unresolved', blocker: 'facebook_operation_policy_stale' },
  );
  // 早退忘了具名 ⇒ MUST NOT 折进任何已有失败名，必须显式可见。
  assert.deepEqual(
    resolveFacebookPrimarySurfacePin({ blocker: null }),
    { surface: 'feed', resolution: 'unresolved', blocker: 'unnamed_baseline_short_circuit' },
  );
});
