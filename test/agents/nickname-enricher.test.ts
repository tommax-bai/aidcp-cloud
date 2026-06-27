import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EventBus } from '../../src/event-bus/index.js';
import { SessionContext } from '../../src/agents/session-context.js';
import { NicknameEnricher } from '../../src/agents/nickname-enricher.js';
import type { Soul } from '../../src/soul/types.js';

const mockSoul: Soul = {
  identity: { name: 'TestBot', role: 'AI爱好者', background: '技术博主', tone: '友好' },
  interests: { primary: ['AI'], secondary: ['技术'], seed_keywords: ['LLM'] },
};

const REAL = 'acc-real-userid';

interface Harness {
  bus: EventBus;
  ctx: SessionContext;
  setCalls: { accountId: string; nickname: string }[];
  fireTimeout: () => void;
  timerCleared: () => boolean;
  captures: { accountId: string }[];
  backToFeed: number;
}

function setup(opts: { accountId?: string } = {}): Harness {
  const bus = new EventBus();
  const ctx = new SessionContext();
  const setCalls: { accountId: string; nickname: string }[] = [];
  let timeoutCb: (() => void) | null = null;
  let cleared = false;
  const captures: { accountId: string }[] = [];
  let backToFeed = 0;

  const role = new NicknameEnricher({
    eventBus: bus,
    soul: mockSoul,
    sessionContext: ctx,
    getAccountId: () => opts.accountId ?? REAL,
    setNickname: (accountId, nickname) => { setCalls.push({ accountId, nickname }); },
    setTimeoutFn: (fn) => { timeoutCb = fn; return { id: 1 }; },
    clearTimeoutFn: () => { cleared = true; },
  });
  role.subscribe();

  bus.on('self.profile.capture', (p) => { captures.push(p); });
  bus.on('feed.entered', (p) => { if (p.trigger === 'back_to_feed') backToFeed++; });

  return {
    bus, ctx, setCalls, captures,
    fireTimeout: () => { if (timeoutCb) timeoutCb(); },
    timerCleared: () => cleared,
    get backToFeed() { return backToFeed; },
  } as Harness;
}

function sessionStart(bus: EventBus): void {
  bus.emit('feed.entered', { pageType: 'feed', trigger: 'session_start', ts: Date.now() });
}
function selfDetail(bus: EventBus, accountId: string, nickname?: string): void {
  bus.emit('profile.detail.arrived', {
    detail: { authorId: accountId, postsCount: 0, followersCount: 0, extracted: false, ...(nickname !== undefined ? { nickname } : {}) },
    accountId,
    ts: Date.now(),
  });
}

