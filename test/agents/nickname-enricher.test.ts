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
  role: NicknameEnricher;
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
    bus, role, ctx, setCalls, captures,
    fireTimeout: () => { if (timeoutCb) timeoutCb(); },
    timerCleared: () => cleared,
    get backToFeed() { return backToFeed; },
  } as Harness;
}

function sessionStart(bus: EventBus): void {
  bus.emit('feed.entered', { pageType: 'feed', trigger: 'session_start', ts: Date.now() });
}
/** 边缘就绪信号：首个 page.cards.arrived（初始扫描完、进命令循环、已登记可推送）。 */
function edgeReady(bus: EventBus): void {
  bus.emit('page.cards.arrived', { cards: [], ts: Date.now() });
}
function selfDetail(bus: EventBus, accountId: string, nickname?: string): void {
  bus.emit('profile.detail.arrived', {
    detail: { authorId: accountId, postsCount: 0, followersCount: 0, extracted: false, ...(nickname !== undefined ? { nickname } : {}) },
    accountId,
    ts: Date.now(),
  });
}

describe('NicknameEnricher（登录账号真实昵称采集，云端角色驱动）', () => {
  it('会话开始 + 需采集 → 同步暂停浏览/置在途/武装超时；命令延到边缘就绪(首个 page.cards)再 emit（修 sent=0 + 命令循环未起）', () => {
    const h = setup();
    h.ctx.setPendingNicknameCapture(true);
    sessionStart(h.bus);
    // 状态同步置好（立刻挡 R3 窗口 + 让通知巡视让位）
    assert.equal(h.ctx.browseSuspended, true, '应同步暂停自主浏览');
    assert.equal(h.ctx.selfCaptureInFlight, true, '应同步置在途标记');
    // 命令延后：会话开始时边缘还没就绪（未登记可推送 + 初始扫描中命令循环未起），不发
    assert.equal(h.captures.length, 0, 'emit 应延到边缘就绪，不在握手窗口/初始扫描期发（否则 sent=0 或被丢）');
    edgeReady(h.bus); // 首个 page.cards.arrived
    assert.equal(h.captures.length, 1, '边缘就绪后应 emit 一次 self.profile.capture');
    assert.equal(h.captures[0].accountId, REAL);
  });

  it('边缘就绪前采集被收尾（reset/超时清掉在途）→ 就绪信号不再 emit（防误发）', () => {
    const h = setup();
    h.ctx.setPendingNicknameCapture(true);
    sessionStart(h.bus);
    h.ctx.setSelfCaptureInFlight(false); // 模拟就绪前被 reset/超时清掉
    edgeReady(h.bus);
    assert.equal(h.captures.length, 0, 'in-flight 已清 → 就绪信号不发命令');
  });

  it('边缘就绪信号去重：多次 page.cards 只触发一次采集命令', () => {
    const h = setup();
    h.ctx.setPendingNicknameCapture(true);
    sessionStart(h.bus);
    edgeReady(h.bus);
    edgeReady(h.bus);
    edgeReady(h.bus);
    assert.equal(h.captures.length, 1, '首个 page.cards 后 awaitingEdgeReady 置 false，后续不再发');
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

  // ── change nickname-capture-on-login：采真名从「浏览会话开始」解耦为「登录引导固定步骤」──
  it('登录引导触发（armLoginCapture，无 session_start）→ 同款采集流程：武装→边缘就绪 emit→落库回 feed（解耦人设闸）', () => {
    const h = setup();
    h.ctx.setPendingNicknameCapture(true);
    // 不发 session_start —— 直接登录引导触发（未绑人设、不开浏览会话也照采）
    h.role.armLoginCapture();
    assert.equal(h.ctx.browseSuspended, true, '应同步暂停');
    assert.equal(h.ctx.selfCaptureInFlight, true, '应同步置在途');
    assert.equal(h.captures.length, 0, 'emit 延到边缘就绪');
    edgeReady(h.bus); // 首个 page.cards.arrived
    assert.equal(h.captures.length, 1, '边缘就绪后 emit 一次 self.profile.capture');
    selfDetail(h.bus, REAL, '测评酱');
    assert.deepEqual(h.setCalls, [{ accountId: REAL, nickname: '测评酱' }], '登录引导路径同样落库真名');
    assert.equal(h.ctx.pendingNicknameCapture, false, '采到即幂等');
    assert.equal(h.backToFeed, 1, '回 feed 一次');
  });

  it('登录引导触发：无需采集(pending=false)→零扰动；占位账号 default 绝不采', () => {
    const h1 = setup();
    h1.role.armLoginCapture(); // pending 默认 false
    assert.equal(h1.captures.length, 0, 'pending=false → 零扰动');
    assert.equal(h1.ctx.browseSuspended, false);

    const h2 = setup({ accountId: 'default' });
    h2.ctx.setPendingNicknameCapture(true); // 即便误置
    h2.role.armLoginCapture();
    assert.equal(h2.captures.length, 0, 'default 占位账号绝不采（双保险）');
    assert.equal(h2.ctx.browseSuspended, false);
  });
});