describe('NicknameEnricher（登录账号真实昵称采集，云端角色驱动）', () => {
  it('会话开始 + 需采集 → 暂停浏览 + 置在途 + 武装超时 + emit self.profile.capture', () => {
    const h = setup();
    h.ctx.setPendingNicknameCapture(true);
    sessionStart(h.bus);
    assert.equal(h.captures.length, 1, '应 emit 一次 self.profile.capture');
    assert.equal(h.captures[0].accountId, REAL);
    assert.equal(h.ctx.browseSuspended, true, '应暂停自主浏览');
    assert.equal(h.ctx.selfCaptureInFlight, true, '应置在途标记');
  });

  it('会话开始 + 无需采集（pending=false）→ 零扰动', () => {
    const h = setup();
    // pending 默认 false
    sessionStart(h.bus);
    assert.equal(h.captures.length, 0);
    assert.equal(h.ctx.browseSuspended, false);
    assert.equal(h.ctx.selfCaptureInFlight, false);
  });

  it('占位账号 default 绝不采（双保险）', () => {
    const h = setup({ accountId: 'default' });
    h.ctx.setPendingNicknameCapture(true); // 即便 pending 被误置
    sessionStart(h.bus);
    assert.equal(h.captures.length, 0);
    assert.equal(h.ctx.browseSuspended, false);
  });

  it('本人主页非空昵称到达 → 持久化 + pending=false(幂等) + 清在途 + 解暂停 + 回 feed（严格顺序）', () => {
    const h = setup();
    h.ctx.setPendingNicknameCapture(true);
    sessionStart(h.bus);
    selfDetail(h.bus, REAL, '工程师大白');
    assert.deepEqual(h.setCalls, [{ accountId: REAL, nickname: '工程师大白' }], '应单写持久化非空昵称');
    assert.equal(h.ctx.pendingNicknameCapture, false, '采到 → 本连接此后不再绕（幂等）');
    assert.equal(h.ctx.selfCaptureInFlight, false, '应清在途标记');
    assert.equal(h.ctx.browseSuspended, false, '应解除暂停（在 emit back_to_feed 之前）');
    assert.equal(h.timerCleared(), true, '应取消超时');
    assert.equal(h.backToFeed, 1, '应回 feed 一次');
  });

  it('本人主页空昵称（诚实空）→ 不写 + 尝试计数++ + 仍回 feed', () => {
    const h = setup();
    h.ctx.setPendingNicknameCapture(true);
    sessionStart(h.bus);
    selfDetail(h.bus, REAL, '   '); // 空白
    assert.equal(h.setCalls.length, 0, '空昵称绝不写（不覆盖真名、DB 保持 NULL 待重试）');
    assert.equal(h.ctx.selfCaptureAttempts, 1, '采空尝试计数应 +1');
    assert.equal(h.ctx.pendingNicknameCapture, true, '未采到 → pending 仍为 true（下次会话有界重试）');
    assert.equal(h.backToFeed, 1, '仍回 feed');
    assert.equal(h.ctx.browseSuspended, false);
  });

  it('他人主页 detail（authorId ≠ accountId）→ 角色忽略（不写、不回 feed、保持在途）', () => {
    const h = setup();
    h.ctx.setPendingNicknameCapture(true);
    sessionStart(h.bus);
    // 普通作者浏览的 detail
    h.bus.emit('profile.detail.arrived', {
      detail: { authorId: 'other-author', postsCount: 10, followersCount: 100, extracted: true, nickname: '别人' },
      accountId: REAL,
      ts: Date.now(),
    });
    assert.equal(h.setCalls.length, 0, '绝不把别人昵称写到自己');
    assert.equal(h.backToFeed, 0, '他人 detail 不触发本角色回 feed');
    assert.equal(h.ctx.selfCaptureInFlight, true, '本人采集仍在途');
  });

  it('~20s 超时（edge 静默）→ 清在途 + 解暂停 + 回 feed', () => {
    const h = setup();
    h.ctx.setPendingNicknameCapture(true);
    sessionStart(h.bus);
    h.fireTimeout();
    assert.equal(h.ctx.selfCaptureInFlight, false);
    assert.equal(h.ctx.browseSuspended, false);
    assert.equal(h.backToFeed, 1, '超时应回 feed');
  });

  it('超时在本人 detail 收尾之后触发 → 空响（不重复回 feed）', () => {
    const h = setup();
    h.ctx.setPendingNicknameCapture(true);
    sessionStart(h.bus);
    selfDetail(h.bus, REAL, '工程师大白'); // 先收尾（backToFeed=1, inFlight=false）
    h.fireTimeout(); // 迟到的超时
    assert.equal(h.backToFeed, 1, '超时空响，不二次回 feed');
  });

  it('K 次采空后退避：达上限的会话开始不再驱动采集', () => {
    const h = setup();
    h.ctx.setPendingNicknameCapture(true);
    // 模拟已累计到上限
    for (let i = 0; i < h.ctx.selfCaptureMaxAttempts; i++) h.ctx.incrementSelfCaptureAttempts();
    sessionStart(h.bus);
    assert.equal(h.captures.length, 0, '达 K 上限 → 不再绕（退避）');
    assert.equal(h.ctx.browseSuspended, false);
  });
});
